import test from "node:test";
import assert from "node:assert/strict";
import {
  criticUnavailableReview,
  normalizeCriticReview,
  type CriticReviewRequest
} from "../src/runtime/research-critic.js";
import type { CanonicalPaper } from "../src/runtime/literature-store.js";

function paper(id: string): CanonicalPaper {
  return {
    id,
    key: `doi:10.1000/${id}`,
    title: `Paper ${id}`,
    citation: `Example Author (2026). Paper ${id}.`,
    abstract: "A scoped paper.",
    year: 2026,
    authors: ["Example Author"],
    venue: "Review Journal",
    discoveredVia: ["openalex"],
    identifiers: {
      doi: `10.1000/${id}`,
      pmid: null,
      pmcid: null,
      arxivId: null
    },
    discoveryRecords: [],
    accessCandidates: [],
    bestAccessUrl: null,
    bestAccessProvider: null,
    accessMode: "metadata_only",
    fulltextFormat: "none",
    license: null,
    tdmAllowed: null,
    contentStatus: {
      abstractAvailable: true,
      fulltextAvailable: false,
      fulltextFetched: false,
      fulltextExtracted: false
    },
    screeningHistory: [],
    screeningStage: "abstract",
    screeningDecision: "include",
    screeningRationale: "Relevant.",
    accessErrors: [],
    tags: [],
    runIds: [],
    linkedThemeIds: [],
    linkedClaimIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function request(): CriticReviewRequest {
  return {
    projectRoot: "/tmp/project",
    runId: "run-test",
    stage: "source_selection",
    brief: {
      topic: "autonomous research agents",
      researchQuestion: "Which evidence supports literature-review automation?",
      researchDirection: "Review scoped literature.",
      successCriterion: "Use only on-topic evidence."
    },
    selectedPapers: [paper("paper-1")],
    paper: {
      schemaVersion: 1,
      runId: "run-test",
      briefFingerprint: "brief",
      title: "Draft",
      abstract: "Draft",
      reviewType: "technical_survey",
      structureRationale: "Draft",
      scientificRoles: [],
      sections: [],
      claims: [{
        claimId: "claim-1",
        claim: "Scoped claim.",
        evidence: "Evidence.",
        sourceIds: ["paper-1"]
      }],
      citationLinks: [],
      referencedPaperIds: ["paper-1"],
      evidenceTableIds: [],
      limitations: [],
      readinessStatus: "drafted"
    }
  };
}

test("critic output normalization filters invented IDs and caps revision advice", () => {
  const normalized = normalizeCriticReview({
    readiness: "revise",
    confidence: 2,
    objections: [{
      severity: "major",
      target: "source_selection",
      message: "One selected paper is outside the scoped evidence target.",
      affectedPaperIds: ["paper-1", "invented-paper"],
      affectedClaimIds: ["claim-1", "invented-claim"],
      suggestedRevision: "Search for direct literature-review automation evaluations."
    }],
    revisionAdvice: {
      searchQueries: Array.from({ length: 20 }, (_, index) => `query ${index}`),
      evidenceTargets: ["direct evaluation"],
      papersToExclude: ["paper-1", "invented-paper"],
      claimsToSoften: ["claim-1", "invented-claim"]
    }
  }, request());

  assert.equal(normalized.readiness, "revise");
  assert.equal(normalized.confidence, 1);
  assert.deepEqual(normalized.objections[0].affectedPaperIds, ["paper-1"]);
  assert.deepEqual(normalized.objections[0].affectedClaimIds, ["claim-1"]);
  assert.equal(normalized.revisionAdvice.searchQueries.length, 12);
  assert.deepEqual(normalized.revisionAdvice.papersToExclude, ["paper-1"]);
  assert.deepEqual(normalized.revisionAdvice.claimsToSoften, ["claim-1"]);
});

test("malformed critic output becomes a blocking diagnostic", () => {
  const normalized = normalizeCriticReview({}, request());

  assert.equal(normalized.readiness, "block");
  assert.equal(normalized.objections[0].severity, "blocking");
  assert.match(normalized.objections[0].message, /did not provide a structured objection/);
});

test("protocol critic normalization drops premature missing-source objections", () => {
  const normalized = normalizeCriticReview({
    readiness: "block",
    confidence: 0.95,
    objections: [{
      code: "no_selected_papers",
      severity: "blocking",
      target: "source_selection",
      message: "No papers have been selected for review, so evidence cannot be synthesized yet.",
      affectedPaperIds: [],
      affectedClaimIds: [],
      suggestedRevision: "Run retrieval with the protocol queries."
    }],
    revisionAdvice: {
      searchQueries: ["autonomous research agents literature review"],
      evidenceTargets: ["literature review automation"],
      papersToExclude: [],
      claimsToSoften: []
    }
  }, {
    ...request(),
    stage: "protocol",
    selectedPapers: [],
    paper: null,
    verification: null
  });

  assert.equal(normalized.readiness, "pass");
  assert.deepEqual(normalized.objections, []);
  assert.deepEqual(normalized.revisionAdvice.searchQueries, ["autonomous research agents literature review"]);
});

test("protocol critic normalization keeps real protocol objections", () => {
  const normalized = normalizeCriticReview({
    readiness: "block",
    objections: [{
      code: "bad-target",
      severity: "blocking",
      target: "protocol",
      message: "The protocol turns output-style requirements into evidence targets.",
      affectedPaperIds: [],
      affectedClaimIds: [],
      suggestedRevision: "Move writing-style requirements to manuscript constraints."
    }]
  }, {
    ...request(),
    stage: "protocol"
  });

  assert.equal(normalized.readiness, "block");
  assert.equal(normalized.objections[0].target, "protocol");
  assert.match(normalized.objections[0].message, /output-style/);
});

test("critic unavailable report blocks release explicitly", () => {
  const unavailable = criticUnavailableReview(request(), "timeout");

  assert.equal(unavailable.readiness, "block");
  assert.equal(unavailable.objections[0].code, "critic-unavailable");
  assert.match(unavailable.objections[0].message, /timeout/);
});
