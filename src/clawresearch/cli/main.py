from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

from clawresearch.artifacts.manager import ArtifactManager
from clawresearch.policy.io import default_policy_for_workspace, read_policy, write_policy
from clawresearch.state.models import ConversationPhase, ProjectStatus
from clawresearch.state.store import StateStore
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt
from rich.rule import Rule
from rich.table import Table


RICH_CONSOLE = Console()


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


def _resolve_approval_for_workspace(
    store: StateStore,
    workspace: Path,
    *,
    approval_id: str,
    status: str,
    note: str | None = None,
) -> dict[str, object]:
    project = store.get_project(workspace)
    if project is None:
        raise RuntimeError(f"No project found at {workspace}")

    approval = store.get_approval(approval_id)
    if approval is None or approval["project_id"] != project.id:
        raise RuntimeError(f"No approval found: {approval_id}")
    if approval["status"] != "pending":
        raise RuntimeError(f"Approval is not pending: {approval_id}")

    resolved_payload: dict[str, object] = {}
    if note:
        resolved_payload["note"] = note

    created_job_id = None
    if status == "approved" and approval["approval_type"] in {"gpu_budget_threshold", "job_path_outside_policy"}:
        created_job_id = _queue_job_from_approval(store, workspace, project.id, approval)
        resolved_payload["created_job_id"] = created_job_id

    store.resolve_approval(approval["id"], status=status, payload=resolved_payload)
    store.set_project_status(project.id, ProjectStatus.RESEARCHING.value, paused=False)
    return {
        "approval_id": approval["id"],
        "status": status,
        "created_job_id": created_job_id,
    }


def _resolve_approval(args: argparse.Namespace, *, status: str) -> int:
    workspace = Path(args.workspace).resolve()
    store = ensure_initialized(workspace)
    try:
        payload = _resolve_approval_for_workspace(
            store,
            workspace,
            approval_id=args.approval_id,
            status=status,
            note=args.note,
        )
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(payload, indent=2))
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


