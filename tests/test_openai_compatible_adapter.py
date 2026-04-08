from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import httpx

from clawresearch.integrations.agents.openai_compatible import OpenAICompatibleAgentAdapter


class OpenAICompatibleAdapterTests(unittest.TestCase):
    def test_adapter_calls_openai_compatible_chat_completions(self) -> None:
        captured_bodies: list[dict[str, object]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/v1/chat/completions")
            body = json.loads(request.content.decode("utf-8"))
            captured_bodies.append(body)
            response_payload = {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "mode": "planner",
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
                                    "budget_impact": {"gpu_hours": 0, "cpu_hours": 0, "wall_clock_hours": 0},
                                }
                            )
                        }
                    }
                ]
            }
            return httpx.Response(200, json=response_payload)

        adapter = OpenAICompatibleAgentAdapter(
            base_url="http://localhost:11434/v1",
            model="qwen3-14b",
            timeout_seconds=10,
            transport=httpx.MockTransport(handler),
        )

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            result = adapter.run_agent(
                workspace,
                "planner",
                {
                    "project": {"id": "project_demo", "name": "demo"},
                    "task": {"kind": "research.bootstrap", "title": "Bootstrap", "owner_mode": "planner", "priority": 10},
                },
                codebase_root=codebase,
            )

        self.assertEqual(result.mode, "planner")
        self.assertEqual(result.summary, "ok")
        self.assertEqual(len(captured_bodies), 1)
        self.assertEqual(captured_bodies[0]["model"], "qwen3-14b")
        self.assertEqual(captured_bodies[0]["response_format"]["type"], "json_schema")

    def test_adapter_falls_back_when_json_schema_is_rejected(self) -> None:
        seen_response_formats: list[object] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8"))
            seen_response_formats.append(body.get("response_format"))
            response_format = body.get("response_format")
            if isinstance(response_format, dict) and response_format.get("type") == "json_schema":
                return httpx.Response(400, json={"error": {"message": "json_schema unsupported"}})
            response_payload = {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "mode": "analyst",
                                    "summary": "fallback ok",
                                    "next_actions": [],
                                    "rationale": "fallback test",
                                    "confidence": 0.7,
                                    "entities_created_or_updated": [],
                                    "artifacts_to_create_or_update": [],
                                    "jobs_to_start": [],
                                    "claims_updated": [],
                                    "evidence_updates": [],
                                    "decisions_proposed": [],
                                    "needs_human_approval": False,
                                    "approval_reason": None,
                                    "budget_impact": {"gpu_hours": None, "cpu_hours": None, "wall_clock_hours": None},
                                }
                            )
                        }
                    }
                ]
            }
            return httpx.Response(200, json=response_payload)

        adapter = OpenAICompatibleAgentAdapter(
            base_url="http://localhost:11434/v1",
            model="qwen3-14b",
            timeout_seconds=10,
            transport=httpx.MockTransport(handler),
        )

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            result = adapter.run_agent(
                workspace,
                "analyst",
                {"project": {"id": "project_demo", "name": "demo"}, "task": {"kind": "analysis", "title": "Audit"}},
                codebase_root=codebase,
            )

        self.assertEqual(result.mode, "analyst")
        self.assertEqual(result.summary, "fallback ok")
        self.assertGreaterEqual(len(seen_response_formats), 2)
        self.assertEqual(seen_response_formats[0]["type"], "json_schema")
        self.assertEqual(seen_response_formats[1]["type"], "json_object")

    def test_adapter_can_run_conversation(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8"))
            self.assertEqual(body["response_format"]["type"], "json_schema")
            response_payload = {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "reply": "The current research direction is too broad. We should first test the same-backbone baseline.",
                                    "summary": "Narrow to a matched same-backbone baseline question.",
                                    "research_brief": "Test whether end-to-end MPC outperforms a separately trained same-backbone baseline.",
                                    "proposed_question": "Does end-to-end MPC improve a same-backbone baseline under matched contracts?",
                                    "recommended_next_step": "Plan and run the same-backbone baseline.",
                                    "ready_to_start": True,
                                }
                            )
                        }
                    }
                ]
            }
            return httpx.Response(200, json=response_payload)

        adapter = OpenAICompatibleAgentAdapter(
            base_url="http://localhost:11434/v1",
            model="qwen3-14b",
            timeout_seconds=10,
            transport=httpx.MockTransport(handler),
        )

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            result = adapter.run_conversation(
                workspace,
                {
                    "project": {"id": "project_demo", "name": "demo"},
                    "conversation": {
                        "phase": "startup_chat",
                        "history": [{"role": "user", "content": "What is the current research direction?"}],
                        "latest_user_message": "What is the current research direction?",
                    },
                },
                codebase_root=codebase,
            )

        self.assertIn("same-backbone baseline", result.reply)
        self.assertTrue(result.ready_to_start)
