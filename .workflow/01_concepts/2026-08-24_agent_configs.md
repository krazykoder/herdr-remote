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

Two layers, because the fields in a config are not all equally dangerous.

### The threat is the base URL, not the key

A config that can set `ANTHROPIC_BASE_URL` **and** bind `ANTHROPIC_API_KEY` to one of the relay's
secrets is a config that can send your key to any host it likes. That, and not "the key might be
displayed", is what makes a browser-writable registry a bad idea. Everything below follows from it.

`model` is on the other side of that line. It is a string that goes into an environment variable
and is read by the CLI, and the worst a wrong one does is fail to start.

### Layer 1 — providers, file-owned

`~/.config/herdr-remote/agent-configs.json`, path overridable with `HERDR_AGENT_CONFIGS`. Outside
the repo, hand-edited, never written by the relay and never by a client — the same standing
`ops.json` has.

```json
{
  "version": 1,
  "providers": [
    {
      "id": "agentrouter",
      "label": "AgentRouter",
      "kind": "claude",
      "env": {
        "CLAUDE_CONFIG_DIR": "~/.claude-agentrouter",
        "ANTHROPIC_BASE_URL": "https://agentrouter.org/"
      },
      "secrets": {"ANTHROPIC_API_KEY": "AGENTROUTER_API_KEY"},
      "unset": ["ANTHROPIC_API_TOKEN"],
      "model_var": "ANTHROPIC_MODEL",
      "model_option_var": "ANTHROPIC_CUSTOM_MODEL_OPTION"
    }
  ]
}
```

- `env` — literal values. A base URL and a config dir are not secrets, but they are the trust
  anchor, so they live here and nowhere else.
- `secrets` — maps the variable the agent needs to **the name of a variable in the relay's own
  environment**, which is where `~/.config/herdr-remote/secrets.env` already keeps keys for the ops
  bot. The value is never in this file, never on the wire, never in a log.
- `unset` — the conflict removal every one of the shell functions does by hand.
- `model_var` / `model_option_var` — which variables an alias's free-text model is written into.
  Per provider because it is a fact about the CLI, not about the user's choice.

A provider naming a secret the relay does not hold is kept and reported unusable rather than
dropped — the choice `launcherGate` makes for a tile pointing at a missing Project. A dropped
provider is a mystery; one that says `AGENTROUTER_API_KEY is not set` is a fixable problem.

### Layer 2 — aliases, user-owned

An alias is a **provider plus a model string plus a name**. That is all it may be.

```json
{"id": "oclaude", "label": "oclaude", "provider": "agentrouter",
 "model": "claude-opus-5", "model_option": "claude-opus-4-6[1m]"}
```

Nothing in an alias can name a host, a key, or a variable. Adding one cannot make the relay talk to
anywhere the provider file did not already authorise, which is what makes this layer safe to edit
from a phone. `model` is free text — the model names move faster than any list this app could keep,
and a wrong one fails at the CLI, visibly, in the pane.

Aliases live in `user_state` beside the other shared documents, so a name added on the phone is
there on the desktop. Editing them from the app is fine; see the answer below.

### Built-in kinds are neither, and cannot be touched

`claude` with no config is `claude`. The kinds in `HERDR_START_AGENTS` stay exactly what they are:
no alias may claim one of their names, no provider may declare itself the default for one, and a
spawn that names no config gets the stock environment. There is no "edit the default" anywhere in
this design — the way to have a different `claude` is to add a *second* entry beside it.

This is what makes the feature additive: the worst a broken alias can do is be a broken alias.

### The wire carries names, never values

- `start_options` gains `configs: [{id, label, kind, model}]` — four fields, all public. Its
  presence is the client's gate for the whole feature, the way `start_options` gates Start.
- `start_agent` gains an optional `config`. Validated against the alias list **and** against the
  message's `name`: an alias whose provider is `claude` attached to a `codex` spawn is a refusal,
  not a silent drop. An unknown id is a refusal for the same reason.

