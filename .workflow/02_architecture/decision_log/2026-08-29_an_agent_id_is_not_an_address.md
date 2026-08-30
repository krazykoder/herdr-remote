# An agent id names a colleague; it does not make a pane addressable

**Date:** 2026-08-29 · **Class:** A (behaviour restored, no contract change)

`aid` was introduced so a pair follows its colleague across a restart, and `memberMatches` now
prefers it over the four-field fingerprint. From there it looks reasonable to relax `pairHealth`'s
other guard — the one that calls a pair stale when two hosts report the same bare `pane_id` — on the
grounds that an `aid` names the colleague unambiguously. It does not follow, and the relaxation was
reverted.

The reason is that identity and addressing are two different things here. Everything that reaches a
pane from the pair strip is keyed on the bare `pane_id` and nothing else: `pairFor`, `memberOf`,
`partnerOf`, and on the wire the relay's own `pane_guard`, which refuses an ambiguous pane outright
(`ambiguous_pane_ids`, per-server counters, G7/D6). Knowing *which* colleague a member is does not
tell any of them *which* pane to open. A pair drawn as healthy over an ambiguous id is a switch
button and a transfer the relay will decline — a worse failure than the stale strip, because the
stale strip says so. The client mirrors the relay's refusal rather than out-running it.

The real cost — that two polled hosts make routine collisions and so routinely stale pairs — is a
gap in the client half of the identity work: the pair lookups were never moved off `pane_id`.
Closing it means giving those three functions an agent-keyed form, not loosening the guard that
stands in for it. Tracked as the next step, not fixed here.

Kept from the same change: `healPairs` now compares whole fingerprints rather than `pane_id` alone,
so an agent that moves host while keeping its pane id is re-stamped instead of left naming the
machine it left.
