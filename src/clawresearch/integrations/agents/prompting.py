from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def runtime_schema_payload() -> dict[str, Any]:
    next_action_item = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "kind": {"type": ["string", "null"]},
            "title": {"type": "string"},
            "owner_mode": {"type": ["string", "null"]},
            "priority": {"type": ["integer", "null"]},
            "brief": {"type": ["string", "null"]},
            "payload": {"type": ["object", "null"], "additionalProperties": True},
        },
        "required": ["kind", "title", "owner_mode", "priority", "brief", "payload"],
    }
    generic_ref = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "summary": {"type": ["string", "null"]},
            "kind": {"type": ["string", "null"]},
            "path": {"type": ["string", "null"]},
            "source": {"type": ["string", "null"]},
            "status": {"type": ["string", "null"]},
            "entity_type": {"type": ["string", "null"]},
            "entity_id": {"type": ["string", "null"]},
            "decision_type": {"type": ["string", "null"]},
            "rationale": {"type": ["string", "null"]},
            "blocking": {"type": ["boolean", "null"]},
            "strength": {"type": ["string", "null"]},
            "command": {"type": ["string", "null"]},
            "cwd": {"type": ["string", "null"]},
            "metadata": {"type": ["object", "null"], "additionalProperties": True},
        },
        "required": [
            "summary",
            "kind",
            "path",
            "source",
            "status",
            "entity_type",
            "entity_id",
            "decision_type",
            "rationale",
            "blocking",
            "strength",
            "command",
            "cwd",
            "metadata",
        ],
    }
    envelope_fields: dict[str, Any] = {
        "mode": {"type": "string"},
        "summary": {"type": "string"},
        "next_actions": {"type": "array", "items": next_action_item},
        "rationale": {"type": "string"},
        "confidence": {"type": "number"},
        "entities_created_or_updated": {"type": "array", "items": generic_ref},
        "artifacts_to_create_or_update": {"type": "array", "items": generic_ref},
        "jobs_to_start": {"type": "array", "items": generic_ref},
        "claims_updated": {"type": "array", "items": generic_ref},
        "evidence_updates": {"type": "array", "items": generic_ref},
        "decisions_proposed": {"type": "array", "items": generic_ref},
        "needs_human_approval": {"type": "boolean"},
        "approval_reason": {"type": ["string", "null"]},
        "budget_impact": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "gpu_hours": {"type": ["number", "null"]},
                "cpu_hours": {"type": ["number", "null"]},
                "wall_clock_hours": {"type": ["number", "null"]},
            },
            "required": ["gpu_hours", "cpu_hours", "wall_clock_hours"],
        },
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": envelope_fields,
        "required": list(envelope_fields.keys()),
    }


def conversation_schema_payload() -> dict[str, Any]:
    properties: dict[str, Any] = {
        "reply": {"type": "string"},
        "summary": {"type": "string"},
        "research_brief": {"type": ["string", "null"]},
        "proposed_question": {"type": ["string", "null"]},
        "recommended_next_step": {"type": ["string", "null"]},
        "ready_to_start": {"type": "boolean"},
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties.keys()),
    }


def schema_payload() -> dict[str, Any]:
    return runtime_schema_payload()