No environment ever crosses the socket in either direction. A client names a thing and the relay
decides what the name means, which is the rule `HERDR_START_AGENTS`, `ops.json` and `open_terminal`
already follow.

### Applying it

One line, built server-side, sent with `pane send-text` and an Enter once the prompt appears —
between `_create_target_pane` and `agent_start_args`:

```
 unset ANTHROPIC_API_TOKEN; export CLAUDE_CONFIG_DIR='...' ANTHROPIC_BASE_URL='...' ANTHROPIC_API_KEY='...' ANTHROPIC_MODEL='claude-opus-5'; clear
```

Every value goes through `shlex.quote`, and the model additionally through a charset guard, because
it is the one field a client's edit reaches. Nothing else in the line originates from a client.

**Leading space, deliberately.** Under `HIST_IGNORE_SPACE` the line stays out of the shell's
history. The scrollback holds it until the agent's TUI paints over it — the same exposure `oclaude`
has today, whose body is in the user's history file — so the `clear` at the end is worth having.

### The UI: a new section on the Launcher tab

Same shape as the sections beside it: a `section-header`, one row per alias. A row shows the label,
the kind's badge, the provider's label, the model, and the one fact worth knowing about the key —
`AGENTROUTER_API_KEY · set` or `· missing`, never the key.

Providers are shown above the aliases, greyed and unpressable, so the file's contents are visible
without being editable. That is deliberate: the reason a row cannot be edited should be legible
from the same screen as the row.

Picking one happens where the kind is picked — the harness strip in the Start sheet, the new-agent
sheet, and a launcher tile member — as a second strip under it whose first badge is the stock kind.
An alias belongs to a kind, so it cannot be offered before one is chosen.

### What remembers the pick

- A launcher tile member gains `config: 'oclaude'` beside its `at`.
- A conversation's `spawn` records it, so Start again comes back on the same provider — the problem
  `starter` had, and the same answer.

Both store the id and resolve at use, degrading to the stock kind when the relay no longer offers
it. `canonAt` is the precedent: names on disk outlive the lists they point into.

## Should the app be able to edit the registry?

Asked directly, and the answer is **no for providers, yes for aliases** — which is the whole reason
the two are separate documents rather than one file with a permissions flag.

- **Providers: no, and not later either.** The file names endpoints and binds credentials to them.
  A browser that can write it can exfiltrate every key on the machine to a host of its choosing,
  and the relay is reachable through a public tunnel. There is no UI worth that. Changing a
  provider is an SSH-and-an-editor job, or an ops-bot job if it ever needs to be remote — the ops
  bot is already the thing that changes what the machine will run, and it is authenticated
  separately from the app.
- **Aliases: yes.** They are a name, a provider already authorised by the file, and a model string.
  Nothing in them can widen what the relay will do. This is where the user's actual ask lives —
  "add an `oclaude` to the picker" — and it costs nothing to allow.
- **Built-ins: no, and there is nothing to edit.** A stock kind has no config; it is the absence of
  one. Aliases sit beside it, never over it.

The test for which layer a new field belongs in: *if a client could set this, could it change where
a credential goes?* Yes, provider. No, alias.

## Scope

**v1**
- `relay/agent_configs.py` — provider loader, alias validator, and the export-line builder, in the
  shape of `relay/ops_config.py`. The builder is the security boundary and is where the tests go.
- `configs` in `start_options`; `config` on `start_agent`; the export step in `start_agent_exec`.
- Aliases as a fifth `user_state` document.
- The Launcher section, the picker strip, the tile and record fields.

**Not v1**
- Editing providers from anywhere but the file.
- Switching provider on a running session.
- Provider reachability checks, key rotation, or spend tracking.
- Aliases for kinds other than `claude`. The model holds for any env-configured CLI, but only the
  claude family has evidence behind it today.

## Open questions

1. Should an alias be able to carry argv as well as env? Every function in `~/.bash_functions` is
   env-only, so v1 says no — and argv is a field a client should probably never set anyway.
2. A launcher tile naming an alias this relay does not have: broken tile, or a template that
   travels between machines? `Missing Project` says keep it, disabled, with the reason on it.
