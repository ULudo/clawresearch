import type { ResearchBrief } from "./session-store.js";

export type PaperClaimSupportStrength =
  | "explicit"
  | "partial"
  | "implied";

export type PaperExtractionConfidence =
  | "high"
  | "medium"
  | "low";

export type PaperExtraction = {
  id: string;
  paperId: string;
  runId: string;
  problemSetting: string;
  systemType: string;
  architecture: string;
  toolsAndMemory: string;
  planningStyle: string;
  evaluationSetup: string;
  successSignals: string[];
  failureModes: string[];
  limitations: string[];
  supportedClaims: Array<{
    claim: string;
    support: PaperClaimSupportStrength;
  }>;
  confidence: PaperExtractionConfidence;
  evidenceNotes: string[];
};

export type EvidenceMatrixInsightKind =
  | "pattern"
  | "anti_pattern"
  | "gap"
  | "conflict";

export type EvidenceMatrixRow = {
  paperId: string;
  extractionId: string;
  problemSetting: string;
  systemType: string;
  architecture: string;
  toolsAndMemory: string;
  planningStyle: string;
  evaluationSetup: string;
  successSignals: string[];
  failureModes: string[];
  limitations: string[];
  claimCount: number;
  confidence: PaperExtractionConfidence;
};

export type EvidenceMatrixInsight = {
  id: string;
  kind: EvidenceMatrixInsightKind;
  title: string;
  summary: string;
  paperIds: string[];
  claimTexts: string[];
};

export type EvidenceMatrix = {
  schemaVersion: number;
  runId: string;
  briefFingerprint: string;
  rowCount: number;
  rows: EvidenceMatrixRow[];
  derivedInsights: EvidenceMatrixInsight[];
};

export type EvidenceMatrixRequest = {
  runId: string;
  brief: ResearchBrief;
  paperExtractions: PaperExtraction[];
};

const lowInformationEvidenceValues = new Set([
  "unknown",
  "none",
  "n/a",
  "not specified",
  "not explicitly specified",
  "not mentioned",
  "not explicitly mentioned",
  "not described",
  "not explicitly described",
  "no failure modes explicitly described",
  "no limitations explicitly described"
]);

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

function evidenceInsightValue(value: string): string | null {
  const normalized = normalizeText(value).toLowerCase();

  return normalized.length === 0 || lowInformationEvidenceValues.has(normalized)
    ? null
    : normalized;
}

export function briefFingerprint(brief: ResearchBrief): string {
  return hashString(JSON.stringify({
    topic: brief.topic,
    researchQuestion: brief.researchQuestion,
    researchDirection: brief.researchDirection,
    successCriterion: brief.successCriterion
  }));
}

function evidenceMatrixRowFromExtraction(extraction: PaperExtraction): EvidenceMatrixRow {
  return {
    paperId: extraction.paperId,
    extractionId: extraction.id,
    problemSetting: extraction.problemSetting,
    systemType: extraction.systemType,
    architecture: extraction.architecture,
    toolsAndMemory: extraction.toolsAndMemory,
    planningStyle: extraction.planningStyle,
    evaluationSetup: extraction.evaluationSetup,
    successSignals: extraction.successSignals,
    failureModes: extraction.failureModes,
    limitations: extraction.limitations,
    claimCount: extraction.supportedClaims.length,
    confidence: extraction.confidence
  };
}

function collectRepeatedEvidence(
  extractions: PaperExtraction[],
  field: "successSignals" | "failureModes"
): Map<string, { paperIds: Set<string>; claimTexts: Set<string> }> {
  const repeated = new Map<string, { paperIds: Set<string>; claimTexts: Set<string> }>();

  for (const extraction of extractions) {
    for (const value of extraction[field]) {
      const normalized = evidenceInsightValue(value);

      if (normalized === null) {
        continue;
      }

      const entry = repeated.get(normalized) ?? {
        paperIds: new Set<string>(),
        claimTexts: new Set<string>()
      };

      entry.paperIds.add(extraction.paperId);

      for (const claim of extraction.supportedClaims) {
        entry.claimTexts.add(claim.claim);
      }

      repeated.set(normalized, entry);
    }
  }

  return repeated;
}

