# Diagnosis: Advanced Model Autonomous Research Run

Date: 2026-04-28

Inspected project:
`/home/uli/Development/Python/research-test/advanced-model-test`

Inspected run:
`/home/uli/Development/Python/research-test/advanced-model-test/.clawresearch/runs/run-20260428-161810505z`

This report is investigation-only. It records observed behavior from the run artifacts and relevant ClawResearch code paths. It does not make runtime code changes.

## Executive summary

The advanced-model run completed successfully at the process level, but did not produce a professional literature review manuscript. The worker exited with code 0, `stderr.log` was empty, and the run produced the expected artifact family: plan, protocol, sources, literature review, extractions, evidence matrix, synthesis, checks, quality report, agenda, and status-only paper.

The run also demonstrated meaningful progress in the new agentic source loop. It used native tool calls, recorded 21 native research-agent actions, and completed four source-selection/evidence passes with the repeated step sequence `search_sources`, `merge_sources`, `rank_sources`, `resolve_access`, and `select_evidence_set`. This is a real improvement over the earlier monolithic source-gathering behavior.

The main failure was quality control around source selection and revision. The app repeatedly selected a weak six-paper evidence set even though the critic identified better in-scope candidates already present in the source pool. The final selected set included useful sources, but also included papers that the critic correctly flagged as not core research-agent systems, especially `paper-18kuzux` on explainable generative AI. The system had critic feedback, recovery queries, and multiple revision passes, but it did not convert the critic's concrete advice into a changed selected set. Instead, it eventually exhausted the configured revision budget and continued to extraction and synthesis with warnings.

The final `paper.md` is not a manuscript. It is explicitly a status artifact. Lines 5-7 say no full manuscript was released because the evidence set did not pass the readiness gate. This was conservative and probably correct. However, the surrounding system messaging was confusing: the run summary and agenda sounded more optimistic than the critic reports and quality report justified, and the assistant told the user to use `/continue` even though `/continue` was guaranteed to fail for the selected work package mode.

The failed `/continue` workflow is a concrete app bug or product mismatch. The console completion summary says “Next step: use /continue to launch it” whenever a work package exists, but the command handler rejects work packages whose mode is not one of `replication`, `benchmarking`, `ablation`, or `method_improvement`. The selected work package mode was `literature_synthesis`, so `/continue` failed with “Mode literature_synthesis is not executable in this phase.”

The agent feedback after the run was partly useful but not persisted because the conversational project assistant has no file-edit/write path. It can answer questions and update structured brief fields, but it cannot append to `summary.md` or create a feedback Markdown artifact. This is a design gap, not a permissions problem in the local filesystem.

## What worked well

### The run executed end to end

Concrete evidence:

- `run.json` marks the run as `completed`, with `exitCode: 0`, started at `2026-04-28T16:18:10.565Z` and finished at `2026-04-28T16:36:50.530Z`.
- `stderr.log` is zero bytes.
- `trace.log` records four evidence passes and final synthesis completion.
- `agent-steps.jsonl` contains 44 structured steps.

This means the runtime did not crash and the worker state machine reached a terminal state cleanly.

### The advanced model used native action transport successfully

The quality report records:

- backend: `openai-codex:gpt-5.5`
- agent control mode: `auto`
- transport counts: `native_tool_call: 21`
- invalid action count: `0`

This is important. The native tool-call transport was not the source of this run's failure. The model chose valid actions, and the runtime validated/executed them.

### The agentic source loop is visible and operational

The agent completed four source-selection passes. Each pass used the expected staged source-tool pattern:

- `search_sources`
- `merge_sources`
- `rank_sources`
- `resolve_access`
- `select_evidence_set`

The transcript and stdout show concrete tool observations, for example:

- OpenAlex returned 80 raw candidates and 29 new screened scholarly sources in evidence pass 4.
- arXiv returned 80 raw candidates and 47 new screened scholarly sources in evidence pass 4.
- The final pass merged 76 screened sources into 74 canonical papers.
- The final pass resolved access for 6 selected papers.
- The final pass selected 6 papers for synthesis.

