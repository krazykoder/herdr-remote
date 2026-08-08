---
trigger: always_on
---

# Antigravity Artifact Sync Rules

When working on files inside `frontend/`, also read and follow `frontend/.agent/rules/session_rules.md`.

## 1. Source of Truth & Mirroring
- **Primary**: Use Antigravity's internal artifact system (State, Task Lists, Implementation Plans) for active work.
- **Canonical Docs**: Project state lives in `/.workflow/`; Process guides live in `.agent/manuals/`.
- **Mirror**: Sync the internal state to the `./.antigravity/` workspace folder at the start and end of every session.

## 2. Workspace Artifact Definitions
- **`./.antigravity/completed_tasks.md`**: Append-only log.
- **`./.antigravity/task.md`**: A markdown mirror of the current internal Antigravity Task List.
- **`./.antigravity/session_logs.md`**: Append only - Captures the "Current State" and "Next Steps".
- ** `./.antigravity/project_context.md`: Append only - Captures project context.

## 3. Workflow Integration

### 🟢 Session Initialization
1. **Sync In**: Read `./.antigravity/session_logs.md`, `task.md` and `/.workflow/02_architecture/module_map.md`.
2. **Rehydrate**: Populate the current Antigravity Chat Task List/Artifacts using the data found in these workspace files.

### 🔄 Active Tasking
- Dont use browser automatically to verify feature. Ask user.
- Periodically update `./.antigravity/task.md`.

### 🔴 Session Wrap-up
1. **Document plans and walkthrough**
- Always save a copy of the final implementation plan to `./.antigravity/implementation_plans/` (prefix: `YYYY-MM-DD_`).
- Always save a copy of the final walkthrough to `./.antigravity/walkthroughs/` (prefix: `YYYY-MM-DD_`).

2. **Internal-to-File Sync**:
    - **Archive**: Move completed items to `./.antigravity/completed_tasks.md`.
    - **Snapshot**: Generate a "State Snapshot" in `./.antigravity/session_logs.md`.
    - **Context**: Update `./.antigravity/project_context.md` with new features.

3. **Architecture Maintenance (Mandatory)**:
    - **Sync Map**: Ensure `/.workflow/02_architecture/module_map.md` matches the current code state.
    - **Link New Concepts**: Any new concept artifact (e.g. `MODULARITY_PROPOSAL.md`) MUST be linked in `module_map.md` under "Concepts & Standards" or documented in `.agent/manuals/phases/01_Concepts_Details.md`.
    - **Architecture Changes**: Updates to invariants go to `/.workflow/02_architecture/ARCHITECTURE_CONTRACT.md`.
    - **Walkthroughs**: Any code implementation MUST have a corresponding verification walkthrough in `/.workflow/05_implementation/`.

## 4. Documentation Standards
- **Visuals First**: Complex logic or flows (>3 steps) MUST be accompanied by a Mermaid diagram.
    - **System Overviews**: Use `graph TD` to show data flow between components.
    - **Workflows**: Use `sequenceDiagram` for strict ordering or protocols.
    - **Proposals**: Include "Before" and "After" diagrams for architectural changes.
- **Reference**: Use VS Code Preview (`Cmd+Shift+V`) to verify diagram rendering before saving.