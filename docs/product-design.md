# ClawResearch Product Design

## Purpose

ClawResearch already has the beginnings of a serious autonomous research runtime:

- persistent supervisor
- event log and structured research state
- managed jobs and approvals
- claim, evidence, and decision tracking
- pluggable agent backends

What it does **not** yet have is a product surface that makes this power feel simple, intuitive, and exciting.

This document defines the product experience for ClawResearch as a user-facing system.

The core product principle is:

> ClawResearch should feel like giving a research mission to a capable autonomous operator, not like manually driving an orchestration CLI.

The runtime remains the backend engine. The product becomes a web application built on top of that runtime.

## Product Positioning

ClawResearch is a local autonomous research operator for empirical coding and ML research.

It should help a user:

- state a research goal
- point the system at a codebase
- choose a model/runtime profile
- watch the research evolve
- intervene only when useful
- inspect evidence and decisions
- approve expensive actions
- receive a defensible local note, research package, or publication-ready draft

It is not primarily:

- a raw CLI tool
- a terminal-first orchestration framework
- a chatbot that forgets its state between turns
- a notebook replacement

It is a research control room.

## Product Goals

### Primary goals

- Make starting research feel immediate and obvious.
- Make autonomous progress legible to humans.
- Make long-running work safe and governable.
- Make research state readable without technical database inspection.
- Make approvals and interventions lightweight.
- Preserve the rigor and bounded autonomy of the runtime.

### Non-goals

- Replacing the runtime with a pure chat UI.
- Hiding all internals from power users.
- Building a generalized team collaboration platform in the first interface.
- Supporting every research domain equally well in the first interface.

## Product Thesis

The backend should remain structured and machine-oriented.
The frontend should translate that structure into a calm, intuitive operator experience.

A user should be able to answer these questions within seconds:

- What is the agent trying to prove?
- What has it learned so far?
- What is blocked?
- What is running?
- What does it want from me?
- Is this becoming publishable, or should it stay local?

## Target Users

### 1. Research engineer

A technically strong user with a codebase, experiments, and a concrete question.

Needs:

- fast setup
- visibility into jobs and evidence
- confidence that the system is not wasting compute

### 2. Research lead

A user who wants to monitor progress, approve expensive actions, and evaluate publication readiness.

Needs:

- concise summaries
- approval workflow
- clear decision history
- manuscript readiness visibility

### 3. Power user / operator

A user comfortable with CLI and deeper inspection.

Needs:

- UI first, but CLI still available
- direct access to logs, jobs, artifacts, and state when needed

## Product Shape

ClawResearch should become a local web application with three layers:

1. Runtime
2. Local API server
3. Web app

### Runtime

Existing `clawresearch` engine:

- supervisor loop
- jobs
- approvals
- event log
- claims, evidence, decisions
- agent adapters

### Local API server

A thin, local server that exposes the runtime in a UI-friendly format.

Responsibilities:

- project and workspace management
- status aggregation
- task creation
- approvals
- jobs inspection
- event/activity feed
- markdown artifact loading
- chat-like command ingestion
- live updates via polling or server-sent events

### Web app

A local frontend that presents ClawResearch as a research workspace rather than a command suite.

## Experience Principles

### 1. Start fast

The user should not need to understand all runtime concepts before beginning.

### 2. Show intent before detail

Show:

- research question
- current objective
- current blocker
- next action

before showing:

- raw events
- internal ids
- detailed metadata

### 3. Human summaries over raw JSON

All runtime state should be translated into readable UI language.

### 4. Chat is a control surface, not the whole product

The user should be able to steer the system conversationally, but the truth should live in visible project state.

### 5. Approvals should feel lightweight

The system should ask for approval with a clear cost, purpose, and expected value.

### 6. Research state must remain inspectable

The UI should stay friendly without becoming opaque.

## Core User Flows

## Flow 1: Start a new research mission

### User intent

"I want the agent to investigate a question in this codebase."

### UX

Landing screen with a single primary form:

- Research goal or question
- Codebase path
- Workspace name
- Model profile
- Optional notes
- Start Research button

### Result

The system:

- creates the workspace
- initializes policy defaults
- creates the initial research task
- starts the supervisor
- opens the project view

## Flow 2: Monitor autonomous progress

### User intent

"What is the agent doing, and is it making progress?"

### UX

Project dashboard shows:

- current status
- current research question
- top claims
- latest evidence
- active jobs
- latest decisions
- open approvals
- recent activity timeline

## Flow 3: Approve or reject expensive work

### User intent

"The agent wants to run something costly. Should I allow it?"

### UX

Approval cards with:

- title
- why this is needed
- expected compute cost
- expected artifacts
- what scientific uncertainty it reduces
- buttons: Approve / Reject

