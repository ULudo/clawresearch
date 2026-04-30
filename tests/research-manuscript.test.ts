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

test("review protocol separates workflow instructions from evidence targets", () => {
  const protocol = buildReviewProtocol({
    run: {
      id: "run-test",
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "Which architectures and evaluation methods are supported by existing autonomous research-agent system papers?",
        researchDirection: "Review system architectures, tool-use loops, and evaluation methods.",
        successCriterion: "Compare at least five autonomous research-agent systems. Create a source matrix. Convert findings into a design brief."
      }
    } as never,
    plan: {
      researchMode: "literature_synthesis",
      objective: "Review autonomous research-agent system papers.",
      rationale: "A literature synthesis is appropriate.",
      searchQueries: ["autonomous research agents system architecture evaluation"],
      localFocus: [
        "autonomous research-agent systems",
        "create a source matrix",
        "convert findings into a design brief"
      ]
    },
    scholarlyDiscoveryProviders: ["openalex"],
    publisherFullTextProviders: [],
    oaRetrievalHelperProviders: [],
    generalWebProviders: [],
    localContextEnabled: true
  });

  const evidenceText = protocol.evidenceTargets.join(" ");
  const workflowText = protocol.workflowNotes.join(" ");
  const successText = protocol.successCriteria.join(" ");

  assert.match(evidenceText, /autonomous research-agent systems/i);
  assert.doesNotMatch(evidenceText, /source matrix/i);
  assert.doesNotMatch(evidenceText, /design brief/i);
  assert.match(workflowText, /source matrix/i);
  assert.match(workflowText, /design brief/i);
  assert.match(successText, /five autonomous research-agent systems/i);
  assert.doesNotMatch(successText, /source matrix/i);
});
