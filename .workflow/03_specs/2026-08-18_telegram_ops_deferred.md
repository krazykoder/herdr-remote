# Deferred — herdr-ops, what was left out and when to build it

**Date:** 2026-08-18 · **Status:** open · **Class:** B (all items additive)
**Built:** [spec](2026-08-18_telegram_ops_spec.md) ·
[plan](../04_implementation_plans/2026-08-18_telegram_ops_plan.md) ·
[setup](../../relay/OPS_SETUP.md)

Each item below was a deliberate omission, not an oversight. Item 1 was reconsidered on
2026-08-18 and **closed as "not for now"**: setup is `relay/ops-setup.sh` plus a manual start, and
that is the supported shape rather than a gap waiting to be filled.

---

## 1. A service unit for the ops bot itself — `com.herdr-remote.ops`

**Decided 2026-08-18: not doing this for now.** The supported path is `relay/ops-setup.sh` once,
then start the bot by hand. No launchd plist, no systemd unit.

**What that costs.** Nothing restarts the bot after a crash or a reboot. The failure that matters:
the machine reboots while you are away, and the recovery channel is not there when you reach for
it — which is the one situation the bot exists for.

**Why that is acceptable today.** Supervising a process is a separate, separately-testable change,
and an installer that writes launchd units is the riskiest thing in this feature to get wrong.
Running it by hand also means every session is one you started deliberately, which is the right
default while the Telegram round trip is still being proven.

**Build it when:** you have gone to use the bot and found it not running. That is the signal — not
before. `install-service.sh` already carries `HERDR_OPS_TG_TOKEN` through its `secrets.env` rewrite,
so the token side is ready whenever the unit is written.

**Shape.** A fourth label alongside `LABEL_RELAY` / `LABEL_TUNNEL` / `LABEL_TELEGRAM`, with
`KeepAlive` true and `RunAtLoad` true, the token read from `secrets.env` like the others. One
wrinkle worth thinking about before writing it: the ops bot must **not** be a child of, or share a
process group with, anything it restarts, and launchd already gives each label its own session, so
this is a property to assert in the plist rather than engineer.

---

## 2. Auto-restart in the health watcher

**What is missing.** `health_watcher()` reports an up→down transition to the allowlisted chats and
stops there. It never restarts anything on its own.

**Why deferred.** A supervisor that acts on a probe needs a backoff, a cap, and a definition of
"down" that a flapping port cannot trigger — otherwise the first false negative turns into a
restart loop that takes down a working relay. Reporting has none of that risk, and in practice the
message plus a `/relay restart` tap is a few seconds slower than an automatic restart while being
impossible to get catastrophically wrong.

**Build it when:** the same alert arrives repeatedly and the answer is always the same tap. Not
before — the value is only in the cases where a human would have said yes anyway.

**Shape.** Opt-in per service (`"auto_restart": true` in the registry), exponential backoff, a hard
cap of N restarts per hour, and every automatic action announced in the chat with the same text a
manual one produces. Never automatic for a service whose probe has failed since the bot booted:
that is a configuration problem, not an outage.

---

## 3. The `unit` backend, exercised for real

**What is missing.** `ops_supervisor.unit_action()` and the `unit` health probe are implemented —
`launchctl kickstart -k` / `systemctl --user restart` — but nothing on this machine has a unit for
them to drive, so the code path has never run outside its own reading.

**Why deferred.** The registry's schema is the frozen contract, so the probe type had to exist in
the loader from day one; making it *work* needs a service that is actually installed under launchd.
Writing it against nothing would have produced code shaped by a guess about `launchctl print`'s
output.

**Build it when:** item 1 lands, since that creates the first unit on this machine, or when the
relay is moved back under `install-service.sh` supervision.

**Watch for:** `launchctl print` output format differs across macOS versions, and the current
implementation greps for `state = running`. That is the fragile line. `systemctl --user is-active`
is a clean exit code and is not the concern.

---

## 4. Other local servers in the registry

**What is missing.** Nothing but rows. Confirmed 2026-08-18 that no other long-running services
exist on this host worth managing.

**Why deferred.** There was nothing to name. This is the item that requires no code at all — the
registry is config, so adding a service is an entry with a `start`, a `health` probe and a `log`.

**Build it when:** a second server appears. The four probe types (`tcp`, `pgrep`, `http`, `unit`)
are already implemented, so most services need no new code.

---

## 5. SSH fan-out to a second machine

**What is missing.** The bot manages the host it runs on. It has no equivalent of the relay's
`HERDR_REMOTES`.

**Why deferred.** Same-machine is the case that exists. Remote control also changes the security
model — an allowlist that reaches another box needs its own credentials, its own registry, and a
much clearer answer to "which machine did that command run on".

**Build it when:** there is a second machine. The lazy version is probably a second ops bot on that
machine with its own token and chat, not an SSH layer in this one — one process per host keeps the
blast radius and the allowlist local to what they control.

---

## Not deferred — deliberately out of scope, permanently

- **Reading panes or approving agents.** That is `herdr_telegram.py`'s job, and the ops bot's
  independence from the relay is exactly what makes it survive a relay outage. Adding a relay
  connection here would reintroduce the coupling the whole design exists to avoid.
- **A general remote shell.** `/exec`, free-form arguments, or "run anything if the chat id
  matches". The allowlist is the feature.
- **Doing anything when the machine is offline or asleep.** Inherent to running on the box.
