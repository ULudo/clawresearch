from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

from clawresearch.artifacts.manager import ArtifactManager
from clawresearch.cli.main import ensure_initialized, runtime_dir
from clawresearch.integrations.agents.local_shell import LocalShellAgentAdapter
from clawresearch.integrations.agents.openai_compatible import adapter_from_env as openai_adapter_from_env
from clawresearch.jobs.runner import JobRunner
from clawresearch.policy.io import read_policy
from clawresearch.recovery.reconcile import reconcile_workspace
from clawresearch.scheduler.resources import ResourceManager
from clawresearch.state.models import AgentMode, ProjectStatus


def _normalize_owner_mode(kind: str, owner_mode: str | None, title: str, brief: str = "") -> str:
    normalized_owner_mode = (owner_mode or "").strip().lower()
    normalized_kind = (kind or "").strip().lower()
    text = " ".join(part for part in [normalized_kind, title, brief] if part).lower()

    if "experiment" in normalized_kind:
        return AgentMode.EXPERIMENTER.value
    if any(token in normalized_kind for token in ["validation", "analysis"]):
        return AgentMode.ANALYST.value
    if "audit" in normalized_kind or "literature" in normalized_kind:
        return AgentMode.SCOUT.value
    if "review" in normalized_kind:
        return AgentMode.REVIEWER.value
    if any(token in normalized_kind for token in ["manuscript", "write"]):
        return AgentMode.WRITER.value
    if any(token in normalized_kind for token in ["research.question", "research.plan", "research.bootstrap"]):
        return AgentMode.PLANNER.value

    if normalized_owner_mode and normalized_owner_mode != AgentMode.PLANNER.value:
        return normalized_owner_mode

    if any(token in text for token in ["manuscript", "paper draft", "write", "abstract", "conclusion"]):
        return AgentMode.WRITER.value
    if any(token in text for token in ["review", "self-review", "critique", "red flag"]):
        return AgentMode.REVIEWER.value
    if any(token in text for token in ["validation", "analy", "statistic", "ablation", "regime-stratified"]):
        return AgentMode.ANALYST.value
    if any(token in text for token in ["experiment", "benchmark", "run ", "seed budget", "warm-start"]):
        return AgentMode.EXPERIMENTER.value
    if any(token in text for token in ["audit", "literature", "related work", "evidence", "code/"]):
        return AgentMode.SCOUT.value
    return AgentMode.PLANNER.value


def _enqueue_next_actions(store, project_id: str, actions: list[dict[str, object]]) -> list[str]:
    created: list[str] = []
    for action in actions:
        if not isinstance(action, dict):
            continue
        title = str(action.get("title") or action.get("summary") or action.get("description") or "").strip()
        if not title:
            continue
        payload: dict[str, object] = {}
        brief = str(action.get("brief") or "").strip()
        if brief:
            payload["brief"] = brief
        raw_payload = action.get("payload")
        if isinstance(raw_payload, dict):
            payload.update(raw_payload)
        owner_mode = _normalize_owner_mode(
            str(action.get("kind") or "research.followup"),
            str(action.get("owner_mode") or ""),
            title,
            brief,
        )
        task_id, created_now = store.ensure_task(
            project_id=project_id,
            kind=str(action.get("kind") or "research.followup"),
            title=title,
            owner_mode=owner_mode,
            priority=int(action.get("priority") or 100),
            payload=payload,
        )
        if created_now:
            created.append(task_id)
    return created


