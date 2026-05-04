import test from "node:test";
import assert from "node:assert/strict";
import {
  guidanceContextForAgent,
  readResearchGuidance,
  recommendResearchGuidance,
  searchResearchGuidance
} from "../src/runtime/research-guidance.js";

test("research guidance is advisory, inspectable, and overridable", () => {
  const result = searchResearchGuidance("citation support release invariants", 3);

  assert.ok(result.count > 0);
  assert.equal(result.advisory, true);
  assert.equal(result.overridable, true);
  assert.equal(result.notAReleaseGate, true);
  assert.ok(result.items.every((item) => item.advisory && item.overridable));
});

test("research guidance can be recommended from a brief without becoming a gate", () => {
  const result = recommendResearchGuidance({
    brief: {
      topic: "autonomous research agents",
      researchQuestion: "How should literature-review agents manage claims and citations?",
      researchDirection: "Review work-store and provenance designs.",
      successCriterion: "Produce a professional paper with traceable citations."
    },
    plan: {
      researchMode: "literature_synthesis",
      objective: "Review claim and citation provenance in research agents.",
      rationale: "The model needs advisory lab scaffolding, not hidden gates.",
      searchQueries: ["autonomous research agents citation provenance"],
      localFocus: ["claims", "citations", "workspace"]
    }
  });

  assert.ok(result.items.some((item) => /workspace|invariants|citation/i.test(`${item.title} ${item.summary}`)));
  const context = guidanceContextForAgent({
    brief: {
      topic: "autonomous research agents",
      researchQuestion: null,
      researchDirection: null,
      successCriterion: null
    }
  });
  assert.equal(context.policy, "advisory_only");
  assert.ok(context.tools.includes("guidance.search"));
});

test("research guidance read returns the full advisory object", () => {
  const item = readResearchGuidance("rubric-release-invariants");

  assert.ok(item !== null);
  assert.equal(item.kind, "QualityRubric");
  assert.equal(item.advisory, true);
  assert.match(item.body, /computable integrity/i);
});

test("research lab manual teaches custom tool families on demand", () => {
  const workspaceGuide = readResearchGuidance("tool-guide.workspace");
  const releaseSearch = searchResearchGuidance("release verify not ready repair", 4);

  assert.ok(workspaceGuide !== null);
  assert.equal(workspaceGuide.kind, "ToolGuide");
  assert.match(workspaceGuide.body, /workspace\.list/);
  assert.match(workspaceGuide.body, /full workspace memory/i);
  assert.ok(releaseSearch.items.some((item) => item.id === "tool-guide.release"));

  const context = guidanceContextForAgent({
    brief: {
      topic: "agentic literature reviews",
      researchQuestion: null,
      researchDirection: null,
      successCriterion: null
    }
  });
  assert.match(context.message, /lab manual/i);
  assert.equal(context.policy, "advisory_only");
});
