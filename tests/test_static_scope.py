#!/usr/bin/env python3
"""The app's files are served on the LAN listener and on no other.

The relay has two listeners and one request handler. The LAN one answers the devices on your
network; the external one is loopback-only and exists for a tunnel to terminate on, which puts it
on the public internet. A token gates the tunnel, but a token is a secret and secrets leak — so
the file surface is closed there by construction rather than by authentication.

Nothing here is about the *API*: the WebSocket upgrade, the push endpoint and the VAPID key are
what a hosted copy of the app needs to reach this relay from anywhere, and all three stay open on
both listeners. That is the line these tests draw.
"""
import asyncio
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay  # noqa: E402


class FakeHeaders:
    def __init__(self, items):
        self._items = items

    def raw_items(self):
        return list(self._items)

    def get(self, key, default=None):
        for k, v in self._items:
            if k.lower() == key.lower():
                return v
        return default


class FakeRequest:
    def __init__(self, path, headers=()):
        self.path = path
        self.headers = FakeHeaders(headers)


def get(path, *, serve_app, require_token=False, token=None):
    headers = [("Authorization", f"Bearer {token}")] if token else []
    return asyncio.run(herdr_relay.process_request(
        None, FakeRequest(path, headers),
        require_token=require_token, serve_app=serve_app))


# One file per branch of the handler: the page, a module, the built bundle, and an asset.
APP_PATHS = ["/", "/index.html", "/src/state.js", "/dist/index.html", "/sw.js",
             "/manifest.webmanifest", "/icon-192.png"]


class StaticScopeTest(unittest.TestCase):
    def test_lan_serves_the_app(self):
        for path in APP_PATHS:
            with self.subTest(path=path):
                res = get(path, serve_app=True)
                self.assertEqual(res.status_code, 200)
                self.assertTrue(res.body, "served an empty file")

    def test_external_serves_none_of_it(self):
        # With a valid token, so what is being measured is the file gate and not the auth gate.
        old = herdr_relay.AUTH_TOKEN
        herdr_relay.AUTH_TOKEN = "s3cret"
        try:
            for path in APP_PATHS:
                with self.subTest(path=path):
                    res = get(path, serve_app=False, require_token=True, token="s3cret")
                    self.assertEqual(res.status_code, 404)
        finally:
            herdr_relay.AUTH_TOKEN = old

    def test_the_api_a_hosted_app_needs_stays_open(self):
        # The whole point of the tunnel: a page served from GitHub Pages subscribing to push
        # against this relay. Closing the file surface must not close this with it.
        old = herdr_relay.AUTH_TOKEN
        herdr_relay.AUTH_TOKEN = "s3cret"
        try:
            res = get("/api/vapid-public-key", serve_app=False,
                      require_token=True, token="s3cret")
            self.assertEqual(res.status_code, 200)
        finally:
            herdr_relay.AUTH_TOKEN = old

    def test_the_token_still_gates_the_lan_listener_when_it_has_one(self):
        # serve_app is not an exemption from auth. A LAN listener with a token set answers no file
        # to a caller without one.
        old = herdr_relay.AUTH_TOKEN
        herdr_relay.AUTH_TOKEN = "s3cret"
        try:
            res = get("/", serve_app=True, require_token=True)
            self.assertEqual(res.status_code, 401)
        finally:
            herdr_relay.AUTH_TOKEN = old

    def test_traversal_is_refused_on_the_listener_that_does_serve(self):
        # LAN-only is not a reason to relax the allowlist: every device on the network reaches it.
        for path in ["/src/../../relay/herdr_relay.py", "/src/sub/dir.js", "/dist/../index.html",
                     "/../CLAUDE.md", "/src/state.js%00.png"]:
            with self.subTest(path=path):
                self.assertEqual(get(path, serve_app=True).status_code, 404)


if __name__ == "__main__":
    unittest.main()
