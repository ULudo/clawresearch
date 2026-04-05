from __future__ import annotations

import argparse
import json
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from clawresearch.api.service import ApiError, ApiService


class ApiRequestHandler(BaseHTTPRequestHandler):
    service: ApiService
    server_version = "ClawResearchAPI/0.1"

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._send_common_headers(content_type="application/json")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[clawresearch-api] {fmt % args}\n")

    def _dispatch(self, method: str) -> None:
        try:
            parsed = urlparse(self.path)
            segments = [segment for segment in parsed.path.split("/") if segment]
            query = parse_qs(parsed.query)
            body = self._read_json_body() if method == "POST" else {}
            payload = self._route(method, segments, query, body)
            self._write_json(HTTPStatus.OK, payload)
        except ApiError as exc:
            self._write_json(exc.status_code, {"error": exc.message})
        except json.JSONDecodeError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": f"Invalid JSON body: {exc}"})
        except Exception as exc:  # pragma: no cover - defensive server guardrail
            self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})

    def _route(self, method: str, segments: list[str], query: dict[str, list[str]], body: dict[str, Any]) -> Any:
        workspace = self._workspace_from_query(query)
        if segments == ["api", "health"]:
            return {"status": "ok"}

        if len(segments) >= 2 and segments[:2] == ["api", "projects"]:
            if method == "GET" and len(segments) == 2:
                return {"projects": self.service.list_projects()}
            if method == "POST" and len(segments) == 2:
                return self.service.create_project(
                    name=str(body.get("name") or "").strip(),
                    path=self._optional_str(body.get("path")),
                    codebase_root=self._optional_str(body.get("codebase_root")),
                    initial_prompt=self._optional_str(body.get("initial_prompt")),
                )
            if len(segments) >= 3:
                project_id = segments[2]
                if method == "GET" and len(segments) == 3:
                    return self.service.get_project(project_id, workspace=workspace)
                if method == "POST" and len(segments) == 4 and segments[3] == "pause":
                    return self.service.pause_project(project_id, workspace=workspace)
                if method == "POST" and len(segments) == 4 and segments[3] == "resume":
                    return self.service.resume_project(project_id, workspace=workspace)
                if method == "GET" and len(segments) == 4 and segments[3] == "status":
                    return self.service.get_project_status(project_id, workspace=workspace)
                if method == "GET" and len(segments) == 4 and segments[3] == "overview":
                    return self.service.get_project_overview(project_id, workspace=workspace)
                if method == "GET" and len(segments) == 4 and segments[3] == "activity":
                    limit = self._optional_int(query.get("limit", [None])[0], default=50)
                    return self.service.get_activity(project_id, workspace=workspace, limit=limit)
                if method == "GET" and len(segments) == 4 and segments[3] == "tasks":
                    include_closed = self._optional_bool(query.get("all", [None])[0])
                    return {"tasks": self.service.list_tasks(project_id, workspace=workspace, include_closed=include_closed)}
                if method == "POST" and len(segments) == 4 and segments[3] == "tasks":
                    return self.service.create_task(
                        project_id,
                        workspace=workspace,
                        title=str(body.get("title") or "").strip(),
                        kind=self._optional_str(body.get("kind")) or "research.followup",
                        owner_mode=self._optional_str(body.get("owner_mode")) or "planner",
                        priority=self._optional_int(body.get("priority"), default=100),
                        brief=self._optional_str(body.get("brief")),
                        payload=body.get("payload") if isinstance(body.get("payload"), dict) else None,
                    )
                if method == "GET" and len(segments) == 4 and segments[3] == "approvals":
                    return {"approvals": self.service.list_approvals(project_id, workspace=workspace)}
                if method == "GET" and len(segments) == 4 and segments[3] == "jobs":
                    include_all = not self._optional_bool(query.get("active_only", [None])[0])
                    return {"jobs": self.service.list_jobs(project_id, workspace=workspace, include_all=include_all)}
                if method == "GET" and len(segments) == 4 and segments[3] == "claims":
                    return {"claims": self.service.list_claims(project_id, workspace=workspace)}
                if method == "GET" and len(segments) == 4 and segments[3] == "evidence":
                    return {"evidence": self.service.list_evidence(project_id, workspace=workspace)}
                if method == "GET" and len(segments) == 4 and segments[3] == "decisions":
                    return {"decisions": self.service.list_decisions(project_id, workspace=workspace)}
                if method == "GET" and len(segments) == 4 and segments[3] == "artifacts":
                    return {"artifacts": self.service.list_artifacts(project_id, workspace=workspace)}
                if method == "POST" and len(segments) == 4 and segments[3] == "commands":
                    return self.service.submit_command(project_id, workspace=workspace, text=str(body.get("text") or "").strip())

        if len(segments) >= 2 and segments[:2] == ["api", "approvals"] and method == "POST" and len(segments) == 4:
            approval_id = segments[2]
            action = segments[3]
            if action not in {"approve", "reject"}:
                raise ApiError(404, f"Unknown approval action: {action}")
            return self.service.resolve_approval(approval_id, workspace=workspace, action=action, note=self._optional_str(body.get("note")))

        if len(segments) >= 2 and segments[:2] == ["api", "jobs"] and method == "GET":
            if len(segments) == 3:
                return self.service.get_job(segments[2], workspace=workspace)
            if len(segments) == 4 and segments[3] == "logs":
                return self.service.get_job_logs(segments[2], workspace=workspace)

        if len(segments) >= 2 and segments[:2] == ["api", "artifacts"] and method == "GET" and len(segments) == 3:
            return self.service.get_artifact(segments[2], workspace=workspace)

        raise ApiError(404, f"Unknown route: {'/'.join(segments) or '/'}")

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        decoded = json.loads(raw.decode("utf-8"))
        if decoded is None:
            return {}
        if not isinstance(decoded, dict):
            raise ApiError(400, "JSON body must be an object.")
        return decoded

    def _workspace_from_query(self, query: dict[str, list[str]]) -> str | None:
        values = query.get("workspace")
        if not values:
            return None
        return values[0]

    def _optional_str(self, value: object) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    def _optional_int(self, value: object, *, default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def _optional_bool(self, value: object) -> bool:
        if value is None:
            return False
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _write_json(self, status_code: int, payload: Any) -> None:
        data = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status_code)
        self._send_common_headers(content_type="application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_common_headers(self, *, content_type: str) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")


class ClawResearchApiServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], service: ApiService) -> None:
        handler_cls = self._make_handler(service)
        super().__init__(server_address, handler_cls)
        self.service = service

    @staticmethod
    def _make_handler(service: ApiService):
        class Handler(ApiRequestHandler):
            pass

        Handler.service = service
        return Handler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="clawresearch-api", description="Local API server for the ClawResearch runtime")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8342)
    parser.add_argument("--workspace", default=None, help="Default workspace served by the API")
    parser.add_argument("--projects-root", default=None, help="Optional parent directory used for project discovery and creation")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    service = ApiService(
        default_workspace=Path(args.workspace).expanduser().resolve() if args.workspace else None,
        projects_root=Path(args.projects_root).expanduser().resolve() if args.projects_root else None,
    )
    server = ClawResearchApiServer((args.host, args.port), service)
    print(f"ClawResearch API listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down ClawResearch API server.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
