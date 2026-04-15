import test from "node:test";
import assert from "node:assert/strict";
import { verifyResearchClaims } from "../src/runtime/verifier.js";

test("verifier records provenance, evidence links, and supported claims from canonical papers", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "Riemann Hypothesis",
      researchQuestion: "Which proof-technique families are most prominent?",
      researchDirection: "Review prior proof-technique families.",
      successCriterion: "Produce a concise technique map."
    },
    papers: [
      {
        id: "paper-1",
        key: "doi:10.1000/rh-survey",
        title: "A survey of proof strategies for the Riemann Hypothesis",
        citation: "Example Author (2024). A survey of proof strategies for the Riemann Hypothesis.",
        abstract: "Survey-style source describing analytic approaches, common obstacles, and recurring proof motifs.",
        year: 2024,
        authors: ["Example Author"],
        venue: "Number Theory Review",
        discoveredVia: ["openalex"],
        identifiers: {
          doi: "10.1000/rh-survey",
          pmid: null,
          pmcid: null,
          arxivId: null
        },
        discoveryRecords: [],
        accessCandidates: [],
        bestAccessUrl: "https://example.org/rh-survey.pdf",
        bestAccessProvider: "openalex",
        accessMode: "fulltext_open",
        fulltextFormat: "pdf",
        license: null,
        tdmAllowed: true,
        contentStatus: {
          abstractAvailable: true,
          fulltextAvailable: true,
          fulltextFetched: false,
          fulltextExtracted: false
        },
        screeningStage: "fulltext",
        screeningDecision: "include",
        screeningRationale: "Directly relevant survey.",
        accessErrors: [],
        tags: [],
        runIds: [],
        linkedThemeIds: [],
        linkedClaimIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    claims: [
      {
        claim: "Current proof attempts repeatedly return to analytic techniques around the zeta function.",
        evidence: "The gathered papers emphasize analytic methods and frame them as central to the problem.",
        sourceIds: ["paper-1"]
      }
    ]
  });

  assert.equal(report.overallStatus, "grounded");
  assert.equal(report.counts.sources, 1);
  assert.equal(report.counts.supported, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "supported");
  assert.equal(report.verifiedClaims[0]?.confidence, "high");
  assert.equal(report.verifiedClaims[0]?.provenance.length, 1);
  assert.equal(report.verifiedClaims[0]?.evidenceLinks.length, 1);
});

test("verifier marks claims linked only to blocked papers as unverified", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "AI job displacement in nursing homes",
      researchQuestion: "What evidence exists regarding AI job displacement in nursing homes?",
      researchDirection: "Literature review.",
      successCriterion: "Find direct evidence."
    },
    papers: [
      {
        id: "paper-1",
        key: "doi:10.1000/nursing-home",
        title: "AI in nursing homes",
        citation: "Example Author (2025). AI in nursing homes.",
        abstract: null,
        year: 2025,
        authors: ["Example Author"],
        venue: "Care Automation Review",
        discoveredVia: ["crossref"],
        identifiers: {
          doi: "10.1000/nursing-home",
          pmid: null,
          pmcid: null,
          arxivId: null
        },
        discoveryRecords: [],
        accessCandidates: [],
        bestAccessUrl: "https://example.org/paywalled-paper",
        bestAccessProvider: "crossref",
        accessMode: "fulltext_blocked",
        fulltextFormat: "none",
        license: null,
        tdmAllowed: null,
        contentStatus: {
          abstractAvailable: false,
          fulltextAvailable: false,
          fulltextFetched: false,
          fulltextExtracted: false
        },
        screeningStage: "title",
        screeningDecision: "uncertain",
        screeningRationale: "Discovered but not readable.",
        accessErrors: [],
        tags: [],
        runIds: [],
        linkedThemeIds: [],
        linkedClaimIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    claims: [
      {
        claim: "AI is already displacing workers in nursing homes.",
        evidence: "A discovered paper exists, but it remained blocked.",
        sourceIds: ["paper-1"]
      }
    ]
  });

  assert.equal(report.overallStatus, "mixed");
  assert.equal(report.counts.unverified, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "unverified");
  assert.match(report.unverifiedClaims[0]?.reason ?? "", /blocked|credentials/i);
});

test("verifier emits explicit unknown when the claim itself states evidence is limited", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "AI job displacement in nursing homes",
      researchQuestion: "What evidence exists regarding AI job displacement in nursing homes?",
      researchDirection: "Literature review.",
      successCriterion: "Clarify what remains unknown."
    },
    papers: [
      {
        id: "paper-1",
        key: "doi:10.1000/ai-care",
        title: "AI in nursing homes",
        citation: "Example Author (2025). AI in nursing homes.",
        abstract: "The literature remains limited and does not provide direct evidence of workforce displacement.",
        year: 2025,
        authors: ["Example Author"],
        venue: "Care Automation Review",
        discoveredVia: ["openalex"],
        identifiers: {
          doi: "10.1000/ai-care",
          pmid: null,
          pmcid: null,
          arxivId: null
        },
        discoveryRecords: [],
        accessCandidates: [],
        bestAccessUrl: "https://example.org/ai-care",
        bestAccessProvider: "openalex",
        accessMode: "abstract_available",
        fulltextFormat: "none",
        license: null,
        tdmAllowed: null,
        contentStatus: {
          abstractAvailable: true,
          fulltextAvailable: false,
          fulltextFetched: false,
          fulltextExtracted: false
        },
        screeningStage: "abstract",
        screeningDecision: "include",
        screeningRationale: "Abstract-level screening only.",
        accessErrors: [],
        tags: [],
        runIds: [],
        linkedThemeIds: [],
        linkedClaimIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    claims: [
      {
        claim: "There is no direct evidence yet about AI causing job displacement in nursing homes.",
        evidence: "The available literature remains limited and does not provide direct evidence of displacement.",
        sourceIds: ["paper-1"]
      }
    ]
  });

  assert.equal(report.overallStatus, "mixed");
  assert.equal(report.counts.unknown, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "unknown");
  assert.equal(report.verifiedClaims[0]?.confidence, "unknown");
  assert.ok(report.unknowns.some((entry) => /Unknown: There is no direct evidence yet/i.test(entry)));
});
