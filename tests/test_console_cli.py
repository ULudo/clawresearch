from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from clawresearch.cli.main import (
    _humanize_action,
    _project_snapshot_text,
    _task_title_from_text,
    _validate_codebase_root,
    ensure_initialized,
    init_workspace,
)


class ConsoleCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.workspace = self.root / "demo-workspace"
        self.codebase = self.root / "codebase"
        self.codebase.mkdir(parents=True, exist_ok=True)
        init_workspace(self.workspace, self.codebase)
        self.store = ensure_initialized(self.workspace)
        self.project = self.store.create_project("demo-workspace", self.workspace, codebase_root=self.codebase)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_validate_codebase_root_requires_existing_directory(self) -> None:
        resolved = _validate_codebase_root(str(self.codebase))
        self.assertEqual(resolved, self.codebase.resolve())
        with self.assertRaises(ValueError):
            _validate_codebase_root(str(self.root / "missing"))

    def test_task_title_from_text_truncates_long_input(self) -> None:
        title = _task_title_from_text(
            "Investigate whether end-to-end MPC meaningfully improves predictor+MPC systems under matched contracts and same-backbone baselines.",
            prefix="Research task",
        )
        self.assertLessEqual(len(title), 88)
        self.assertIn("Investigate", title)

    def test_project_snapshot_text_is_human_readable(self) -> None:
        self.store.create_task(
            project_id=self.project.id,
            kind="research.question",
            title="Clarify the same-backbone baseline gap",
            owner_mode="planner",
            priority=200,
            payload={"brief": "Decide whether publication is blocked by missing same-backbone evidence."},
        )
        self.store.record_agent_run(
            project_id=self.project.id,
            mode="planner",
            adapter_name="openai_compatible",
            input_path=None,
            output_path=None,
            status="completed",
            summary="The current manuscript scope is broader than the verified comparator evidence.",
            confidence=0.72,
        )

        snapshot = _project_snapshot_text(self.store, self.workspace)
        self.assertIn("Project: demo-workspace", snapshot)
        self.assertIn("Next task: [planner] Clarify the same-backbone baseline gap", snapshot)
        self.assertIn("Last agent summary:", snapshot)

    def test_humanize_action_maps_internal_labels(self) -> None:
        self.assertEqual(_humanize_action("created_followup_tasks:3"), "queued 3 follow-up task(s)")
        self.assertEqual(_humanize_action("started_job:job_123"), "started job job_123")


if __name__ == "__main__":
    unittest.main()
