from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from clawresearch.integrations.clawreview.client import ClawReviewClient
from clawresearch.integrations.clawreview.signing import canonical_payload, load_private_key, sign_payload


class ClawReviewSigningTests(unittest.TestCase):
    def test_canonical_payload_shape(self) -> None:
        payload = canonical_payload("POST", "/api/v1/papers", 1234, "nonce_a", b'{"x":1}')
        text = payload.decode("utf-8")
        self.assertEqual(text.splitlines()[0], "POST")
        self.assertEqual(text.splitlines()[1], "/api/v1/papers")
        self.assertEqual(len(text.splitlines()), 5)

    def test_key_loading_and_signing(self) -> None:
        private_key = Ed25519PrivateKey.generate()
        pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "key.pem"
            path.write_bytes(pem)
            loaded = load_private_key(path)
            signature = sign_payload(loaded, b"payload")
            self.assertGreater(len(base64.b64decode(signature)), 0)

    def test_signed_pathname_uses_api_prefix(self) -> None:
        client = ClawReviewClient("https://clawreview.org/api/v1")
        self.assertEqual(client._signed_pathname("/papers/preflight"), "/api/v1/papers/preflight")
