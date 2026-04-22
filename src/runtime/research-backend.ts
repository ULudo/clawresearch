import type { ResearchBrief } from "./session-store.js";
import {
  createMemoryRecordId,
  type ProjectMemoryContext
} from "./memory-store.js";
import type {
  CanonicalPaper,
  LiteratureContext
} from "./literature-store.js";
import type { VerificationReport } from "./verifier.js";
import {
  buildLiteratureSynthesisInstruction,
  shouldUseLiteratureReviewSubsystem
} from "./literature-review.js";

const defaultHost = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const defaultModel = process.env.CLAWRESEARCH_OLLAMA_MODEL ?? "qwen3:14b";

export type ResearchMode =
  | "literature_synthesis"
  | "replication"
  | "benchmarking"
  | "ablation"
  | "method_improvement"
  | "new_hypothesis";

export type ResearchPlan = {
  researchMode: ResearchMode;
  objective: string;
  rationale: string;
  searchQueries: string[];
  localFocus: string[];
};

export type ResearchTheme = {
  title: string;
  summary: string;
  sourceIds: string[];
};

export type ResearchClaim = {
  claim: string;
  evidence: string;
  sourceIds: string[];
};

export type ResearchGapKind =
  | "missing_baseline"
  | "confounder"
  | "coverage_gap"
  | "method_gap"
  | "evidence_conflict";

export type ResearchGapSeverity =
  | "low"
  | "medium"
  | "high";

export type DirectionScores = {
  evidenceBase: number;
  novelty: number;
  tractability: number;
  expectedCost: number;
  risk: number;
  overall: number;
};

export type ResearchGap = {
  id: string;
  title: string;
  summary: string;
  sourceIds: string[];
  claimIds: string[];
  severity: ResearchGapSeverity;
  gapKind: ResearchGapKind;
};

export type ResearchDirectionCandidate = {
  id: string;
  title: string;
  summary: string;
  mode: ResearchMode;
  whyNow: string;
  sourceIds: string[];
  claimIds: string[];
  gapIds: string[];
  scores: DirectionScores;
};

export type WorkPackage = {
  id: string;
  title: string;
  mode: ResearchMode;
  objective: string;
  hypothesisOrQuestion: string;
  methodSketch: string;
  baselines: string[];
  controls: string[];
  decisiveExperiment: string;
  stopCriterion: string;
  expectedArtifact: string;
  requiredInputs: string[];
  blockedBy: string[];
};

export type ResearchAgenda = {
  executiveSummary: string;
  gaps: ResearchGap[];
  candidateDirections: ResearchDirectionCandidate[];
  selectedDirectionId: string | null;
  selectedWorkPackage: WorkPackage | null;
  holdReasons: string[];
  recommendedHumanDecision: string;
};

export type ResearchSynthesis = {
  executiveSummary: string;
  themes: ResearchTheme[];
  claims: ResearchClaim[];
  nextQuestions: string[];
};

export type ResearchPlanningRequest = {
  projectRoot: string;
  brief: ResearchBrief;
  localFiles: string[];
  memoryContext: ProjectMemoryContext;
  literatureContext?: LiteratureContext;
};

export type ResearchSynthesisRequest = {
  projectRoot: string;
  brief: ResearchBrief;
  plan: ResearchPlan;
  papers: CanonicalPaper[];
  literatureContext?: LiteratureContext;
};

export type ResearchAgendaRequest = {
  projectRoot: string;
  brief: ResearchBrief;
  plan: ResearchPlan;
  papers: CanonicalPaper[];
  synthesis: ResearchSynthesis;
  verification: VerificationReport;
  memoryContext: ProjectMemoryContext;
  literatureContext?: LiteratureContext;
};

export interface ResearchBackend {
  readonly label: string;
  planResearch(request: ResearchPlanningRequest): Promise<ResearchPlan>;
  synthesizeResearch(request: ResearchSynthesisRequest): Promise<ResearchSynthesis>;
  developResearchAgenda(request: ResearchAgendaRequest): Promise<ResearchAgenda>;
}

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
};

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, "");
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function hashString(text: string): string {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampScore(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(5, Math.round(value)));
}

function safeStringArray(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => safeString(entry))
    .filter((entry): entry is string => entry !== null)
    .slice(0, limit);
}

function safeSourceIdArray(value: unknown): string[] {
  return safeStringArray(value, 6);
}

function uniqueSourceIds(sourceIds: string[]): string[] {
  return [...new Set(sourceIds)];
}

