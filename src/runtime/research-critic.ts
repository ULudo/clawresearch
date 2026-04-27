import type { CanonicalPaper } from "./literature-store.js";
import type { ReviewSelectionQuality } from "./literature-review.js";
import type { ResearchAgenda, ResearchPlan, ResearchSynthesis } from "./research-backend.js";
import type { EvidenceMatrix, PaperExtraction } from "./research-evidence.js";
import type { ResearchSourceGatherResult, LiteratureRelevanceAssessment } from "./research-sources.js";
import type {
  ManuscriptChecksArtifact,
  ReferencesArtifact,
  ReviewPaperArtifact,
  ReviewProtocol
} from "./research-manuscript.js";
import type { ResearchBrief } from "./session-store.js";
import type { VerificationReport } from "./verifier.js";

export type CriticReviewStage =
  | "protocol"
  | "source_selection"
  | "evidence"
  | "release";

export type CriticReadiness =
  | "pass"
  | "revise"
  | "block";

export type CriticObjectionSeverity =
  | "blocking"
  | "major"
  | "minor";

export type CriticObjectionTarget =
  | "protocol"
  | "source_selection"
  | "extraction"
  | "evidence"
  | "synthesis"
  | "verification"
  | "manuscript"
  | "release";

export type CriticObjection = {
  code: string;
  severity: CriticObjectionSeverity;
  target: CriticObjectionTarget;
  message: string;
  affectedPaperIds: string[];
  affectedClaimIds: string[];
  suggestedRevision: string | null;
};

export type CriticRevisionAdvice = {
  searchQueries: string[];
  evidenceTargets: string[];
  papersToExclude: string[];
  claimsToSoften: string[];
};

export type CriticReviewArtifact = {
  schemaVersion: 1;
  runId: string;
  stage: CriticReviewStage;
  reviewer: "ephemeral_critic";
  readiness: CriticReadiness;
  confidence: number;
  objections: CriticObjection[];
  revisionAdvice: CriticRevisionAdvice;
};

export type CriticReviewRequest = {
  projectRoot: string;
  runId: string;
  stage: CriticReviewStage;
  iteration?: {
    attempt: number;
    maxAttempts: number;
    revisionPassesUsed: number;
  };
  retryInstruction?: string | null;
  brief: ResearchBrief;
  protocol?: ReviewProtocol | null;
  plan?: ResearchPlan | null;
  selectedPapers?: CanonicalPaper[];
  relevanceAssessments?: LiteratureRelevanceAssessment[];
  selectionQuality?: ReviewSelectionQuality | null;
  gathered?: Pick<ResearchSourceGatherResult, "reviewWorkflow" | "retrievalDiagnostics" | "notes"> | null;
  paperExtractions?: PaperExtraction[];
  evidenceMatrix?: EvidenceMatrix | null;
  synthesis?: ResearchSynthesis | null;
  verification?: VerificationReport | null;
  agenda?: ResearchAgenda | null;
  paper?: ReviewPaperArtifact | null;
  references?: ReferencesArtifact | null;
  manuscriptChecks?: ManuscriptChecksArtifact | null;
};

const maxObjections = 12;
const maxRevisionItems = 12;
const maxMessageLength = 700;

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const text = readString(entry);
      return text === null ? [] : [text];
    })
    : [];
}