This confirms the app is no longer only doing one all-at-once source gathering call in live mode.

### Source gathering was productive

The final artifacts record:

- 77 raw sources gathered.
- 74 canonical papers retained.
- 74 title-screened, abstract-screened, and full-text-screened records.
- 13 included papers.
- 6 selected papers.
- 7 deferred included papers.
- 16 in-scope relevance assessments, 40 borderline, 18 excluded.

The system found relevant material. It surfaced multiple useful papers beyond the selected set, including `ResearchAgent`, `ScienceBoard`, `ChatCite`, `IntrAgent`, and `DeepXiv-SDK`.

### Extraction, synthesis, verification, and memory persistence worked

Artifacts show:

- `paper-extractions.json`: 6 of 6 selected papers extracted successfully in one batch.
- `evidence-matrix.json`: 6 evidence rows.
- `synthesis.json`: 1 synthesis cluster completed, no failed clusters.
- `verification.json`: 8 supported claims, 0 partially supported, 0 unverified, 0 explicit unknown.
- `research-journal.json`: 48 records persisted.
- `literature-review.json`: 74 canonical papers persisted to the literature snapshot.

The synthesis is not a professional review paper, but it contains several useful findings.

### The critic produced high-value feedback

The critic repeatedly found real issues:

- Protocol critic: evidence targets mixed extractable evidence with workflow/manuscript instructions.
- Protocol critic: scientific usefulness, reliability, and reproducibility were underspecified as required facets.
- Source-selection critic: the selected set did not support the required comparison of at least five actual systems/frameworks.
- Source-selection critic: `paper-18kuzux` was not a research-agent system.
- Evidence critic: better in-scope candidates were already present but deferred.

These were not generic complaints. They were concrete and actionable.

## What worked poorly

### The selected evidence set stayed weak across revisions

The critic identified essentially the same source-selection problem after each pass. By the final pass, the selected set still included:

- `paper-y9pc09`: FlamePilot, a concrete domain-specific autonomous combustion workflow agent.
- `paper-1u4tony`: PaperArena, a benchmark/platform for tool-augmented scientific literature reasoning.
- `paper-18kuzux`: GenXAI, a general explainable generative AI survey, not a research-agent system.
- `paper-dir7ef`: SAGE, a retrieval benchmark for deep research agents.
- `paper-1fwr7f2`: Agent Laboratory, an end-to-end staged research assistant framework.
- `paper-1k9lpmc`: LEGOMem, a procedural-memory framework for general multi-agent workflow automation.

This set supports useful design observations, but it does not strongly satisfy the user success criterion: compare at least five existing LLM-based research-agent systems or frameworks. At best, only a subset are true research-agent systems. Others are benchmarks, general surveys, or adjacent workflow/memory systems.

### The recovery/revision process did not apply critic advice effectively

The source-selection critic explicitly advised excluding `paper-18kuzux` and rebalancing toward actual research-agent systems. The evidence critic then named stronger in-scope candidates already surfaced by screening:

- ScienceBoard
- ResearchAgent
- ChatCite
- DeepXiv-SDK
- IntrAgent

Despite that, the final evidence matrix still included `paper-18kuzux` and did not extract the named stronger candidates.

This is the central workflow failure: the app can hear the critic, but does not yet have a reliable mechanism for turning critic objections into concrete source-set changes.

### The deterministic readiness checks were too optimistic

`manuscript-checks.json` says:

- evidence targets covered: pass
- selected papers in scope: pass
- evidence matrix ready: pass
- verification ready: pass
- cited sources topic relevant: pass

But the critic says:

- the selected set does not support the five-system comparison,
- `paper-18kuzux` is off-topic as a primary evidence row,
- better in-scope candidates were deferred,
- protocol matrix facets were underfilled.

