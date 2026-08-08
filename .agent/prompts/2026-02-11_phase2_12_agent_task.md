# Phase 2.12 Agent Task: Algo Identity & Execution Modes

---

## Environment

- **Python**: Use `.venv313` at workspace root (`source .venv313/bin/activate`)
- **Workspace**: `/Users/towshif/code/python/algoFlow`

---

## Context

Phase 2.11 brought all stores to full API parity. Phase 2.12 introduces **AlgoID** — a deterministic config fingerprint for reproducibility — and wires ProtoEngine for Python-mode execution.

**Implementation Plan**: `.workflow/04_implementation_plans/2026-02-11_phase2_12_algo_identity_and_execution.md`

**Key files**:
- `algoflow/core/algo_id.py` (NEW)
- `algoflow/core/context.py`
- `algoflow/pipeline/flow_runner.py`
- `algoflow/stages/trades/types.py`
- `algoflow/stages/trades/executor.py`
- `algoflow/simulation/simulation_runner.py`
- `dev_signalFlow/backend/tsignalCore/engine/proto_engine.py` (reference only)

---

## Steps

### Step 1: AlgoID Utility

**Create** `algoflow/core/algo_id.py`:

```python
import json
import hashlib
from dataclasses import dataclass, field
from typing import Dict, Any, Optional

@dataclass
class AlgoConfig:
    """Full algo configuration for reproducibility."""
    base_config: str                                    # registry key
    input_overrides: Dict[str, Any] = field(default_factory=dict)
    logic_overrides: Dict[str, Any] = field(default_factory=dict)
    param_overrides: Dict[str, Any] = field(default_factory=dict)
    
    @property
    def algo_id(self) -> str:
        return generate_algo_id(
            self.base_config,
            self.input_overrides,
            self.logic_overrides,
            self.param_overrides,
        )
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "base_config": self.base_config,
            "input_overrides": self.input_overrides,
            "logic_overrides": self.logic_overrides,
            "param_overrides": self.param_overrides,
            "algo_id": self.algo_id,
        }
    
    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AlgoConfig":
        return cls(
            base_config=d["base_config"],
            input_overrides=d.get("input_overrides", {}),
            logic_overrides=d.get("logic_overrides", {}),
            param_overrides=d.get("param_overrides", {}),
        )


def generate_algo_id(
    base_config: str,
    input_overrides: Dict[str, Any] = None,
    logic_overrides: Dict[str, Any] = None,
    param_overrides: Dict[str, Any] = None,
) -> str:
    """
    Generate a deterministic AlgoID from config + overrides.
    
    Rules:
    - No overrides → returns base_config as-is
    - With overrides → returns "{base_config}_{12-char hash}"
    - Same config always produces same AlgoID
    """
    input_overrides = input_overrides or {}
    logic_overrides = logic_overrides or {}
    param_overrides = param_overrides or {}
    
    # Filter out empty values
    input_overrides = {k: v for k, v in input_overrides.items() if v is not None}
    logic_overrides = {k: v for k, v in logic_overrides.items() if v is not None}
    param_overrides = {k: v for k, v in param_overrides.items() if v is not None}
    
    if not any([input_overrides, logic_overrides, param_overrides]):
        return base_config
    
    canonical = json.dumps({
        "base": base_config,
        "inputs": input_overrides,
        "logic": logic_overrides,
        "params": param_overrides,
    }, sort_keys=True, default=str)
    
    short_hash = hashlib.sha256(canonical.encode()).hexdigest()[:12]
    return f"{base_config}_{short_hash}"
```

### Step 2: PipelineContext — Add AlgoID Fields

**File**: `algoflow/core/context.py`

Add two fields to `PipelineContext`:
```python
algo_id: str = ""
algo_config: Optional[Dict[str, Any]] = None
```

Update `save()`:
- Write `algo_config.json` to the output directory containing `algo_id` and `algo_config`

Update `load()`:
- Read `algo_config.json` if present, populate `algo_id` and `algo_config`

### Step 3: Trade Schema Enrichment

**File**: `algoflow/stages/trades/types.py`

