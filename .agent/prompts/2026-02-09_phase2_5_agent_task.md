# Agent Task: Execute Phase 2.5 JIT Optimization

**Priority**: P1  
**Estimated Effort**: 0.5 day  
**Plan Reference**: `.workflow/04_implementation_plans/2026-02-09_phase2_5_jit_optimization_plan.md`

---

## Core Decisions

1. **Always use `cache=True`** — Numba caching is always enabled
2. **Interactive mode uses `force_recompile=True`** — ensures fresh compile on edits
3. **`algo_fid` is system-managed** — users use `uid` alias only

---

## Steps

### Step 1: Enable Numba Caching in Code Generation

**File**: `dev_signalFlow/backend/tsignalCore/engine/flow/flow_numba_dsl_engine.py`

Find ALL lines where `@njit` decorator is generated and change to `@njit(cache=True)`.

Search for: `code.append("@njit")` or similar patterns.

**Verify**: After regenerating a DSL, grep output file for `cache=True`.

```bash
grep -r "cache=True" dev_signalFlow/backend/tsignalCore/engine/dslcode/
```

---

### Step 2: Add Warmup Method to DSLEngine

**File**: `dev_signalFlow/backend/tsignalCore/engine/dsl_engine.py`

Add method after `register_dsl`:

```python
def warmup_registered_dsl(self, registry_key: str, input_length: int = 10):
    """Trigger JIT compilation with dummy data."""
    entry = self.registry.get(registry_key)
    if not entry:
        return
    
    dummy_inputs = {
        name: np.random.random(input_length).astype(np.float64) 
        for name in entry['input_names']
    }
    
    try:
        self.execute_registered_dsl(
            registry_key, 
            dummy_inputs, 
            printMapping=False, 
            use_tracking=False
        )
    except Exception:
        pass  # Ignore warmup errors
```

---

### Step 3: Create E2E Test for JIT Timing

**File**: `tests/e2e/40_jit_warmup_timing.py`

Test should:
1. Register a variant with `force_recompile=True`
2. Warmup → time it (expect ~0.5s)
3. Execute → time it (expect <0.01s)
4. Assert execution time < warmup_time / 10

---

### Step 4: Verify Cache Persistence (Second Run)

```bash
# First run - compiles
python tests/e2e/40_jit_warmup_timing.py

# Second run - should skip compile (check timing output)
python tests/e2e/40_jit_warmup_timing.py
```

---

### Step 5: Run Regression

```bash
python tests/e2e/35_mega_stress_test.py
python tests/e2e/37_mega_stress_test_batch_optimized.py
python tests/e2e/39A_master_test_simple.py
python tests/e2e/39B_master_test_simulate_variants.py
```

---

## Acceptance Criteria

- [ ] All `@njit` decorators in generated code include `cache=True`
- [ ] `DSLEngine.warmup_registered_dsl()` exists and works
- [ ] E2E test `40_jit_warmup_timing.py` passes
- [ ] Second run of same variant is 10x+ faster
- [ ] All regression tests pass

---

## Completion

1. Create walkthrough: `.workflow/05_implementation/2026-02-09_Phase2.5_Walkthrough.md`
2. Update `.antigravity/project_context.md`
3. Proceed to Phase 2.2 planning
