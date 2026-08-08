# Phase 2.11 Agent Task: Store API Completeness & Compiler Safety

---

## Environment

- **Python**: Use `.venv313` at workspace root (`source .venv313/bin/activate`)
- **Workspace**: `/Users/towshif/code/python/algoFlow`

---

## Context

Phase 2.10 established the 5-store architecture (DataStore, ParamStore, SignalStore, TradeStore, StatStore) with basic CRUD and persistence. Phase 2.11 brings these stores to **full API parity**, adds a `to_dataframe()` bridge for analysis, cleans up legacy bracket notation, and adds compiler safety.

**Implementation Plan**: `.workflow/04_implementation_plans/2026-02-11_phase2_11_store_api_completeness.md`

**Key files**:
- `algoflow/stores/param_store.py`
- `algoflow/stores/signal_store.py`
- `algoflow/stores/trade_store.py`
- `algoflow/stores/stat_store.py`
- `algoflow/stores/data_store.py`
- `algoflow/pipeline/flow_runner.py`
- `dev_signalFlow/backend/tsignalCore/engine/flow/flow_numba_dsl_engine.py`

---

## Steps

### Step 1: Group A — Store CRUD Parity

**ParamStore** (`algoflow/stores/param_store.py`):
- Add `remove(symbol, param_name)` — delete `_store[symbol][param_name]`, raise KeyError if missing
- Add `remove_symbol(symbol)` — delete entire `_store[symbol]`, raise KeyError if missing

**SignalStore** (`algoflow/stores/signal_store.py`):
- Add `remove(symbol, algo_name)` — delete `_store[symbol][algo_name]`
- Add `remove_symbol(symbol)` — delete entire `_store[symbol]`

**TradeStore** (`algoflow/stores/trade_store.py`):
- Add `has()` → `bool` — return `len(self._trades) > 0`
- Add `count()` → `int` — return `len(self._trades)`
- Add `get_by_symbol(symbol)` → `List[Trade]` — filter by `trade.ticker == symbol`
- Add `get_by_status(status)` → `List[Trade]` — filter by `trade.status == status`
- Add `remove_by_symbol(symbol)` — filter out trades for that ticker

**StatStore** (`algoflow/stores/stat_store.py`):
- Add `remove(stat_name)` — delete `_store[stat_name]`, raise KeyError if missing

### Step 2: Group B — Store Merge & Transform

**DataStore** (`algoflow/stores/data_store.py`):
- Add `merge(other: DataStore)` — iterate `other._data`, overwrite on conflict
- Add `transform(symbol, func)` — `self._data[symbol] = func(self._data[symbol])`

**ParamStore** (`algoflow/stores/param_store.py`):
- Add `merge(other: ParamStore)` — deep merge: for each symbol/param in other, `self.set(symbol, param, values)`

**SignalStore** (`algoflow/stores/signal_store.py`):
- Add `merge(other: SignalStore)` — deep merge: for each symbol/algo in other, `self.set(symbol, algo, values)`

### Step 3: Group C — `to_dataframe()` Bridge

**TradeStore**:
- Add `to_dataframe()` → `pd.DataFrame` — convert `self._trades` to DataFrame using `dataclasses.asdict()` per trade

**ParamStore**:
- Add `to_dataframe(symbol=None)` → `pd.DataFrame`
  - If `symbol` specified: return DataFrame with param names as columns for that symbol
  - If `None`: return DataFrame with MultiIndex columns `(symbol, param_name)`

**SignalStore**:
- Add `to_dataframe(symbol=None)` → `pd.DataFrame`
  - Same pattern as ParamStore but with `(symbol, algo_name)` MultiIndex

**StatStore**:
- Add `to_dataframe()` → `pd.DataFrame` — stat names as columns

### Step 4: Group D — Compiler Safety (`result_var` uniqueness)

**File**: `dev_signalFlow/backend/tsignalCore/engine/flow/flow_numba_dsl_engine.py`

In the compilation path (before code generation), scan all nodes for `result_var` values:

```python
# During compilation, check for duplicate result_var
result_vars = {}
for node_id, node in nodes.items():
    rv = node.get('params', {}).get('result_var')
    if rv and rv in result_vars:
        raise ValueError(
            f"Duplicate result_var '{rv}' in nodes '{result_vars[rv]}' and '{node_id}'. "
            f"Each result_var must be unique within a DSL."
        )
    if rv:
        result_vars[rv] = node_id
```

Add this check in `_generate_flow_main_function()` or the compilation entry point, before code generation begins.