function uniqueClaimIds(claimIds: string[]): string[] {
  return [...new Set(claimIds)];
}

function safeResearchMode(value: unknown): ResearchMode | null {
  switch (value) {
    case "literature_synthesis":
    case "replication":
    case "benchmarking":
    case "ablation":
    case "method_improvement":
    case "new_hypothesis":
      return value;
    default:
      return null;
  }
}

function safeGapKind(value: unknown): ResearchGapKind | null {
  switch (value) {
    case "missing_baseline":
    case "confounder":
    case "coverage_gap":
    case "method_gap":
    case "evidence_conflict":
      return value;
    default:
      return null;
  }
}

function safeGapSeverity(value: unknown): ResearchGapSeverity | null {
  switch (value) {
    case "low":
    case "medium":
    case "high":
      return value;
    default:
      return null;
  }
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  if (Math.abs(left.length - right.length) > 1) {
    return false;
  }

  let i = 0;
  let j = 0;
  let edits = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }

    edits += 1;

    if (edits > 1) {
      return false;
    }

    if (left.length > right.length) {
      i += 1;
    } else if (right.length > left.length) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }

  if (i < left.length || j < right.length) {
    edits += 1;
  }

  return edits <= 1;
}

function reconcileSourceIds(sourceIds: string[], allowedSourceIds: string[]): string[] {
  const allowed = new Set(allowedSourceIds);

  return uniqueSourceIds(sourceIds.flatMap((sourceId) => {
    if (allowed.has(sourceId)) {
      return [sourceId];
    }

    const closeMatches = allowedSourceIds.filter((candidate) => editDistanceAtMostOne(sourceId, candidate));
    return closeMatches.length === 1 ? [closeMatches[0]!] : [];
  }));
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model did not return JSON.");
    }

    return JSON.parse(text.slice(start, end + 1));
  }
}

function normalizePlan(raw: unknown, brief: ResearchBrief): ResearchPlan {
  const record = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const fallbackTopic = brief.topic ?? "the requested project";
  const fallbackQuestion = brief.researchQuestion ?? `What is the most useful first-pass research framing for ${fallbackTopic}?`;

  return {
    researchMode: safeResearchMode(record.researchMode) ?? "literature_synthesis",
    objective: safeString(record.objective) ?? fallbackQuestion,
    rationale: safeString(record.rationale) ?? "Begin with a bounded literature-grounded pass before making stronger claims.",
    searchQueries: safeStringArray(record.searchQueries, 5).length > 0
      ? safeStringArray(record.searchQueries, 5)
      : [fallbackTopic, fallbackQuestion],
    localFocus: safeStringArray(record.localFocus, 5)
  };
}

function normalizeThemes(value: unknown, allowedSourceIds: string[] = []): ResearchTheme[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const title = safeString(record.title);
    const summary = safeString(record.summary);

    if (title === null || summary === null) {
      return [];
    }

    return [{
      title,
      summary,
      sourceIds: reconcileSourceIds(safeSourceIdArray(record.sourceIds), allowedSourceIds)
    }];
  }).slice(0, 6);
}

function normalizeClaims(value: unknown, allowedSourceIds: string[] = []): ResearchClaim[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const claim = safeString(record.claim);
    const evidence = safeString(record.evidence);

    if (claim === null || evidence === null) {
      return [];
    }

    return [{
      claim,
      evidence,
      sourceIds: reconcileSourceIds(safeSourceIdArray(record.sourceIds), allowedSourceIds)
    }];
  }).slice(0, 8);
}

function normalizeSynthesis(raw: unknown, brief: ResearchBrief, allowedSourceIds: string[] = []): ResearchSynthesis {
  const record = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};

  return {
    executiveSummary: safeString(record.executiveSummary)
      ?? `This first-pass run synthesized the available sources around ${brief.topic ?? "the requested topic"}.`,
    themes: normalizeThemes(record.themes, allowedSourceIds),
    claims: normalizeClaims(record.claims, allowedSourceIds),
    nextQuestions: safeStringArray(record.nextQuestions, 6)
  };
}

function claimRecordIdFromClaimText(text: string): string {
  return createMemoryRecordId("claim", text);
}

function claimIdsForSynthesis(synthesis: ResearchSynthesis): string[] {
  return synthesis.claims.map((claim) => claimRecordIdFromClaimText(claim.claim));
}

