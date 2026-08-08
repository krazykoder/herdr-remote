# Phase 5: Implementation (Code Writing)

[**🏠 Home**](../README.md) | [**📚 Full Reference**](../Full_Reference.md)

**Phases:** [1. Concepts](./01_Concepts.md) | [2. Architecture](./02_Architecture.md) | [3. Specs](./03_Specs.md) | [4. Plans](./04_Implementation_Plans.md) | [5. Impl](./05_Implementation.md) | [6. Reviews](./06_Reviews.md)

---

**Purpose:** Build the system strictly according to implementation plans and **document the execution**.

**Key Rule:**
Implementers generally CANNOT make architectural decisions. If a plan is flawed, stop and escalate.
**CRITICAL:** Do NOT use the browser automatically to verify features. Always ask the user first.


## Ownership
- **Owner:** Implementer (GPT / Codex / Cursor)
- **Primary Output:** Source code (in `src/` or `lib/`)
- **Workflow Output:** Walkthroughs (in `.workflow/05_implementation/`)

## Directory Contents (`.workflow/05_implementation/`)
This directory does **NOT** contain source code. It contains **Walkthroughs** and **Reports**:
- `YYYY-MM-DD_<phase>_<name>_walkthrough.md`: Log of changes, verification steps, proof of correctness.
- `YYYY-MM-DD_<phase>_<name>_report.md`: Implementation summary, gaps, recommendations.

## Process
1. Read the **Implementation Plan** (`04_...`).
2. Write the **Code** (in the codebase).
3. Write a **Walkthrough** artifact:
   - Document what was done.
   - Document verification results.
4. Submit for **Review** (Phase 6).
