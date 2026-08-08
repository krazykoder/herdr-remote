# Phase 2.7 Agent Task: Pipeline Control & Cross-Symbol Injection

---

## Environment

- **Python**: Use `.venv313` at workspace root (`source .venv313/bin/activate`)
- **Workspace**: `/Users/towshif/code/python/algoFlow`
- **Test Templates**: Use `tests/e2e/39A_master_test_simple.py` and `tests/e2e/39B_master_test_simulate_variants.py` as base templates. Copy and modify for new tests.

---

## Context & Dependencies

Phase 2.6 introduced:
- `DataStore` — OHLCV storage (`algoflow/stores/data_store.py`)
- `SimulationContext` — Aggregate state (`algoflow/simulation/context.py`)
- `PipelineContext` — Per-variant state with `completed_stages`, `shared_param_store`, `data_store` (`algoflow/core/context.py`)
- `Stage` enum — `DATA, PARAMS, ALGO, TRADES, PERF` (`algoflow/core/context.py`)
- `SimulationRunner` — 3-phase execution (`algoflow/simulation/simulation_runner.py`)

Phase 2.6 Gaps (addressed here):
- FlowRunner does not accept `shared_param_store`
- Cross-symbol params not injected into algo inputs
- No stage-aware skip/resume
- No batch stage API

---

## Core Decisions

1. **Cross-symbol injection uses Approach A**: `SimulationRunner` passes `shared_param_store` to `FlowRunner.run()`. FlowRunner merges ALL cross-symbol params into the `inputs` dict with bracket-namespaced keys: `[SYMBOL][param_name]` (e.g., `[SPY][ema_21]`).
2. **FlowRunner return type unchanged**: Still returns `Dict[str, np.ndarray]`. PipelineContext attached as `result['context']`.
3. **Stage-aware execution is opt-in**: When `context` param is provided to `FlowRunner.run()`, completed stages are skipped. When not provided, full pipeline runs (backward compat).
4. **`run_stage()` is additive**: The existing `SimulationRunner.run()` continues to work. `run_stage()` is a new method for incremental execution.

---

## Steps

### Step 0: FlowRunner — Accept `shared_param_store`

**File**: `algoflow/pipeline/flow_runner.py`

Modify `FlowRunner.run()` signature:
```python
def run(
    self,
    symbol: str,
    algo_name: str,
    ohlcv: Dict[str, np.ndarray] = None,
    param_overrides: Dict[str, Any] = None,
    algo_params: Dict[str, Any] = None,
    use_cache: bool = True,
    shared_param_store: Optional[ParamStore] = None,  # NEW
) -> Dict[str, np.ndarray]:
```

After `_prepare_inputs()` (line ~117), inject cross-symbol params:
```python
# Inject cross-symbol params from shared_param_store
if shared_param_store:
    for sym in shared_param_store.get_symbols():
        if sym != symbol:  # Don't duplicate own params  
            sym_params = shared_param_store.get_all_for_symbol(sym)
            for name, arr in sym_params.items():
                inputs[f"[{sym}][{name}]"] = arr  # e.g. [SPY][ema_21]
```

### Step 1: SimulationRunner — Pass `shared_param_store`

**File**: `algoflow/simulation/simulation_runner.py`

In Phase 2 cell execution (~line 187), add `shared_param_store=shared_params`:
```python
flow_result = self.flow_runner.run(
    symbol=cell.symbol,
    algo_name=cell.algo,
    ohlcv=ohlcv_dict,
    param_overrides=param_overrides if param_overrides else None,
    algo_params=algo_params if algo_params else None,
    use_cache=True,
    shared_param_store=shared_params,  # ← ADD THIS
)
```

### Step 2: FlowRunner — Stage-Aware Execution

**File**: `algoflow/pipeline/flow_runner.py`

Add optional `context: PipelineContext = None` parameter to `run()`.

