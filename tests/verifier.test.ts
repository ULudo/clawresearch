import test from "node:test";
import assert from "node:assert/strict";
import { verifyResearchClaims } from "../src/runtime/verifier.js";

test("verifier records provenance, evidence links, and supported claims", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "Riemann Hypothesis",
      researchQuestion: "Which proof-technique families are most prominent?",
      researchDirection: "Review prior proof-technique families.",
      successCriterion: "Produce a concise technique map."
    },
    sources: [
      {
        id: "brief-1",
        kind: "project_brief",
        title: "Riemann Hypothesis",
        locator: null,
        citation: "User-provided project brief.",
        excerpt: "Topic: Riemann Hypothesis."
      },
      {
        id: "web-1",
        kind: "openalex_work",
        title: "A survey of proof strategies for the Riemann Hypothesis",
        locator: "https://example.org/rh-survey",
        citation: "Example Author (2024). A survey of proof strategies for the Riemann Hypothesis.",
        excerpt: "Survey-style source describing analytic approaches, common obstacles, and recurring proof motifs."
      }
    ],
    claims: [
      {
        claim: "Current proof attempts repeatedly return to analytic techniques around the zeta function.",
        evidence: "The gathered sources emphasize analytic methods and frame them as central to the problem.",
        sourceIds: ["brief-1", "web-1"]
      }
    ]
  });

  assert.equal(report.overallStatus, "grounded");
  assert.equal(report.counts.sources, 2);
  assert.equal(report.counts.supported, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "supported");
  assert.equal(report.verifiedClaims[0]?.confidence, "medium");
  assert.equal(report.verifiedClaims[0]?.provenance.length, 2);
  assert.equal(report.verifiedClaims[0]?.evidenceLinks.length, 2);
});

test("verifier marks claims linked only to the project brief as unverified", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "AI job displacement in nursing homes",
      researchQuestion: "What evidence exists regarding AI job displacement in nursing homes?",
      researchDirection: "Literature review.",
      successCriterion: "Find direct evidence."
    },
    sources: [
      {
        id: "brief-1",
        kind: "project_brief",
        title: "AI job displacement in nursing homes",
        locator: null,
        citation: "User-provided project brief.",
        excerpt: "Topic: AI job displacement in nursing homes."
      }
    ],
    claims: [
      {
        claim: "AI is already displacing workers in nursing homes.",
        evidence: "The user described the concern in the project brief.",
        sourceIds: ["brief-1"]
      }
    ]
  });

  assert.equal(report.overallStatus, "insufficient_evidence");
  assert.equal(report.counts.unverified, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "unverified");
  assert.match(report.unverifiedClaims[0]?.reason ?? "", /project brief/i);
  assert.ok(report.unknowns.some((entry) => /No evidence-bearing sources beyond the project brief/i.test(entry)));
});

test("verifier emits explicit unknown when the claim itself states evidence is limited", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "AI job displacement in nursing homes",
      researchQuestion: "What evidence exists regarding AI job displacement in nursing homes?",
      researchDirection: "Literature review.",
      successCriterion: "Clarify what remains unknown."
    },
    sources: [
      {
        id: "web-1",
        kind: "openalex_work",
        title: "AI in nursing homes",
        locator: "https://example.org/ai-nursing-home",
        citation: "Example Author (2025). AI in nursing homes.",
        excerpt: "The literature remains limited and does not provide direct evidence of workforce displacement."
      }
    ],
    claims: [
      {
        claim: "There is no direct evidence yet about AI causing job displacement in nursing homes.",
        evidence: "The available literature remains limited and does not provide direct evidence of displacement.",
        sourceIds: ["web-1"]
      }
    ]
  });

  assert.equal(report.overallStatus, "mixed");
  assert.equal(report.counts.unknown, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "unknown");
  assert.equal(report.verifiedClaims[0]?.confidence, "unknown");
  assert.ok(report.unknowns.some((entry) => /Unknown: There is no direct evidence yet/i.test(entry)));
});
