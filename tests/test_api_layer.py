from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from clawresearch.api.server import ApiRequestHandler
from clawresearch.api.service import ApiService
from clawresearch.cli.main import ensure_initialized, init_workspace


class ApiLayerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.workspace = self.root / "demo-project"
        self.codebase = self.root / "codebase"
        self.codebase.mkdir(parents=True, exist_ok=True)
        (self.codebase / "README.md").write_text("# Demo codebase\n", encoding="utf-8")
        self.workspace.mkdir(parents=True, exist_ok=True)
        init_workspace(self.workspace, self.codebase)
        self.store = ensure_initialized(self.workspace)
        project = self.store.create_project("demo-project", self.workspace, codebase_root=self.codebase)
        self.project_id = project.id
        self.store.create_task(
            project_id=self.project_id,
            kind="research.question",
            title="Investigate same-backbone baseline",
            owner_mode="planner",
            priority=120,
            payload={"brief": "Determine whether the same-backbone baseline is missing and blocking publication."},
        )
        self.store.upsert_claim(
            project_id=self.project_id,
            claim_id="claim_missing_baseline",
            text="A same-backbone baseline is still missing.",
            scope=None,
            claim_type="claim",
            status="supported",
        )
        self.store.upsert_decision(
            project_id=self.project_id,
            decision_id="decision_block_publish",
            decision_type="publication_readiness",
            status="proposed",
            summary="Publication is blocked by missing baseline evidence.",
            rationale="The current manuscript scope outruns the verified comparator set.",
            blocking=True,
        )
        self.store.create_approval(
            project_id=self.project_id,
            approval_type="gpu_budget_threshold",
            reason="Requested GPU job exceeds approval threshold (12.00h)",
            payload={
                "command": "python train.py",
                "cwd": str(self.workspace),
                "job_request": {
                    "summary": "Train a same-backbone predictor baseline",
                    "rationale": "This run would resolve the central missing comparator.",
                    "metadata": {"uses_gpu": True, "estimated_gpu_hours": 12, "expected_artifacts": ["out/model.pt"]},
                },
            },
        )
        (self.workspace / "research" / "research-question.md").write_text(
            "# Research Question\n\nCan end-to-end MPC beat a separately trained predictor + MPC stack under matched conditions?\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_service_overview_aggregates_human_readable_state(self) -> None:
        service = ApiService(default_workspace=self.workspace)
        overview = service.get_project_overview(self.project_id)
        self.assertEqual(overview["project"]["id"], self.project_id)
        self.assertIn("Current blocker", overview["hero_summary"])
        self.assertEqual(overview["current_blocker"]["type"], "approval")
        self.assertEqual(overview["publication_readiness"]["recommended_action"], "continue_research")
        self.assertTrue(overview["open_approvals"])

    def test_route_dispatch_supports_overview_and_command_submission(self) -> None:
        service = ApiService(default_workspace=self.workspace)
        handler = _DummyRouteHarness(service)

        overview = ApiRequestHandler._route(
            handler,
            "GET",
            ["api", "projects", self.project_id, "overview"],
            {},
            {},
        )
        self.assertEqual(overview["project"]["id"], self.project_id)
        self.assertEqual(overview["current_blocker"]["type"], "approval")

        command_result = ApiRequestHandler._route(
            handler,
            "POST",
            ["api", "projects", self.project_id, "commands"],
            {},
            {"text": "Focus on the same-backbone baseline first."},
        )
        self.assertEqual(command_result["action"], "task_created")

        tasks = service.list_tasks(self.project_id)
        self.assertTrue(any(task["title"].startswith("Focus on the same-backbone baseline first") for task in tasks))


class _DummyRouteHarness:
    def __init__(self, service: ApiService) -> None:
        self.service = service

    _workspace_from_query = ApiRequestHandler._workspace_from_query
    _optional_str = ApiRequestHandler._optional_str
    _optional_int = ApiRequestHandler._optional_int
    _optional_bool = ApiRequestHandler._optional_bool


if __name__ == "__main__":
    unittest.main()