def _stable_item_id(prefix: str, item: dict[str, object], *fallback_parts: str) -> str:
    explicit = str(item.get("entity_id") or "").strip()
    if explicit:
        return explicit
    seed = "||".join([prefix, *fallback_parts, json.dumps(item, sort_keys=True, default=str)])
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def _persist_structured_output(store, project_id: str, result) -> dict[str, int]:
    counts = {"artifacts": 0, "claims": 0, "evidence": 0, "decisions": 0, "job_requests": 0}

    for item in [*result.entities_created_or_updated, *result.artifacts_to_create_or_update]:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        if path:
            artifact_id = _stable_item_id(
                "artifact",
                item,
                str(item.get("kind") or ""),
                path,
                str(item.get("summary") or ""),
            )
            store.upsert_artifact(
                project_id=project_id,
                artifact_id=artifact_id,
                artifact_type=str(item.get("kind") or item.get("entity_type") or "artifact"),
                path=path,
                checksum=str(item.get("checksum") or "").strip() or None,
                metadata=item,
            )
            counts["artifacts"] += 1
            continue
        store.append_event(
            project_id=project_id,
            entity_type=str(item.get("entity_type") or "entity"),
            entity_id=_stable_item_id("entity", item, str(item.get("summary") or "")),
            event_type="entity.reported",
            payload=item,
        )

    for item in result.claims_updated:
        if not isinstance(item, dict):
            continue
        claim_id = _stable_item_id("claim", item, str(item.get("summary") or ""))
        store.upsert_claim(
            project_id=project_id,
            claim_id=claim_id,
            text=str(item.get("summary") or "").strip() or "(untitled claim)",
            scope=str(item.get("scope") or "").strip() or None,
            claim_type=str(item.get("kind") or item.get("entity_type") or "claim"),
            status=str(item.get("status") or "open"),
            metadata=item,
        )
        if item.get("path"):
            store.upsert_artifact(
                project_id=project_id,
                artifact_id=_stable_item_id("artifact", item, str(item.get("path") or "")),
                artifact_type="claim_source",
                path=str(item["path"]),
                metadata=item,
            )
            counts["artifacts"] += 1
        counts["claims"] += 1

    for item in result.evidence_updates:
        if not isinstance(item, dict):
            continue
        evidence_id = _stable_item_id("evidence", item, str(item.get("summary") or ""))
        reproducibility = {
            "path": item.get("path"),
            "status": item.get("status"),
            "command": item.get("command"),
            "cwd": item.get("cwd"),
            "source": item.get("source"),
            "strength": item.get("strength"),
        }
        store.upsert_evidence_item(
            project_id=project_id,
            evidence_item_id=evidence_id,
            source_type=str(item.get("source") or item.get("entity_type") or "evidence"),
            title=str(item.get("summary") or "").strip() or "(untitled evidence)",
            strength=str(item.get("strength") or "unknown"),
            reproducibility=reproducibility,
            conclusion_impact=str(item.get("decision_type") or item.get("status") or "").strip() or None,
            summary=str(item.get("rationale") or "").strip() or None,
            metadata=item,
        )
        if item.get("path"):
            store.upsert_artifact(
                project_id=project_id,
                artifact_id=_stable_item_id("artifact", item, str(item.get("path") or "")),
                artifact_type="evidence_source",
                path=str(item["path"]),
                metadata=item,
            )
            counts["artifacts"] += 1
        counts["evidence"] += 1

    for item in result.decisions_proposed:
        if not isinstance(item, dict):
            continue
        decision_id = _stable_item_id("decision", item, str(item.get("summary") or ""))
        store.upsert_decision(
            project_id=project_id,
            decision_id=decision_id,
            decision_type=str(item.get("decision_type") or item.get("kind") or "decision"),
            status=str(item.get("status") or "proposed"),
            summary=str(item.get("summary") or "").strip() or "(untitled decision)",
            rationale=str(item.get("rationale") or item.get("source") or "").strip() or "(no rationale provided)",
            blocking=bool(item.get("blocking")),
            evidence=item,
        )
        counts["decisions"] += 1

    for item in result.jobs_to_start:
        if not isinstance(item, dict):
            continue
        store.append_event(
            project_id=project_id,
            entity_type="job_request",
            entity_id=_stable_item_id("job_request", item, str(item.get("summary") or item.get("command") or "")),
            event_type="job.requested",
            payload=item,
        )
        counts["job_requests"] += 1

    return counts


def _runtime_capabilities(policy) -> dict[str, object]:
    adapter_name = str(policy.agent_adapter.name or "local_shell")
    return {
        "adapter": adapter_name,
        "supports_structured_output": True,
        "supports_web_search": False,
        "supports_shell_access": adapter_name == "local_shell",
        "supports_codebase_writes": False,
        "supports_job_execution": True,
    }


def _artifact_excerpt(path: Path, *, max_chars: int = 700) -> str:
    if not path.exists():
        return "(missing)"
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "\n..."


def _task_keywords(title: str, brief: str) -> list[str]:
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9_+.-]{2,}", f"{title} {brief}")
    stopwords = {
        "the",
        "and",
        "for",
        "with",
        "that",
        "this",
        "from",
        "into",
        "under",
        "same",
        "only",
        "work",
        "task",
        "research",
        "baseline",
        "compare",
        "against",
        "contract",
        "contracts",
    }
    seen: set[str] = set()
    ordered: list[str] = []
    for token in tokens:
        lowered = token.lower()
        if lowered in stopwords or lowered in seen:
            continue
        seen.add(lowered)
        ordered.append(token)
    return ordered[:8]