Add three new fields to `Trade`:
```python
algo_id: str = ""         # Which algo config produced this trade
mfe: float = 0.0          # Max Favorable Excursion (% from entry)
mae: float = 0.0          # Max Adverse Excursion (% from entry)
```

**File**: `algoflow/stages/trades/executor.py`

1. Add `algo_id` parameter to `execute()` method:
   ```python
   def execute(self, ticker, dates, prices, signals, algo_id: str = "") -> List[Trade]:
   ```

2. Set `algo_id` on each created Trade:
   ```python
   current_trade = Trade(ticker=ticker, direction=1, ..., algo_id=algo_id)
   ```

3. Add MFE/MAE computation. After calling `_close_trade()`, compute excursions:
   ```python
   def _compute_excursions(self, trade: Trade, prices: np.ndarray):
       """Compute MFE and MAE for a closed trade."""
       if trade.exit_index is None or trade.entry_index is None:
           return
       segment = prices[trade.entry_index:trade.exit_index + 1]
       if len(segment) == 0 or trade.entry_price == 0:
           return
       if trade.direction == 1:  # Long
           trade.mfe = float((segment.max() - trade.entry_price) / trade.entry_price)
           trade.mae = float((segment.min() - trade.entry_price) / trade.entry_price)
       else:  # Short
           trade.mfe = float((trade.entry_price - segment.min()) / trade.entry_price)
           trade.mae = float((trade.entry_price - segment.max()) / trade.entry_price)
   ```

4. Call `_compute_excursions(current_trade, prices)` after each `_close_trade()` call.

### Step 4: SignalStore Completeness

**File**: `algoflow/pipeline/flow_runner.py`

Replace lines ~276-281 (the hardcoded signal/trend storage) with:

```python
# Store ALL algo result arrays in SignalStore, keyed by algo_id
for key, val in result.items():
    if isinstance(val, np.ndarray):
        ctx.signal_store.set(symbol, f"{ctx.algo_id}_{key}", val)
```

This stores `trend`, `signal`, `ret`, `tbar`, `stop`, `_wt`, and any custom `output_var` / `result_var` arrays from the DSL.

**IMPORTANT**: Update ALL downstream code that reads SignalStore keys:

1. **`FlowRunner.run()` Stage.ALGO skip logic** (around L250-264):
   - Change `f"{algo_name}_signal"` → `f"{ctx.algo_id}_signal"`
   - Change `f"{algo_name}_trend"` → `f"{ctx.algo_id}_trend"`

2. **`FlowRunner.get_stats()`** (around L574-597):
   - Change `f"{ctx.algo_name}_signal"` → `f"{ctx.algo_id}_signal"`
   - Change `f"{ctx.algo_name}_trend"` → `f"{ctx.algo_id}_trend"`

3. **Trade & Perf execution** (around L283-317):
   - The `result` dict keys are unchanged (still `'signal'`, `'trend'`, etc.)
   - Only the _storage_ keys change — reads from `result` dict are fine
   - Update StatStore keys: `f"{symbol}_{algo_name}_{k}"` → `f"{symbol}_{ctx.algo_id}_{k}"`

4. **Pass `algo_id` to `_execute_trades()`**:
   ```python
   trades = self._trade_executor.execute(symbol, dates, prices_arr, signals, algo_id=ctx.algo_id)
   ```

### Step 5: ProtoEngine Wiring

**File**: `algoflow/pipeline/flow_runner.py`

1. Add `proto_engine` to `__init__`:
   ```python
   def __init__(self, param_engine=None, dsl_engine=None, proto_engine=None, ...):
       self.proto_engine = proto_engine
   ```

2. Add mode detection helper:
   ```python
   def _get_algo_mode(self, algo_name: str) -> str:
       """Determine execution mode: 'dsl' or 'manual'."""
       if self.algo_config_manager:
           entry = self.algo_config_manager.get_algo(algo_name)
           if entry:
               source = entry.get('source', '')
               if isinstance(source, str) and source == 'manual':
                   return 'manual'
               if isinstance(source, dict) and source.get('engine') == 'manual':
                   return 'manual'
       return 'dsl'
   ```

