# Implementation Plan — Backend-authoritative shared state

**Spec:** `.workflow/03_specs/2026-08-20_shared_state_backend_authority_spec.md`.

| Marker | Path | Change |
|---|---|---|
| `[MODIFY]` | `web/src/conversation_store.js` | Mark newly created conversation ids in a local pending outbox. |
| `[MODIFY]` | `web/src/state_sync.js` | Adopt backend state; rebase only pending conversation creations. |
| `[MODIFY]` | `tests/test_state_sync.js` | Verify backend wins existing ids and pending rows retry. |
| `[MODIFY]` | `tests/e2e/browser/state_sync.spec.js` | Mark the offline-created test row pending. |

No relay, database, IndexedDB, or message-shape change is required.