def _search_codebase_context(codebase_root: Path, *, title: str, brief: str, evidence_paths: list[str]) -> list[dict[str, str]]:
    if not codebase_root.exists():
        return []

    contexts: list[dict[str, str]] = []
    seen_paths: set[str] = set()

    def add_path(path: Path, reason: str) -> None:
        resolved = path.resolve()
        if not resolved.exists() or not resolved.is_file():
            return
        resolved_text = str(resolved)
        if resolved_text in seen_paths:
            return
        seen_paths.add(resolved_text)
        contexts.append({"path": resolved_text, "reason": reason, "excerpt": _artifact_excerpt(resolved, max_chars=900)})

    for evidence_path in evidence_paths:
        path = Path(evidence_path)
        try:
            resolved = path.resolve()
        except FileNotFoundError:
            continue
        if resolved.exists() and resolved.is_file() and (resolved == codebase_root.resolve() or codebase_root.resolve() in resolved.parents):
            add_path(resolved, "existing_evidence")
        if len(contexts) >= 6:
            return contexts

    try:
        path_search = subprocess.run(
            ["rg", "--files", codebase_root],
            capture_output=True,
            text=True,
            check=False,
        )
        all_files = [Path(line) for line in path_search.stdout.splitlines() if line.strip()]
    except FileNotFoundError:
        all_files = []

    if not all_files:
        for root, dirs, files in os.walk(codebase_root):
            dirs[:] = [name for name in dirs if name not in {".git", "__pycache__"}]
            for filename in files:
                path = Path(root) / filename
                all_files.append(path)

    keywords = _task_keywords(title, brief)
    for keyword in keywords:
        for candidate in all_files:
            if keyword.lower() in candidate.name.lower():
                add_path(candidate, f"filename_match:{keyword}")
                if len(contexts) >= 6:
                    return contexts

        matched = 0
        for candidate in all_files:
            if not candidate.exists() or not candidate.is_file():
                continue
            try:
                text = candidate.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if keyword.lower() in text.lower():
                add_path(candidate, f"content_match:{keyword}")
                matched += 1
                if len(contexts) >= 6:
                    return contexts
                if matched >= 3:
                    break

    return contexts


def _state_snapshot(store, project, workspace: Path, current_task_id: str) -> dict[str, object]:
    current_task = next((row for row in store.list_tasks(project.id, status="open") if row["id"] == current_task_id), None)
    current_brief = ""
    current_title = ""
    if current_task is not None:
        current_title = str(current_task["title"] or "")
        current_brief = str(json.loads(current_task["payload_json"]).get("brief") or "")
    open_tasks = []
    for row in store.list_open_tasks(project.id):
        if row["id"] == current_task_id:
            continue
        open_tasks.append(
            {
                "id": row["id"],
                "kind": row["kind"],
                "title": row["title"],
                "owner_mode": row["owner_mode"],
                "priority": row["priority"],
                "brief": json.loads(row["payload_json"]).get("brief"),
            }
        )
        if len(open_tasks) >= 8:
            break

    claims = [
        {
            "id": row["id"],
            "status": row["status"],
            "claim_type": row["claim_type"],
            "scope": row["scope"],
            "text": row["text"],
        }
        for row in store.list_claims(project.id)[:8]
    ]
    evidence = [
        {
            "id": row["id"],
            "source_type": row["source_type"],
            "strength": row["strength"],
            "title": row["title"],
            "summary": row["summary"],
            "conclusion_impact": row["conclusion_impact"],
        }
        for row in store.list_evidence_items(project.id)[:8]
    ]
    decisions = [
        {
            "id": row["id"],
            "decision_type": row["decision_type"],
            "status": row["status"],
            "blocking": bool(row["blocking"]),
            "summary": row["summary"],
            "rationale": row["rationale"],
        }
        for row in store.list_decisions(project.id)[:6]
    ]
    recent_events = [
        {
            "timestamp": row["timestamp"],
            "entity_type": row["entity_type"],
            "event_type": row["event_type"],
            "entity_id": row["entity_id"],
        }
        for row in store.list_recent_events(project.id, limit=8)
    ]
    recent_agent_runs = [
        {
            "mode": row["mode"],
            "status": row["status"],
            "adapter_name": row["adapter_name"],
            "summary": row["summary"],
            "confidence": row["confidence"],
            "started_at": row["started_at"],
        }
        for row in store.list_recent_agent_runs(project.id, limit=5)
    ]

    research_dir = workspace / "research"
    artifact_excerpts: dict[str, str] = {}
    for artifact_path in sorted(research_dir.glob("*.md")):
        artifact_excerpts[artifact_path.name] = _artifact_excerpt(artifact_path)

    jobs = []
    for row in store.list_jobs(project.id, statuses=("pending", "running", "failed", "succeeded"), limit=8):
        metadata = json.loads(row["metadata_json"])
        jobs.append(
            {
                "id": row["id"],
                "kind": row["kind"],
                "status": row["status"],
                "command": row["command"],
                "cwd": row["cwd"],
                "summary": metadata.get("summary"),
                "reason": metadata.get("reason"),
            }
        )

    evidence_paths = [str(json.loads(row["reproducibility_json"]).get("path") or "") for row in store.list_evidence_items(project.id)]
    codebase_context = _search_codebase_context(
        Path(project.codebase_root) if project.codebase_root else workspace,
        title=current_title,
        brief=current_brief,
        evidence_paths=[path for path in evidence_paths if path],
    )

    return {
        "open_tasks": open_tasks,
        "claims": claims,
        "evidence": evidence,
        "decisions": decisions,
        "recent_events": recent_events,
        "recent_agent_runs": recent_agent_runs,
        "research_artifacts": artifact_excerpts,
        "jobs": jobs,
        "codebase_context": codebase_context,
    }


