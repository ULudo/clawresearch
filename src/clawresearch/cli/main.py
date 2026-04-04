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


def init_workspace(workspace: Path, codebase_root: Path | None = None) -> None:
    artifacts = ArtifactManager(workspace)
    artifacts.ensure_workspace()
    artifacts.ensure_required_artifacts()
    policy_path = runtime_dir(workspace) / "policy.yaml"
    if policy_path.exists():
        policy = read_policy(policy_path)
        resolved_workspace = str(workspace.resolve())
        if resolved_workspace not in policy.allowed_writable_roots:
            policy.allowed_writable_roots.append(resolved_workspace)
        if codebase_root is not None:
            resolved_codebase_root = str(codebase_root.resolve())
            if resolved_codebase_root not in policy.allowed_writable_roots:
                policy.allowed_writable_roots.append(resolved_codebase_root)
        write_policy(policy_path, policy)
    else:
        write_policy(policy_path, default_policy_for_workspace(workspace, codebase_root))
    ensure_initialized(workspace)


def cmd_init(args: argparse.Namespace) -> int:
    workspace = Path(args.path).resolve()
    codebase_root = Path(args.codebase_root).resolve() if args.codebase_root else None
    if codebase_root is not None and not codebase_root.exists():
        print(f"Codebase root does not exist: {codebase_root}", file=sys.stderr)
        return 1
    if codebase_root is not None and not codebase_root.is_dir():
        print(f"Codebase root is not a directory: {codebase_root}", file=sys.stderr)
        return 1
    workspace.mkdir(parents=True, exist_ok=True)
    init_workspace(workspace, codebase_root)
    print(f"Initialized ClawResearch workspace at {workspace}")
    return 0


def cmd_project_create(args: argparse.Namespace) -> int:
    target = Path(args.path).resolve() / args.name if args.path else Path(args.name).resolve()
    codebase_root = Path(args.codebase_root).resolve() if args.codebase_root else None
    if codebase_root is not None and not codebase_root.exists():
        print(f"Codebase root does not exist: {codebase_root}", file=sys.stderr)
        return 1
    if codebase_root is not None and not codebase_root.is_dir():
        print(f"Codebase root is not a directory: {codebase_root}", file=sys.stderr)
        return 1
    target.mkdir(parents=True, exist_ok=True)
    init_workspace(target, codebase_root)
    store = ensure_initialized(target)
    existing = store.get_project(target)
    if existing is None:
        project = store.create_project(args.name, target, codebase_root=codebase_root)
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
            "workspace_root": project.workspace_root,
            "codebase_root": project.codebase_root,
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


def _queue_job_from_approval(store: StateStore, workspace: Path, project_id: str, approval_row) -> str:
    requested = json.loads(approval_row["requested_payload_json"])
    command = str(requested.get("command") or "").strip()
    cwd = str(requested.get("cwd") or workspace).strip()
    job_request = requested.get("job_request")
    metadata = dict(job_request.get("metadata") or {}) if isinstance(job_request, dict) else {}
    env_snapshot = metadata.get("env") if isinstance(metadata.get("env"), dict) else {}
    metadata.update(
        {
            "summary": metadata.get("summary") or (job_request or {}).get("summary") or command,
            "reason": metadata.get("reason") or (job_request or {}).get("rationale"),
            "uses_gpu": bool(metadata.get("uses_gpu")),
            "estimated_gpu_hours": metadata.get("estimated_gpu_hours"),
            "approval_id": approval_row["id"],
            "approval_type": approval_row["approval_type"],
        }
    )
    log_path = runtime_dir(workspace) / "jobs" / f"{approval_row['id']}.log"
    return store.create_job(
        project_id=project_id,
        kind=str((job_request or {}).get("kind") or "approved_job"),
        command=command,
        cwd=cwd,
        env_snapshot={str(k): str(v) for k, v in env_snapshot.items()},
        log_path=str(log_path),
        metadata=metadata,
    )


