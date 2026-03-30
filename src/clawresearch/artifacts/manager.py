from __future__ import annotations

from pathlib import Path

REQUIRED_ARTIFACTS = {
    "research-question.md": "# Research Question\n\n- Primary question:\n- Core gap:\n- Working thesis:\n",
    "problem-formulation.md": "# Problem Formulation\n\n## Scope\n\n## Assumptions\n\n## Formal Definition\n",
    "literature-positioning.md": "# Literature Positioning\n\n## Closest Prior Work\n\n## Distinct Contribution Boundary\n",
    "method-spec.md": "# Method Specification\n\n## Approach\n\n## Reproducibility Notes\n",
    "evaluation-plan.md": "# Evaluation Plan\n\n## Questions\n\n## Evidence Needed\n",
    "evidence-log.md": "# Evidence Log\n\n## Stable Evidence\n\n## Missing Evidence\n\n## Next Steps\n",
}

OPTIONAL_ARTIFACTS = {
    "manuscript.md": "# Manuscript\n",
    "self-review.md": "# Self Review\n",
}


class ArtifactManager:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.runtime_dir = workspace / ".clawresearch"
        self.research_dir = workspace / "research"

    def ensure_workspace(self) -> None:
        for path in [
            self.runtime_dir,
            self.runtime_dir / "logs",
            self.runtime_dir / "jobs",
            self.runtime_dir / "checkpoints",
            self.runtime_dir / "artifacts",
            self.research_dir,
        ]:
            path.mkdir(parents=True, exist_ok=True)

    def ensure_required_artifacts(self) -> list[Path]:
        created: list[Path] = []
        self.ensure_workspace()
        for name, template in REQUIRED_ARTIFACTS.items():
            target = self.research_dir / name
            if not target.exists():
                target.write_text(template, encoding="utf-8")
                created.append(target)
        return created

    def optional_artifact_path(self, name: str) -> Path:
        if name not in OPTIONAL_ARTIFACTS:
            raise KeyError(f"unknown optional artifact: {name}")
        return self.research_dir / name
