# ClawResearch

ClawResearch is being restarted from a much smaller and cleaner foundation.

The repo now reflects a deliberate reset:

> a console-first autonomous research runtime for empirical computational research

The first implementation taught us a lot, but it grew too quickly into a platform-heavy prototype. That prototype has been removed from the main code path so the next iteration can start from a clear, debuggable base.

## What This Repo Is Now

This repository is intentionally minimal.

It currently contains:

- the revised concept documents
- a small TypeScript package scaffold
- a single `clawresearch` entrypoint
- a clean starting point for the rewrite on the workstation

It intentionally does **not** currently contain:

- the previous API layer
- the previous daemon stack
- the previous approval and policy machinery
- the previous adapter and orchestration prototype

## Start Here

Read these documents in order:

1. `docs/reset-development-concept.md`
2. `docs/autonomous-research-agent-literature-synthesis.md`
3. `docs/archive/product-design-v1.md` only if you want to inspect the discarded direction

## Reset Direction

The next implementation should be:

- console-first
- current-directory-as-project
- persistent across restarts
- capable of detached long-running jobs
- findings-memory-driven
- model- and backend-agnostic

The next implementation should **not** begin as:

- a web product
- a research operations platform
- a governance-first system
- a large multi-component orchestration framework

## Language Decision

The new reset uses TypeScript rather than Python.

That is a product decision, not a claim about what language the agent later researches in.

The reasoning is simple:

- ClawResearch is primarily a local agent product and runtime harness
- terminal UX, streaming, process orchestration, and packaging are central
- the actual research workloads can remain polyglot and run through external tools, shells, repos, Docker, or Python environments
- the harness language should optimize for product flow and developer velocity, not for mirroring the language of downstream experiment code

## Quickstart

```bash
npm install
npm run dev
```

That starts the console runtime in the current directory. The startup chat behaves like a real research intake conversation, backed by a local Ollama model by default.

Current local-model assumption:

- `ollama` is installed and running locally
- `qwen3:14b` is available

You can override the default model with:

```bash
CLAWRESEARCH_OLLAMA_MODEL=your-model-name npm run dev
```

The intake chat gradually clarifies and captures:

- topic
- research question
- research direction
- success criterion

If the consultant proposes a concrete first-pass brief, `/go` can accept that draft directly, start a detached local run, stream live progress in the terminal, and persist the run artifacts under the project runtime directory.

Useful slash commands inside the console:

- `/help`
- `/status`
- `/go`
- `/pause`
- `/resume`
- `/quit`
- `/exit`

Minimal runtime state is persisted locally in:

```text
.clawresearch/session.json
```

The console also keeps a raw debug transcript of the interaction in:

```text
.clawresearch/console-transcript.log
```

Detached runs are stored under:

```text
.clawresearch/runs/<run-id>/
```

Each run keeps a small set of debuggable local artifacts, including:

- `run.json`
- `trace.log`
- `events.jsonl`
- `stdout.log`
- `stderr.log`
- `brief.json`
- `summary.md`

`events.jsonl` is the structured event stream the console watches while a run is active. It currently emits small, readable steps such as `plan`, `next`, `exec`, `summary`, `stdout`, and terminal `run` updates.

The current detached worker is still intentionally minimal. It proves the runtime shape, logging, and observability layer, but it does not yet perform a real literature review or full autonomous research loop.

After dependencies are installed, the runtime can also be built and run as compiled JavaScript:

```bash
npm run build
node dist/src/cli.js
```

If you want a quick reminder of the reset contract from the terminal, run:

```bash
clawresearch --docs
```

Example startup flow:

```text
$ clawresearch
ClawResearch
============
Project root: /path/to/project
Runtime state: .clawresearch/session.json

Startup research chat is ready.
This chat should feel like a stakeholder handing a research project to a capable research partner.

What research problem should I investigate for this project, and what kind of outcome would make the work useful to you?
clawresearch> We want to study sparse graph training for noisy datasets.
clawresearch> The main question is whether a cheaper sampling strategy can preserve accuracy.
clawresearch> Start from a reproducible baseline and compare a couple of bounded ablations.
clawresearch> Success means staying within 1% of baseline accuracy while cutting runtime by 20%.
clawresearch> /go
run        Research run started.
run        Run id: run-...
run        Status: queued
run        Trace: .clawresearch/runs/run-.../trace.log
run        Events: .clawresearch/runs/run-.../events.jsonl
watch      Streaming live run activity from .clawresearch/runs/run-.../events.jsonl.
plan       Persist the research brief, prepare initial run artifacts, and launch the detached bootstrap command.
exec       bash -lc ...
done       Run run-... completed.
```

## Repo Layout

- `docs/` contains the current source-of-truth concept
- `src/` contains the reset TypeScript scaffold
- `tests/` contains only minimal smoke coverage for the new baseline

## Development Intent

The recommended workflow is:

1. pull this repo on the stronger workstation
2. install dependencies with Node.js 20+
3. use the reset concept as the implementation contract
4. rebuild the runtime incrementally from the console inward

This keeps the repo honest: small concept, small scaffold, clean next steps.
