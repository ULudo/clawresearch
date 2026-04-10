# ClawResearch

ClawResearch is being reset around a smaller and more practical goal:

> a console-first autonomous research runtime for empirical computational research

The previous implementation taught us a lot, but it also grew too quickly into a platform- and governance-heavy architecture. This repo now treats that first version as prototype history and uses the new concept as the source of truth for the next implementation.

## Start Here

If you are pulling this repo to begin the rewrite, read these in order:

1. `/Users/uludo/Documents/New project/clawresearch/docs/reset-development-concept.md`
2. `/Users/uludo/Documents/New project/clawresearch/docs/autonomous-research-agent-literature-synthesis.md`
3. `/Users/uludo/Documents/New project/clawresearch/docs/archive/product-design-v1.md` only if you want to inspect the older direction

## Current Direction

The reset version of ClawResearch should be:

- console-first
- current-directory-as-project
- persistent across restarts
- capable of detached long-running jobs
- findings-memory-driven
- backend-agnostic across local and hosted models

What it should **not** start as:

- a web platform
- a research management control plane
- a governance-heavy system
- a generalized autonomous scientist for every domain

## Reset Priorities

The next implementation should begin with:

1. `clawresearch` as a single-command console entry
2. minimal persistent run/session state
3. detached job execution and reconciliation
4. readable live trace plus persisted run trace
5. findings memory with simple maturity states
6. one solid local-model backend path

## Why the Repo Looks the Way It Does

The current source tree still contains the first prototype implementation. It should be treated as:

- a source of lessons
- a source of a few potentially reusable utilities
- **not** the architectural foundation that must be preserved

The reset concept intentionally favors:

- directness
- debuggability
- real long-running research loops

over:

- early approval systems
- policy-first safety layers
- UI/platform breadth

## Development Environment

For this project, the recommended primary development machine is the one that already hosts:

- the offline/open model
- the larger storage budget
- the heavier experiment runtime

That keeps development and real execution in the same environment.

## Packaging

The current package entrypoints remain in the repo because they are useful reference points during the reset:

- `clawresearch`
- `clawresearchd`
- `clawresearch-api`

But the reset development concept should drive what gets kept, replaced, or deleted next.