3. Update `_execute_algo()` to route by mode:
   ```python
   def _execute_algo(self, algo_name, inputs, algo_params=None, shared_param_store=None):
       mode = self._get_algo_mode(algo_name)
       
       if mode == 'manual' and self.proto_engine:
           return self._execute_proto(algo_name, inputs, algo_params)
       elif self.dsl_engine:
           # existing DSL execution path (unchanged)
           ...
       else:
           return self._fallback_execution(inputs)
   ```

4. Add ProtoEngine execution method (Option A — dict→DataFrame→dict adapter):
   ```python
   def _execute_proto(self, algo_name, inputs, algo_params=None):
       """Execute algo via ProtoEngine (Python mode)."""
       import pandas as pd
       
       # Convert inputs dict → DataFrame
       df = pd.DataFrame(inputs)
       
       # Determine which columns are inputs (to detect new output columns)
       input_columns = set(df.columns)
       
       # Execute
       kwargs = algo_params or {}
       result_df = self.proto_engine.run_algo(algo_name, df, inplace=True, **kwargs)
       
       # Extract NEW columns as outputs
       result = {}
       for col in result_df.columns:
           if col not in input_columns:
               result[col] = result_df[col].values
       
       # Ensure standard output convention
       if 'signal' not in result and 'trend' not in result:
           # Look for common ProtoEngine output patterns
           for pattern in ['Signal', 'Trend', 'signal_line', 'trend_line']:
               if pattern in result:
                   result['signal' if 'signal' in pattern.lower() else 'trend'] = result.pop(pattern)
                   break
       
       return result
   ```

### Step 6: Param Promotion

**File**: `algoflow/pipeline/flow_runner.py`

Add promotion logic AFTER signal storage (after the new `for key, val in result.items()` loop):

```python
# Promote flagged outputs to ParamStore
self._promote_outputs(algo_name, result, ctx, symbol, shared_param_store)
```

New method:
```python
def _promote_outputs(self, algo_name, result, ctx, symbol, shared_param_store=None):
    """Promote algo outputs flagged with 'promote: true' to ParamStore."""
    dsl_key = self._resolve_dsl_key(algo_name)
    if not dsl_key or not self.dsl_engine:
        return
    
    entry = self.dsl_engine.get_registered_dsl(dsl_key)
    if not entry:
        return
    
    dsl_config = entry.get('dsl_config', {})
    outputs = dsl_config.get('outputs', {})
    
    for output_name, output_def in outputs.items():
        if isinstance(output_def, dict) and output_def.get('promote', False):
            if output_name in result and isinstance(result[output_name], np.ndarray):
                ctx.param_store.set(symbol, output_name, result[output_name])
                if shared_param_store:
                    shared_param_store.set(symbol, output_name, result[output_name])
```

### Step 7: Stage Separation

**File**: `algoflow/pipeline/flow_runner.py`

Add `stop_after_stage` parameter to `run()`:
```python
def run(self, ..., stop_after_stage: Optional['Stage'] = None) -> 'PipelineContext':
```

Add early returns after each stage:
- After ALGO stage (Step 4 execution complete): `if stop_after_stage == Stage.ALGO: return ctx`
- After TRADES stage (trades generated): `if stop_after_stage == Stage.TRADES: return ctx`
- End of function runs full pipeline including PERF

**File**: `algoflow/simulation/simulation_runner.py`

Split the `Stage.ALGO`/`Stage.TRADES`/`Stage.PERF` block (L234) into three separate blocks. Each passes the appropriate `stop_after_stage` to `FlowRunner.run()`.

**File**: `algoflow/core/context.py`

Verify `Stage` enum has `TRADES` and `PERF` entries. If missing, add them:
```python
class Stage(Enum):
    DATA = "DATA"
    PARAMS = "PARAMS"
    ALGO = "ALGO"
    TRADES = "TRADES"    # ensure exists
    PERF = "PERF"        # ensure exists
```

Update `SimulationRunner.run()` to chain all 5 stages:
```python
def run(self, ...):
    sim_ctx = self.run_stage(Stage.DATA, sim_ctx, ...)
    sim_ctx = self.run_stage(Stage.PARAMS, sim_ctx, ...)
    sim_ctx = self.run_stage(Stage.ALGO, sim_ctx, ...)
    sim_ctx = self.run_stage(Stage.TRADES, sim_ctx, ...)
    sim_ctx = self.run_stage(Stage.PERF, sim_ctx, ...)
```

