# ClawResearch Reset Handoff

Date: 2026-04-24

This document is a compact orientation for continuing the ClawResearch reset in a fresh Codex chat. It describes what the current system is meant to be, how the runtime state is organized, what invariants matter, and where development should continue.

## Product Vision

ClawResearch is an autonomous research runtime for research projects.

It should not be restricted to one domain. Current models are especially useful for coding-heavy work, and the runtime can use code execution well, but the product goal is broader: support research projects in any field where a useful research process can be made explicit, inspected, and improved. That can include computational research, literature-heavy research, mathematics, empirical science, engineering, or other domains.

The long-term goal is a full autonomous research system. The near-term goal is to build the reliable kernel of that system: a console-first local runtime that helps define a research direction, builds expertise through literature review, proposes next research steps, and eventually executes original research loops with appropriate user involvement.

Professional scientific communication is part of the long-term goal. ClawResearch should eventually write high-quality research papers that communicate its findings at a real scientific standard. Those papers should be suitable for publication and communication on `clawreview.org`, a site intended for autonomous agents doing research. Current simple coding-agent paper outputs are not good enough for that standard; improving scientific paper quality is a central motivation for this runtime.

## Research Process

The intended user loop is:

1. Run `clawresearch` in a project directory.
2. Discuss the project with an agent that acts like a research consultant.
3. Define a clear research topic, question, direction, scope, and success criterion.
4. Type `/go` to start the first autonomous research phase.
5. Begin with an extended literature review to understand what is already known, what remains open, where the problems are, and which research questions matter.
6. Produce useful literature-review outputs: ideally a high-quality review-style report that summarizes the field, organizes the evidence, identifies open problems, and proposes concrete tasks.
7. Use that accumulated expertise to start original research: experiments, calculations, coding, evaluation, proof attempts, or other domain-appropriate work.
8. Persist the evolving research state locally so later runs build on what has already been learned.

The first conversation is not a form. It should feel like briefing a capable external researcher or consultant. Often the user does not know the exact question yet, so the agent should help by asking good questions, offering examples, naming possible directions, recommending the most promising path, and clarifying what the research is for.

The current trigger for leaving the scoping conversation and starting autonomous work is `/go`. That command is just the current interface choice; conceptually it means "the research direction is clear enough, start the research process."

The system should feel closer to a thoughtful research partner in a terminal than a rigid CLI. The current directory is the project. The architecture should stay inspectable, local-first, and debuggable.

## Autonomy And User Involvement

The user should be treated like the customer or principal investigator for the research project.

ClawResearch should not annoy the user with constant interruptions, but it also should not run far in a direction that no longer matches what the user intended. The goal is the right balance:

- work autonomously when the task is clear
- preserve detailed artifacts so autonomous work can be audited
- stop and discuss when direction, scope, cost, risk, or interpretation becomes uncertain
- present what was done and what was learned in a natural way
- offer concrete next directions and recommendations
- let the user clarify purpose, priorities, and acceptable tradeoffs

The interaction should remain natural and supportive. The user may need help discovering what they actually want; the agent should support that process rather than merely ask for missing fields.

## What ClawResearch Is Not Yet

ClawResearch is not yet a full autonomous research system. It should not pretend that one run produces publication-ready truth.

The current target is more modest and more useful:

- maintain a durable research journal
- maintain a canonical literature library
- run bounded literature-review and work-package passes
- keep an audit trail for every `/go`
- make evidence, claims, verification, and next directions inspectable
- avoid losing context between runs

The future target is broader:

- become expert in a topic through high-quality literature review
- produce review-paper-like outputs when appropriate
- identify open research questions and concrete tasks
- execute original research loops
- add experiments, code, evaluations, calculations, findings, and failed directions back into the research state
- write professional research papers that meet scientific standards for communication and eventual publication
- know when to continue autonomously and when to return to the user for a real discussion

Web UI, heavy governance, multi-user collaboration, and broad safety/policy layers are intentionally deferred. The current priority is the research kernel: a strong console app and a reliable local research process that other interfaces can later build on.

## Core State Model

There are two levels of state.

### Project-Level State

Project-level files represent the current accumulated understanding of the research project. These are the files future runs should consult and update.

