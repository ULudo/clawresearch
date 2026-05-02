import { createMemoryRecordId } from "./memory-store.js";
import type { ResearchClaim } from "./research-backend.js";
import { createLiteratureEntityId } from "./literature-store.js";
import type { CanonicalPaper, PaperAccessMode } from "./literature-store.js";
import type { ResearchBrief } from "./session-store.js";

const verificationSchemaVersion = 3;
const unknownPattern = /\b(?:unknown|unclear|unverified|insufficient|not enough|no direct evidence|limited evidence|remains incomplete)\b/i;
const topicalStopTokens = new Set([
  "about",
  "after",
  "analysis",
  "approach",
  "approaches",
  "best",
  "build",
  "built",
  "current",
  "design",
  "efficient",
  "evidence",
  "expected",
  "focus",
  "general",
  "identify",
  "including",
  "investigate",
  "literature",
  "meet",
  "paper",
  "quality",
  "question",
  "research",
  "review",
  "standard",
  "study",
  "success",
  "synthesis",
  "technique",
  "techniques",
  "typically",
  "what",
  "which",
  "with",
  "work"
]);

export type ClaimSupportStatus =
  | "supported"
  | "partially_supported"
  | "unverified"
  | "unknown";

export type ClaimConfidence =
  | "high"
  | "medium"
  | "low"
  | "unknown";

export type SourceProvenance = {
  sourceId: string;
  sourceRecordId: string;
  providerIds: string[];
  title: string;
  citation: string;
  locator: string | null;
  accessMode: PaperAccessMode;
};

export type ClaimEvidenceLink = {
  sourceId: string;
  sourceRecordId: string;
  providerIds: string[];
  title: string;
  citation: string;
  locator: string | null;
  accessMode: PaperAccessMode;
  excerpt: string;
};

export type SourceRelevanceStatus =
  | "relevant"
  | "weak"
  | "off_topic";

export type SourceRelevance = {
  sourceId: string;
  status: SourceRelevanceStatus;
  matchedBriefTerms: string[];
  rationale: string;
};

export type VerifiedClaim = {
  claimId: string;
  claim: string;
  evidence: string;
  citedSourceIds: string[];
  missingSourceIds: string[];
  offTopicSourceIds: string[];
  supportStatus: ClaimSupportStatus;
  confidence: ClaimConfidence;
  evidenceLinks: ClaimEvidenceLink[];
  provenance: SourceProvenance[];
  verificationNotes: string[];
};

export type VerificationCounts = {
  claims: number;
  supported: number;
  partiallySupported: number;
  unverified: number;
  unknown: number;
  sources: number;
  topicallyRelevantSources: number;
  weaklyRelevantSources: number;
  offTopicSources: number;
};

export type VerificationReport = {
  schemaVersion: number;
  overallStatus: "grounded" | "mixed" | "insufficient_evidence";
  summary: string;
  counts: VerificationCounts;
  sourceProvenance: SourceProvenance[];
  sourceRelevance: SourceRelevance[];
  verifiedClaims: VerifiedClaim[];
  unverifiedClaims: Array<{
    claimId: string;
    claim: string;
    reason: string;
  }>;
  unknowns: string[];
};

export type VerificationRequest = {
  brief: ResearchBrief;
  papers: CanonicalPaper[];
  claims: ResearchClaim[];
};

function sourceRecordId(source: CanonicalPaper): string {
  return createLiteratureEntityId("paper", source.key);
}

function claimRecordId(claim: ResearchClaim): string {
  return createMemoryRecordId("claim", claim.claim);
}

function toProvenance(source: CanonicalPaper): SourceProvenance {
  return {
    sourceId: source.id,
    sourceRecordId: sourceRecordId(source),
    providerIds: source.discoveredVia,
    title: source.title,
    citation: source.citation,
    locator: source.bestAccessUrl,
    accessMode: source.accessMode
  };
}

function toEvidenceLink(source: CanonicalPaper): ClaimEvidenceLink {
  return {
    sourceId: source.id,
    sourceRecordId: sourceRecordId(source),
    providerIds: source.discoveredVia,
    title: source.title,
    citation: source.citation,
    locator: source.bestAccessUrl,
    accessMode: source.accessMode,
    excerpt: source.abstract ?? `${source.accessMode} via ${source.bestAccessProvider ?? "unknown"}`
  };
}

