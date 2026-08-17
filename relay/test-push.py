#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pywebpush>=2.0.0", "py-vapid>=1.9.0"]
# ///
"""Send one notification to every subscribed device, and say what happened.

    uv run relay/test-push.py
    uv run relay/test-push.py "Custom title" "Custom body"

Testing this through a real agent means waiting for one to block or finish, and when nothing
arrives there is no way to tell which link failed — the phone never subscribed, the keys are
wrong, or Apple rejected it. This exercises the same path the relay uses and prints the push
service's own answer per device.

Reads the keys from the environment, falling back to the project's .herdr-remote/secrets.env so it
behaves the same in a plain shell as under the launchd service. Nothing secret is printed.
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get("HERDR_STATE_DIR") or ROOT / ".herdr-remote")
SECRETS = STATE / "secrets.env"
SUBS = STATE / "push_subs.json"


def load_env():
    """Environment wins; the secrets file fills the gaps."""
    if SECRETS.is_file():
        for line in SECRETS.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def main():
    load_env()
    public = os.environ.get("HERDR_VAPID_PUBLIC", "")
    private = os.environ.get("HERDR_VAPID_PRIVATE", "")
    subject = os.environ.get("HERDR_VAPID_SUBJECT", "mailto:herdr@localhost")
    if not public or not private:
        sys.exit(f"No VAPID keys in the environment or {SECRETS}.\n"
                 f"Generate them: uv run relay/make-vapid.py >> {SECRETS}")

    if not SUBS.is_file():
        sys.exit(f"No {SUBS.name} — no device has ever subscribed.\n"
                 "On the phone: open the app from the Home Screen, Settings ▸ Enable Push.\n"
                 "It must be connected to this relay at the time, and the status must read Enabled.")
    subs = json.loads(SUBS.read_text())
    if not subs:
        sys.exit(f"{SUBS} is empty — no device is subscribed.")

    title = sys.argv[1] if len(sys.argv) > 1 else "🐑 herdr test"
    body = sys.argv[2] if len(sys.argv) > 2 else "If you can read this on the Lock Screen, push works."

    from pywebpush import webpush

    print(f"{len(subs)} subscribed device(s)")
    failures = 0
    for i, sub in enumerate(subs, 1):
        host = sub.get("endpoint", "").split("/")[2] if sub.get("endpoint") else "?"
        try:
            webpush(
                subscription_info=sub,
                data=json.dumps({"title": title, "body": body, "url": "/", "tag": "herdr-test"}),
                vapid_private_key=private,
                vapid_claims={"sub": subject},
                headers={"Topic": "herdr-test", "TTL": "60"},
            )
            print(f"  {i}. {host}: accepted")
        except Exception as e:
            failures += 1
            # The push service's status is the whole diagnosis: 401/403 means the keys do not match
            # the ones the device subscribed with, 410 means that subscription is gone.
            print(f"  {i}. {host}: REJECTED — {e}")
    if failures:
        print("\nA 401 or 403 means the relay's keys changed since the device subscribed: "
              "disable and re-enable push on the phone.\n"
              "A 410 means that subscription expired — same fix.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