function normalizeDirectionScores(
  value: unknown,
  claimIds: string[],
  verification: VerificationReport
): DirectionScores {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  const relatedClaims = verification.verifiedClaims.filter((claim) => claimIds.includes(claim.claimId));
  const evidenceSignals = relatedClaims.filter((claim) => claim.supportStatus === "supported").length;
  const conflictingSignals = relatedClaims.filter((claim) => claim.supportStatus !== "supported").length;
  let evidenceBase = clampScore(record.evidenceBase, relatedClaims.length > 0 ? 3 : 2);

  if (evidenceSignals >= 2) {
    evidenceBase = Math.max(evidenceBase, 4);
  } else if (evidenceSignals === 1) {
    evidenceBase = Math.max(evidenceBase, 3);
  } else {
    evidenceBase = Math.min(evidenceBase, 2);
  }

  const tractability = clampScore(record.tractability, 3);
  const expectedCost = clampScore(record.expectedCost, 3);
  const risk = clampScore(record.risk, 3);
  let novelty = clampScore(record.novelty, evidenceBase >= 3 ? 3 : 2);

  if (evidenceBase <= 2) {
    novelty = Math.min(novelty, 3);
  }

  let overall = Math.round((evidenceBase + novelty + tractability + (6 - expectedCost) + (6 - risk)) / 5);

  if (conflictingSignals > 0) {
    overall -= 1;
  }

  overall = Math.max(1, Math.min(5, overall));

  return {
    evidenceBase,
    novelty,
    tractability,
    expectedCost,
    risk,
    overall
  };
}

function normalizeGaps(
  value: unknown,
  allowedSourceIds: string[],
  allowedClaimIds: string[]
): ResearchGap[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const title = safeString(record.title);
    const summary = safeString(record.summary);

    if (title === null || summary === null) {
      return [];
    }

    return [{
      id: safeString(record.id) ?? `gap-${hashString(`${title}:${summary}`)}`,
      title,
      summary,
      sourceIds: reconcileSourceIds(safeSourceIdArray(record.sourceIds), allowedSourceIds),
      claimIds: uniqueClaimIds(safeStringArray(record.claimIds, 8).filter((claimId) => allowedClaimIds.includes(claimId))),
      severity: safeGapSeverity(record.severity) ?? "medium",
      gapKind: safeGapKind(record.gapKind) ?? "coverage_gap"
    }];
  }).slice(0, 6);
}

function normalizeCandidateDirections(
  value: unknown,
  allowedSourceIds: string[],
  allowedClaimIds: string[],
  allowedGapIds: string[],
  verification: VerificationReport
): ResearchDirectionCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const title = safeString(record.title);
    const summary = safeString(record.summary);
    const whyNow = safeString(record.whyNow);

    if (title === null || summary === null || whyNow === null) {
      return [];
    }

    const claimIds = uniqueClaimIds(
      safeStringArray(record.claimIds, 8).filter((claimId) => allowedClaimIds.includes(claimId))
    );

    return [{
      id: safeString(record.id) ?? `direction-${hashString(`${title}:${summary}`)}`,
      title,
      summary,
      mode: safeResearchMode(record.mode) ?? "literature_synthesis",
      whyNow,
      sourceIds: reconcileSourceIds(safeSourceIdArray(record.sourceIds), allowedSourceIds),
      claimIds,
      gapIds: uniqueClaimIds(
        safeStringArray(record.gapIds, 8).filter((gapId) => allowedGapIds.includes(gapId))
      ),
      scores: normalizeDirectionScores(record.scores, claimIds, verification)
    }];
  }).slice(0, 5);
}

function normalizeWorkPackage(
  value: unknown,
  candidateDirections: ResearchDirectionCandidate[],
  brief: ResearchBrief
): WorkPackage | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const title = safeString(record.title);
  const objective = safeString(record.objective);
  const hypothesisOrQuestion = safeString(record.hypothesisOrQuestion);
  const methodSketch = safeString(record.methodSketch);
  const decisiveExperiment = safeString(record.decisiveExperiment);
  const stopCriterion = safeString(record.stopCriterion);
  const expectedArtifact = safeString(record.expectedArtifact);

  if (
    title === null
    || objective === null
    || hypothesisOrQuestion === null
    || methodSketch === null
    || decisiveExperiment === null
    || stopCriterion === null
    || expectedArtifact === null
  ) {
    return null;
  }

  const directionId = safeString(record.directionId);
  const selectedDirection = directionId === null
    ? null
    : candidateDirections.find((direction) => direction.id === directionId) ?? null;

  return {
    id: safeString(record.id) ?? `work-package-${hashString(`${title}:${objective}`)}`,
    title,
    mode: safeResearchMode(record.mode) ?? selectedDirection?.mode ?? "literature_synthesis",
    objective,
    hypothesisOrQuestion,
    methodSketch,
    baselines: safeStringArray(record.baselines, 6),
    controls: safeStringArray(record.controls, 6),
    decisiveExperiment,
    stopCriterion,
    expectedArtifact,
    requiredInputs: safeStringArray(record.requiredInputs, 8),
    blockedBy: safeStringArray(record.blockedBy, 8)
  };
}

