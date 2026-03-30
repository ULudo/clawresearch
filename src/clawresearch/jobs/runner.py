from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from clawresearch.state.models import JobStatus


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


class JobRunner:
    def __init__(self, jobs_dir: Path) -> None:
        self.jobs_dir = jobs_dir
        self.jobs_dir.mkdir(parents=True, exist_ok=True)

    def start_detached_job(
        self,
        *,
        command: list[str],
        cwd: Path,
        env: dict[str, str],
        log_path: Path,
        metadata_path: Path | None = None,
    ) -> tuple[int, str]:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("ab") as log_handle:
            process = subprocess.Popen(
                command,
                cwd=str(cwd),
                env={**os.environ, **env},
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        if metadata_path is not None:
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            metadata_path.write_text(
                json.dumps({"pid": process.pid, "command": command, "cwd": str(cwd), "env": env}, indent=2),
                encoding="utf-8",
            )
        return process.pid, str(log_path)

    def inspect_pid(self, pid: int) -> str:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return JobStatus.UNKNOWN.value
        except PermissionError:
            return JobStatus.RUNNING.value
        return JobStatus.RUNNING.value

    def collect_artifact_checksums(self, paths: list[Path]) -> dict[str, str]:
        result: dict[str, str] = {}
        for path in paths:
            if path.exists() and path.is_file():
                result[str(path)] = sha256_file(path)
        return result