### Result

On approval:

- pending job materializes
- scheduler can start it

On rejection:

- decision is recorded
- planner gets a new constraint in the next turn

## Flow 4: Steer the research in plain language

### User intent

"Focus on the same-backbone baseline first."

### UX

A chat-style control box in the project page.

The user types natural language instructions.
The frontend translates this into a new task or control action.

Examples:

- "Continue and prioritize the same-backbone baseline."
- "Do not publish anything yet."
- "Pause experiments and summarize the evidence so far."
- "Focus on Heeten instead of OPSD."

This is not a free-floating conversation. Each instruction becomes one of:

- task creation
- project control action
- priority shift
- approval decision
- publication policy override

## Flow 5: Review the research package

### User intent

"Show me the scientific substance, not just system activity."

### UX

Dedicated Research tab with readable views for:

- research question
- problem formulation
- literature positioning
- method spec
- evaluation plan
- evidence log
- manuscript and self-review when present

## Flow 6: Decide whether to publish or keep local

### User intent

"Is this ready for public scientific review?"

### UX

Publication view shows:

- publish readiness summary
- blocking issues
- evidence sufficiency
- reproducibility status
- required self-review status
- recommended action:
  - keep local
  - continue research
  - draft manuscript
  - prepare for submission

## Information Architecture

## Global structure

- Home
- Projects
- Project detail

## Project detail sections

- Overview
- Activity
- Research
- Jobs
- Approvals
- Artifacts
- Publication
- Settings

## Screen Design

## 1. Home screen

Purpose:

- immediate first impression
- zero-friction launch

### Main elements

- headline: "Run autonomous research on your codebase"
- short explanation
- new research form
- recent projects list
- active projects summary

### Primary action

`Start Research`

## 2. Project overview

Purpose:

- one-screen answer to "what is happening?"

### Main cards

- Research Mission
- Current Status
- Next Recommended Action
- Open Approvals
- Active Jobs
- Publication Readiness
- Latest Findings

### Hero summary

A short system-generated natural-language summary like:

"The agent is investigating whether end-to-end MPC improves a separately trained predictor + MPC pipeline under matched conditions. The current blocker is a missing same-backbone baseline. A 12 GPU-hour TimesNet training run is awaiting approval."

## 3. Activity view

Purpose:

- timeline of actions and reasoning

### Each activity item should show

- timestamp
- action type
- human-readable summary
- optional linked artifacts
- optional linked claim/evidence/decision

Examples:

- "Planner reframed the question around same-backbone attribution."
- "Experiment request created: train TimesNet predictor on strict96."
- "Approval required: estimated 12 GPU-hours."
- "Analyst concluded manuscript is not publication-ready due to missing baseline."

## 4. Research view

Purpose:

- expose scientific content directly

### Layout

Left navigation:

- Question
- Problem
- Literature
- Method
- Evaluation
- Evidence
- Manuscript
- Self-review

Right pane:

- rendered markdown
- metadata chips
- last updated time

## 5. Jobs view

Purpose:

- make long-running execution understandable

### Job table columns

- status
- summary
- type
- GPU usage
- start time
- duration
- expected outputs
- source task

### Job detail drawer

- command
- cwd
- env summary
- logs
- reproducibility metadata
- output artifacts
- resulting evidence

## 6. Approvals view

Purpose:

- make approvals fast and confident

### Approval card content

- request title
- why this matters scientifically
- estimated cost
- blocking impact
- expected outcome
- linked task or job
- linked claim/open question
- approve / reject actions

## 7. Publication view

Purpose:

- decide the right terminal state for the project

### Sections

- publication readiness summary
- blockers
- reproducibility checklist
- manuscript presence/status
- self-review presence/status
- recommendation

## 8. Settings view

Purpose:

- keep advanced configuration out of the main flow

### Settings

- codebase path
- workspace path
- model backend
- policy thresholds
- compute budget
- publish policy
- allowed command profiles
- pause/resume project

## Chat and Command Experience

The product should include a chat-like input area, but it should not behave like a generic assistant chat.

### It should support

- natural-language task creation
- prioritization
- pauses
- asks for summaries
- asks for clarification from current state

### It should not be the only interface

Research state should remain visible in dedicated UI sections.

### Example interactions

User:
- "Continue and prioritize the same-backbone baseline."

System action:
- creates a high-priority planner or experimenter task
- records the instruction in activity
- shows updated priorities in the task list

User:
- "Summarize why publication is blocked."

System action:
- either answers from current state immediately
- or creates an analyst task if a fresh synthesis is needed

## API Design

The API is local-first and should sit on top of the runtime.

Base path:

- `/api`

## Projects

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `POST /api/projects/:id/pause`
- `POST /api/projects/:id/resume`

## Project summary and dashboard

