# Decision Log: Incremental Conversation Sync & Shared Pane Caching

## Decision
Transition the live conversation log fetching from a full 200-row poll model to a per-pane in-memory cache with incremental `since_id` delta syncing.

## Rationale
- **Network & Database Efficiency**: Polling 200 rows every 5 seconds or on every toggle was redundant when only a few turns change over time. Passing `since_id` (auto-incrementing SQLite ID) allows SQLite to do an indexed `id > ?` scan returning only new turns.
- **Cross-Conversation Pane Sharing**: Because multiple conversations can group overlapping sets of panes, caching at the pane fingerprint level (`[host, agent, cwd]`) means a pane shared by Conversations A and B is fetched once and reused immediately without network latency or UI flicker.
- **Preserved FE Reconstruction**: The frontend continues to own conversation assembly and interleaving, ensuring single-pane and joint multi-pane views render consistently across local transcript and live relay modes.
