# Phase 2.8.1 Agent Task: Bug Fixes, Test Gap & Cleanup

---

## Environment

- **Python**: Use `.venv313` at workspace root (`source .venv313/bin/activate`)
- **Workspace**: `/Users/towshif/code/python/algoFlow`
- **Test Templates**: Use `tests/e2e/39A_master_test_simple.py` and `tests/e2e/39B_master_test_simulate_variants.py` as reference templates
- **DEPRECATED**: Adapters in `stages/*/adapters/` are dead code — rename, do NOT delete

---

## Context

Phase 2.8 was executed. Review found 6 issues to fix:

1. **Duplicate `run()` in SimulationRunner** — lines 98-112 are a dead first definition, line 113 has the real one
2. **Dead `pass` in FlowRunner** — lines 201-204 are stale comment + `pass` from removed bracket injection
3. **Test 46 doesn't verify `default_source` bracket resolution** — it uses `input_variant` instead
4. **Deprecated adapters need renaming** to `DEPRECATED_*` prefix
5. **`get_stats()` takes `Dict`** — should take `PipelineContext` or be deprecated
6. **`runner.py`** is a Phase 1.0 prototype — rename to `DEPRECATED_runner.py`

---

## Steps

### Step 1: Fix Duplicate `run()` (SimulationRunner)

**File**: `algoflow/simulation/simulation_runner.py`

Delete lines 98-112 — the dead first `run()` definition (stub with docstring only, no body). The real `run()` now starts at what is currently line 113 and correctly chains `run_stage()` calls.

### Step 2: Remove Dead `pass` (FlowRunner)

**File**: `algoflow/pipeline/flow_runner.py`

Remove lines 201-204:
```python
        # REMOVED: Bulk injection of [SYMBOL][param] keys. 
        # Now handled on-demand via _resolve_input_source in _execute_algo.
        pass
```

### Step 3: Add `default_source` Bracket E2E Test

**File**: `tests/e2e/46_dsl_cross_symbol.py`

The existing test verifies cross-symbol via `input_variant`. Add a **second test case** that exercises the `default_source` path:

1. Create a `SimulationRunner` with `input_variants=[{}]` (NO overrides)
2. Run all 3 stages (DATA → PARAMS → ALGO)
3. The AAPL cell should run `cross_symbol_follower` DSL, which declares `"spy_ema": {"default_source": "[SPY][_EMA21]"}`
4. `FlowRunner._execute_algo()` should call `_resolve_input_source("[SPY][_EMA21]", ...)` → resolve from `shared_param_store`
5. Assert that AAPL produces valid signals (non-zero signal array)
6. Assert that the resolved `spy_ema` matches SPY's actual `_EMA21`

This is the critical test that proves bracket notation in `default_source` works end-to-end.

### Step 4: Rename Deprecated Adapters

**DO NOT DELETE** — rename with `DEPRECATED_` prefix:

```bash
mv stages/algos/adapters/sf_adapter.py stages/algos/adapters/DEPRECATED_sf_adapter.py
mv stages/algos/adapters/sf_dsl_adapter.py stages/algos/adapters/DEPRECATED_sf_dsl_adapter.py
mv stages/params/adapters/tulip_adapter.py stages/params/adapters/DEPRECATED_tulip_adapter.py
mv stages/algos/proto/macd_cross.py stages/algos/proto/DEPRECATED_macd_cross.py
```

Keep existing `DEPRECATED.md` files.

Also check if any test files import these — if so, update the imports to match new filenames. Known importers:
- `tests/verify_p4.py`
- `tests/e2e_phase1_1.py`
- `tests/e2e_phase1_2_binding.py`
- `tests/test_p1_3_dsl_adapter.py`

### Step 5: Audit `get_stats()`

**File**: `algoflow/pipeline/flow_runner.py`

`get_stats(self, result: Dict)` (around line 555) still expects old `Dict` return format. 

1. First, check if anything calls `get_stats()` (`grep -r "get_stats" --include="*.py"`)
2. If unreferenced: rename to `DEPRECATED_get_stats()` and add a comment
3. If referenced: update signature to accept `PipelineContext` and read from stores

### Step 6: Rename `runner.py`

**File**: `algoflow/pipeline/runner.py`

1. Check for imports: `grep -r "from algoflow.pipeline.runner" --include="*.py"` and `grep -r "from algoflow.pipeline import runner" --include="*.py"`
2. Rename to `algoflow/pipeline/DEPRECATED_runner.py`
3. Update any imports found in step 1

---

## Verification

After all changes:
```bash
source .venv313/bin/activate

# Primary: Test the default_source bracket path
python tests/e2e/46_dsl_cross_symbol.py

# Regression
python tests/e2e/45_pipeline_control.py
python tests/e2e/39B_master_test_simulate_variants.py
python tests/e2e/39A_master_test_simple.py
```

---

## Post-Implementation Report

After all steps are complete and verified, create a report at:
**`.workflow/05_implementation/2026-02-10_phase2_8_1_walkthrough.md`**

Include:
1. **Changes Summary**: What was fixed/renamed/added
2. **Test Results**: All test outcomes
3. **Gaps & Recommendations**: Any edge cases or remaining issues
4. **`default_source` test result**: Explicit confirmation that bracket notation in DSL `default_source` resolves end-to-end

---

## Acceptance Criteria

- [ ] No duplicate `run()` in SimulationRunner
- [ ] No dead `pass` in FlowRunner
- [ ] Test 46 verifies `default_source` bracket resolution WITHOUT `input_variant`
- [ ] Deprecated adapters renamed to `DEPRECATED_*` (not deleted)
- [ ] `get_stats()` resolved (updated or deprecated)
- [ ] `runner.py` renamed to `DEPRECATED_runner.py`
- [ ] All regression tests pass (39A, 39B, 45, 46)
- [ ] Walkthrough report saved to `.workflow/05_implementation/`
