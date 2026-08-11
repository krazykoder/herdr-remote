# The pane read path — a shell injection, an adjustable history, and what the poll actually costs

2026-08-11

Four commits on `feat/ui-polish`, plus two transport designs that were assessed and rejected. They
are one report because they are one code path: a client asks for pane text, the relay shells out to
`herdr`, and it does so again every three seconds for as long as the pane is open. Making the
history adjustable is what forced everything else — a setting that multiplies a standing cost is
not a setting until the cost is understood.

| Commit | What |
|--------|------|
| `670785e` | `feat(web)`: duplicate a session, and start one to pair with |
| `58e9e2a` | `fix(relay)`: quote the remote argv, and bound the read depth |
| `cac25f2` | `perf(relay)`: keep the herdr calls off the event loop |
| `ad1f460` | `perf(web)`: back off the pane poll when the agent is idle |

Nothing is pushed. `feat/split-view` remains separate and unmerged.

---

## Part 1 — Duplicate a session, and start one to pair with (`670785e`)

Two convenience routes into `start_agent`, both of which skip the start dialog.

**Duplicate.** A menu item in the pane menu, labelled with the harness it will spawn
(`Duplicate this claude`). It reads the open pane's `agent`, `project_id` and `workspace_id` and
sends a `start_agent` that inherits all three, landing in the same tab when the pane has one and a
new workspace when it does not.

**Start and pair.** A button at the bottom of the pair dialog's candidate list. It closes the pair
dialog, opens the start dialog pre-filled with the source pane's project, and remembers that when
the new pane arrives it should come back to the pair dialog with that pane already chosen.

### The conflict that was flagged

The parenthetical in the request — *let me know if any conflict on this* — has one real answer:
**panes carry no role**. herdr reports a label, and the relay derives `Architect 1` from the role
at start time via `next_role_label`. By the time a pane is on screen, its role exists only as the
first word of a label a user is free to rename.

So `roleOf(a)` infers it, and refuses rather than guesses:

```js
function roleOf(a) {
  const roles = (startOptions && startOptions.roles) || [];
  const first = String(a.label || '').split(' ')[0].toLowerCase();
  return roles.includes(first) ? first : roles[0];
}
```

A renamed pane falls back to the first configured role. Duplicate is hidden entirely
(`canDuplicate`) when the pane has no `agent`, no `project_id`, an agent outside
`startOptions.agents`, or when Projects is off — which is why the Playwright suite, which runs with
no `HERDR_PROJECTS_FILE`, never sees either feature.

### The asynchrony

`start_agent` replies `command_result` with a `pane_id`; the pane itself only exists in a later
`agents` snapshot. The existing deferral was `pendingStart` + `openPendingStart()`. One variable
was added beside it:

```js
// What the next successful start was asked for, when it was asked for from inside a pane:
// 'open' to land in it regardless, {pair: paneId} to come back to the pair dialog with it
// chosen. null — every other route in — keeps the old deferring behaviour.
let startIntent = null;
```

The intent is spent once, and `openStartDialog` clears it at the top so an abandoned pair flow
cannot capture an unrelated start made minutes later.

---

## Part 2 — The remote argv was a shell (`58e9e2a`)

**This was a remote command execution hole, and it is the reason the rest of the work happened.**

`run_herdr_result` built its remote call as:

```python
cmd = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", remote, HERDR, *args]
```

That reads as an argv, and is not one. **ssh has no argv to hand the far side.** It concatenates
everything after the target into a single string and the remote *login shell* parses the result. So
every client-supplied value that reached one of those arguments was a command on every host in
`HERDR_REMOTES`:

| Message | The argument |
|---------|--------------|
| `send_text` | the body of the text |
| `rename_pane` | the label |
| `read_pane` | the line count |

`pane_guard` validated pane IDs. Nothing validated the rest. A `send_text` of `; curl … | sh` was
execution on the remote host with the relay operator's SSH credentials.

Fixed at the choke point every caller already routes through, not at each call site:

```python
remote_cmd = " ".join(shlex.quote(a) for a in (HERDR, *args))
```

The local branch needs none of it — no shell is involved in an argv exec — and there is no argument
on this path that wants shell interpretation, so quoting unconditionally is correct rather than
merely safe. Patching only `lines`, which is where the depth setting drew attention, would have
left `send_text` and `rename_pane` open.

