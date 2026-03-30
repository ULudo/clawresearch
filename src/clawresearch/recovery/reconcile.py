from __future__ import annotations

from clawresearch.jobs.runner import JobRunner
from clawresearch.scheduler.resources import ResourceManager
from clawresearch.state.store import StateStore


def reconcile_workspace(store: StateStore, runner: JobRunner, resource_manager: ResourceManager, project_id: str) -> dict[str, int]:
    active_jobs = store.list_active_jobs(project_id)
    counters = {"running": 0, "unknown": 0}
    for job in active_jobs:
        pid = job["pid"]
        if pid:
            status = runner.inspect_pid(pid)
            if status == "running":
                counters["running"] += 1
                store.update_job_runtime(job["id"], status="running", pid=pid)
            else:
                counters["unknown"] += 1
                store.update_job_runtime(job["id"], status="unknown", pid=pid)
                store.append_event(
                    project_id=project_id,
                    entity_type="job",
                    entity_id=job["id"],
                    event_type="job.lost",
                    payload={"pid": pid},
                )
    return counters
