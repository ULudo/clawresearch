from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from clawresearch.cli.main import (
    _humanize_action,
    _chat_session,
    _materialize_session_to_runtime,
    _project_has_history,
    _project_snapshot_text,
    _task_title_from_text,
    ensure_initialized,
    init_workspace,
    main,
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

    def test_main_without_args_starts_console(self) -> None:
        with mock.patch("clawresearch.cli.main.cmd_console", return_value=0) as patched:
            result = main([])
        self.assertEqual(result, 0)
        patched.assert_called_once()

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

    def test_project_has_history_ignores_only_bootstrap_task(self) -> None:
        self.store.create_task(
            project_id=self.project.id,
            kind="research.bootstrap",
            title="Initialize research question, literature map, and first plan",
            owner_mode="planner",
            priority=10,
            payload={},
        )
        self.assertFalse(_project_has_history(self.store, self.project.id))

        self.store.create_task(
            project_id=self.project.id,
            kind="research.reframe",
            title="Pivot to a new research direction",
            owner_mode="planner",
            priority=200,
            payload={"brief": "Switch from benchmark comparison to warm-start transfer validation."},
        )
        self.assertTrue(_project_has_history(self.store, self.project.id))

    def test_materialize_session_to_runtime_updates_summary_and_artifact(self) -> None:
        session_id = "session123"
        self.store.append_conversation_turn(
            project_id=self.project.id,
            phase="startup_chat",
            role="user",
            content="I want to understand whether end-to-end MPC helps with a same-backbone predictor baseline.",
            metadata={"session_id": session_id},
        )
        self.store.append_conversation_turn(
            project_id=self.project.id,
            phase="startup_chat",
            role="agent",
            content="We should narrow the question to a matched same-backbone comparison.",
            metadata={
                "session_id": session_id,
                "research_brief": "Test whether end-to-end MPC beats a separately trained same-backbone predictor + MPC baseline under matched contracts.",
                "proposed_question": "Does end-to-end MPC improve a same-backbone baseline under matched benchmark contracts?",
                "recommended_next_step": "Run the same-backbone baseline before broadening the manuscript claim.",
            },
        )

        created = _materialize_session_to_runtime(
            self.store,
            self.project,
            self.workspace,
            session_id=session_id,
            new_direction=False,
        )

        self.assertTrue(created)
        refreshed = self.store.get_project(self.workspace)
        assert refreshed is not None
        self.assertIn("same-backbone predictor + MPC baseline", refreshed.summary or "")

        artifact = (self.workspace / "research" / "research-question.md").read_text(encoding="utf-8")
        self.assertIn("Does end-to-end MPC improve a same-backbone baseline", artifact)

        tasks = self.store.list_open_tasks(self.project.id)
        self.assertEqual(len(tasks), 1)
        payload = json.loads(tasks[0]["payload_json"])
        self.assertEqual(payload["session_id"], session_id)

    def test_humanize_action_maps_internal_labels(self) -> None:
        self.assertEqual(_humanize_action("created_followup_tasks:3"), "queued 3 follow-up task(s)")
        self.assertEqual(_humanize_action("started_job:job_123"), "started job job_123")

    def test_chat_session_handles_keyboard_interrupt_cleanly(self) -> None:
        with mock.patch("clawresearch.cli.main.Prompt.ask", side_effect=KeyboardInterrupt):
            result = _chat_session(
                self.store,
                self.project,
                self.workspace,
                phase="startup_chat",
                new_direction=False,
            )
        self.assertEqual(result, "quit")


if __name__ == "__main__":
    unittest.main()
