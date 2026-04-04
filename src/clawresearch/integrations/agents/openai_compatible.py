from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

import httpx

from clawresearch.state.models import AgentOutputEnvelope

from .base import AgentAdapter
from .parsing import parse_envelope_from_text
from .prompting import build_prompt, schema_payload


class OpenAICompatibleAgentAdapter(AgentAdapter):
    name = "openai_compatible"

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str | None = None,
        timeout_seconds: int = 3600,
        extra_headers: dict[str, str] | None = None,
        reasoning_effort: str | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self.extra_headers = extra_headers or {}
        self.reasoning_effort = reasoning_effort
        self.transport = transport

    def prepare_context(
        self,
        workspace: Path,
        mode: str,
        prompt_bundle: dict[str, Any],
        codebase_root: Path | None = None,
    ) -> Path:
        run_dir = workspace / ".clawresearch" / "checkpoints" / f"agent-{uuid.uuid4().hex[:10]}"
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "prompt.json").write_text(json.dumps(prompt_bundle, indent=2), encoding="utf-8")
        return run_dir

    def run_agent(
        self,
        workspace: Path,
        mode: str,
        prompt_bundle: dict[str, Any],
        codebase_root: Path | None = None,
    ) -> AgentOutputEnvelope:
        run_dir = self.prepare_context(workspace, mode, prompt_bundle, codebase_root=codebase_root)
        output_file = run_dir / "output.json"
        schema_file = run_dir / "response-schema.json"
        schema = schema_payload()
        schema_file.write_text(json.dumps(schema, indent=2), encoding="utf-8")

        resolved_codebase_root = codebase_root or workspace
        prompt = build_prompt(prompt_bundle, workspace_root=workspace, codebase_root=resolved_codebase_root, mode=mode)
        payload = self._request_payload(prompt, schema)
        content = self._send_with_fallbacks(payload)
        output_file.write_text(content, encoding="utf-8")
        return self.parse_typed_output(content)

    def _request_payload(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a structured ClawResearch research agent. Return only valid JSON matching the requested schema.",
                },
                {"role": "user", "content": prompt},
            ],
        }
        if self.reasoning_effort:
            body["reasoning_effort"] = self.reasoning_effort
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "clawresearch_agent_output", "schema": schema},
        }
        return body

    def _send_with_fallbacks(self, payload: dict[str, Any]) -> str:
        attempts = [
            payload,
            {**payload, "response_format": {"type": "json_object"}},
            {k: v for k, v in payload.items() if k != "response_format"},
        ]
        last_error: Exception | None = None
        for body in attempts:
            try:
                return self._send_once(body)
            except Exception as exc:  # noqa: BLE001
                last_error = exc
        assert last_error is not None
        raise RuntimeError(f"openai-compatible agent request failed after fallbacks: {last_error}") from last_error

    def _send_once(self, body: dict[str, Any]) -> str:
        headers = {"Content-Type": "application/json", **self.extra_headers}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        with httpx.Client(timeout=self.timeout_seconds, transport=self.transport) as client:
            response = client.post(f"{self.base_url}/chat/completions", headers=headers, json=body)
            response.raise_for_status()
            payload = response.json()
        try:
            message = payload["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"invalid chat completion response shape: {payload}") from exc
        content = message.get("content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            text_parts: list[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text_parts.append(str(item.get("text") or ""))
            joined = "".join(text_parts).strip()
            if joined:
                return joined
        raise RuntimeError(f"unable to extract text content from response: {payload}")

    def parse_typed_output(self, raw_output: str) -> AgentOutputEnvelope:
        return parse_envelope_from_text(raw_output)

    def collect_generated_artifacts(self, run_dir: Path) -> list[Path]:
        return sorted(path for path in run_dir.iterdir() if path.is_file())


def adapter_from_env(env: dict[str, str] | None = None, timeout_seconds: int = 3600) -> OpenAICompatibleAgentAdapter:
    merged_env = {**os.environ, **(env or {})}
    base_url = merged_env.get("CLAWRESEARCH_OPENAI_BASE_URL", "").strip()
    model = merged_env.get("CLAWRESEARCH_OPENAI_MODEL", "").strip()
    api_key = merged_env.get("CLAWRESEARCH_OPENAI_API_KEY", "").strip() or None
    reasoning_effort = merged_env.get("CLAWRESEARCH_OPENAI_REASONING_EFFORT", "").strip() or None
    if not base_url:
        raise RuntimeError("CLAWRESEARCH_OPENAI_BASE_URL is required for the openai_compatible adapter")
    if not model:
        raise RuntimeError("CLAWRESEARCH_OPENAI_MODEL is required for the openai_compatible adapter")
    return OpenAICompatibleAgentAdapter(
        base_url=base_url,
        model=model,
        api_key=api_key,
        timeout_seconds=timeout_seconds,
        reasoning_effort=reasoning_effort,
    )
