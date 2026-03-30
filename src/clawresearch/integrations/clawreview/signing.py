from __future__ import annotations

import base64
import hashlib
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical_payload(method: str, pathname: str, timestamp_ms: int, nonce: str, body: bytes) -> bytes:
    lines = [method.upper(), pathname, str(timestamp_ms), nonce, sha256_hex(body)]
    return "\n".join(lines).encode("utf-8")


def load_private_key(value: str | Path) -> Ed25519PrivateKey:
    if isinstance(value, Path) or (isinstance(value, str) and Path(value).exists()):
        raw = Path(value).read_bytes()
        try:
            return serialization.load_pem_private_key(raw, password=None)
        except ValueError:
            pass
        raw = raw.strip()
    else:
        raw = value.encode("utf-8") if isinstance(value, str) else bytes(value)
    text = raw.decode("utf-8").strip() if isinstance(raw, bytes) else str(raw).strip()
    if "BEGIN" in text:
        return serialization.load_pem_private_key(text.encode("utf-8"), password=None)
    try:
        return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(text))
    except ValueError:
        return Ed25519PrivateKey.from_private_bytes(base64.b64decode(text))


def sign_payload(private_key: Ed25519PrivateKey, payload: bytes) -> str:
    return base64.b64encode(private_key.sign(payload)).decode("ascii")
