# Phase 2.9 Agent Task: Cross-Symbol Input Schema Refactor

---

## Environment

- **Python**: Use `.venv313` at workspace root (`source .venv313/bin/activate`)
- **Workspace**: `/Users/towshif/code/python/algoFlow`
- **Key Files**: `algoflow/pipeline/flow_runner.py`, `algoflow/simulation/simulation_runner.py`

---

## Context

The current cross-symbol input resolution uses bracket notation `"[SPY][_EMA21]"` which requires regex parsing, has 3 resolution paths, and caused bugs where bracket strings flow as raw strings. We're replacing this with a clean `symbol` + `source` field design.

**New schema**:
```json
"spy_ema": {
    "type": "float64",
    "source": "_EMA21",
    "symbol": "SPY"
}
```

**Rule**: If `symbol` field present → fetch from `shared_param_store[symbol][source]`. If absent → use current symbol's params.

**Backward compat**: `default_source` (without brackets) is treated as alias for `source`. This avoids touching 15+ stress test files that use `"default_source": "_EMA21"`.

---

## Steps

### Step 1: Add `_resolve_cross_symbol_inputs()` to FlowRunner

**File**: `algoflow/pipeline/flow_runner.py`

Add a new method that resolves inputs with a `symbol` field from `shared_param_store`:

```python
def _resolve_cross_symbol_inputs(self, algo_name, inputs, shared_param_store):
    """
    Resolve DSL inputs that have a 'symbol' field (cross-symbol references).
    
    For each DSL input definition that includes 'symbol', fetch the value
    from shared_param_store[symbol][source] and add it to inputs.
    Also handles backward-compat 'default_source' (without brackets) as 
    alias for 'source' for same-symbol param resolution.
    """
    dsl_key = self._resolve_dsl_key(algo_name)  # reuse existing key resolution
    if not dsl_key:
        return
    entry = self.dsl_engine.get_registered_dsl(dsl_key)
    if not entry:
        return
    dsl_inputs = entry.get('dsl_config', {}).get('inputs', {})
    
    for input_name, input_def in dsl_inputs.items():
        if not isinstance(input_def, dict):
            continue
        if input_name in inputs:
            continue  # Already provided by caller/OHLCV/params
        
        # Cross-symbol: has 'symbol' field
        sym = input_def.get('symbol')
        source = input_def.get('source') or input_def.get('default_source')
        
        if sym and source and shared_param_store:
            if shared_param_store.has(sym, source):
                inputs[input_name] = shared_param_store.get(sym, source)
        elif source and not sym:
            # Same-symbol default_source: look in current inputs
            if source in inputs:
                inputs[input_name] = inputs[source]
```

### Step 2: Extract `_resolve_dsl_key()` helper (if not exists)

The DSL key resolution logic (lines ~460-480) is reused. If it's not already a separate method, extract it so `_resolve_cross_symbol_inputs` can use it.

### Step 3: Integrate resolution into `run()`

**File**: `algoflow/pipeline/flow_runner.py`

Call `_resolve_cross_symbol_inputs()` after `_prepare_inputs()` and param overrides, but BEFORE `_execute_algo()`:

```python
# After _prepare_inputs and param_overrides:
inputs = self._prepare_inputs(symbol, ohlcv, required_inputs, use_cache)

# Apply param overrides (if any)
if param_overrides:
    for key, value in param_overrides.items():
        inputs[key] = value
        if isinstance(value, np.ndarray):
            ctx.param_store.set(symbol, key, value)

# NEW: Resolve cross-symbol inputs from DSL schema
self._resolve_cross_symbol_inputs(algo_name, inputs, shared_param_store)

# Store all resolved inputs
for key, val in inputs.items():
    if isinstance(val, np.ndarray):
        ctx.param_store.set(symbol, key, val)

# Execute algo — inputs are now ALL resolved arrays
result = self._execute_algo(algo_name, inputs, algo_params, shared_param_store)
```

### Step 4: Clean up old bracket resolution code

**File**: `algoflow/pipeline/flow_runner.py`

1. **Delete** `_resolve_input_source()` method (lines ~84-113)
2. **Remove** bracket detection in `param_overrides` block (lines ~213-216)
3. **Remove** `default_source` bracket resolver in `_execute_algo()` (lines ~485-504)
4. **Remove** post-execution persistence loop (lines ~244-248) — now handled before execution

