# Decision Log: Incremental Conversation Sync & Shared Pane Caching

## Decision
Transition the live conversation log fetching from a full 200-row poll model to a per-pane in-memory cache with incremental `since_id` delta syncing.

## Rationale
- **Network & Database Efficiency**: Polling 200 rows every 5 seconds or on every toggle was redundant when only a few turns change over time. Passing `since_id` (auto-incrementing SQLite ID) allows SQLite to do an indexed `id > ?` scan returning only new turns.
- **Cross-Conversation Pane Sharing**: Because multiple conversations can group overlapping sets of panes, caching at the pane fingerprint level (`[host, agent, cwd]`) means a pane shared by Conversations A and B is fetched once and reused immediately without network latency or UI flicker.
- **Preserved FE Reconstruction**: The frontend continues to own conversation assembly and interleaving, ensuring single-pane and joint multi-pane views render consistently across local transcript and live relay modes.

## The watermark is "answered through", not "newest turn"
The cache is keyed per pane and the query is per roster, and those two do not line up. A bucket's
resume point is therefore the highest id the *answer* carried, over every member of it — not the id
of that pane's own newest turn. The distinction is invisible in the happy path and decides the
whole feature outside it: a pane that has said nothing has no newest turn, so the newest-turn
reading leaves it permanently cold and re-asks for the full 200-row window every five seconds,
which is the case this change exists to remove. Because buckets are shared across rosters and last
answered by different queries, the id sent is the **floor** over the roster; the ceiling would skip
rows a lagging member has below it. Re-reading a few rows the floor already has is free — they
dedupe by `seq` — and skipping rows is not recoverable.
