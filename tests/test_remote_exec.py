#!/usr/bin/env python3
"""What the relay hands a remote host, and what it accepts as a read depth.

ssh takes no argv. Everything after the target is concatenated and handed to the remote login
shell, so an argument built out of client-supplied text — the body of a send_text, a pane label,
a line count — is a command on that host unless it is quoted here. That made every value a
client can put on the wire remote command execution on any host in HERDR_REMOTES, which is why
the quoting lives in the one function all of them go through rather than at each call site.

The line count is bounded on top of that. The quoting makes it harmless, not sensible: the read
is synchronous, repeats every few seconds per open pane, and crosses SSH.
"""
import shlex
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay


class RemoteCommandTests(unittest.TestCase):
    def cmd(self, *args, remote="box"):
        with patch.object(subprocess, "run") as run:
            herdr_relay.run_herdr_result(*args, remote=remote)
        return run.call_args.args[0]

    def test_a_local_call_is_an_argv_with_no_shell(self):
        with patch.object(subprocess, "run") as run:
            herdr_relay.run_herdr_result("pane", "send-text", "w1:p1", "; rm -rf ~", remote=None)
        self.assertEqual(run.call_args.args[0][-1], "; rm -rf ~")
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_the_remote_command_is_one_string_of_quoted_words(self):
        cmd = self.cmd("pane", "read", "w1:p1", "--lines", "200")
        self.assertEqual(cmd[:2], ["ssh", "-o"])
        self.assertEqual(cmd[-2], "box")
        self.assertEqual(cmd[-1], f"{herdr_relay.HERDR} pane read w1:p1 --lines 200")

    def test_shell_metacharacters_in_client_text_stay_data(self):
        for payload in ("; touch /tmp/pwned",
                        "$(touch /tmp/pwned)",
                        "`touch /tmp/pwned`",
                        "x && touch /tmp/pwned",
                        "x | sh",
                        "x\ntouch /tmp/pwned"):
            with self.subTest(payload=payload):
                remote = self.cmd("pane", "send-text", "w1:p1", payload)[-1]
                # Split the way the remote shell splits it: the payload has to come back as one
                # word, still equal to itself, with nothing following it to be run as a command.
                self.assertEqual(shlex.split(remote),
                                 [herdr_relay.HERDR, "pane", "send-text", "w1:p1", payload])

    def test_a_label_with_spaces_survives_the_trip(self):
        # The same bug, without the malice: "Architect 1" used to arrive as two arguments and the
        # rename failed on every remote pane.
        self.assertEqual(self.cmd("pane", "rename", "w1:p1", "Architect 1")[-1],
                         f"{herdr_relay.HERDR} pane rename w1:p1 'Architect 1'")


class ReadDepthTests(unittest.TestCase):
    def test_a_number_passes_through(self):
        self.assertEqual(herdr_relay.read_pane_lines(200), 200)
        self.assertEqual(herdr_relay.read_pane_lines("200"), 200)

    def test_it_is_bounded_at_both_ends(self):
        self.assertEqual(herdr_relay.read_pane_lines(10 ** 9), herdr_relay.READ_LINES_MAX)
        self.assertEqual(herdr_relay.read_pane_lines(0), 1)
        self.assertEqual(herdr_relay.read_pane_lines(-5), 1)

    def test_a_sentinel_request_tracks_the_configured_ceiling(self):
        old = herdr_relay.READ_LINES_MAX
        try:
            herdr_relay.READ_LINES_MAX = 200_000
            self.assertEqual(herdr_relay.read_pane_lines(10 ** 9), 200_000)
        finally:
            herdr_relay.READ_LINES_MAX = old

    def test_anything_else_falls_back_rather_than_refusing(self):
        for raw in (None, "", "lots", "12; rm -rf ~", {"lines": 5}, 1.5e400):
            with self.subTest(raw=raw):
                self.assertEqual(herdr_relay.read_pane_lines(raw), herdr_relay.READ_LINES_DEFAULT)

    def test_the_result_is_always_an_int(self):
        # str() of it becomes an argv element; a float would reach herdr as "1.5".
        self.assertIsInstance(herdr_relay.read_pane_lines("42"), int)
        self.assertIsInstance(herdr_relay.read_pane_lines(42.7), int)


if __name__ == "__main__":
    unittest.main()
