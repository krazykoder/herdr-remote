# Phase 2.14 Agent Task: Documentation Sync

**Date**: 2026-02-12  
**Plan**: [Phase 2.14 Doc Sync Plan](file:///Users/towshif/code/python/algoFlow/.workflow/04_implementation_plans/2026-02-12_phase2_14_documentation_sync.md)  
**Scope**: Update all architecture docs to reflect Phase 2.0–2.13 changes

---

## Context

Phase 2 (2.0–2.13) made major changes to the AlgoFlow pipeline that are NOT reflected in architecture docs:

1. **StatStore → PerfStore** rename (Phase 2.13)
2. **AlgoID** — deterministic identity for algo configs (Phase 2.12)
3. **AlgoID Ownership** — FlowRunner generates AlgoID from `input_variant` (declarative spec), not `param_overrides` (resolved arrays) (Phase 2.13)
4. **Store Consolidation** — `cell_<id>/` eliminated; consolidated `signals/{symbol}.parquet`, `perf/summary.parquet`, `manifest.json` (Phase 2.13)
5. **Promote Flag** — DSL `outputs` config: `"promote": true` copies algo outputs to ParamStore (Phase 2.12)
6. **AlgoID-based dedup** — cache check in SignalStore before execution (Phase 2.13)
7. **Algo Commit** — `bake()` + `commit_to_registry()` pipeline (Phase 2.13)
8. **New modules** — `identity.py`, `algo_commit.py`, `naming.py`, PerfStore, Tests 45–53

## Instructions

### Skill Reference
Use the **Update Architecture Documentation** skill:
```
/Users/towshif/code/python/algoFlow/.agent/skills/update_architecture_docs/SKILL.md
```

### Files to Update (in order)

#### 1. `module_map.md` (version → v2.14)
- Add new files: `algoflow/core/identity.py`, `algoflow/core/algo_commit.py`, `algoflow/utils/naming.py`
- Rename all `StatStore` → `PerfStore`
- Add tests 45–53 with one-line descriptions
- Update store list: DataStore, ParamStore, SignalStore, TradeStore, **PerfStore**

#### 2. `GUIDE_DSL_SCHEMA.md` (version → v2.14)
- Add `outputs` config section:
  ```json
  "outputs": {
    "signal": {},
    "trend": {},
    "weight": {"promote": true}
  }
  ```
- Document `promote: true` behavior (copies to local + shared ParamStore)
- Add `input_variant` identity spec:
  ```json
  {"spy_ema": {"source": "_EMA21", "symbol": "SPY"}}
  ```
- Document how DSL config contributes to AlgoID hash

#### 3. `ARCHITECTURE_CONTEXTS.md` (version → v2.14)
- Rename `StatStore` → `PerfStore` (2 refs)
- Add to PipelineContext: `algo_id: AlgoID`, `algo_config: dict`
- Add to FlowCell: `input_variant: dict`, `algo_id: str`
- Replace per-cell storage diagram with consolidated layout:
  ```
  simulation_output/
  ├── manifest.json
  ├── data/, params/shared.parquet
  ├── signals/{symbol}.parquet
  ├── perf/summary.parquet
  └── trades/all_trades.json
  ```

#### 4. `ARCHITECTURE_EXECUTION_FLOW.md` (version → v2.14)
- Rename `StatStore` → `PerfStore`
- Add to execution sequence:
  - Step 0.5: AlgoID generation (FlowRunner, from `input_variant` spec)
  - After algo: `_promote_outputs()` step
  - Before algo: cache check (dedup via AlgoID)
- Add identity flow diagram:
  ```
  input_variant (spec) → AlgoID hash (identity)
  param_overrides (arrays) → DSL Engine (execution)
  ```

#### 5. `ARCHITECTURE_CONTRACT.md` (version → v2.14)
- Add invariants:
  - "FlowRunner owns AlgoID generation (downstream authority)"
  - "Same plain config dict → same AlgoID → SignalStore cache hit"
  - "param_overrides (resolved arrays) never enter AlgoID hash"
  - "Promoted outputs exist in both SignalStore and ParamStore"
  - "Consolidated storage: no per-cell directories"

#### 6. `ARCHITECTURE.md`
- Rename `StatStore` → `PerfStore`
- Update storage layout if present

#### 7. `ARCHITECTURE_DESIGN_ALGO_REGISTRY.md`
- Add `outputs` schema with `promote` flag
- Add AlgoID field documentation

### Reference Files (READ before editing)
- `algoflow/core/identity.py` — AlgoID class
- `algoflow/core/algo_commit.py` — bake/commit
- `algoflow/pipeline/flow_runner.py` — Lines 168–240 (identity), 556–577 (promote)
- `algoflow/simulation/simulation_runner.py` — Lines 82–104 (sweep + AlgoID), 307–332 (run_stage)
- `algoflow/stores/perf_store.py` — PerfStore API
- `.workflow/06_reviews/2026-02-12_post_phase2_13_reassessment.md` — Current state of all items

### Verification
After all edits, run:
```bash
# Zero StatStore refs in architecture docs
grep -r "StatStore" .workflow/02_architecture/ | grep -v archive | wc -l  # expect 0

# PerfStore present in key docs
grep -l "PerfStore" .workflow/02_architecture/{ARCHITECTURE_CONTEXTS,ARCHITECTURE_EXECUTION_FLOW,module_map}.md

# AlgoID / promote / input_variant documented
grep -l "promote" .workflow/02_architecture/GUIDE_DSL_SCHEMA.md
grep -l "input_variant" .workflow/02_architecture/ARCHITECTURE_EXECUTION_FLOW.md
grep -l "AlgoID" .workflow/02_architecture/ARCHITECTURE_CONTEXTS.md

# All updated docs have v2.14 header
grep "Version.*2.14" .workflow/02_architecture/{GUIDE_DSL_SCHEMA,module_map,ARCHITECTURE_CONTEXTS,ARCHITECTURE_EXECUTION_FLOW,ARCHITECTURE_CONTRACT}.md
```

### Deliverables
1. Updated docs (7 files)
2. Walkthrough: `.workflow/05_implementation/2026-02-12_phase2_14_documentation_sync_walkthrough.md`
3. Session log update
