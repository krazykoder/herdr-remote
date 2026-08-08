# Agent Instructions

## Project Context

Refer to [CLAUDE.md](CLAUDE.md) as needed — it holds the project overview, component map,
workflow structure (`.workflow/`), environment setup (`.venv313`), run commands, WebSocket
protocol, and deployment notes. This file covers agent conduct; CLAUDE.md covers the project.
Where both apply, CLAUDE.md is authoritative on project specifics.

## global agent instructions

- Never manually modify CHANGELOG.md files or any files that are marked as auto-generated
- When making technical decisions, do not give much weight to development cost.
  Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- When doing bug fixes, always start with reproducing the bug in an E2E setting as closely aligned with how an end user would experience it as possible.
  This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection.
  If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along the way.
- Apply that same high standard to engineering excellence: lint, test failures, and test flakiness.
  If you see one, even if it is not caused by what you are working on right now, still get it fixed.

## Guidelines

- Read the project README and any existing docs before making changes
- Run the project's build/test commands before committing (check package.json, Makefile, pyproject.toml, Cargo.toml)
- Keep changes minimal and focused on the task
- Prefer early returns over nested conditionals
- Handle error states explicitly
- Use semantic HTML and ARIA attributes for accessibility in frontend code
- Follow existing code style and conventions in the repo
- Do not introduce new dependencies without justification

## Verification

- Run linting and type checks before committing
- Run tests relevant to changed code
- Verify the build passes

## Git

- Write clear, concise commit messages
- Stage only files related to the current task
- Do not push to main/master without explicit permission
