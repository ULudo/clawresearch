# ClawResearch Development Coordination

## Mission

Make the current ClawResearch concept work as intended:

- The model is the researcher.
- ClawResearch is the laboratory / SDK / runtime.
- The runtime provides tools, storage, provenance, observability, crash recovery, provider routing, checkpoints, exports, and mechanical invariants.
- The runtime must not secretly become the researcher through fixed workflows, hidden lexical gates, deterministic quality heuristics, premature stop rules, or old research-manager logic.

The goal of this campaign is not a pretty demo. The goal is to determine whether the model-as-researcher concept can produce serious research artifacts when the implementation, tools, observations, notebook, critic, and finalization semantics are designed correctly.

## Current Baseline

- The repository currently contains uncommitted runtime and test changes from the latest contract-aware finalization work.
- Latest inspected live run: `/home/uli/Development/Python/research-test/test-08`.
- `test-08` completed without process failure and finalized a `research_brief`.
- Source discovery worked well, but synthesis/citation propagation collapsed:
  - 229 canonical sources
  - 12 selected synthesis sources
  - 12 extraction rows / 11 unique extracted sources
  - 1 evidence cell
  - 3 claims
  - 3 manuscript sections
  - 1 rendered reference
- No critic review ran in `test-08` because the run mission was `research_brief`; current critic gating is mandatory only for `professional_paper`.
- `extraction.create` now blocks bad process-text persistence, but the model still had many blocked attempts before discovering the accepted content shape.

## Working Hypotheses

1. The core concept may still be viable, but the model is spending too much effort operating a brittle research database/tool API instead of doing research.
2. The biggest current failure is not search; it is conversion of selected/extracted sources into durable evidence cells, claims, support links, citations, and manuscript argument structure.
3. `research_brief` finalization is currently too permissive if it can produce one-reference papers from a broader selected corpus without critic review.
4. The critic path must either be truly available and meaningful or invisible to the model. A no-op or optional critic encourages false confidence.
5. Tool results must act like a research IDE: clear accepted shapes, valid IDs, precise repair hints, and useful previews.

## Baseline Failure Diagnosis From `test-08`

The core concept did not obviously fail in `test-08`: the model planned, used the notebook, searched, selected, extracted, created claims/sections, verified, and finalized through explicit tools. The failure is implementation/interface quality.

Converged findings:

- Source discovery worked: 229 canonical sources and 12 selected synthesis sources.
- Exact selected evidence state is not canonical enough in SQLite; diagnostics can confuse broad `include` state with actual selected synthesis state.
- The model created 12 extraction rows but only 11 unique selected-source extractions; one source was duplicated and one selected source was missed.
- `extraction.create` correctly blocked bad process-text persistence, but the model still hit 20 blocked attempts because the accepted payload shape was not obvious enough.
- Only 1 durable evidence cell was created, and it was a cross-source synthesis paragraph attributed to one source.
- All final support links rendered through that one source, so 12 selected papers collapsed to 1 reference.
- Release checks counted extraction rows as evidence coverage and allowed `research_brief` finalization with one evidence cell/reference.
- No critic review ran because the current finalization contract requires critic approval only for `professional_paper`, not `research_brief`.
- Critic approval is currently inferred from notebook artifact-link summaries, which are too model-writable to serve as authoritative release state.
- Notebook tasks were actively used, but notebook links can drift or name nonexistent artifacts.

Conclusion: first fixes should make the lab easier to operate and make structural attrition impossible to miss or finalize around. Do not add hidden semantic judging.

## Coordination Protocol

- Keep this file current after each major investigation, implementation slice, or live test.
- Record decisions, not just observations.
- Prefer deletion of bad legacy paths over compatibility patches.
- Keep the architecture principle stable unless evidence strongly proves it unworkable.
- Every observed failure should become either:
  - a targeted implementation task,
  - a regression test,
  - a deliberate non-goal,
  - or an open design question.

## Active Workstreams

1. Artifact / live-run forensics.
2. Tool-contract and observation ergonomics.
3. Critic availability, review contract, and finalization semantics.
4. Evidence/synthesis/citation dataflow.
5. Regression and live evaluation harness.

## Delegated Investigations

- Subagent A / live-run forensics: inspect `test-08` tool sequence, workspace state, final artifact, and quality collapse.
- Subagent B / tool ergonomics: audit model-facing action schema, tool observations, repair hints, and prompt/guidance friction.
- Subagent C / critic/finalization: audit critic availability, finalization contract, `research_brief` permissiveness, and critic gating.
- Subagent D / dataflow: audit selected sources -> extractions -> evidence cells -> claims -> support links -> citations -> references.

