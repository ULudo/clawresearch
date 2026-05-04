import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResearchActionDecision, workspaceResearchActions } from "../src/runtime/research-agent.js";

const expectedToolFamilies = [
  "workspace.search",
  "workspace.read",
  "source.search",
  "source.merge",
  "source.resolve_access",
  "source.select_evidence",
  "extraction.create",
  "evidence.create_cell",
  "evidence.matrix_view",
  "claim.create",
  "claim.link_support",
  "section.create",
  "section.patch",
  "critic.review",
  "check.run",
  "release.verify",
  "manuscript.release"
];

test("architecture contract: production action surface excludes legacy orchestration aliases", () => {
  const actions = workspaceResearchActions();
  const legacyActions = [
    "extract_papers",
    "build_evidence_matrix",
    "ask_critic",
    "screen_sources",
    "search_sources",
    "revise_search_strategy",
    "work_store.query",
    "work_store.read",
    "work_store.create",
    "work_store.patch",
    "manuscript.read_section",
    "manuscript.patch_section",
    "manuscript.add_paragraph",
    "manuscript.check_section_claims",
    "manuscript.status"
  ];

  for (const action of legacyActions) {
    assert.equal(actions.includes(action as never), false, `${action} must not be model-facing production surface`);
  }
});

test("architecture contract: milestone labels do not narrow the production action surface", () => {
  const actions = workspaceResearchActions();

  for (const action of expectedToolFamilies) {
    assert.equal(actions.includes(action as never), true, `${action} should remain available independent of milestone label`);
  }
});

test("architecture contract: documented invalid next hints stay out of the production action surface", () => {
  const actions = workspaceResearchActions();

  assert.equal(actions.includes("evidence.find_support" as never), false);
});

test("research action normalization accepts JSON escape hatches for dynamic workspace payloads", () => {
  const decision = normalizeResearchActionDecision({
    action: "workspace.status",
    rationale: "Checkpoint with structured status payload.",
    confidence: 0.8,
    inputs: {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null,
      workStore: {
        collection: "workItems",
        entityId: "work-item-1",
        filters: {},
        filterJson: "{\"status\":\"open\"}",
        semanticQuery: null,
        limit: 10,
        cursor: null,
        changes: {},
        patchJson: "{\"status\":\"resolved\"}",
        entity: {},
        payloadJson: "{\"status\":\"working\",\"statusReason\":\"release checks need repair\",\"nextInternalActions\":[\"Inspect release checks\"]}",
        link: {
          fromCollection: null,
          fromId: null,
          toCollection: null,
          toId: null,
          relation: null,
          snippet: null
        }
      }
    },
    expectedOutcome: "Checkpoint is persisted.",
    stopCondition: "Stop after status."
  }, {
    projectRoot: "/tmp/project",
    runId: "run-json-hatches",
    phase: "research",
    attempt: 1,
    maxAttempts: 1,
    allowedActions: ["workspace.status"],
    brief: {
      topic: "tool contracts",
      researchQuestion: null,
      researchDirection: null,
      successCriterion: null
    },
    plan: {
      researchMode: "literature_synthesis",
      objective: "Test JSON hatches.",
      rationale: "Native schemas keep dynamic objects closed.",
      searchQueries: [],
      localFocus: []
    },
    observations: {
      sourceCandidates: 0,
      canonicalSources: 0,
      screenedInSources: 0,
      explicitlySelectedEvidenceSources: 0,
      resolvedAccessSources: 0,
      canonicalPapers: 0,
      selectedPapers: 0,
      extractedPapers: 0,
      evidenceRows: 0,
      evidenceInsights: 0,
      manuscriptReadiness: null,
      sessionStepsUsed: 0,
      sessionStepsRemaining: 1
    },
    criticReports: []
  });

  assert.deepEqual(decision.inputs.workStore?.filters, { status: "open" });
  assert.deepEqual(decision.inputs.workStore?.changes, { status: "resolved" });
  assert.equal(decision.inputs.workStore?.entity.status, "working");
  assert.equal(decision.inputs.workStore?.entity.statusReason, "release checks need repair");
  assert.deepEqual(decision.inputs.workStore?.entity.nextInternalActions, ["Inspect release checks"]);
});