- `GET /api/projects/:id/overview`
- `GET /api/projects/:id/activity`
- `GET /api/projects/:id/status`

## Tasks

- `GET /api/projects/:id/tasks`
- `POST /api/projects/:id/tasks`
- `POST /api/tasks/:id/cancel`
- `POST /api/tasks/:id/reprioritize`

## Approvals

- `GET /api/projects/:id/approvals`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`

## Jobs

- `GET /api/projects/:id/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/logs`

## Research state

- `GET /api/projects/:id/claims`
- `GET /api/projects/:id/evidence`
- `GET /api/projects/:id/decisions`
- `GET /api/projects/:id/artifacts`
- `GET /api/projects/:id/artifacts/:artifact_id`

## Control / chat-style interactions

- `POST /api/projects/:id/commands`

Example command payloads:

- `{ "text": "Continue and prioritize the same-backbone baseline." }`
- `{ "text": "Pause all new experiments and summarize the current evidence." }`

The backend translates these into structured actions.

## Live updates

One of:

- `GET /api/projects/:id/stream` via server-sent events
- lightweight polling fallback

## Backend Requirements for the API Layer

The API server needs an application service layer that aggregates runtime state into user-facing summaries.

This layer should:

- convert raw task payloads into readable descriptions
- convert claims, evidence, and decisions into concise summaries
- derive project overview state
- derive current blocker
- derive next recommended action
- expose approval cards with scientific rationale

This is important: the UI should not reconstruct product meaning from raw tables.

## Data Presentation Rules

### Internal ids should be de-emphasized

IDs may exist in advanced views, but the main product should show names and summaries.

### JSON should never be the default representation

Everything user-facing should be translated into:

- prose
- status chips
- cards
- tables
- markdown rendering

### State should be legible at a glance

The top-level project screen should always expose:

- current objective
- current blocker
- active jobs
- pending approvals
- most recent decision

## Design Direction

The UI should not feel like a database console.

It should feel:

- calm
- focused
- serious
- slightly ambitious
- less like DevOps
- more like a mission control room for research

### Visual direction

- clean typographic hierarchy
- dark-on-light or warm paper-like surfaces by default
- strong status color system
- bold but restrained accent color
- roomy cards
- prominent summaries
- reduced motion support

### Suggested design language

- human-readable research notebook meets mission control
- not hacker terminal cosplay
- not generic SaaS admin panel

## Recommended Frontend Stack

Because the runtime is local and the product is stateful, the simplest strong choice is:

- Next.js or React SPA frontend
- lightweight Python local API server
- server-sent events or polling for live updates

Two reasonable implementation paths:

### Option A

- Python API server inside `clawresearch`
- React frontend in a sibling app package

### Option B

- Python serves both API and static frontend assets

Preferred direction:

- Python API in `clawresearch`
- React frontend as a separate app inside the same repo or monorepo later

## First Build Slice

The first user-facing release should include:

### Required

- Create project screen
- Project overview dashboard
- Approvals screen
- Jobs screen
- Research artifacts viewer
- Activity feed
- Command input box
- Pause/resume controls

### Optional later

- rich manuscript editor
- side-by-side diffing of research artifacts
- multi-project comparisons
- multi-user collaboration
- public share views

## Recommended Implementation Order

### Step 1: API layer

Add a local API server with:

- project listing and creation
- project overview
- tasks
- approvals
- jobs
- claims/evidence/decisions
- command submission

### Step 2: Minimal web app shell

Build:

- home page
- project page shell
- overview cards
- approvals list
- jobs list

### Step 3: Research document views

Render markdown artifacts in the UI.

### Step 4: Command input

Allow natural-language instructions to become tasks and control actions.

### Step 5: Live updates

Add polling or streaming so the UI feels alive.

### Step 6: Publication surface

Add manuscript, self-review, and publication readiness views.

## CLI Role After UI Exists

The CLI remains valuable for:

- debugging
- scripting
- CI
- power users
- remote/headless administration

But it is no longer the default product surface.

## Product Success Criteria

The interface is successful if a new user can do the following without reading CLI docs:

1. create a new research mission
2. point it at a codebase
3. start the agent
4. understand what it is doing
5. approve or reject expensive actions
6. inspect why the system believes something
7. see whether work should stay local or move toward publication

## Immediate Next Product Decision

The next implementation step should be:

- build a local API layer inside `clawresearch`
- then build a web app on top of it

Not:

- add more CLI subcommands first
- expand raw JSON output first
- add more hidden runtime complexity without a product surface

## Short Product Summary

ClawResearch should evolve from:

- a powerful autonomous research runtime with a developer-facing CLI

into:

- a local research control room where a user can launch, monitor, steer, and approve autonomous research with almost no ceremony.
