---
name: Update Architecture Documentation
description: A guided procedure for efficiently and accurately updating the AlgoFlow architecture documentation to match the codebase state.
---

# Architecture Documentation Update Procedure

Use this skill when you need to bring the architecture documentation (`.workflow/02_architecture/`) in sync with the current codebase (e.g., after a major phase completion or refactor).

## 1. Analysis Phase (Code vs Docs)

Before editing, you must identify the drift.

1.  **List the Code Structure**:
    *   Run `list_dir` on `algoflow/` and `dev_*/` directories.
    *   Compare the output against the "Package Structure" section in `ARCHITECTURE.md`.
    *   *Goal*: Identify new modules, deleted files, or moved components.

2.  **Check Core Interfaces**:
    *   View `algoflow/core/interfaces.py` (or similar).
    *   Ensure `ARCHITECTURE_CONTRACT.md` reflects current invariants (e.g., Numba usage, Immutability).

## 2. Core Document Updates

Update the "Source of Truth" documents first.

1.  **Update `ARCHITECTURE.md`**:
    *   Update **Executive Summary**: Does the "Current Capabilities" list match the latest Phase?
    *   Update **Package Structure**: Paste the corrected tree from your Analysis.
    *   Update **Integration Model**: Ensure Mermaid diagrams reflect actual import paths and flow (e.g., `CLI -> Manager -> Engine`).

2.  **Update `module_map.md`**:
    *   Ensure every new top-level module (e.g., `simulation`, `cli`) is listed.
    *   Verify "Dependencies" columns are accurate.

## 3. Design Document Standardization

For every design document (`ARCHITECTURE_DESIGN_*.md`), ensure consistency.

1.  **Standardize Header**:
    Apply this format to the top of EVERY design doc:
    ```markdown
    # [Document Title]

    **Status**: [Active/Draft] (Phase X.X)
    **Date**: [YYYY-MM-DD]
    **Version**: [X.X]

    ---

    **Navigation**
    - [Core Architecture](./ARCHITECTURE.md)
    - [Module Map](./module_map.md)
    - [Related Design Doc A](./...)

    **Table of Contents**
    1. [Section 1](#...)
    2. [Section 2](#...)
    ```

2.  **Update Content**:
    *   Check if code examples are obsolete.
    *   Update Mermaid diagrams if logic flow has changed.

## 4. Link & Graph Verification

1.  **Fix Broken Links**:
    *   Search for outdated filenames (e.g., `grep_search(Query="OLD_FILENAME.md", SearchPath=".workflow")`).
    *   Replace with current file paths.

2.  **Verify Mermaid**:
    *   Ensure all node labels with special characters (parentheses, slashes) are quoted (e.g., `A["Label (Info)"]`).

## 5. Artifact generation
    *   Create a "Walkthrough" artifact summarizing what changed.
    *   Update `session_logs.md` with the new documentation state.
