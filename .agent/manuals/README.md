# Agent Onboarding Workflow

[**🏠 Home**](./README.md) | [**📚 Full Reference**](./Full_Reference.md)

**Phases:** [1. Concepts](./phases/01_Concepts.md) | [2. Architecture](./phases/02_Architecture.md) | [3. Specs](./phases/03_Specs.md) | [4. Plans](./phases/04_Implementation_Plans.md) | [5. Impl](./phases/05_Implementation.md) | [6. Reviews](./phases/06_Reviews.md)

---

**Goal:** Build systems quickly WITHOUT architecture drift by separating Exploration, Decisions, Execution, and Audit.

For full details, see: [Full_Reference.md](./Full_Reference.md)

## Canonical Directory Structure

All persistent project knowledge lives under `/.workflow/`.

| Path | Phase | Purpose |
|------|-------|---------|
| `/.workflow/01_concepts/` | **1. Concepts** | Explore intent (non-binding) | [Guide](./phases/01_Concepts.md) |
| `/.workflow/02_architecture/` | **2. Architecture** | Commit to structure (binding) | [Guide](./phases/02_Architecture.md) |
| `/.workflow/03_specs/` | **3. Specs** | Define correctness | [Guide](./phases/03_Specs.md) |
| `/.workflow/04_implementation_plans/` | **4. Implementation Plans** | Implementation instructions | [Guide](./phases/04_Implementation_Plans.md) |
| `/.workflow/05_implementation/` | **5. Implementation** | Code & Tests | [Guide](./phases/05_Implementation.md) |
| `/.workflow/06_reviews/` | **6. Reviews** | Audit & Enforcement | [Guide](./phases/06_Reviews.md) |

## Quick Phase Overview

| Phase | Name | Owner | Primary Output |
|-----|-----|-------|--------|
| 1 | **Concepts** | Strategist (Gemini) | Concept docs |
| 2 | **Architecture** | Architect (Claude) | Contracts & Module Map |
| 3 | **Specs** | Architect | Behavioral Specs |
| 4 | **Implementation Plans** | Architect | Implementation Plans |
| 5 | **Implementation**| Implementer (GPT) | Code (Repo) & Walkthroughs (Workflow) |
| 6 | **Reviews** | Auditor (Claude) | Reports |

**Rule:** Concepts explain intent. Architecture commits to reality.
