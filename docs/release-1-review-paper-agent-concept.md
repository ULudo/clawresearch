# ClawResearch Release 1 Development Concept

## Purpose

Release 1 should make ClawResearch a production-shaped autonomous review-paper agent.

The system should take a research brief, help scope it, run an auditable literature-review process, and produce a serious review-paper draft plus a grounded future research agenda. It should not yet promise full original-research execution. Original research work packages remain the next major frontier after the review-paper path is reliable.

The release target is:

> a console-first autonomous research agent that can produce a high-quality, evidence-grounded review paper draft from a scoped research question, with explicit provenance, citation grounding, limitations, and next research directions.

## Release Thesis

The current ClawResearch kernel already supports the first autonomous research phase:

- research scoping conversation
- detached `/go` runs
- provider-aware source retrieval
- canonical paper library
- per-run provenance artifacts
- paper extraction
- evidence matrix
- synthesis
- claim verification
- agenda and work-package proposal
- durable journal and direction files

Release 1 should polish that kernel into one coherent product outcome: a review paper.

This is the right first production boundary because a strong literature review is itself a research contribution and is also the knowledge foundation for later experiments, implementations, calculations, or proof attempts.

## Non-Goals For Release 1

Release 1 should not try to solve the whole autonomous-scientist problem.

Out of scope:

- fully autonomous original research execution
- general experiment orchestration across arbitrary domains
- proof-attempt execution as a production feature
- manuscript submission automation
- web UI
- multi-user collaboration
- heavy governance layers

Release 1 should keep `/go` as the autonomous research path. The old `/continue` work-package path has been removed so the polished review/report path is not split across hidden execution modes.

## User Experience

The intended Release 1 loop is:

1. User runs `clawresearch` in a project directory.
2. ClawResearch scopes the topic like a research consultant.
3. User starts the run with `/go`.
4. ClawResearch conducts a literature review with visible provenance.
5. ClawResearch writes a review protocol, evidence artifacts, and a paper draft.
6. User inspects `/status`, `/agenda`, and `/paper`.
7. ClawResearch either:
   - marks the review draft as ready for human revision, or
   - holds the paper with concrete reasons such as thin evidence, missing facets, weak citation support, or access limitations.

The system should feel like a research assistant preparing a serious review draft, not like a generic summarizer.

## Artifact Model

Release 1 should keep the current artifact model and add a small manuscript layer.

### New Run-Level Artifacts

`review-protocol.json`

The review protocol for the run. It should include:

- research question
- review type
- search strategy
- provider list
- planned query families
- inclusion criteria
- exclusion criteria
- required success-criterion facets
- screening stages
- quality/appraisal criteria
- stopping conditions
- protocol limitations

`review-protocol.md`

Human-readable protocol summary.

`paper-outline.json`

Structured manuscript plan for the review paper:

- title
- abstract claims
- review type
- structure rationale
- section or rhetorical-role plan
- key themes
- evidence tables to cite
- open questions
- limitations
- agenda implications

`paper.md`

The main review-paper draft. It should be a professional scientific review manuscript, not a fixed-template agent summary.

Release 1 should not hardcode one universal paper outline. The manuscript structure should be chosen from:

- the research question
- field conventions
- review type, such as systematic review, scoping review, narrative review, methodological review, or technical survey
- evidence maturity
- intended contribution

Instead of requiring exact section names, Release 1 should require the scientific roles a reviewer expects:

- a title and abstract that state the scope and contribution
- a convincing motivation and clearly stated research question
- a real research gap and literature positioning
- a review method, search, and screening account
- a characterization and appraisal of the evidence base
- an organized synthesis of what is known
- explicit open problems, disagreements, or unresolved questions
- limitations and threats to validity
- implications for future research
- a conclusion that matches the evidence
- complete references

These roles may be combined, renamed, reordered, or expanded when the subject calls for it.

`paper.json`

Structured representation of the paper:

- title
- abstract
- review type
- structure rationale
- sections or rhetorical units
- claims
- citation links
- referenced paper ids
- evidence table ids
- limitations
- readiness status

`references.json`

Canonical bibliography records used by `paper.md`.

This should use canonical paper IDs and contain enough metadata to later export BibTeX, CSL JSON, or another citation format.

`manuscript-checks.json`

A manuscript readiness audit:

- all cited source IDs exist
- all claims cite evidence
- no citation points to an excluded paper
- no unsupported verified claim is presented as established
- required scientific roles are present in the chosen structure
- missing required facets are acknowledged
- limitations are present
- methods/search strategy is described
- references section is complete enough
- readiness status and blocker list

### Existing Artifacts That Remain Important

`sources.json`

Raw retrieval and provider provenance.

`literature-review.json`

Run-level literature snapshot. It now includes `selectionQuality`, which should become a core input to the manuscript.

`paper-extractions.json`

Per-paper evidence extraction.

`evidence-matrix.json`

Cross-paper evidence organization.

`claims.json`

Structured claims from synthesis or paper drafting.

`verification.json`

Claim support audit.

`agenda.json`

Future research directions and work packages.

`synthesis.md`

Can remain a diagnostic report. `paper.md` should become the polished research communication artifact.

## Review Protocol

The current system retrieves and screens papers, but Release 1 needs an explicit review protocol before synthesis.

The protocol should be generated after planning and before retrieval, then updated with actual retrieval diagnostics after the run.

It should answer:

- What question is this review trying to answer?
- What counts as relevant evidence?
- Which concepts are required?
- Which concepts are background-only?
- Which source types are acceptable?
- What papers are excluded and why?
- What minimum evidence is needed before writing a confident review?
- What limitations should the final paper disclose?

The protocol should not be treated as rigid bureaucracy. It is the review's scientific contract.

## Paper Quality Bar

Release 1 paper drafts should satisfy these standards:

- claims are citation-grounded
- citations use stable canonical paper IDs internally
- structure is appropriate to the review type, research question, and field conventions
- the review method is explicit
- search and screening choices are described
- included evidence is distinguishable from background evidence
- unsupported or missing evidence is named plainly
- limitations are not cosmetic
- open problems follow from evidence, not generic brainstorming
- agenda recommendations are connected to specific gaps
- the paper does not pretend to be final when evidence is partial

The output can be a draft, but it should be a research draft, not an agent chat transcript.

## ClawReview Alignment

When targeting publication or review on `clawreview.org`, ClawResearch should preserve the same scientific standard even if local artifact names differ.

The Release 1 manuscript path should map cleanly onto the roles ClawReview expects from serious agent research:

- a sharply defined research question
- problem formulation and scope
- literature positioning
- review protocol or method specification
- evidence log and source appraisal
- manuscript draft
- self-review or readiness audit

For Release 1 review papers, the review protocol, evidence matrix, verification artifacts, `paper.md`, and `manuscript-checks.json` should collectively satisfy those roles. The important constraint is not a universal outline; it is that the resulting paper is scientifically defensible and reviewable.

## Manuscript Readiness States

The manuscript layer should not have a single boolean.

Use readiness states:

- `not_started`
- `drafted`
- `needs_more_evidence`
- `needs_human_review`
- `ready_for_revision`
- `blocked`

`ready_for_revision` means the draft is coherent and evidence-grounded enough for human scientific editing. It does not mean publication-ready without review.

## Console Commands

Release 1 should add or refine:

`/paper`

Show the latest paper draft status:

- paper path
- title
- readiness state
- cited paper count
- claim count
- unresolved blockers
- next recommended action

`/paper open`

Print or page the current `paper.md`.

`/paper checks`

Show manuscript readiness checks.

`/go`

For literature-review tasks, `/go` should now produce the manuscript artifacts in addition to current artifacts.

## Backend Responsibilities

The model-backed research backend should gain explicit manuscript tasks:

1. `planReviewProtocol`
2. `draftPaperOutline`
3. `draftReviewPaper`
4. `reviseReviewPaperFromChecks`

These should remain behind interfaces so the runtime is not locked to one backend.

The deterministic runtime should handle:

- artifact writing
- citation ID checks
- paper ID validation
- readiness checks
- provenance
- command routing
- console display

The model should handle:

- prose drafting
- thematic organization
- interpretation
- scientific framing
- section-level or rhetorical-role argumentation

## Data Flow

Release 1 literature run:

1. Scope brief.
2. Plan research mode.
3. Generate `review-protocol.json`.
4. Retrieve sources.
5. Merge canonical papers.
6. Screen and select reviewed papers.
7. Write `selectionQuality`.
8. Extract per-paper evidence.
9. Build evidence matrix.
10. Synthesize themes and claims.
11. Verify claims.
12. Generate agenda.
13. Draft `paper-outline.json`.
14. Draft `paper.md` and `paper.json`.
15. Build `references.json`.
16. Run manuscript checks.
17. Write journal records.
18. Present `/paper` status.

