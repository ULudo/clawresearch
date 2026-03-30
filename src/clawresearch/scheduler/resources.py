from __future__ import annotations

import json
import uuid
from pathlib import Path

from clawresearch.state.store import StateStore, utc_now


class ResourceManager:
    def __init__(self, store: StateStore) -> None:
        self.store = store

    def can_run_gpu_job(self, project_id: str) -> bool:
        with self.store.transaction() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM resource_locks
                WHERE project_id = ? AND resource_type = 'gpu' AND lock_status = 'active'
                """,
                (project_id,),
            ).fetchone()
        return int(row["count"]) == 0

    def acquire_gpu_lock(self, project_id: str, owner_type: str, owner_id: str) -> str:
        lock_id = f"lock_{uuid.uuid4().hex[:12]}"
        with self.store.transaction() as connection:
            connection.execute(
                """
                INSERT INTO resource_locks (id, project_id, resource_type, resource_key, lock_status, owner_type, owner_id, acquired_at, metadata_json)
                VALUES (?, ?, 'gpu', 'gpu:0', 'active', ?, ?, ?, ?)
                """,
                (lock_id, project_id, owner_type, owner_id, utc_now(), json.dumps({})),
            )
        return lock_id

    def release_lock(self, lock_id: str) -> None:
        with self.store.transaction() as connection:
            connection.execute(
                "UPDATE resource_locks SET lock_status = 'released', released_at = ? WHERE id = ?",
                (utc_now(), lock_id),
            )