function compactText(value: string, limit = maxMessageLength): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 3).trim()}...`;
}

function uniqueStrings(values: string[], limit = maxRevisionItems): string[] {
  return [...new Set(values.map((value) => compactText(value, 220)).filter((value) => value.length > 0))].slice(0, limit);
}

function normalizeReadiness(value: unknown): CriticReadiness | null {
  switch (readString(value)?.toLowerCase()) {
    case "pass":
      return "pass";
    case "revise":
      return "revise";
    case "block":
      return "block";
    default:
      return null;
  }
}

function normalizeSeverity(value: unknown, readiness: CriticReadiness): CriticObjectionSeverity {
  switch (readString(value)?.toLowerCase()) {
    case "blocking":
      return "blocking";
    case "major":
      return "major";
    case "minor":
      return "minor";
    default:
      return readiness === "pass" ? "minor" : "blocking";
  }
}

function normalizeTarget(value: unknown, stage: CriticReviewStage): CriticObjectionTarget {
  switch (readString(value)?.toLowerCase()) {
    case "protocol":
      return "protocol";
    case "source_selection":
    case "source selection":
      return "source_selection";
    case "extraction":
      return "extraction";
    case "evidence":
      return "evidence";
    case "synthesis":
      return "synthesis";
    case "verification":
      return "verification";
    case "manuscript":
      return "manuscript";
    case "release":
      return "release";
    default:
      return stage === "source_selection" ? "source_selection" : stage;
  }
}

function normalizeConfidence(value: unknown, readiness: CriticReadiness): number {
  const confidence = readNumber(value);
  if (confidence === null) {
    return readiness === "pass" ? 0.7 : 0.8;
  }

  return Math.min(1, Math.max(0, confidence));
}

function allowedPaperIdsFor(request: CriticReviewRequest): Set<string> {
  return new Set((request.selectedPapers ?? []).map((paper) => paper.id));
}

function allowedClaimIdsFor(request: CriticReviewRequest): Set<string> {
  return new Set([
    ...(request.paper?.claims.map((claim) => claim.claimId) ?? []),
    ...(request.verification?.verifiedClaims.map((claim) => claim.claimId) ?? [])
  ]);
}

function filterKnownIds(values: unknown, allowedIds: Set<string>): string[] {
  if (allowedIds.size === 0) {
    return [];
  }

  return readStringArray(values)
    .filter((id) => allowedIds.has(id))
    .slice(0, maxRevisionItems);
}

function normalizeObjections(
  raw: unknown,
  request: CriticReviewRequest,
  readiness: CriticReadiness
): CriticObjection[] {
  const allowedPaperIds = allowedPaperIdsFor(request);
  const allowedClaimIds = allowedClaimIdsFor(request);
  const rawObjections = Array.isArray(raw) ? raw.slice(0, maxObjections) : [];
  const objections = rawObjections.flatMap((entry, index) => {
    const record = asObject(entry);
    const message = readString(record.message) ?? readString(record.reason);
    if (message === null) {
      return [];
    }

    return [{
      code: readString(record.code) ?? `critic-${request.stage}-${index + 1}`,
      severity: normalizeSeverity(record.severity, readiness),
      target: normalizeTarget(record.target, request.stage),
      message: compactText(message),
      affectedPaperIds: filterKnownIds(record.affectedPaperIds ?? record.paperIds, allowedPaperIds),
      affectedClaimIds: filterKnownIds(record.affectedClaimIds ?? record.claimIds, allowedClaimIds),
      suggestedRevision: readString(record.suggestedRevision ?? record.suggestedRecovery) === null
        ? null
        : compactText(readString(record.suggestedRevision ?? record.suggestedRecovery) ?? "", 260)
    }];
  });

  if (readiness !== "pass" && objections.length === 0) {
    return [{
      code: `critic-${request.stage}-nonpass`,
      severity: "blocking",
      target: normalizeTarget(null, request.stage),
      message: `The ${request.stage.replace(/_/g, " ")} critic did not pass this artifact but did not provide a structured objection.`,
      affectedPaperIds: [],
      affectedClaimIds: [],
      suggestedRevision: "Revise the prior research stage with more focused evidence before release."
    }];
  }

  return objections;
}

function normalizeRevisionAdvice(raw: unknown, request: CriticReviewRequest): CriticRevisionAdvice {
  const record = asObject(raw);
  const allowedPaperIds = allowedPaperIdsFor(request);
  const allowedClaimIds = allowedClaimIdsFor(request);

  return {
    searchQueries: uniqueStrings(readStringArray(record.searchQueries)),
    evidenceTargets: uniqueStrings(readStringArray(record.evidenceTargets)),
    papersToExclude: filterKnownIds(record.papersToExclude, allowedPaperIds),
    claimsToSoften: filterKnownIds(record.claimsToSoften, allowedClaimIds)
  };
}

function isPrematureProtocolEvidenceObjection(request: CriticReviewRequest, objection: CriticObjection): boolean {
  if (request.stage !== "protocol" || objection.target === "protocol") {
    return false;
  }

  const text = `${objection.code} ${objection.message}`.toLowerCase();
  const mentionsMissingArtifact = /\b(no|none|zero|0|missing|absence|absent|lack|lacks|lacking|without)\b/.test(text);
  const mentionsFutureEvidence = /\b(selected\s+papers?|papers?\s+selected|sources?|evidence|claims?|extractions?|synthesis|verification|manuscript)\b/.test(text);

  return mentionsMissingArtifact && mentionsFutureEvidence;
}

export function normalizeCriticReview(raw: unknown, request: CriticReviewRequest): CriticReviewArtifact {
  const record = asObject(raw);
  let readiness = normalizeReadiness(record.readiness) ?? "block";
  const revisionAdvice = normalizeRevisionAdvice(record.revisionAdvice ?? record.recoveryAdvice, request);
  let objections = normalizeObjections(record.objections, request, readiness);

  if (request.stage === "protocol") {
    const stageCompatibleObjections = objections.filter((objection) => (
      !isPrematureProtocolEvidenceObjection(request, objection)
    ));

    if (stageCompatibleObjections.length !== objections.length) {
      objections = stageCompatibleObjections;
      if (objections.length === 0) {
        readiness = "pass";
      } else if (readiness === "block" && !objections.some((objection) => objection.severity === "blocking")) {
        readiness = "revise";
      }
    }
  }

  return {
    schemaVersion: 1,
    runId: request.runId,
    stage: request.stage,
    reviewer: "ephemeral_critic",
    readiness,
    confidence: normalizeConfidence(record.confidence, readiness),
    objections,
    revisionAdvice
  };
}

export function criticUnavailableReview(
  request: CriticReviewRequest,
  message: string
): CriticReviewArtifact {
  return {
    schemaVersion: 1,
    runId: request.runId,
    stage: request.stage,
    reviewer: "ephemeral_critic",
    readiness: "block",
    confidence: 1,
    objections: [{
      code: "critic-unavailable",
      severity: "blocking",
      target: normalizeTarget(null, request.stage),
      message: compactText(`Critic review was unavailable: ${message}`),
      affectedPaperIds: [],
      affectedClaimIds: [],
      suggestedRevision: "Retry with a working critic backend before releasing a full manuscript."
    }],
    revisionAdvice: {
      searchQueries: [],
      evidenceTargets: [],
      papersToExclude: [],
      claimsToSoften: []
    }
  };
}

export function criticReviewPassed(report: CriticReviewArtifact): boolean {
  return report.readiness === "pass"
    && !report.objections.some((objection) => objection.severity === "blocking");
}

export function criticReviewNeedsRevision(report: CriticReviewArtifact): boolean {
  return report.readiness === "revise"
    || report.revisionAdvice.searchQueries.length > 0
    || report.revisionAdvice.evidenceTargets.length > 0
    || report.objections.some((objection) => objection.suggestedRevision !== null);
}

export function criticRevisionTexts(reports: CriticReviewArtifact[]): string[] {
  return uniqueStrings(reports.flatMap((report) => [
    ...report.revisionAdvice.searchQueries,
    ...report.revisionAdvice.evidenceTargets,
    ...report.objections.flatMap((objection) => objection.suggestedRevision === null ? [] : [objection.suggestedRevision])
  ]), 16);
}