The deterministic checks passed because the required facets were too broad: essentially `evaluation` and `autonomous research agents`. The protocol artifact also still contained malformed/process-like evidence targets. As a result, the deterministic gate could say “all required facets covered” while the critic correctly saw that the selected evidence set was not professionally adequate.

### The final paper artifact is status-only and internally awkward

`paper.md` is a short status report, not a review paper. It says:

- no full review manuscript was released,
- the artifact is a status report,
- readiness is `needs_human_review`,
- selected synthesis papers: 6,
- blocker: “The paper artifact does not include explicit limitations.”

The status-only choice was reasonable because the evidence set was weak. But the blocker is awkward: it complains that a status-only artifact lacks explicit limitations even though the artifact itself exists because the full manuscript was withheld. This suggests the manuscript checks are being applied too generically to status artifacts.

### The review protocol remained polluted

`review-protocol.md` still lists process instructions under “Evidence Targets,” including:

- “No local files are currently available, so begin by creating a source matrix...”
- “Convert findings into a design brief structure...”
- “Record open questions and reusable source metadata...”

The protocol critic flagged this repeatedly, but the protocol revision loop did not fix it. This is not only a prompt quality problem. It means the protocol data model still does not sufficiently separate:

- extractable source evidence,
- retrieval hints,
- manuscript constraints,
- process notes,
- planned outputs.

### Provider choice was narrower than configured

The test configured many providers, but the research agent consistently chose only OpenAlex and arXiv for discovery. That may be defensible for this topic, but the critic wanted stronger evidence and named systems. The source loop did not pivot to DBLP, Crossref, publisher sources, or broader targeted discovery even after repeated source-selection criticism.

Uncertainty: the model may have had reasonable reasons to prefer OpenAlex/arXiv, and many relevant CS/AI preprints do live there. Still, the lack of provider pivot is a repeated pattern in this run.

### The run summary overstates readiness relative to the critic

The console summary said the reviewed set was “adequate for a bounded next step because all required facets are covered.” That is technically consistent with the weak deterministic facets, but it conflicts with critic evidence showing unresolved protocol, source-selection, and evidence concerns.

The better summary would have been: the run completed and produced a useful but not manuscript-ready synthesis; selected evidence remains contested; the next step should repair source selection or build an evaluation matrix with clear caveats.

## Root causes of the weak literature review

### 1. No full literature review manuscript was released

The most immediate reason the output was not professional is that `paper.md` was not intended to be a manuscript. It was a status artifact. The app withheld a full paper because readiness was `needs_human_review`.

That behavior was safer than producing a false paper. However, from the user perspective it still fails the goal of producing a professional review paper.

### 2. The evidence set was too small and uneven

The run selected 6 papers from 74 canonical papers and 13 included papers. That can support a design memo or short position synthesis, but it is thin for a serious literature review about LLM-based autonomous research agents.

A professional review would usually need:

- a clearer search protocol,
- a transparent inclusion/exclusion table,
- a larger and more coherent set of primary system/framework papers,
- explicit separation between system papers, benchmark papers, surveys, and conceptual background,
- a comparative matrix across systems,
- a limitations section,
- a references section with stable bibliographic metadata,
- a methodology section explaining search sources, screening criteria, and appraisal criteria.

The run produced pieces of this, but not in a professional review-paper structure.

### 3. Source type classification was missing

The selected set mixed very different source roles:

- system/framework evidence: FlamePilot, Agent Laboratory
- benchmark/evaluation evidence: PaperArena, SAGE
- memory/framework-adjacent evidence: LEGOMem
- conceptual/background evidence: GenXAI

The app treated these as one synthesis set. A serious review needs explicit source roles, for example:

- `primary_system`
- `benchmark`
- `survey`
- `method_framework`
- `background_concept`
- `excluded`

This would have prevented GenXAI from counting as one of the compared research-agent systems while still allowing it to inform explainability/verifiability criteria.

### 4. Protocol and facet extraction were still brittle

The final protocol's required concepts were only:

