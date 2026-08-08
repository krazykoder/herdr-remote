---
name: auto_test_gen
description: Procedure for automatically generating advanced DSL stress tests (v5-v10) based on v4 template.
---

# Auto Test Generation Skill

## Goal
Generate a suite of "Ultimate Complexity" stress tests (v5 through v10) for the AlgoFlow DSL pipeline. Each test must use a unique logic scenario, distinct JSON definition, and a corresponding verification script derived from `28_stress_test_v4.py`.

## Procedure

### 1. Define Scenarios
Identify distinct logic patterns to stress different parts of the compiler and engine:
- **v5 (MACD)**: Signal line crossovers (Logic: `MACD > Signal`).
- **v6 (ADX)**: Trend strength logic (Logic: `ADX > 25 AND DI+ > DI-`).
- **v7 (Multi-Timeframe)**: Simulated via input aliasing (Logic: `Close > SMA50_Daily` where SMA50 is distinct input).
- **v8 (Volume/VWAP)**: Volume-weighted logic (Logic: `Close > VWAP`).
- **v9 (Trailing Stop)**: Complex exit logic overrides.
- **v10 (Kitchen Sink)**: Combination of all above.

### 2. Implement Generator Script
Create `dev_signalFlow/utils/generate_stress_tests.py` with the following capabilities:
- **Templates**:
    - `DSL_TEMPLATE`: JSON structure with placeholders for `inputs`, `nodes`, `params`.
    - `SCRIPT_TEMPLATE`: Python script structure based on `28_stress_test_v4.py` (with `ROOT_DIR` fix).
- **Configuration**:
    - Dictionary mapping `vN` -> `{ logic_def, input_def, override_scenarios }`.
- **Output**:
    - Writes `test_complex_overrides_v{N}.json` to `dev_signalFlow/backend/tsignalCore/lib/dsl/`.
    - Writes `{24+N}_stress_test_v{N}.py` to `tests/e2e/`.

### 3. Execution & Verification
- Run: `python dev_signalFlow/utils/generate_stress_tests.py`
- Verify: Check that files exist and contain correct logic.
- (Optional) Run individual tests: `python tests/e2e/{24+N}_stress_test_v{N}.py`.

### 4. Best Practices & Troubleshooting
- **Registry Mocking**: Always check `ParamRegistry.get(name)` before registering mocks. Use `ParamRegistry.register(name, 'python', args=[], description='Mock')` to satisfy `ParamEngine` validation for missing indicators.
- **Multi-Output Configs**: When mocking `ParamConfigManager` for multi-output indicators (e.g., MACD), explicitly provide the `output_names` list (e.g., `["macd", "macd_signal"]`). Failing to do so causes "output count mismatch" errors.
- **Template Indentation**: Python code inside multi-line string templates is highly sensitive to indentation. Ensure `replace_file_content` or manual edits preserve the correct whitespace, especially for imports and function definitions.
- **Prototype Registration**: Any new logic prototype (e.g., `cmo_trend_proto`) must be registered in `FunctionRegistry` within the generated script to be accessible by the DSL engine.