function normalizeAgenda(raw: unknown, request: ResearchAgendaRequest): ResearchAgenda {
  const record = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const allowedSourceIds = request.papers.map((paper) => paper.id);
  const allowedClaimIds = claimIdsForSynthesis(request.synthesis);
  const gaps = normalizeGaps(record.gaps, allowedSourceIds, allowedClaimIds);
  const candidateDirections = normalizeCandidateDirections(
    record.candidateDirections,
    allowedSourceIds,
    allowedClaimIds,
    gaps.map((gap) => gap.id),
    request.verification
  );
  let selectedDirectionId = safeString(record.selectedDirectionId);

  if (selectedDirectionId !== null && !candidateDirections.some((direction) => direction.id === selectedDirectionId)) {
    selectedDirectionId = null;
  }

  const selectedWorkPackage = normalizeWorkPackage(record.selectedWorkPackage, candidateDirections, request.brief);
  const effectiveSelectedDirectionId = selectedDirectionId
    ?? (selectedWorkPackage === null
      ? null
      : candidateDirections.find((direction) => direction.mode === selectedWorkPackage.mode)?.id ?? candidateDirections[0]?.id ?? null);
  const holdReasons = safeStringArray(record.holdReasons, 6);
  const verifiedSignals = request.verification.verifiedClaims.filter((claim) => claim.supportStatus === "supported").length;
  const evidenceThin = request.papers.length < 3 || verifiedSignals === 0;
  const missingSelection = effectiveSelectedDirectionId === null || selectedWorkPackage === null;

  return {
    executiveSummary: safeString(record.executiveSummary)
      ?? `The reviewed literature suggests ${candidateDirections.length > 0 ? `${candidateDirections.length} candidate research directions` : "further literature work before direction selection"}.`,
    gaps,
    candidateDirections,
    selectedDirectionId: evidenceThin || missingSelection ? null : effectiveSelectedDirectionId,
    selectedWorkPackage: evidenceThin || missingSelection ? null : selectedWorkPackage,
    holdReasons: evidenceThin || missingSelection
      ? holdReasons.length > 0
        ? holdReasons
        : ["The reviewed evidence is still too thin or inconclusive to justify an executable next work package."]
      : holdReasons,
    recommendedHumanDecision: safeString(record.recommendedHumanDecision)
      ?? (evidenceThin || missingSelection
        ? "Review the agenda, refine the brief or retrieval strategy, and run another literature pass before continuing."
        : "Inspect the selected work package, then confirm `/continue` if the scope and evidence base look acceptable.")
  };
}

