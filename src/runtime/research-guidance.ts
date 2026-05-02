import type { ResearchPlan } from "./research-backend.js";
import type { ResearchBrief } from "./session-store.js";

export type ResearchGuidanceKind =
  | "ResearchGuideline"
  | "ResearchPlaybook"
  | "ProtocolTemplate"
  | "QualityRubric"
  | "ExampleArtifact";

export type ResearchGuidanceObject = {
  id: string;
  kind: ResearchGuidanceKind;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  advisory: true;
  overridable: true;
  notAReleaseGate: true;
};

export type ResearchGuidancePreview = {
  id: string;
  kind: ResearchGuidanceKind;
  title: string;
  summary: string;
  tags: string[];
  advisory: true;
  overridable: true;
};

export type ResearchGuidanceContext = {
  available: true;
  policy: "advisory_only";
  message: string;
  recommended: ResearchGuidancePreview[];
  tools: Array<"guidance.search" | "guidance.read" | "guidance.recommend">;
};

export type ResearchGuidanceSearchResult = {
  query: string | null;
  count: number;
  items: ResearchGuidancePreview[];
  advisory: true;
  overridable: true;
  notAReleaseGate: true;
};

const builtinGuidance: ResearchGuidanceObject[] = [
  {
    id: "playbook-literature-review-workspace",
    kind: "ResearchPlaybook",
    title: "Agentic literature review workspace",
    summary: "Use the workspace as memory: search, inspect, screen, extract, claim, cite, write, check, and revise as needed.",
    body: [
      "Treat research as an observe-act-persist loop rather than a fixed phase pipeline.",
      "Use workspace.list/search/read to inspect durable state before repeating work.",
      "Use source.search when the current workspace lacks the evidence needed for the researcher's own claims.",
      "Use claim and section tools to build synthesis in small, provenance-aware units.",
      "Use critic and checks as feedback generators, then turn their concrete objections into normal work items or revisions."
    ].join("\n"),
    tags: ["literature review", "workspace", "agent loop", "provenance"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "rubric-release-invariants",
    kind: "QualityRubric",
    title: "Release invariants for manuscript exports",
    summary: "A manuscript export should have renderable citations, valid support links, known source IDs, and no broken provenance.",
    body: [
      "Hard release checks are only for computable integrity problems.",
      "Every cited claim used in a manuscript section should link to a claim, support link, evidence cell or source, and renderable reference.",
      "Semantic disagreements such as weak relevance or incomplete coverage should be represented as warnings, critic objections, or work items.",
      "Do not treat a low lexical match as an automatic exclusion; the researcher owns source interpretation."
    ].join("\n"),
    tags: ["release", "citations", "support links", "invariants"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "template-review-protocol",
    kind: "ProtocolTemplate",
    title: "Review protocol template",
    summary: "A lightweight protocol can state scope, inclusion/exclusion criteria, evidence targets, and manuscript constraints.",
    body: [
      "Scope: What phenomenon, population, domain, method, or theory is being reviewed?",
      "Inclusion criteria: What kinds of sources can support the review?",
      "Exclusion criteria: What sources are outside the research objective?",
      "Evidence targets: What facts, methods, outcomes, limitations, or controversies should be extracted?",
      "Manuscript constraints: What output format, citation style, or audience requirements apply?"
    ].join("\n"),
    tags: ["protocol", "scope", "criteria", "evidence targets"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "guideline-critic-work-items",
    kind: "ResearchGuideline",
    title: "Critic feedback as research debt",
    summary: "Critic objections should become visible work items or revisions, not hidden runtime decisions.",
    body: [
      "The critic is a reviewer/supervisor, not a second researcher.",
      "It should point to concrete targets such as claims, sections, evidence cells, sources, protocol criteria, or citation links.",
      "The main researcher decides whether to search more, revise a claim, soften wording, patch citations, revise the protocol, or explain an uncertainty.",
      "Only broken schemas, IDs, source access requirements, citation integrity, or export failures are hard runtime blockers."
    ].join("\n"),
    tags: ["critic", "work items", "review", "diagnostics"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "example-section-claim-citation",
    kind: "ExampleArtifact",
    title: "Section, claim, and citation shape",
    summary: "A section should point to claims, and claims should carry support links to evidence or sources.",
    body: [
      "Example section: related_work links claim-001 and claim-002.",
      "Example claim: claim-001 states a bounded finding and records supportStatus.",
      "Example support link: citation-001 connects claim-001 to evidence-cell-001 and source-001 with a short support snippet.",
      "References are generated from support links actually used by claims in sections."
    ].join("\n"),
    tags: ["example", "section", "claim", "citation", "support"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  }
];

function preview(guidance: ResearchGuidanceObject): ResearchGuidancePreview {
  return {
    id: guidance.id,
    kind: guidance.kind,
    title: guidance.title,
    summary: guidance.summary,
    tags: guidance.tags,
    advisory: true,
    overridable: true
  };
}

function terms(text: string | null | undefined): string[] {
  if (typeof text !== "string") {
    return [];
  }

  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3);
}

function guidanceScore(guidance: ResearchGuidanceObject, queryTerms: string[]): number {
  if (queryTerms.length === 0) {
    return 1;
  }

  const haystack = [
    guidance.id,
    guidance.kind,
    guidance.title,
    guidance.summary,
    guidance.body,
    guidance.tags.join(" ")
  ].join(" ").toLowerCase();

  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export function searchResearchGuidance(query: string | null | undefined, limit = 6): ResearchGuidanceSearchResult {
  const queryTerms = terms(query);
  const items = builtinGuidance
    .map((guidance) => ({ guidance, score: guidanceScore(guidance, queryTerms) }))
    .filter((entry) => queryTerms.length === 0 || entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map((entry) => preview(entry.guidance));

  return {
    query: typeof query === "string" && query.trim().length > 0 ? query.trim() : null,
    count: items.length,
    items,
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  };
}

export function readResearchGuidance(id: string | null | undefined): ResearchGuidanceObject | null {
  if (typeof id !== "string" || id.trim().length === 0) {
    return null;
  }

  return builtinGuidance.find((guidance) => guidance.id === id.trim()) ?? null;
}

export function recommendResearchGuidance(input: {
  brief: ResearchBrief;
  plan?: ResearchPlan | null;
  limit?: number;
}): ResearchGuidanceSearchResult {
  const query = [
    input.brief.topic,
    input.brief.researchQuestion,
    input.brief.researchDirection,
    input.brief.successCriterion,
    input.plan?.objective,
    input.plan?.rationale,
    ...(input.plan?.searchQueries ?? [])
  ].filter((value): value is string => typeof value === "string").join(" ");

  return searchResearchGuidance(query, input.limit ?? 4);
}

export function guidanceContextForAgent(input: {
  brief: ResearchBrief;
  plan?: ResearchPlan | null;
}): ResearchGuidanceContext {
  return {
    available: true,
    policy: "advisory_only",
    message: "Guidance is visible research-lab scaffolding. It may inform actions, but it is advisory, inspectable, and overridable; it is never a hidden release gate.",
    recommended: recommendResearchGuidance({
      brief: input.brief,
      plan: input.plan ?? null,
      limit: 4
    }).items,
    tools: ["guidance.search", "guidance.read", "guidance.recommend"]
  };
}