def build_prompt(bundle: dict[str, Any], workspace_root: Path, codebase_root: Path, mode: str) -> str:
    task = bundle.get("task", {})
    project = bundle.get("project", {})
    brief = ""
    if isinstance(task, dict):
        payload = task.get("payload") or {}
        if isinstance(payload, dict):
            brief = str(payload.get("brief") or "").strip()
    state_snapshot = json.dumps(bundle.get("state_snapshot", {}), indent=2)
    capabilities = bundle.get("runtime_capabilities") or {}
    capabilities_text = json.dumps(capabilities, indent=2)

    schema_text = json.dumps(runtime_schema_payload(), indent=2)
    return f"""You are operating as a ClawResearch {mode} agent.

You are working inside a local autonomous research runtime.

Project:
- id: {project.get("id", "")}
- name: {project.get("name", "")}
- workspace_root: {workspace_root}
- codebase_root: {codebase_root}

Current task:
- kind: {task.get("kind", "")}
- title: {task.get("title", "")}
- owner_mode: {task.get("owner_mode", "")}
- priority: {task.get("priority", "")}

Task brief:
{brief or "(no additional brief provided)"}

Runtime capabilities for this run:
{capabilities_text}

Current research state snapshot:
{state_snapshot}

Rules for this run:
- Treat this as a serious research-planning and evidence-audit pass.
- Inspect the target codebase and its local evidence carefully.
- If this adapter does not provide web access, do not invent web findings. Instead, name the missing literature work explicitly.
- Do not modify files, git state, experiments, configs, notebooks, or the target repository in this run.
- Do not claim results you have not verified.
- Prefer bounded, defensible conclusions over ambitious claims.
- If evidence is insufficient for a public manuscript, say so explicitly.
- Focus on what would most improve the research next.
- Avoid creating duplicate tasks that are already present in the state snapshot.
- If an existing open task already covers the needed work, strengthen the rationale instead of rephrasing it.

Your goal in this run:
- assess the current state of evidence in the target codebase
- identify the actual research gap
- sharpen the primary research question if needed
- propose the most decisive next research actions
- update claims, evidence, and decisions when the codebase or artifact state already supports them

Return only a JSON object matching this schema:
{schema_text}

The JSON must be a valid ClawResearch typed output envelope.
For each next action, choose the most suitable owner_mode from:
- planner
- scout
- experimenter
- analyst
- writer
- reviewer

Expected emphasis for next_actions:
- concrete research tasks
- code/evidence audit tasks
- experiment design or validation tasks
- manuscript work only if the science is actually ready

Guidance for jobs_to_start:
- only propose a job if it is concrete and executable from the current codebase
- include `command` and `cwd`
- put any extra job details under `metadata`, for example:
  - `uses_gpu`
  - `estimated_gpu_hours`
  - `expected_artifacts`
  - `env`
  - `reason`
- do not request a job if the prerequisite code or config is still unclear
"""


def build_conversation_prompt(bundle: dict[str, Any], workspace_root: Path, codebase_root: Path) -> str:
    project = bundle.get("project", {})
    conversation = bundle.get("conversation", {})
    state_snapshot = json.dumps(bundle.get("state_snapshot", {}), indent=2)
    capabilities_text = json.dumps(bundle.get("runtime_capabilities") or {}, indent=2)
    schema_text = json.dumps(conversation_schema_payload(), indent=2)
    return f"""You are the ClawResearch research assistant for an active local research project.

Project:
- id: {project.get("id", "")}
- name: {project.get("name", "")}
- workspace_root: {workspace_root}
- codebase_root: {codebase_root}

Current conversation phase:
- phase: {conversation.get("phase", "startup_chat")}
- new_direction: {conversation.get("new_direction", False)}

Conversation history:
{json.dumps(conversation.get("history", []), indent=2)}

Latest user message:
{conversation.get("latest_user_message", "")}

Runtime capabilities:
{capabilities_text}

Current research state snapshot:
{state_snapshot}

Rules for this run:
- Answer the user's latest message directly and clearly.
- This is a conversation response, not an autonomous execution step.
- Do not start jobs, request approvals, or pretend to have run experiments in this response.
- If there is a blocker such as an approval or running job, mention it briefly but still answer the user's question.
- If the project already has evidence, claims, or decisions, use them explicitly in your answer.
- If the user is redirecting the work, help sharpen the direction rather than defending the old path.
- Be concrete, grounded, and easy to read in a terminal.
- Do not invent web findings or new experimental results.

Return only a JSON object matching this schema:
{schema_text}
"""
