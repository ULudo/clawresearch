from __future__ import annotations

import json
import uuid
from typing import Any

from clawresearch.state.store import StateStore, utc_now


class EvidenceService:
    def __init__(self, store: StateStore) -> None:
        self.store = store

    def create_claim(self, *, project_id: str, text: str, scope: str, claim_type: str, status: str = "open") -> str:
        claim_id = f"claim_{uuid.uuid4().hex[:12]}"
        timestamp = utc_now()
        with self.store.transaction() as connection:
            connection.execute(
                """
                INSERT INTO claims (id, project_id, text, scope, claim_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (claim_id, project_id, text, scope, claim_type, status, timestamp, timestamp),
            )
        self.store.append_event(
            project_id=project_id,
            entity_type="claim",
            entity_id=claim_id,
            event_type="claim.created",
            payload={"text": text, "scope": scope, "claim_type": claim_type, "status": status},
        )
        return claim_id

    def create_evidence_item(
        self,
        *,
        project_id: str,
        source_type: str,
        title: str,
        strength: str,
        reproducibility: dict[str, Any],
        conclusion_impact: str,
        summary: str,
    ) -> str:
        evidence_id = f"evidence_{uuid.uuid4().hex[:12]}"
        timestamp = utc_now()
        with self.store.transaction() as connection:
            connection.execute(
                """
                INSERT INTO evidence_items (id, project_id, source_type, title, strength, reproducibility_json, conclusion_impact, summary, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    evidence_id,
                    project_id,
                    source_type,
                    title,
                    strength,
                    json.dumps(reproducibility, sort_keys=True),
                    conclusion_impact,
                    summary,
                    timestamp,
                    timestamp,
                ),
            )
        return evidence_id

    def link_claim_to_evidence(
        self, *, project_id: str, claim_id: str, evidence_item_id: str, relation: str, rationale: str
    ) -> str:
        link_id = f"link_{uuid.uuid4().hex[:12]}"
        with self.store.transaction() as connection:
            connection.execute(
                """
                INSERT INTO claim_evidence_links (id, project_id, claim_id, evidence_item_id, relation, rationale)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (link_id, project_id, claim_id, evidence_item_id, relation, rationale),
            )
        return link_id
