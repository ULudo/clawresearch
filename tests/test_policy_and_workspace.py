from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from clawresearch.cli.main import init_workspace, state_store_for
from clawresearch.policy.io import read_policy


class PolicyAndWorkspaceTests(unittest.TestCase):
    def test_workspace_reinit_merges_codebase_root_into_existing_policy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace)
            init_workspace(workspace, codebase)

            policy = read_policy(workspace / ".clawresearch" / "policy.yaml")
            self.assertIn(str(workspace.resolve()), policy.allowed_writable_roots)
            self.assertIn(str(codebase.resolve()), policy.allowed_writable_roots)

    def test_workspace_init_creates_policy_and_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace, codebase)
            self.assertTrue((workspace / ".clawresearch" / "state.db").exists())
            self.assertTrue((workspace / ".clawresearch" / "policy.yaml").exists())
            self.assertTrue((workspace / "research" / "research-question.md").exists())

            policy = read_policy(workspace / ".clawresearch" / "policy.yaml")
            self.assertIn(str(workspace.resolve()), policy.allowed_writable_roots)
            self.assertIn(str(codebase.resolve()), policy.allowed_writable_roots)

    def test_project_create_and_status_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace)
            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace, codebase_root=codebase)
            store.create_task(project_id=project.id, kind="research.bootstrap", title="Bootstrap", owner_mode="planner")

            loaded = store.get_project(workspace)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded.name, "demo")
            self.assertEqual(loaded.workspace_root, str(workspace.resolve()))
            self.assertEqual(loaded.codebase_root, str(codebase.resolve()))
            tasks = store.list_open_tasks(project.id)
            self.assertEqual(len(tasks), 1)
            self.assertEqual(tasks[0]["owner_mode"], "planner")
            payload = json.loads(tasks[0]["payload_json"])
            self.assertEqual(payload, {})

    def test_tasks_are_listed_with_higher_priority_first(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            init_workspace(workspace)
            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace)
            store.create_task(project_id=project.id, kind="research.followup", title="lower", owner_mode="planner", priority=40)
            store.create_task(project_id=project.id, kind="research.followup", title="higher", owner_mode="planner", priority=90)

            tasks = store.list_open_tasks(project.id)
            self.assertEqual(tasks[0]["title"], "higher")
            self.assertEqual(tasks[1]["title"], "lower")

    def test_ensure_task_dedupes_matching_open_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            init_workspace(workspace)
            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace)

            first_id, first_created = store.ensure_task(
                project_id=project.id,
                kind="research.followup",
                title="Audit baseline predictor",
                owner_mode="scout",
                priority=80,
                payload={"brief": "Compare against the current MPC baseline."},
            )
            second_id, second_created = store.ensure_task(
                project_id=project.id,
                kind="research.followup",
                title="Audit baseline predictor",
                owner_mode="scout",
                priority=80,
                payload={"brief": "Compare against the current MPC baseline."},
            )

            self.assertTrue(first_created)
            self.assertFalse(second_created)
            self.assertEqual(first_id, second_id)
            self.assertEqual(len(store.list_open_tasks(project.id)), 1)
