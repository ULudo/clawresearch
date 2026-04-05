from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from clawresearch.artifacts.manager import REQUIRED_ARTIFACTS
from clawresearch.cli.main import ensure_initialized, init_workspace, runtime_dir
from clawresearch.policy.io import read_policy
from clawresearch.state.models import ProjectRecord, ProjectStatus
from clawresearch.state.store import StateStore


@dataclass(slots=True)
class ResolvedProject:
    workspace: Path
    store: StateStore
    project: ProjectRecord


class ApiError(RuntimeError):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class ApiService:
    def __init__(self, *, default_workspace: Path | None = None, projects_root: Path | None = None) -> None:
        self.default_workspace = default_workspace.resolve() if default_workspace else None
        self.projects_root = projects_root.resolve() if projects_root else None

    def list_projects(self) -> list[dict[str, Any]]:
        projects: list[dict[str, Any]] = []
        for workspace in self._discover_workspaces():
            resolved = self._resolve_project(workspace=workspace)
            projects.append(self._project_card(resolved))
        return sorted(projects, key=lambda item: item["name"].lower())

    def create_project(self, *, name: str, path: str | None, codebase_root: str | None, initial_prompt: str | None) -> dict[str, Any]:
        if not name.strip():
            raise ApiError(400, "Project name is required.")

        if path:
            target = Path(path).expanduser().resolve() / name
        elif self.projects_root is not None:
            target = self.projects_root / name
        else:
            target = Path(name).expanduser().resolve()

        target.mkdir(parents=True, exist_ok=True)
        codebase_path = Path(codebase_root).expanduser().resolve() if codebase_root else None
        if codebase_path is not None and not codebase_path.is_dir():
            raise ApiError(400, f"Codebase root is not a directory: {codebase_path}")

        init_workspace(target, codebase_path)
        store = ensure_initialized(target)
        project = store.get_project(target)
        if project is None:
            project = store.create_project(name, target, codebase_root=codebase_path)
            bootstrap_brief = initial_prompt or "Initialize the research question, literature map, first plan, and current blocker."
            store.create_task(
                project_id=project.id,
                kind="research.bootstrap",
                title="Initialize research question, literature map, and first plan",
                owner_mode="planner",
                priority=120,
                payload={"brief": bootstrap_brief},
            )
        elif initial_prompt:
            store.create_task(
                project_id=project.id,
                kind="user.command",
                title=self._command_title(initial_prompt),
                owner_mode="planner",
                priority=120,
                payload={"brief": initial_prompt},
            )

        return self._project_card(ResolvedProject(workspace=target, store=store, project=project))

    def get_project(self, project_id: str | None = None, *, workspace: str | None = None) -> dict[str, Any]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        return self._project_card(resolved)

    def pause_project(self, project_id: str | None = None, *, workspace: str | None = None) -> dict[str, Any]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        resolved.store.set_project_status(resolved.project.id, ProjectStatus.PAUSED.value, paused=True)
        return self.get_project(project_id=resolved.project.id, workspace=str(resolved.workspace))

    def resume_project(self, project_id: str | None = None, *, workspace: str | None = None) -> dict[str, Any]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        resolved.store.set_project_status(resolved.project.id, ProjectStatus.RESEARCHING.value, paused=False)
        return self.get_project(project_id=resolved.project.id, workspace=str(resolved.workspace))

    def get_project_status(self, project_id: str | None = None, *, workspace: str | None = None) -> dict[str, Any]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        project = resolved.project
        store = resolved.store
        approvals = store.list_pending_approvals(project.id)
        active_jobs = store.list_active_jobs(project.id)
        open_tasks = store.list_open_tasks(project.id)
        policy = read_policy(runtime_dir(resolved.workspace) / "policy.yaml")
        return {
            "project": self._project_card(resolved),
            "counts": {
                "open_tasks": len(open_tasks),
                "pending_approvals": len(approvals),
                "active_jobs": len(active_jobs),
            },
            "policy": policy.to_dict(),
        }

    def get_project_overview(self, project_id: str | None = None, *, workspace: str | None = None) -> dict[str, Any]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        project = resolved.project
        store = resolved.store
        open_tasks = store.list_open_tasks(project.id)
        approvals = store.list_pending_approvals(project.id)
        jobs = store.list_jobs(project.id, statuses=("pending", "running", "failed", "succeeded"), limit=6)
        claims = store.list_claims(project.id)
        evidence = store.list_evidence_items(project.id)
        decisions = store.list_decisions(project.id)
        recent_runs = store.list_recent_agent_runs(project.id, limit=3)
        artifacts = self.list_artifacts(project.id, workspace=str(resolved.workspace))

        blocker = self._current_blocker(approvals, decisions)
        next_action = self._next_recommended_action(open_tasks, approvals, jobs)
        publication = self._publication_summary(decisions, artifacts)
        mission = self._mission_text(resolved.workspace, open_tasks)

        return {
            "project": self._project_card(resolved),
            "mission": mission,
            "hero_summary": self._hero_summary(project, mission, blocker, next_action),
            "current_blocker": blocker,
            "next_recommended_action": next_action,
            "publication_readiness": publication,
            "latest_findings": {
                "claims": [self._claim_payload(row) for row in claims[:3]],
                "evidence": [self._evidence_payload(row) for row in evidence[:3]],
                "decisions": [self._decision_payload(row) for row in decisions[:3]],
            },
            "active_jobs": [self._job_payload(row) for row in jobs if row["status"] in {"pending", "running"}],
            "open_approvals": [self._approval_payload(row) for row in approvals[:3]],
            "recent_agent_runs": [self._agent_run_payload(row) for row in recent_runs],
            "counts": {
                "open_tasks": len(open_tasks),
                "pending_approvals": len(approvals),
                "active_jobs": len([job for job in jobs if job["status"] in {"pending", "running"}]),
            },
        }

    def get_activity(self, project_id: str | None = None, *, workspace: str | None = None, limit: int = 50) -> dict[str, Any]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        events = resolved.store.list_recent_events(resolved.project.id, limit=limit)
        items = []
        for row in events:
            payload = json.loads(row["payload_json"])
            items.append(
                {
                    "id": row["id"],
                    "timestamp": row["timestamp"],
                    "entity_type": row["entity_type"],
                    "entity_id": row["entity_id"],
                    "event_type": row["event_type"],
                    "summary": self._event_summary(row["event_type"], payload),
                    "payload": payload,
                }
            )
        return {"items": items}

    def list_tasks(self, project_id: str | None = None, *, workspace: str | None = None, include_closed: bool = False) -> list[dict[str, Any]]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        status = None if include_closed else "open"
        return [self._task_payload(row) for row in resolved.store.list_tasks(resolved.project.id, status=status)]

    def create_task(
        self,
        project_id: str | None = None,
        *,
        workspace: str | None = None,
        title: str,
        kind: str = "research.followup",
        owner_mode: str = "planner",
        priority: int = 100,
        brief: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        merged_payload = dict(payload or {})
        if brief:
            merged_payload["brief"] = brief
        task_id = resolved.store.create_task(
            project_id=resolved.project.id,
            kind=kind,
            title=title,
            owner_mode=owner_mode,
            priority=priority,
            payload=merged_payload,
        )
        return {"task_id": task_id, "project_id": resolved.project.id}

    def list_approvals(self, project_id: str | None = None, *, workspace: str | None = None) -> list[dict[str, Any]]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        return [self._approval_payload(row) for row in resolved.store.list_pending_approvals(resolved.project.id)]

    def resolve_approval(self, approval_id: str, *, workspace: str | None = None, action: str, note: str | None = None) -> dict[str, Any]:
        resolved = self._resolve_project(workspace=Path(workspace).expanduser().resolve() if workspace else None)
        approval = resolved.store.get_approval(approval_id)
        if approval is None or approval["project_id"] != resolved.project.id:
            raise ApiError(404, f"Approval not found: {approval_id}")
        if approval["status"] != "pending":
            raise ApiError(409, f"Approval is not pending: {approval_id}")

        from clawresearch.cli.main import _queue_job_from_approval  # local reuse to keep queue semantics aligned

        status = "approved" if action == "approve" else "rejected"
        payload: dict[str, Any] = {}
        if note:
            payload["note"] = note
        created_job_id = None
        if status == "approved" and approval["approval_type"] in {"gpu_budget_threshold", "job_path_outside_policy"}:
            created_job_id = _queue_job_from_approval(resolved.store, resolved.workspace, resolved.project.id, approval)
            payload["created_job_id"] = created_job_id
        resolved.store.resolve_approval(approval_id, status=status, payload=payload)
        resolved.store.set_project_status(resolved.project.id, ProjectStatus.RESEARCHING.value, paused=False)
        return {"approval_id": approval_id, "status": status, "created_job_id": created_job_id}

    def list_jobs(self, project_id: str | None = None, *, workspace: str | None = None, include_all: bool = True) -> list[dict[str, Any]]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        statuses = None if include_all else ("pending", "running")
        return [self._job_payload(row) for row in resolved.store.list_jobs(resolved.project.id, statuses=statuses)]

    def get_job(self, job_id: str, *, workspace: str | None = None) -> dict[str, Any]:
        resolved = self._resolve_project(workspace=Path(workspace).expanduser().resolve() if workspace else None)
        row = resolved.store.get_job(job_id)
        if row is None or row["project_id"] != resolved.project.id:
            raise ApiError(404, f"Job not found: {job_id}")
        payload = self._job_payload(row)
        log_path = Path(row["log_path"])
        payload["logs"] = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        payload["env_snapshot"] = json.loads(row["env_snapshot_json"])
        payload["metadata"] = json.loads(row["metadata_json"])
        return payload

    def get_job_logs(self, job_id: str, *, workspace: str | None = None) -> dict[str, Any]:
        job = self.get_job(job_id, workspace=workspace)
        return {"job_id": job_id, "logs": job.get("logs", "")}

    def list_claims(self, project_id: str | None = None, *, workspace: str | None = None) -> list[dict[str, Any]]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        return [self._claim_payload(row) for row in resolved.store.list_claims(resolved.project.id)]

    def list_evidence(self, project_id: str | None = None, *, workspace: str | None = None) -> list[dict[str, Any]]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        return [self._evidence_payload(row) for row in resolved.store.list_evidence_items(resolved.project.id)]

    def list_decisions(self, project_id: str | None = None, *, workspace: str | None = None) -> list[dict[str, Any]]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        return [self._decision_payload(row) for row in resolved.store.list_decisions(resolved.project.id)]

    def list_artifacts(self, project_id: str | None = None, *, workspace: str | None = None) -> list[dict[str, Any]]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        rows = []
        for row in resolved.store.list_artifacts(resolved.project.id):
            rows.append(self._artifact_payload(row))
        research_dir = resolved.workspace / "research"
        for name in sorted(REQUIRED_ARTIFACTS):
            path = research_dir / name
            if path.exists() and not any(Path(item["path"]) == path for item in rows):
                rows.append(
                    {
                        "id": f"research_{name}",
                        "artifact_type": "research_markdown",
                        "name": name,
                        "path": str(path),
                        "exists": True,
                        "metadata": {},
                    }
                )
        return rows

    def get_artifact(self, artifact_id: str, *, workspace: str | None = None) -> dict[str, Any]:
        resolved = self._resolve_project(workspace=Path(workspace).expanduser().resolve() if workspace else None)
        if artifact_id.startswith("research_"):
            name = artifact_id.removeprefix("research_")
            path = resolved.workspace / "research" / name
            if not path.exists():
                raise ApiError(404, f"Artifact not found: {artifact_id}")
            return {
                "id": artifact_id,
                "artifact_type": "research_markdown",
                "name": name,
                "path": str(path),
                "content": path.read_text(encoding="utf-8", errors="replace"),
                "metadata": {},
            }
        row = resolved.store.get_artifact(artifact_id)
        if row is None or row["project_id"] != resolved.project.id:
            raise ApiError(404, f"Artifact not found: {artifact_id}")
        path = Path(row["path"])
        return {
            **self._artifact_payload(row),
            "content": path.read_text(encoding="utf-8", errors="replace") if path.exists() and path.is_file() else None,
        }

    def submit_command(self, project_id: str | None = None, *, workspace: str | None = None, text: str) -> dict[str, Any]:
        resolved = self._resolve_project(project_id=project_id, workspace=Path(workspace).expanduser().resolve() if workspace else None)
        normalized = text.strip()
        if not normalized:
            raise ApiError(400, "Command text is required.")

        lowered = normalized.lower()
        if lowered in {"pause", "pause project", "pause research"}:
            resolved.store.set_project_status(resolved.project.id, ProjectStatus.PAUSED.value, paused=True)
            return {"action": "project_paused", "project_id": resolved.project.id}
        if lowered in {"resume", "continue", "resume project", "resume research", "continue research"}:
            resolved.store.set_project_status(resolved.project.id, ProjectStatus.RESEARCHING.value, paused=False)
            task_id = resolved.store.create_task(
                project_id=resolved.project.id,
                kind="user.command",
                title="Continue autonomous research with current priorities",
                owner_mode="planner",
                priority=140,
                payload={"brief": normalized},
            )
            return {"action": "project_resumed", "task_id": task_id, "project_id": resolved.project.id}

        task_id = resolved.store.create_task(
            project_id=resolved.project.id,
            kind="user.command",
            title=self._command_title(normalized),
            owner_mode="planner",
            priority=130,
            payload={"brief": normalized},
        )
        return {"action": "task_created", "task_id": task_id, "project_id": resolved.project.id}

    def _discover_workspaces(self) -> list[Path]:
        workspaces: list[Path] = []
        seen: set[str] = set()
        candidates: list[Path] = []
        if self.default_workspace is not None:
            candidates.append(self.default_workspace)
        if self.projects_root is not None and self.projects_root.exists():
            candidates.extend(path for path in sorted(self.projects_root.iterdir()) if path.is_dir())
            candidates.append(self.projects_root)
        for candidate in candidates:
            marker = runtime_dir(candidate) / "state.db"
            if marker.exists():
                resolved = str(candidate.resolve())
                if resolved not in seen:
                    seen.add(resolved)
                    workspaces.append(candidate.resolve())
        return workspaces

    def _resolve_project(self, project_id: str | None = None, *, workspace: Path | None = None) -> ResolvedProject:
        if workspace is not None:
            store = ensure_initialized(workspace)
            project = store.get_project(workspace)
            if project is None:
                raise ApiError(404, f"No project found at {workspace}")
            if project_id is not None and project.id != project_id:
                raise ApiError(404, f"Project not found: {project_id}")
            return ResolvedProject(workspace=workspace, store=store, project=project)

        if self.default_workspace is not None:
            store = ensure_initialized(self.default_workspace)
            project = store.get_project(self.default_workspace)
            if project is None:
                raise ApiError(404, f"No project found at {self.default_workspace}")
            if project_id is None or project.id == project_id:
                return ResolvedProject(workspace=self.default_workspace, store=store, project=project)

        for candidate in self._discover_workspaces():
            store = ensure_initialized(candidate)
            project = store.get_project(candidate)
            if project is None:
                continue
            if project_id is None or project.id == project_id:
                return ResolvedProject(workspace=candidate, store=store, project=project)

        if project_id is not None:
            raise ApiError(404, f"Project not found: {project_id}")
        raise ApiError(400, "No project workspace configured for API access.")

    def _project_card(self, resolved: ResolvedProject) -> dict[str, Any]:
        project = resolved.project
        store = resolved.store
        approvals = store.list_pending_approvals(project.id)
        active_jobs = store.list_active_jobs(project.id)
        return {
            "id": project.id,
            "name": project.name,
            "status": project.status,
            "paused": project.paused,
            "summary": project.summary,
            "workspace_root": project.workspace_root,
            "codebase_root": project.codebase_root,
            "counts": {
                "open_tasks": len(store.list_open_tasks(project.id)),
                "pending_approvals": len(approvals),
                "active_jobs": len(active_jobs),
                "claims": len(store.list_claims(project.id)),
                "evidence": len(store.list_evidence_items(project.id)),
                "decisions": len(store.list_decisions(project.id)),
            },
        }

    def _mission_text(self, workspace: Path, open_tasks: list[Any]) -> str:
        research_question = workspace / "research" / "research-question.md"
        if research_question.exists():
            text = research_question.read_text(encoding="utf-8", errors="replace").strip()
            if text:
                lines = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]
                if lines:
                    return lines[0]
        if open_tasks:
            top = open_tasks[0]
            payload = json.loads(top["payload_json"])
            brief = str(payload.get("brief") or "").strip()
            return brief or str(top["title"])
        return "Research mission initialized."

    def _current_blocker(self, approvals: list[Any], decisions: list[Any]) -> dict[str, Any] | None:
        if approvals:
            approval = approvals[0]
            return {
                "type": "approval",
                "title": "Approval required",
                "summary": approval["reason"],
                "status": approval["status"],
                "approval_id": approval["id"],
            }
        blocking_decisions = [row for row in decisions if bool(row["blocking"]) or row["status"] in {"blocked", "rejected"}]
        if blocking_decisions:
            row = blocking_decisions[0]
            return {
                "type": "decision",
                "title": row["summary"],
                "summary": row["rationale"],
                "status": row["status"],
                "decision_id": row["id"],
            }
        return None

    def _next_recommended_action(self, open_tasks: list[Any], approvals: list[Any], jobs: list[Any]) -> dict[str, Any] | None:
        if approvals:
            approval = approvals[0]
            return {
                "type": "approval",
                "title": "Review pending approval",
                "summary": approval["reason"],
                "action": "approve_or_reject",
            }
        running = [row for row in jobs if row["status"] == "running"]
        if running:
            row = running[0]
            metadata = json.loads(row["metadata_json"])
            return {
                "type": "job",
                "title": metadata.get("summary") or row["command"],
                "summary": "Wait for the running job to finish and then review the resulting evidence.",
                "action": "monitor_job",
            }
        if open_tasks:
            row = open_tasks[0]
            payload = json.loads(row["payload_json"])
            return {
                "type": "task",
                "title": row["title"],
                "summary": payload.get("brief") or row["kind"],
                "action": "run_supervisor",
            }
        return {
            "type": "idle",
            "title": "No immediate action required",
            "summary": "The workspace is currently waiting for new instructions or results.",
            "action": "standby",
        }

    def _publication_summary(self, decisions: list[Any], artifacts: list[dict[str, Any]]) -> dict[str, Any]:
        manuscript_present = any(item["name"] == "manuscript.md" or Path(item["path"]).name == "manuscript.md" for item in artifacts)
        self_review_present = any(item["name"] == "self-review.md" or Path(item["path"]).name == "self-review.md" for item in artifacts)
        blockers = [self._decision_payload(row) for row in decisions if bool(row["blocking"]) or "public" in row["decision_type"]]
        recommended = "continue_research"
        summary = "Research should continue before publication."
        if manuscript_present and self_review_present and not blockers:
            recommended = "prepare_submission"
            summary = "Core publication artifacts exist and no blocking publication decision is present."
        elif manuscript_present:
            recommended = "complete_self_review"
            summary = "A manuscript exists, but publication readiness is still incomplete."
        return {
            "recommended_action": recommended,
            "summary": summary,
            "manuscript_present": manuscript_present,
            "self_review_present": self_review_present,
            "blockers": blockers[:3],
        }

    def _hero_summary(self, project: ProjectRecord, mission: str, blocker: dict[str, Any] | None, next_action: dict[str, Any] | None) -> str:
        parts = [f"{project.name} is working on: {mission}"]
        if blocker:
            parts.append(f"Current blocker: {blocker['summary']}")
        if next_action:
            parts.append(f"Next action: {next_action['title']}")
        return " ".join(parts)

    def _event_summary(self, event_type: str, payload: dict[str, Any]) -> str:
        if event_type == "task.created":
            return f"Task created: {payload.get('title') or payload.get('kind')}."
        if event_type == "approval.created":
            return f"Approval required: {payload.get('reason')}"
        if event_type == "approval.resolved":
            return f"Approval resolved as {payload.get('status')}."
        if event_type == "job.created":
            return f"Job queued: {payload.get('command')}"
        if event_type == "job.started":
            return f"Job started: {payload.get('command') or payload.get('job_id')}"
        if event_type == "job.finished":
            return f"Job finished with status {payload.get('status')}."
        if event_type == "decision.upserted":
            return f"Decision updated: {payload.get('summary')}"
        if event_type == "claim.upserted":
            return f"Claim updated: {payload.get('text')}"
        if event_type == "evidence.upserted":
            return f"Evidence recorded: {payload.get('title')}"
        if event_type == "artifact.upserted":
            return f"Artifact updated: {payload.get('path')}"
        return event_type.replace(".", " ")

    def _task_payload(self, row) -> dict[str, Any]:
        payload = json.loads(row["payload_json"])
        return {
            "id": row["id"],
            "kind": row["kind"],
            "title": row["title"],
            "status": row["status"],
            "priority": row["priority"],
            "owner_mode": row["owner_mode"],
            "brief": payload.get("brief"),
            "payload": payload,
        }

    def _approval_payload(self, row) -> dict[str, Any]:
        payload = json.loads(row["requested_payload_json"])
        job_request = payload.get("job_request") if isinstance(payload, dict) else None
        metadata = dict(job_request.get("metadata") or {}) if isinstance(job_request, dict) else {}
        return {
            "id": row["id"],
            "approval_type": row["approval_type"],
            "status": row["status"],
            "reason": row["reason"],
            "summary": metadata.get("summary") or (job_request or {}).get("summary") or row["reason"],
            "scientific_rationale": metadata.get("reason") or (job_request or {}).get("rationale"),
            "estimated_gpu_hours": metadata.get("estimated_gpu_hours"),
            "expected_artifacts": metadata.get("expected_artifacts") or [],
            "requested_payload": payload,
            "created_at": row["created_at"],
        }

    def _job_payload(self, row) -> dict[str, Any]:
        metadata = json.loads(row["metadata_json"])
        return {
            "id": row["id"],
            "kind": row["kind"],
            "status": row["status"],
            "summary": metadata.get("summary") or row["command"],
            "command": row["command"],
            "cwd": row["cwd"],
            "pid": row["pid"],
            "exit_code": row["exit_code"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "log_path": row["log_path"],
            "uses_gpu": bool(metadata.get("uses_gpu")),
            "estimated_gpu_hours": metadata.get("estimated_gpu_hours"),
            "expected_artifacts": metadata.get("expected_artifacts") or [],
        }

    def _claim_payload(self, row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "status": row["status"],
            "claim_type": row["claim_type"],
            "scope": row["scope"],
            "text": row["text"],
        }

    def _evidence_payload(self, row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "source_type": row["source_type"],
            "strength": row["strength"],
            "title": row["title"],
            "conclusion_impact": row["conclusion_impact"],
            "summary": row["summary"],
            "reproducibility": json.loads(row["reproducibility_json"]),
        }

    def _decision_payload(self, row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "decision_type": row["decision_type"],
            "status": row["status"],
            "blocking": bool(row["blocking"]),
            "summary": row["summary"],
            "rationale": row["rationale"],
        }

    def _artifact_payload(self, row) -> dict[str, Any]:
        path = Path(row["path"])
        return {
            "id": row["id"],
            "artifact_type": row["artifact_type"],
            "name": path.name,
            "path": row["path"],
            "checksum": row["checksum"],
            "exists": path.exists(),
            "metadata": json.loads(row["metadata_json"]),
        }

    def _agent_run_payload(self, row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "mode": row["mode"],
            "status": row["status"],
            "adapter_name": row["adapter_name"],
            "summary": row["summary"],
            "confidence": row["confidence"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
        }

    def _command_title(self, text: str) -> str:
        collapsed = " ".join(text.split())
        if len(collapsed) <= 72:
            return collapsed
        return collapsed[:69].rstrip() + "..."