## Decision Log

- 2026-05-11: Start coordinated development campaign with subagents. Use `test-08` as the first baseline failure case.
- 2026-05-11: Treat `test-08` as an implementation/interface failure, not a proof that the model-as-researcher concept is dead.
- 2026-05-11: First implementation slice should address critic/finalization authority, extraction/evidence tool ergonomics, and structural source/evidence/reference attrition diagnostics.
- 2026-05-11: Implemented first slice with two workers:
  - Tool ergonomics: typed common `workStore.entity` fields, action recipes, payload fallback preservation.
  - Dataflow/finalization: source/evidence/reference disposition diagnostics, fixed evidence coverage wording, runtime-owned release critic authority, `research_brief` finalization now requires release critic pass.
- 2026-05-11: Validation after first slice: `npm run check` passed; `npm test` passed with 162 tests.
- 2026-05-11: Live validation in `/home/uli/Development/Python/research-test/codex-coordination-01` showed a real improvement over `test-08`: the model selected 12 sources, created 12 extractions, created 12 evidence cells, created 5 claims, linked support to 5 rendered references, ran release checks, and called the critic. It did not finalize a weak paper. Remaining blocker was a false diagnostic: the workspace counted every screened-in `include` as "selected" and told the model 156 sources remained selected even after `source.select_evidence replace` set the evidence set to 12.
- 2026-05-11: Fixed exact evidence-set persistence and diagnostics: worker evidence state now stores the explicit selected source IDs, source checkpoints persist them immediately, and disposition/notebook diagnostics prefer those IDs over broad screening includes. Added regression test for screened includes vs exact selected evidence IDs. Validation: `npm run check` passed; `npm test -- --test-name-pattern "workspace disposition diagnostics"` ran the compiled suite with 163 passing tests.
- 2026-05-11: Tightened selected-state semantics further: removed the remaining fallback from screened `include` records to selected sources. After explicit empty selection, diagnostics now report zero selected sources instead of all screened includes. Critic review packets now use exact selected IDs plus cited IDs, not every screened include. Added regressions for empty selection and critic packets. Validation: `npm run check` passed; full `npm test` passed with 165 tests.
- 2026-05-11: Improved release repair routing: artifact-contract blockers now dominate next hints over generic notebook cleanup, and artifact diagnostics include concrete source-disposition IDs plus suggested repair actions. This should reduce notebook churn after `release.verify`/`manuscript.finalize` failures. Validation: `npm run check` passed; full `npm test` passed with 165 tests.

## Open Questions

- Should `critic.review` be mandatory for every `manuscript.finalize`, or only for `professional_paper`? Current evidence favors mandatory release critic for every `paper.md` export.
- Should `research_brief` be allowed as a final artifact, or should it be treated as an internal checkpoint unless explicitly requested by the user? Current evidence favors allowing it only when explicitly planned/requested and critic-reviewed.
- What is the smallest tool improvement that makes `extraction.create` usable enough for strong models without hiding semantic work?
- How should the runtime expose corpus-to-paper attrition without becoming a semantic judge?

## First Implementation Slice

Target: make the current concept testable under stricter lab conditions without reintroducing a workflow manager.

1. Tool ergonomics:
   - Add typed common fields to the native `workStore.entity` schema so the model can use normal tool-call arguments instead of stringified `payloadJson` for common operations.
   - Add concise action recipes for `extraction.create`, `evidence.create_cell`, and `claim.link_support`.
   - Make blocked extraction/evidence/link results return accepted shapes and relevant valid IDs.
   - Add recent extractions/evidence cells to model-facing workspace context.

2. Structural provenance/coverage diagnostics:
   - Persist or expose exact selected synthesis IDs from source selection in canonical workspace/worker state.
   - Add source disposition diagnostics: selected, extracted, evidence-cell sources, claim sources, citation sources, rendered reference sources, missing/duplicated/dispositioned IDs.
   - Fix evidence coverage messaging so extraction rows are not called evidence cells/rows.
   - Validate notebook links against existing workspace IDs as warnings/diagnostics.

3. Critic/finalization:
   - Require a runtime-owned release-scope critic pass before `manuscript.finalize` writes `paper.md` for `research_brief` or `professional_paper`.
   - Do not auto-run the critic; return `not_ready` with `critic.review` when needed.
   - Do not trust model-authored notebook artifact links as critic authority.
   - If critic backend is unavailable, hide `critic.review` from the model and make finalization return a clear user/runtime blocker.
   - Keep `release.verify` mechanical and explicit.

