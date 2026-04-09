from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from clawresearch.integrations.agents.prompting import (
    build_conversation_prompt,
    build_prompt,
    conversation_schema_payload,
    schema_payload,
)

_build_prompt = build_prompt
_schema_payload = schema_payload


def _codex_path_entries(codex_bin: Path) -> list[str]:
    entries: list[str] = []
    parent = codex_bin.parent
    if str(parent):
        entries.append(str(parent))
    for ancestor in codex_bin.parents:
        if ancestor.name == "lib":
            node_bin = ancestor.parent / "bin"
            if node_bin.exists():
                entries.append(str(node_bin))
            break
    deduped: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        if entry and entry not in seen:
            deduped.append(entry)
            seen.add(entry)
    return deduped


def build_codex_command(
    *,
    codex_bin: Path,
    codebase_root: Path,
    schema_path: Path,
    output_file: Path,
    codex_model: str = "",
    codex_reasoning_effort: str = "",
) -> list[str]:
    command = [
        str(codex_bin),
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-C",
        str(codebase_root),
        "--output-schema",
        str(schema_path),
        "-o",
        str(output_file),
        "-",
    ]
    if codex_model:
        command[2:2] = ["-m", codex_model]
    if codex_reasoning_effort:
        command[2:2] = ["-c", f'model_reasoning_effort="{codex_reasoning_effort}"']
    return command


def main() -> int:
    prompt_file = Path(os.environ["CLAWRESEARCH_PROMPT_FILE"]).resolve()
    output_file = Path(os.environ["CLAWRESEARCH_OUTPUT_FILE"]).resolve()
    workspace_root = Path(os.environ["CLAWRESEARCH_WORKSPACE_ROOT"]).resolve()
    codebase_root = Path(os.environ["CLAWRESEARCH_CODEBASE_ROOT"]).resolve()
    mode = os.environ.get("CLAWRESEARCH_MODE", "planner")
    interaction_kind = os.environ.get("CLAWRESEARCH_INTERACTION_KIND", "runtime").strip() or "runtime"
    codex_bin = Path(os.environ.get("CLAWRESEARCH_CODEX_BIN", "codex"))
    codex_model = os.environ.get("CLAWRESEARCH_CODEX_MODEL", "").strip()
    codex_reasoning_effort = os.environ.get("CLAWRESEARCH_CODEX_REASONING_EFFORT", "").strip()

    bundle = json.loads(prompt_file.read_text(encoding="utf-8"))

    run_dir = output_file.parent
    schema_path = run_dir / "codex-output-schema.json"
    if interaction_kind == "conversation":
        schema = conversation_schema_payload()
        prompt = build_conversation_prompt(bundle, workspace_root=workspace_root, codebase_root=codebase_root)
    else:
        schema = schema_payload()
        prompt = build_prompt(bundle, workspace_root=workspace_root, codebase_root=codebase_root, mode=mode)
    schema_path.write_text(json.dumps(schema, indent=2), encoding="utf-8")
    env = dict(os.environ)
    path_entries = _codex_path_entries(codex_bin)
    if path_entries:
        env["PATH"] = f"{':'.join(path_entries)}:{env.get('PATH', '')}"

    command = build_codex_command(
        codex_bin=codex_bin,
        codebase_root=codebase_root,
        schema_path=schema_path,
        output_file=output_file,
        codex_model=codex_model,
        codex_reasoning_effort=codex_reasoning_effort,
    )
    result = subprocess.run(
        command,
        input=prompt,
        text=True,
        env=env,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return int(result.returncode)
    if not output_file.exists():
        raise RuntimeError("codex exec completed without producing the expected output file")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
