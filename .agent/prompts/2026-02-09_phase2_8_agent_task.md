# Phase 2.8 Agent Task: DSL Cross-Symbol Aliasing & API Cleanup

---

## Environment

- **Python**: Use `.venv313` at workspace root (`source .venv313/bin/activate`)
- **Workspace**: `/Users/towshif/code/python/algoFlow`
- **Test Templates**: Use `tests/e2e/39A_master_test_simple.py` and `tests/e2e/39B_master_test_simulate_variants.py` as base templates.
- **DEPRECATED**: Do NOT reference or use `SFDSLAdapter`, `TulipParamAdapter`, or anything in `stages/*/adapters/`. Dead code.

---

## Context & Dependencies

Phase 2.7 delivered:
- Cross-symbol bracket injection: `[SYMBOL][param_name]` keys in FlowRunner inputs
- Stage-aware FlowRunner with `shared_param_store` and `context` params
- `SimulationRunner.run_stage()` batch API

Phase 2.7 gaps (addressed here):
1. `SimulationRunner.run()` duplicates `run_stage()` logic
2. No DSL-level cross-symbol aliasing
3. `FlowRunner.run()` returns `Dict` instead of `PipelineContext`

---

## Critical Design Constraint

**Do NOT modify the DSL compiler.** Cross-symbol inputs use **long-form `default_source` only**:

```json
{
  "inputs": {
    "_EMA21": "float64",
    "spy_trend": { "type": "float64", "default_source": "[SPY][_EMA21]" }
  }
}
```

- Short form (`"_EMA21": "float64"`) → same-symbol only, unchanged
- Long form with bracket `default_source` → cross-symbol, resolved in FlowRunner
- Compiler sees `spy_trend` as a normal `float64` param — zero compiler changes

---

## Steps

### Step 0: Bracket Resolution in FlowRunner

**File**: `algoflow/pipeline/flow_runner.py`

Add a small resolver method (~10 lines):
```python
def _resolve_input_source(self, default_source, symbol, inputs, shared_param_store):
    """Resolve a default_source string. Supports bracket notation [SYMBOL][param]."""
    if default_source.startswith("[") and shared_param_store:
        import re
        match = re.match(r'\[(\w+)\]\[(\w+)\]', default_source)
        if match:
            sym, param = match.groups()
            return shared_param_store.get(sym, param)
    return inputs.get(default_source)
```

Integrate into `_prepare_inputs()` where `default_source` values are resolved. When a long-form input has a bracket `default_source`, resolve it from `shared_param_store` instead of the local inputs dict.

### Step 1: SimulationRunner.run() Refactor

**File**: `algoflow/simulation/simulation_runner.py`

Replace the entire `run()` body with:
```python
def run(self, progress=True, progress_callback=None) -> SimulationContext:
    if not self._sweep_defined:
        raise RuntimeError("Sweep not defined. Call define_sweep() first.")
    sim_ctx = SimulationContext(
        data_store=DataStore(),
        shared_param_store=ParamStore()
    )
    sim_ctx = self.run_stage(Stage.DATA, sim_ctx, progress, progress_callback)
    sim_ctx = self.run_stage(Stage.PARAMS, sim_ctx, progress, progress_callback)
    sim_ctx = self.run_stage(Stage.ALGO, sim_ctx, progress, progress_callback)
    if progress:
        print(f"✅ Simulation complete: {len(sim_ctx.matrix)} cells")
    return sim_ctx
```

Delete the ~180 lines of inline Phase 0/1/2 logic that currently duplicates `run_stage()`.

### Step 2: FlowRunner Return Type Change

**File**: `algoflow/pipeline/flow_runner.py`

Change return type from `Dict[str, np.ndarray]` to `PipelineContext`:
```python
def run(self, ...) -> 'PipelineContext':
    # ... existing logic ...
    return ctx  # Instead of: result['context'] = ctx; return result
```

