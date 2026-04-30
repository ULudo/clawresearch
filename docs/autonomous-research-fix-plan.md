# ClawResearch Autonomous Research Fix Plan

## Summary

ClawResearch should be simpler at the user interface and stronger in the runtime.

The normal research workflow should be:

1. The user discusses or adjusts the research direction.
2. The user runs `/go`.
3. ClawResearch works autonomously until it can produce a professional paper/report, an evidence-led alternative finding, a concrete user decision request, or a precise external/model limitation.

The app should not add more user commands to compensate for incomplete runtime behavior. In particular, `/continue` should be removed from the research workflow rather than kept as a backup path.

## Design Principles

- `/go` is the single autonomous research command.
- Existing artifacts should be fixed and made decisive before adding new artifacts.
- `literature-review.json` and `sources.json` are the canonical source-selection artifacts.
- `evidence-matrix.json` is the extracted evidence matrix for selected sources.
- The critic should drive revision, not simply block release.
- The system should not stop just because the original claim is unsupported. It should report what the evidence actually supports.
- The user should only be interrupted when a real human decision or external fix is required.
- The post-run assistant should be able to write project files through controlled file actions, without adding new commands.

## P0: Remove `/continue` Completely

Remove `/continue` from the user-facing application instead of keeping it as a legacy or backup path.

Required changes:

- Remove `/continue` command handling from the console.
- Remove `/continue` from help output, suggestions, completion summaries, and assistant messages.
- Remove "Next step: use `/continue`" style text.
- Remove or retire `postReviewBehavior: auto_continue` if it only exists to support continuation work packages.
- Remove work-package launch behavior that exists only for `/continue`.
- Remove tests that assert `/continue` behavior.

Replacement behavior:

- If a next step is actionable, `/go` should perform it before ending.
- If the next step requires the user, `/go` should end with a clear decision request.
- If the next step cannot be done because of an external constraint, `/go` should explain the exact constraint.

## P1: Make `/go` The Full Autonomous Research Loop

`/go` should continue the research process until a meaningful research outcome is reached.

The loop should support:

- protocol creation and revision,
- source search,
- source classification,
- source selection,
- extraction,
- evidence matrix construction,
- critic review,
- revision based on critic feedback,
- synthesis,
- manuscript/report drafting,
- final checks,
- final paper/report release or a concrete non-release outcome.

The run should not stop with a vague "needs more evidence" state when the agent still has available actions. If more evidence can be found, selected, extracted, or synthesized, `/go` should do that work.

## P2: Fix Existing Source Artifacts Instead Of Adding A Second Source Matrix

Do not create another source matrix artifact.

Use existing artifacts more effectively:

- `literature-review.json`: canonical candidate/source-selection matrix.
- `sources.json`: source retrieval and routing details.
- `evidence-matrix.json`: extracted evidence matrix for selected papers only.
- `summary.md`: human-readable summary generated from the same structured artifacts.

`literature-review.json` should become the place where source-selection decisions are inspectable and actionable.

Suggested fields to add or strengthen on existing source records:

```ts
sourceRole:
  | "primary_system"
  | "benchmark"
  | "survey"
  | "method_component"
  | "background"
  | "off_topic";

selectionDecision:
  | "selected_primary"
  | "selected_supporting"
  | "deferred"
  | "excluded";

selectionReason: string;
criticConcerns: string[];
requiredForManuscript: boolean;
```

This is not a new workflow. It is making the existing workflow legible and enforceable.

## P3: Add Role-Aware Source Classification

The current `in_scope`, `borderline`, `excluded` classification is too coarse.

A source can be in scope but still not suitable as a primary comparison source. For example:

- a survey may be useful as background,
- a benchmark may support evaluation discussion,
- a general method paper may support one design component,
- only a system/framework paper should count toward a required comparison of existing systems.

The source gate should check source roles against the brief and protocol.

Example for a review requiring "at least five existing research-agent systems/frameworks":

- require at least five `primary_system` records,
- allow `benchmark` records as evaluation evidence,
- allow `survey` records as background only,
- prevent `survey`, `background`, or `method_component` sources from filling primary system slots,
- prevent critic-excluded papers from entering the core synthesis set.

This would have prevented a broad GenXAI survey from being counted as a primary autonomous research-agent system.

## P4: Make Critic Feedback Drive Revision

The critic should not merely produce objections and then let the run end.

The normal loop should be:

1. Researcher creates or revises artifact.
2. Fresh critic reviews artifact.
3. Researcher applies concrete criticism.
4. Fresh critic reviews again.
5. Repeat until the critic passes, a useful evidence-led result is produced, a user decision is required, or an external/model limitation is reached.

The researcher should act on critic feedback directly:

