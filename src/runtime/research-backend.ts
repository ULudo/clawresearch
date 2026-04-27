import type { ResearchBrief } from "./session-store.js";
import {
  createMemoryRecordId,
  type ProjectMemoryContext
} from "./memory-store.js";
import type {
  CanonicalPaper,
  LiteratureContext
} from "./literature-store.js";
import {
  evidenceMatrixNextQuestions,
  type EvidenceMatrix,
  type PaperClaimSupportStrength,
  type PaperExtraction,
  type PaperExtractionConfidence
} from "./research-evidence.js";
import {
  normalizeCriticReview,
  type CriticReviewArtifact,
  type CriticReviewRequest,
  type CriticReviewStage
} from "./research-critic.js";
import type { VerificationReport } from "./verifier.js";
import {
  buildLiteratureSynthesisInstruction,
  shouldUseLiteratureReviewSubsystem,
  type ReviewSelectionQuality
} from "./literature-review.js";
import {
  normalizeResearchActionDecision,
  type ResearchAgentControlMode,
  type ResearchActionDecision,
  type ResearchActionRequest
} from "./research-agent.js";

export type {
  EvidenceMatrix,
  EvidenceMatrixInsight,
  EvidenceMatrixInsightKind,
  EvidenceMatrixRow,
  PaperClaimSupportStrength,
  PaperExtraction,
  PaperExtractionConfidence
} from "./research-evidence.js";

const defaultHost = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const defaultModel = process.env.CLAWRESEARCH_OLLAMA_MODEL ?? "qwen3:14b";
const defaultCriticHost = process.env.CLAWRESEARCH_OLLAMA_CRITIC_HOST ?? defaultHost;
const defaultCriticModel = process.env.CLAWRESEARCH_OLLAMA_CRITIC_MODEL ?? defaultModel;

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
  paperExtractions: PaperExtraction[];
  evidenceMatrix: EvidenceMatrix;
  selectionQuality?: ReviewSelectionQuality | null;
  literatureContext?: LiteratureContext;
};

export type ResearchAgendaRequest = {
  projectRoot: string;
  brief: ResearchBrief;
  plan: ResearchPlan;
  papers: CanonicalPaper[];
  paperExtractions: PaperExtraction[];
  evidenceMatrix: EvidenceMatrix;
  synthesis: ResearchSynthesis;
  verification: VerificationReport;
  selectionQuality?: ReviewSelectionQuality | null;
  memoryContext: ProjectMemoryContext;
  literatureContext?: LiteratureContext;
};

export type PaperExtractionRequest = {
  projectRoot: string;
  runId: string;
  brief: ResearchBrief;
  plan: ResearchPlan;
  papers: CanonicalPaper[];
  literatureContext?: LiteratureContext;
  compact?: boolean;
};

export type ResearchBackendOperation =
  | "planning"
  | "agent_step"
  | "extraction"
  | "synthesis"
  | "agenda"
  | "critic";

export type ResearchBackendCallOptions = {
  operation: ResearchBackendOperation;
  timeoutMs: number;
  agentControlMode?: ResearchAgentControlMode;
};

export type ResearchBackendCapabilities = {
  actionControl: {
    nativeToolCalls: boolean;
    strictJsonFallback: boolean;
  };
};

export type ResearchBackendFailureKind =
  | "timeout"
  | "malformed_json"
  | "http"
  | "unexpected";

export class ResearchBackendError extends Error {
  constructor(
    public readonly kind: ResearchBackendFailureKind,
    public readonly operation: ResearchBackendOperation,
    message: string,
    public readonly timeoutMs: number | null = null
  ) {
    super(message);
    this.name = "ResearchBackendError";
  }
}

export interface ResearchBackend {
  readonly label: string;
  readonly capabilities?: ResearchBackendCapabilities;
  planResearch(request: ResearchPlanningRequest, options?: ResearchBackendCallOptions): Promise<ResearchPlan>;
  chooseResearchAction(request: ResearchActionRequest, options?: ResearchBackendCallOptions): Promise<ResearchActionDecision>;
  extractReviewedPapers(request: PaperExtractionRequest, options?: ResearchBackendCallOptions): Promise<PaperExtraction[]>;
  synthesizeResearch(request: ResearchSynthesisRequest, options?: ResearchBackendCallOptions): Promise<ResearchSynthesis>;
  developResearchAgenda(request: ResearchAgendaRequest, options?: ResearchBackendCallOptions): Promise<ResearchAgenda>;
  reviewResearchArtifact(request: CriticReviewRequest, options?: ResearchBackendCallOptions): Promise<CriticReviewArtifact>;
}