**Side effect: a real bug fixed.** A pane label containing a space arrived at a remote host as two
arguments, so renaming a remote pane had never worked.

### Testing it required fixing the fixture

`tests/e2e/bin/ssh` exec'd its arguments directly, which quietly made the quoting untestable — the
fixture was not modelling the thing that was broken. It now does what ssh does:

```python
os.execv("/bin/sh", ["/bin/sh", "-c", " ".join(cmd)])
```

`tests/test_remote_exec.py` (9 tests) asserts the local branch involves no shell, the remote command
is one quoted string, and six shell-metacharacter payloads round-trip through `shlex.split(remote)`
back to the exact argv they started as.

---

## Part 3 — The history ceiling, and the depth bound under it (`58e9e2a`)

The original question: can the number of lines fetched be a setting, and does that need a relay
change? Yes to both.

**Frontend.** `HISTORY_KEY` in localStorage, four offered ceilings (2,000 / 5,000 / 20,000 /
50,000), default 5,000 — which is what the hard-coded ceiling had always been. The stored value is
validated against the offered list rather than trusted, because it reaches the relay as a read
depth and a number the UI cannot produce is a number the UI cannot undo. `historyStep()` is a tenth
of the ceiling, so a deep ceiling is not fifty taps away.

Two behaviours worth stating explicitly:

- A pane still **opens on 200 lines** whatever the ceiling says. The ceiling moves only how far
  `Load more` will go. Open depth is paid on every pane switch; the ceiling is paid only when asked
  for.
- **Lowering the ceiling takes effect on the open pane**, not at the next pane switch — otherwise a
  50,000-line read keeps being re-polled after the user has explicitly asked for less.

**Relay.** The depth is bounded server-side regardless of what the client stored:

```python
READ_LINES_MAX = 50000
READ_LINES_DEFAULT = 30

def read_pane_lines(raw):
    try:
        return max(1, min(int(raw), READ_LINES_MAX))
    except (TypeError, ValueError, OverflowError):
        return READ_LINES_DEFAULT
```

Quoting made an unbounded depth *harmless*; it did not make it *sensible*. The read is synchronous,
repeats every few seconds per open pane, and crosses SSH. Unparseable input falls back rather than
refusing — a read is not worth an error round trip, and 30 lines still shows the reader something.
(`OverflowError` is in the clause because `1.5e400` raises it, not `ValueError`.)

### Three cost fixes the depth made necessary

**`pane_cols` samples at most 200 lines.** It is a *second* `pane read` on every request. Sampling
50,000 lines of scrollback to measure the wrap column is not only expensive, it is wrong: the wrap
column is a property of the pane *now*, and old scrollback carries the width the pane used to be.
The cheaper sample is the more accurate one.

**SSH multiplexes.** `ControlMaster=auto`, a `ControlPath` under `tempfile.gettempdir()`,
`ControlPersist=60s`. Every open pane cost two calls every three seconds on top of the poll loop,
and each was paying a full TCP connect, key exchange and auth round trip. The control path lives in
the temp dir and not `LOG_DIR` because the socket name is bounded at roughly 104 bytes on macOS and
a deep log path silently disables multiplexing instead of failing.

**A deep read is not re-polled.** `POLL_MAX_LINES = 1000`: above that depth the interval stops and
only reads the user asks for are sent. Scrollback does not change — a deep read is a picture of the
past, and re-fetching tens of thousands of lines every three seconds to redraw identical text is a
standing cost on the relay, the SSH hop, and a phone's radio. Scrolling back to the tail resumes at
200 lines. This was chosen over caching or splicing because it holds no state and therefore cannot
desynchronise.

---

## Part 4 — The relay was blocking on every herdr call (`cac25f2`)

Found while measuring Part 3, and it **predates all of this work**. Every `herdr` call in the
message handler and the poll loop was a blocking `subprocess.run` executed inline in a coroutine —
an SSH round trip each for a remote pane. While one ran, nothing else in the relay moved: not the
poll broadcast, not another client's approval, not the keepalive on a socket that was waiting.

