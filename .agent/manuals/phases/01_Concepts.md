# Phase 1: Concepts (Exploration)

[**🏠 Home**](../README.md) | [**📚 Full Reference**](../Full_Reference.md)

**Phases:** [1. Concepts](./01_Concepts.md) | [2. Architecture](./02_Architecture.md) | [3. Specs](./03_Specs.md) | [4. Plans](./04_Implementation_Plans.md) | [5. Impl](./05_Implementation.md) | [6. Reviews](./06_Reviews.md)

---

**Purpose:** Capture how the problem is understood *before* committing to structure.

For full details, see: [01_Concepts_Details.md](./01_Concepts_Details.md)

## Key Rules
- **Non-binding:** Concepts can be incomplete or contradictory.
- **No Execution:** Concepts do not imply execution order or pipelines.
- **Goal:** Externalize thinking to inform Phase 2.

## Directory Structure
```text
01_concepts/
├── mental_flow/              <– the core narrative of the system
│   ├── README.md               <– big-picture conceptual story
│   └── mental_<module_name>/   <-- focused conceptual lenses
│       ├── <document>.md
│       └── <refinement_docs>.md
├── ideas/                    <– refined ideas (NOT competing alternatives)
├── risks/                    <– known unknowns & complexity cliffs
└── constraints/              <– technical or product constraints
```

## Ownership
- **Owner:** Strategist (Gemini Pro Thinking)
- **Output:** Concept artifacts (inputs for Architecture).
