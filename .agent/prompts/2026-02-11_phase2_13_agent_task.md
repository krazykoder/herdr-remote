# Phase 2.13 Agent Task: Store Consolidation, Context Simplification & Algo Commit

---

## Environment

- **Python**: Use `.venv313` at workspace root (`source .venv313/bin/activate`)
- **Workspace**: `/Users/towshif/code/python/algoFlow`

---

## Context

Phase 2.12 completed AlgoID, Trade MFE/MAE, ProtoEngine wiring, and persistence. Phase 2.13 consolidates the storage architecture, simplifies contexts, adds AlgoID-based deduplication, and implements the algo commit pipeline.

**Implementation Plan**: `.workflow/04_implementation_plans/2026-02-11_phase2_13_store_consolidation.md`

**Key files**:
- `algoflow/stores/stat_store.py` → rename to `perf_store.py`
- `algoflow/stores/signal_store.py`
- `algoflow/stores/param_store.py`
- `algoflow/stores/trade_store.py`
- `algoflow/core/context.py`
- `algoflow/core/identity.py` (reference only — DO NOT MODIFY)
- `algoflow/core/algo_commit.py` (NEW)
- `algoflow/simulation/context.py`
- `algoflow/simulation/simulation_runner.py`
- `algoflow/pipeline/flow_runner.py`

---

## Steps

### Step 1: StatStore → PerfStore Rename

1. **Rename file**: `algoflow/stores/stat_store.py` → `algoflow/stores/perf_store.py`
2. **Rename class**: `StatStore` → `PerfStore` inside `perf_store.py`
3. **Update all imports and references** across:
   - `algoflow/core/context.py` — field `stat_store` → `perf_store`, import change
   - `algoflow/pipeline/flow_runner.py` — all `stat_store` → `perf_store`
   - `algoflow/simulation/context.py` — `stat_store` in `to_dataframe()`
   - `algoflow/simulation/simulation_runner.py` — any references
   - `algoflow/stores/__init__.py` — if it exports `StatStore`
   - All `tests/e2e/*.py` files that reference `stat_store` or `StatStore`
4. **Verify**: Run tests 39B, 46, 48 to confirm rename is clean

### Step 2: Manifest Schema

**Create** manifest support in `algoflow/simulation/context.py`:

```python
def _save_manifest(self, path: str):
    """Save sweep matrix with cell metadata and algo_ids."""
    manifest = {
        "run_date": datetime.now().isoformat(),
        "cells": []
    }
    for cell in self.matrix:
        cell_data = cell.to_dict()
        cell_data["status"] = "done"  # or check if signals exist
        manifest["cells"].append(cell_data)
    
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)

@classmethod
def _load_manifest(cls, path: str) -> List[FlowCell]:
    """Load manifest and reconstruct FlowCell list."""
    with open(path) as f:
        data = json.load(f)
    cells = []
    for item in data["cells"]:
        cell = FlowCell(
            cell_id=item["cell_id"],
            symbol=item["symbol"],
            algo=item["algo"],
        )
        cells.append(cell)
    return cells
```

### Step 3: SimulationContext Consolidated Save/Load

**File**: `algoflow/simulation/context.py`

Replace the per-cell `save()/load()` with the consolidated model:

**New `save()` layout**:
```
output_dir/
├── manifest.json
├── data/{symbol}.parquet
├── params/shared.parquet
├── signals/{symbol}.parquet      ← ALL algo signals per symbol
├── perf/summary.parquet          ← ONE row per variant
├── trades/all_trades.json        ← ALL trades tagged with algo_id
└── configs/algo_configs.json     ← ALL configs keyed by algo_id
```

**Critical changes**:
1. `SimulationContext` gains new fields: `signal_store`, `perf_store`, `trade_store` (consolidated for entire sim)
2. Remove `contexts: Dict[str, PipelineContext]` — pipeline contexts are runtime-only
3. `save()` writes each store to its consolidated location
4. `load()` reads from consolidated locations

**Signal consolidation**: The SignalStore already keys by `{symbol}::{param_name}` where param_name = `{algo_id}_{output}`. When saving per-symbol, filter by symbol prefix:

```python
def save_signals_per_symbol(self, output_dir: str):
    """Save signals grouped by symbol."""
    signals_dir = os.path.join(output_dir, "signals")
    os.makedirs(signals_dir, exist_ok=True)
    
    for symbol in self.signal_store.get_symbols():
        symbol_data = self.signal_store.get_all_for_symbol(symbol)
        # Save as {symbol}.parquet with columns = algo signal keys
        df = pd.DataFrame(symbol_data)
        df.to_parquet(os.path.join(signals_dir, f"{symbol}.parquet"))
```

**Perf consolidation**: The PerfStore stats are already in StatStore with keys like `{symbol}_{algo_id}_{metric}`. For `perf/summary.parquet`, build a DataFrame with one row per cell:

```python
def save_perf_summary(self, output_dir: str):
    """Save perf metrics as a single summary DataFrame."""
    perf_dir = os.path.join(output_dir, "perf")
    os.makedirs(perf_dir, exist_ok=True)
    
    rows = []
    for cell in self.matrix:
        row = cell.to_dict()
        # Extract scalar metrics for this cell from perf_store
        prefix = f"{cell.symbol}_{cell.algo}"
        for stat_name in self.perf_store.get_stat_names():
            if stat_name.startswith(prefix):
                metric = stat_name.replace(prefix + "_", "")
                values = self.perf_store.get(stat_name)
                row[metric] = float(values[0]) if len(values) > 0 else None
        rows.append(row)
    
    pd.DataFrame(rows).to_parquet(os.path.join(perf_dir, "summary.parquet"))
```

### Step 4: PipelineContext Simplification

**File**: `algoflow/core/context.py`

1. Keep `PipelineContext` with ALL existing fields (backward compat)
2. Keep `save()/load()` methods for **standalone** (non-simulation) use
3. Rename `stat_store` → `perf_store` (from Step 1)
4. Ensure `completed_stages` is NOT relied upon for dedup — store checks handle this

### Step 5: AlgoID-Based Dedup in FlowRunner

**File**: `algoflow/pipeline/flow_runner.py`

Add dedup check before algo execution in `run()`:

```python
# After generating AlgoID, before executing algo:
algo_id_str = ctx.algo_id.full_id if ctx.algo_id else ctx.algo_name

# Dedup check: skip if signals already exist
signal_key = f"{algo_id_str}_signal"
if ctx.signal_store.has(symbol, signal_key):
    print(f"  ⚡ Cache hit: {signal_key} on {symbol} — skipping algo execution")
    # Reconstruct result dict from existing signals
    result = {}
    for key in ctx.signal_store.get_param_names(symbol):
        if key.startswith(algo_id_str + "_"):
            short_key = key[len(algo_id_str) + 1:]
            result[short_key] = ctx.signal_store.get(symbol, key)
    # Skip to post-algo processing (trades, perf)
else:
    # Normal execution path
    result = self._execute_algo(algo_name, inputs, algo_params, ...)
```

### Step 6: AlgoID-Based Dedup in SimulationRunner

**File**: `algoflow/simulation/simulation_runner.py`

In `run_stage()` for the ALGO stage, check if signals already exist:

```python
# In ALGO stage cell iteration:
from algoflow.core.identity import AlgoID

for i, cell in enumerate(sim_ctx.matrix):
    # Generate AlgoID for this cell
    algo_id = AlgoID.from_config(cell.algo, {
        "logic": cell.logic_variant,
        "inputs": cell.input_variant,
        "params": cell.param_variant,
    })
    
    signal_key = f"{algo_id.full_id}_signal"
    if sim_ctx.signal_store.has(cell.symbol, signal_key):
        print(f"  ⚡ Skipping cell {cell.cell_id}: {signal_key} already computed")
        continue
    
    # Execute normally...
```

### Step 7: Algo Commit

**Create** `algoflow/core/algo_commit.py`:

Implement two functions:

1. **`bake(algo_config, dsl_engine)`** — Resolves overrides into standalone DSL:
   - Load base DSL from registry via `dsl_engine.get_registered_dsl(base_key)`
   - Apply `input_overrides` → rewrite `inputs` section
   - Apply `param_overrides` → bake into `runtime_params`
   - Stamp `_committed` metadata: `baked_from`, `bake_date`, `origin_hash`
   - Return resolved DSL dict

