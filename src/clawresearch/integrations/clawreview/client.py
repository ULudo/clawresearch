from __future__ import annotations

import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from clawresearch.integrations.clawreview.signing import canonical_payload, load_private_key, sign_payload


@dataclass(slots=True)
class ProtocolFile:
    id: str
    url: str
    sha256: str
    optional: bool = False


class ProtocolPackManager:
    def __init__(self, origin: str = "https://clawreview.org") -> None:
        self.origin = origin.rstrip("/")

    def fetch_skill_json(self) -> dict[str, Any]:
        response = httpx.get(f"{self.origin}/skill.json", timeout=30.0)
        response.raise_for_status()
        return response.json()

    def fetch_and_verify(self, target_dir: Path) -> list[Path]:
        target_dir.mkdir(parents=True, exist_ok=True)
        payload = self.fetch_skill_json()
        downloaded: list[Path] = []
        for entry in payload.get("files", []):
            file_path = target_dir / Path(entry["url"]).name
            response = httpx.get(entry["url"], timeout=30.0)
            response.raise_for_status()
            body = response.content
            digest = hashlib.sha256(body).hexdigest()
            if digest != entry["sha256"]:
                raise RuntimeError(f"hash mismatch for {entry['url']}")
            file_path.write_bytes(body)
            downloaded.append(file_path)
        return downloaded


class ClawReviewClient:
    def __init__(self, base_api_url: str, agent_id: str | None = None, private_key: str | Path | None = None) -> None:
        self.base_api_url = base_api_url.rstrip("/")
        self.agent_id = agent_id
        self.private_key = load_private_key(private_key) if private_key else None
        self.client = httpx.Client(timeout=60.0)

    def _signed_pathname(self, pathname: str) -> str:
        base_path = urlparse(self.base_api_url).path.rstrip("/")
        return f"{base_path}{pathname}"

    def _signed_headers(self, method: str, pathname: str, body: bytes) -> dict[str, str]:
        if self.agent_id is None or self.private_key is None:
            raise RuntimeError("signed request requires agent_id and private_key")
        timestamp = int(time.time() * 1000)
        nonce = f"nonce_{secrets.token_hex(8)}"
        payload = canonical_payload(method, self._signed_pathname(pathname), timestamp, nonce, body)
        return {
            "X-Agent-Id": self.agent_id,
            "X-Timestamp": str(timestamp),
            "X-Nonce": nonce,
            "X-Signature": sign_payload(self.private_key, payload),
            "Idempotency-Key": f"idemp_{secrets.token_hex(12)}",
            "Content-Type": "application/json",
        }

    def _post(self, pathname: str, payload: dict[str, Any], signed: bool = False) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        headers = self._signed_headers("POST", pathname, body) if signed else {"Content-Type": "application/json"}
        response = self.client.post(f"{self.base_api_url}{pathname}", content=body, headers=headers)
        response.raise_for_status()
        return response.json()

    def _get(self, pathname: str) -> dict[str, Any]:
        response = self.client.get(f"{self.base_api_url}{pathname}")
        response.raise_for_status()
        return response.json()

    def register_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/agents/register", payload)

    def verify_challenge(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/agents/verify-challenge", payload)

    def preflight(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/papers/preflight", payload, signed=True)

    def publish_paper(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/papers", payload, signed=True)

    def init_asset(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/assets/init", payload, signed=True)

    def complete_asset(self, asset_id: str) -> dict[str, Any]:
        return self._post("/assets/complete", {"asset_id": asset_id}, signed=True)

    def upload_asset(self, upload_url: str, content: bytes, content_type: str = "image/png") -> None:
        response = self.client.put(upload_url, content=content, headers={"Content-Type": content_type})
        response.raise_for_status()

    def list_under_review(self) -> dict[str, Any]:
        return self._get("/under-review?include_review_meta=true")

    def submit_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/reviews", payload, signed=True)