```text
.clawresearch/
  session.json
  project-config.json
  credentials.json
  console-transcript.log
  research-journal.json
  library.json
  research-direction.json
  runs/
```

`session.json`

Stores the current console/session state: the research brief, saved startup conversation, active run id, last run id, intake backend state, and run counters.

`project-config.json`

Stores selected source providers and runtime settings. Credentials are not stored here.

`credentials.json`

Stores local provider credentials outside project config.

`research-journal.json`

The agent's durable research journal. This is a core file, not casual notes. It stores agent-derived research knowledge such as findings, claims, hypotheses, ideas, questions, summaries, candidate directions, method plans, and artifact links.

`library.json`

The canonical paper library for the project. It stores paper identity, metadata, provider discovery records, access state, screening state, screening history, theme boards, and review notebooks.

`research-direction.json`

The current accepted research agenda/direction. It is produced from a run agenda and represents the current global direction the project should continue from.

### Run-Level State

Run-level files represent what happened during one `/go` execution. They are provenance and audit trail, not the primary long-term memory.

```text
.clawresearch/runs/run-.../
  run.json
  brief.json
  plan.json
  sources.json
  literature-review.json
  paper-extractions.json
  evidence-matrix.json
  synthesis.md
  claims.json
  verification.json
  next-questions.json
  agenda.json
  agenda.md
  work-package.json
  summary.md
  research-journal.json
  events.jsonl
  trace.log
  stdout.log
  stderr.log
```

`run.json`

Run metadata: status, stage, timestamps, worker pid, command, parent run, and artifact paths.

`brief.json`

The frozen brief used for this run.

`plan.json`

The run's planned research mode, objective, rationale, search queries, and local focus.

`sources.json`

Raw provider hits, source routing, auth status, provider notes, review workflow details, and merge diagnostics.

`literature-review.json`

The run-specific literature snapshot: papers seen by this run, reviewed papers selected for synthesis, review workflow, access/auth state, and insert/update counts into the global library.

`paper-extractions.json`

Per-paper structured extraction from reviewed papers. This is where the system records what each paper says about problem setting, system type, architecture, tools and memory, planning style, evaluation setup, success signals, failure modes, limitations, supported claims, confidence, and evidence notes.

`evidence-matrix.json`

Cross-paper evidence organization derived from paper extractions. It contains matrix rows plus derived patterns, anti-patterns, gaps, and conflicts.

`synthesis.md`

Human-readable synthesis/report for the run. It summarizes the reviewed evidence, themes, claims, verification status, evidence matrix insights, paper extractions, and next questions.

`claims.json`

Structured claims extracted from the synthesis.

`verification.json`

Claim support audit. It checks whether synthesized claims are supported, partially supported, unverified, or explicit unknowns based on the cited canonical papers and access state.

`next-questions.json`

Follow-up questions derived from the run.

`agenda.json`

The run's proposed research agenda: gaps, candidate directions, selected direction, selected work package if any, hold reasons, and recommended human decision.

`agenda.md`

Human-readable view of `agenda.json`.

`work-package.json`

The selected bounded next work package, if the run found one.

`summary.md`

Short run summary.

`research-journal.json`

Snapshot of journal records written by this run. The global project journal is still `.clawresearch/research-journal.json`.

`events.jsonl`, `trace.log`, `stdout.log`, `stderr.log`

Debug and live-trace artifacts used by the console watcher.

## Important Distinctions

### Global Files vs Run Files

Global files are the current project truth. Run files are evidence and provenance.

A run should not force future runs to reconstruct state by scanning every past run. Instead, a run should write its detailed artifacts, then merge durable knowledge into global files:

- `research-journal.json`
- `library.json`
- `research-direction.json`

### Library vs Literature Review

`library.json` is the accumulated canonical paper library across the whole project.

`runs/run-.../literature-review.json` is one run's literature review snapshot.

This distinction matters because multiple runs can discover, screen, and reuse overlapping papers. The project needs one stable paper graph, while each run still needs an audit trail of what it saw and selected.

### Research Journal vs Library

`research-journal.json` stores the agent's derived research thinking.

`library.json` stores canonical paper facts and literature structure.

Papers should not be mirrored as generic journal records. Journal records should link to paper ids when needed.

### Evidence Matrix vs Verification

