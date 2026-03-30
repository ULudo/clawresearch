from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from clawresearch.artifacts.manager import ArtifactManager
from clawresearch.policy.io import default_policy_for_workspace, read_policy, write_policy
from clawresearch.state.models import ProjectStatus
from clawresearch.state.store import StateStore


def runtime_dir(workspace: Path) -> Path:
    return workspace / ".clawresearch"


def state_store_for(workspace: Path) -> StateStore:
    return StateStore(runtime_dir(workspace) / "state.db")


def ensure_initialized(workspace: Path) -> StateStore:
    store = state_store_for(workspace)
    store.initialize()
    return store


def init_workspace(workspace: Path) -> None:
    artifacts = ArtifactManager(workspace)
    artifacts.ensure_workspace()
    artifacts.ensure_required_artifacts()
    policy_path = runtime_dir(workspace) / "policy.yaml"
    if not policy_path.exists():
        write_policy(policy_path, default_policy_for_workspace(workspace))
    ensure_initialized(workspace)


def cmd_init(args: argparse.Namespace) -> int:
    workspace = Path(args.path).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    init_workspace(workspace)
    print(f"Initialized ClawResearch workspace at {workspace}")
    return 0


def cmd_project_create(args: argparse.Namespace) -> int:
    target = Path(args.path).resolve() / args.name if args.path else Path(args.name).resolve()
    target.mkdir(parents=True, exist_ok=True)
    init_workspace(target)
    store = ensure_initialized(target)
    existing = store.get_project(target)
    if existing is None:
        project = store.create_project(args.name, target)
        store.create_task(
            project_id=project.id,
            kind="research.bootstrap",
            title="Initialize research question, literature map, and first plan",
            owner_mode="planner",
            priority=10,
        )
        print(f"Created project {project.name} at {target}")
    else:
        print(f"Project already exists at {target}")
    return 0


def cmd_project_status(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1
    open_tasks = store.list_open_tasks(project.id)
    approvals = store.list_pending_approvals(project.id)
    active_jobs = store.list_active_jobs(project.id)
    payload = {
        "project": {
            "id": project.id,
            "name": project.name,
            "status": project.status,
            "paused": project.paused,
            "root_path": project.root_path,
            "summary": project.summary,
        },
        "open_tasks": len(open_tasks),
        "pending_approvals": len(approvals),
        "active_jobs": len(active_jobs),
        "policy": read_policy(runtime_dir(workspace) / "policy.yaml").to_dict(),
    }
    print(json.dumps(payload, indent=2))
    return 0


def cmd_project_pause(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1
    store.set_project_status(project.id, ProjectStatus.PAUSED.value, paused=True)
    print(f"Paused project {project.name}")
    return 0


def cmd_project_resume(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1
    store.set_project_status(project.id, ProjectStatus.RESEARCHING.value, paused=False)
    print(f"Resumed project {project.name}")
    return 0


def cmd_approvals(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1
    approvals = [dict(row) for row in store.list_pending_approvals(project.id)]
    print(json.dumps(approvals, indent=2))
    return 0


def cmd_logs(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    logs_dir = runtime_dir(workspace) / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(logs_dir.glob("*.log"))
    if not files:
        print("No logs yet.")
        return 0
    target = files[-1]
    lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in lines[-args.lines :]:
        print(line)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="clawresearch", description="Autonomous local research runtime")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="Initialize a workspace in place")
    init_parser.add_argument("path", nargs="?", default=".")
    init_parser.set_defaults(func=cmd_init)

    project_parser = subparsers.add_parser("project", help="Project lifecycle commands")
    project_subparsers = project_parser.add_subparsers(dest="project_command", required=True)

    create_parser = project_subparsers.add_parser("create", help="Create a project workspace")
    create_parser.add_argument("name")
    create_parser.add_argument("--path", default=None, help="Parent directory for the new workspace")
    create_parser.set_defaults(func=cmd_project_create)

    status_parser = project_subparsers.add_parser("status", help="Show project status")
    status_parser.add_argument("--workspace", default=".")
    status_parser.set_defaults(func=cmd_project_status)

    pause_parser = project_subparsers.add_parser("pause", help="Pause a project")
    pause_parser.add_argument("--workspace", default=".")
    pause_parser.set_defaults(func=cmd_project_pause)

    resume_parser = project_subparsers.add_parser("resume", help="Resume a project")
    resume_parser.add_argument("--workspace", default=".")
    resume_parser.set_defaults(func=cmd_project_resume)

    approvals_parser = subparsers.add_parser("approvals", help="List pending approvals")
    approvals_parser.add_argument("--workspace", default=".")
    approvals_parser.set_defaults(func=cmd_approvals)

    logs_parser = subparsers.add_parser("logs", help="Show latest daemon log lines")
    logs_parser.add_argument("--workspace", default=".")
    logs_parser.add_argument("--lines", type=int, default=40)
    logs_parser.set_defaults(func=cmd_logs)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