def _normalize_summary_text(value: str, *, limit: int = 140) -> str:
    collapsed = " ".join((value or "").strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def _task_title_from_text(text: str, *, prefix: str) -> str:
    normalized = _normalize_summary_text(text, limit=88)
    if not normalized:
        return prefix
    return normalized


def _append_console_task(
    store: StateStore,
    *,
    project_id: str,
    text: str,
    kind: str,
    owner_mode: str = "planner",
    priority: int = 150,
    metadata: dict[str, object] | None = None,
) -> str:
    payload = {"brief": text, "source": "console"}
    if metadata:
        payload.update(metadata)
    return store.create_task(
        project_id=project_id,
        kind=kind,
        title=_task_title_from_text(text, prefix="Research task"),
        owner_mode=owner_mode,
        priority=priority,
        payload=payload,
    )


def _humanize_action(action: str) -> str:
    if ":" not in action:
        return action.replace("_", " ")
    label, detail = action.split(":", 1)
    if label == "awaiting_approval":
        return f"waiting for approval ({detail})"
    if label == "created_job_followups":
        return f"created {detail} job follow-up task(s)"
    if label == "running_jobs":
        return f"{detail} job(s) still running"
    if label == "normalized_owner_mode":
        _, mode = detail.rsplit(":", 1)
        return f"routed task to {mode}"
    if label == "created_followup_tasks":
        return f"queued {detail} follow-up task(s)"
    if label == "persisted_artifacts":
        return f"updated {detail} artifact record(s)"
    if label == "persisted_claims":
        return f"updated {detail} claim(s)"
    if label == "persisted_evidence":
        return f"updated {detail} evidence item(s)"
    if label == "persisted_decisions":
        return f"updated {detail} decision(s)"
    if label == "persisted_job_requests":
        return f"recorded {detail} job request(s)"
    if label == "jobs_queued":
        return f"queued {detail} managed job(s)"
    if label == "job_approvals":
        return f"opened {detail} approval(s) for requested job(s)"
    if label == "started_job":
        return f"started job {detail}"
    if label == "agent_failed":
        return f"agent run failed for task {detail}"
    return action.replace("_", " ")


def _project_snapshot_text(store: StateStore, workspace: Path) -> str:
    project = store.get_project(workspace)
    if project is None:
        return f"No project found at {workspace}"
    open_tasks = store.list_open_tasks(project.id)
    approvals = store.list_pending_approvals(project.id)
    active_jobs = store.list_active_jobs(project.id)
    recent_runs = store.list_recent_agent_runs(project.id, limit=1)
    lines = [
        f"Project: {project.name}",
        f"Status: {project.status}{' (paused)' if project.paused else ''}",
        f"Workspace: {project.workspace_root}",
    ]
    if project.codebase_root:
        lines.append(f"Codebase: {project.codebase_root}")
    lines.append(f"Open tasks: {len(open_tasks)} | Pending approvals: {len(approvals)} | Active jobs: {len(active_jobs)}")
    if open_tasks:
        next_task = open_tasks[0]
        lines.append(f"Next task: [{next_task['owner_mode']}] {next_task['title']}")
    if recent_runs:
        run = recent_runs[0]
        if run["summary"]:
            lines.append(f"Last agent summary: {_normalize_summary_text(str(run['summary']), limit=180)}")
    return "\n".join(lines)


def _render_system_panel(message: str, *, title: str = "System", style: str = "blue") -> None:
    RICH_CONSOLE.print(Panel(message, title=title, border_style=style))


def _print_project_snapshot(store: StateStore, workspace: Path) -> None:
    RICH_CONSOLE.print(Panel(_project_snapshot_text(store, workspace), title="Project Status", border_style="cyan"))


def _render_agent_reply(reply: str, *, summary: str | None = None, ready_to_start: bool = False) -> None:
    title = "Agent"
    if ready_to_start:
        title += " · ready to start"
    body = reply.strip()
    if summary:
        body = f"{body}\n\n[dim]Summary: {_normalize_summary_text(summary, limit=180)}[/dim]"
    RICH_CONSOLE.print(Panel(body, title=title, border_style="green"))


def _render_help() -> None:
    table = Table(title="Console Commands", box=None)
    table.add_column("Command", style="bold cyan")
    table.add_column("What it does")
    table.add_row("/go", "Start or resume the autonomous research loop.")
    table.add_row("/status", "Show the current project status.")
    table.add_row("/approvals", "List pending approvals.")
    table.add_row("/approve <id>", "Approve one pending approval.")
    table.add_row("/approve-all", "Approve every pending approval.")
    table.add_row("/pause", "Pause the project and stay in chat mode.")
    table.add_row("/resume", "Mark the project as resumed without starting the loop.")
    table.add_row("/quit", "Exit the console.")
    table.add_row("/help", "Show this help.")
    RICH_CONSOLE.print(table)


def _print_approvals(store: StateStore, project_id: str) -> None:
    approvals = store.list_pending_approvals(project_id)
    if not approvals:
        _render_system_panel("No pending approvals.", title="Approvals", style="green")
        return
    body = "\n".join(
        f"- {row['id']} [{row['approval_type']}] {_normalize_summary_text(str(row['reason']), limit=180)}"
        for row in approvals
    )
    _render_system_panel(body, title="Approvals", style="yellow")


def _print_new_job_logs(store: StateStore, project_id: str, job_offsets: dict[str, int]) -> None:
    jobs = store.list_jobs(project_id, statuses=("running", "succeeded", "failed", "unknown"))
    for row in jobs:
        log_path = Path(row["log_path"])
        if not log_path.exists():
            continue
        previous_offset = job_offsets.get(str(row["id"]), 0)
        with log_path.open("r", encoding="utf-8", errors="replace") as handle:
            handle.seek(previous_offset)
            chunk = handle.read()
            job_offsets[str(row["id"])] = handle.tell()
        if not chunk.strip():
            continue
        rendered = "\n".join(chunk.splitlines()[-20:])
        RICH_CONSOLE.print(Panel(rendered, title=f"Job output · {row['id']}", border_style="magenta"))


def _print_tick_report(
    store: StateStore,
    workspace: Path,
    tick_result: dict[str, object],
    *,
    job_offsets: dict[str, int],
    seen_run_ids: set[str],
) -> None:
    project = store.get_project(workspace)
    if project is None:
        _render_system_panel(f"No project found at {workspace}", title="Tick", style="red")
        return
    status = str(tick_result.get("project_status") or project.status)
    actions = [str(action) for action in tick_result.get("actions", [])]
    lines = [f"project: {project.name}", f"status: {status}"]
    if actions:
        lines.extend(f"- {_humanize_action(action)}" for action in actions)
    RICH_CONSOLE.print(Panel("\n".join(lines), title="State update", border_style="blue"))
    recent_runs = store.list_recent_agent_runs(project.id, limit=3)
    for row in reversed(recent_runs):
        run_id = str(row["id"])
        if run_id in seen_run_ids:
            continue
        seen_run_ids.add(run_id)
        summary = _normalize_summary_text(str(row["summary"] or "completed an agent step"), limit=220)
        RICH_CONSOLE.print(Panel(summary, title=f"Agent reply · {row['mode']}", border_style="green"))
    approvals = store.list_pending_approvals(project.id)
    if approvals:
        _print_approvals(store, project.id)
    active_jobs = store.list_active_jobs(project.id)
    if active_jobs:
        rows: list[str] = []
        for row in active_jobs:
            metadata = json.loads(row["metadata_json"])
            summary = _normalize_summary_text(str(metadata.get("summary") or row["command"]), limit=140)
            rows.append(f"- {row['id']} [{row['status']}] {summary}")
        RICH_CONSOLE.print(Panel("\n".join(rows), title="Jobs", border_style="magenta"))
    _print_new_job_logs(store, project.id, job_offsets)


def _ensure_console_project(workspace: Path) -> tuple[StateStore, object, bool]:
    workspace.mkdir(parents=True, exist_ok=True)
    init_workspace(workspace, workspace)
    store = ensure_initialized(workspace)
    project = store.get_project(workspace)
    created = False
    if project is None:
        name = workspace.name or "research-project"
        project = store.create_project(name, workspace, codebase_root=workspace)
        created = True
    return store, project, created


def _handle_pending_approvals_interactively(store: StateStore, workspace: Path) -> bool:
    project = store.get_project(workspace)
    if project is None:
        return False
    approvals = store.list_pending_approvals(project.id)
    if not approvals:
        return False
    _print_approvals(store, project.id)
    while True:
        choice = Prompt.ask("approval", default="wait").strip()
        if not choice:
            continue
        lowered = choice.lower()
        if lowered in {"w", "wait"}:
            return False
        if lowered in {"q", "quit"}:
            raise KeyboardInterrupt
        if lowered in {"a", "approve", "approve all"}:
            namespace = argparse.Namespace(workspace=str(workspace), note="Approved from console")
            for row in approvals:
                namespace.approval_id = row["id"]
                cmd_approval_approve(namespace)
            return True
        if lowered.startswith("r ") or lowered.startswith("reject "):
            _, _, approval_id = choice.partition(" ")
            approval_id = approval_id.strip()
            if not approval_id:
                print("Please include an approval id to reject.")
                continue
            namespace = argparse.Namespace(workspace=str(workspace), note="Rejected from console", approval_id=approval_id)
            cmd_approval_reject(namespace)
            return True
        _render_system_panel("Unknown approval command.", title="Approvals", style="red")


def _build_conversation_bundle(store: StateStore, project, workspace: Path, *, phase: str, session_id: str, new_direction: bool, user_message: str) -> dict[str, object]:
    from clawresearch.daemon.main import _runtime_capabilities, _state_snapshot

    policy = read_policy(runtime_dir(workspace) / "policy.yaml")
    history: list[dict[str, object]] = []
    for row in store.list_conversation_turns(project.id):
        metadata = json.loads(row["metadata_json"])
        if metadata.get("session_id") != session_id:
            continue
        history.append(
            {
                "role": row["role"],
                "content": row["content"],
                "metadata": metadata,
            }
        )
    history = history[-12:]
    return {
        "project": {
            "id": project.id,
            "name": project.name,
            "workspace_root": project.workspace_root,
            "codebase_root": project.codebase_root,
        },
        "conversation": {
            "phase": phase,
            "new_direction": new_direction,
            "history": history,
            "latest_user_message": user_message,
        },
        "runtime_capabilities": _runtime_capabilities(policy),
        "state_snapshot": _state_snapshot(store, project, workspace, ""),
    }


def _run_conversation_round(store: StateStore, project, workspace: Path, *, phase: str, session_id: str, new_direction: bool, user_message: str):
    from clawresearch.daemon.main import _build_agent_adapter

    policy = read_policy(runtime_dir(workspace) / "policy.yaml")
    adapter = _build_agent_adapter(policy)
    store.append_conversation_turn(
        project_id=project.id,
        phase=phase,
        role="user",
        content=user_message,
        metadata={"session_id": session_id, "new_direction": new_direction},
    )
    bundle = _build_conversation_bundle(
        store,
        project,
        workspace,
        phase=phase,
        session_id=session_id,
        new_direction=new_direction,
        user_message=user_message,
    )
    response = adapter.run_conversation(
        workspace,
        bundle,
        codebase_root=Path(project.codebase_root) if project.codebase_root else workspace,
    )
    store.append_conversation_turn(
        project_id=project.id,
        phase=phase,
        role="agent",
        content=response.reply,
        metadata={
            "session_id": session_id,
            "summary": response.summary,
            "research_brief": response.research_brief,
            "proposed_question": response.proposed_question,
            "recommended_next_step": response.recommended_next_step,
            "ready_to_start": response.ready_to_start,
            "new_direction": new_direction,
        },
    )
    return response


def _session_turns(store: StateStore, project_id: str, session_id: str) -> list[dict[str, object]]:
    selected: list[dict[str, object]] = []
    for row in store.list_conversation_turns(project_id):
        metadata = json.loads(row["metadata_json"])
        if metadata.get("session_id") != session_id:
            continue
        selected.append(
            {
                "role": row["role"],
                "content": row["content"],
                "metadata": metadata,
            }
        )
    return selected


def _materialize_session_to_runtime(
    store: StateStore,
    project,
    workspace: Path,
    *,
    session_id: str,
    new_direction: bool,
) -> bool:
    turns = _session_turns(store, project.id, session_id)
    if not turns:
        return False
    last_user = next((turn["content"] for turn in reversed(turns) if turn["role"] == "user"), "")
    last_agent = next((turn for turn in reversed(turns) if turn["role"] == "agent"), None)
    last_metadata = dict(last_agent["metadata"]) if last_agent is not None else {}
    research_brief = str(last_metadata.get("research_brief") or last_user or project.summary or "").strip()
    proposed_question = str(last_metadata.get("proposed_question") or "").strip() or None
    next_step = str(last_metadata.get("recommended_next_step") or "").strip() or None
    if not research_brief:
        return False

    ArtifactManager(workspace).write_research_question_summary(
        research_brief=research_brief,
        proposed_question=proposed_question,
        next_step=next_step,
    )
    store.update_project_summary(project.id, research_brief)

    if new_direction:
        kind = "research.reframe"
        owner_mode = "planner"
        priority = 240
    elif not store.list_recent_agent_runs(project.id, limit=1) and not store.list_open_tasks(project.id):
        kind = "research.bootstrap"
        owner_mode = "planner"
        priority = 220
    else:
        kind = "user.command"
        owner_mode = "planner"
        priority = 180

    _, created = store.ensure_task(
        project_id=project.id,
        kind=kind,
        title=_task_title_from_text(research_brief, prefix="Research direction"),
        owner_mode=owner_mode,
        priority=priority,
        payload={
            "brief": research_brief,
            "proposed_question": proposed_question,
            "recommended_next_step": next_step,
            "source": "conversation",
            "session_id": session_id,
            "new_direction": new_direction,
        },
    )
    return created


def _project_has_history(store: StateStore, project_id: str) -> bool:
    if store.list_recent_agent_runs(project_id, limit=1):
        return True
    if store.list_conversation_turns(project_id, limit=1):
        return True
    if store.list_claims(project_id) or store.list_evidence_items(project_id) or store.list_decisions(project_id):
        return True
    if store.list_jobs(project_id, limit=1):
        return True
    tasks = store.list_tasks(project_id, status=None)
    if any(str(row["kind"]) != "research.bootstrap" for row in tasks):
        return True
    if len(tasks) > 1:
        return True
    return False


def _resume_prompt(store: StateStore, workspace: Path) -> str:
    _print_project_snapshot(store, workspace)
    _render_system_panel(
        "Existing research was found in this directory.\nChoose [bold]c[/bold] to continue or [bold]n[/bold] to start a new direction in the same project.",
        title="Resume",
        style="cyan",
    )
    while True:
        choice = Prompt.ask("resume", choices=["c", "n", "q"], default="c")
        if choice in {"c", "n", "q"}:
            return choice


def _handle_chat_command(store: StateStore, workspace: Path, command: str) -> str | None:
    project = store.get_project(workspace)
    if project is None:
        return "quit"
    lowered = command.strip().lower()
    if lowered == "/help":
        _render_help()
        return None
    if lowered == "/status":
        _print_project_snapshot(store, workspace)
        return None
    if lowered == "/approvals":
        _print_approvals(store, project.id)
        return None
    if lowered == "/approve-all":
        approvals = store.list_pending_approvals(project.id)
        if not approvals:
            _render_system_panel("No pending approvals.", title="Approvals", style="green")
            return None
        try:
            for row in approvals:
                _resolve_approval_for_workspace(
                    store,
                    workspace,
                    approval_id=str(row["id"]),
                    status="approved",
                    note="Approved from console",
                )
        except RuntimeError as exc:
            _render_system_panel(str(exc), title="Approvals", style="red")
            return None
        _render_system_panel(f"Approved {len(approvals)} approval(s).", title="Approvals", style="green")
        return None
    if lowered.startswith("/approve "):
        approval_id = command.split(" ", 1)[1].strip()
        if approval_id:
            try:
                _resolve_approval_for_workspace(
                    store,
                    workspace,
                    approval_id=approval_id,
                    status="approved",
                    note="Approved from console",
                )
            except RuntimeError as exc:
                _render_system_panel(str(exc), title="Approvals", style="red")
                return None
            _render_system_panel(f"Approved {approval_id}.", title="Approvals", style="green")
        return None
    if lowered == "/pause":
        store.set_project_status(project.id, ProjectStatus.PAUSED.value, paused=True)
        _render_system_panel("Project paused.", title="Project", style="yellow")
        return None
    if lowered == "/resume":
        store.set_project_status(project.id, ProjectStatus.RESEARCHING.value, paused=False)
        _render_system_panel("Project resumed.", title="Project", style="green")
        return None
    if lowered == "/go":
        return "go"
    if lowered == "/quit":
        return "quit"
    _render_system_panel("Unknown command. Use /help for available commands.", title="Chat", style="red")
    return None


def _chat_session(
    store: StateStore,
    project,
    workspace: Path,
    *,
    phase: str,
    new_direction: bool,
) -> str:
    session_id = uuid.uuid4().hex[:12]
    if new_direction:
        store.append_conversation_turn(
            project_id=project.id,
            phase=phase,
            role="system",
            content="A new research direction is being established in this project.",
            metadata={"session_id": session_id, "new_direction": True},
        )
    while True:
        raw = Prompt.ask("[bold cyan]you[/bold cyan]")
        text = raw.strip()
        if not text:
            continue
        if text.startswith("/"):
            action = _handle_chat_command(store, workspace, text)
            if action == "quit":
                return "quit"
            if action == "go":
                materialized = _materialize_session_to_runtime(store, project, workspace, session_id=session_id, new_direction=new_direction)
                if materialized:
                    _render_system_panel("Research brief locked in. Starting the autonomous loop.", title="Run", style="green")
                else:
                    _render_system_panel("Starting the autonomous loop without a new chat brief.", title="Run", style="green")
                return "go"
            continue
        try:
            response = _run_conversation_round(
                store,
                project,
                workspace,
                phase=phase,
                session_id=session_id,
                new_direction=new_direction,
                user_message=text,
            )
        except Exception as exc:  # noqa: BLE001
            _render_system_panel(str(exc), title="Agent unavailable", style="red")
            continue
        _render_agent_reply(response.reply, summary=response.summary, ready_to_start=response.ready_to_start)
        approvals = store.list_pending_approvals(project.id)
        if approvals:
            _render_system_panel(
                f"Current blocker: {_normalize_summary_text(str(approvals[0]['reason']), limit=180)}",
                title="Blocker",
                style="yellow",
            )


def _run_loop(store: StateStore, project, workspace: Path, *, interval_seconds: int) -> str:
    from clawresearch.daemon.main import run_supervisor_tick

    job_offsets: dict[str, int] = {}
    seen_run_ids: set[str] = set(str(row["id"]) for row in store.list_recent_agent_runs(project.id, limit=50))
    RICH_CONSOLE.print(Rule("Autonomous research mode"))
    while True:
        try:
            tick_result = run_supervisor_tick(workspace)
            store = ensure_initialized(workspace)
            _print_tick_report(store, workspace, tick_result, job_offsets=job_offsets, seen_run_ids=seen_run_ids)
            project = store.get_project(workspace)
            if project is None:
                _render_system_panel("Project disappeared. Exiting.", title="Run", style="red")
                return "quit"
            if project.status == ProjectStatus.ARCHIVED_LOCAL.value:
                _render_system_panel(
                    "The agent reached a local archive state. Review the research artifacts and claims.",
                    title="Run complete",
                    style="green",
                )
                return "quit"
            if project.status == ProjectStatus.AWAITING_APPROVAL.value:
                _render_system_panel(
                    "Autonomous progress is paused because an approval is required. You can ask questions, approve work, or quit.",
                    title="Approval needed",
                    style="yellow",
                )
                return "chat"
            time.sleep(interval_seconds)
        except KeyboardInterrupt:
            _render_system_panel(
                "Autonomous mode paused. You can ask follow-up questions, inspect status, or resume with /go.",
                title="Paused",
                style="cyan",
            )
            return "chat"


def cmd_console(args: argparse.Namespace) -> int:
    workspace = Path.cwd().resolve()
    store, project, created = _ensure_console_project(workspace)

    if created:
        _render_system_panel(
            f"Started a new ClawResearch session in {workspace.name}.\nEverything in this directory is now the working research context.",
            title="ClawResearch",
            style="green",
        )
        new_direction = False
        phase = ConversationPhase.STARTUP_CHAT.value
    else:
        if _project_has_history(store, project.id):
            choice = _resume_prompt(store, workspace)
            if choice == "q":
                return 0
            new_direction = choice == "n"
            phase = ConversationPhase.STARTUP_CHAT.value if new_direction else ConversationPhase.PAUSED_CHAT.value
            if new_direction:
                _render_system_panel(
                    "Starting a new research direction in the current project. Existing evidence stays available as context.",
                    title="New direction",
                    style="green",
                )
        else:
            new_direction = False
            phase = ConversationPhase.STARTUP_CHAT.value
            _render_system_panel(
                f"Attached to {project.name} in {workspace.name}.",
                title="ClawResearch",
                style="green",
            )

    _render_system_panel(
        "Use plain language to discuss the research direction. When you are ready, type /go.\nUse /help for commands.",
        title="Chat",
        style="cyan",
    )

    while True:
        chat_result = _chat_session(store, project, workspace, phase=phase, new_direction=new_direction)
        if chat_result == "quit":
            return 0
        store = ensure_initialized(workspace)
        project = store.get_project(workspace)
        if project is None:
            return 1
        if chat_result == "go":
            store.set_project_status(project.id, ProjectStatus.RESEARCHING.value, paused=False)
            run_result = _run_loop(store, project, workspace, interval_seconds=args.interval_seconds)
            if run_result == "quit":
                return 0
            phase = ConversationPhase.PAUSED_CHAT.value
            new_direction = False


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
    subparsers = parser.add_subparsers(dest="command")

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

    console_parser = subparsers.add_parser("console", help="Interactive research console in the current directory")
    console_parser.add_argument("--interval-seconds", type=int, default=30, help="Supervisor tick interval during autonomous mode")
    console_parser.set_defaults(func=cmd_console)

    return parser


def main(argv: list[str] | None = None) -> int:
    args_list = list(sys.argv[1:] if argv is None else argv)
    if not args_list:
        return int(cmd_console(argparse.Namespace(interval_seconds=30)))
    parser = build_parser()
    args = parser.parse_args(args_list)
    if not hasattr(args, "func"):
        return int(cmd_console(argparse.Namespace(interval_seconds=30)))
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