def _path_allowed(path: Path, policy) -> bool:
    resolved = path.resolve()
    for allowed_root in policy.allowed_writable_roots:
        root = Path(allowed_root).resolve()
        if resolved == root or root in resolved.parents:
            return True
    return False


def _coerce_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _capture_git_metadata(cwd: Path) -> dict[str, object]:
    metadata: dict[str, object] = {"git_present": False}
    commands = {
        "git_commit": ["git", "rev-parse", "HEAD"],
        "git_branch": ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        "git_dirty": ["git", "status", "--porcelain"],
    }
    for key, command in commands.items():
        try:
            result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
        except FileNotFoundError:
            return metadata
        if result.returncode != 0:
            return metadata
        metadata["git_present"] = True
        value = result.stdout.strip()
        if key == "git_dirty":
            metadata[key] = bool(value)
            if value:
                metadata["git_dirty_lines"] = value.splitlines()[:20]
        else:
            metadata[key] = value
    return metadata


def _capture_host_metadata() -> dict[str, object]:
    payload: dict[str, object] = {
        "hostname": socket.gethostname(),
        "python_executable": sys.executable,
        "python_version": sys.version.split()[0],
    }
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return payload
    if result.returncode == 0:
        payload["gpu"] = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return payload


def _collect_artifact_checksums(paths: list[Path]) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for path in paths:
        if not path.exists() or not path.is_file():
            continue
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(65536), b""):
                digest.update(chunk)
        checksums[str(path)] = digest.hexdigest()
    return checksums


def _queue_requested_jobs(store, project, policy, result, jobs_dir: Path) -> dict[str, int]:
    counts = {"jobs_queued": 0, "job_approvals": 0}
    for item in result.jobs_to_start:
        if not isinstance(item, dict):
            continue
        command = str(item.get("command") or "").strip()
        if not command:
            continue

        raw_metadata = item.get("metadata")
        metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
        env_snapshot = metadata.get("env")
        if not isinstance(env_snapshot, dict):
            env_snapshot = {}
        uses_gpu = bool(metadata.get("uses_gpu"))
        estimated_gpu_hours = _coerce_float(metadata.get("estimated_gpu_hours"), 0.0)

        requested_cwd = str(item.get("cwd") or project.codebase_root or project.workspace_root).strip()
        cwd = Path(requested_cwd).resolve()
        if not cwd.exists() or not cwd.is_dir():
            store.append_event(
                project_id=project.id,
                entity_type="job_request",
                entity_id=_stable_item_id("job_request_invalid_cwd", item, command),
                event_type="job.request_rejected",
                payload={"reason": "invalid_cwd", "cwd": requested_cwd, "command": command},
            )
            continue
        if not _path_allowed(cwd, policy):
            store.create_approval(
                project_id=project.id,
                approval_type="job_path_outside_policy",
                reason=f"Requested job cwd is outside allowed roots: {cwd}",
                payload={"command": command, "cwd": str(cwd), "job_request": item},
            )
            counts["job_approvals"] += 1
            continue
        if uses_gpu and estimated_gpu_hours >= policy.approval_thresholds.experiment_gpu_hours:
            store.create_approval(
                project_id=project.id,
                approval_type="gpu_budget_threshold",
                reason=f"Requested GPU job exceeds approval threshold ({estimated_gpu_hours:.2f}h)",
                payload={"command": command, "cwd": str(cwd), "job_request": item},
            )
            counts["job_approvals"] += 1
            continue

        job_label = _stable_item_id("job_request", item, command)
        log_path = jobs_dir / f"{job_label}.log"
        metadata = {
            **metadata,
            "summary": str(item.get("summary") or "").strip() or command,
            "reason": str(item.get("rationale") or "").strip() or None,
            "uses_gpu": uses_gpu,
            "estimated_gpu_hours": estimated_gpu_hours,
            "expected_artifacts": metadata.get("expected_artifacts") or [],
            "requested_by_mode": result.mode,
        }
        store.create_job(
            project_id=project.id,
            kind=str(item.get("kind") or "job"),
            command=command,
            cwd=str(cwd),
            env_snapshot={str(k): str(v) for k, v in env_snapshot.items()},
            log_path=str(log_path),
            metadata=metadata,
        )
        counts["jobs_queued"] += 1
    return counts


