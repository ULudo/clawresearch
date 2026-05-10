# ClawResearch

ClawResearch is a local research lab for an LLM researcher.

The model is responsible for research judgment: planning, source selection, evidence interpretation, synthesis, writing, revision, and deciding what to do next. ClawResearch provides the lab infrastructure around that researcher: terminal UX, provider tools, persistent workspace memory, provenance, citation integrity, checkpoints, diagnostics, and final exports.

The current product is console-first and project-local. Run it inside the directory you want to research. ClawResearch stores its workspace under `.clawresearch/` in that project.

## Current Architecture

ClawResearch is built around a model-driven research session:

1. The runtime observes the current workspace state.
2. The model chooses one explicit tool action.
3. The runtime validates the action mechanically.
4. The runtime executes exactly that action.
5. The result is persisted and returned as an observation.
6. The model observes again and chooses the next action.

There is no hidden research pipeline. Source search, extraction, evidence creation, claim work, section writing, critic review, release checks, notebook updates, and manuscript finalization are model-selected tools.

The runtime may block hard invariant violations such as broken IDs, malformed schemas, missing citation links, invalid references, provider access failures, or export failures. It should not secretly decide semantic research questions such as whether a source is relevant, whether a claim is useful, or whether a research direction is promising.

## Core Concepts

- **Researcher model**: the main LLM that owns planning, tool choice, synthesis, and writing.
- **Research lab runtime**: the TypeScript/Node.js application that provides tools, storage, validation, logs, and exports.
- **Workspace database**: the canonical project memory in `.clawresearch/workspace.sqlite`.
- **Living notebook**: a compact model-owned project notebook stored in the workspace, containing the objective, definition of done, current tasks, readiness notes, and artifact links.
- **Critic**: an optional reviewer call that can provide feedback when the researcher chooses `critic.review`; critic feedback is visible to the model and does not silently rewrite the workspace.
- **Manuscript finalization**: the explicit `manuscript.finalize` tool writes `paper.md` only after mechanical export invariants pass.

## Quickstart

Install dependencies:

```bash
npm install
```

Start the terminal UI in the current project:

```bash
npm run dev
```

Use the plain line-oriented console for scripts, pipes, or debugging:

```bash
npm run dev -- --plain
```

Use a different project root:

```bash
npm run dev -- --project-root /path/to/project
```

Build and run compiled JavaScript:

```bash
npm run build
node dist/src/cli.js
```

Show CLI help:

```bash
npm run dev -- --help
```

## Model Setup

The default local path uses Ollama.

Current local-model assumption:

- `ollama` is installed and running locally
- a capable model is available, for example `qwen3:14b` or a stronger local model

Override the Ollama model:

```bash
CLAWRESEARCH_OLLAMA_MODEL=your-model-name npm run dev
```

Hosted model and provider support is being developed through the same backend abstraction. The architecture expects stronger models to perform better because the runtime intentionally does not replace the researcher with hidden deterministic research logic.

## Console Flow

On startup, ClawResearch opens a research intake conversation. The intake chat helps clarify:

- topic
- research question
- research direction
- success criterion

When the brief is good enough, run:

```text
/go
```

`/go` starts or resumes the autonomous research worker for the current objective. The worker continues from the project workspace and streams readable progress events in the terminal.

Useful slash commands:

- `/help`
- `/status`
- `/sources`
- `/paper`
- `/paper open`
- `/paper checks`
- `/go`
- `/pause`
- `/resume`
- `/quit`
- `/exit`

## Source Providers

New projects open a provider checklist at startup. The default selection is:

- scholarly discovery: `openalex`, `crossref`, `dblp`, `pubmed`
- publisher / full text: `arxiv`, `europe-pmc`
- OA / retrieval helpers: `core`, `unpaywall`
- general web: none
- local context: on

Inside the TUI:

- `Up` and `Down` move through providers
- `Space` or `Enter` toggles a provider
- `S` saves the current selection
- `Esc` leaves the overlay

`/sources` reopens the checklist later.

Credentialed providers are selectable but off by default, including:

- scholarly discovery: `elsevier`
- publisher / full text: `ieee-xplore`, `springer-nature`

When credentials are needed, ClawResearch asks for the key, token, or email directly and stores it only in the local runtime folder.

## Workspace And Files

Project runtime state lives in:

```text
.clawresearch/
```

Important project-level files:

- `.clawresearch/session.json`: console session state
- `.clawresearch/project-config.json`: source and runtime configuration
- `.clawresearch/credentials.json`: local credentials
- `.clawresearch/workspace.sqlite`: canonical research workspace
- `.clawresearch/console-transcript.log`: raw console transcript

Detached run logs live under:

```text
.clawresearch/runs/<run-id>/
```

Run directories are for observability and exports. Typical files include:

- `run.json`
- `trace.log`
- `events.jsonl`
- `stdout.log`
- `stderr.log`
- `agent-state.json`
- `agent-steps.jsonl`
- `paper.md`
- `paper.json`
- `references.json`
- `manuscript-checks.json`

The canonical research state is the SQLite workspace, not the run artifacts.
ClawResearch does not maintain a separate `research-journal.json`, `notes.json`, or `memory.json`; project memory is derived from `workspace.sqlite`.

The workspace stores durable research objects such as:

- living research notebook
- protocols
- provider runs
- sources and canonical sources
- screening decisions and full-text/access records
- extractions and evidence cells
- claims, support links, citations, and manuscript sections
- researcher-authored work items
- release checks and worker state

## Model-Facing Tools

The production action surface is intentionally explicit. The model can inspect and mutate the workspace through tools such as:

- `notebook.read`
- `notebook.patch`
- `workspace.list`
- `workspace.search`
- `workspace.read`
- `workspace.create`
- `workspace.patch`
- `protocol.create_or_revise`
- `source.search`
- `source.merge`
- `source.resolve_access`
- `source.select_evidence`
- `extraction.create`
- `evidence.create_cell`
- `evidence.matrix_view`
- `claim.create`
- `claim.patch`
- `claim.link_support`
- `claim.check_support`
- `section.create`
- `section.patch`
- `section.link_claim`
- `critic.review`
- `release.verify`
- `manuscript.finalize`
- `workspace.status`
- `guidance.search`
- `guidance.read`
- `guidance.recommend`

Tool failures are returned as observations with repair context. For example, if `claim.link_support` is missing a claim ID or evidence cell ID, the runtime returns nearby valid claims, evidence cells, sources, and cautious next hints instead of silently creating a bad citation.

## Final Paper

The main publishable export is:

```text
paper.md
```

It is generated by `manuscript.finalize` from workspace sections, claims, support links, citations, and references. Mechanical checks must pass before the file is written. Research sufficiency remains a model judgment supported by the notebook, work items, critic feedback, and explicit release checks.

## Development

Run type checks:

```bash
npm run check
```

Run the full test suite:

```bash
npm test
```

The test suite includes architecture-contract tests that guard against reintroducing hidden research workflows, legacy action aliases, runtime-generated recovery queries, fallback evidence selection, and automatic source-to-manuscript phase behavior.

## Design Direction

ClawResearch should stay small and task-driven:

- keep the workspace canonical
- keep tools explicit and observable
- keep semantic judgment with the model
- keep runtime validation mechanical
- keep guidance visible and overridable
- delete obsolete pipeline-style code instead of preserving it for compatibility

The goal is a research IDE for the model: simple enough to operate, durable enough to support long research projects, and strict enough to preserve provenance and export integrity.
