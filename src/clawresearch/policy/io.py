from __future__ import annotations

from pathlib import Path

import yaml

from clawresearch.policy.model import Policy


def default_policy_for_workspace(workspace: Path, codebase_root: Path | None = None) -> Policy:
    allowed = [str(workspace.resolve())]
    if codebase_root is not None:
        resolved = str(codebase_root.resolve())
        if resolved not in allowed:
            allowed.append(resolved)
    return Policy(allowed_writable_roots=allowed)


def write_policy(path: Path, policy: Policy) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(policy.to_dict(), handle, sort_keys=False)


def read_policy(path: Path) -> Policy:
    with path.open("r", encoding="utf-8") as handle:
        payload = yaml.safe_load(handle) or {}
    return Policy.from_dict(payload)
