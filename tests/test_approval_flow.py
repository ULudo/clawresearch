from __future__ import annotations

import argparse
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from clawresearch.cli.main import cmd_approval_approve, init_workspace, state_store_for


class ApprovalFlowTests(unittest.TestCase):
    def test_approval_approve_materializes_pending_job(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            codebase = workspace / "codebase"
            codebase.mkdir()
            init_workspace(workspace, codebase)
            store = state_store_for(workspace)
            store.initialize()
            project = store.create_project("demo", workspace, codebase_root=codebase)
            approval_id = store.create_approval(
                project_id=project.id,
                approval_type="gpu_budget_threshold",
                reason="GPU job exceeds threshold",
                payload={
                    "command": "python train.py --config strict96",
                    "cwd": str(codebase),
                    "job_request": {
                        "kind": "experiment",
                        "summary": "Train strict96 baseline",
                        "rationale": "Needed for the same-contract baseline.",
                        "metadata": {
                            "uses_gpu": True,
                            "estimated_gpu_hours": 12,
                            "env": {"CUDA_VISIBLE_DEVICES": "0"},
                        },
                    },
                },
            )

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                exit_code = cmd_approval_approve(
                    argparse.Namespace(
                        approval_id=approval_id,
                        workspace=str(workspace),
                        note="approved for test",
                    )
                )

            self.assertEqual(exit_code, 0)
            response = json.loads(stdout.getvalue())
            self.assertEqual(response["approval_id"], approval_id)
            self.assertEqual(response["status"], "approved")
            self.assertTrue(response["created_job_id"])

            approval_row = store.get_approval(approval_id)
            self.assertEqual(approval_row["status"], "approved")

            jobs = store.list_jobs(project.id, statuses=("pending",))
            self.assertEqual(len(jobs), 1)
            metadata = json.loads(jobs[0]["metadata_json"])
            self.assertEqual(metadata["approval_id"], approval_id)
            self.assertTrue(metadata["uses_gpu"])