- `evaluation`
- `autonomous research agents`

That was too broad. It allowed the system to call the evidence set “covered” even though the success criterion required scientific usefulness, reliability, reproducibility, architecture, workflow stages, and at least five systems/frameworks.

The optional facets also contained malformed n-grams such as:

- `compare least research-agent`
- `least research-agent system`
- `developed they support`
- `architecture harnesse compare`

This indicates that facet extraction is still not clean enough for professional review readiness.

### 5. Critic feedback did not become source-selection operations

The critic said to exclude `paper-18kuzux` and extract stronger candidates. The runtime did not promote those candidates or force a revised selected set. It only launched new search passes. This is a mismatch between criticism and available revision actions.

What was needed was not more broad search. It was targeted source-set editing:

- exclude known bad primary papers,
- re-rank already discovered in-scope papers,
- promote specific critic-named candidates,
- extract replacement papers,
- re-run evidence critic on the revised matrix.

### 6. Synthesis was asked to work around evidence problems

The synthesis agent knew the evidence was flawed. Its action rationale said revision budget was exhausted, so it would synthesize with caveats and demote non-agent evidence. That produced a useful synthesis note, but not a professional literature review.

A professional manuscript should not be written by asking synthesis to “work around” a flawed selection. The source set must be repaired first.

### 7. The release checks do not distinguish status artifacts from manuscripts

The blocker “paper artifact does not include explicit limitations” appeared even though `paper.md` was a status report. This makes the final state confusing. Status artifacts need their own checks, separate from manuscript checks.

## Root causes of the failed `/continue` command

### Observed behavior

After the run completed, the assistant told the user:

> Next step: use /continue to launch it.

The next logged system message says:

> The latest agenda is not ready for /continue yet: Mode literature_synthesis is not executable in this phase.

The selected work package was:

- id: `wp-001`
- title: `Operational source matrix and evaluation rubric for credible LLM research agents`
- mode: `literature_synthesis`

### Code path

The summary recommendation comes from `buildCompletedRunSummary` in `src/runtime/console-app.ts`. It recommends `/continue` whenever an agenda has a selected work package.

The blocker comes from `workPackageContinueBlockers` in `src/runtime/research-agenda.ts`. That function only allows modes that pass `autoRunnableMode`, and `autoRunnableMode` currently allows only:

- `replication`
- `benchmarking`
- `ablation`
- `method_improvement`

It does not allow `literature_synthesis`.

### Diagnosis

This is a product/logic mismatch, not a model failure.

The agenda generator selected a literature-synthesis work package that is valuable and not blocked. The console summary advertised `/continue`. But the command gate refuses literature-synthesis work packages because the work-package executor only considers certain modes executable.

There are two possible fixes:

1. Do not recommend `/continue` for work package modes that cannot run. The completion summary should say the agenda selected a non-executable literature synthesis direction and offer `/go` rerun, manual review, or a future supported action.
2. Make `literature_synthesis` work packages executable by adding a bounded work-package executor for source matrices, rubrics, and design briefs.

Given this run, the second option is probably more aligned with the product goal. The selected work package was exactly the kind of next autonomous research step the user expected.

## Assessment of the agent feedback

### Valuable feedback

The feedback after the run was mostly useful. It correctly identified:

- The harness did well as a structured literature-research assistant.
- It turned a broad topic into a concrete brief and success criterion.
- It gathered a substantial source pool.
- It produced an agenda with gaps and a bounded next work package.
- It preserved caveats and did not claim publishable readiness.
- Six selected papers are thin for broad design recommendations.
- Evidence coverage is uneven.
- Reproducibility of the harness itself is not proven.
- The next useful step is a source matrix and evaluation rubric.

This should become product work.

### Low-value or incomplete feedback

Some feedback was too generic:

- “Add an explicit self-evaluation layer” is directionally right but underspecified.
- “Require artifact packages” is true but broad; the app already produces many artifacts, so the missing piece is a completeness/readability/export contract, not just more files.
- “Expand synthesis beyond 6 papers” is true but should be reframed as: select enough papers by role and evidence target, not simply increase a numeric count.