### Step 8: AlgoID Integration in FlowRunner.run()

**File**: `algoflow/pipeline/flow_runner.py`

At the top of `run()`, after Step 0 (Initialize Context), generate the AlgoID:

```python
from algoflow.core.algo_id import generate_algo_id, AlgoConfig

# Build AlgoConfig
algo_cfg = AlgoConfig(
    base_config=algo_name,
    input_overrides=param_overrides or {},
    logic_overrides=algo_params or {},
)
ctx.algo_id = algo_cfg.algo_id
ctx.algo_config = algo_cfg.to_dict()
```

### Step 9: Tests

**Create** `tests/e2e/48_algo_identity_test.py`:
- Template from `tests/e2e/42_architecture_alignment.py`
- Test 1: Run algo with no overrides → `algo_id == algo_name`
- Test 2: Run algo with `param_overrides={"threshold": 0.6}` → `algo_id != algo_name`
- Test 3: Run same config twice → same `algo_id`
- Test 4: Check `ctx.signal_store` has keys prefixed with `algo_id`
- Test 5: Check all trades have `trade.algo_id == ctx.algo_id`
- Test 6: Check `trade.mfe` and `trade.mae` are non-zero for closed trades
- Test 7: Save/load PipelineContext → `algo_config` preserved
- Test 8: Check ALL result arrays stored (not just signal/trend)

**Create** `tests/e2e/49_proto_engine_wiring.py`:
- Register a manual algo in `AlgoConfigManager`
- Create `FlowRunner` with `proto_engine=ProtoEngine()`
- Run via `FlowRunner.run()`
- Verify mode routing happened (signals produced)
- Verify `Trade.algo_id` populated
- Verify SignalStore keyed by `algo_id`

**Run regression**:
```bash
source .venv313/bin/activate
python tests/e2e/39B_master_test_simulate_variants.py
python tests/e2e/46_dsl_cross_symbol.py
python tests/e2e/47_context_graduation_test.py
```

---

## DO NOT Change

- **DSLEngine internals**: No changes to compilation or code generation
- **ProtoEngine**: Do NOT modify `proto_engine.py` — call it via its existing API
- **Existing store method signatures**: Only ADD fields/methods, don't change existing ones
- **Stress tests (27-40)**: Should continue to work — SignalStore keys change but these tests use `FlowRunner.run()` which now uses `algo_id` (which equals `algo_name` when no overrides)

---

## Post-Implementation Report

Create: `.workflow/05_implementation/2026-02-11_phase2_12_algo_identity_and_execution.md`

Include:
1. **AlgoID**: Show deterministic hash working with/without overrides
2. **Trade enrichment**: Show MFE/MAE values on sample trades
3. **SignalStore**: Show all result arrays stored (not just signal/trend)
4. **ProtoEngine**: Show routing working via `source: "manual"` config
5. **Stage separation**: Show ALGO/TRADES/PERF running independently
6. **Regression**: All existing tests passing

---

## Acceptance Criteria

- [ ] `generate_algo_id()` produces deterministic hashes
- [ ] No overrides → `algo_id == base_config`
- [ ] `PipelineContext.algo_id` and `algo_config` populated
- [ ] `algo_config.json` persisted on save, restored on load
- [ ] `Trade.algo_id` populated on all generated trades
- [ ] `Trade.mfe` and `Trade.mae` computed for closed trades
- [ ] ALL result arrays stored in SignalStore (not just signal/trend)
- [ ] SignalStore keys use `{algo_id}_{key}` pattern
- [ ] `FlowRunner._get_algo_mode()` returns "manual" for Python algos
- [ ] `FlowRunner._execute_proto()` converts dict→DataFrame→dict
- [ ] Param promotion writes flagged outputs to ParamStore + shared store
- [ ] `stop_after_stage` parameter works on FlowRunner.run()
- [ ] SimulationRunner chains 5 separate stages
- [ ] All regression tests pass (39B, 46, 47)
- [ ] New E2E tests pass (48, 49)
- [ ] Walkthrough saved to `.workflow/05_implementation/`
