# Agent configs

A named set of provider settings a session can be started under. `claude` and `oclaude` are the
same binary; picking between them from a phone is what this is for.

Branch: `feat/agent-configs`. Nothing implemented yet — this is the proposal.

## What the difference actually is

`oclaude` and its siblings in `~/.bash_functions` are shell functions, and every one of them
differs from `claude` only in **environment**:

| | `claude` | `oclaude` | `f1claude` | `a1claude` | `myclaude` |
|---|---|---|---|---|---|
| `CLAUDE_CONFIG_DIR` | — | `~/.claude-agentrouter` | same | same | same |
| `ANTHROPIC_BASE_URL` | — | `agentrouter.org` | `cc.freemodel.dev` | `capi.aerolink.lat` | — |
| `ANTHROPIC_API_KEY` | — | `$AGENTROUTER_API_KEY` | `$FREEMODEL_API_KEY` | `$AEROLINK_API_KEY2` | — |
| `ANTHROPIC_MODEL` | — | `claude-opus-4-8` | `claude-opus-4-8[1m]` | — | `claude-opus-4-8` |
| first | — | `unset ANTHROPIC_API_KEY ANTHROPIC_API_TOKEN` | same | same | same |

So an agent config is **a name, a kind, and a set of environment variables**. There is no argv in
it, no wrapper script, no second binary. That is the whole data model, and it is small enough that
the feature is mostly about *where the values live* rather than about what they are.

It also says why the launcher cannot reach these today: `herdr agent start --kind claude` runs
herdr's own launcher for that kind. A zsh function is not a kind and never will be one.

## Where it can be applied

`start_agent_exec` (`relay/herdr_relay.py:1480`) does two things in order:

1. `_create_target_pane` — a pane exists and its login shell is coming up to a prompt.
2. `agent_start_args` — `herdr agent start <label> --kind <kind> --pane <pane>`.

Between them is a shell at a prompt that the agent process will inherit from. That is the hook,
and the relay already uses exactly this window for terminals: `terminal_init_exec`
(`relay/herdr_relay.py:1557`) waits for the prompt to appear by polling `pane read`, then sends a
line. The same wait, one `export` line, then start the agent.

Rejected alternative: passing env through `herdr agent start`. herdr has no flag for it, and the
`--` passthrough that `AGENT_ARGS` uses is the *agent's* argv, not the environment.

## Design

### 1. The registry is a file on the relay's machine

`~/.config/herdr-remote/agent-configs.json`, overridable with `HERDR_AGENT_CONFIGS`. It lives
outside the repo for the same reason `ops.json` does: it names credentials and endpoints.

```json
{
  "version": 1,
  "configs": [
    {
      "id": "oclaude",
      "label": "Claude · agentrouter",
      "kind": "claude",
      "env": {
        "CLAUDE_CONFIG_DIR": "~/.claude-agentrouter",
        "ANTHROPIC_BASE_URL": "https://agentrouter.org/",
        "ANTHROPIC_MODEL": "claude-opus-4-8"
      },
      "secrets": {"ANTHROPIC_API_KEY": "AGENTROUTER_API_KEY"},
      "unset": ["ANTHROPIC_API_TOKEN"]
    }
  ]
}
```

- `env` — literal values. Safe to show; a base URL and a model name are not secrets.
- `secrets` — maps the variable the agent needs to **the name of a variable in the relay's own
  environment**, which is where `~/.config/herdr-remote/secrets.env` already puts keys for the ops
  bot. The key's *value* is never in this file, never on the wire, never in a log line.
- `unset` — the conflict removal every one of the shell functions does by hand.

A config naming a secret the relay does not hold is kept and reported as unusable, not dropped —
the same choice `launcherGate` makes for a tile pointing at a missing Project. A dropped config is
a mystery; a config that says "AGENTROUTER_API_KEY is not set" is a fixable one.

### 2. The wire carries names, never values

- `start_options` gains `configs: [{id, label, kind}]`. Three fields, all of them already public.
  Its presence is the client's gate for the whole feature, the way `start_options` gates Start and
  `arb_sessions` gates arbitration.
- `start_agent` gains an optional `config`. Validated against the registry **and** against the
  message's `name`: a config for `claude` attached to a `codex` spawn is a refusal, not a silent
  drop. An unknown id is a refusal for the same reason.

No environment ever crosses the socket in either direction. The client names a thing and the relay
decides what that name means — the rule `HERDR_START_AGENTS`, `ops.json` and `open_terminal` all
already follow.

### 3. Applying it

One line, built server-side, sent with `pane send-text` and an Enter after the prompt appears:

```
 unset ANTHROPIC_API_TOKEN; export CLAUDE_CONFIG_DIR='...' ANTHROPIC_API_KEY='...' ...
```

Every value goes through `shlex.quote`. Nothing in the line originates from a client, so there is
no injection surface from the browser — the registry and the relay's own environment are the only
two sources.

**Leading space, deliberately.** With `HIST_IGNORE_SPACE` the line stays out of the shell's
history. The scrollback still holds it until the agent's TUI paints over it, which is the same
exposure `oclaude` has today (its body is in the user's history file). Worth stating rather than
pretending otherwise; a `clear` in the same line is cheap and worth having.

### 4. The UI: a new section on the Launcher tab

Same shape as the sections beside it — a `section-header`, one row per config. Each row: label,
the kind's own badge, the base URL's host, the model, and the one fact that matters about the key —
`AGENTROUTER_API_KEY · set` or `· missing`, never the key.

**Read-only in v1.** A browser that can rewrite this registry is a browser that can point an agent
at any endpoint with any key. `ops.json` has no UI for the same reason. If editing is wanted later
it belongs behind the ops bot, which already exists to change what the machine will run.

Picking one happens where the kind is picked — the harness badge strip in the Start sheet, the
new-agent sheet, and a launcher tile member — as a second strip under it, with `default` as the
first badge. A config belongs to a kind, so it cannot be offered before one is chosen.

### 5. What remembers the pick

- A launcher tile member gains `config: 'oclaude'` beside its `at`.
- A conversation's `spawn` records it, so Start again comes back on the same provider — the same
  problem `starter` solved, and the same answer.

Both store the id and resolve it at use, degrading to the default when the relay no longer offers
it. `canonAt` is the precedent: names on disk outlive the lists they point into.

## Scope

**v1**
- `relay/agent_configs.py` — loader, validator, and the export-line builder, mirroring
  `relay/ops_config.py`. The builder is the security boundary and is where the tests go.
- `configs` in `start_options`; `config` on `start_agent`; the export step in `start_agent_exec`.
- The Launcher section, the picker strip, the tile and record fields.

**Not v1**
- Editing configs from the browser.
- Switching provider on a running session.
- Provider reachability checks or key rotation.
- Configs for kinds other than `claude`. The model holds for any env-configured CLI, but only the
  claude family has evidence behind it today.

## Open questions

1. Does a config carry `--model` as argv for kinds that want it that way, or is env the whole
   story? Env alone covers every function in `~/.bash_functions`, so v1 says env alone.
2. Should a launcher tile be able to name a config the relay does not have — a template that
   travels between machines — or is that a broken tile? `Missing Project` says the former.
