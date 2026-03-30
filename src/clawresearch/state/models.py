from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class ProjectStatus(StrEnum):
    RESEARCHING = "researching"
    RUNNING_JOBS = "running_jobs"
    AWAITING_APPROVAL = "awaiting_approval"
    DRAFTING = "drafting"
    REVIEWING = "reviewing"
    SUBMITTING = "submitting"
    ARCHIVED_LOCAL = "archived_local"
    PUBLISHED = "published"
    FAILED = "failed"
    PAUSED = "paused"


class ClaimStatus(StrEnum):
    OPEN = "open"
    SUPPORTED = "supported"
    MIXED = "mixed"
    WEAKENED = "weakened"
    BLOCKED = "blocked"


class JobStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


class AgentMode(StrEnum):
    SCOUT = "scout"
    PLANNER = "planner"
    EXPERIMENTER = "experimenter"
    ANALYST = "analyst"
    WRITER = "writer"
    REVIEWER = "reviewer"


@dataclass(slots=True)
class ProjectRecord:
    id: str
    name: str
    root_path: str
    status: str
    paused: bool
    summary: str | None = None


@dataclass(slots=True)
class AgentOutputEnvelope:
    mode: str
    summary: str
    next_actions: list[dict[str, Any]] = field(default_factory=list)
    rationale: str = ""
    confidence: float = 0.0
    entities_created_or_updated: list[dict[str, Any]] = field(default_factory=list)
    artifacts_to_create_or_update: list[dict[str, Any]] = field(default_factory=list)
    jobs_to_start: list[dict[str, Any]] = field(default_factory=list)
    claims_updated: list[dict[str, Any]] = field(default_factory=list)
    evidence_updates: list[dict[str, Any]] = field(default_factory=list)
    decisions_proposed: list[dict[str, Any]] = field(default_factory=list)
    needs_human_approval: bool = False
    approval_reason: str | None = None
    budget_impact: dict[str, Any] = field(default_factory=dict)
