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
- `clawresearch-api`: local API server for the product UI layer

Key runtime features:

- persistent SQLite-backed research state and event log
- separate `workspace_root` and `codebase_root`
- typed agent outputs with claims, evidence, decisions, tasks, and job requests
- managed detached job execution with recovery and job-followup analysis
- approval gates for expensive or policy-sensitive work
- direct local-model support through an OpenAI-compatible API (for example Ollama)

## Quickstart

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

clawresearch project create rellflow-e2e-mpc \
  --path /tmp/clawresearch-workspaces \
  --codebase-root /home/uli/Development/Python/ReLLFloW

# Optional: switch a workspace to a local OpenAI-compatible model server.
# Example policy env:
# CLAWRESEARCH_OPENAI_BASE_URL=http://127.0.0.1:11434/v1
# CLAWRESEARCH_OPENAI_MODEL=qwen3:14b
# CLAWRESEARCH_OPENAI_API_KEY=ollama

clawresearch project status --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc
clawresearchd serve --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc --interval-seconds 30
```

Useful inspection commands:

```bash
clawresearch task list --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc
clawresearch approvals --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc
clawresearch approval approve <approval-id> --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc
clawresearch jobs list --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc
clawresearch inspect claims --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc
clawresearch inspect evidence --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc
clawresearch inspect decisions --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc
```

## Local API layer

ClawResearch now includes a local API layer that translates runtime state into UI-friendly project data.
The same server also serves the first local web shell at `/`.

You can run it against a single workspace:

```bash
clawresearch-api \
  --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc \
  --host 127.0.0.1 \
  --port 8342
```

Or directly via the Python module if your editable install has not been refreshed yet:

```bash
python -m clawresearch.api.server \
  --workspace /tmp/clawresearch-workspaces/rellflow-e2e-mpc \
  --host 127.0.0.1 \
  --port 8342
```

Useful endpoints:

```bash
curl -s http://127.0.0.1:8342/api/health
curl -s http://127.0.0.1:8342/api/projects/project_xxx/overview
curl -s http://127.0.0.1:8342/api/projects/project_xxx/activity
curl -s http://127.0.0.1:8342/api/projects/project_xxx/tasks
curl -s http://127.0.0.1:8342/api/projects/project_xxx/approvals
curl -s http://127.0.0.1:8342/api/projects/project_xxx/jobs
curl -s http://127.0.0.1:8342/api/projects/project_xxx/claims
curl -s http://127.0.0.1:8342/api/projects/project_xxx/evidence
curl -s http://127.0.0.1:8342/api/projects/project_xxx/decisions
curl -s http://127.0.0.1:8342/api/projects/project_xxx/artifacts
```

Open the web shell in a browser:

```bash
open http://127.0.0.1:8342/
```

The shell currently includes:

- project creation
- project overview cards
- approvals and actions
- jobs visibility
- claims, evidence, and decisions
- research artifact browsing
- plain-language command submission

Control-style commands can be submitted as JSON:

```bash
curl -s \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"text":"Continue and prioritize the same-backbone baseline."}' \
  http://127.0.0.1:8342/api/projects/project_xxx/commands
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

Projects can target an external codebase. The workspace stores runtime state, logs, and research artifacts, while `codebase_root` is the directory where agents inspect code, run commands, and execute experiments.

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

## Runtime loop

The supervisor follows a bounded autonomous loop:

1. reconcile running jobs and recover state after restarts
2. surface pending approvals
3. start pending managed jobs when policy allows
4. call the configured agent backend with a typed prompt and current research snapshot
5. persist claims, evidence, decisions, artifacts, and follow-up tasks
6. gate expensive work through approvals instead of silently running it

This keeps reliability, long-running execution, and scientific state management outside the model itself.