`evidence-matrix.json` organizes what the reviewed papers say and derives cross-paper patterns, gaps, conflicts, and anti-patterns.

`verification.json` audits whether the synthesized claims are actually supported by the cited evidence.

In short:

- Evidence matrix: "What evidence do we have?"
- Verification: "Are our claims justified by that evidence?"

### Agenda vs Research Direction

`runs/run-.../agenda.json` is what one run proposes.

`.clawresearch/research-direction.json` is the current accepted/global research direction.

Keeping both is useful because one run may propose action while another may recommend holding for more evidence. The global direction should represent the current project decision.

### Reports vs Papers

`synthesis.md` and `summary.md` are current run artifacts for debugging and human inspection. They are not yet professional papers.

The long-term writing target is stronger: ClawResearch should eventually produce publishable research papers that communicate the literature, methods, evidence, findings, limitations, and open questions at scientific standard. The current report artifacts should evolve toward that goal instead of remaining generic agent summaries.

## Current Pipeline

The current implemented pipeline is still mostly the first autonomous phase: literature review and agenda generation. It does not yet fully execute original research.

A current literature-review run roughly does this:

1. Load session, research journal, project config, credentials, and library context.
2. Plan a bounded research mode and source strategy.
3. Route providers by domain and task type.
4. Gather raw sources and scholarly discovery hits.
5. Merge provider hits into canonical papers.
6. Resolve access state and screening state.
7. Select reviewed papers for synthesis.
8. Upsert papers, themes, and notebooks into `library.json`.
9. Extract structured per-paper records into `paper-extractions.json`.
10. Build `evidence-matrix.json`.
11. Synthesize themes, claims, and next questions.
12. Verify claims into `verification.json`.
13. Generate a run agenda into `agenda.json`.
14. Write/update global `research-direction.json`.
15. Write journal records into both the run snapshot and global `research-journal.json`.
16. Stream readable events to the console.

The intended later pipeline extends this with original research work:

1. Select or confirm a research direction / work package.
2. Design a method, experiment, proof attempt, implementation plan, or evaluation.
3. Execute the work with the right tools for the domain.
4. Debug or revise when the work fails.
5. Evaluate results against the success criterion.
6. Add findings, negative results, hypotheses, and next questions back into the research journal.
7. Return to the user when direction, interpretation, or priority needs discussion.

## Non-Negotiable Invariants

Canonical paper IDs must be stable and joinable across artifacts.

The same paper must use the same canonical ID in:

- `library.json`
- `literature-review.json`
- `paper-extractions.json`
- `evidence-matrix.json`
- `claims.json`
- `verification.json`
- `agenda.json`
- `research-journal.json`

Run-local IDs such as `paper-1` must not leak into durable cross-artifact references once canonical IDs are available.

The journal and library must remain separate.

The project-level files should be the current truth, while run directories should remain audit trails.

Legacy paths should still be readable where possible:

- `.clawresearch/memory.json`
- `.clawresearch/notes.json`
- `.clawresearch/literature/library.json`

New writes should use:

- `.clawresearch/research-journal.json`
- `.clawresearch/library.json`
- `.clawresearch/research-direction.json`
- `.clawresearch/runs/run-.../literature-review.json`

## What The Live Test Showed

A live run in `~/Development/Python/research-test` showed that the previous layout produced useful information but too much duplicated bulk.

After two runs, the global library already contained hundreds of canonical papers, while each run also stored large `sources.json` and literature snapshots. This supports the current design principle:

- keep global files as living state
- keep run files as audit trail
- avoid forcing future runs to rebuild state from all previous run directories
- keep per-run snapshots, but make their role explicit

The live test also showed that one run can produce a concrete work package while another run can recommend holding for better evidence. That is why `agenda.json` remains per-run and `research-direction.json` exists globally.

## Current Verification

As of this handoff:

```bash
npm run check
npm test
```

passed locally.

The latest full test run reported:

```text
77/77 tests passing
```

## Where To Continue

The system is structurally coherent enough to continue with quality hardening.

Recommended next work:

1. Run a fresh `/go` in a real project and inspect the new artifact layout.
2. Verify that new runs write `research-journal.json`, `library.json`, `research-direction.json`, and per-run `literature-review.json`.
3. Check that legacy global stores load but new writes use the new names.
4. Improve the consultant-style scoping conversation:
   - help the user discover the research topic and question naturally
   - offer examples and candidate directions when the user is uncertain
   - explain why a proposed direction is useful
   - produce a clear, bounded brief before `/go`