When provided, check stages before execution:
```python
# Before param generation
if context and Stage.PARAMS in context.completed_stages:
    # Skip param generation, use existing params from context
    inputs = dict(ohlcv)
    for name, arr in context.param_store.get_all_for_symbol(symbol).items():
        inputs[name] = arr
else:
    inputs = self._prepare_inputs(symbol, ohlcv, required_inputs, use_cache)
    if context:
        context.completed_stages.append(Stage.PARAMS)

# Before algo execution
if context and Stage.ALGO in context.completed_stages:
    # Skip algo, use existing signals
    result = {}
    for name, arr in context.signal_store.get_all_for_symbol(symbol).items():
        result[name] = arr
else:
    result = self._execute_algo(algo_name, inputs, algo_params)
    if context:
        context.completed_stages.append(Stage.ALGO)
```

### Step 3: SimulationRunner — Batch Stage API

**File**: `algoflow/simulation/simulation_runner.py`

Add `run_stage()` method:
```python
def run_stage(
    self,
    stage: Stage,
    sim_ctx: SimulationContext = None,
    progress: bool = True,
    progress_callback=None
) -> SimulationContext:
    """Execute a single pipeline stage across all cells."""
```

Stage implementations:
- `Stage.DATA`: Load all data → `sim_ctx.data_store`
- `Stage.PARAMS`: Generate all params → `sim_ctx.shared_param_store`
- `Stage.ALGO`: Execute algo per cell (requires DATA + PARAMS complete)
- `Stage.TRADES`: Execute trades per cell (requires ALGO complete)
- `Stage.PERF`: Calculate perf per cell (requires TRADES complete)

Each stage validates preconditions and updates `completed_stages` on each `PipelineContext`.

### Step 4: Progress Callback

**File**: `algoflow/simulation/simulation_runner.py`

Add optional `progress_callback` to `run()` and `run_stage()`:
```python
def run(self, progress=True, progress_callback=None) -> SimulationContext:
```

Callback signature: `progress_callback(stage: str, index: int, total: int, cell: FlowCell)`

Fire at each cell iteration and each stage boundary.

### Step 5: Verification Test

**File**: `tests/e2e/45_pipeline_control.py`

Based on 39A/39B template. Tests:

1. **Cross-Symbol Params**: Run 2-symbol sweep, verify AAPL algo sees `[SPY][*]` bracket-prefixed params in its inputs
2. **Stage Skip**: Pre-populate PipelineContext with `completed_stages=[Stage.PARAMS]`, verify param generation skipped
3. **Batch Stage API**: Call `run_stage(Stage.DATA)`, verify DataStore populated, no algos run
4. **Batch Stage Chain**: `run_stage(DATA)` → `run_stage(PARAMS)` → `run_stage(ALGO)` produces same results as `run()`
5. **Progress Callback**: Capture callback calls, verify count and arguments
6. **Backward Compat**: Existing `run()` without new params still works

---

## File References

| File | Role |
|------|------|
| `algoflow/pipeline/flow_runner.py` | Pipeline orchestrator (modify in Steps 0, 2) |
| `algoflow/simulation/simulation_runner.py` | Sweep executor (modify in Steps 1, 3, 4) |
| `algoflow/core/context.py` | PipelineContext, Stage enum (read-only) |
| `algoflow/simulation/context.py` | SimulationContext, FlowCell (read-only) |
| `algoflow/stores/data_store.py` | DataStore (read-only) |
| `algoflow/stores/param_store.py` | ParamStore (read-only) |
| `tests/e2e/39A_master_test_simple.py` | Test template (copy for test 45) |
| `tests/e2e/39B_master_test_simulate_variants.py` | Test template (reference for variant setup) |

---

## Acceptance Criteria

- [ ] `[SPY][ema_21]` appears in AAPL algo's input dict during cross-symbol sweep
- [ ] FlowRunner skips param generation when `Stage.PARAMS` in `completed_stages`
- [ ] `run_stage(Stage.DATA)` populates DataStore, nothing else
- [ ] `run_stage(Stage.PARAMS)` populates shared params, nothing else
- [ ] Chained `run_stage()` calls produce equivalent results to `run()`
- [ ] Progress callback fires with correct `(stage, index, total, cell)` 
- [ ] All existing tests 19-27, 44 still pass (no regressions)