4. Tests:
   - Test `test-08`-shaped collapse blocks finalization.
   - Test `research_brief` without release critic pass is `not_ready`.
   - Test fake notebook critic artifact links do not satisfy finalization.
   - Test extraction blocked result includes accepted shape and valid source previews.
   - Test source/evidence/reference disposition diagnostics report selected/extracted/cited attrition.

Status: implemented and validated.

## Live Validation: `codex-coordination-01`

Run directory: `/home/uli/Development/Python/research-test/codex-coordination-01`.

What improved:

- Broad source discovery remained strong: 226 canonical sources after merge.
- The agent used the model-selected evidence set more seriously than in `test-08`: 12 selected sources, 12 unique source extractions, 12 evidence cells.
- `extraction.create` no longer caused the repeated blocked-loop pattern seen in `test-08`.
- `release.verify` did not falsely approve the work. It reported missing critic/source-to-reference/section issues and the model continued.
- The model called `critic.review` and continued after critic revision feedback.

What failed:

- Exact selected evidence state was not visible to workspace diagnostics. Diagnostics used `screeningDecision === "include"` as selected, producing false warnings about 156 selected sources when the model had explicitly selected 12.
- The false source-count warning drove repeated `source.select_evidence replace`, `claim.link_support`, and critic/release retries.
- The run was manually terminated to avoid wasting provider calls. This left `run.json` marked as `running`, which is a manual-interruption/crash-recovery concern, not the main research-quality finding.

Fix completed:

- Persist exact `selectedSourceIds` in the worker evidence snapshot.
- Update source checkpoint persistence to write exact selected IDs during the live session, not only after the session exits.
- Update workspace disposition and notebook diagnostics to prefer exact selected IDs over screened includes.
- Add regression coverage: broad screened includes must not inflate selected-source diagnostics after explicit evidence selection.
- Delete the fallback that treated screened includes as selected when the explicit selected set was empty.
- Update release critic packets so selected-source context means exact selected evidence sources plus already cited sources, not all screened includes.

Next likely frictions:

- Runtime-owned critic approval is not freshness-scoped yet. A release critic pass can become stale after later claim/evidence/section edits. Add a reviewed workspace timestamp or fingerprint before trusting release critic approval.
- `claim.link_support` can still be overused redundantly. If the next live run loops there, add duplicate-link observations rather than blocking semantic choices.

## Next Live Validation

Run a fresh controlled live test with a small research objective. Evaluation criteria:

- Critic review should be used before `manuscript.finalize` can write `paper.md`.
- The model should have fewer blocked `extraction.create` attempts because typed entity fields and recipes are visible.
- If source/evidence/reference attrition collapses, `release.verify` or `manuscript.finalize` should return `not_ready` instead of exporting a weak paper.
- Selected-source diagnostics should reflect the explicit `source.select_evidence` set, not broad screened includes.
- The final state may be unfinished; that is acceptable if the runtime correctly keeps working or reports a concrete missing machine-actionable item.

## Live Validation: `test-09` Support-Link Loop

Run directory: `/home/uli/Development/Python/research-test/test-09`.

Observed failure before fix:

- The worker appeared stuck in repeated `claim.link_support` repair actions after release verification.
- The workspace had 10 selected sources and 10 evidence-cell sources, but only 4 durable support links/references.
- Root cause was a runtime persistence bug, not a model reasoning failure: generated support-link IDs were based on a 64-character truncation of `claimId-sourceId-evidenceCellId`. Long claim IDs consumed the whole prefix, so different source/evidence links for the same claim generated the same ID and overwrote each other.

Fix completed:

- `generatedSupportLinkId` now includes short readable claim/source/evidence parts plus a stable hash over run id, claim id, source id, and evidence-cell id.
- Repeated attempts for the same claim/source/evidence identity remain idempotent, but different sources/evidence cells now create distinct support links.
- `claim.link_support` reports whether it attached a new support link or updated an existing one.
- Added regression test: one long claim id plus three different source/evidence links must persist as three distinct citations.

Validation:

- `npm run check` passes.
- `node --test dist/tests/run-worker.test.js` passes.
- `npm test` passes.
- Live resume of `test-09` under the fixed code increased durable support links from 4 to 10 distinct selected sources, and `references.json` rendered 10 references instead of 4.
- The model then moved past the old loop into `notebook.patch`, `release.verify`, `critic.review`, workspace reading, evidence repair, claim patching, section patching, and section claim checks.

Remaining observed issues:

- The run was intentionally bounded with shell `timeout`; because the process was externally killed, `run.json` remains marked `running` with a stale worker PID. This is a crash/interruption recovery issue, not the original support-link loop.
- After the support-link fix, the release critic still returned `revise` for substantive paper-quality/provenance issues: duplicate/provisional extractions, placeholder manuscript rows, and benchmark tasks needing more concrete detail.
- The agent can now repair those issues, but it has not finalized a paper yet. The next improvement area is clean provenance replacement/retirement for stale extractions/support links and better live-run interruption recovery.

## Infrastructure Fix: Quit and Dead-Worker Recovery

Implemented after the `test-09` bounded live run exposed two process-lifecycle issues.

- Terminal UI `/quit` now restores raw mode, removes watchers/listeners, leaves the alternate screen, and pauses stdin so Node can return to the shell without requiring `Ctrl-C`.
- Dead detached worker PIDs are now reconciled as resumable interruptions, not research failures. A run whose worker process disappeared before a terminal checkpoint is marked `paused`, `workerPid` is cleared, `job.signal` is set to `worker_lost`, and worker state tells the user to resume with `/go`.
- `/go` treats that interrupted run as recoverable and starts a fresh continuation segment from the existing workspace instead of blocking on “already active.”
- Added regression tests for terminal quit cleanup, dead-worker reconciliation, and `/go` continuation after dead-worker recovery.

## Provenance Repair Tools

Implemented explicit model-facing repair operations for stale/provisional research objects without reintroducing hidden workflow.

- Added lifecycle state for extraction, evidence-cell, and support-link/citation records: `active`, `superseded`, and `retired`.
- Added `extraction.patch` and `evidence.patch` so the model can revise content or intentionally mark weak/provisional objects as superseded/retired.
- Extended `claim.link_support` with `mode: append | replace | remove`.
  - `append` keeps the existing add/update behavior.
  - `replace` attaches new support and supersedes matched old support links.
  - `remove` retires matched support links without hard-deleting audit history.
- Active support/readiness, reference rendering, evidence matrix views, and notebook disposition diagnostics ignore retired/superseded support/evidence records.
- Tool prompts, native schemas, and advisory guidance now explain these repair operations as provenance maintenance, not semantic judgment.
- Added regression coverage for support-link replacement/removal and extraction/evidence lifecycle patching.

Validation:

- `npm run check` passes.
- `npm test` passes.

## Change-Based Critic Freshness

Implemented explicit freshness tracking for release critic reviews.

- `critic.review` now stores a fingerprinted snapshot of the critic-relevant workspace it reviewed: notebook project state, active extractions, active evidence cells, claims, active support/citation links, and manuscript sections.
- `release.verify` compares the latest runtime-owned release critic snapshot against the current workspace and returns a visible freshness diagnostic:
  - `fresh`: reviewed objects still match.
  - `stale`: reviewed objects changed or disappeared.
  - `incomplete`: new critic-relevant objects were added after review.
  - `missing`: no runtime-owned release review exists.
- `manuscript.finalize` blocks when the release critic is missing, stale, incomplete, or not passing for gated artifact targets.
- Freshness is change-based, not wall-clock-based. A release check by itself does not stale the critic review because release-check records are not part of the critic-relevant snapshot.
- No hidden critic call was added. The model must explicitly choose `critic.review`; the runtime only reports whether the stored review still covers the current workspace.
- The researcher prompt mentions `critic.review` freshness only when that tool is actually available.

Validation:

- `npm run check` passes.
- Focused critic freshness tests pass.
- `npm test` passes.

## Manuscript Section Repair Ergonomics

Implemented section repair support without adding hidden manuscript rewriting.

- `section.read` now returns a repair packet:
  - full section markdown in the entity text,
  - numbered manuscript blocks for targeted editing,
  - linked claims, support links/citations, evidence cells, and sources,
  - relevant runtime-owned critic objections that target the section/manuscript,
  - mechanical hygiene warnings for placeholder/TODO prose, raw workspace ids, process-tool prose, and missing claim links.
- `section.patch` now supports explicit targeted operations:
  - `replace_all`
  - `replace_block`
  - `insert_after_block`
  - `append_paragraph`
  - `remove_block`
  - `update_title`
  - `set_claim_links`
- The model remains the writer. The runtime does not rewrite prose; it only applies the explicit patch requested by the model and returns before/after repair context.
- Native tool schemas, prompt recipes, and guidance now expose the targeted section patch contract.

Validation:

- Focused section repair tests pass.
- `npm run check` passes.
- `npm test` passes.