function planningInstruction(request: ResearchPlanningRequest): string {
  const literatureContext = request.literatureContext ?? {
    available: false,
    paperCount: 0,
    themeCount: 0,
    notebookCount: 0,
    papers: [],
    themes: [],
    notebooks: [],
    queryHints: []
  };

  return [
    "You are ClawResearch's planning module for a console-first autonomous research runtime.",
    "Plan a bounded first-pass research mode using the brief and local project context.",
    "Use the project memory when it is relevant so the next pass builds on prior findings, open questions, useful ideas, and existing artifacts instead of starting from scratch.",
    "Ground the plan in the following design principles:",
    "- choose a research mode explicitly",
    "- prefer bounded literature-grounded work over overclaiming",
    "- keep the objective specific and debuggable",
    "- produce search queries that are likely to retrieve useful sources",
    "- use the project directory context when relevant",
    "",
    "Allowed researchMode values:",
    "- literature_synthesis",
    "- replication",
    "- benchmarking",
    "- ablation",
    "- method_improvement",
    "- new_hypothesis",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "researchMode": "string",',
    '  "objective": "string",',
    '  "rationale": "string",',
    '  "searchQueries": ["string"],',
    '  "localFocus": ["string"]',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Local files: ${JSON.stringify(request.localFiles.slice(0, 20))}`,
    `Project memory context: ${JSON.stringify(request.memoryContext)}`,
    `Literature memory context: ${JSON.stringify(literatureContext)}`
  ].join("\n");
}

function synthesisInstruction(request: ResearchSynthesisRequest): string {
  const literatureContext = request.literatureContext ?? {
    available: false,
    paperCount: 0,
    themeCount: 0,
    notebookCount: 0,
    papers: [],
    themes: [],
    notebooks: [],
    queryHints: []
  };
  const condensedPapers = request.papers.map((paper) => ({
    id: paper.id,
    title: paper.title,
    citation: paper.citation,
    year: paper.year,
    authors: paper.authors,
    venue: paper.venue,
    abstract: paper.abstract,
    bestAccessUrl: paper.bestAccessUrl,
    bestAccessProvider: paper.bestAccessProvider,
    accessMode: paper.accessMode,
    fulltextFormat: paper.fulltextFormat,
    screeningStage: paper.screeningStage,
    screeningDecision: paper.screeningDecision,
    screeningRationale: paper.screeningRationale,
    tags: paper.tags,
    identifiers: paper.identifiers
  }));

  if (shouldUseLiteratureReviewSubsystem(request.plan, request.brief)) {
    return buildLiteratureSynthesisInstruction({
      projectRoot: request.projectRoot,
      brief: request.brief,
      plan: request.plan,
      sources: condensedPapers.map((paper) => ({
        id: paper.id,
        kind: "canonical_paper",
        title: paper.title,
        locator: paper.bestAccessUrl,
        citation: paper.citation,
        excerpt: paper.abstract ?? `${paper.accessMode} via ${paper.bestAccessProvider ?? "unknown"}`,
        screeningDecision: paper.screeningDecision,
        screeningRationale: paper.screeningRationale,
        tags: paper.tags
      })),
      literatureContext
    });
  }

  return [
    "You are ClawResearch's synthesis module for a console-first autonomous research runtime.",
    "Work only from the provided sources. Do not invent papers, evidence, or claims.",
    "Produce a bounded first-pass synthesis that remains honest about uncertainty.",
    "Every claim must be explicitly grounded in the cited sourceIds.",
    "Prefer claims about patterns, limitations, methods, and open questions over grand conclusions.",
    "Next questions should be concrete follow-up research questions, not generic brainstorming.",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "executiveSummary": "string",',
    '  "themes": [',
    '    { "title": "string", "summary": "string", "sourceIds": ["string"] }',
    "  ],",
    '  "claims": [',
    '    { "claim": "string", "evidence": "string", "sourceIds": ["string"] }',
    "  ],",
    '  "nextQuestions": ["string"]',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Plan: ${JSON.stringify(request.plan)}`,
    `Canonical papers: ${JSON.stringify(condensedPapers)}`,
    `Literature memory context: ${JSON.stringify(literatureContext)}`
  ].join("\n");
}

