---
name: Implementation to Concept Synthesis
description: A guided procedure for distilling technical implementation details (plans, reports, logs) into verbose conceptual "Idea" documentation.
---

# Implementation to Concept Synthesis Procedure

Use this skill when you need to create "historical idea" or "strategic brief" documentation based on completed work. This process ensures that the *why* (the strategy) is preserved alongside the *what* (the code).

## 1. Data Collection

Before writing, gather the raw evidence of implementation.

1.  **Read the Plan**:
    *   Find the relevant plan in `.workflow/04_implementation_plans/`.
    *   *Goal*: Understand the *intention* behind the phase.

2.  **Read the Report/Walkthrough**:
    *   Find the completion report in `.workflow/05_implementation/`.
    *   *Goal*: Identify the actual outcomes, "Technical Wins", and identified "Gaps".

3.  **Inspect the Evidence**:
    *   Briefly view the verification tests (e.g., `tests/e2e_...`) if mentioned in the report to confirm the logic.

## 2. Synthesis Phase (Developing the "Idea")

Conceptual documentation must be **verbose** and **philosophical**. Do not just list features.

1.  **Extract the "Strategic Breakthrough"**:
    *   Ask yourself: "What was the one major conceptual problem this phase solved?" (e.g., "Decoupling data from logic" or "Institutional-grade metrics").
    *   Frame this as the main "Idea" of the document.

2.  **Narrative Structure**:
    *   **The Idea**: Define the core philosophy.
    *   **Key Concepts**: Explain 2-3 major technical abstractions introduced (e.g., Protocols, State Machines).
    *   **The Problem/Solution**: Describe the struggle (e.g., "The Impedance Mismatch") and the resolution.

3.  **Maintain Verbosity**:
    *   Use full sentences.
    *   Explain the *rationale* behind architectural decisions.
    *   Mention "Strategic Wins" or "Technical Breakthroughs".

## 3. Formatting & Linking

1.  **Standard Header**:
    Use the Concept Navigation format:
    ```markdown
    # Phase X.X: Title

    > [!NOTE]
    > **Navigation**: [< Prev: Title](./Prev.md) | [📂 Table of Contents](./README.md) | [Next: Title >](./Next.md)
    ```

2.  **Standard Footer**:
    Always attribute the source:
    ```markdown
    ---
    *Derived from: [Implementation Report Name] and [Plan Name].*
    ```

3.  **Mermaid Diagrams**:
    If the report used a diagram to show logic flow, refine and include it in the concept doc. Quote node labels with special characters.

## 4. Practical Usage Scenario

**Scenario**: You just finished Phase 3.1 which implemented a "Cluster-Based Execution" engine.

1.  **Analyze**: Read `phase3_1_plan.md` (intention: parallelism) and `PHASE_3_1_REPORT.md` (outcome: 4x speed via Ray).
2.  **Synthesize**: Draft a doc titled `Phase_3_1_Cluster_Parallelism.md`. 
    *   Define the "Idea" as "Scaling the River to the Cloud".
    *   Explain the "Worker-Observer" pattern used.
    *   Highlight the breakthrough in memory management.
3.  **Link**: Add to the `README.md` index and link to Phase 3.0.
