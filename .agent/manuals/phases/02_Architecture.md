# Phase 2: Architecture (Commitment)

[**🏠 Home**](../README.md) | [**📚 Full Reference**](../Full_Reference.md)

**Phases:** [1. Concepts](./01_Concepts.md) | [2. Architecture](./02_Architecture.md) | [3. Specs](./03_Specs.md) | [4. Plans](./04_Implementation_Plans.md) | [5. Impl](./05_Implementation.md) | [6. Reviews](./06_Reviews.md)

---

**Purpose:** Translate concepts into a coherent, executable system design.

For full details, see: [02_Architecture_Details.md](./02_Architecture_Details.md)

## Key Rules
- **Binding:** Decisions made here are frozen.
- **Authority:** Architecture consumes Phase 1 but decides what is real.
- **Invariants:** Defines what must ALWAYS be true.

## Key Outputs (`/.workflow/02_architecture/`)
```text
/.workflow/02_architecture/
├── ARCHITECTURE_CONTRACT.md  <– Invariants and forbidden actions
├── module_map.md             <– Boundaries and responsibilities
└── decision_log/             <– Explicit tradeoffs
```

## Ownership
- **Owner:** Architect (Claude Opus 4.5)
- **Role:** The only role allowed to define structure.
