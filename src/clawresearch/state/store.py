from __future__ import annotations

import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from clawresearch.state.models import ProjectRecord, ProjectStatus
from clawresearch.state.schema import SCHEMA_STATEMENTS


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_task_text(value: str) -> str:
    collapsed = re.sub(r"\s+", " ", (value or "").strip().lower())
    return collapsed


def _task_fingerprint(kind: str, title: str, owner_mode: str | None, payload: dict[str, Any] | None) -> str:
    payload_text = json.dumps(payload or {}, sort_keys=True, separators=(",", ":"))
    return "||".join(
        [
            _normalize_task_text(kind),
            _normalize_task_text(title),
            _normalize_task_text(owner_mode or ""),
            payload_text,
        ]
    )


class StateStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.transaction() as connection:
            for statement in SCHEMA_STATEMENTS:
                connection.execute(statement)

    def create_project(
        self,
        name: str,
        workspace_root: Path,
        codebase_root: Path | None = None,
        summary: str | None = None,
    ) -> ProjectRecord:
        resolved_workspace_root = workspace_root.resolve()
        resolved_codebase_root = codebase_root.resolve() if codebase_root else None
        project_id = f"project_{uuid.uuid4().hex[:12]}"
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO projects (id, name, workspace_root, codebase_root, status, paused, summary, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
                """,
                (
                    project_id,
                    name,
                    str(resolved_workspace_root),
                    str(resolved_codebase_root) if resolved_codebase_root else None,
                    ProjectStatus.RESEARCHING.value,
                    summary,
                    timestamp,
                    timestamp,
                ),
            )
        self.append_event(
            project_id=project_id,
            entity_type="project",
            entity_id=project_id,
            event_type="project.created",
            payload={
                "name": name,
                "workspace_root": str(resolved_workspace_root),
                "codebase_root": str(resolved_codebase_root) if resolved_codebase_root else None,
                "summary": summary,
            },
            dedupe_key=f"project-created:{project_id}",
        )
        return ProjectRecord(
            project_id,
            name,
            str(resolved_workspace_root),
            str(resolved_codebase_root) if resolved_codebase_root else None,
            ProjectStatus.RESEARCHING.value,
            False,
            summary,
        )

    def get_project(self, workspace: Path) -> ProjectRecord | None:
        resolved_workspace = workspace.resolve()
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT id, name, workspace_root, codebase_root, status, paused, summary FROM projects WHERE workspace_root = ?",
                (str(resolved_workspace),),
            ).fetchone()
        if row is None:
            return None
        return ProjectRecord(
            id=row["id"],
            name=row["name"],
            workspace_root=row["workspace_root"],
            codebase_root=row["codebase_root"],
            status=row["status"],
            paused=bool(row["paused"]),
            summary=row["summary"],
        )

    def get_project_by_id(self, project_id: str) -> ProjectRecord | None:
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT id, name, workspace_root, codebase_root, status, paused, summary FROM projects WHERE id = ?",
                (project_id,),
            ).fetchone()
        if row is None:
            return None
        return ProjectRecord(
            id=row["id"],
            name=row["name"],
            workspace_root=row["workspace_root"],
            codebase_root=row["codebase_root"],
            status=row["status"],
            paused=bool(row["paused"]),
            summary=row["summary"],
        )

    def list_projects(self) -> list[ProjectRecord]:
        with self.transaction() as connection:
            rows = connection.execute(
                "SELECT id, name, workspace_root, codebase_root, status, paused, summary FROM projects ORDER BY created_at DESC"
            ).fetchall()
        return [
            ProjectRecord(
                id=row["id"],
                name=row["name"],
                workspace_root=row["workspace_root"],
                codebase_root=row["codebase_root"],
                status=row["status"],
                paused=bool(row["paused"]),
                summary=row["summary"],
            )
            for row in rows
        ]

    def set_project_status(self, project_id: str, status: str, paused: bool | None = None) -> None:
        timestamp = utc_now()
        fields = ["status = ?", "updated_at = ?"]
        params: list[Any] = [status, timestamp]
        if paused is not None:
            fields.append("paused = ?")
            params.append(int(paused))
        params.append(project_id)
        with self.transaction() as connection:
            connection.execute(f"UPDATE projects SET {', '.join(fields)} WHERE id = ?", params)
        self.append_event(
            project_id=project_id,
            entity_type="project",
            entity_id=project_id,
            event_type="project.status_changed",
            payload={"status": status, "paused": paused},
        )

    def append_event(
        self,
        *,
        project_id: str,
        entity_type: str,
        entity_id: str,
        event_type: str,
        payload: dict[str, Any],
        causation_id: str | None = None,
        correlation_id: str | None = None,
        dedupe_key: str | None = None,
    ) -> str:
        event_id = f"evt_{uuid.uuid4().hex[:16]}"
        timestamp = utc_now()
        with self.transaction() as connection:
            if dedupe_key is not None:
                existing = connection.execute("SELECT id FROM events WHERE dedupe_key = ?", (dedupe_key,)).fetchone()
                if existing is not None:
                    return str(existing["id"])
            connection.execute(
                """
                INSERT INTO events (id, timestamp, project_id, entity_type, entity_id, event_type, payload_json, causation_id, correlation_id, dedupe_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    timestamp,
                    project_id,
                    entity_type,
                    entity_id,
                    event_type,
                    json.dumps(payload, sort_keys=True),
                    causation_id,
                    correlation_id,
                    dedupe_key,
                ),
            )
        return event_id

    def create_task(
        self,
        *,
        project_id: str,
        kind: str,
        title: str,
        owner_mode: str | None = None,
        priority: int = 100,
        payload: dict[str, Any] | None = None,
    ) -> str:
        task_id = f"task_{uuid.uuid4().hex[:12]}"
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO tasks (id, project_id, kind, title, status, priority, owner_mode, blocked_reason, payload_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'open', ?, ?, NULL, ?, ?, ?)
                """,
                (task_id, project_id, kind, title, priority, owner_mode, json.dumps(payload or {}), timestamp, timestamp),
            )
        self.append_event(
            project_id=project_id,
            entity_type="task",
            entity_id=task_id,
            event_type="task.created",
            payload={"kind": kind, "title": title, "owner_mode": owner_mode, "priority": priority, "payload": payload or {}},
        )
        return task_id

    def ensure_task(
        self,
        *,
        project_id: str,
        kind: str,
        title: str,
        owner_mode: str | None = None,
        priority: int = 100,
        payload: dict[str, Any] | None = None,
    ) -> tuple[str, bool]:
        desired = _task_fingerprint(kind, title, owner_mode, payload)
        for row in self.list_open_tasks(project_id):
            existing = _task_fingerprint(
                str(row["kind"] or ""),
                str(row["title"] or ""),
                str(row["owner_mode"] or ""),
                json.loads(row["payload_json"]),
            )
            if existing == desired:
                return str(row["id"]), False
        return (
            self.create_task(
                project_id=project_id,
                kind=kind,
                title=title,
                owner_mode=owner_mode,
                priority=priority,
                payload=payload,
            ),
            True,
        )

    def list_open_tasks(self, project_id: str) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(
                connection.execute(
                    "SELECT * FROM tasks WHERE project_id = ? AND status = 'open' ORDER BY priority DESC, created_at ASC",
                    (project_id,),
                ).fetchall()
            )

    def list_tasks(self, project_id: str, *, status: str | None = None) -> list[sqlite3.Row]:
        query = "SELECT * FROM tasks WHERE project_id = ?"
        params: list[Any] = [project_id]
        if status is not None:
            query += " AND status = ?"
            params.append(status)
        query += " ORDER BY priority DESC, created_at ASC"
        with self.transaction() as connection:
            return list(connection.execute(query, params).fetchall())

    def set_task_status(self, task_id: str, status: str, blocked_reason: str | None = None) -> None:
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                "UPDATE tasks SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?",
                (status, blocked_reason, timestamp, task_id),
            )

    def set_task_owner_mode(self, task_id: str, owner_mode: str) -> None:
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                "UPDATE tasks SET owner_mode = ?, updated_at = ? WHERE id = ?",
                (owner_mode, timestamp, task_id),
            )

    def create_job(
        self,
        *,
        project_id: str,
        kind: str,
        command: str,
        cwd: str,
        env_snapshot: dict[str, Any],
        log_path: str,
        experiment_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO jobs (id, project_id, experiment_id, kind, command, cwd, env_snapshot_json, log_path, status, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                """,
                (job_id, project_id, experiment_id, kind, command, cwd, json.dumps(env_snapshot), log_path, json.dumps(metadata or {})),
            )
        self.append_event(
            project_id=project_id,
            entity_type="job",
            entity_id=job_id,
            event_type="job.created",
            payload={"kind": kind, "command": command, "cwd": cwd},
        )
        return job_id

    def update_job_runtime(self, job_id: str, *, status: str, pid: int | None = None, exit_code: int | None = None) -> None:
        timestamp = utc_now()
        started_at = timestamp if status == "running" else None
        finished_at = timestamp if status in {"succeeded", "failed", "cancelled", "unknown"} else None
        with self.transaction() as connection:
            connection.execute(
                """
                UPDATE jobs
                SET status = ?, pid = COALESCE(?, pid), exit_code = COALESCE(?, exit_code), started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at)
                WHERE id = ?
                """,
                (status, pid, exit_code, started_at, finished_at, job_id),
            )

    def update_job_metadata(self, job_id: str, metadata: dict[str, Any]) -> None:
        with self.transaction() as connection:
            row = connection.execute("SELECT metadata_json FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(f"unknown job id: {job_id}")
            current = json.loads(row["metadata_json"])
            current.update(metadata)
            connection.execute(
                "UPDATE jobs SET metadata_json = ? WHERE id = ?",
                (json.dumps(current, sort_keys=True), job_id),
            )

    def list_jobs(
        self,
        project_id: str,
        *,
        statuses: tuple[str, ...] | None = None,
        limit: int | None = None,
    ) -> list[sqlite3.Row]:
        query = "SELECT * FROM jobs WHERE project_id = ?"
        params: list[Any] = [project_id]
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            query += f" AND status IN ({placeholders})"
            params.extend(statuses)
        query += " ORDER BY rowid ASC"
        if limit is not None:
            query += " LIMIT ?"
            params.append(limit)
        with self.transaction() as connection:
            return list(connection.execute(query, params).fetchall())

    def get_job(self, job_id: str) -> sqlite3.Row | None:
        with self.transaction() as connection:
            return connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()

    def list_active_jobs(self, project_id: str) -> list[sqlite3.Row]:
        return self.list_jobs(project_id, statuses=("pending", "running"))

    def list_pending_approvals(self, project_id: str) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(
                connection.execute(
                    "SELECT * FROM approvals WHERE project_id = ? AND status = 'pending' ORDER BY created_at ASC",
                    (project_id,),
                ).fetchall()
            )

    def get_approval(self, approval_id: str) -> sqlite3.Row | None:
        with self.transaction() as connection:
            return connection.execute("SELECT * FROM approvals WHERE id = ?", (approval_id,)).fetchone()

    def create_approval(self, *, project_id: str, approval_type: str, reason: str, payload: dict[str, Any]) -> str:
        approval_id = f"approval_{uuid.uuid4().hex[:12]}"
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO approvals (id, project_id, approval_type, status, reason, requested_payload_json, resolved_payload_json, created_at, updated_at)
                VALUES (?, ?, ?, 'pending', ?, ?, '{}', ?, ?)
                """,
                (approval_id, project_id, approval_type, reason, json.dumps(payload), timestamp, timestamp),
            )
        self.append_event(
            project_id=project_id,
            entity_type="approval",
            entity_id=approval_id,
            event_type="approval.created",
            payload={"approval_type": approval_type, "reason": reason},
        )
        return approval_id

    def resolve_approval(self, approval_id: str, *, status: str, payload: dict[str, Any] | None = None) -> None:
        timestamp = utc_now()
        with self.transaction() as connection:
            row = connection.execute("SELECT project_id FROM approvals WHERE id = ?", (approval_id,)).fetchone()
            if row is None:
                raise KeyError(f"unknown approval id: {approval_id}")
            connection.execute(
                """
                UPDATE approvals
                SET status = ?, resolved_payload_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, json.dumps(payload or {}, sort_keys=True), timestamp, approval_id),
            )
        self.append_event(
            project_id=str(row["project_id"]),
            entity_type="approval",
            entity_id=approval_id,
            event_type="approval.resolved",
            payload={"status": status, "payload": payload or {}},
        )

    def record_agent_run(
        self,
        *,
        project_id: str,
        mode: str,
        adapter_name: str,
        input_path: str | None,
        output_path: str | None,
        status: str,
        summary: str | None = None,
        confidence: float | None = None,
    ) -> str:
        run_id = f"run_{uuid.uuid4().hex[:12]}"
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO agent_runs (id, project_id, mode, status, adapter_name, input_path, output_path, started_at, confidence, summary)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, project_id, mode, status, adapter_name, input_path, output_path, utc_now(), confidence, summary),
            )
        return run_id

    def list_recent_agent_runs(self, project_id: str, *, limit: int = 5) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(
                connection.execute(
                    "SELECT * FROM agent_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?",
                    (project_id, limit),
                ).fetchall()
            )

    def upsert_claim(
        self,
        *,
        project_id: str,
        claim_id: str,
        text: str,
        scope: str | None,
        claim_type: str,
        status: str,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO claims (id, project_id, text, scope, claim_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    text = excluded.text,
                    scope = excluded.scope,
                    claim_type = excluded.claim_type,
                    status = excluded.status,
                    updated_at = excluded.updated_at
                """,
                (claim_id, project_id, text, scope, claim_type, status, timestamp, timestamp),
            )
        self.append_event(
            project_id=project_id,
            entity_type="claim",
            entity_id=claim_id,
            event_type="claim.upserted",
            payload={"text": text, "scope": scope, "claim_type": claim_type, "status": status, "metadata": metadata or {}},
            dedupe_key=f"claim-upserted:{project_id}:{claim_id}:{status}:{text}",
        )
        return claim_id

    def list_claims(self, project_id: str) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(connection.execute("SELECT * FROM claims WHERE project_id = ? ORDER BY created_at ASC", (project_id,)).fetchall())

    def upsert_evidence_item(
        self,
        *,
        project_id: str,
        evidence_item_id: str,
        source_type: str,
        title: str,
        strength: str,
        reproducibility: dict[str, Any],
        conclusion_impact: str | None,
        summary: str | None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO evidence_items (
                    id, project_id, source_type, title, strength, reproducibility_json, conclusion_impact, summary, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    source_type = excluded.source_type,
                    title = excluded.title,
                    strength = excluded.strength,
                    reproducibility_json = excluded.reproducibility_json,
                    conclusion_impact = excluded.conclusion_impact,
                    summary = excluded.summary,
                    updated_at = excluded.updated_at
                """,
                (
                    evidence_item_id,
                    project_id,
                    source_type,
                    title,
                    strength,
                    json.dumps(reproducibility, sort_keys=True),
                    conclusion_impact,
                    summary,
                    timestamp,
                    timestamp,
                ),
            )
        self.append_event(
            project_id=project_id,
            entity_type="evidence_item",
            entity_id=evidence_item_id,
            event_type="evidence.upserted",
            payload={
                "source_type": source_type,
                "title": title,
                "strength": strength,
                "reproducibility": reproducibility,
                "conclusion_impact": conclusion_impact,
                "summary": summary,
                "metadata": metadata or {},
            },
            dedupe_key=f"evidence-upserted:{project_id}:{evidence_item_id}:{strength}:{title}",
        )
        return evidence_item_id

    def list_evidence_items(self, project_id: str) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(
                connection.execute("SELECT * FROM evidence_items WHERE project_id = ? ORDER BY created_at ASC", (project_id,)).fetchall()
            )

    def upsert_decision(
        self,
        *,
        project_id: str,
        decision_id: str,
        decision_type: str,
        status: str,
        summary: str,
        rationale: str,
        blocking: bool,
        evidence: dict[str, Any] | None = None,
    ) -> str:
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO decisions (id, project_id, decision_type, status, summary, rationale, blocking, evidence_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    decision_type = excluded.decision_type,
                    status = excluded.status,
                    summary = excluded.summary,
                    rationale = excluded.rationale,
                    blocking = excluded.blocking,
                    evidence_json = excluded.evidence_json,
                    updated_at = excluded.updated_at
                """,
                (
                    decision_id,
                    project_id,
                    decision_type,
                    status,
                    summary,
                    rationale,
                    int(blocking),
                    json.dumps(evidence or {}, sort_keys=True),
                    timestamp,
                    timestamp,
                ),
            )
        self.append_event(
            project_id=project_id,
            entity_type="decision",
            entity_id=decision_id,
            event_type="decision.upserted",
            payload={
                "decision_type": decision_type,
                "status": status,
                "summary": summary,
                "rationale": rationale,
                "blocking": blocking,
                "evidence": evidence or {},
            },
            dedupe_key=f"decision-upserted:{project_id}:{decision_id}:{status}:{summary}",
        )
        return decision_id

    def list_decisions(self, project_id: str) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(connection.execute("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at ASC", (project_id,)).fetchall())

    def upsert_artifact(
        self,
        *,
        project_id: str,
        artifact_id: str,
        artifact_type: str,
        path: str,
        checksum: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO artifacts (id, project_id, artifact_type, path, checksum, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    artifact_type = excluded.artifact_type,
                    path = excluded.path,
                    checksum = excluded.checksum,
                    metadata_json = excluded.metadata_json,
                    updated_at = excluded.updated_at
                """,
                (
                    artifact_id,
                    project_id,
                    artifact_type,
                    path,
                    checksum,
                    json.dumps(metadata or {}, sort_keys=True),
                    timestamp,
                    timestamp,
                ),
            )
        self.append_event(
            project_id=project_id,
            entity_type="artifact",
            entity_id=artifact_id,
            event_type="artifact.upserted",
            payload={"artifact_type": artifact_type, "path": path, "checksum": checksum, "metadata": metadata or {}},
            dedupe_key=f"artifact-upserted:{project_id}:{artifact_id}:{path}",
        )
        return artifact_id

    def list_artifacts(self, project_id: str) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(connection.execute("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at ASC", (project_id,)).fetchall())

    def get_artifact(self, artifact_id: str) -> sqlite3.Row | None:
        with self.transaction() as connection:
            return connection.execute("SELECT * FROM artifacts WHERE id = ?", (artifact_id,)).fetchone()

    def list_recent_events(self, project_id: str, *, limit: int = 10) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(
                connection.execute(
                    "SELECT * FROM events WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?",
                    (project_id, limit),
                ).fetchall()
            )