### Misleading feedback

The assistant said it could not edit `summary.md` because no file-write tool was available. That is true for the chat assistant surface, but from the user perspective it is a system design failure: the app should have a supported artifact-update command or feedback artifact workflow.

The assistant also recommended `/continue` even though the selected work package mode was not executable. That was misleading and should be fixed.

## Why feedback was not persisted properly

The project assistant backend is conversational. Its response contract returns:

- `assistantMessage`
- optional structured brief fields
- readiness
- open questions
- summary

There is no operation for writing a file, appending to `summary.md`, creating a feedback artifact, or proposing a patch to an artifact. The normal user chat path in `handleUserInput` saves the conversation and may update the brief, but it does not interpret “extend summary.md” as a file-write command.

The run worker writes `summary.md` during the autonomous worker run. After the run finishes, the console assistant cannot mutate it.

Therefore the failure was not caused by filesystem permissions or path problems. It was caused by missing application capability and missing assistant instructions/tooling.

Recommended design:

- Add a first-class `/feedback` or `/note` command that writes a timestamped Markdown note into the run directory.
- Add `/summary append` or `/summary revise` for user-approved summary updates.
- Let the project assistant return structured `artifactPatchSuggestions`, but require the command layer to apply them explicitly.
- Save post-run feedback to a separate artifact first, for example `run-feedback.md`, to avoid silently rewriting the run-generated summary.

## Assessment of the research findings

The findings are useful despite the weak manuscript readiness.

### Strong findings to preserve

1. Structured workflows beat vague autonomy.

The synthesis found that credible research agents should expose staged workflows, artifacts, and intervention points rather than hiding everything behind a single autonomous loop. This is directly relevant to ClawResearch's design.

2. Retrieval and cross-paper reasoning are bottlenecks.

PaperArena and SAGE were used to support a strong claim: tool-augmented literature reasoning and deep-research retrieval remain hard, and simple retrieval baselines can outperform LLM-based retrievers in some settings. This supports treating retrieval as a first-class subsystem, not an implementation detail.

3. Domain-specific tools are valuable but narrow.

FlamePilot supports the value of atomic domain tools and execution metrics, but also shows domain specificity and incomplete generalization. This maps well to ClawResearch's tool approach: tools should be explicit, inspectable, and evaluated.

4. Human oversight should be measured, not hidden.

Agent Laboratory suggests human feedback improves quality. That is relevant because ClawResearch should distinguish autonomous-only quality from human-in-the-loop quality.

5. Memory should be evaluated by role.

LEGOMem suggests separating orchestrator-level memory from task-agent memory. For ClawResearch, this implies separate evaluation for project memory, source memory, run memory, critic memory, and agent step traces.

6. Reproducibility artifact requirements are central.

The agenda correctly identifies prompts, traces, sources, code/tool calls, environment details, intermediate outputs, and final claims as part of the artifact package needed to judge scientific value.

### Findings that need caution

GenXAI is useful as background for explainability/verifiability criteria, but it should not count as a research-agent system. LEGOMem is useful for memory architecture, but it is not directly validated on scientific research workflows. PaperArena and SAGE are excellent benchmark/evaluation sources, but they are not themselves full autonomous research-agent systems.

### Novel/useful patterns for ClawResearch

The run suggests concrete ClawResearch design principles:

- Evaluate retrieval separately from synthesis.
- Track source roles explicitly.
- Make critic objections operational, not just textual.
- Keep full manuscript release gated.
- Produce a source matrix before attempting a professional review paper.
- Persist a quality report that distinguishes model suitability from harness quality.
- Treat human interaction as a measurable intervention, not a vague support channel.

## Recommended improvements to ClawResearch

### 1. Add source-role classification

Every selected and included paper should have a role:

- `primary_system`
- `benchmark`
- `survey`
- `framework`
- `background`
- `excluded`

