from __future__ import annotations

import json

from clawresearch.state.models import AgentOutputEnvelope


def parse_envelope_from_text(raw_output: str) -> AgentOutputEnvelope:
    payload = _extract_json_payload(raw_output)
    return AgentOutputEnvelope(**payload)


def _extract_json_payload(raw_output: str) -> dict:
    text = raw_output.strip()
    if not text:
        raise RuntimeError("agent output is empty")

    direct = _try_json_load(text)
    if direct is not None:
        return direct

    fence_start = text.find("```")
    if fence_start != -1:
        fence_end = text.rfind("```")
        if fence_end > fence_start:
            fenced = text[fence_start + 3 : fence_end].strip()
            if fenced.startswith("json"):
                fenced = fenced[4:].strip()
            loaded = _try_json_load(fenced)
            if loaded is not None:
                return loaded

    for candidate in _iter_braced_candidates(text):
        loaded = _try_json_load(candidate)
        if loaded is not None:
            return loaded

    raise RuntimeError("unable to parse typed agent output as JSON")


def _try_json_load(candidate: str) -> dict | None:
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _iter_braced_candidates(text: str):
    depth = 0
    start = None
    for index, char in enumerate(text):
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}":
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and start is not None:
                yield text[start : index + 1]
                start = None