2. **`commit_to_registry(baked_dsl, registry_path, new_name=None)`** — Register in algo_registry:
   - Generate name from `baked_from` + `origin_hash[:8]` (or use `new_name`)
   - Add `type: "committed"` and lineage metadata
   - Check for duplicates (skip if already exists)
   - Write to registry JSON

### Step 8: Tests

**Create** `tests/e2e/50_store_consolidation.py`:
- Run SimulationRunner with 2 symbols × 2 algos = 4 cells
- Save to output directory
- Verify consolidated layout: `manifest.json`, `signals/`, `perf/`, `trades/`, `configs/`
- Verify NO `cell_<id>/` directories
- Verify `signals/SPY.parquet` has columns for both algos
- Verify `perf/summary.parquet` has 4 rows
- Load from directory → verify data matches
- Run `to_dataframe()` → verify leaderboard output

**Create** `tests/e2e/51_algo_dedup.py`:
- Run algo → signals stored
- Run same algo again → verify "⚡ Cache hit" log, no re-execution
- Run same algo with different param_overrides → verify new execution (different AlgoID)
- Verify signal_store has entries for both algo_ids

**Create** `tests/e2e/52_algo_commit.py`:
- Create research config with input + param overrides
- Call `bake()` → verify resolved DSL has overrides baked in
- Call `commit_to_registry()` → verify new registry entry
- Verify entry has `type: "committed"`, `baked_from`, `bake_date`
- Load committed entry and run → verify it produces signals without overrides

**Run regression**:
```bash
source .venv313/bin/activate
python tests/e2e/39B_master_test_simulate_variants.py
python tests/e2e/46_dsl_cross_symbol.py
python tests/e2e/48_algo_identity_test.py
python tests/e2e/49_proto_engine_wiring.py
```

---

## DO NOT Change

- **DSLEngine internals**: No changes to compilation or code generation
- **ProtoEngine**: Do NOT modify `proto_engine.py` — call via existing API
- **AlgoID class**: `algoflow/core/identity.py` — DO NOT modify schema
- **Existing store method signatures**: Only ADD methods, don't change existing store APIs
- **Stress tests (27-40)**: Must continue to work
- **Store internal data structures**: `_store`, `_data`, `_trades` — don't change backing dicts

---

## Post-Implementation Report

Create: `.workflow/05_implementation/2026-02-11_phase2_13_store_consolidation_report.md`

Include:
1. **PerfStore rename**: Show import/usage before and after
2. **Consolidated layout**: Show actual saved directory structure
3. **Dedup**: Show cache hit/miss log output
4. **Algo commit**: Show baked DSL and registry entry
5. **Performance**: File count comparison (before vs after)
6. **Regression**: All existing tests passing

---

## Acceptance Criteria

- [ ] `StatStore` → `PerfStore` rename complete across all files
- [ ] `stat_store` → `perf_store` field rename across contexts and runners
- [ ] SimulationContext saves consolidated layout (no `cell_<id>/` dirs)
- [ ] `signals/{symbol}.parquet` contains all algo signal columns
- [ ] `perf/summary.parquet` contains one row per variant with metrics
- [ ] `manifest.json` has cell metadata and algo_ids
- [ ] `trades/all_trades.json` has all trades tagged with algo_id
- [ ] `configs/algo_configs.json` has all configs keyed by algo_id
- [ ] PipelineContext standalone save/load still works
- [ ] AlgoID dedup skips cells in SimulationRunner (signal_store check)
- [ ] AlgoID dedup skips at FlowRunner level
- [ ] `bake()` produces standalone DSL from config + overrides
- [ ] `commit_to_registry()` creates `type: "committed"` entry with lineage
- [ ] Committed algo runs without overrides, produces correct signals
- [ ] All regression tests pass (39B, 46, 48, 49)
- [ ] New E2E tests pass (50, 51, 52)
- [ ] Walkthrough saved to `.workflow/05_implementation/`
