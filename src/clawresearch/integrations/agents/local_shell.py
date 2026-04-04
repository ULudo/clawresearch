from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path
from typing import Any

from clawresearch.state.models import AgentOutputEnvelope

from .base import AgentAdapter
from .parsing import parse_envelope_from_text


class LocalShellAgentAdapter(AgentAdapter):
    name = "local_shell"

    def __init__(self, command_template: list[str], env: dict[str, str] | None = None, timeout_seconds: int = 3600) -> None:
        self.command_template = command_template
        self.env = env or {}
        self.timeout_seconds = timeout_seconds

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
        if not self.command_template:
            raise RuntimeError("agent adapter command_template is empty")
        run_dir = self.prepare_context(workspace, mode, prompt_bundle, codebase_root=codebase_root)
        output_file = run_dir / "output.json"
        resolved_codebase_root = codebase_root or workspace
        env = {
            **os.environ,
            **self.env,
            "CLAWRESEARCH_MODE": mode,
            "CLAWRESEARCH_PROMPT_FILE": str(run_dir / "prompt.json"),
            "CLAWRESEARCH_OUTPUT_FILE": str(output_file),
            "CLAWRESEARCH_WORKSPACE_ROOT": str(workspace),
            "CLAWRESEARCH_CODEBASE_ROOT": str(resolved_codebase_root),
        }
        result = subprocess.run(
            self.command_template,
            cwd=str(resolved_codebase_root),
            env={**env},
            capture_output=True,
            text=True,
            timeout=self.timeout_seconds,
            check=False,
        )
        raw_output = output_file.read_text(encoding="utf-8") if output_file.exists() else result.stdout
        if result.returncode != 0 and not raw_output.strip():
            raise RuntimeError(f"agent adapter command failed: {result.stderr.strip()}")
        return self.parse_typed_output(raw_output)

    def parse_typed_output(self, raw_output: str) -> AgentOutputEnvelope:
        return parse_envelope_from_text(raw_output)

    def collect_generated_artifacts(self, run_dir: Path) -> list[Path]:
        return sorted(path for path in run_dir.iterdir() if path.is_file())
