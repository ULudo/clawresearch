import { createMemoryRecordId } from "./memory-store.js";
import type { ResearchClaim } from "./research-backend.js";
import type { ResearchSource, ResearchSourceKind } from "./research-sources.js";
import type { ResearchBrief } from "./session-store.js";

const verificationSchemaVersion = 1;
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
  kind: ResearchSourceKind;
  title: string;
  citation: string;
  locator: string | null;
};

export type ClaimEvidenceLink = {
  sourceId: string;
  sourceRecordId: string;
  kind: ResearchSourceKind;
  title: string;
  citation: string;
  locator: string | null;
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
  sources: ResearchSource[];
  claims: ResearchClaim[];
};

function sourceRecordId(source: ResearchSource): string {
  if (source.kind === "project_brief") {
    return createMemoryRecordId(
      "source",
      [
        source.kind,
        source.title,
        source.citation,
        source.excerpt
      ].join(" | ")
    );
  }

  return createMemoryRecordId(
    "source",
    `${source.kind}:${source.locator ?? source.citation ?? source.title}`
  );
}

function claimRecordId(claim: ResearchClaim): string {
  return createMemoryRecordId("claim", claim.claim);
}

function toProvenance(source: ResearchSource): SourceProvenance {
  return {
    sourceId: source.id,
    sourceRecordId: sourceRecordId(source),
    kind: source.kind,
    title: source.title,
    citation: source.citation,
    locator: source.locator
  };
}

function toEvidenceLink(source: ResearchSource): ClaimEvidenceLink {
  return {
    sourceId: source.id,
    sourceRecordId: sourceRecordId(source),
    kind: source.kind,
    title: source.title,
    citation: source.citation,
    locator: source.locator,
    excerpt: source.excerpt
  };
}

function supportProfile(claim: ResearchClaim, sources: ResearchSource[]): {
  supportStatus: ClaimSupportStatus;
  confidence: ClaimConfidence;
  notes: string[];
} {
  const notes: string[] = [];
  const externalSources = sources.filter((source) => source.kind !== "project_brief");

  if (sources.length === 0) {
    notes.push("No cited sources were available to verify this claim.");
    return {
      supportStatus: "unverified",
      confidence: "low",
      notes
    };
  }

  if (externalSources.length === 0) {
    notes.push("The claim is only linked to the project brief, not to an evidence-bearing source.");
    return {
      supportStatus: "unverified",
      confidence: "low",
      notes
    };
  }

  if (unknownPattern.test(`${claim.claim} ${claim.evidence}`)) {
    notes.push("The claim itself expresses uncertainty or absence of direct evidence.");
    return {
      supportStatus: "unknown",
      confidence: "unknown",
      notes
    };
  }

  if (externalSources.length >= 2) {
    notes.push("The claim is linked to multiple evidence-bearing sources.");
    return {
      supportStatus: "supported",
      confidence: "high",
      notes
    };
  }

  notes.push("The claim is linked to a single evidence-bearing source.");
  return {
    supportStatus: "supported",
    confidence: "medium",
    notes
  };
}

function summarizeReport(report: VerificationReport, brief: ResearchBrief): string {
  if (report.verifiedClaims.length === 0) {
    return `No synthesized claims were available to verify for ${brief.topic ?? "this project"}. Current state remains explicit about unknowns and unverified gaps.`;
  }

  return [
    `Verified ${report.counts.claims} claims against ${report.counts.sources} sources.`,
    `${report.counts.supported} supported, ${report.counts.partiallySupported} partially supported, ${report.counts.unverified} unverified, ${report.counts.unknown} explicit unknown.`
  ].join(" ");
}

export function verifyResearchClaims(request: VerificationRequest): VerificationReport {
  const sourceMap = new Map(request.sources.map((source) => [source.id, source]));
  const sourceProvenance = request.sources.map(toProvenance);
  const verifiedClaims = request.claims.map((claim) => {
    const matchedSources = claim.sourceIds.flatMap((sourceId) => {
      const source = sourceMap.get(sourceId);
      return source === undefined ? [] : [source];
    });
    const missingSourceIds = claim.sourceIds.filter((sourceId) => !sourceMap.has(sourceId));
    const profile = supportProfile(claim, matchedSources);
    const notes = [...profile.notes];

    if (missingSourceIds.length > 0) {
      notes.push(`Missing cited sources: ${missingSourceIds.join(", ")}.`);
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

  if (request.sources.filter((source) => source.kind !== "project_brief").length === 0) {
    unknowns.push("No evidence-bearing sources beyond the project brief were available for verification.");
  }

  const counts: VerificationCounts = {
    claims: verifiedClaims.length,
    supported: verifiedClaims.filter((claim) => claim.supportStatus === "supported").length,
    partiallySupported: verifiedClaims.filter((claim) => claim.supportStatus === "partially_supported").length,
    unverified: verifiedClaims.filter((claim) => claim.supportStatus === "unverified").length,
    unknown: verifiedClaims.filter((claim) => claim.supportStatus === "unknown").length,
    sources: request.sources.length
  };

  const overallStatus = request.sources.filter((source) => source.kind !== "project_brief").length === 0
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