5. Improve literature precision:
   - stronger negative filtering for generic/off-topic papers
   - domain profiles with required and excluded concepts
   - better provider and venue priors
   - reranking before full review
   - stricter screening rationales
6. Improve literature-review outputs:
   - move toward a high-quality review-paper-style report
   - summarize the field and evidence clearly
   - identify open questions, unresolved problems, and concrete next tasks
   - distinguish what is known from what is speculative
   - make the output a stepping stone toward professional research papers, not just an agent summary
7. Improve extraction quality:
   - avoid low-value "not explicitly mentioned" filler
   - distinguish unknown from weakly supported
   - prefer explicit evidence over broad paper summaries
8. Improve evidence matrix quality:
   - derive only meaningful patterns, gaps, conflicts, and anti-patterns
   - ignore repeated low-information unknowns
   - make matrix insights useful for agenda generation
9. Build the original-research phase after the literature-review phase is strong:
   - method planning
   - experiment/proof/implementation execution
   - evaluation
   - failed-direction memory
   - result integration into the journal and report
10. Build the scientific-writing layer:
   - turn review and research outputs into professional paper drafts
   - enforce scientific standards for claims, evidence, method description, limitations, and citations
   - target eventual communication/publication through `clawreview.org`
   - explicitly improve over the low-quality paper outputs produced by simple coding agents
11. Improve the autonomy/user-discussion boundary:
   - continue autonomously when direction is clear
   - return to the user when purpose, scope, interpretation, risk, or priority needs discussion
   - present options and recommendations instead of only asking open-ended questions
12. Review whether `synthesis.md` and `summary.md` should remain separate or become one clearer report artifact.
13. Review whether per-run `sources.json` and `literature-review.json` should be compacted to reduce duplicated bulk.

## Fresh Chat Prompt

Use this prompt to start a new Codex chat:

```text
You are working in /home/uli/Development/Python/clawresearch.

First read these files:

- README.md
- docs/reset-development-concept.md
- docs/autonomous-research-agent-literature-synthesis.md
- docs/console-reset-chat-handoff.md

Then inspect the current worktree.

Context:
- ClawResearch is a console-first TypeScript/Node autonomous research runtime for research projects in general, not only coding-heavy work.
- The first interaction should feel like a research-consultant scoping conversation: help the user define topic, question, direction, purpose, and success criterion before `/go`.
- The first autonomous phase should build expertise through a strong literature review: what is known, what is open, where the problems are, and which concrete tasks should be tackled next.
- The long-term goal is a full autonomous research system that can later do original research work such as experiments, implementation, calculations, proof attempts, evaluation, and integration of findings.
- The system should eventually write professional research papers suitable for scientific communication on clawreview.org; current simple coding-agent papers are far below the needed standard.
- The project-level core files are .clawresearch/session.json, .clawresearch/research-journal.json, .clawresearch/library.json, and .clawresearch/research-direction.json.
- Per-run files under .clawresearch/runs/run-... are audit/provenance artifacts.
- The run-level literature snapshot is literature-review.json.
- The durable research journal is research-journal.json.
- The canonical paper library is library.json.
- The global accepted agenda/direction is research-direction.json.
- Canonical paper IDs must stay stable and joinable across library, literature review, extraction, matrix, claims, verification, agenda, and journal artifacts.
- The user should be treated like the customer / principal investigator: avoid unnecessary interruptions, but return for natural discussion when direction, scope, interpretation, risk, or priorities need clarification.

Start by running:

npm run check
npm test

If either fails, fix it first.

Then continue with quality hardening:
- improve the consultant-style research scoping conversation
- improve literature precision
- improve the review-paper-style literature output
- improve the scientific writing / paper-generation path
- improve paper extraction quality
- reduce low-information evidence-matrix insights
- prepare the path toward original research execution after the literature-review phase
- keep the artifact model simple and debuggable
- preserve backward compatibility for old .clawresearch/memory.json, .clawresearch/notes.json, and .clawresearch/literature/library.json where reasonable

Work directly in the codebase and keep changes small, tested, and aligned with the reset concept.
```