def _start_pending_jobs(store, runner: JobRunner, resource_manager: ResourceManager, project_id: str, policy) -> list[str]:
    actions: list[str] = []
    active_jobs = store.list_active_jobs(project_id)
    active_running = [job for job in active_jobs if job["status"] == "running"]
    remaining_slots = max(policy.compute_budget.max_parallel_jobs - len(active_running), 0)
    if remaining_slots == 0:
        return actions

    for job in store.list_jobs(project_id, statuses=("pending",)):
        if remaining_slots <= 0:
            break
        metadata = json.loads(job["metadata_json"])
        uses_gpu = bool(metadata.get("uses_gpu"))
        if uses_gpu and not resource_manager.can_run_gpu_job(project_id):
            continue

        env_snapshot = json.loads(job["env_snapshot_json"])
        metadata_updates = {
            "git": _capture_git_metadata(Path(job["cwd"])),
            "host": _capture_host_metadata(),
        }
        result_path = runner.jobs_dir / f"{job['id']}.result.json"
        metadata_path = runner.jobs_dir / f"{job['id']}.meta.json"
        lock_id = None
        if uses_gpu:
            lock_id = resource_manager.acquire_gpu_lock(project_id, "job", str(job["id"]))
        pid, _ = runner.start_detached_job(
            command=job["command"],
            cwd=Path(job["cwd"]),
            env={str(k): str(v) for k, v in env_snapshot.items()},
            log_path=Path(job["log_path"]),
            metadata_path=metadata_path,
            result_path=result_path,
        )
        store.update_job_runtime(job["id"], status="running", pid=pid)
        metadata_updates.update(
            {
            "result_path": str(result_path),
            "metadata_path": str(metadata_path),
            "lock_id": lock_id,
            }
        )
        store.update_job_metadata(str(job["id"]), metadata_updates)
        store.append_event(
            project_id=project_id,
            entity_type="job",
            entity_id=str(job["id"]),
            event_type="job.started",
            payload={"pid": pid, "command": job["command"], "cwd": job["cwd"], "uses_gpu": uses_gpu},
            dedupe_key=f"job-started:{job['id']}",
        )
        actions.append(f"started_job:{job['id']}")
        remaining_slots -= 1
    return actions


def _enqueue_job_followups(store, project_id: str) -> list[str]:
    created: list[str] = []
    for job in store.list_jobs(project_id, statuses=("succeeded", "failed", "unknown")):
        metadata = json.loads(job["metadata_json"])
        if metadata.get("followup_task_id"):
            continue
        expected_artifacts = [Path(path) for path in metadata.get("expected_artifacts") or [] if path]
        artifact_checksums = {}
        if expected_artifacts:
            artifact_checksums = _collect_artifact_checksums(expected_artifacts)
            if artifact_checksums:
                store.update_job_metadata(str(job["id"]), {"artifact_checksums": artifact_checksums})
        owner_mode = AgentMode.ANALYST.value if job["status"] == "succeeded" else AgentMode.PLANNER.value
        title = (
            f"Analyze completed job: {metadata.get('summary') or job['kind']}"
            if job["status"] == "succeeded"
            else f"Diagnose non-success job: {metadata.get('summary') or job['kind']}"
        )
        payload = {
            "brief": metadata.get("reason") or metadata.get("summary") or job["command"],
            "job_id": job["id"],
            "job_status": job["status"],
            "command": job["command"],
            "cwd": job["cwd"],
            "log_path": job["log_path"],
            "metadata": metadata,
            "artifact_checksums": artifact_checksums,
        }
        task_id, created_now = store.ensure_task(
            project_id=project_id,
            kind="job.analysis" if job["status"] == "succeeded" else "job.failure",
            title=title,
            owner_mode=owner_mode,
            priority=95 if job["status"] == "succeeded" else 110,
            payload=payload,
        )
        store.update_job_metadata(str(job["id"]), {"followup_task_id": task_id})
        if created_now:
            created.append(task_id)
    return created