type OllamaToolCall = {
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type OllamaChatResponse = {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
};

type OllamaStreamChunk = {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
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

function safePaperClaimSupportStrength(value: unknown): PaperClaimSupportStrength | null {
  switch (value) {
    case "explicit":
    case "partial":
    case "implied":
      return value;
    default:
      return null;
  }
}

function safePaperExtractionConfidence(value: unknown): PaperExtractionConfidence | null {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return null;
  }
}

function parseOllamaContent(rawResponseText: string): string | null {
  try {
    const payload = JSON.parse(rawResponseText) as OllamaChatResponse;
    return typeof payload.message?.content === "string" ? payload.message.content : null;
  } catch {
    // Fall through to Ollama's streaming NDJSON shape.
  }

  let content = "";

  for (const line of rawResponseText.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    try {
      const payload = JSON.parse(trimmed) as OllamaStreamChunk;
      if (typeof payload.message?.content === "string") {
        content += payload.message.content;
      }
    } catch {
      // Ignore incomplete/diagnostic stream lines; malformed final JSON is
      // handled by extractJson after all model content is assembled.
    }
  }

  return content.length > 0 ? content : null;
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

function normalizeExtractionClaims(value: unknown): PaperExtraction["supportedClaims"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const claim = safeString(record.claim);

    if (claim === null) {
      return [];
    }

    return [{
      claim,
      support: safePaperClaimSupportStrength(record.support) ?? "implied"
    }];
  }).slice(0, 8);
}

