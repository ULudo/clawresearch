from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from clawresearch.cli.main import init_workspace, runtime_dir, state_store_for
from clawresearch.jobs.runner import JobRunner
from clawresearch.recovery.reconcile import reconcile_workspace
from clawresearch.scheduler.resources import ResourceManager


class JobRunnerTests(unittest.TestCase):
    def test_detached_job_writes_result_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            runner = JobRunner(workspace / ".clawresearch" / "jobs")

            log_path = workspace / ".clawresearch" / "jobs" / "simple.log"
            result_path = workspace / ".clawresearch" / "jobs" / "simple.result.json"
            metadata_path = workspace / ".clawresearch" / "jobs" / "simple.meta.json"
            pid, _ = runner.start_detached_job(
                command="python3 -c \"from pathlib import Path; Path('artifact.txt').write_text('ok', encoding='utf-8')\"",
                cwd=codebase,
                env={"TEST_JOB": "1"},
                log_path=log_path,
                metadata_path=metadata_path,
                result_path=result_path,
            )

            payload = None
            for _ in range(40):
                status, payload = runner.inspect_job(pid=pid, result_path=result_path)
                if status == "succeeded":
                    break
                time.sleep(0.05)

            self.assertIsNotNone(payload)
            self.assertEqual(payload["status"], "succeeded")
            self.assertEqual(payload["exit_code"], 0)
            self.assertTrue((codebase / "artifact.txt").exists())
            self.assertTrue(metadata_path.exists())

    def test_reconcile_marks_completed_jobs_and_releases_gpu_lock(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace, codebase)
            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace, codebase_root=codebase)
            runner = JobRunner(runtime_dir(workspace) / "jobs")
            resources = ResourceManager(store)

            job_id = store.create_job(
                project_id=project.id,
                kind="experiment",
                command="python3 -c \"print('job ok')\"",
                cwd=str(codebase),
                env_snapshot={},
                log_path=str(runtime_dir(workspace) / "jobs" / "job.log"),
                metadata={"summary": "test job", "uses_gpu": True},
            )
            lock_id = resources.acquire_gpu_lock(project.id, "job", job_id)
            result_path = runtime_dir(workspace) / "jobs" / f"{job_id}.result.json"
            metadata_path = runtime_dir(workspace) / "jobs" / f"{job_id}.meta.json"
            pid, _ = runner.start_detached_job(
                command="python3 -c \"print('job ok')\"",
                cwd=codebase,
                env={},
                log_path=Path(runtime_dir(workspace) / "jobs" / "job.log"),
                metadata_path=metadata_path,
                result_path=result_path,
            )
            store.update_job_runtime(job_id, status="running", pid=pid)
            store.update_job_metadata(job_id, {"result_path": str(result_path), "lock_id": lock_id})

            for _ in range(40):
                counters = reconcile_workspace(store, runner, resources, project.id)
                if counters["succeeded"] == 1:
                    break
                time.sleep(0.05)

            jobs = store.list_jobs(project.id, statuses=("succeeded",))
            self.assertEqual(len(jobs), 1)
            self.assertEqual(jobs[0]["id"], job_id)
            self.assertTrue(resources.can_run_gpu_job(project.id))
            recent_events = store.list_recent_events(project.id, limit=4)
            self.assertTrue(any(row["event_type"] == "job.succeeded" for row in recent_events))

    def test_reconcile_leaves_pending_jobs_without_pid_for_scheduler(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace, codebase)
            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace, codebase_root=codebase)
            runner = JobRunner(runtime_dir(workspace) / "jobs")
            resources = ResourceManager(store)

            job_id = store.create_job(
                project_id=project.id,
                kind="experiment",
                command="python3 -c \"print('pending')\"",
                cwd=str(codebase),
                env_snapshot={},
                log_path=str(runtime_dir(workspace) / "jobs" / "pending.log"),
                metadata={"summary": "pending job"},
            )

            counters = reconcile_workspace(store, runner, resources, project.id)
            self.assertEqual(counters["unknown"], 0)
            jobs = store.list_jobs(project.id, statuses=("pending",))
            self.assertEqual(len(jobs), 1)
            self.assertEqual(jobs[0]["id"], job_id)