def _resolve_approval(args: argparse.Namespace, *, status: str) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1

    approval = store.get_approval(args.approval_id)
    if approval is None or approval["project_id"] != project.id:
        print(f"No approval found: {args.approval_id}", file=sys.stderr)
        return 1
    if approval["status"] != "pending":
        print(f"Approval is not pending: {args.approval_id}", file=sys.stderr)
        return 1

    resolved_payload: dict[str, object] = {}
    if args.note:
        resolved_payload["note"] = args.note

    created_job_id = None
    if status == "approved" and approval["approval_type"] in {"gpu_budget_threshold", "job_path_outside_policy"}:
        created_job_id = _queue_job_from_approval(store, workspace, project.id, approval)
        resolved_payload["created_job_id"] = created_job_id

    store.resolve_approval(approval["id"], status=status, payload=resolved_payload)
    store.set_project_status(project.id, ProjectStatus.RESEARCHING.value, paused=False)
    print(
        json.dumps(
            {
                "approval_id": approval["id"],
                "status": status,
                "created_job_id": created_job_id,
            },
            indent=2,
        )
    )
    return 0


def cmd_approval_approve(args: argparse.Namespace) -> int:
    return _resolve_approval(args, status="approved")


def cmd_approval_reject(args: argparse.Namespace) -> int:
    return _resolve_approval(args, status="rejected")


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


