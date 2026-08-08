# Agent Task: Execute Phase 2.6 SimulationRunner Alignment

**Priority**: P0  
**Estimated Effort**: 1-2 days  
**Plan Reference**: `.workflow/04_implementation_plans/2026-02-09_phase2_6_simulation_alignment_plan.md`

---

## Environment & Testing

> [!IMPORTANT]
> - **Python**: Always use `.venv313` at workspace root: `source .venv313/bin/activate`
> - **Test Templates**: Copy `tests/e2e/39A_master_test_simulate.py` or `39B_master_test_simulate_variants.py` as templates.

---

## Core Decisions

1. **No backward compat**: Replace `SimulationResult` entirely with `SimulationContext`.
2. **Data Persistence**: `DataStore` holds raw OHLCV, persisted as Parquet.
3. **Cross-symbol access**: Single `shared_param_store` for all symbols' params.
4. **Stage-aware execution**: `FlowRunner` accepts `stages` parameter for partial runs.
5. **Execution order**: Data(ALL) → Params(ALL) → Algo(each) → Trades → Perf.

---

## Steps

### Step 0: Create DataStore

**File**: `algoflow/stores/data_store.py` (New)

```python
class DataStore:
    def __init__(self):
        self._data: Dict[str, pd.DataFrame] = {}
        
    def add(self, symbol: str, df: pd.DataFrame): ...
    def get(self, symbol: str) -> pd.DataFrame: ...
    def list_symbols(self) -> List[str]: ...
    def save(self, path: str): ... # Parquet
    def load(self, path: str): ...
```

**Also**: Update `algoflow/stores/__init__.py`.

---

### Step 1: Define Stage Enum

**File**: `algoflow/core/context.py`

```python
from enum import Enum

class Stage(Enum):
    DATA = "data"
    PARAMS = "params"
    ALGO = "algo"
    TRADES = "trades"
    PERF = "perf"
```

Update `PipelineContext`:
- Add `completed_stages: List[Stage]`
- Add `data_store: DataStore` (optional reference)

---

### Step 2: Create SimulationContext

**File**: `algoflow/simulation/context.py` (New)

```python
@dataclass
class SimulationContext:
    data_store: DataStore
    shared_param_store: ParamStore
    contexts: Dict[str, PipelineContext] = field(default_factory=dict)
    matrix: List[FlowCell] = field(default_factory=list)
    
    def add(self, cell: FlowCell, ctx: PipelineContext):
        self.matrix.append(cell)
        self.contexts[cell.cell_id] = ctx
    
    def save(self, output_dir: str):
        """Save data + params + contexts."""
        os.makedirs(output_dir, exist_ok=True)
        self.data_store.save(os.path.join(output_dir, "data"))
        self.shared_param_store.save(
            os.path.join(output_dir, "shared_params.parquet"))
        for cell in self.matrix:
            cell_dir = os.path.join(output_dir, f"cell_{cell.cell_id}")
            self.contexts[cell.cell_id].save(cell_dir)
        with open(os.path.join(output_dir, "matrix.json"), "w") as f:
            json.dump([c.to_dict() for c in self.matrix], f, indent=2)
```

---

### Step 3: Replace SimulationResult

**File**: `algoflow/simulation/results.py`

- Delete `SimulationResult` class
- Keep `FlowCell` dataclass

---

### Step 4: Refactor SimulationRunner

**File**: `algoflow/simulation/simulation_runner.py`

```python
def run(self, progress=True) -> SimulationContext:
    # Phase 0: Load ALL Data
    data_store = DataStore()
    unique_symbols = set(cell.symbol for cell in self.matrix)
    for symbol in unique_symbols:
        df = self.flow_runner.load_data(symbol)
        data_store.add(symbol, df)

    # Phase 1: Pre-compute ALL params
    shared_params = ParamStore()
    for symbol in unique_symbols:
        # Pass data_store to avoid reload
        params = self.flow_runner.generate_params(
            symbol, data_store.get(symbol)) 
        for name, arr in params.items():
            shared_params.set(symbol, name, arr)
    
    # Phase 2: Execute variants
    sim_ctx = SimulationContext(
        data_store=data_store, 
        shared_param_store=shared_params
    )
    for cell in self.matrix:
        ctx = self.flow_runner.run(
            symbol=cell.symbol,
            algo_name=cell.algo,
            data_store=data_store,             # Use cached data
            shared_param_store=shared_params,  # Cross-symbol access
            start_stage=Stage.ALGO,            # Params already done
            ...
        )
        sim_ctx.add(cell, ctx)
    
    return sim_ctx
```

---

### Step 5: Refactor FlowRunner

**File**: `algoflow/pipeline/flow_runner.py`

```python
def run(
    self,
    symbol: str,
    algo_name: str,
    stages: List[Stage] = None,        # NEW: which stages to run
    start_stage: Stage = None,         # NEW: resume from stage
    context: PipelineContext = None,   # NEW: pre-existing context
    data_store: DataStore = None,      # NEW: cached data
    shared_param_store: ParamStore = None, # NEW: cross-symbol
    **kwargs
) -> PipelineContext:
```

Logic:
1. If `data_store` provided, use it. Else load from source.
2. If `context` provided, resume from it.
3. If `shared_param_store` provided, use it.
4. If `stages` provided, only execute those stages.

---

### Step 6: Verification

**File**: `tests/e2e/44_simulation_context.py` (New)

1. **Cross-symbol**: Run algo on AAPL that reads `SPY.ema21`.
2. **Partial pipeline**: Run params-only, save, load, resume at algo stage.
3. **Full simulation**: Run multi-variant sweep, verify `SimulationContext`.
4. **Persistence**: Save/load `SimulationContext`, compare data.
5. **DataFrame**: Verify `to_dataframe()` output.

---

## Acceptance Criteria

- [ ] `SimulationResult` replaced by `SimulationContext`
- [ ] `DataStore` persists raw OHLCV
- [ ] `shared_param_store` populated for all symbols
- [ ] Cross-symbol param access works
- [ ] Stage-aware execution works (partial + resume)
- [ ] Test 44 passes
- [ ] Create Walkthrough Report upon completion