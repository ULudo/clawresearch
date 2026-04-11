from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from rich.console import Console
from rich.panel import Panel

from clawresearch import __version__

PROJECT_ROOT = Path(__file__).resolve().parents[3]
RESET_DOC = PROJECT_ROOT / "docs" / "reset-development-concept.md"
LITERATURE_DOC = PROJECT_ROOT / "docs" / "autonomous-research-agent-literature-synthesis.md"


def _display_path(path: Path) -> str:
    try:
        return str(path.relative_to(PROJECT_ROOT))
    except ValueError:
        return str(path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="clawresearch",
        description="Bootstrap shell for the reset ClawResearch rewrite.",
    )
    parser.add_argument(
        "--docs",
        action="store_true",
        help="Show the key reset documents and implementation focus.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    return parser

def _render_intro(console: Console) -> None:
    console.print(
        Panel.fit(
            "ClawResearch has been reset to a minimal console-first scaffold.\n"
            "The old prototype was removed so the next implementation can start clean.",
            title="ClawResearch Reset",
            border_style="cyan",
        )
    )

def _render_docs(console: Console) -> None:
    console.print("[bold]Start with these files:[/bold]")
    console.print(f"1. {_display_path(RESET_DOC)}")
    console.print(f"2. {_display_path(LITERATURE_DOC)}")
    console.print("3. Implement the new runtime from the console inward.")

def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    console = Console()
    _render_intro(console)

    if args.docs:
        _render_docs(console)
    else:
        console.print(
            "Run [bold]clawresearch --docs[/bold] to see the reset implementation contract."
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
