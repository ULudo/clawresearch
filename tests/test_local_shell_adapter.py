from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from clawresearch.integrations.agents.local_shell import LocalShellAgentAdapter


class LocalShellAdapterTests(unittest.TestCase):
    def test_adapter_reads_json_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            script = workspace / "agent.py"
            script.write_text(
                """
import json
import os
from pathlib import Path

output = {
    "mode": os.environ["CLAWRESEARCH_MODE"],
    "summary": "ok",
    "next_actions": [],
    "rationale": "test",
    "confidence": 0.5,
    "entities_created_or_updated": [],
    "artifacts_to_create_or_update": [],
    "jobs_to_start": [],
    "claims_updated": [],
    "evidence_updates": [],
    "decisions_proposed": [],
    "needs_human_approval": False,
    "approval_reason": None,
    "budget_impact": {"gpu_hours": 0},
}
assert os.environ["CLAWRESEARCH_CODEBASE_ROOT"].endswith("codebase")
assert os.environ["CLAWRESEARCH_WORKSPACE_ROOT"] != os.environ["CLAWRESEARCH_CODEBASE_ROOT"]
Path(os.environ["CLAWRESEARCH_OUTPUT_FILE"]).write_text(json.dumps(output), encoding="utf-8")
""",
                encoding="utf-8",
            )
            codebase = workspace / "codebase"
            codebase.mkdir()
            adapter = LocalShellAgentAdapter(["python3", str(script)])
            result = adapter.run_agent(workspace, "planner", {"hello": "world"}, codebase_root=codebase)
            self.assertEqual(result.mode, "planner")
            self.assertEqual(result.summary, "ok")
            self.assertFalse(result.needs_human_approval)

    def test_adapter_parses_fenced_json_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            script = workspace / "agent.py"
            script.write_text(
                """
import os
from pathlib import Path

Path(os.environ["CLAWRESEARCH_OUTPUT_FILE"]).write_text(
    \"\"\"```json
{
  "mode": "analyst",
  "summary": "fenced",
  "next_actions": [],
  "rationale": "parser should recover the JSON payload",
  "confidence": 0.9,
  "entities_created_or_updated": [],
  "artifacts_to_create_or_update": [],
  "jobs_to_start": [],
  "claims_updated": [],
  "evidence_updates": [],
  "decisions_proposed": [],
  "needs_human_approval": false,
  "approval_reason": null,
  "budget_impact": {"gpu_hours": 0, "cpu_hours": 0, "wall_clock_hours": 0}
}
```\"\"\",
    encoding="utf-8",
)
""",
                encoding="utf-8",
            )
            codebase = workspace / "codebase"
            codebase.mkdir()
            adapter = LocalShellAgentAdapter(["python3", str(script)])
            result = adapter.run_agent(workspace, "analyst", {"hello": "world"}, codebase_root=codebase)
            self.assertEqual(result.mode, "analyst")
            self.assertEqual(result.summary, "fenced")
