from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from clawresearch.integrations.agents.codex_exec import _build_prompt, _schema_payload, build_codex_command


class CodexExecWrapperTests(unittest.TestCase):
    def test_schema_payload_has_expected_envelope_fields(self) -> None:
        schema = _schema_payload()
        self.assertEqual(schema["type"], "object")
        self.assertIn("mode", schema["properties"])
        self.assertIn("summary", schema["properties"])
        self.assertIn("next_actions", schema["properties"])
        self.assertIn("budget_impact", schema["required"])

    def test_build_prompt_includes_task_brief_and_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            codebase = Path(tmp) / "codebase"
            bundle = {
                "project": {"id": "project_1", "name": "rellflow-e2e"},
                "task": {
                    "kind": "research.question",
                    "title": "Investigate end-to-end MPC for predictor training",
                    "owner_mode": "planner",
                    "priority": 20,
                    "payload": {
                        "brief": "Assess whether end-to-end objective training improves predictor + MPC performance."
                    },
                },
            }
            prompt = _build_prompt(bundle, workspace_root=workspace, codebase_root=codebase, mode="planner")
            self.assertIn(str(workspace), prompt)
            self.assertIn(str(codebase), prompt)
            self.assertIn("Investigate end-to-end MPC for predictor training", prompt)
            self.assertIn("end-to-end objective training", prompt)

    def test_build_codex_command_skips_git_repo_check(self) -> None:
        command = build_codex_command(
            codex_bin=Path("/tmp/codex"),
            codebase_root=Path("/tmp/codebase"),
            schema_path=Path("/tmp/schema.json"),
            output_file=Path("/tmp/output.json"),
        )
        self.assertIn("--skip-git-repo-check", command)
