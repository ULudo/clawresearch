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
npm run dev -- --docs
```

After dependencies are installed, the scaffold can also be built and run as compiled JavaScript:

```bash
npm run build
node dist/src/cli.js --docs
```

The current command is only a bootstrap shell that points at the reset docs. The real runtime is meant to be rebuilt from here.

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
