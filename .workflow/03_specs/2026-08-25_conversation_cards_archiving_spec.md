# Spec — Conversation card badges and synced archive

`archived: true` is optional metadata on the existing backend-authoritative `conversations` index.
Absent means active, preserving old records. Archive hides only the landing card; it never changes
members, transcripts, recording, pairs, or auto-tier behavior.

Active cards show distinct agent and project badges in roster order. Member rows record `agent` and
`project`; legacy rows fall back to their existing key. Multiple projects render as adjacent badges.

Archive and Unarchive mutate the existing index through `saveConvIndex`, so normal state revision
and conflict handling syncs the result to all browsers. The header toggles archived-card visibility;
card actions stop propagation and remain keyboard-labelled.