### Step 5: Update SimulationRunner `input_variant` resolution

**File**: `algoflow/simulation/simulation_runner.py`

In `run_stage(Stage.ALGO)`, resolve structured `input_variant` dicts before passing to `FlowRunner`:

```python
# Around line 253, replace:
param_overrides = dict(cell.input_variant)

# With:
param_overrides = {}
for key, val in cell.input_variant.items():
    if isinstance(val, dict) and 'symbol' in val:
        # Structured cross-symbol override
        sym = val['symbol']
        source = val.get('source', key)
        if sim_ctx.shared_param_store.has(sym, source):
            param_overrides[key] = sim_ctx.shared_param_store.get(sym, source)
    else:
        param_overrides[key] = val
```

### Step 6: Update Test 46

**File**: `tests/e2e/46_dsl_cross_symbol.py`

Update DSL config:
```python
# BEFORE:
"spy_ema": {
    "type": "float64",
    "default_source": "[SPY][_EMA21]"
}

# AFTER:
"spy_ema": {
    "type": "float64",
    "source": "_EMA21",
    "symbol": "SPY"
}
```

Update `input_variants` in `define_sweep`:
```python
# BEFORE:
input_variants=[
    {},
    {"spy_ema": "[SPY][_EMA21]"}
]

# AFTER:
input_variants=[
    {},
    {"spy_ema": {"source": "_EMA21", "symbol": "SPY"}}
]
```

Update assertions:
- Explicit test: `aapl_ctx.param_store.has("AAPL", "spy_ema")` should now be ✅ (resolved before execution)
- Implicit test: Same — resolved before execution, stored in param_store
- Convert `⚠️` warnings to hard `assert` statements

### Step 7: Update Test 45 (pipeline control)

**File**: `tests/e2e/45_pipeline_control.py` and `tests/e2e/45_pipeline_control_real.py`

Update any bracket notation in DSL configs or `input_variants` to use `symbol` + `source` dicts.

### Step 8: Update DSL Schema Guide

**File**: `.workflow/02_architecture/GUIDE_DSL_SCHEMA.md`

Document the new `symbol` and `source` fields in the inputs section:
```
### Cross-Symbol Inputs
To reference parameters from another symbol:
  "spy_ema": {
      "type": "float64",
      "source": "_EMA21",    # param name in the source symbol
      "symbol": "SPY"         # source symbol (omit for current symbol)
  }
```

---

## DO NOT Change

- **Stress tests (27-40)**: These use `default_source: "_EMA21"` (same-symbol, no brackets). The backward compat alias handles these.
- **DSL JSON files**: Same-symbol `default_source` works as-is.
- **DSLEngine**: No changes needed — it receives resolved arrays.
- **ParamEngine**: No changes needed.

---

## Verification

```bash
source .venv313/bin/activate

# Primary: cross-symbol with new schema
python tests/e2e/46_dsl_cross_symbol.py

# Pipeline control
python tests/e2e/45_pipeline_control.py

# Backward compat
python tests/e2e/42_architecture_alignment.py
python tests/e2e/39B_master_test_simulate_variants.py
python tests/e2e/39A_master_test_simple.py
```

---

## Post-Implementation Report

Create: `.workflow/05_implementation/2026-02-10_phase2_9_walkthrough.md`

Include:
1. **Changes Summary**: What was refactored
2. **Before/After**: Show old bracket notation vs new `symbol` field
3. **Test Results**: All test outcomes
4. **Backward Compat Verification**: Confirm stress tests still pass without changes
5. **Code Deleted**: List all removed bracket parsing code

---

## Acceptance Criteria

- [ ] `_resolve_input_source()` deleted
- [ ] `_resolve_cross_symbol_inputs()` added — single resolution point
- [ ] No bracket strings `[X][Y]` in production code
- [ ] `param_overrides` only receives numpy arrays (structured dicts resolved in SimulationRunner)
- [ ] Test 46: both explicit and implicit paths use `symbol` field schema
- [ ] Test 46: `spy_ema` persisted to `param_store` (both paths ✅, no ⚠️)
- [ ] Backward compat: `default_source` without brackets still works
- [ ] All regression tests pass (39A, 39B, 42, 45, 46)
- [ ] Walkthrough saved to `.workflow/05_implementation/`
