from __future__ import annotations

SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_root TEXT NOT NULL UNIQUE,
        codebase_root TEXT,
        status TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        project_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT,
        dedupe_key TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_key ON events(dedupe_key) WHERE dedupe_key IS NOT NULL",
    """
    CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        owner_mode TEXT,
        blocked_reason TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        scope TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        text TEXT NOT NULL,
        scope TEXT,
        claim_type TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS evidence_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        title TEXT NOT NULL,
        strength TEXT NOT NULL,
        reproducibility_json TEXT NOT NULL,
        conclusion_impact TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS claim_evidence_links (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        evidence_item_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        rationale TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(claim_id) REFERENCES claims(id),
        FOREIGN KEY(evidence_item_id) REFERENCES evidence_items(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        hypothesis_id TEXT,
        command TEXT,
        config_hash TEXT,
        dataset_version TEXT,
        seeds_json TEXT NOT NULL,
        expected_artifacts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        experiment_id TEXT,
        kind TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        env_snapshot_json TEXT NOT NULL,
        log_path TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        path TEXT NOT NULL,
        checksum TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS manuscripts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        current_revision INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        manuscript_id TEXT,
        review_type TEXT NOT NULL,
        status TEXT NOT NULL,
        path TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        rationale TEXT NOT NULL,
        blocking INTEGER NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        approval_type TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_payload_json TEXT NOT NULL,
        resolved_payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        adapter_name TEXT NOT NULL,
        input_path TEXT,
        output_path TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        confidence REAL,
        summary TEXT,
        raw_output_path TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resource_locks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        lock_status TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        released_at TEXT,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """,
]
