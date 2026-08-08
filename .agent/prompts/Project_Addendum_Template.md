# Project Addendum — {{PROJECT_NAME}}

> Append this to any System Prompt to inject project-specific context.
> Fill in the sections below per-project. Delete sections that don't apply.

---

## Workspace

| Item | Value |
|------|-------|
| **Root** | `/Users/towshif/code/python/{{PROJECT_NAME}}` |
| **Python** | `source .venv313/bin/activate` |
| **Package Mgr** | `pip` / `uv` |
| **Frontend** | _(e.g., `frontend/` — Vite + TypeScript, or N/A)_ |
| **Styling** | _(e.g., Vanilla CSS, Tailwind, or N/A)_ |

---

## Stack Constraints (Hard Rules)

### Backend
```
IS:  Python 3.13, {{frameworks/libs used}}
NOT: {{explicitly forbidden patterns}}
```

### Frontend (if applicable)
```
IS:  {{stack description}}
NOT: {{explicitly forbidden frameworks/patterns}}
```

### File Limits
| Language | Max Lines |
|----------|-----------|
| Python | 600 |
| TypeScript | 350 |

### Type Safety
- _(e.g., Strict TypeScript, no `any`. mypy strict mode for Python.)_

---

## Dev Commands

```bash
# Activate environment
source .venv313/bin/activate

# Run tests
pytest                              # backend
cd frontend && npm run test:e2e     # frontend (if applicable)

# Type check
cd frontend && npx tsc --noEmit     # frontend (if applicable)

# Dev server
cd frontend && npm run dev          # frontend (if applicable)
```

---

## Key Patterns (project-specific)

> Document any patterns the Implementer must follow (component base class, state management, API client usage, etc.)

```
Example:
- All components extend `Component` from `lib/component.ts`
- State via `Store<T>` from `stores/base.ts`
- API calls via `apiClient` — no raw `fetch()`
```

---

## Test Templates (if applicable)

| Priority | Test File | Best For |
|----------|-----------|----------|
| 1 | `tests/e2e/{{test_file}}` | {{description}} |
| 2 | `tests/e2e/{{test_file}}` | {{description}} |

---

## Directory Reference

```
{{PROJECT_NAME}}/
├── src/              # or project-specific layout
│   ├── ...
├── tests/
│   ├── ...
├── .workflow/
│   ├── 01_concepts/
│   ├── 02_architecture/
│   ├── 03_specs/
│   ├── 04_implementation_plans/
│   ├── 05_implementation/
│   └── 06_reviews/
```

---

## Forbidden Actions (project-specific)

- _(e.g., No `document.querySelector()` for cross-component data)_
- _(e.g., No inline type definitions for API contracts)_
- _(e.g., No files exceeding line limits)_
