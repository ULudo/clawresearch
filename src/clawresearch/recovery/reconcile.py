from __future__ import annotations

import json
from pathlib import Path

from clawresearch.jobs.runner import JobRunner
from clawresearch.scheduler.resources import ResourceManager
from clawresearch.state.store import StateStore


def reconcile_workspace(store: StateStore, runner: JobRunner, resource_manager: ResourceManager, project_id: str) -> dict[str, int]:
    active_jobs = store.list_active_jobs(project_id)
    counters = {"running": 0, "unknown": 0, "succeeded": 0, "failed": 0}
    for job in active_jobs:
        if job["status"] == "pending" and not job["pid"]:
            continue
        pid = job["pid"]
        metadata = json.loads(job["metadata_json"])
        result_path = Path(metadata["result_path"]) if metadata.get("result_path") else None
        status, payload = runner.inspect_job(pid=pid, result_path=result_path)
        if status == "running":
            counters["running"] += 1
            store.update_job_runtime(job["id"], status="running", pid=pid)
            continue

        if status in {"succeeded", "failed"}:
            counters[status] += 1
            exit_code = None if payload is None else int(payload.get("exit_code", 0))
            store.update_job_runtime(job["id"], status=status, pid=pid, exit_code=exit_code)
            resource_manager.release_owner_locks(project_id, "job", str(job["id"]))
            store.append_event(
                project_id=project_id,
                entity_type="job",
                entity_id=job["id"],
                event_type=f"job.{status}",
                payload=payload or {"pid": pid, "status": status},
                dedupe_key=f"job-status:{job['id']}:{status}",
            )
            continue

        counters["unknown"] += 1
        store.update_job_runtime(job["id"], status="unknown", pid=pid)
        resource_manager.release_owner_locks(project_id, "job", str(job["id"]))
        store.append_event(
            project_id=project_id,
            entity_type="job",
            entity_id=job["id"],
            event_type="job.lost",
            payload={"pid": pid},
            dedupe_key=f"job-lost:{job['id']}",
        )
    return counters
