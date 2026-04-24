import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceMatrix,
  type PaperExtraction
} from "../src/runtime/research-evidence.js";

function extraction(id: string, paperId: string): PaperExtraction {
  return {
    id,
    paperId,
    runId: "run-1",
    problemSetting: "Compare research-agent evaluation practices.",
    systemType: "autonomous research runtime",
    architecture: "planner and synthesis loop",
    toolsAndMemory: "paper library and research journal",
    planningStyle: "agenda-driven",
    evaluationSetup: "Compare against documented success criteria.",
    successSignals: [],
    failureModes: ["No failure modes explicitly described"],
    limitations: ["No limitations explicitly described"],
    supportedClaims: [{
      claim: "The paper does not enumerate concrete failure modes.",
      support: "explicit"
    }],
    confidence: "high",
    evidenceNotes: ["Extraction retained the missing-failure-mode filler."]
  };
}

test("evidence matrix ignores repeated low-information failure-mode filler", () => {
  const matrix = buildEvidenceMatrix({
    runId: "run-1",
    brief: {
      topic: "Research agents",
      researchQuestion: "How should autonomous research runtimes be evaluated?",
      researchDirection: "Compare evaluation practices.",
      successCriterion: "Identify concrete gaps and next tasks."
    },
    paperExtractions: [
      extraction("extraction-1", "paper-1"),
      extraction("extraction-2", "paper-2")
    ]
  });

  assert.equal(matrix.rowCount, 2);
  assert.equal(matrix.derivedInsights.some((insight) => insight.kind === "anti_pattern"), false);
  assert.equal(
    matrix.derivedInsights.some((insight) => /no failure modes explicitly described/i.test(insight.title)),
    false
  );
});