If evidence is too thin, the system should still write protocol and manuscript-check artifacts, but `paper.md` should clearly be a blocked or partial draft rather than a confident review.

## Implementation Phases

### Phase 1: Manuscript Artifact Skeleton

Add run artifact paths for:

- `review-protocol.json`
- `review-protocol.md`
- `paper-outline.json`
- `paper.md`
- `paper.json`
- `references.json`
- `manuscript-checks.json`

Add tests proving run paths are created and old run records still load.

### Phase 2: Review Protocol Generation

Create a `ReviewProtocol` type and writer.

Initial protocol can be deterministic plus model-assisted:

- deterministic: brief, plan, providers, query candidates, selection facets
- model-assisted: inclusion/exclusion criteria, review type, appraisal criteria, stopping conditions

Add protocol to run artifacts and prompt context.

### Phase 3: Manuscript Checks

Build deterministic checks before trying to improve prose.

Checks should validate:

- cited paper IDs exist
- cited papers were reviewed or explicitly marked background
- claims have source IDs
- unsupported claims are not phrased as settled
- missing required facets are acknowledged
- references cover all cited papers
- paper satisfies the required scientific roles for its chosen review structure

This creates the safety rail for the writing layer.

### Phase 4: Paper Outline And Draft

Add backend methods for outline and paper drafting.

The outline step should select a subject-appropriate manuscript structure instead of applying a fixed table of contents. It should explain why the selected structure fits the review question and evidence base.

The paper drafter should consume:

- brief
- review protocol
- reviewed papers
- selection quality
- paper extractions
- evidence matrix
- synthesis
- verification
- agenda
- references

The first draft should be Markdown, not a complex document format.

### Phase 5: References

Create `references.json` from canonical papers cited in the manuscript.

Keep this simple first:

- canonical paper ID
- title
- authors
- year
- venue
- DOI/arXiv/PMID/PMCID
- URL
- citation string

BibTeX/CSL export can come later.

### Phase 6: `/paper` Command

Add console and TUI support for inspecting:

- latest paper draft
- readiness state
- manuscript checks
- blockers

This makes the new release feature visible.

### Phase 7: Functional Release Trials

Use real `/go` runs on three benchmark topics:

- autonomous research agents
- rigorous numerical verification of zeta zeros
- AI adoption/workforce impact in nursing homes

Success is not that all three produce final publishable reviews. Success is that:

- strong evidence produces a coherent draft
- partial evidence produces an honest partial/blocked draft
- citations are valid
- limitations are explicit
- missing facets appear in checks
- agenda recommendations do not outrun the paper evidence

## Tests To Add

Unit and integration tests:

- run records include new manuscript artifact paths
- old run records load with default manuscript paths
- review protocol artifact includes brief, plan, provider strategy, facets, inclusion/exclusion criteria
- references include every cited canonical paper
- manuscript checks catch missing citations
- manuscript checks catch cited excluded papers
- manuscript checks catch missing required facets not acknowledged in the draft
- `/paper` reports no paper before first run
- `/paper` reports status after a run
- blocked evidence writes blocked manuscript status
- full run writes `paper.md`, `paper.json`, and `manuscript-checks.json`

Functional tests:

- `--plain` scripted run can inspect `/paper`
- one sufficient stubbed review produces `ready_for_revision`
- one thin-evidence run produces `needs_more_evidence`
- one unsupported-claim fixture fails manuscript checks

## Success Criteria

Release 1 is ready when:

- a scoped literature-review run writes all manuscript artifacts
- the paper draft has a domain-appropriate scientific review structure
- all citations join to canonical paper IDs
- manuscript checks catch unsupported or missing evidence
- the console exposes paper status naturally
- the review protocol explains what the run tried to do
- blocked/partial reviews are honest rather than polished over
- the global journal and library are updated without duplicating paper records
- `npm run check` and `npm test` pass
- packaged CLI smoke tests pass

## Release 1 Definition

ClawResearch Release 1 should be described as:

> an autonomous review-paper research agent that helps scope a research question, conducts an auditable literature review, writes a grounded review-paper draft, verifies its claims against cited evidence, and proposes future research directions.

It should not yet be described as:

> a complete autonomous scientist that reliably performs original research end to end.

That distinction keeps the product honest while still making Release 1 meaningful.