function normalizeText(text: string): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function topicalTokens(text: string | null | undefined): string[] {
  if (typeof text !== "string") {
    return [];
  }

  return normalizeText(text)
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !topicalStopTokens.has(token));
}

function sourceRelevanceToBrief(brief: ResearchBrief, source: CanonicalPaper): SourceRelevance {
  const topicTokens = [...new Set(topicalTokens(brief.topic))];
  const briefTokens = [...new Set([
    ...topicTokens,
    ...topicalTokens(brief.researchQuestion),
    ...topicalTokens(brief.researchDirection),
    ...topicalTokens(brief.successCriterion)
  ])];
  const sourceText = normalizeText([
    source.title,
    source.abstract,
    source.citation,
    source.venue,
    ...source.tags
  ].filter((value): value is string => typeof value === "string").join(" "));
  const sourceTokens = new Set(topicalTokens(sourceText));
  const matchedBriefTerms = briefTokens.filter((token) => sourceTokens.has(token) || sourceText.includes(token));
  const matchedTopicTerms = topicTokens.filter((token) => sourceTokens.has(token) || sourceText.includes(token));
  const topicNeeded = topicTokens.length === 0 ? 0 : Math.min(2, topicTokens.length);
  const status: SourceRelevanceStatus = topicNeeded > 0 && matchedTopicTerms.length >= topicNeeded
    ? "relevant"
    : topicNeeded === 0 && matchedBriefTerms.length >= 2
      ? "weak"
      : matchedTopicTerms.length > 0 && matchedBriefTerms.length >= 2
        ? "weak"
        : "off_topic";
  const rationale = status === "relevant"
    ? "The source matches the core topic terms from the brief."
    : status === "weak"
      ? "The source has partial overlap with the brief but does not fully match the core topic."
      : "The source does not match the core topic terms from the brief closely enough for claim support.";

  return {
    sourceId: source.id,
    status,
    matchedBriefTerms,
    rationale
  };
}

function supportStrength(accessMode: PaperAccessMode): number {
  switch (accessMode) {
    case "fulltext_open":
      return 4;
    case "fulltext_licensed":
      return 3;
    case "abstract_available":
      return 2;
    case "metadata_only":
      return 1;
    case "needs_credentials":
    case "fulltext_blocked":
      return 0;
  }
}

function supportProfile(claim: ResearchClaim, papers: CanonicalPaper[]): {
  supportStatus: ClaimSupportStatus;
  confidence: ClaimConfidence;
  notes: string[];
} {
  const notes: string[] = [];

  if (papers.length === 0) {
    notes.push("No cited canonical papers were available to verify this claim.");
    return {
      supportStatus: "unverified",
      confidence: "low",
      notes
    };
  }

  if (unknownPattern.test(`${claim.claim} ${claim.evidence}`)) {
    notes.push("The claim itself remains explicit about unknown or limited evidence.");
    return {
      supportStatus: "unknown",
      confidence: "unknown",
      notes
    };
  }

  const readablePapers = papers.filter((paper) => supportStrength(paper.accessMode) >= 2);
  const blockedPapers = papers.filter((paper) => supportStrength(paper.accessMode) === 0);

  if (readablePapers.length >= 2) {
    notes.push("The claim is linked to multiple readable papers with accessible evidence.");
    return {
      supportStatus: "supported",
      confidence: "high",
      notes
    };
  }

  if (readablePapers.length === 1) {
    notes.push(`The claim is linked to one readable paper at ${readablePapers[0]!.accessMode}.`);
    return {
      supportStatus: "supported",
      confidence: readablePapers[0]!.accessMode === "abstract_available" ? "medium" : "high",
      notes
    };
  }

  if (blockedPapers.length > 0) {
    notes.push("The cited papers were discovered, but the best legal reading route remains blocked or still needs credentials.");
    return {
      supportStatus: "unverified",
      confidence: "low",
      notes
    };
  }

  notes.push("Only metadata-level records were available, so the claim remains only partially grounded.");
  return {
    supportStatus: "partially_supported",
    confidence: "low",
    notes
  };
}

