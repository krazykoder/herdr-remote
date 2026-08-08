# Agent Task: Execute Phase 2.1 Trade/Perf Integration

**Priority**: P0  
**Estimated Effort**: 1 day  
**Plan Reference**: `.workflow/04_implementation_plans/2026-02-09_phase2_1_trade_perf_plan.md`

---

## Objective

Integrate the existing `TradeExecutor` and `MetricsCalculator` modules into `FlowRunner`. After completion, every simulation run will produce trades, P&L, and performance metrics.

---

## Steps

### Step 1: Fix Bug in executor.py

**File**: `algoflow/stages/trades/executor.py`  
**Line**: 62  
**Fix**: Change `names` to `dates`

```diff
-                    self._close_trade(current_trade, names, prices, i)
+                    self._close_trade(current_trade, dates, prices, i)
```

**Verify**: `python -c "from algoflow.stages.trades.executor import TradeExecutor; print('OK')"` should not error.

---

### Step 2: Modify FlowRunner

**File**: `algoflow/pipeline/flow_runner.py`

#### 2.1 Add imports at top:
```python
from algoflow.stages.trades.executor import TradeExecutor
from algoflow.stages.trades.types import Trade
from algoflow.stages.perf.metrics import MetricsCalculator, PerformanceReport
from typing import List
```

#### 2.2 Modify `__init__` to add:
```python
self._trade_executor = TradeExecutor()
self._metrics_calc = MetricsCalculator()
```

#### 2.3 Add new method `_execute_trades`:
```python
def _execute_trades(
    self, 
    symbol: str,
    dates: np.ndarray,
    prices: np.ndarray, 
    signals: np.ndarray
) -> List[Trade]:
    """Convert signals to trades."""
    return self._trade_executor.execute(symbol, dates, prices, signals)
```

#### 2.4 Add new method `_calculate_perf`:
```python
def _calculate_perf(
    self,
    prices: np.ndarray,
    signals: np.ndarray,
    trades: List[Trade]
) -> PerformanceReport:
    """Calculate performance metrics."""
    return self._metrics_calc.compute(prices, signals, trades)
```

#### 2.5 Modify `run()` method to add trade/perf execution after algo execution:
After the line that calls `self._execute_algo(...)`, add:

```python
# Trade & Performance Execution
signals = result.get('signal', result.get('trend', np.zeros(len(prices))))
dates = ohlcv.get('date', ohlcv.get('timestamp', np.arange(len(signals))))
prices_arr = ohlcv.get('close', ohlcv.get('Close', np.array([])))

if len(signals) > 0 and len(prices_arr) > 0:
    trades = self._execute_trades(symbol, dates, prices_arr, signals)
    perf = self._calculate_perf(prices_arr, signals, trades)
    result['trades'] = trades
    result['perf'] = perf
    result['perf_summary'] = {
        'total_return': perf.total_return,
        'sharpe_ratio': perf.sharpe_ratio,
        'max_drawdown': perf.max_drawdown,
        'total_trades': perf.total_trades,
        'win_rate': perf.win_rate
    }
```

---

### Step 3: Create E2E Test

**File**: `tests/e2e/38_flow_runner_trades_perf.py`

Create a test that:
1. Initializes FlowRunner with real engines
2. Runs a known algo (e.g., `logic1_flow`)
3. Asserts `result['trades']` is a list
4. Asserts `result['perf']` is a PerformanceReport
5. Asserts `result['perf_summary']['sharpe_ratio']` is not NaN

---

### Step 4: Run Regression Tests

```bash
# Run existing stress tests to ensure no breakage
python tests/e2e/26_stress_test_v2.py
python tests/e2e/27_stress_test_v3.py
python tests/e2e/28_stress_test_v4.py
```

All should pass.

---

### Step 5: Update Mega Stress Test (Optional)

**File**: `tests/e2e/35_mega_stress_test.py`

Modify to print/log performance metrics for each variant:
```python
print(f"Variant {key}: Sharpe={result['perf_summary']['sharpe_ratio']:.2f}")
```

---

## Acceptance Criteria

- [ ] `executor.py` bug fixed
- [ ] `FlowRunner.run()` returns `trades` list
- [ ] `FlowRunner.run()` returns `perf` PerformanceReport
- [ ] `FlowRunner.run()` returns `perf_summary` dict
- [ ] E2E test `38_flow_runner_trades_perf.py` passes
- [ ] Regression tests v2-v10 still pass

---

## Completion

After all steps are done:
1. Create walkthrough in `.workflow/05_implementation/2026-02-09_Phase2.1_Walkthrough.md`
2. Update `.antigravity/project_context.md` with Phase 2.1 feature note
3. Update `.antigravity/task.md` to mark items complete
