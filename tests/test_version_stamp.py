#!/usr/bin/env python3
"""One version, read the same way by the two things that report it.

The page carries the version the build stamped into it; the relay reports the version it read at
startup. Both come from `version` in herdr-plugin.toml, and the whole point of the Settings card
is that a reader can compare them — which only means anything if they agree when nothing is wrong.
So the check here is that both readers land on the same string, and that the stamp actually
replaces the placeholder the unbuilt page ships with.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))
sys.path.insert(0, str(ROOT / "scripts"))

import build  # noqa: E402
import herdr_relay  # noqa: E402


class VersionStamp(unittest.TestCase):
    def test_relay_and_build_read_the_same_version(self):
        self.assertRegex(build.plugin_version(), r"^\d+\.\d+")
        self.assertEqual(herdr_relay.RELAY_VERSION, build.plugin_version())

    def test_the_unbuilt_page_says_dev_and_the_build_stamps_over_it(self):
        page = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        # Served from disk this is what the app reports, and it is the honest answer: what is on
        # screen is the working copy, not a release.
        self.assertIn('<meta name="app-version" content="dev">', page)
        self.assertIn('<meta name="app-built" content="">', page)

        stamped = build.stamp_version(page, "1.2.3", "2026-01-31")
        self.assertIn('<meta name="app-version" content="1.2.3">', stamped)
        self.assertIn('<meta name="app-built" content="2026-01-31">', stamped)
        self.assertNotIn('content="dev"', stamped)

    def test_a_manifest_with_no_version_is_a_failed_build_not_a_blank_one(self):
        # A page stamped with an empty version reads as a released build with no number, which is
        # worse than not building: the card would be lying rather than unknown.
        with self.assertRaises(ValueError):
            build.stamp_version("<meta name=\"app-version\" content=\"dev\">", "", "")


if __name__ == "__main__":
    unittest.main()
