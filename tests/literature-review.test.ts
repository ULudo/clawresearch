import test from "node:test";
import assert from "node:assert/strict";
import {
  assessPaperFacetCoverage,
  assessLiteratureSource,
  buildReviewFacets,
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

test("review facets ignore manuscript-quality instructions while keeping topical facets", () => {
  const facets = buildReviewFacets({
    brief: {
      topic: "autonomous research agents for scientific discovery",
      researchQuestion: "How do autonomous research agents use experimentation and evaluation in scientific discovery?",
      researchDirection: "Compare autonomous research agent systems, their experimentation loops, and evaluation practices.",
      successCriterion: "Write a coherent evidence-backed review paper with 25-45 strong references, citations, limitations, and clear separation of proven statements from speculation."
    },
    plan: {
      researchMode: "literature_synthesis",
      objective: "Synthesize autonomous research agent systems for scientific discovery.",
      rationale: "A literature synthesis is appropriate.",
      searchQueries: ["autonomous research agents scientific discovery evaluation"],
      localFocus: ["experimentation", "evaluation"]
    }
  });
	  const labels = facets.map((facet) => facet.label.toLowerCase());

	  assert.ok(labels.some((label) => /autonomous research agents/.test(label)));
	  assert.ok(labels.some((label) => /experimentation/.test(label)));
	  assert.ok(labels.some((label) => /evaluation/.test(label)));
  assert.ok(!labels.some((label) => /reference|citation|coherent|evidence-backed|limitation|proven statements/.test(label)));
	  assert.ok(!labels.some((label) => /comprehensiveness|meet standard|standard comprehensiveness|typically expected|high-quality including|design build|build efficient/.test(label)));
  assert.ok(!labels.some((label) => /complete publication-style section|effect from uses|method constraint distinguishing|section traceable only/.test(label)));
	});

test("facet coverage does not reward generic design or efficiency matches without the core topic", () => {
  const facets = buildReviewFacets({
    brief: {
      topic: "Design and build efficient autonomous research agents",
      researchQuestion: "How can autonomous research agents perform literature review, information retrieval, summarization, and information organization?",
      researchDirection: "Review systems that perform autonomous literature review workflows.",
      successCriterion: "Meet the standards of quality and comprehensiveness typically expected in academic research."
    },
    plan: {
      researchMode: "literature_synthesis",
      objective: "Synthesize design methods for autonomous research agents.",
      rationale: "A literature synthesis is appropriate.",
      searchQueries: ["autonomous research agents literature review"],
      localFocus: ["information retrieval", "summarization", "information organization"]
    }
  });
  const labels = facets.map((facet) => facet.label.toLowerCase());
  const offTopicCoverage = assessPaperFacetCoverage(facets, {
    id: "paper-cmip6",
    title: "Overview of the Coupled Model Intercomparison Project Phase 6 experimental design and organization",
    citation: "Climate Author (2016). CMIP6 experimental design and organization.",
    abstract: "The paper describes efficient experimental design and organization for climate model comparison.",
    venue: "Geoscientific Model Development"
  });

  assert.ok(labels.some((label) => /autonomous research agents/.test(label)));
  assert.ok(!labels.some((label) => /comprehensiveness|meet standard|design build|build efficient/.test(label)));
  assert.equal(offTopicCoverage.coveredFacetIds.some((facetId) => /autonomous-research-agents/.test(facetId)), false);
  assert.equal(offTopicCoverage.coverageScore, 0);
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
