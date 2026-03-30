from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class AgentAdapterPolicy:
    name: str = "local_shell"
    command_template: list[str] = field(default_factory=list)
    timeout_seconds: int = 3600
    env: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class ComputeBudget:
    gpu_hours: float = 24.0
    cpu_hours: float = 72.0
    max_parallel_jobs: int = 2
    max_parallel_gpu_jobs: int = 1


@dataclass(slots=True)
class PublishPolicy:
    auto_publish: bool = False
    require_preflight: bool = True
    require_self_review: bool = True


@dataclass(slots=True)
class ApprovalThresholds:
    experiment_gpu_hours: float = 8.0
    iteration_without_evidence_gain: int = 5
    methods_change_requires_approval: bool = True
    research_question_change_requires_approval: bool = True


@dataclass(slots=True)
class Policy:
    allowed_writable_roots: list[str] = field(default_factory=list)
    allowed_command_profiles: list[str] = field(default_factory=lambda: ["python", "shell", "git-readonly"])
    network_policy: str = "bounded"
    compute_budget: ComputeBudget = field(default_factory=ComputeBudget)
    wall_clock_budget_hours: float = 168.0
    max_iterations_per_hypothesis: int = 8
    publish_policy: PublishPolicy = field(default_factory=PublishPolicy)
    approval_thresholds: ApprovalThresholds = field(default_factory=ApprovalThresholds)
    abort_conditions: list[str] = field(
        default_factory=lambda: ["policy_violation", "repeated_failed_iterations", "budget_exhausted"]
    )
    agent_adapter: AgentAdapterPolicy = field(default_factory=AgentAdapterPolicy)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Policy":
        return cls(
            allowed_writable_roots=value.get("allowed_writable_roots", []),
            allowed_command_profiles=value.get("allowed_command_profiles", ["python", "shell", "git-readonly"]),
            network_policy=value.get("network_policy", "bounded"),
            compute_budget=ComputeBudget(**value.get("compute_budget", {})),
            wall_clock_budget_hours=value.get("wall_clock_budget_hours", 168.0),
            max_iterations_per_hypothesis=value.get("max_iterations_per_hypothesis", 8),
            publish_policy=PublishPolicy(**value.get("publish_policy", {})),
            approval_thresholds=ApprovalThresholds(**value.get("approval_thresholds", {})),
            abort_conditions=value.get(
                "abort_conditions", ["policy_violation", "repeated_failed_iterations", "budget_exhausted"]
            ),
            agent_adapter=AgentAdapterPolicy(**value.get("agent_adapter", {})),
        )
