# Spec: Incremental Conversation Sync & Per-Pane Cache Optimization

## 1. Objective
Optimize backend database queries and frontend synchronization for live conversation records (`conv_log` / `conv_live`):
1. **Incremental Delta Fetching**: Query turns incrementally using `since_id` (turn ID sequence) so warm panes only receive newly appended rows rather than refetching up to 200 rows repeatedly.
2. **Per-Fingerprint / Per-Pane Cache**: Cache turns keyed by pane fingerprint (`[host, agent, cwd]`) in memory.
3. **Multi-Conversation Deduplicated Reuse**: Panes shared across multiple conversations are fetched only once and reused across tab/conversation switches.
4. **Client-Side Reconstruction**: Conversation threads (single-pane or joint multi-pane) continue to be dynamically reconstructed in the browser by aggregating and sorting the per-fingerprint cached streams.

---

## 2. Wire Protocol Additions

### `conv_log` Request (Client → Relay)
```json
{
  "type": "conv_log",
  "fingerprints": [["local", "claude", "/work/charts/relay"]],
  "since_id": 42,
  "last": 200
}
```
- `since_id` *(optional int)*: When present, filters `turns.id > since_id`.
- `fingerprints` *(optional array of [host, agent, cwd])*: Filters turns belonging to the specified pane fingerprints.

### `conv_log` Response (Relay → Client)
```json
{
  "type": "conv_log",
  "truncated": false,
  "turns": [ ... ],
  "fingerprints": [["local", "claude", "/work/charts/relay"]]
}
```
- `fingerprints` *(optional array)*: Echoes back the queried fingerprints so the client can update per-fingerprint sync timestamps even if 0 turns are returned.

---

## 3. Frontend Architecture (`conv_live.js`)

1. **`convLiveCache` Map**:
   - Keys: Normalized fingerprint strings `JSON.stringify([host, agent, cwd])`.
   - Values: `{ turns: Turn[], maxSeq: number, maxAt: number, lastFetch: number }`.
2. **Delta Query Logic (`convLiveFetch`)**:
   - If all member fingerprints in the active conversation are warm in `convLiveCache` (`maxSeq > 0`), sends `since_id = Math.min(...maxSeqs)`.
   - Skips network requests if all members were fetched within `CONV_LIVE_EVERY` (5s) unless `force` is true.
3. **Cache Reconciliation (`convLiveReceive`)**:
   - Appends incoming turns into respective fingerprint buckets, deduplicating by `seq`/`id`.
   - Maintains sorted order by `(at, seq)`.
4. **Conversation Assembly (`convLiveEntries`)**:
   - Retrieves turns from `convLiveCache` for the active conversation's member keys.
   - Assigns `member` index and resolves local/bare member keys.
   - Sorts and formats into renderable message entry objects.
