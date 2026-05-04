import type { ResearchPlan } from "./research-backend.js";
import type { ResearchBrief } from "./session-store.js";

export type ResearchGuidanceKind =
  | "ToolGuide"
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
    id: "tool-guide.workspace",
    kind: "ToolGuide",
    title: "Workspace lookup tools",
    summary: "Use workspace.list/search/read like ls, grep, and cat for the durable research workspace.",
    body: [
      "The workspace dashboard is only an index; do not treat it as the full workspace memory.",
      "Use workspace.list with a collection to enumerate durable objects and get previews plus cursors.",
      "Use workspace.search with a short semantic query when you know the concept but not the id.",
      "Use workspace.read with a known entity id when a preview is not enough to decide the next action.",
      "Typical sequence: workspace.list claims -> workspace.read claim-123 -> claim.patch or claim.link_support."
    ].join("\n"),
    tags: ["tool guide", "workspace", "lookup", "list", "search", "read"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "tool-guide.sources",
    kind: "ToolGuide",
    title: "Source discovery tools",
    summary: "Use source.search, source.merge, source.resolve_access, and source.select_evidence as explicit source operations.",
    body: [
      "Use source.search with explicit provider ids and search query text chosen by the researcher.",
      "Use source.merge after useful candidates exist; merge deduplicates and creates canonical source records.",
      "Use source.resolve_access with known canonical source ids when access/full-text status matters.",
      "Use source.select_evidence with known source ids when you intentionally choose the current evidence set.",
      "A failed or low-yield search is an observation; inspect sourceState and choose another explicit action if machine-actionable work remains."
    ].join("\n"),
    tags: ["tool guide", "sources", "search", "merge", "access", "evidence set"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "tool-guide.extractions",
    kind: "ToolGuide",
    title: "Extraction and evidence tools",
    summary: "Use extraction.create and evidence.create_cell to persist model-authored reading notes and evidence.",
    body: [
      "Use extraction.create only for a known canonical source id and include the extracted research content in the payload.",
      "Use evidence.create_cell after an extraction exists for that source; evidence cells are durable support material for claims.",
      "Use evidence.matrix_view as a read-only view over existing extractions/evidence; it must not create evidence by itself.",
      "If the needed source or extraction id is unclear, inspect with workspace.list/search/read first."
    ].join("\n"),
    tags: ["tool guide", "extraction", "evidence", "matrix view", "reading notes"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "tool-guide.claims",
    kind: "ToolGuide",
    title: "Claim and citation tools",
    summary: "Use claim tools to create bounded claims and connect them to exact support links.",
    body: [
      "Use claim.create for one bounded research claim, not an entire paper section.",
      "Use claim.link_support to connect a claim to a known evidence cell/source with a support snippet.",
      "Use claim.check_support to inspect whether a claim has renderable support.",
      "A manuscript claim should be softened, revised, or marked uncertain when support is weak; do not invent citations."
    ].join("\n"),
    tags: ["tool guide", "claims", "citations", "support links", "provenance"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "tool-guide.sections",
    kind: "ToolGuide",
    title: "Manuscript section tools",
    summary: "Use section tools to draft and revise manuscript sections from claims and cited support.",
    body: [
      "Use section.create for a durable manuscript section with a clear title, role, markdown, and source/claim ids.",
      "Use section.patch to revise section text or metadata.",
      "Use section.link_claim to connect an existing section to an existing claim.",
      "Use section.check_claims to create visible work items when section claims lack support."
    ].join("\n"),
    tags: ["tool guide", "sections", "manuscript", "drafting", "revision"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "tool-guide.release",
    kind: "ToolGuide",
    title: "Release verification and export tools",
    summary: "Use release.verify and manuscript.release only when the workspace appears ready for mechanical release checks.",
    body: [
      "Use release.verify to run computable invariant checks: known ids, support links, citations, references, and sections.",
      "If release.verify reports failures, treat them as repair observations and continue with explicit workspace, claim, section, or source tools.",
      "Use manuscript.release to export paper.md from workspace state only after hard invariants pass.",
      "Release failure means not ready; it is not a reason to stop unless the remaining issue is truly external or requires a user decision."
    ].join("\n"),
    tags: ["tool guide", "release", "verify", "paper", "references", "not ready"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
  {
    id: "tool-guide.checkpoints",
    kind: "ToolGuide",
    title: "Checkpoint and status tool",
    summary: "Use workspace.status only for true checkpoints, external blockers, or real user decisions.",
    body: [
      "Do not use workspace.status simply because more machine-actionable work remains.",
      "If checkpointing, include the concrete current state and any model-authored nextInternalActions.",
      "Use externally_blocked only for real outside limitations such as credentials, provider outage, quota, access, or permissions.",
      "Use needs_user_decision only when you provide a concrete decision question and explicit options."
    ].join("\n"),
    tags: ["tool guide", "checkpoint", "status", "continuation", "user decision"],
    advisory: true,
    overridable: true,
    notAReleaseGate: true
  },
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
    message: "Guidance is the visible ClawResearch lab manual. Use guidance.search/read/recommend when a tool family is unclear. Guidance is advisory, inspectable, overridable, and never a hidden release gate.",
    recommended: recommendResearchGuidance({
      brief: input.brief,
      plan: input.plan ?? null,
      limit: 4
    }).items,
    tools: ["guidance.search", "guidance.read", "guidance.recommend"]
  };
}
