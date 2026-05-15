import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeResearchActionDecision,
  workspaceResearchActions,
  type ResearchActionName,
  type ResearchActionRequest
} from "../src/runtime/research-agent.js";

const expectedToolFamilies = [
  "notebook.read",
  "notebook.patch",
  "workspace.search",
  "workspace.read",
  "source.search",
  "source.merge",
  "source.resolve_access",
  "source.select_evidence",
  "extraction.create",
  "extraction.patch",
  "evidence.create_cell",
  "evidence.patch",
  "evidence.matrix_view",
  "claim.create",
  "claim.link_support",
  "section.create",
  "section.patch",
  "section.delete",
  "critic.review",
  "check.run",
  "release.verify",
  "manuscript.finalize"
];

function normalizationRequest(allowedActions: ResearchActionName[]): ResearchActionRequest {
  return {
    projectRoot: "/tmp/project",
    runId: "run-normalize",
    phase: "research",
    attempt: 1,
    maxAttempts: 1,
    allowedActions,
    brief: {
      topic: "tool contracts",
      researchQuestion: null,
      researchDirection: null,
      successCriterion: null
    },
    plan: {
      researchMode: "literature_synthesis",
      objective: "Test action normalization.",
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
      sessionStepsUsed: 0
    },
    criticReports: []
  };
}

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
      sessionStepsUsed: 0
    },
    criticReports: []
  });

  assert.deepEqual(decision.inputs.workStore?.filters, { status: "open" });
  assert.deepEqual(decision.inputs.workStore?.changes, { status: "resolved" });
  assert.equal(decision.inputs.workStore?.entity.status, "working");
  assert.equal(decision.inputs.workStore?.entity.statusReason, "release checks need repair");
  assert.deepEqual(decision.inputs.workStore?.entity.nextInternalActions, ["Inspect release checks"]);
});

test("research action normalization preserves typed workStore entity fields with payloadJson as fallback", () => {
  const decision = normalizeResearchActionDecision({
    action: "evidence.create_cell",
    rationale: "Create typed evidence without stringifying the common fields.",
    confidence: 0.84,
    inputs: {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null,
      workStore: {
        collection: "evidenceCells",
        entityId: null,
        filters: {},
        filterJson: null,
        semanticQuery: null,
        limit: null,
        cursor: null,
        changes: {},
        patchJson: null,
        entity: {
          sourceId: "source-1",
          paperId: "paper-1",
          extractionId: "extraction-1",
          field: "limitations",
          value: ["The evaluation is small."],
          text: "The evaluation is small.",
          claimId: "claim-1",
          evidenceCellId: "evidence-1",
          supportSnippet: "The paper reports a small evaluation.",
          sectionIds: ["discussion"],
          markdown: "## Discussion\n\nSmall evaluation.",
          status: "working",
          statusReason: "Typed field should win.",
          nextInternalActions: ["Link support next"]
        },
        payloadJson: "{\"statusReason\":\"payload fallback reason\",\"confidence\":\"high\",\"sourceId\":\"payload-source\"}",
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
    expectedOutcome: "Evidence cell is persisted.",
    stopCondition: "Stop after evidence creation."
  }, normalizationRequest(["evidence.create_cell"]));

  const entity = decision.inputs.workStore?.entity ?? {};
  assert.equal(entity.sourceId, "source-1");
  assert.equal(entity.paperId, "paper-1");
  assert.equal(entity.extractionId, "extraction-1");
  assert.equal(entity.field, "limitations");
  assert.deepEqual(entity.value, ["The evaluation is small."]);
  assert.equal(entity.text, "The evaluation is small.");
  assert.equal(entity.claimId, "claim-1");
  assert.equal(entity.evidenceCellId, "evidence-1");
  assert.equal(entity.supportSnippet, "The paper reports a small evaluation.");
  assert.deepEqual(entity.sectionIds, ["discussion"]);
  assert.equal(entity.markdown, "## Discussion\n\nSmall evaluation.");
  assert.equal(entity.status, "working");
  assert.equal(entity.statusReason, "Typed field should win.");
  assert.deepEqual(entity.nextInternalActions, ["Link support next"]);
  assert.equal(entity.confidence, "high");
});
