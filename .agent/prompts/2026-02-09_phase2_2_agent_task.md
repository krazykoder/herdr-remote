# Agent Task: Execute Phase 2.2 Pipeline Architecture

**Priority**: P1  
**Estimated Effort**: 1-2 days  
**Plan Reference**: `.workflow/04_implementation_plans/2026-02-09_phase2_2_persistence_plan.md`

---

## Core Decisions

1.  **Store-Manager Pattern**: Consistent architecture across all 4 stages.
2.  **Persistence**: Enable save/load on all stores.
3.  **Context Location**: `algoflow/core/context.py` (per ARCHITECTURE.md).
4.  **Validation**: Integrate `HealthCheck` with `TradeStore`.

---

## Steps

### Step 1: Implement TradeStore

**File**: `algoflow/stores/trade_store.py` (New)

```python
from typing import List
from algoflow.stages.trades.types import Trade

class TradeStore:
    def __init__(self):
        self._trades: List[Trade] = []
    
    def add(self, trade: Trade): ...
    def get_all(self) -> List[Trade]: ...
    def clear(self): ...
    def save(self, path: str): ...  # JSON
    def load(self, path: str): ...  # JSON
```

**Also update**: `algoflow/stores/__init__.py` to export `TradeStore`.

---

### Step 2: Activate Store Persistence

**Files**: `param_store.py`, `signal_store.py`, `stat_store.py`

| Store | Format | Helper |
|-------|--------|--------|
| `ParamStore` | Parquet | `algoflow/io/parquet.py` |
| `SignalStore` | Parquet | `algoflow/io/parquet.py` |
| `StatStore` | JSON | `json.dump/load` |
| `TradeStore` | JSON | `json.dump/load` with `asdict()` |

---

### Step 3: Create Config Managers

**Files**:
- `algoflow/stages/trades/config_manager.py` (New)
- `algoflow/stages/perf/config_manager.py` (New)

Simple dataclass-based managers for `initial_capital`, `risk_free_rate`, etc.

---

### Step 4: Create PipelineContext

**File**: `algoflow/core/context.py` (New) — **Per ARCHITECTURE.md**

```python
from dataclasses import dataclass, field
from algoflow.stores import ParamStore, SignalStore, TradeStore, StatStore

@dataclass
class PipelineContext:
    symbol: str
    algo_name: str
    param_store: ParamStore = field(default_factory=ParamStore)
    signal_store: SignalStore = field(default_factory=SignalStore)
    trade_store: TradeStore = field(default_factory=TradeStore)
    stat_store: StatStore = field(default_factory=StatStore)
    
    def save(self, output_dir: str): ...
    
    @classmethod
    def load(cls, output_dir: str) -> "PipelineContext": ...
```

---

### Step 5: Refactor FlowRunner

**File**: `algoflow/pipeline/flow_runner.py`

1.  Instantiate `PipelineContext` at start of `run()`.
2.  Populate `ctx.param_store` after param generation.
3.  Populate `ctx.signal_store` after algo execution.
4.  Populate `ctx.trade_store` after trade execution.
5.  Populate `ctx.stat_store` after metrics calculation.
6.  Return `ctx` (or keep Dict for backward compatibility).

---

### Step 6: Integrate HealthCheck

**File**: `algoflow/validation/health_check.py`

Update `HealthCheck.check()` to accept `TradeStore`:
```python
def check(
    self,
    param_store: ParamStore,
    stat_store: StatStore,
    signal_store: SignalStore,
    trade_store: TradeStore,  # NEW
    ohlcv: Dict[str, Dict[str, np.ndarray]]
) -> HealthReport:
```

Add trade validation:
- `trade_count > 0` (warning if no trades)
- Optional: PnL sanity check

---

### Step 7: Verification

**File**: `tests/e2e/42_architecture_alignment.py` (New)

1.  Run full pipeline → verify all 4 stores populated.
2.  Save context → verify 4 files created.
3.  Load context → verify data matches original.
4.  Run `HealthCheck` → verify report is healthy.

---

## Acceptance Criteria

- [ ] `TradeStore` exists and works
- [ ] All Stores support `save/load`
- [ ] `PipelineContext` in `algoflow/core/context.py`
- [ ] `FlowRunner` uses `PipelineContext`
- [ ] `HealthCheck` includes `TradeStore`
- [ ] Existing tests pass
