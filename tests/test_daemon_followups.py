from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from clawresearch.cli.main import init_workspace, runtime_dir, state_store_for
from clawresearch.daemon.main import run_supervisor_tick
from clawresearch.state.models import AgentOutputEnvelope
from clawresearch.policy.io import read_policy, write_policy


class DaemonFollowupTests(unittest.TestCase):
    def test_run_supervisor_tick_accepts_openai_compatible_without_command_template(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace, codebase)

            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace, codebase_root=codebase)
            store.create_task(
                project_id=project.id,
                kind="research.bootstrap",
                title="Bootstrap",
                owner_mode="planner",
                priority=10,
            )

            policy_path = runtime_dir(workspace) / "policy.yaml"
            policy = read_policy(policy_path)
            policy.agent_adapter.name = "openai_compatible"
            policy.agent_adapter.command_template = []
            policy.agent_adapter.env = {
                "CLAWRESEARCH_OPENAI_BASE_URL": "http://127.0.0.1:11434/v1",
                "CLAWRESEARCH_OPENAI_MODEL": "qwen3:14b",
                "CLAWRESEARCH_OPENAI_API_KEY": "ollama",
            }
            write_policy(policy_path, policy)

            fake_adapter = mock.Mock()
            fake_adapter.name = "openai_compatible"
            fake_adapter.run_agent.return_value = AgentOutputEnvelope(
                mode="planner",
                summary="planned with openai-compatible adapter",
                rationale="The supervisor should build the adapter even without a shell command template.",
                confidence=0.8,
            )

            with mock.patch("clawresearch.daemon.main.openai_adapter_from_env", return_value=fake_adapter) as patched:
                result = run_supervisor_tick(workspace)

            patched.assert_called_once()
            fake_adapter.run_agent.assert_called_once()
            self.assertIn("agent_completed_task", result["actions"])
            self.assertNotIn("agent_adapter_not_configured", result["actions"])

    def test_run_supervisor_tick_includes_codebase_context_for_openai_adapter(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            (codebase / "timesnet_predictor.py").write_text(
                "class TimesNetPredictor:\n    pass\n",
                encoding="utf-8",
            )
            init_workspace(workspace, codebase)

            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace, codebase_root=codebase)
            store.create_task(
                project_id=project.id,
                kind="research.bootstrap",
                title="Audit TimesNet baseline wiring",
                owner_mode="planner",
                priority=10,
                payload={"brief": "Inspect predictor integration and current baseline evidence."},
            )

            policy_path = runtime_dir(workspace) / "policy.yaml"
            policy = read_policy(policy_path)
            policy.agent_adapter.name = "openai_compatible"
            policy.agent_adapter.command_template = []
            policy.agent_adapter.env = {
                "CLAWRESEARCH_OPENAI_BASE_URL": "http://127.0.0.1:11434/v1",
                "CLAWRESEARCH_OPENAI_MODEL": "qwen3:14b",
                "CLAWRESEARCH_OPENAI_API_KEY": "ollama",
            }
            write_policy(policy_path, policy)

            fake_adapter = mock.Mock()
            fake_adapter.name = "openai_compatible"
            fake_adapter.run_agent.return_value = AgentOutputEnvelope(
                mode="planner",
                summary="planned with codebase context",
                rationale="The prompt bundle should contain a codebase context pack for local models.",
                confidence=0.8,
            )

            with mock.patch("clawresearch.daemon.main.openai_adapter_from_env", return_value=fake_adapter):
                run_supervisor_tick(workspace)

            prompt_bundle = fake_adapter.run_agent.call_args.args[2]
            codebase_context = prompt_bundle["state_snapshot"]["codebase_context"]
            self.assertTrue(codebase_context)
            self.assertIn("timesnet_predictor.py", codebase_context[0]["path"])

    def test_run_supervisor_tick_enqueues_followup_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace, codebase)

            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace, codebase_root=codebase)
            store.create_task(
                project_id=project.id,
                kind="research.bootstrap",
                title="Bootstrap",
                owner_mode="planner",
                priority=10,
            )

            script = workspace / ".clawresearch" / "artifacts" / "followup_agent.py"
            script.write_text(
                """
import json
import os
from pathlib import Path

payload = {
    "mode": os.environ["CLAWRESEARCH_MODE"],
    "summary": "planned next steps",
    "next_actions": [
        {
            "kind": "research.literature",
            "title": "Audit baseline predictor and benchmark evidence",
            "owner_mode": "scout",
            "priority": 20,
            "payload": {"brief": "Map current predictor + MPC baseline evidence."},
        }
    ],
    "rationale": "A first planning pass should schedule the literature and code audit.",
    "confidence": 0.72,
    "entities_created_or_updated": [],
    "artifacts_to_create_or_update": [],
    "jobs_to_start": [],
    "claims_updated": [],
    "evidence_updates": [],
    "decisions_proposed": [],
    "needs_human_approval": False,
    "approval_reason": None,
    "budget_impact": {"gpu_hours": 0.0},
}

Path(os.environ["CLAWRESEARCH_OUTPUT_FILE"]).write_text(json.dumps(payload), encoding="utf-8")
""",
                encoding="utf-8",
            )

            policy_path = runtime_dir(workspace) / "policy.yaml"
            policy = read_policy(policy_path)
            policy.agent_adapter.command_template = ["python3", str(script)]
            write_policy(policy_path, policy)

            result = run_supervisor_tick(workspace)
            self.assertIn("agent_completed_task", result["actions"])
            self.assertIn("created_followup_tasks:1", result["actions"])

            tasks = store.list_tasks(project.id)
            self.assertEqual(len(tasks), 2)
            open_tasks = store.list_open_tasks(project.id)
            self.assertEqual(len(open_tasks), 1)
            self.assertEqual(open_tasks[0]["title"], "Audit baseline predictor and benchmark evidence")

    def test_run_supervisor_tick_normalizes_existing_task_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace, codebase)

            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace, codebase_root=codebase)
            task_id = store.create_task(
                project_id=project.id,
                kind="experiment",
                title="Run matched warm-start benchmark",
                owner_mode="planner",
                priority=10,
                payload={"brief": "Compare scratch, warm-start, and frozen predictor baselines."},
            )

            script = workspace / ".clawresearch" / "artifacts" / "experiment_agent.py"
            script.write_text(
                """
import json
import os
from pathlib import Path

payload = {
    "mode": os.environ["CLAWRESEARCH_MODE"],
    "summary": "executed with normalized mode",
    "next_actions": [],
    "rationale": "The supervisor should route experiment work to the experimenter mode.",
    "confidence": 0.8,
    "entities_created_or_updated": [],
    "artifacts_to_create_or_update": [],
    "jobs_to_start": [],
    "claims_updated": [],
    "evidence_updates": [],
    "decisions_proposed": [],
    "needs_human_approval": False,
    "approval_reason": None,
    "budget_impact": {"gpu_hours": 0.0},
}

Path(os.environ["CLAWRESEARCH_OUTPUT_FILE"]).write_text(json.dumps(payload), encoding="utf-8")
""",
                encoding="utf-8",
            )

            policy_path = runtime_dir(workspace) / "policy.yaml"
            policy = read_policy(policy_path)
            policy.agent_adapter.command_template = ["python3", str(script)]
            write_policy(policy_path, policy)

            result = run_supervisor_tick(workspace)
            self.assertIn(f"normalized_owner_mode:{task_id}:experimenter", result["actions"])

            updated_tasks = store.list_tasks(project.id, status="done")
            self.assertEqual(len(updated_tasks), 1)
            self.assertEqual(updated_tasks[0]["owner_mode"], "experimenter")

    def test_run_supervisor_tick_persists_claims_evidence_decisions_and_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace, codebase)

            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace, codebase_root=codebase)
            store.create_task(
                project_id=project.id,
                kind="research.task",
                title="Audit research state",
                owner_mode="analyst",
                priority=50,
            )

            script = workspace / ".clawresearch" / "artifacts" / "persistence_agent.py"
            script.write_text(
                """
import json
import os
from pathlib import Path

payload = {
    "mode": os.environ["CLAWRESEARCH_MODE"],
    "summary": "persisted research state",
    "next_actions": [],
    "rationale": "The runtime should keep structured research state, not only tasks.",
    "confidence": 0.88,
    "entities_created_or_updated": [
        {
            "summary": "Sharpened research question",
            "kind": "research_question",
            "path": str(Path(os.environ["CLAWRESEARCH_WORKSPACE_ROOT"]) / "research" / "research-question.md"),
            "entity_type": "research.question",
            "entity_id": "rq_demo",
        }
    ],
    "artifacts_to_create_or_update": [],
    "jobs_to_start": [
        {
            "summary": "Run benchmark audit script",
            "command": "python scripts/audit.py",
            "cwd": os.environ["CLAWRESEARCH_CODEBASE_ROOT"],
        }
    ],
    "claims_updated": [
        {
            "summary": "Warm-start evidence is currently incomplete.",
            "kind": "claim",
            "status": "blocked",
            "entity_id": "claim_warmstart_gap",
            "path": str(Path(os.environ["CLAWRESEARCH_CODEBASE_ROOT"]) / "paper" / "note.md"),
        }
    ],
    "evidence_updates": [
        {
            "summary": "Existing benchmark report only compares against XGBoost + MPC.",
            "source": "artifact inspection",
            "strength": "strong",
            "status": "confirmed",
            "entity_id": "ev_xgb_only",
            "path": str(Path(os.environ["CLAWRESEARCH_CODEBASE_ROOT"]) / "out" / "report.md"),
            "cwd": os.environ["CLAWRESEARCH_CODEBASE_ROOT"],
        }
    ],
    "decisions_proposed": [
        {
            "summary": "Do not open publication work yet.",
            "decision_type": "publication_readiness",
            "status": "proposed",
            "blocking": True,
            "entity_id": "dec_hold_publish",
            "rationale": "The same-backbone baseline is still missing.",
        }
    ],
    "needs_human_approval": False,
    "approval_reason": None,
    "budget_impact": {"gpu_hours": 0.0},
}

Path(os.environ["CLAWRESEARCH_OUTPUT_FILE"]).write_text(json.dumps(payload), encoding="utf-8")
""",
                encoding="utf-8",
            )

            policy_path = runtime_dir(workspace) / "policy.yaml"
            policy = read_policy(policy_path)
            policy.agent_adapter.command_template = ["python3", str(script)]
            write_policy(policy_path, policy)

            result = run_supervisor_tick(workspace)
            self.assertIn("persisted_artifacts:3", result["actions"])
            self.assertIn("persisted_claims:1", result["actions"])
            self.assertIn("persisted_evidence:1", result["actions"])
            self.assertIn("persisted_decisions:1", result["actions"])
            self.assertIn("persisted_job_requests:1", result["actions"])

            claims = store.list_claims(project.id)
            evidence = store.list_evidence_items(project.id)
            decisions = store.list_decisions(project.id)
            artifacts = store.list_artifacts(project.id)

            self.assertEqual(len(claims), 1)
            self.assertEqual(claims[0]["id"], "claim_warmstart_gap")
            self.assertEqual(claims[0]["status"], "blocked")

            self.assertEqual(len(evidence), 1)
            self.assertEqual(evidence[0]["id"], "ev_xgb_only")
            self.assertEqual(evidence[0]["strength"], "strong")

            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0]["id"], "dec_hold_publish")
            self.assertEqual(decisions[0]["blocking"], 1)

            self.assertEqual(len(artifacts), 3)
