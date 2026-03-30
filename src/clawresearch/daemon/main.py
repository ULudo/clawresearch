from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from clawresearch.artifacts.manager import ArtifactManager
from clawresearch.cli.main import ensure_initialized, runtime_dir
from clawresearch.integrations.agents.local_shell import LocalShellAgentAdapter
from clawresearch.jobs.runner import JobRunner
from clawresearch.policy.io import read_policy
from clawresearch.recovery.reconcile import reconcile_workspace
from clawresearch.scheduler.resources import ResourceManager
from clawresearch.state.models import ProjectStatus


def run_supervisor_tick(workspace: Path) -> dict[str, object]:
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        raise RuntimeError(f"workspace is initialized but has no project: {workspace}")

    policy = read_policy(runtime_dir(workspace) / "policy.yaml")
    artifacts = ArtifactManager(workspace)
    artifacts.ensure_required_artifacts()
    runner = JobRunner(runtime_dir(workspace) / "jobs")
    resource_manager = ResourceManager(store)

    summary: dict[str, object] = {
        "project_id": project.id,
        "project_name": project.name,
        "project_status": project.status,
        "paused": project.paused,
        "recovery": reconcile_workspace(store, runner, resource_manager, project.id),
        "actions": [],
    }

    if project.paused:
        summary["actions"].append("paused_project_noop")
        return summary

    pending_approvals = store.list_pending_approvals(project.id)
    if pending_approvals:
        store.set_project_status(project.id, ProjectStatus.AWAITING_APPROVAL.value, paused=False)
        summary["actions"].append(f"awaiting_approval:{len(pending_approvals)}")
        return summary

    active_jobs = store.list_active_jobs(project.id)
    if active_jobs:
        store.set_project_status(project.id, ProjectStatus.RUNNING_JOBS.value, paused=False)
        summary["actions"].append(f"running_jobs:{len(active_jobs)}")
        return summary

    open_tasks = store.list_open_tasks(project.id)
    if not open_tasks:
        store.set_project_status(project.id, ProjectStatus.ARCHIVED_LOCAL.value, paused=False)
        summary["actions"].append("no_open_tasks_archive_local")
        return summary

    command_template = policy.agent_adapter.command_template
    if not command_template:
        summary["actions"].append("agent_adapter_not_configured")
        return summary

    task = open_tasks[0]
    prompt_bundle = {
        "project": {"id": project.id, "name": project.name, "root_path": project.root_path},
        "task": dict(task),
        "policy": policy.to_dict(),
    }
    adapter = LocalShellAgentAdapter(
        command_template=command_template,
        env=policy.agent_adapter.env,
        timeout_seconds=policy.agent_adapter.timeout_seconds,
    )
    result = adapter.run_agent(workspace, task["owner_mode"] or "planner", prompt_bundle)
    store.record_agent_run(
        project_id=project.id,
        mode=result.mode,
        adapter_name=adapter.name,
        input_path=None,
        output_path=None,
        status="completed",
        summary=result.summary,
        confidence=result.confidence,
    )
    store.set_task_status(task["id"], "done")
    store.append_event(
        project_id=project.id,
        entity_type="agent_run",
        entity_id=task["id"],
        event_type="agent.completed",
        payload={"mode": result.mode, "summary": result.summary, "needs_human_approval": result.needs_human_approval},
    )
    if result.needs_human_approval:
        store.create_approval(
            project_id=project.id,
            approval_type="agent_requested",
            reason=result.approval_reason or "Agent requested human approval",
            payload={"task_id": task["id"], "summary": result.summary},
        )
        summary["actions"].append("agent_requested_approval")
    else:
        summary["actions"].append("agent_completed_task")
    return summary


def cmd_serve(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    logs_dir = runtime_dir(workspace) / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_file = logs_dir / "supervisor.log"
    while True:
        result = run_supervisor_tick(workspace)
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(result) + "\n")
        time.sleep(args.interval_seconds)


def cmd_run_once(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    print(json.dumps(run_supervisor_tick(workspace), indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="clawresearchd", description="ClawResearch supervisor daemon")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="Run the supervisor loop continuously")
    serve.add_argument("--workspace", default=".")
    serve.add_argument("--interval-seconds", type=int, default=30)
    serve.set_defaults(func=cmd_serve)

    run_once = subparsers.add_parser("run-once", help="Run a single supervisor tick")
    run_once.add_argument("--workspace", default=".")
    run_once.set_defaults(func=cmd_run_once)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
