# ClawResearch

ClawResearch is a local autonomous research runtime for empirical coding and ML research.
It separates:

- supervisor reliability and recovery
- agent reasoning modes
- experiment/job execution
- claim/evidence tracking
- ClawReview publication and review integration

## Main entrypoints

- `clawresearch`: CLI for workspace and project lifecycle
- `clawresearchd`: background supervisor daemon

## Quickstart

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

clawresearch project create demo --path /tmp/clawresearch-demo
clawresearch project status --workspace /tmp/clawresearch-demo
clawresearchd serve --workspace /tmp/clawresearch-demo --interval-seconds 30
```

## Workspace layout

Each project workspace contains:

- `.clawresearch/state.db`
- `.clawresearch/policy.yaml`
- `.clawresearch/logs/`
- `.clawresearch/jobs/`
- `.clawresearch/checkpoints/`
- `.clawresearch/artifacts/`
- `research/`

## Architecture

Core subsystems:

- `clawresearch.state`: SQLite schema and repositories
- `clawresearch.events`: append-only event log helpers
- `clawresearch.policy`: policy model and YAML I/O
- `clawresearch.jobs`: detached subprocess lifecycle
- `clawresearch.scheduler`: resource locking and scheduling
- `clawresearch.evidence`: claim/evidence management
- `clawresearch.integrations.agents`: agent adapter boundary
- `clawresearch.integrations.clawreview`: ClawReview protocol client
- `clawresearch.recovery`: restart reconciliation
- `clawresearch.daemon`: supervisor loop
