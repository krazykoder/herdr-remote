#!/usr/bin/env python3
"""What a push notification says, and which notification it replaces.

Both matter more than they look. A Lock Screen shows roughly two lines and no scrollback, so the
body has one chance to name the thing being asked; and the collapse key decides whether a second
pane wanting you appears at all, or silently overwrites the first.
"""
import sys
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay
from herdr_relay import STATIC_FILES, notify_body, push_tag, push_topic

WEB = ROOT / "web"

# A claude pane sitting on a permission prompt, as read_pane returns it.
BLOCKED = """\
⏺ I'll remove the stale build output.

⏺ Bash(rm -rf build/)
  ⎿  Running…

╭──────────────────────────────────────────────╮
│ Bash command                                 │
│                                              │
│ rm -rf build/                                │
│ Delete the build directory                   │
│                                              │
│ Do you want to proceed?                      │
│ ❯ 1. Yes                                     │
│   2. Yes, and don't ask again                │
│   3. No, and tell Claude what to do          │
╰──────────────────────────────────────────────╯
"""

DONE = """\
⏺ Bash(git status --short)
  ⎿  M web/index.html

⏺ Ready. Name the change.

✻ Baked for 22s

❯
"""


class NotifyBodyTests(unittest.TestCase):
    def test_it_reads_the_question_not_the_scrollback(self):
        body = notify_body(BLOCKED)
        self.assertIn("Do you want to proceed?", body)
        # The top of the pane is what content[:120] used to send.
        self.assertNotIn("I'll remove the stale build output", body)

    def test_the_choices_are_left_out(self):
        # They are the least useful thing on a Lock Screen: answering needs the app open anyway,
        # and three numbered lines would crowd out the question itself.
        body = notify_body(BLOCKED)
        self.assertNotIn("1. Yes", body)
        self.assertNotIn("tell Claude what to do", body)

    def test_box_rules_and_the_empty_composer_are_not_content(self):
        body = notify_body(DONE)
        self.assertIn("Ready. Name the change.", body)
        self.assertNotIn("╰", body)
        self.assertNotIn("❯", body)

    def test_it_is_short_enough_for_a_lock_screen(self):
        body = notify_body("\n".join(f"line {i} " + "of a very long agent monologue " * 4
                                     for i in range(50)))
        self.assertLessEqual(len(body), 140)
        self.assertTrue(body.endswith("…"))

    def test_an_empty_pane_says_nothing_rather_than_failing(self):
        self.assertEqual(notify_body(""), "")
        self.assertEqual(notify_body("\n\n   \n"), "")


class FinishedBodyTests(unittest.TestCase):
    """Which of the two readings a finished pane's push carries.

    The detector lives in relay/pane_summary.py and is tested against the browser's fixtures in
    tests/test_pane_summary.py. What is pinned here is the choice: the closing message when there
    is one, the bottom of the pane when there is not, and the setting that forces the latter.
    """

    def test_an_unset_relay_reads_the_pane_as_it_always_did(self):
        # The detector is opt-in while it is new. Nothing about a relay that has never heard of
        # HERDR_PUSH_SUMMARY changes.
        self.assertEqual(herdr_relay.finished_body(DONE, "claude"), notify_body(DONE))

    def test_switched_on_it_says_what_the_agent_concluded(self):
        with unittest.mock.patch.object(herdr_relay, "PUSH_SUMMARY", True):
            self.assertEqual(herdr_relay.finished_body(DONE, "claude"), "Ready. Name the change.")
        # Which is the difference: the pane's last three lines start with the command it ran.
        self.assertIn("git status --short", notify_body(DONE))

    def test_a_harness_with_no_profile_falls_back_even_when_it_is_on(self):
        with unittest.mock.patch.object(herdr_relay, "PUSH_SUMMARY", True):
            self.assertEqual(herdr_relay.finished_body(DONE, "amp"), notify_body(DONE))


class PushTagTests(unittest.TestCase):
    def test_two_panes_get_two_tags(self):
        self.assertNotEqual(push_tag("w24:p12"), push_tag("w24:p13"))

    def test_a_tag_is_legal_as_an_rfc_8030_topic(self):
        # Topic is a header value the push service parses: URL-safe base64 alphabet, 32 max.
        for pane in ("w24:p12", "%1", "", "w" * 60):
            tag = push_tag(pane)
            self.assertLessEqual(len(tag), 32, tag)
            self.assertRegex(tag, r"^[A-Za-z0-9_-]+$")

    def test_the_same_pane_always_collapses_onto_itself(self):
        self.assertEqual(push_tag("w24:p12"), push_tag("w24:p12"))


class PushTopicTests(unittest.TestCase):
    """The header the tag travels in, which Apple is stricter about than RFC 8030 reads.

    It decodes the Topic, so a length of 4n+1 is impossible base64 and the whole push is refused
    with `BadWebPushTopic`. The numbers below were checked against web.push.apple.com itself: 13
    and 25 characters are refused, 11, 14, 24, 26 and 32 accepted.
    """

    def topic_is_sendable(self, topic):
        self.assertLessEqual(len(topic), 32, topic)
        self.assertNotEqual(len(topic) % 4, 1, topic)
        self.assertRegex(topic, r"^[A-Za-z0-9_-]+$")

    def test_the_pane_tag_that_was_being_refused(self):
        # "herdr-w24-p22" — 13 characters, and the reason no push from this relay was arriving.
        self.topic_is_sendable(push_topic(push_tag("w24:p22")))

    def test_every_pane_id_shape_this_relay_sees(self):
        for window in range(1, 40):
            for pane in range(1, 40):
                self.topic_is_sendable(push_topic(push_tag(f"w{window}:p{pane}")))

    def test_a_session_id_is_sendable_too(self):
        # The arbitration pause push: "herdr-arb-s-20260817-1103" is 25, which Apple also refuses.
        self.topic_is_sendable(push_topic("herdr-arb-s-20260817-1103"))

    def test_a_topic_already_legal_is_left_alone(self):
        self.assertEqual(push_topic("herdr-w1-p1"), "herdr-w1-p1")

    def test_two_panes_still_collapse_apart(self):
        self.assertNotEqual(push_topic(push_tag("w24:p12")), push_topic(push_tag("w24:p13")))


class StaticFileTests(unittest.TestCase):
    def test_every_served_file_exists(self):
        # The manifest and icons are what make iOS offer Add to Home Screen, which is the only way
        # a phone can receive push at all — a 404 here is a feature that cannot be turned on.
        for name in STATIC_FILES:
            self.assertTrue((WEB / name).is_file(), f"web/{name} is served but missing")

    def test_the_page_asks_for_a_real_manifest_and_icon(self):
        head = (WEB / "index.html").read_text()
        self.assertIn('<link rel="manifest" href="manifest.webmanifest">', head)
        self.assertIn('rel="apple-touch-icon"', head)
        # A data: manifest is what was here before; iOS will not install from one.
        self.assertNotIn('rel="manifest"\n    href="data:', head)


if __name__ == "__main__":
    unittest.main()
