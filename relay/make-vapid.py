#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["py-vapid>=1.9.0"]
# ///
"""Print a VAPID keypair as the two env lines the relay wants.

    mkdir -p ~/.config/herdr-remote && uv run relay/make-vapid.py >> ~/.config/herdr-remote/secrets.env

VAPID is not an API key and there is nothing to sign up for: the pair is generated here, the
public half is handed to the browser so it can name this relay when it subscribes, and the private
half signs each push so Apple and Google will accept it. Generate once — changing the keys
invalidates every existing subscription, and each device has to enable push again.

`vapid --gen` from py-vapid writes PEM files instead, which is the format neither end of this
relay wants: the browser needs the raw P-256 public point in base64url for applicationServerKey,
and pywebpush wants the private scalar the same way. Getting there from a PEM is the step that
usually goes wrong, so this prints both directly.
"""

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid.utils import b64urlencode


def main():
    private = ec.generate_private_key(ec.SECP256R1())
    public_point = private.public_key().public_bytes(
        # Uncompressed X9.62 point — the one encoding the Push API accepts.
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    scalar = private.private_numbers().private_value.to_bytes(32, "big")
    print(f"HERDR_VAPID_PUBLIC={b64urlencode(public_point)}")
    print(f"HERDR_VAPID_PRIVATE={b64urlencode(scalar)}")
    print("HERDR_VAPID_SUBJECT=mailto:you@example.com")


if __name__ == "__main__":
    main()
