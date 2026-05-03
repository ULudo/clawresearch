import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewProtocol } from "../src/runtime/research-manuscript.js";

test("fallback review protocol does not derive required semantic facets from prompt wording", () => {
  const protocol = buildReviewProtocol({
    run: {
      id: "run-test",
      brief: {
        topic: "agent-owned scope",
        researchQuestion: "Which sources should the researcher inspect?",
        researchDirection: "The model-authored workspace protocol defines semantic scope.",
        successCriterion: "Produce a complete publication-style paper. Create a source matrix. Use traceable citations."
      }
    } as never,
    plan: {
      researchMode: "literature_synthesis",
      objective: "Review sources chosen by the researcher agent.",
      rationale: "The runtime only exports a neutral shell until the model-authored protocol exists.",
      searchQueries: ["researcher selected sources"],
      localFocus: ["researcher selected evidence"]
    },
    scholarlyDiscoveryProviders: ["openalex"],
    publisherFullTextProviders: [],
    oaRetrievalHelperProviders: [],
    generalWebProviders: [],
    localContextEnabled: true
  }) as Record<string, unknown>;

  assert.equal("requiredSuccessCriterionFacets" in protocol, false);
  assert.deepEqual(protocol.evidenceTargets, [
    "researcher selected evidence",
    "Review sources chosen by the researcher agent."
  ]);
  assert.match(JSON.stringify(protocol.workflowNotes), /source matrix/i);
  assert.match(JSON.stringify(protocol.successCriteria), /traceable citations/i);
});