function agendaInstruction(request: ResearchAgendaRequest): string {
  const literatureContext = request.literatureContext ?? {
    available: false,
    paperCount: 0,
    themeCount: 0,
    notebookCount: 0,
    papers: [],
    themes: [],
    notebooks: [],
    queryHints: []
  };
  const reviewedPapers = request.papers.map((paper) => ({
    id: paper.id,
    title: paper.title,
    citation: paper.citation,
    year: paper.year,
    venue: paper.venue,
    abstract: paper.abstract,
    accessMode: paper.accessMode,
    screeningDecision: paper.screeningDecision,
    tags: paper.tags
  }));
  const claims = request.synthesis.claims.map((claim) => ({
    id: claimRecordIdFromClaimText(claim.claim),
    claim: claim.claim,
    evidence: claim.evidence,
    sourceIds: claim.sourceIds
  }));

  return [
    "You are ClawResearch's research-agenda module for a console-first autonomous research runtime.",
    "Convert the reviewed literature, verified claims, open questions, and project memory into a bounded research agenda.",
    "This is proposal ranking, not scientific proof. Do not treat polished text as evidence.",
    "Use only the reviewed papers and verified-claim context provided here.",
    "Prefer 2 to 5 concrete candidate directions.",
    "If the evidence base is weak, conflicting, or too theory-heavy for a bounded next step, leave selectedDirectionId null, selectedWorkPackage null, and explain holdReasons honestly.",
    "Do not generate manuscript-writing tasks.",
    "",
    "Scoring guidance:",
    "- strong evidence and replicated signals increase evidenceBase",
    "- conflicting or weakly supported evidence lowers overall",
    "- thin evidence cannot justify maximum novelty",
    "- high-cost or unclear-evaluation directions should be penalized",
    "",
    "Allowed mode values:",
    "- literature_synthesis",
    "- replication",
    "- benchmarking",
    "- ablation",
    "- method_improvement",
    "- new_hypothesis",
    "",
    "Allowed gapKind values:",
    "- missing_baseline",
    "- confounder",
    "- coverage_gap",
    "- method_gap",
    "- evidence_conflict",
    "",
    "Allowed severity values:",
    "- low",
    "- medium",
    "- high",
    "",
    "Score every dimension from 1 to 5.",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "executiveSummary": "string",',
    '  "gaps": [',
    '    {',
    '      "id": "string",',
    '      "title": "string",',
    '      "summary": "string",',
    '      "sourceIds": ["string"],',
    '      "claimIds": ["string"],',
    '      "severity": "low|medium|high",',
    '      "gapKind": "missing_baseline|confounder|coverage_gap|method_gap|evidence_conflict"',
    "    }",
    "  ],",
    '  "candidateDirections": [',
    '    {',
    '      "id": "string",',
    '      "title": "string",',
    '      "summary": "string",',
    '      "mode": "literature_synthesis|replication|benchmarking|ablation|method_improvement|new_hypothesis",',
    '      "whyNow": "string",',
    '      "sourceIds": ["string"],',
    '      "claimIds": ["string"],',
    '      "gapIds": ["string"],',
    '      "scores": {',
    '        "evidenceBase": 1,',
    '        "novelty": 1,',
    '        "tractability": 1,',
    '        "expectedCost": 1,',
    '        "risk": 1,',
    '        "overall": 1',
    "      }",
    "    }",
    "  ],",
    '  "selectedDirectionId": "string or null",',
    '  "selectedWorkPackage": {',
    '    "id": "string",',
    '    "directionId": "string",',
    '    "title": "string",',
    '    "mode": "literature_synthesis|replication|benchmarking|ablation|method_improvement|new_hypothesis",',
    '    "objective": "string",',
    '    "hypothesisOrQuestion": "string",',
    '    "methodSketch": "string",',
    '    "baselines": ["string"],',
    '    "controls": ["string"],',
    '    "decisiveExperiment": "string",',
    '    "stopCriterion": "string",',
    '    "expectedArtifact": "string",',
    '    "requiredInputs": ["string"],',
    '    "blockedBy": ["string"]',
    '  } or null,',
    '  "holdReasons": ["string"],',
    '  "recommendedHumanDecision": "string"',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Plan: ${JSON.stringify(request.plan)}`,
    `Reviewed papers: ${JSON.stringify(reviewedPapers)}`,
    `Synthesis themes: ${JSON.stringify(request.synthesis.themes)}`,
    `Claims: ${JSON.stringify(claims)}`,
    `Next questions: ${JSON.stringify(request.synthesis.nextQuestions)}`,
    `Verification: ${JSON.stringify(request.verification)}`,
    `Project memory context: ${JSON.stringify(request.memoryContext)}`,
    `Literature memory context: ${JSON.stringify(literatureContext)}`
  ].join("\n");
}

async function ollamaJsonCall<T>(
  host: string,
  model: string,
  systemPrompt: string
): Promise<T> {
  const response = await fetch(`http://${normalizeHost(host)}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: systemPrompt
        }
      ]
    }),
    signal: AbortSignal.timeout(120_000)
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as OllamaChatResponse;
  const content = payload.message?.content;

  if (typeof content !== "string") {
    throw new Error("Ollama returned an unexpected response.");
  }

  return extractJson(content) as T;
}

export class OllamaResearchBackend implements ResearchBackend {
  readonly label: string;

  constructor(
    private readonly host = defaultHost,
    private readonly model = defaultModel
  ) {
    this.label = `ollama:${this.model}`;
  }

  async planResearch(request: ResearchPlanningRequest): Promise<ResearchPlan> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      planningInstruction(request)
    );

    return normalizePlan(raw, request.brief);
  }

  async synthesizeResearch(request: ResearchSynthesisRequest): Promise<ResearchSynthesis> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      synthesisInstruction(request)
    );

    return normalizeSynthesis(raw, request.brief, request.papers.map((paper) => paper.id));
  }

  async developResearchAgenda(request: ResearchAgendaRequest): Promise<ResearchAgenda> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      agendaInstruction(request)
    );

    return normalizeAgenda(raw, request);
  }
}

export function createDefaultResearchBackend(): ResearchBackend {
  return new OllamaResearchBackend();
}
