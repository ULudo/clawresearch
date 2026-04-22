import test from "node:test";
import assert from "node:assert/strict";
import {
  assessLiteratureSource,
  buildLiteratureReviewProfile,
  shouldUseLiteratureReviewSubsystem
} from "../src/runtime/literature-review.js";
import type { ProjectMemoryContext } from "../src/runtime/memory-store.js";

function emptyMemoryContext(): ProjectMemoryContext {
  return {
    available: false,
    recordCount: 0,
    countsByType: {
      claim: 0,
      finding: 0,
      question: 0,
      idea: 0,
      summary: 0,
      artifact: 0,
      direction: 0,
      hypothesis: 0,
      method_plan: 0
    },
    claims: [],
    findings: [],
    questions: [],
    ideas: [],
    summaries: [],
    artifacts: [],
    directions: [],
    hypotheses: [],
    methodPlans: [],
    queryHints: [],
    localFileHints: []
  };
}

test("literature review profile derives task-aware queries and attributes for a review-style brief", () => {
  const profile = buildLiteratureReviewProfile({
    brief: {
      topic: "autonomous research agents",
      researchQuestion: "What best practices for designing and implementing autonomous research agents improve the odds of successful and publishable AI research?",
      researchDirection: "Start with a literature synthesis that compares design patterns, implementation tradeoffs, and evaluation practices.",
      successCriterion: "Produce a literature-grounded note with concrete design patterns and next-step questions."
    },
    plan: {
      researchMode: "literature_synthesis",
      objective: "Synthesize best practices for autonomous research agents in AI research.",
      rationale: "A first-pass literature review is the safest grounded starting point.",
      searchQueries: [
        "autonomous research agents best practices",
        "autonomous research agents design patterns"
      ],
      localFocus: [
        "design patterns",
        "evaluation practices"
      ]
    },
    memoryContext: emptyMemoryContext()
  });

  assert.equal(shouldUseLiteratureReviewSubsystem({
    researchMode: "literature_synthesis",
    objective: "Synthesize best practices",
    rationale: "Literature review first.",
    searchQueries: [],
    localFocus: []
  }, {
    topic: "autonomous research agents",
    researchQuestion: "What does the literature say?",
    researchDirection: "Review the field.",
    successCriterion: "Produce a grounded literature note."
  }), true);
  assert.match(profile.domainAnchors.join(" | "), /autonomous research agents/i);
  assert.ok(profile.taskAttributes.includes("survey"));
  assert.ok(profile.taskAttributes.includes("implementation"));
  assert.ok(profile.taskAttributes.includes("best_practices"));
  assert.ok(
    profile.searchQueries.some((query) => /autonomous research agents .*best practices/i.test(query)),
    `Expected task-aware literature query, saw: ${profile.searchQueries.join(" | ")}`
  );
});

test("literature source assessment rejects generic background material that only matches task words", () => {
  const profile = buildLiteratureReviewProfile({
    brief: {
      topic: "autonomous research agents",
      researchQuestion: "What best practices for designing and implementing autonomous research agents improve the odds of successful and publishable AI research?",
      researchDirection: "Compare architectures and workflow patterns through literature synthesis.",
      successCriterion: "Produce a grounded best-practices note."
    },
    plan: {
      researchMode: "literature_synthesis",
      objective: "Compare design patterns for autonomous research agents.",
      rationale: "Use a literature review rather than generic background browsing.",
      searchQueries: [
        "autonomous research agents design patterns"
      ],
      localFocus: [
        "design patterns"
      ]
    },
    memoryContext: emptyMemoryContext()
  });

  const relevant = assessLiteratureSource(profile, {
    title: "Design Patterns for Autonomous Research Agents",
    citation: "Example Author (2026). Design Patterns for Autonomous Research Agents.",
    excerpt: "This review compares architecture choices, evaluation practices, and workflow patterns for autonomous research agents."
  });
  const generic = assessLiteratureSource(profile, {
    title: "Learning analytics and AI: Politics, pedagogy and practices",
    citation: "Generic Author (2020). Learning analytics and AI: Politics, pedagogy and practices.",
    excerpt: "This paper discusses AI practices in education and learning analytics."
  });

  assert.equal(relevant.accepted, true);
  assert.equal(generic.accepted, false);
  assert.match(generic.rationale, /did not match the core domain anchors/i);
});