- demote or exclude papers the critic identifies as unsuitable,
- promote stronger candidates already present in `relevanceAssessments`,
- extract additional candidate papers before synthesis,
- add missing evidence fields to the existing evidence matrix,
- revise protocol fields when the critic identifies polluted or underspecified criteria,
- re-run the critic after revision.

Important behavior:

- Do not default to more searching when better candidates are already present.
- Search more only when the existing pool is genuinely insufficient.
- Do not ask the user to continue if the app can continue by itself.

## P5: Final Outcomes Must Be Research Outcomes

The final result should be useful to a researcher, not a developer status code.

User-facing outcomes should be:

### 1. Professional paper/report ready

The evidence is strong enough and all gates pass. ClawResearch writes the full paper, literature review, design brief, or requested report.

### 2. Evidence-led answer ready

If the original claim or assumption is not supported, the researcher should not stop. It should write what the evidence actually supports.

Example:

> The literature does not support X as stated. The stronger finding is Y, with limitations Z. Here is the review/report framed around the evidence.

This is still a successful research outcome.

### 3. Needs user decision

Use this only when the next step requires a genuine human choice.

Example:

> The literature splits into three viable directions. I can continue with A, B, or C. I recommend A because ...

After the discussion or brief adjustment, the user should be able to run `/go` again to continue from the revised direction.

### 4. External constraint

Use this only when the app genuinely cannot proceed by itself.

Examples:

- API quota or rate limit,
- missing credentials,
- provider outage,
- unavailable full text,
- local storage or permission problem,
- configured model unavailable.

The report must state what was tried, what failed, and what the user can fix.

### 5. Model/task capability limit

This should be rare and explicit.

Before reaching this outcome, the app should try:

- smaller batches,
- narrower subquestions,
- additional extraction,
- source reselection,
- critic-guided revision,
- stronger configured critic or writer model when available.

Only then may it say that the current model/configuration is not suitable for the research task. Even then, it should preserve what succeeded and recommend a concrete model or configuration change.

## P6: Clean Protocol And Manuscript Gates

The review protocol must separate source-extractable evidence from writing instructions and workflow notes.

Use separate protocol fields for:

- `evidenceTargets`: facts extractable from papers,
- `manuscriptRequirements`: output structure and writing expectations,
- `workflowNotes`: internal process guidance,
- `successCriteria`: measurable release requirements.

Do not put instructions like "create a source matrix" or "convert findings into a design brief" into `evidenceTargets`.

Manuscript checks should distinguish:

- manuscript readiness,
- source-selection readiness,
- evidence-matrix readiness,
- status/report readiness.

A status or decision report should not fail because it lacks manuscript sections. A manuscript should fail if it lacks sections required for a professional paper.

## P7: Add Post-Run Conversational File Writing

After a run, the user should be able to discuss the result with the assistant and ask it to write or update project files.

Examples:

- "Write this feedback into `docs/run-feedback.md`."
- "Update `summary.md` with this assessment."
- "Create a design note from our discussion."
- "Save this as a Markdown report."

The assistant should actually write the file. It should not provide pasteable text unless the user asks for text only.

This should not be implemented as new commands such as `/feedback`, `/summary append`, or `/note`.

Design:

- Add controlled project file actions to the project assistant:
  - `read_project_file`
  - `write_project_file`
  - `update_project_file`
  - `list_project_files`
- Restrict file operations to the project root.
- Block sensitive files by default:
  - credentials,
  - model credential stores,
  - secret env files,
  - lock files,
  - internal runtime state files unless explicitly allowed.
- Allow normal Markdown/docs/report writing.
- Use atomic writes.
- Record file writes in the session history.
- Ask one concise clarification only when the target path or edit intent is ambiguous.

## P8: Focused Tests And Live Validation

Add tests around the actual failure modes rather than broad new command surfaces.

Required tests:

- `/continue` is absent from help and command handling.
- Completed `/go` runs never recommend `/continue`.
- `literature-review.json` stores role-aware source classifications.
- Survey/background/benchmark papers cannot count as primary system comparisons.
- Critic feedback changes the next selected evidence set when it identifies concrete exclusions or promotions.
- The researcher promotes stronger candidates already present before searching more.
- Polluted protocol phrases are not stored as evidence targets.
- Unsupported original claims produce evidence-led reports rather than dead-end blocker messages.
- User-decision outcomes include concrete options and a recommendation.
- External-constraint outcomes identify the exact failed dependency.
- Post-run chat can create and update a Markdown file inside the project.
- Post-run chat cannot write credentials or sensitive runtime files.

Live validation:

- Re-run the advanced-model test topic.
- Confirm that weak primary selections are demoted.
- Confirm that stronger in-scope candidates are extracted before synthesis.
- Confirm that `/go` either writes a professional paper/report or returns a concrete research decision/external limitation.
- Confirm that the user can ask the assistant to write a Markdown file after discussing the run.