def _build_agent_adapter(policy):
    if policy.agent_adapter.name == "openai_compatible":
        return openai_adapter_from_env(policy.agent_adapter.env, timeout_seconds=policy.agent_adapter.timeout_seconds)
    return LocalShellAgentAdapter(
        command_template=policy.agent_adapter.command_template,
        env=policy.agent_adapter.env,
        timeout_seconds=policy.agent_adapter.timeout_seconds,
    )


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
        "workspace_root": project.workspace_root,
        "codebase_root": project.codebase_root,
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

    created_job_followups = _enqueue_job_followups(store, project.id)
    if created_job_followups:
        summary["actions"].append(f"created_job_followups:{len(created_job_followups)}")

    started_jobs = _start_pending_jobs(store, runner, resource_manager, project.id, policy)
    if started_jobs:
        store.set_project_status(project.id, ProjectStatus.RUNNING_JOBS.value, paused=False)
        summary["actions"].extend(started_jobs)
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

    if policy.agent_adapter.name == "local_shell" and not policy.agent_adapter.command_template:
        summary["actions"].append("agent_adapter_not_configured")
        return summary

    task = open_tasks[0]
    task_payload = json.loads(task["payload_json"])
    execution_mode = _normalize_owner_mode(
        str(task["kind"] or ""),
        str(task["owner_mode"] or ""),
        str(task["title"] or ""),
        str(task_payload.get("brief") or ""),
    )
    if task["owner_mode"] != execution_mode:
        store.set_task_owner_mode(task["id"], execution_mode)
        summary["actions"].append(f"normalized_owner_mode:{task['id']}:{execution_mode}")
    prompt_bundle = {
        "project": {
            "id": project.id,
            "name": project.name,
            "workspace_root": project.workspace_root,
            "codebase_root": project.codebase_root,
        },
        "task": {
            **dict(task),
            "owner_mode": execution_mode,
            "payload": task_payload,
        },
        "policy": policy.to_dict(),
        "runtime_capabilities": _runtime_capabilities(policy),
        "state_snapshot": _state_snapshot(store, project, workspace, str(task["id"])),
    }
    adapter = _build_agent_adapter(policy)
    store.set_task_status(str(task["id"]), "running")
    try:
        result = adapter.run_agent(
            workspace,
            execution_mode,
            prompt_bundle,
            codebase_root=Path(project.codebase_root) if project.codebase_root else None,
        )
    except Exception as exc:  # noqa: BLE001
        store.set_task_status(str(task["id"]), "blocked", blocked_reason=str(exc))
        store.append_event(
            project_id=project.id,
            entity_type="task",
            entity_id=str(task["id"]),
            event_type="agent.failed",
            payload={"mode": execution_mode, "error": str(exc)},
        )
        summary["actions"].append(f"agent_failed:{task['id']}")
        summary["error"] = str(exc)
        store.set_project_status(project.id, ProjectStatus.RESEARCHING.value, paused=False)
        return summary
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
    persisted = _persist_structured_output(store, project.id, result)
    created_tasks = _enqueue_next_actions(store, project.id, result.next_actions)
    queued_jobs = _queue_requested_jobs(store, project, policy, result, runner.jobs_dir)
    for label, count in persisted.items():
        if count:
            summary["actions"].append(f"persisted_{label}:{count}")
    if created_tasks:
        summary["actions"].append(f"created_followup_tasks:{len(created_tasks)}")
    for label, count in queued_jobs.items():
        if count:
            summary["actions"].append(f"{label}:{count}")
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
    started_jobs = _start_pending_jobs(store, runner, resource_manager, project.id, policy)
    if started_jobs:
        summary["actions"].extend(started_jobs)
        store.set_project_status(project.id, ProjectStatus.RUNNING_JOBS.value, paused=False)
    else:
        store.set_project_status(project.id, ProjectStatus.RESEARCHING.value, paused=False)
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