function normalizePaperExtractions(raw: unknown, request: PaperExtractionRequest): PaperExtraction[] {
  const record = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const rawExtractions = Array.isArray(record.extractions)
    ? record.extractions
    : Array.isArray(raw)
      ? raw
      : [];
  const papersById = new Map(request.papers.map((paper) => [paper.id, paper]));

  return rawExtractions.flatMap((entry, index) => {
    const extraction = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const paperId = safeString(extraction.paperId);

    if (paperId === null || !papersById.has(paperId)) {
      return [];
    }

    return [{
      id: safeString(extraction.id) ?? `extraction-${hashString(`${request.runId}:${paperId}:${index}`)}`,
      paperId,
      runId: request.runId,
      problemSetting: safeString(extraction.problemSetting) ?? "",
      systemType: safeString(extraction.systemType) ?? "",
      architecture: safeString(extraction.architecture) ?? "",
      toolsAndMemory: safeString(extraction.toolsAndMemory) ?? "",
      planningStyle: safeString(extraction.planningStyle) ?? "",
      evaluationSetup: safeString(extraction.evaluationSetup) ?? "",
      successSignals: safeStringArray(extraction.successSignals, 8),
      failureModes: safeStringArray(extraction.failureModes, 8),
      limitations: safeStringArray(extraction.limitations, 8),
      supportedClaims: normalizeExtractionClaims(extraction.supportedClaims),
      confidence: safePaperExtractionConfidence(extraction.confidence) ?? "low",
      evidenceNotes: safeStringArray(extraction.evidenceNotes, 8)
    }];
  });
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

function fallbackThemesFromEvidence(
  request: ResearchSynthesisRequest,
  allowedSourceIds: string[]
): ResearchTheme[] {
  const insightThemes = request.evidenceMatrix.derivedInsights.flatMap((insight) => {
    const sourceIds = reconcileSourceIds(insight.paperIds, allowedSourceIds);

    if (sourceIds.length === 0) {
      return [];
    }

    return [{
      title: insight.title,
      summary: insight.summary,
      sourceIds
    }];
  });

  if (insightThemes.length > 0) {
    return insightThemes.slice(0, 6);
  }

  const rowsWithClaims = request.evidenceMatrix.rows
    .filter((row) => row.claimCount > 0)
    .slice(0, 6);

  if (rowsWithClaims.length === 0) {
    return [];
  }

  return [{
    title: "Reviewed system evidence",
    summary: `The reviewed set contains ${rowsWithClaims.length} papers with extractable paper-level claims, but the synthesis backend did not return stable cross-paper themes.`,
    sourceIds: reconcileSourceIds(rowsWithClaims.map((row) => row.paperId), allowedSourceIds)
  }];
}

function fallbackClaimsFromPaperExtractions(
  request: ResearchSynthesisRequest,
  allowedSourceIds: string[]
): ResearchClaim[] {
  return request.paperExtractions.flatMap((extraction) => {
    if (extraction.confidence === "low" || !allowedSourceIds.includes(extraction.paperId)) {
      return [];
    }

    return extraction.supportedClaims
      .filter((claim) => claim.support === "explicit" || claim.support === "partial")
      .map((claim) => ({
        claim: claim.claim,
        evidence: extraction.evidenceNotes[0]
          ?? `Extracted from reviewed paper ${extraction.paperId} in the ${extraction.problemSetting} setting.`,
        sourceIds: [extraction.paperId]
      }));
  }).slice(0, 8);
}

function normalizeSynthesis(raw: unknown, request: ResearchSynthesisRequest, allowedSourceIds: string[] = []): ResearchSynthesis {
  const record = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const nextQuestions = safeStringArray(record.nextQuestions, 6);
  const matrixBackedQuestions = evidenceMatrixNextQuestions(request.evidenceMatrix);
  const themes = normalizeThemes(record.themes, allowedSourceIds);
  const claims = normalizeClaims(record.claims, allowedSourceIds);

  return {
    executiveSummary: safeString(record.executiveSummary)
      ?? `This first-pass run synthesized the available sources around ${request.brief.topic ?? "the requested topic"}.`,
    themes: themes.length > 0 ? themes : fallbackThemesFromEvidence(request, allowedSourceIds),
    claims: claims.length > 0 ? claims : fallbackClaimsFromPaperExtractions(request, allowedSourceIds),
    nextQuestions: nextQuestions.length > 0 ? nextQuestions : matrixBackedQuestions
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
  const evidenceThin = request.evidenceMatrix.rowCount < 3 || verifiedSignals === 0;
  const missingSelection = effectiveSelectedDirectionId === null || selectedWorkPackage === null;
  const matrixHolds = request.evidenceMatrix.derivedInsights
    .filter((insight) => insight.kind === "gap" || insight.kind === "conflict")
    .map((insight) => insight.summary)
    .slice(0, 2);

  return {
    executiveSummary: safeString(record.executiveSummary)
      ?? `The reviewed literature suggests ${candidateDirections.length > 0 ? `${candidateDirections.length} candidate research directions` : "further literature work before direction selection"}.`,
    gaps,
    candidateDirections,
    selectedDirectionId: evidenceThin || missingSelection ? null : effectiveSelectedDirectionId,
    selectedWorkPackage: evidenceThin || missingSelection ? null : selectedWorkPackage,
    holdReasons: evidenceThin || missingSelection
      ? holdReasons.length > 0
        ? [...holdReasons, ...matrixHolds].slice(0, 6)
        : matrixHolds.length > 0
          ? matrixHolds
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

function agentStepInstruction(request: ResearchActionRequest): string {
  const criticSummaries = request.criticReports.map((report) => ({
    stage: report.stage,
    readiness: report.readiness,
    confidence: report.confidence,
    objections: report.objections.map((objection) => ({
      code: objection.code,
      severity: objection.severity,
      target: objection.target,
      message: objection.message,
      suggestedRevision: objection.suggestedRevision
    })),
    revisionAdvice: report.revisionAdvice
  }));

  return [
    "You are ClawResearch's research-agent controller.",
    "Choose exactly one next action from the allowed action list.",
    "Do not invent tool names. Do not execute the action yourself. The runtime will validate and execute the chosen action.",
    "If evidence is not ready and useful revision budget remains, choose revise_search_strategy with concrete searchQueries.",
    "If the selected evidence is ready for synthesis, choose synthesize_clustered.",
    "If the model cannot justify another useful step or action control is unsafe, choose finalize_status_report.",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "action": "one allowed action",',
    '  "rationale": "why this is the best next action",',
    '  "confidence": 0.0,',
    '  "inputs": {',
    '    "searchQueries": ["only if revising/searching"],',
    '    "evidenceTargets": ["missing evidence targets"],',
    '    "paperIds": ["known paper ids only"],',
    '    "criticStage": "protocol|source_selection|evidence|release|null",',
    '    "reason": "short status reason or null"',
    "  },",
    '  "expectedOutcome": "checkpoint/result expected from the action",',
    '  "stopCondition": "when the runtime should stop this action"',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Run id: ${request.runId}`,
    `Phase: ${request.phase}`,
    `Attempt: ${request.attempt}/${request.maxAttempts}`,
    `Allowed actions: ${request.allowedActions.join(", ")}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Plan: ${JSON.stringify(request.plan)}`,
    `Observations: ${JSON.stringify(request.observations)}`,
    `Critic reports: ${JSON.stringify(criticSummaries)}`,
    request.retryInstruction === undefined ? "Retry instruction: null" : `Retry instruction: ${request.retryInstruction}`
  ].join("\n");
}

function extractionInstruction(request: PaperExtractionRequest): string {
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
    paperId: paper.id,
    title: paper.title,
    citation: paper.citation,
    abstract: request.compact === true ? paper.abstract?.slice(0, 1_200) ?? null : paper.abstract,
    year: paper.year,
    venue: paper.venue,
    authors: request.compact === true ? paper.authors.slice(0, 8) : paper.authors,
    accessMode: paper.accessMode,
    screeningStage: paper.screeningStage,
    screeningDecision: paper.screeningDecision,
    screeningRationale: paper.screeningRationale,
    tags: request.compact === true ? paper.tags.slice(0, 8) : paper.tags
  }));

  return [
    "You are ClawResearch's paper-extraction module for a console-first autonomous research runtime.",
    "Extract paper-by-paper evidence only from the provided reviewed papers.",
    request.compact === true
      ? "Use compact mode: prefer short, conservative fields and return one sparse but valid extraction per paper."
      : "Use normal mode: retain useful methodological and evidence detail while staying concise.",
    "Do not fabricate detail. If a field is unclear, leave it as an empty string or empty array and lower confidence.",
    "Supported claims must be short claim texts grounded in the paper itself.",
    "",
    "Allowed confidence values:",
    "- high",
    "- medium",
    "- low",
    "",
    "Allowed supportedClaims support values:",
    "- explicit",
    "- partial",
    "- implied",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "extractions": [',
    "    {",
    '      "id": "string",',
    '      "paperId": "string",',
    '      "problemSetting": "string",',
    '      "systemType": "string",',
    '      "architecture": "string",',
    '      "toolsAndMemory": "string",',
    '      "planningStyle": "string",',
    '      "evaluationSetup": "string",',
    '      "successSignals": ["string"],',
    '      "failureModes": ["string"],',
    '      "limitations": ["string"],',
    '      "supportedClaims": [',
    '        { "claim": "string", "support": "explicit|partial|implied" }',
    "      ],",
    '      "confidence": "high|medium|low",',
    '      "evidenceNotes": ["string"]',
    "    }",
    "  ]",
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Run id: ${request.runId}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Plan: ${JSON.stringify(request.plan)}`,
    `Reviewed papers: ${JSON.stringify(reviewedPapers)}`,
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
    return [
      buildLiteratureSynthesisInstruction({
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
        literatureContext,
        selectionQuality: request.selectionQuality ?? null
      }),
      "",
      "Evidence-backed extraction layer:",
      `Paper extractions: ${JSON.stringify(request.paperExtractions)}`,
      `Evidence matrix: ${JSON.stringify(request.evidenceMatrix)}`,
      "Ground themes, claims, and open questions in the evidence matrix derivedInsights and the extraction records, not only the raw paper list."
    ].join("\n");
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
    `Review selection quality: ${JSON.stringify(request.selectionQuality ?? null)}`,
    `Paper extractions: ${JSON.stringify(request.paperExtractions)}`,
    `Evidence matrix: ${JSON.stringify(request.evidenceMatrix)}`,
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
    "Use review selection quality as a boundary condition: do not select a work package whose core objective depends on missing required facets.",
    "If selection adequacy is thin or required facets are missing, either choose a literature-retrieval/refinement package or leave the agenda on hold with explicit missing-facet reasons.",
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
    `Review selection quality: ${JSON.stringify(request.selectionQuality ?? null)}`,
    `Paper extractions: ${JSON.stringify(request.paperExtractions)}`,
    `Evidence matrix: ${JSON.stringify(request.evidenceMatrix)}`,
    `Synthesis themes: ${JSON.stringify(request.synthesis.themes)}`,
    `Claims: ${JSON.stringify(claims)}`,
    `Next questions: ${JSON.stringify(request.synthesis.nextQuestions)}`,
    `Verification: ${JSON.stringify(request.verification)}`,
    `Project memory context: ${JSON.stringify(request.memoryContext)}`,
    `Literature memory context: ${JSON.stringify(literatureContext)}`
  ].join("\n");
}

function criticInstruction(request: CriticReviewRequest): string {
  const selectedPapers = (request.selectedPapers ?? []).map((paper) => ({
    id: paper.id,
    title: paper.title,
    citation: paper.citation,
    year: paper.year,
    venue: paper.venue,
    abstract: paper.abstract,
    accessMode: paper.accessMode,
    screeningDecision: paper.screeningDecision,
    screeningRationale: paper.screeningRationale
  }));
  const claimIds = [
    ...(request.paper?.claims.map((claim) => claim.claimId) ?? []),
    ...(request.verification?.verifiedClaims.map((claim) => claim.claimId) ?? [])
  ];
  const stageGuidance = criticStageGuidance(request.stage);
  const packetLines = criticPacketLines(request, selectedPapers, claimIds);

  return [
    "You are ClawResearch's stateless critic reviewer.",
    "You are newly instantiated for this single review. You have no memory, no tools, and no access to retrieval.",
    "Your job is to falsify readiness, not to continue the research and not to rewrite the artifact.",
    "Use only the evidence packet below. Do not invent papers, claims, citations, methods, or prior context.",
    "Give concrete objections tied only to artifacts that are present and expected at this review stage.",
    stageGuidance.releaseRule,
    "",
    "Stage-specific contract:",
    ...stageGuidance.rules.map((rule) => `- ${rule}`),
    "",
    "Readiness rules:",
    "- pass: no blocking or major evidence-readiness concern remains",
    "- revise: the worker should revise strategy before release",
    "- block: the artifact is unsafe to use as the basis for release",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "readiness": "pass|revise|block",',
    '  "confidence": 0.0,',
    '  "objections": [',
    '    {',
    '      "code": "string",',
    '      "severity": "blocking|major|minor",',
    '      "target": "protocol|source_selection|extraction|evidence|synthesis|verification|manuscript|release",',
    '      "message": "specific objection grounded in the provided packet",',
    '      "affectedPaperIds": ["known selected paper id only"],',
    '      "affectedClaimIds": ["known claim id only"],',
    '      "suggestedRevision": "concrete revision advice or null"',
    "    }",
    "  ],",
    '  "revisionAdvice": {',
    '    "searchQueries": ["concrete query suggestions"],',
    '    "evidenceTargets": ["missing evidence targets"],',
    '    "papersToExclude": ["known selected paper id only"],',
    '    "claimsToSoften": ["known claim id only"]',
    "  }",
    "}",
    "",
    `Review stage: ${request.stage}`,
    `Run id: ${request.runId}`,
    `Critic iteration: ${JSON.stringify(request.iteration ?? null)}`,
    request.retryInstruction === undefined || request.retryInstruction === null
      ? "Retry instruction: null"
      : `Retry instruction: ${request.retryInstruction}`,
    ...packetLines
  ].join("\n");
}

function criticStageGuidance(stage: CriticReviewStage): { releaseRule: string; rules: string[] } {
  switch (stage) {
    case "protocol":
      return {
        releaseRule: "This gate decides whether the protocol is ready for autonomous retrieval, not whether the final manuscript is ready.",
        rules: [
          "Review only the brief, plan, and review protocol.",
          "No papers, selected sources, extractions, claims, synthesis, verification, or manuscript should exist yet.",
          "Missing selected papers is expected and must not be an objection at the protocol stage.",
          "Criticize unclear scope, bad inclusion/exclusion criteria, output-style constraints treated as evidence targets, unsafe search strategy, or contradictions that would make retrieval unreliable.",
          "Use revise when concrete query, scope, or evidence-target changes could make retrieval stronger; use block only when the protocol cannot safely guide retrieval."
        ]
      };
    case "source_selection":
      return {
        releaseRule: "This gate decides whether the selected sources are ready for extraction.",
        rules: [
          "Review the brief, protocol, selected papers, relevance assessments, retrieval diagnostics, and selection quality.",
          "Do not require extracted evidence, synthesized claims, references, or a manuscript yet.",
          "Object to off-topic selected papers, missing evidence targets, weak source fit, or selection/relevance contradictions.",
          "If readiness is revise or block, you must provide at least one concrete objection with a specific message and suggested revision.",
          "Revision advice may suggest search queries, evidence targets, or selected paper IDs to exclude, but must not introduce invented papers.",
          "Avoid picky or stylistic objections; after repeated iterations, reserve block for severe evidence-set risks that would make extraction unsafe."
        ]
      };
    case "evidence":
      return {
        releaseRule: "This gate decides whether extracted evidence is ready for synthesis.",
        rules: [
          "Review selected papers, relevance assessments, paper extractions, and the evidence matrix.",
          "Do not require final prose, references, or release checks yet.",
          "Object to missing extractions for selected papers, unsupported evidence rows, weak coverage, or extracted evidence that does not match the protocol.",
          "If readiness is revise or block, you must provide at least one concrete objection with a specific message and suggested revision.",
          "Avoid picky or stylistic objections; after repeated iterations, reserve block for severe evidence integrity risks."
        ]
      };
    case "release":
      return {
        releaseRule: "This gate decides whether a full manuscript may be released.",
        rules: [
          "Review the manuscript, references, verification, deterministic manuscript checks, protocol, and selected papers.",
          "Object to unsupported claims, missing citations, off-topic evidence, failed checks, missing limitations, or mismatches between the paper and evidence matrix.",
          "Do not ask for new research unless the provided manuscript cannot be safely released without it."
        ]
      };
  }
}

function criticPacketLines(
  request: CriticReviewRequest,
  selectedPapers: Array<{
    id: string;
    title: string;
    citation: string;
    year: number | null;
    venue: string | null;
    abstract: string | null;
    accessMode: string;
    screeningDecision: string;
    screeningRationale: string | null;
  }>,
  claimIds: string[]
): string[] {
  const common = [
    `Brief: ${JSON.stringify(request.brief)}`,
    `Protocol: ${JSON.stringify(request.protocol ?? null)}`,
    `Plan objective: ${request.plan?.objective ?? null}`
  ];

  switch (request.stage) {
    case "protocol":
      return common;
    case "source_selection":
      return [
        ...common,
        `Selected papers: ${JSON.stringify(selectedPapers)}`,
        `Known selected paper IDs: ${JSON.stringify(selectedPapers.map((paper) => paper.id))}`,
        `Review workflow: ${JSON.stringify(request.gathered?.reviewWorkflow ?? null)}`,
        `Selection quality: ${JSON.stringify(request.selectionQuality ?? null)}`,
        `Relevance assessments: ${JSON.stringify(request.relevanceAssessments ?? [])}`
      ];
    case "evidence":
      return [
        ...common,
        `Selected papers: ${JSON.stringify(selectedPapers)}`,
        `Known selected paper IDs: ${JSON.stringify(selectedPapers.map((paper) => paper.id))}`,
        `Relevance assessments: ${JSON.stringify(request.relevanceAssessments ?? [])}`,
        `Paper extractions: ${JSON.stringify(request.paperExtractions ?? [])}`,
        `Evidence matrix: ${JSON.stringify(request.evidenceMatrix ?? null)}`
      ];
    case "release":
      return [
        ...common,
        `Selected papers: ${JSON.stringify(selectedPapers)}`,
        `Known selected paper IDs: ${JSON.stringify(selectedPapers.map((paper) => paper.id))}`,
        `Known claim IDs: ${JSON.stringify([...new Set(claimIds)])}`,
        `Evidence matrix: ${JSON.stringify(request.evidenceMatrix ?? null)}`,
        `Synthesis: ${JSON.stringify(request.synthesis ?? null)}`,
        `Verification: ${JSON.stringify(request.verification ?? null)}`,
        `Agenda hold reasons: ${JSON.stringify(request.agenda?.holdReasons ?? [])}`,
        `Paper artifact: ${JSON.stringify(request.paper ?? null)}`,
        `References: ${JSON.stringify(request.references ?? null)}`,
        `Manuscript checks: ${JSON.stringify(request.manuscriptChecks ?? null)}`
      ];
  }
}

async function ollamaChatRaw(
  host: string,
  body: Record<string, unknown>,
  options: ResearchBackendCallOptions
): Promise<string> {
  let response: Response;
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const refreshIdleTimer = (): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs);
  };

  const readBody = async (): Promise<string> => {
    if (response.body === null) {
      return response.text();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (true) {
      const result = await reader.read();
      if (result.done) {
        text += decoder.decode();
        break;
      }

      refreshIdleTimer();
      text += decoder.decode(result.value, { stream: true });
    }

    return text;
  };

  try {
    refreshIdleTimer();
    response = await fetch(`http://${normalizeHost(host)}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    clearIdleTimer();
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";

    if (controller.signal.aborted || /timeout/i.test(name) || /timeout|aborted/i.test(message)) {
      throw new ResearchBackendError(
        "timeout",
        options.operation,
        `${options.operation} model call had no provider activity for ${options.timeoutMs} ms`,
        options.timeoutMs
      );
    }

    throw new ResearchBackendError(
      "unexpected",
      options.operation,
      `${options.operation} model call failed: ${message}`,
      options.timeoutMs
    );
  }

  if (!response.ok) {
    clearIdleTimer();
    throw new ResearchBackendError(
      "http",
      options.operation,
      `Ollama ${options.operation} request failed with ${response.status} ${response.statusText}`,
      options.timeoutMs
    );
  }

  let rawResponseText: string;

  try {
    refreshIdleTimer();
    rawResponseText = await readBody();
  } catch (error) {
    clearIdleTimer();
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";

    if (controller.signal.aborted || /timeout/i.test(name) || /timeout|aborted/i.test(message)) {
      throw new ResearchBackendError(
        "timeout",
        options.operation,
        `${options.operation} model call had no provider activity for ${options.timeoutMs} ms`,
        options.timeoutMs
      );
    }

    throw new ResearchBackendError(
      "unexpected",
      options.operation,
      `${options.operation} model response could not be read: ${message}`,
      options.timeoutMs
    );
  } finally {
    clearIdleTimer();
  }

  return rawResponseText;
}

async function ollamaJsonCall<T>(
  host: string,
  model: string,
  systemPrompt: string,
  options: ResearchBackendCallOptions
): Promise<T> {
  const rawResponseText = await ollamaChatRaw(
    host,
    {
      model,
      stream: true,
      think: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: systemPrompt
        }
      ]
    },
    options
  );
  const content = parseOllamaContent(rawResponseText);

  if (typeof content !== "string") {
    throw new ResearchBackendError(
      "unexpected",
      options.operation,
      `Ollama ${options.operation} request returned an unexpected response.`,
      options.timeoutMs
    );
  }

  try {
    return extractJson(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResearchBackendError(
      "malformed_json",
      options.operation,
      `Ollama ${options.operation} response was not valid JSON: ${message}`,
      options.timeoutMs
    );
  }
}

const researchActionToolName = "choose_research_action";

function researchActionToolDefinition(request: ResearchActionRequest): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: researchActionToolName,
      description: "Choose exactly one validated next action for the ClawResearch runtime. The runtime executes the action after validating it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: request.allowedActions,
            description: "The single next action the runtime should execute."
          },
          rationale: {
            type: "string",
            description: "Brief reason this action is the best next step."
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1
          },
          inputs: {
            type: "object",
            additionalProperties: false,
            properties: {
              searchQueries: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              evidenceTargets: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              paperIds: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              criticStage: {
                type: ["string", "null"],
                enum: ["protocol", "source_selection", "evidence", "release", null]
              },
              reason: {
                type: ["string", "null"]
              }
            },
            required: ["searchQueries", "evidenceTargets", "paperIds", "criticStage", "reason"]
          },
          expectedOutcome: {
            type: "string"
          },
          stopCondition: {
            type: "string"
          }
        },
        required: ["action", "rationale", "confidence", "inputs", "expectedOutcome", "stopCondition"]
      }
    }
  };
}

function nativeAgentStepInstruction(request: ResearchActionRequest): string {
  return [
    "You are ClawResearch's research-agent controller.",
    `Call ${researchActionToolName} exactly once.`,
    "Do not answer in prose. Do not invent tools. The runtime validates and executes the chosen action.",
    "If evidence is not ready and useful revision budget remains, choose revise_search_strategy with concrete searchQueries.",
    "If the selected evidence is ready for synthesis, choose synthesize_clustered.",
    "If the model cannot justify another useful step or action control is unsafe, choose finalize_status_report.",
    "",
    `Project root: ${request.projectRoot}`,
    `Run id: ${request.runId}`,
    `Phase: ${request.phase}`,
    `Attempt: ${request.attempt}/${request.maxAttempts}`,
    `Allowed actions: ${request.allowedActions.join(", ")}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Plan: ${JSON.stringify(request.plan)}`,
    `Observations: ${JSON.stringify(request.observations)}`,
    `Critic reports: ${JSON.stringify(request.criticReports.map((report) => ({
      stage: report.stage,
      readiness: report.readiness,
      confidence: report.confidence,
      objections: report.objections.map((objection) => ({
        code: objection.code,
        severity: objection.severity,
        target: objection.target,
        message: objection.message,
        suggestedRevision: objection.suggestedRevision
      })),
      revisionAdvice: report.revisionAdvice
    })))}`,
    request.retryInstruction === undefined ? "Retry instruction: null" : `Retry instruction: ${request.retryInstruction}`
  ].join("\n");
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value === "string") {
    return extractJson(value);
  }

  return value;
}

function extractNativeToolArguments(rawResponseText: string, toolName: string): unknown | null {
  let payload: OllamaChatResponse | null = null;

  try {
    payload = JSON.parse(rawResponseText) as OllamaChatResponse;
  } catch {
    return null;
  }

  const toolCall = payload.message?.tool_calls?.find((call) => call.function?.name === toolName);
  if (toolCall === undefined) {
    return null;
  }

  return parseToolArguments(toolCall.function?.arguments);
}

async function ollamaResearchActionToolCall(
  host: string,
  model: string,
  request: ResearchActionRequest,
  options: ResearchBackendCallOptions
): Promise<ResearchActionDecision> {
  const rawResponseText = await ollamaChatRaw(
    host,
    {
      model,
      stream: false,
      think: false,
      messages: [
        {
          role: "system",
          content: nativeAgentStepInstruction(request)
        }
      ],
      tools: [researchActionToolDefinition(request)]
    },
    options
  );
  let toolArguments: unknown | null;

  try {
    toolArguments = extractNativeToolArguments(rawResponseText, researchActionToolName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResearchBackendError(
      "malformed_json",
      "agent_step",
      `Ollama agent_step tool-call arguments were not valid JSON: ${message}`,
      options.timeoutMs
    );
  }

  if (toolArguments === null) {
    throw new ResearchBackendError(
      "malformed_json",
      "agent_step",
      `Ollama agent_step response did not include a ${researchActionToolName} tool call.`,
      options.timeoutMs
    );
  }

  try {
    return {
      ...normalizeResearchActionDecision(toolArguments, request),
      transport: "native_tool_call"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResearchBackendError(
      "malformed_json",
      "agent_step",
      `Research agent returned an invalid native tool call: ${message}`,
      options.timeoutMs
    );
  }
}

export class OllamaResearchBackend implements ResearchBackend {
  readonly label: string;
  readonly capabilities: ResearchBackendCapabilities = {
    actionControl: {
      nativeToolCalls: true,
      strictJsonFallback: true
    }
  };

  constructor(
    private readonly host = defaultHost,
    private readonly model = defaultModel,
    private readonly criticHost = defaultCriticHost,
    private readonly criticModel = defaultCriticModel
  ) {
    this.label = this.criticModel === this.model && this.criticHost === this.host
      ? `ollama:${this.model}`
      : `ollama:${this.model};critic:${this.criticModel}`;
  }

  async planResearch(request: ResearchPlanningRequest, options: ResearchBackendCallOptions = {
    operation: "planning",
    timeoutMs: 300_000
  }): Promise<ResearchPlan> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      planningInstruction(request),
      options
    );

    return normalizePlan(raw, request.brief);
  }

  async chooseResearchAction(request: ResearchActionRequest, options: ResearchBackendCallOptions = {
    operation: "agent_step",
    timeoutMs: 300_000
  }): Promise<ResearchActionDecision> {
    const agentControlMode = options.agentControlMode ?? "auto";

    if (agentControlMode === "native_tool_calls") {
      return ollamaResearchActionToolCall(this.host, this.model, request, options);
    }

    if (agentControlMode === "auto") {
      try {
        return await ollamaResearchActionToolCall(this.host, this.model, request, options);
      } catch (error) {
        if (!(error instanceof ResearchBackendError)) {
          throw error;
        }

        if (error.kind === "timeout") {
          throw error;
        }
      }
    }

    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      agentStepInstruction(request),
      options
    );

    try {
      return {
        ...normalizeResearchActionDecision(raw, request),
        transport: "strict_json"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ResearchBackendError(
        "malformed_json",
        "agent_step",
        `Research agent returned an invalid structured action: ${message}`,
        options.timeoutMs
      );
    }
  }

  async extractReviewedPapers(request: PaperExtractionRequest, options: ResearchBackendCallOptions = {
    operation: "extraction",
    timeoutMs: 300_000
  }): Promise<PaperExtraction[]> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      extractionInstruction(request),
      options
    );

    return normalizePaperExtractions(raw, request);
  }

  async synthesizeResearch(request: ResearchSynthesisRequest, options: ResearchBackendCallOptions = {
    operation: "synthesis",
    timeoutMs: 300_000
  }): Promise<ResearchSynthesis> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      synthesisInstruction(request),
      options
    );

    return normalizeSynthesis(raw, request, request.papers.map((paper) => paper.id));
  }

  async developResearchAgenda(request: ResearchAgendaRequest, options: ResearchBackendCallOptions = {
    operation: "agenda",
    timeoutMs: 300_000
  }): Promise<ResearchAgenda> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      agendaInstruction(request),
      options
    );

    return normalizeAgenda(raw, request);
  }

  async reviewResearchArtifact(request: CriticReviewRequest, options: ResearchBackendCallOptions = {
    operation: "critic",
    timeoutMs: 300_000
  }): Promise<CriticReviewArtifact> {
    const raw = await ollamaJsonCall<unknown>(
      this.criticHost,
      this.criticModel,
      criticInstruction(request),
      options
    );

    return normalizeCriticReview(raw, request);
  }
}

export function createDefaultResearchBackend(): ResearchBackend {
  return new OllamaResearchBackend();
}