function summarizeReport(report: VerificationReport, brief: ResearchBrief): string {
  if (report.verifiedClaims.length === 0) {
    return `No synthesized claims were available to verify for ${brief.topic ?? "this project"}. The run stayed explicit about unknowns and evidence gaps.`;
  }

  return [
    `Verified ${report.counts.claims} claims against ${report.counts.sources} canonical papers.`,
    `${report.counts.supported} supported, ${report.counts.partiallySupported} partially supported, ${report.counts.unverified} unverified, ${report.counts.unknown} explicit unknown.`,
    `${report.counts.offTopicSources} sources were outside the scoped topic.`
  ].join(" ");
}

export function verifyResearchClaims(request: VerificationRequest): VerificationReport {
  const sourceMap = new Map(request.papers.map((paper) => [paper.id, paper]));
  const sourceProvenance = request.papers.map(toProvenance);
  const sourceRelevance = request.papers.map((paper) => sourceRelevanceToBrief(request.brief, paper));
  const relevanceBySourceId = new Map(sourceRelevance.map((entry) => [entry.sourceId, entry]));
  const verifiedClaims = request.claims.map((claim) => {
    const matchedSources = claim.sourceIds.flatMap((sourceId) => {
      const source = sourceMap.get(sourceId);
      return source === undefined ? [] : [source];
    });
    const missingSourceIds = claim.sourceIds.filter((sourceId) => !sourceMap.has(sourceId));
    const offTopicSourceIds = matchedSources
      .filter((source) => relevanceBySourceId.get(source.id)?.status === "off_topic")
      .map((source) => source.id);
    const profile = supportProfile(claim, matchedSources);
    const notes = [...profile.notes];

    if (missingSourceIds.length > 0) {
      notes.push(`Missing cited canonical papers: ${missingSourceIds.join(", ")}.`);
    }

    if (offTopicSourceIds.length > 0) {
      notes.push(`Source relevance diagnostics flagged these cited sources for researcher review: ${offTopicSourceIds.join(", ")}.`);
    }

    let supportStatus = profile.supportStatus;
    let confidence = profile.confidence;

    if (missingSourceIds.length > 0 && supportStatus === "supported") {
      supportStatus = "partially_supported";
      confidence = "low";
    }

    return {
      claimId: claimRecordId(claim),
      claim: claim.claim,
      evidence: claim.evidence,
      citedSourceIds: claim.sourceIds,
      missingSourceIds,
      offTopicSourceIds,
      supportStatus,
      confidence,
      evidenceLinks: matchedSources.map(toEvidenceLink),
      provenance: matchedSources.map(toProvenance),
      verificationNotes: notes
    };
  });

  const unknowns = verifiedClaims
    .filter((claim) => claim.supportStatus === "unknown")
    .map((claim) => `Unknown: ${claim.claim}`);
  const unverifiedClaims = verifiedClaims
    .filter((claim) => claim.supportStatus === "unverified" || claim.supportStatus === "partially_supported")
    .map((claim) => ({
      claimId: claim.claimId,
      claim: claim.claim,
      reason: claim.verificationNotes.join(" ")
    }));

  if (verifiedClaims.length === 0) {
    unknowns.push("No synthesized claims were available for verification in this run.");
  }

  if (request.papers.length === 0) {
    unknowns.push("No canonical papers were available for verification.");
  }

  const counts: VerificationCounts = {
    claims: verifiedClaims.length,
    supported: verifiedClaims.filter((claim) => claim.supportStatus === "supported").length,
    partiallySupported: verifiedClaims.filter((claim) => claim.supportStatus === "partially_supported").length,
    unverified: verifiedClaims.filter((claim) => claim.supportStatus === "unverified").length,
    unknown: verifiedClaims.filter((claim) => claim.supportStatus === "unknown").length,
    sources: request.papers.length,
    topicallyRelevantSources: sourceRelevance.filter((entry) => entry.status === "relevant").length,
    weaklyRelevantSources: sourceRelevance.filter((entry) => entry.status === "weak").length,
    offTopicSources: sourceRelevance.filter((entry) => entry.status === "off_topic").length
  };

  const overallStatus = request.papers.length === 0
    ? "insufficient_evidence"
    : counts.unverified > 0 || counts.unknown > 0 || counts.partiallySupported > 0 || counts.offTopicSources > 0
      ? "mixed"
      : "grounded";

  const report: VerificationReport = {
    schemaVersion: verificationSchemaVersion,
    overallStatus,
    summary: "",
    counts,
    sourceProvenance,
    sourceRelevance,
    verifiedClaims,
    unverifiedClaims,
    unknowns
  };

  report.summary = summarizeReport(report, request.brief);
  return report;
}