Manuscript readiness should require enough `primary_system` papers when the brief asks for system comparison. Benchmark and survey papers should be allowed, but they should not satisfy “at least five systems/frameworks.”

### 2. Convert critic advice into concrete revision operations

Critic advice should create structured revision tasks:

- exclude these paper IDs,
- promote these paper IDs,
- extract these replacement papers,
- run targeted query strings,
- re-run relevance review,
- re-run evidence matrix,
- re-run critic.

The run should not only do new retrieval. In this test, the better candidates were already present.

### 3. Repair protocol data modeling

Separate:

- source-extractable evidence targets,
- retrieval hints,
- inclusion criteria,
- exclusion criteria,
- manuscript constraints,
- output artifact plan,
- process notes.

The protocol critic repeatedly found that the app still mixed these concepts.

### 4. Strengthen required facet generation

For this brief, required concepts should have included:

- autonomous research-agent systems/frameworks,
- architecture/orchestration,
- planning,
- tool use,
- retrieval,
- experiment/code execution,
- critique/reflection/verification,
- memory,
- human oversight,
- scientific usefulness,
- reliability,
- reproducibility.

The final required facets were only `evaluation` and `autonomous research agents`, which was too weak.

### 5. Add a source matrix artifact before synthesis

Before paper extraction and synthesis, the app should write a source matrix with rows for candidate papers and columns for source role, inclusion reason, exclusion/defer reason, architecture evidence, workflow stages, tools, memory, evaluation, reproducibility, and critic status.

The source matrix should be critic-reviewed before extraction. This would make failures like GenXAI-as-primary-evidence obvious and actionable.

### 6. Make evidence-set size task-aware

Do not use a small selected set simply because facets are technically covered. The selected set size should depend on task type:

- broad literature review: larger set,
- system comparison: enough primary systems plus benchmarks/surveys,
- design brief: enough architecture evidence and evaluation evidence,
- benchmark proposal: enough benchmark/evaluation papers.

The app should not stop at 6 selected papers for a broad comparative review if 13 included and 16 in-scope papers are available.

### 7. Fix `/continue` mode mismatch

Either:

- stop recommending `/continue` for non-executable modes, or
- make `literature_synthesis` work packages executable.

The better product direction is likely to make selected literature-synthesis work packages executable, because the selected next step in this run was useful and bounded.

### 8. Add post-run feedback persistence

The project assistant needs a sanctioned way to write feedback. Options:

- `/feedback` writes `run-feedback.md`.
- `/summary append` appends user-approved notes to `summary.md`.
- `/note` saves project notes into `research-journal.json` and a Markdown note file.
- The assistant returns structured artifact-edit proposals that the command layer applies only after explicit user confirmation.

### 9. Separate status-artifact checks from manuscript checks

A status-only `paper.md` should not fail because it lacks manuscript sections. Instead, it should have status-specific checks:

- readiness reason present,
- blockers listed,
- next evidence work listed,
- critic objections linked,
- no manuscript-like claims presented as final.

### 10. Improve final user messaging

Final console messages should clearly distinguish:

- worker completed,
- manuscript released,
- manuscript withheld,
- selected work package executable,
- selected work package non-executable,
- recommended next command.

In this run, “complete” plus “use /continue” hid two important facts: the paper was only a status report, and `/continue` could not run the selected mode.

## Concrete implementation tasks, ordered by priority

### Priority 1: Fix misleading `/continue` recommendation

Change the completed-run summary so it checks `workPackageContinueBlockers` before recommending `/continue`.

Acceptance criteria:

- If selected work package mode is `literature_synthesis`, the console does not say “use /continue” unless that mode is executable.
- `/agenda` and `/status` show the exact blocker.
- Add regression test using a selected `literature_synthesis` work package.

### Priority 2: Add executable support for literature-synthesis work packages

Implement a bounded executor for `literature_synthesis` work packages that can produce source matrices, rubrics, design briefs, or literature follow-up artifacts from existing run evidence.