def cmd_task_create(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1

    payload: dict[str, object] = {}
    if args.payload_json:
        try:
            raw_payload = json.loads(args.payload_json)
        except json.JSONDecodeError as exc:
            print(f"Invalid --payload-json: {exc}", file=sys.stderr)
            return 1
        if not isinstance(raw_payload, dict):
            print("--payload-json must decode to a JSON object", file=sys.stderr)
            return 1
        payload.update(raw_payload)
    if args.brief:
        payload["brief"] = args.brief

    task_id = store.create_task(
        project_id=project.id,
        kind=args.kind,
        title=args.title,
        owner_mode=args.owner_mode,
        priority=args.priority,
        payload=payload,
    )
    print(json.dumps({"task_id": task_id, "workspace": str(workspace), "project_id": project.id}, indent=2))
    return 0


def cmd_task_list(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1

    status = None if args.all else "open"
    tasks = [
        {
            "id": row["id"],
            "kind": row["kind"],
            "title": row["title"],
            "status": row["status"],
            "priority": row["priority"],
            "owner_mode": row["owner_mode"],
            "payload": json.loads(row["payload_json"]),
        }
        for row in store.list_tasks(project.id, status=status)
    ]
    print(json.dumps(tasks, indent=2))
    return 0


def cmd_jobs_list(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1

    statuses = None if args.all else ("pending", "running", "failed", "unknown", "succeeded")
    jobs = []
    for row in store.list_jobs(project.id, statuses=statuses):
        metadata = json.loads(row["metadata_json"])
        jobs.append(
            {
                "id": row["id"],
                "kind": row["kind"],
                "status": row["status"],
                "command": row["command"],
                "cwd": row["cwd"],
                "pid": row["pid"],
                "exit_code": row["exit_code"],
                "log_path": row["log_path"],
                "started_at": row["started_at"],
                "finished_at": row["finished_at"],
                "summary": metadata.get("summary"),
                "uses_gpu": metadata.get("uses_gpu"),
                "estimated_gpu_hours": metadata.get("estimated_gpu_hours"),
            }
        )
    print(json.dumps(jobs, indent=2))
    return 0


def cmd_jobs_show(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1

    row = store.get_job(args.job_id)
    if row is None or row["project_id"] != project.id:
        print(f"No job found: {args.job_id}", file=sys.stderr)
        return 1

    payload = dict(row)
    payload["env_snapshot"] = json.loads(payload.pop("env_snapshot_json"))
    payload["metadata"] = json.loads(payload.pop("metadata_json"))
    print(json.dumps(payload, indent=2))
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    if project is None:
        print(f"No project found at {workspace}", file=sys.stderr)
        return 1

    if args.entity == "claims":
        rows = [
            {
                "id": row["id"],
                "status": row["status"],
                "claim_type": row["claim_type"],
                "scope": row["scope"],
                "text": row["text"],
            }
            for row in store.list_claims(project.id)
        ]
    elif args.entity == "evidence":
        rows = [
            {
                "id": row["id"],
                "source_type": row["source_type"],
                "strength": row["strength"],
                "title": row["title"],
                "conclusion_impact": row["conclusion_impact"],
                "summary": row["summary"],
                "reproducibility": json.loads(row["reproducibility_json"]),
            }
            for row in store.list_evidence_items(project.id)
        ]
    else:
        rows = [
            {
                "id": row["id"],
                "decision_type": row["decision_type"],
                "status": row["status"],
                "blocking": bool(row["blocking"]),
                "summary": row["summary"],
                "rationale": row["rationale"],
            }
            for row in store.list_decisions(project.id)
        ]
    print(json.dumps(rows, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="clawresearch", description="Autonomous local research runtime")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="Initialize a workspace in place")
    init_parser.add_argument("path", nargs="?", default=".")
    init_parser.add_argument("--codebase-root", default=None, help="External codebase root the workspace should operate on")
    init_parser.set_defaults(func=cmd_init)

    project_parser = subparsers.add_parser("project", help="Project lifecycle commands")
    project_subparsers = project_parser.add_subparsers(dest="project_command", required=True)

    create_parser = project_subparsers.add_parser("create", help="Create a project workspace")
    create_parser.add_argument("name")
    create_parser.add_argument("--path", default=None, help="Parent directory for the new workspace")
    create_parser.add_argument("--codebase-root", default=None, help="External codebase root the research workspace should operate on")
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

    approval_parser = subparsers.add_parser("approval", help="Resolve a specific approval")
    approval_subparsers = approval_parser.add_subparsers(dest="approval_command", required=True)

    approval_approve = approval_subparsers.add_parser("approve", help="Approve a pending approval")
    approval_approve.add_argument("approval_id")
    approval_approve.add_argument("--workspace", default=".")
    approval_approve.add_argument("--note", default=None)
    approval_approve.set_defaults(func=cmd_approval_approve)

    approval_reject = approval_subparsers.add_parser("reject", help="Reject a pending approval")
    approval_reject.add_argument("approval_id")
    approval_reject.add_argument("--workspace", default=".")
    approval_reject.add_argument("--note", default=None)
    approval_reject.set_defaults(func=cmd_approval_reject)

    logs_parser = subparsers.add_parser("logs", help="Show latest daemon log lines")
    logs_parser.add_argument("--workspace", default=".")
    logs_parser.add_argument("--lines", type=int, default=40)
    logs_parser.set_defaults(func=cmd_logs)

    task_parser = subparsers.add_parser("task", help="Task lifecycle commands")
    task_subparsers = task_parser.add_subparsers(dest="task_command", required=True)

    task_create = task_subparsers.add_parser("create", help="Create a task in an existing workspace")
    task_create.add_argument("title")
    task_create.add_argument("--workspace", default=".")
    task_create.add_argument("--kind", default="research.followup")
    task_create.add_argument("--owner-mode", default="planner")
    task_create.add_argument("--priority", type=int, default=100)
    task_create.add_argument("--brief", default=None, help="Short natural-language task brief stored in payload")
    task_create.add_argument("--payload-json", default=None, help="Additional task payload as a JSON object")
    task_create.set_defaults(func=cmd_task_create)

    task_list = task_subparsers.add_parser("list", help="List tasks in a workspace")
    task_list.add_argument("--workspace", default=".")
    task_list.add_argument("--all", action="store_true", help="Include completed and blocked tasks")
    task_list.set_defaults(func=cmd_task_list)

    jobs_parser = subparsers.add_parser("jobs", help="Inspect managed jobs")
    jobs_subparsers = jobs_parser.add_subparsers(dest="jobs_command", required=True)

    jobs_list = jobs_subparsers.add_parser("list", help="List jobs in a workspace")
    jobs_list.add_argument("--workspace", default=".")
    jobs_list.add_argument("--all", action="store_true", help="Include every job status")
    jobs_list.set_defaults(func=cmd_jobs_list)

    jobs_show = jobs_subparsers.add_parser("show", help="Show a single job")
    jobs_show.add_argument("job_id")
    jobs_show.add_argument("--workspace", default=".")
    jobs_show.set_defaults(func=cmd_jobs_show)

    inspect_parser = subparsers.add_parser("inspect", help="Inspect research-state entities")
    inspect_parser.add_argument("entity", choices=["claims", "evidence", "decisions"])
    inspect_parser.add_argument("--workspace", default=".")
    inspect_parser.set_defaults(func=cmd_inspect)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
