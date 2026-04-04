from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from clawresearch.state.models import AgentOutputEnvelope


class AgentAdapter(ABC):
    name: str

    @abstractmethod
    def prepare_context(
        self,
        workspace: Path,
        mode: str,
        prompt_bundle: dict[str, Any],
        codebase_root: Path | None = None,
    ) -> Path:
        raise NotImplementedError

    @abstractmethod
    def run_agent(
        self,
        workspace: Path,
        mode: str,
        prompt_bundle: dict[str, Any],
        codebase_root: Path | None = None,
    ) -> AgentOutputEnvelope:
        raise NotImplementedError

    @abstractmethod
    def parse_typed_output(self, raw_output: str) -> AgentOutputEnvelope:
        raise NotImplementedError

    @abstractmethod
    def collect_generated_artifacts(self, run_dir: Path) -> list[Path]:
        raise NotImplementedError