Acceptance criteria:

- The selected `wp-001` pattern from this run can launch.
- It uses existing reviewed papers, extractions, claims, and agenda.
- It writes method plan, execution checklist, source matrix/rubric artifact, findings, decision, and summary.
- It does not require a local codebase context to run.

### Priority 3: Introduce source-role classification and readiness gates

Add source roles to relevance/selection artifacts and manuscript checks.

Acceptance criteria:

- Selected papers have roles such as `primary_system`, `benchmark`, `survey`, `background`.
- Briefs requiring comparison of systems/frameworks require a minimum count of `primary_system` or accepted equivalent roles.
- Benchmark/survey/background papers cannot satisfy primary system counts.
- GenXAI-like survey fixtures are not counted as primary research-agent systems.

### Priority 4: Turn critic source-selection advice into revision actions

Add a structured revision planner that consumes critic objections and can operate on already discovered papers.

Acceptance criteria:

- `papersToExclude` removes or demotes affected papers from the synthesis set.
- Critic-named candidates already in `relevanceAssessments` can be promoted into extraction.
- Evidence critic can trigger “extract additional papers” without doing another broad provider search.
- The run re-runs source/evidence critic after the revised set.

### Priority 5: Create a source matrix artifact before extraction/synthesis

Write `source-matrix.json` and `source-matrix.md` after ranking and before final extraction.

Acceptance criteria:

- Rows include selected, included, deferred, and excluded papers.
- Columns include source role, inclusion status, matched/missing criteria, coverage of required evidence fields, access state, and critic notes.
- The matrix makes it clear why each selected paper is selected and why deferred papers were not selected.

### Priority 6: Repair review protocol generation

Refactor protocol generation so evidence targets contain only extractable evidence.

Acceptance criteria:

- Process instructions no longer appear under `evidenceTargets`.
- Manuscript/output constraints are stored separately.
- Required success criterion facets include scientific usefulness, reliability, reproducibility, and system/framework comparison when present in the brief.
- Add regression fixtures based on this run.

### Priority 7: Make selected set sizing task-aware

Add task-sensitive minimums and stopping rules.

Acceptance criteria:

- A broad literature review or system-comparison brief does not stop at 5-6 selected papers when more in-scope candidates are available and critic objections remain.
- Selection can include enough primary systems plus supporting benchmark/survey papers.
- Deferred included papers are explicitly justified.

### Priority 8: Add post-run feedback persistence

Implement `/feedback`, `/note`, or `/summary append`.

Acceptance criteria:

- User can ask to persist post-run feedback.
- The app writes a Markdown artifact or updates the requested artifact through an explicit command path.
- The project assistant no longer says it cannot edit when the application can provide a safe persistence workflow.

### Priority 9: Separate status checks from manuscript checks

Create status-artifact readiness checks distinct from manuscript release checks.

Acceptance criteria:

- Status-only `paper.md` does not fail for missing manuscript limitations.
- Status artifact includes blockers, next evidence work, critic status, and reason manuscript was withheld.
- Full manuscript checks only run against manuscript-shaped artifacts.

### Priority 10: Improve final quality report and model suitability report

Make the quality report distinguish model quality from application workflow quality.

Acceptance criteria:

- Report separates action transport quality, source-selection quality, critic satisfaction, evidence-set sufficiency, synthesis quality, and artifact completeness.
- It identifies app-level failure causes such as “critic advice not operationalized” and “non-executable selected work package.”
- It avoids assigning all quality problems to model suitability.

## Bottom line

The advanced model did not fail in the simple sense. It followed the action contract, used native tool calls, and produced useful synthesis. The app failed to translate good critic feedback into concrete source-set revision, failed to enforce source roles, and then gave misleading continuation guidance.

The most important next engineering step is not another larger model test. It is to make criticism operational: exclude bad papers, promote better discovered candidates, create a source matrix, and only then synthesize or write a manuscript.
