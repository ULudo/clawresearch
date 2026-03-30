from __future__ import annotations

import json
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

    def create_project(self, name: str, root_path: Path, summary: str | None = None) -> ProjectRecord:
        project_id = f"project_{uuid.uuid4().hex[:12]}"
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO projects (id, name, root_path, status, paused, summary, created_at, updated_at)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?)
                """,
                (project_id, name, str(root_path), ProjectStatus.RESEARCHING.value, summary, timestamp, timestamp),
            )
        self.append_event(
            project_id=project_id,
            entity_type="project",
            entity_id=project_id,
            event_type="project.created",
            payload={"name": name, "root_path": str(root_path), "summary": summary},
            dedupe_key=f"project-created:{project_id}",
        )
        return ProjectRecord(project_id, name, str(root_path), ProjectStatus.RESEARCHING.value, False, summary)

    def get_project(self, workspace: Path) -> ProjectRecord | None:
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT id, name, root_path, status, paused, summary FROM projects WHERE root_path = ?",
                (str(workspace),),
            ).fetchone()
        if row is None:
            return None
        return ProjectRecord(
            id=row["id"],
            name=row["name"],
            root_path=row["root_path"],
            status=row["status"],
            paused=bool(row["paused"]),
            summary=row["summary"],
        )

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
            payload={"kind": kind, "title": title, "owner_mode": owner_mode, "priority": priority},
        )
        return task_id

    def list_open_tasks(self, project_id: str) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(
                connection.execute(
                    "SELECT * FROM tasks WHERE project_id = ? AND status = 'open' ORDER BY priority ASC, created_at ASC",
                    (project_id,),
                ).fetchall()
            )

    def set_task_status(self, task_id: str, status: str, blocked_reason: str | None = None) -> None:
        timestamp = utc_now()
        with self.transaction() as connection:
            connection.execute(
                "UPDATE tasks SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?",
                (status, blocked_reason, timestamp, task_id),
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
                SET status = ?, pid = COALESCE(?, pid), exit_code = ?, started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at)
                WHERE id = ?
                """,
                (status, pid, exit_code, started_at, finished_at, job_id),
            )

    def list_active_jobs(self, project_id: str) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(
                connection.execute(
                    "SELECT * FROM jobs WHERE project_id = ? AND status IN ('pending', 'running') ORDER BY rowid ASC",
                    (project_id,),
                ).fetchall()
            )

    def list_pending_approvals(self, project_id: str) -> list[sqlite3.Row]:
        with self.transaction() as connection:
            return list(
                connection.execute(
                    "SELECT * FROM approvals WHERE project_id = ? AND status = 'pending' ORDER BY created_at ASC",
                    (project_id,),
                ).fetchall()
            )

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