The reads matter most because they repeat, so `read_pane_content` bundles the content read and the
`pane_cols` read into one `asyncio.to_thread`. Everything else on the path was wrapped for the same
reason at a smaller scale: `send-text`, `send-keys`, `rename_pane`, `tab create`, and — the longest
single blocking stretch in the relay — `get_all_panes()`, which is one `pane list` per configured
host and runs every `POLL_INTERVAL`.

No behaviour change. Ordering inside each handler is preserved by awaiting each call, and `herdr`
is the serialisation point it always was.

**This, not the cadence work, is what actually made the relay snappy.** The polling changes reduce
load; this one removes head-of-line blocking, which is what a user perceives.

---

## Part 5 — The idle poll backoff (`ad1f460`)

An idle agent's pane **cannot** have changed: nothing has been sent to it. Reading it twenty times
a minute was most of what the relay did at rest.

```js
const POLL_MS = 3000, IDLE_POLL_MS = 12000;
```

The gate lives inside `refreshPane(auto)`, so only the interval is affected — the refresh button,
`Load more`, and a read after a key was sent are never skipped. The 250ms slack matters: without it
a 12s gap measured against a 3s timer waits 15.

**Why backing off cannot hide a wake-up.** The status does not come from this read. It arrives on
the snapshot broadcast, which the relay drives on its own `POLL_INTERVAL`, so the tick after an
agent starts working is already the fast one. Anything not plainly idle keeps the fast cadence:
`blocked` is about to be answered, `unknown` means the status is not to be trusted, and a terminal
has no status at all and is where someone is typing.

### What wakes a backed-off pane — the relay is not passive

Worth stating plainly, because "the frontend polls" describes only half the system. **The relay
polls `herdr` on its own `POLL_INTERVAL = 2`, with no client involvement**, and pushes the result
out. It also accepts push events from `herdr` itself over HTTP POST and UDP into `event_queue`. So
a local process that changes a pane reaches the browser without the browser having asked:

| Path | Direction | Carries |
|------|-----------|---------|
| Poll loop → `agents` / `agent_update` | pushed | status, label, workspace, project |
| Poll loop detects `blocked` | pushed | status **and pane content**, read on the spot |
| HTTP POST / UDP `agent_event` | pushed | whatever `herdr` reports out of band |
| Client `read_pane` | pulled | pane text |

The split is: **status is pushed, text is pulled.** That is exactly what makes Part 5 safe — the
backoff slows the pulled half while the pushed half keeps arriving at full rate.

Two consequences:

- **An agent that wakes locally is noticed within one tick.** `refreshPane` re-evaluates
  `paneIsIdle()` at tick time, so the moment `agent_update` flips the status to `working` the gate
  is 3s again, not 12s — even mid-idle-gap, because the elapsed time already exceeds the shorter
  threshold. `tests/test_pane_history.js` pins this ("a pane that starts working is back at the
  fast cadence on the next tick").
- **The one uncovered case: pane text that changes while the status stays `idle`.** Someone typing
  into the herdr TUI directly, or a background process printing into an idle agent's pane. Nothing
  pushes that, so it is seen up to 12s late. Accepted: no status transition means nothing is
  waiting on the reader, and a terminal pane — where local typing is actually likely — has no
  status and therefore never backs off at all.

An available refinement, not taken: `agent_update` for the active pane could call `refreshPane()`
directly, cutting the ≤3s wake lag to ~0 for one line. Left out because 3s is already below the
threshold at which anyone notices, and the handler currently has no pane-read responsibility.

### Measured effect

Per client with one pane open, and remembering each `read_pane` is two `herdr` calls:

| | reads/min | herdr calls/min |
|---|---|---|
| Before | 20 | 40 |
| Idle pane, after | 5 | 10 |
| Deep read (>1,000 lines) | 0 | 0 |

Against a floor of 30 `pane list` calls per host per minute from the poll loop, which runs whether
or not any pane is open.

---

## Assessed and rejected

### Server-push `pane_content` — rejected

The relay would hold per-connection subscriptions and broadcast pane text only when it changes.
Sized at roughly 120–180 lines of relay and 40 of web:

| Piece | ~lines |
|---|---|
| per-connection subscription state | 15 |
| a watcher task reading each subscribed pane, hashing, broadcasting on change | 40 |
| lifecycle: disconnect, pane closed, pane gone from snapshot | 10 |
| dedupe by `(pane_id, lines, source)` so two viewers share one read | 20 |
| keepalive, so silence is distinguishable from a dead watcher | 15 |

**Rejected because it saves the transmission, not the work.** The relay must still run
`herdr pane read` every tick to discover whether anything changed — the subprocess and the SSH hop,
which are the expensive parts, are untouched. What it removes is bytes that permessage-deflate has
already squashed.

It also costs real properties. Every existing message is stateless request/response; this would be
the first that is not. And silence becomes ambiguous: today a pane that stops updating is visibly a
broken socket, whereas under push "nothing changed" and "the watcher died" look identical until the
keepalive is built. Finally it *replaces* rather than composes with Part 5 — once the server decides
when to send, the client's cadence logic is dead code.

### Progressive backoff to zero — rejected

The proposal: escalate an inactive pane 3s → 12s → 30s → off.

| | reads/min |
|---|---|
| Before Part 5 | 20 |
| After Part 5, idle | 5 |
| With the full ladder | 2, then 0 |

Part 5 already took 75%. The ladder takes 15% more of the original — about 3 reads/min per idle
viewer, which is noise beside the 30 `pane list` calls/min the poll loop makes regardless. The
snapshot broadcast is the floor, and an idle pane read is now cheaper than it. Optimising below the
floor buys nothing.

The cost is not the code, it is the wake-up matrix. Every state that must reset the ladder — status
leaves idle, a key is sent, refresh is tapped, the tail is scrolled to, the text changes anyway — is
a place it can stick *off* and show stale text with no visible cause. A poll that is merely slow
degrades gracefully; a poll that is off is a bug report.

**Hidden-tab throttling was also considered and skipped**: Chrome throttles background timers to
roughly once a minute after five minutes hidden, and iOS Safari suspends the page outright. Already
free.

### Read caching — deferred, with a named trigger

A cache keyed `(pane_id, lines, source)` with a TTL below the poll interval, about ten lines. It
helps only when several clients watch the same pane. **Revisit at 4+ concurrent clients on one pane,
or when `herdr` shows measurable CPU at rest** — not before.

---

## Tests

| File | Count | Covers |
|------|-------|--------|
| `tests/test_remote_exec.py` | 9 | local argv has no shell; remote is one quoted string; six metacharacter payloads round-trip; a label with a space survives; `read_pane_lines` bounds and fallbacks |
| `tests/test_start_dupe.js` | 11 | the duplicate wire message; `new_workspace` fallback; role inference; four refusal cases; intent routing; intent spent once; dialog clears an abandoned intent; dead pair source |
| `tests/test_pane_history.js` | 15 | ceiling validation and step scaling; lowering re-reads; deep read not re-polled; the idle cadence, with `Date.now` injected so the test moves the clock rather than waiting on it |
| `tests/e2e/browser/pane_history.spec.js` | 5 | the setting survives a reload; a working pane is followed on the 3s poll; an idle pane is not read within 7s; a deep read pauses the poll and the tail resumes it; the refresh button still reads at full depth |
| `tests/test_pane_cols.py` | +1 | the sample is capped however deep the read goes |

`tests/test_pane_history.js` slices the block that contains the **real** `refreshPane` and observes
reads on a stub `ws.send`, rather than stubbing `refreshPane` itself — the read is the thing that
would silently stop happening. The browser spec taps `ws.send` on the live page for the same
reason: the relay is real, so those are the requests themselves.

Suite state: 236 Python, 145 node, 17 Playwright, plus `e2e_start_agent.py` and `e2e_pane_slots.py`.

---

## Where this leaves the read path

Nothing further is worth doing at current scale. An idle pane costs 5 reads/min with deflate on,
deep reads are paused entirely, the depth is bounded on both sides, remote arguments are data, SSH
connections are reused, and no `herdr` call runs on the event loop.

The two open triggers, both measured rather than guessed:

- **4+ clients on one pane, or visible `herdr` CPU at rest** — add the read cache.
- **Neither** — do nothing. Server-push is documented above so it does not have to be re-derived,
  not because it is queued.
