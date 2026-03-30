from __future__ import annotations

from typing import Any

from clawresearch.state.store import StateStore


class EventLogger:
    def __init__(self, store: StateStore) -> None:
        self.store = store

    def append(
        self,
        *,
        project_id: str,
        entity_type: str,
        entity_id: str,
        event_type: str,
        payload: dict[str, Any],
        causation_id: str | None = None,
        correlation_id: str | None = None,
        dedupe_key: str | None = None,
    ) -> str:
        return self.store.append_event(
            project_id=project_id,
            entity_type=entity_type,
            entity_id=entity_id,
            event_type=event_type,
            payload=payload,
            causation_id=causation_id,
            correlation_id=correlation_id,
            dedupe_key=dedupe_key,
        )