All algo outputs are already stored in `ctx.signal_store`, trades in `ctx.trade_store`, perf in `ctx.stat_store`.

**Also update** `run_batch()` if it calls `run()`.

### Step 3: Migrate Tests

Update ALL `tests/e2e/` files that use `FlowRunner.run()`:

```python
# OLD
result = flow_runner.run(symbol, algo_name, ...)
signal = result['signal']
sharpe = result['perf_summary']['sharpe_ratio']

# NEW
ctx = flow_runner.run(symbol, algo_name, ...)
signal = ctx.signal_store.get(symbol, f"{algo_name}_signal")
sharpe = ctx.stat_store.get(f"{symbol}_{algo_name}_sharpe_ratio")
```

Files to migrate:
- `39A_master_test_simple.py`
- `39B_master_test_simulate_variants.py`
- `42_architecture_alignment.py`
- `43_master_test_persistence.py`
- `44_simulation_context.py` / `44_simulation_context_real.py`
- `45_pipeline_control.py` / `45_pipeline_control_real.py`
- `simulation_runner.py` (where it reads `flow_result`)

### Step 4: Dead Code Cleanup

Delete deprecated adapter files:
- `stages/algos/adapters/sf_adapter.py`
- `stages/algos/adapters/sf_dsl_adapter.py`
- `stages/params/adapters/tulip_adapter.py`
- `stages/algos/proto/macd_cross.py`

Keep the `DEPRECATED.md` files as tombstones.

### Step 5: Verification Test

**File**: `tests/e2e/46_dsl_cross_symbol.py`

Based on 39A/39B template. **Must test bracket notation via actual DSL config**:

1. **DSL Bracket Resolution**: Create a test DSL entry with `"spy_trend": {"type": "float64", "default_source": "[SPY][_EMA21]"}`. Run a 2-symbol sweep (SPY + AAPL) where AAPL's algo uses SPY's EMA via bracket `default_source`. Verify resolved array matches SPY's actual `_EMA21`.
2. **FlowRunner return type**: Verify `run()` returns `PipelineContext` (not `Dict`). Access signals via `ctx.signal_store`, trades via `ctx.trade_store`.
3. **SimulationRunner chain**: Verify `run()` produces same results as manual `run_stage(DATA) → run_stage(PARAMS) → run_stage(ALGO)` chain.
4. **Regression**: Run tests 39B, 44, 45 and confirm they pass.

---

## Post-Implementation Report

After all steps are complete and verified, create a report at:
**`.workflow/05_implementation/2026-02-10_phase2_8_walkthrough.md`**

The report MUST include:
1. **Changes Summary**: What files were modified/created/deleted
2. **Test Results**: All test outcomes with pass/fail
3. **Gaps & Recommendations**: Any deferred items, edge cases found, or architectural concerns
4. **Breaking Changes**: Document the FlowRunner return type change and what consumers need to update

---

## File References

| File | Role |
|------|------|
| `algoflow/pipeline/flow_runner.py` | Steps 0, 2 |
| `algoflow/simulation/simulation_runner.py` | Step 1 |
| `algoflow/core/context.py` | PipelineContext, Stage enum (read-only) |
| `algoflow/stores/param_store.py` | ParamStore (read-only) |
| `tests/e2e/39A_master_test_simple.py` | Template + migrate |
| `tests/e2e/39B_master_test_simulate_variants.py` | Template + migrate |

---

## Acceptance Criteria

- [ ] Bracket `default_source` (`[SPY][_EMA21]`) resolves correctly — no compiler changes
- [ ] `SimulationRunner.run()` delegates to `run_stage()` (no duplicated logic)
- [ ] `FlowRunner.run()` returns `PipelineContext`
- [ ] All e2e tests migrated and passing
- [ ] DSL config with bracket `default_source` verified end-to-end with real DSL entry
- [ ] Deprecated adapters deleted
- [ ] Walkthrough report saved to `.workflow/05_implementation/`
