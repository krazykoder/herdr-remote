# Spec — Backend-authoritative shared state

**Decision:** `.workflow/02_architecture/decision_log/2026-08-20_shared_state_backend_authority.md`.

1. A new browser sends `state_get` before creating auto conversations or writing shared state.
2. A nonzero relay revision replaces the browser's document. The browser may append only pending
   conversation ids absent from that returned index.
3. A successful append uses the returned revision. On `state_conflict`, repeat the same rebase
   against the conflict body and revision.
4. When the relay acknowledges a conversation write, clear pending ids present in the locally sent
   index. When a relay body already contains a pending id, clear it as already durable.
5. Pairs, view state, hidden state, and any update to a backend-known conversation always adopt
   the backend body on conflict.

Acceptance: a browser stale by one day adopts current backend conversations; locally created,
unacknowledged C and D append without changing backend A and B; each pending conversation retains
its full pane membership; autos are not created before the initial response.