function deriveRepeatedEvidenceInsights(
  extractions: PaperExtraction[],
  field: "successSignals" | "failureModes"
): EvidenceMatrixInsight[] {
  const repeated = collectRepeatedEvidence(extractions, field);
  const isSuccess = field === "successSignals";

  return [...repeated.entries()].flatMap(([value, entry]) => {
    if (entry.paperIds.size < 2) {
      return [];
    }

    return [{
      id: `insight-${hashString(`${isSuccess ? "pattern" : "anti"}:${value}`)}`,
      kind: isSuccess ? "pattern" : "anti_pattern",
      title: isSuccess
        ? `Recurring success pattern: ${value}`
        : `Recurring failure mode: ${value}`,
      summary: isSuccess
        ? `Multiple reviewed papers point to ${value} as a recurring success signal.`
        : `Multiple reviewed papers report ${value} as a recurring failure mode or limitation.`,
      paperIds: [...entry.paperIds],
      claimTexts: [...entry.claimTexts].slice(0, 6)
    }];
  });
}

function deriveEvidenceMatrixInsights(extractions: PaperExtraction[]): EvidenceMatrixInsight[] {
  const insights = [
    ...deriveRepeatedEvidenceInsights(extractions, "successSignals"),
    ...deriveRepeatedEvidenceInsights(extractions, "failureModes")
  ];
  const rowsWithoutEvaluation = extractions
    .filter((extraction) => extraction.evaluationSetup.length === 0)
    .map((extraction) => extraction.paperId);
  const rowsWithLowConfidence = extractions
    .filter((extraction) => extraction.confidence === "low")
    .map((extraction) => extraction.paperId);

  if (rowsWithoutEvaluation.length > 0) {
    insights.push({
      id: `insight-${hashString(`gap:evaluation:${rowsWithoutEvaluation.join(",")}`)}`,
      kind: "gap",
      title: "Evaluation gaps remain in the reviewed set",
      summary: "Some reviewed papers did not expose a clear evaluation setup, which limits cross-paper comparison.",
      paperIds: rowsWithoutEvaluation.slice(0, 12),
      claimTexts: []
    });
  }

  if (rowsWithLowConfidence.length > 0) {
    insights.push({
      id: `insight-${hashString(`conflict:confidence:${rowsWithLowConfidence.join(",")}`)}`,
      kind: "conflict",
      title: "Some reviewed evidence remains low-confidence",
      summary: "Low-confidence extractions indicate conflicting, underspecified, or weakly comparable evidence in part of the reviewed set.",
      paperIds: rowsWithLowConfidence.slice(0, 12),
      claimTexts: []
    });
  }

  if (insights.length === 0 && extractions.length > 0) {
    insights.push({
      id: `insight-${hashString(`gap:sparse:${extractions.length}`)}`,
      kind: "gap",
      title: "Evidence remains sparse",
      summary: "The reviewed set is still too sparse for strong cross-paper comparisons.",
      paperIds: extractions.map((extraction) => extraction.paperId),
      claimTexts: []
    });
  }

  return insights.slice(0, 12);
}

export function buildEvidenceMatrix(request: EvidenceMatrixRequest): EvidenceMatrix {
  const rows = request.paperExtractions.map((extraction) => evidenceMatrixRowFromExtraction(extraction));

  return {
    schemaVersion: 1,
    runId: request.runId,
    briefFingerprint: briefFingerprint(request.brief),
    rowCount: rows.length,
    rows,
    derivedInsights: deriveEvidenceMatrixInsights(request.paperExtractions)
  };
}

export function evidenceMatrixNextQuestions(evidenceMatrix: EvidenceMatrix): string[] {
  return evidenceMatrix.derivedInsights
    .filter((insight) => insight.kind === "gap" || insight.kind === "conflict")
    .map((insight) => {
      if (insight.kind === "gap") {
        return `Which focused follow-up would best close this evidence gap: ${insight.title.toLowerCase()}?`;
      }

      return `What additional evidence or comparison would best resolve this conflict: ${insight.title.toLowerCase()}?`;
    })
    .slice(0, 6);
}
