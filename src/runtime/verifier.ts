import { createMemoryRecordId } from "./memory-store.js";
import type { ResearchClaim } from "./research-backend.js";
import { createLiteratureEntityId } from "./literature-store.js";
import type { CanonicalPaper, PaperAccessMode } from "./literature-store.js";
import type { ResearchBrief } from "./session-store.js";

const verificationSchemaVersion = 2;
const unknownPattern = /\b(?:unknown|unclear|unverified|insufficient|not enough|no direct evidence|limited evidence|remains incomplete)\b/i;

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

export type VerifiedClaim = {
  claimId: string;
  claim: string;
  evidence: string;
  citedSourceIds: string[];
  missingSourceIds: string[];
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
};

export type VerificationReport = {
  schemaVersion: number;
  overallStatus: "grounded" | "mixed" | "insufficient_evidence";
  summary: string;
  counts: VerificationCounts;
  sourceProvenance: SourceProvenance[];
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
    `${report.counts.supported} supported, ${report.counts.partiallySupported} partially supported, ${report.counts.unverified} unverified, ${report.counts.unknown} explicit unknown.`
  ].join(" ");
}

export function verifyResearchClaims(request: VerificationRequest): VerificationReport {
  const sourceMap = new Map(request.papers.map((paper) => [paper.id, paper]));
  const sourceProvenance = request.papers.map(toProvenance);
  const verifiedClaims = request.claims.map((claim) => {
    const matchedSources = claim.sourceIds.flatMap((sourceId) => {
      const source = sourceMap.get(sourceId);
      return source === undefined ? [] : [source];
    });
    const missingSourceIds = claim.sourceIds.filter((sourceId) => !sourceMap.has(sourceId));
    const profile = supportProfile(claim, matchedSources);
    const notes = [...profile.notes];

    if (missingSourceIds.length > 0) {
      notes.push(`Missing cited canonical papers: ${missingSourceIds.join(", ")}.`);
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
    sources: request.papers.length
  };

  const overallStatus = request.papers.length === 0
    ? "insufficient_evidence"
    : counts.unverified > 0 || counts.unknown > 0 || counts.partiallySupported > 0
      ? "mixed"
      : "grounded";

  const report: VerificationReport = {
    schemaVersion: verificationSchemaVersion,
    overallStatus,
    summary: "",
    counts,
    sourceProvenance,
    verifiedClaims,
    unverifiedClaims,
    unknowns
  };

  report.summary = summarizeReport(report, request.brief);
  return report;
}
