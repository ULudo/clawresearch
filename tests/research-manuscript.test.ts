import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewProtocol } from "../src/runtime/research-manuscript.js";

test("review protocol ignores file-like local focus entries as evidence targets", () => {
  const protocol = buildReviewProtocol({
    run: {
      id: "run-test",
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "How can autonomous research agents automate literature reviews?",
        researchDirection: "Review retrieval, synthesis, and evaluation methods.",
        successCriterion: "Produce a grounded review with traceable citations."
      }
    } as never,
    plan: {
      researchMode: "literature_synthesis",
      objective: "Review autonomous research-agent literature workflows.",
      rationale: "A literature synthesis is appropriate.",
      searchQueries: ["autonomous research agents literature review automation"],
      localFocus: ["cli-input.txt", "literature review automation"]
    },
    scholarlyDiscoveryProviders: ["openalex"],
    publisherFullTextProviders: [],
    oaRetrievalHelperProviders: [],
    generalWebProviders: [],
    localContextEnabled: true
  });

  assert.ok(protocol.evidenceTargets.includes("literature review automation"));
  assert.ok(!protocol.evidenceTargets.includes("cli-input.txt"));
  assert.ok(!protocol.requiredSuccessCriterionFacets.some((facet) => facet.label === "cli-input.txt"));
});