### Step 5: Group E — Bracket Notation Cleanup

**File**: `algoflow/pipeline/flow_runner.py`

Clean up `_resolve_cross_symbol_inputs()` (lines 100-155):
- **Remove** the `startswith('[')` bracket check (line 153)
- **Remove** the `default_source` same-symbol fallback (lines 149-155) — this was backward compat for pre-Phase 2.9
- **Remove** commented-out debug prints
- **Simplify** to ONLY handle `symbol` + `source` field pattern:

```python
def _resolve_cross_symbol_inputs(self, algo_name, inputs, shared_param_store):
    """Resolve DSL inputs with 'symbol' field (cross-symbol references)."""
    dsl_key = self._resolve_dsl_key(algo_name)
    if not dsl_key or not self.dsl_engine:
        return

    entry = self.dsl_engine.get_registered_dsl(dsl_key)
    if not entry:
        return

    dsl_inputs = entry.get('dsl_config', {}).get('inputs', {})

    for input_name, input_def in dsl_inputs.items():
        if not isinstance(input_def, dict):
            continue
        if input_name in inputs:
            continue

        sym = input_def.get('symbol')
        source = input_def.get('source')

        if sym and source and shared_param_store:
            if shared_param_store.has(sym, source):
                inputs[input_name] = shared_param_store.get(sym, source)
```

### Step 6: Group F — Naming Convention Doc

Create `.workflow/02_architecture/NAMING_CONVENTIONS.md`:
- Document the confirmed prefix table (`_`, `#`, `%`)
- Note unassigned prefixes (`$`, `@`, `*`, `+`) as TBD
- State the scope: convention for frontend grouping / DataFrame export, not internal enforcement
- Add optional `validate_prefix(name)` soft utility that warns on non-conforming names

### Step 7: Tests

**Create** `tests/unit/test_store_api.py`:
- Test `remove()` on ParamStore, SignalStore, StatStore
- Test `remove_symbol()` on ParamStore, SignalStore
- Test TradeStore: `has()`, `count()`, `get_by_symbol()`, `get_by_status()`, `remove_by_symbol()`
- Test `merge()` on DataStore, ParamStore, SignalStore (including conflict overwrite)
- Test `transform()` on DataStore
- Test `to_dataframe()` on all 4 stores (ParamStore, SignalStore, TradeStore, StatStore)

**Create** `tests/unit/test_dsl_validation.py`:
- Test `result_var` duplicate detection raises error

**Run regression**:
```bash
source .venv313/bin/activate
python tests/e2e/39B_master_test_simulate_variants.py
python tests/e2e/46_dsl_cross_symbol.py
python tests/e2e/47_context_graduation_test.py
```

---

## DO NOT Change

- **Stress tests (27-40)**: These use `default_source: "_EMA21"` (same-symbol). Check if any break after removing `default_source` fallback from FlowRunner. If they do, keep `default_source` as an alias for `source` (without symbol).
- **DSLEngine**: No changes — it receives resolved arrays
- **ParamEngine**: No changes
- **DataStore**: Already has `has()`, `remove()`, `update()` — no CRUD changes needed
- **Existing method signatures**: Do NOT change — only add new methods

---

## Post-Implementation Report

Create: `.workflow/05_implementation/2026-02-11_phase2_11_store_api_completeness.md`

Include:
1. **Changes Summary**: All new methods added per store
2. **API Matrix (after)**: Updated matrix showing full parity
3. **Test Results**: Unit test + regression outcomes
4. **Code Deleted**: Removed bracket notation code from FlowRunner
5. **Naming Convention**: Reference doc created

---

## Acceptance Criteria

- [ ] All 4 remaining stores have `remove()` methods
- [ ] TradeStore has `has()`, `get_by_symbol()`, `get_by_status()`, `count()`
- [ ] `merge()` works on DataStore, ParamStore, SignalStore (other overwrites)
- [ ] `to_dataframe()` available on ParamStore, SignalStore, TradeStore, StatStore
- [ ] `result_var` duplication detected at compile time
- [ ] Bracket notation code removed from `FlowRunner._resolve_cross_symbol_inputs()`
- [ ] `NAMING_CONVENTIONS.md` created in `.workflow/02_architecture/`
- [ ] All unit tests pass (`test_store_api.py`, `test_dsl_validation.py`)
- [ ] All regression tests pass (39B, 46, 47)
- [ ] Walkthrough saved to `.workflow/05_implementation/`
