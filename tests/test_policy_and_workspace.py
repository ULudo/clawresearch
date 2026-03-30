from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from clawresearch.cli.main import init_workspace, state_store_for
from clawresearch.policy.io import read_policy


class PolicyAndWorkspaceTests(unittest.TestCase):
    def test_workspace_init_creates_policy_and_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            init_workspace(workspace)
            self.assertTrue((workspace / ".clawresearch" / "state.db").exists())
            self.assertTrue((workspace / ".clawresearch" / "policy.yaml").exists())
            self.assertTrue((workspace / "research" / "research-question.md").exists())

            policy = read_policy(workspace / ".clawresearch" / "policy.yaml")
            self.assertIn(str(workspace.resolve()), policy.allowed_writable_roots)

    def test_project_create_and_status_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            init_workspace(workspace)
            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace)
            store.create_task(project_id=project.id, kind="research.bootstrap", title="Bootstrap", owner_mode="planner")

            loaded = store.get_project(workspace)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded.name, "demo")
            tasks = store.list_open_tasks(project.id)
            self.assertEqual(len(tasks), 1)
            self.assertEqual(tasks[0]["owner_mode"], "planner")
            payload = json.loads(tasks[0]["payload_json"])
            self.assertEqual(payload, {})
