# ClawResearch Reset Development Concept

## Purpose

This is the concise implementation concept for the next ClawResearch attempt.

The full research and reasoning background lives in:

- `docs/autonomous-research-agent-literature-synthesis.md`
- `docs/release-1-review-paper-agent-concept.md`

This document is the practical version to start coding against.

## Reset Thesis

ClawResearch should restart as:

> a console-first autonomous research runtime for empirical computational research that starts from a research conversation, runs inside the current project directory, executes long-horizon experiment loops, persists jobs and findings across restarts, and incrementally turns those findings into useful research artifacts.

This is intentionally narrower than the previous direction.

## Implementation Language

The reset should use TypeScript on Node.js rather than Python.

This decision follows from the actual product we are building:

- a local agent harness
- a strong terminal experience
- readable streaming traces
- clean orchestration of external commands and tools
- simple packaging and installation

The runtime must be able to operate across polyglot research environments, but it does not need to be implemented in the same language as the codebases it studies or modifies.

## What We Are Not Building First

Not in the first reset core:

- a web platform
- a governance-heavy orchestration system
- approval gates everywhere
- policy-first safety architecture
- multi-user research management
- a general-purpose “AI scientist for all domains”

Those may come later, but they are not the starting point.

## Primary User Experience

The main interaction should be:

1. run `clawresearch`
2. discuss the research direction in chat
3. type `/go`
4. watch the autonomous runtime work in a readable terminal trace
5. interrupt only when needed

The current directory is the project.

## Minimal Architecture

### 1. Console Layer

- startup research chat
- `/go`, `/status`, `/pause`, `/resume`, `/quit`
- readable live trace

### 2. Runtime Core

- current research direction
- run orchestration
- persistence across restarts

### 3. Job Layer

- detached job execution
- polling and reconciliation
- log and output capture

### 4. Findings Memory

At minimum:

- idea
- selected direction
- implemented finding
- validated finding
- failed finding

### 5. Agent Backend Layer

- backend-agnostic
- local open models first-class
- hosted models still possible

### 6. Artifact Layer

- logs
- outputs
- notes
- summaries

## Non-Negotiable Requirements

### 1. Single-directory project model

No `workspace_root` / `codebase_root` split in the primary architecture.

### 2. Persistent jobs and runs

The system must survive interruption.

### 3. Closed research loop

- discuss
- propose
- implement
- run
- inspect
- revise
- repeat

### 4. Findings memory

The agent must not forget failed and successful directions.

### 5. Reproducibility metadata

At minimum:

- command
- timestamps
- code state
- config reference
- artifact paths

### 6. Hardening later

Safety, approvals, and governance are deferred until the runtime loop is clearly useful and debuggable.

## Development Order

### Phase 0

Treat the previous implementation as an experience archive.

### Phase 1

Build the new console-first shell.

### Phase 2

Build persistent runs and detached jobs.

### Phase 3

Build findings memory.

### Phase 4

Build repo-aware implementation and traceback-guided debugging.

### Phase 5

Build stronger summaries, artifact generation, and evaluation helpers.

### Phase 6

Add approvals, policy layers, and broader hardening only after the loop is stable.

## Recommended First Coding Targets

If starting fresh with Codex on the other machine, begin with:

1. `clawresearch` console entry
2. minimal persistent state schema
3. detached job runner
4. run trace persistence
5. findings memory primitives
6. one backend adapter for the local model path

## Success Criteria for the Reset

We should consider the reset successful if:

- the system is easy to start
- it can run long jobs and recover
- it accumulates findings instead of repeating itself blindly
- the live trace is readable enough to debug real runs
- the architecture stays small while the loop gets stronger
