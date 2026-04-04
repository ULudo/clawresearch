from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import textwrap
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
        command: list[str] | str,
        cwd: Path,
        env: dict[str, str],
        log_path: Path,
        metadata_path: Path | None = None,
        result_path: Path | None = None,
    ) -> tuple[int, str]:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        resolved_result_path = result_path or log_path.with_suffix(".result.json")
        resolved_result_path.parent.mkdir(parents=True, exist_ok=True)
        shell_command = command if isinstance(command, str) else shlex.join(command)
        wrapper_path = self.jobs_dir / f"wrapper-{hashlib.sha1(str(log_path).encode('utf-8')).hexdigest()[:12]}.py"
        wrapper_path.write_text(
            self._wrapper_program(
                command=shell_command,
                cwd=cwd,
                env=env,
                log_path=log_path,
                result_path=resolved_result_path,
            ),
            encoding="utf-8",
        )
        process = subprocess.Popen(
            [sys.executable, str(wrapper_path)],
            cwd=str(cwd),
            env=os.environ.copy(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        pid = process.pid
        # We intentionally detach the child and track it by pid/result files rather than by the Popen object.
        process._child_created = False  # type: ignore[attr-defined]
        if metadata_path is not None:
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            metadata_path.write_text(
                json.dumps(
                    {
                        "pid": pid,
                        "command": shell_command,
                        "cwd": str(cwd),
                        "env": env,
                        "log_path": str(log_path),
                        "result_path": str(resolved_result_path),
                        "wrapper_path": str(wrapper_path),
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        return pid, str(log_path)

    def _wrapper_program(
        self,
        *,
        command: str,
        cwd: Path,
        env: dict[str, str],
        log_path: Path,
        result_path: Path,
    ) -> str:
        payload = {
            "command": command,
            "cwd": str(cwd),
            "env": env,
            "log_path": str(log_path),
            "result_path": str(result_path),
        }
        return textwrap.dedent(
            f"""
            from __future__ import annotations

            import json
            import os
            import subprocess
            from datetime import datetime, timezone
            from pathlib import Path

            payload = {payload!r}
            command = payload["command"]
            cwd = Path(payload["cwd"])
            env = {{**os.environ, **payload["env"]}}
            log_path = Path(payload["log_path"])
            result_path = Path(payload["result_path"])

            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as log_handle:
                log_handle.write(f"[clawresearch] started {{datetime.now().astimezone().isoformat()}}\\n")
                log_handle.write(f"[clawresearch] cwd: {{cwd}}\\n")
                log_handle.write(f"[clawresearch] command: {{command}}\\n")
                log_handle.flush()
                completed = subprocess.run(
                    command,
                    cwd=str(cwd),
                    env=env,
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    text=True,
                    shell=True,
                    executable="/bin/bash",
                    check=False,
                )

            result_payload = {{
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "exit_code": completed.returncode,
                "status": "succeeded" if completed.returncode == 0 else "failed",
                "log_path": str(log_path),
                "cwd": str(cwd),
                "command": command,
            }}
            result_path.write_text(json.dumps(result_payload, indent=2), encoding="utf-8")
            raise SystemExit(completed.returncode)
            """
        ).strip() + "\n"

    def inspect_pid(self, pid: int) -> str:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return JobStatus.UNKNOWN.value
        except PermissionError:
            return JobStatus.RUNNING.value
        return JobStatus.RUNNING.value

    def inspect_job(self, *, pid: int | None, result_path: Path | None) -> tuple[str, dict[str, Any] | None]:
        if result_path is not None and result_path.exists():
            payload = json.loads(result_path.read_text(encoding="utf-8"))
            status = str(payload.get("status") or JobStatus.UNKNOWN.value)
            if status not in {
                JobStatus.SUCCEEDED.value,
                JobStatus.FAILED.value,
                JobStatus.CANCELLED.value,
                JobStatus.UNKNOWN.value,
            }:
                status = JobStatus.UNKNOWN.value
            return status, payload
        if pid is None:
            return JobStatus.UNKNOWN.value, None
        return self.inspect_pid(pid), None

    def collect_artifact_checksums(self, paths: list[Path]) -> dict[str, str]:
        result: dict[str, str] = {}
        for path in paths:
            if path.exists() and path.is_file():
                result[str(path)] = sha256_file(path)
        return result
