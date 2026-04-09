from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from clawresearch.integrations.agents.codex_exec import (
    _build_prompt,
    _codex_path_entries,
    _schema_payload,
    build_codex_command,
)


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

    def test_codex_path_entries_include_node_bin_for_js_entrypoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            node_root = Path(tmp) / ".nvm" / "versions" / "node" / "v24.13.1"
            js_entry = node_root / "lib" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            js_entry.parent.mkdir(parents=True, exist_ok=True)
            js_entry.write_text("console.log('codex')\n", encoding="utf-8")
            (node_root / "bin").mkdir(parents=True, exist_ok=True)

            entries = _codex_path_entries(js_entry)

        self.assertIn(str(js_entry.parent), entries)
        self.assertIn(str(node_root / "bin"), entries)
