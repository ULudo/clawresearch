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

That starts the TUI runtime in the current directory. The default experience is now a small terminal UI with:

- a checklist-style provider selector for scholarly discovery, publisher/full-text, OA-helper, general-web, and local-context sources
- a persistent chat transcript instead of a one-line prompt loop
- a bottom chat field for talking to the intake consultant
- a pinned brief/status view while the conversation evolves

If you want the old line-oriented console for scripting, pipes, or debugging, use:

```bash
npm run dev -- --plain
```

The startup chat still behaves like a real research intake conversation, backed by a local Ollama model by default.

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

If the consultant proposes a concrete first-pass brief, `/go` can accept that draft directly, start a detached literature-review run, stream live progress in the terminal, and persist the run artifacts under the project runtime directory. A successful literature run now writes a ranked research agenda and, when possible, a selected next research focus. If you revise the brief after reading the outcome, run `/go` again so ClawResearch continues from the updated project state instead of switching to a separate continuation command.

After a run exists, the chat shifts from pure intake into a project-aware research assistant. It can summarize the latest run, explain the current blocker or next step, answer questions about the active project state, and react to requested changes in the research direction. When you materially change the brief after a saved run, ClawResearch will keep the updated brief and nudge you to run `/go` again so the artifacts catch up with the new direction.

Useful slash commands inside the console:

- `/help`
- `/status`
- `/agenda`
- `/sources`
- `/go`
- `/pause`
- `/resume`
- `/quit`
- `/exit`

New projects now open a source-selection checklist at startup. The default selection is:

- scholarly discovery: `openalex`, `crossref`, `dblp`, `pubmed`
- publisher / full text: `arxiv`, `europe-pmc`
- OA / retrieval helpers: `core`, `unpaywall`
- general web: none
- local context: on

Inside the TUI, use:

- `Up` and `Down` to move through the provider list
- `Space` or `Enter` to toggle a provider
- `S` to save the current selection
- `Esc` to leave the overlay

`/sources` reopens the checklist later. The text commands `scholarly: ...`, `publishers: ...`, `helpers: ...`, `web: ...`, `local: off`, and `sources: ...` are accepted in plain mode, with `sources: ...` kept as a compatibility alias for scholarly discovery.

The second wave of credentialed providers is selectable now too, but stays off by default:

- scholarly discovery: `elsevier`
- publisher / full text: `ieee-xplore`, `springer-nature`

After provider selection, ClawResearch asks for the actual key, token, or email directly. It stores those credentials only in the local runtime folder and mirrors the expected environment-variable names in the background when the runtime starts. For example:

```text
openalex api key [optional; Enter leaves it unset]:
unpaywall email [required; Enter leaves it unavailable]:
elsevier institution token [optional; Enter leaves it unset]:
```

Minimal runtime state is persisted locally in:

```text
.clawresearch/session.json
```

Run artifacts now include:

- `agenda.json`
- `agenda.md`
- `work-package.json`
- `paper.md`
- `paper.json`
- `manuscript-checks.json`
- `quality-report.json`

Project-level literature configuration is persisted in:

```text
.clawresearch/project-config.json
```

Project-level credentials are persisted locally in:

```text
.clawresearch/credentials.json
```

The runtime keeps the canonical agent-accessible research work store in:

```text
.clawresearch/research-work-store.json
```

The current accepted research direction lives in:

```text
.clawresearch/research-direction.json
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
- `plan.json`
- `sources.json`
- `literature-review.json`
- `paper-extractions.json`
- `evidence-matrix.json`
- `synthesis.md`
- `claims.json`
- `verification.json`
- `next-questions.json`
- `agenda.json`
- `summary.md`
- `research-journal.json` (now a run-local work-store checkpoint)

`events.jsonl` is the structured event stream the console watches while a run is active. It currently emits small, readable steps such as `plan`, `source`, `claim`, `next`, `exec`, `summary`, and terminal `run` updates.

The project-level work store is the durable research memory. It stores typed research objects such as:

- provider runs
- sources and canonical sources
- screening decisions and full-text/access records
- extractions and evidence cells
- claims, citations, and manuscript sections
- critic/check work items
- release checks and worker state

Each object has a stable id and enough metadata for the agent to query, read, patch, and extend the research state without treating per-run artifacts as long-term memory.

The planner and source gatherer receive compact contexts derived from this work store, so later `/go` segments build on prior sources, unresolved work items, evidence cells, claims, and manuscript state instead of starting cold each time.

The detached worker now runs a minimal explicit research loop. It is still intentionally small, but it no longer just boots and exits. The current loop does this:

- plan a bounded research mode
- run a dedicated literature-review subsystem for review-style tasks, with task-aware paper ranking instead of generic web browsing
- plan provider-aware retrieval queries from the brief, project memory, and literature memory
- route scholarly discovery by domain instead of looping over a flat provider list
- gather raw discovery hits from `openalex`, `crossref`, `arxiv`, `dblp`, `pubmed`, `europe-pmc`, `ieee-xplore`, `elsevier`, and `springer-nature`
- use `core` and `unpaywall` as OA and retrieval helpers when configured
- use publisher-specific access resolution to prefer readable OA routes and honestly mark entitlement-gated papers
- keep general-web and local context separate from scholarly review
- merge duplicate provider hits into canonical papers
- resolve the best legal reading path per paper before synthesis
- persist canonical paper access state, screening decisions, and provider auth status
- use relevant project memory to shape planning and retrieval
- synthesize themes
- record claims with explicit evidence references
- verify claim provenance, support status, and explicit unknown or unverified gaps
- produce next-step research questions
- write a small structured research journal batch into both the run directory and the project runtime journal store

It is still not a full autonomous scientist yet. The current loop is best understood as a source-grounded first research pass with inspectable artifacts.

When the run is clearly a literature-review task, ClawResearch now switches to a specialized literature subsystem. That subsystem builds a task-aware literature profile, ranks papers by domain and task fit rather than pure keyword overlap, merges provider duplicates into canonical papers, and uses a literature-specific synthesis prompt that emphasizes thematic comparison, citation grounding, and explicit gap identification.

`sources.json` now keeps raw provider hits, routing notes, and merge diagnostics. `literature-review.json` keeps the canonical paper set, access state, screening state, and provider-auth status that mattered for the run.

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
run        Plan: .clawresearch/runs/run-.../plan.json
run        Sources: .clawresearch/runs/run-.../sources.json
run        Literature review: .clawresearch/runs/run-.../literature-review.json
run        Synthesis: .clawresearch/runs/run-.../synthesis.md
run        Verification: .clawresearch/runs/run-.../verification.json
run        Work-store checkpoint: .clawresearch/runs/run-.../research-journal.json
watch      Streaming live run activity from .clawresearch/runs/run-.../events.jsonl.
plan       Plan the research mode and generate initial search queries.
source     web-1: ...
claim      ...
verify     Verified 1 claims against 2 sources. 1 supported, 0 partially supported, 0 unverified, 0 explicit unknown.
memory     Research work store updated: 15 sources, 4 open work items.
next       ...
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
