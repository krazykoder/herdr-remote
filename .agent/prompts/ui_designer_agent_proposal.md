# Proposal: Designer Agents (UI/UX Structural + Visual / Design-System)

> **Status:** Accepted & rewritten 2026-06-17. The two prompts now reflect AlgoFlow's
> actual reality (Phase Z workbench, vertical slices, real workflow dirs, no-fallback /
> presentation-only doctrines). This doc is a thin pointer — the prompts are the source of
> truth, not duplicated here.
>
> - [System_Prompt_9_UI_Designer.md](./System_Prompt_9_UI_Designer.md) — **active**
> - [System_Prompt_10_Visual_Designer.md](./System_Prompt_10_Visual_Designer.md) — **gated to ZR.P5**

## Problem

The Brainstormer → Architect → Implementer → Documenter pipeline handles logic/backend
well but had a frontend gap: the Architect defines module/data contracts but not layout,
flows, or control selection; the Implementer received no structured structural/visual spec.
UI decisions got made ad-hoc → inconsistent layout, missing controls, unconsidered states.

The first drafts of these two prompts were generic-SaaS boilerplate, disconnected from the
project on 7 axes (fictional `04.5/04.7` phases + paths, header/sidebar/statusbar grammar,
stock control vocab, missing our doctrines, an aesthetic that contradicted the shipped FE,
a no-code boundary that blocked the actual styling work, and full verbatim prompt copies
inside this proposal). The rewrite fixes all 7.

## Solution: two roles, clean structure-vs-aesthetics split

| Agent | Owns | Does NOT own | Status |
|---|---|---|---|
| **UI/UX Structural Designer** (P9) | layout, wireframes, flows, control selection, data-display contracts, interaction states | color, type, motion, CSS | **active** |
| **Visual / Design-System Designer** (P10) | token system, component skins, motion, theming | layout structure, control choice, flows, domain/backend | **gated to ZR.P5** |

## How they fit our real workflow (not fictional phases)

AlgoFlow ships in **vertical slices** (`ZR.P*`); the artifact hierarchy is
**Contracts → Specs → Plans → Code**. The designers operate inside a slice and **reuse
existing dirs** — there is no `04.5_ui_design/` or `04.7_visual_design/`:

```
slice ADR/contract (02_architecture, 03_specs)
        │
        ▼
UI/UX Structural Designer (P9)
  • CURRENT-vs-target ASCII anchored in real components (file:line)
  • gaps-vs-scope tables · tagged question ledger ([REDLINE]/[DECISION]/[IMAGE])
  • hybrid intake: agent drafts anchor, user supplies images for un-inferable deltas
  → intake workbook in 07_dev_notes/ → frozen structural contract in 03_specs/ + ADR
        │  (P4 structure frozen)
        ▼
Visual / Design-System Designer (P10)  — ZR.P5, greenfield
  • build ONE canonical token system from scratch (best-in-class)
  • supersede legacy: rebuild styles.css, retire lib/theme.ts, migrate workbench inline hex
  • light + dark first-class; canonical default deferred to P5 kickoff w/ reference images
  → P5 plan in 04_implementation_plans/ + token-arch ADR + token artifact in frontend/
        │
        ▼
Implementer → code · Documenter → verify
```

The P9 method is not theoretical — it is exactly the
[ZR.P4 structural intake workbook](../../.workflow/07_dev_notes/2026-06-17_zrp_p4_structural_intake/2026-06-17_zrp_p4_structural_intake.md)
already produced. Use it as the reference template.

## Resolved decisions (2026-06-17)

1. **Visual Designer = ZR.P5 greenfield, gated.** Not an always-on aesthetic agent. There
   is no real theme to honor — `styles.css` + `lib/theme.ts` + workbench inline hex are
   disposable legacy. The agent builds the canonical token system from scratch and migrates
   the workbench onto it (this requires writing CSS + inline→token `.tsx` edits — the old
   "no CSS/TS" boundary was wrong and is removed). Runs only after P4 structure freezes.
2. **Aesthetic direction = both themes first-class; canonical default deferred.** Light and
   dark are both first-class token sets from day one; the canonical default is chosen at P5
   kickoff with user reference images. (The first draft's "dark-mode-first" was drift.)
3. **Output = reuse existing dirs.** Intake → `07_dev_notes/`; frozen → `03_specs/` + ADR
   in `02_architecture/decision_log/`; build → `04_implementation_plans/`; the token
   artifact lands in `frontend/`. No new phase dirs.
4. **Doctrines encoded in both prompts.** Presentation-only (never mutate Session/domain),
   no-fallback / fail-loud verbatim errors, Class A/B/C change classification with backend
   escalation, `perfId` as canonical cohort identity, frozen `app/` (Z-INV-9), zero-ambiguity.

## Updated agent roster

| # | Agent | File | Slot | Authority |
|---|---|---|---|---|
| 1 | Brainstormer | `System_Prompt_1_Brainstormer.md` | concepts | requirements |
| 2 | Architect | `System_Prompt_2_Architect.md` | contracts→specs→plans | architecture |
| 3 | Implementer | `System_Prompt_3_Implementer.md` | code | execution |
| 4 | Documenter | `System_Prompt_4_Documenter.md` | review | docs |
| 5–8 | Context Dump / Auditor / Fixer / Explorer | `…_5..8` | utility | — |
| **9** | **UI/UX Structural Designer** | **`System_Prompt_9_UI_Designer.md`** | **per FE slice** | **layout, flows, controls** |
| **10** | **Visual / Design-System Designer** | **`System_Prompt_10_Visual_Designer.md`** | **ZR.P5 (gated)** | **tokens, skins, motion** |
