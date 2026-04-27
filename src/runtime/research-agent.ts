import type { ResearchBrief } from "./session-store.js";
import type { ResearchPlan } from "./research-backend.js";
import type { CriticReviewArtifact } from "./research-critic.js";

export type ResearchActionName =
  | "revise_protocol"
  | "revise_search_strategy"
  | "search_sources"
  | "screen_sources"
  | "select_sources"
  | "extract_papers"
  | "build_evidence_matrix"
  | "synthesize_clustered"
  | "ask_critic"
  | "finalize_status_report"
  | "release_manuscript";

export type ResearchAgentPhase =
  | "protocol"
  | "source_selection"
  | "evidence"
  | "synthesis"
  | "release";

export type ResearchActionDecision = {
  schemaVersion: number;
  action: ResearchActionName;
  rationale: string;
  confidence: number;
  inputs: {
    searchQueries: string[];
    evidenceTargets: string[];
    paperIds: string[];
    criticStage: string | null;
    reason: string | null;
  };
  expectedOutcome: string;
  stopCondition: string;
};

export type ResearchActionRequest = {
  projectRoot: string;
  runId: string;
  phase: ResearchAgentPhase;
  attempt: number;
  maxAttempts: number;
  allowedActions: ResearchActionName[];
  brief: ResearchBrief;
  plan: ResearchPlan;
  observations: {
    canonicalPapers: number;
    selectedPapers: number;
    extractedPapers: number;
    evidenceRows: number;
    evidenceInsights: number;
    manuscriptReadiness: string | null;
    revisionPassesUsed: number;
    revisionPassesRemaining: number;
  };
  criticReports: CriticReviewArtifact[];
  retryInstruction?: string;
};

export type ResearchActionDiagnostic = {
  phase: ResearchAgentPhase;
  attempt: number;
  kind: "malformed_action" | "provider_failure" | "invalid_action";
  message: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeStringArray(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((entry) => {
      const text = safeString(entry);
      return text === null ? [] : [text];
    })
    .slice(0, limit);
}

function safeConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function safeAction(value: unknown, allowedActions: ResearchActionName[]): ResearchActionName | null {
  if (typeof value !== "string") {
    return null;
  }

  return allowedActions.includes(value as ResearchActionName)
    ? value as ResearchActionName
    : null;
}

export function normalizeResearchActionDecision(
  raw: unknown,
  request: ResearchActionRequest
): ResearchActionDecision {
  const record = asObject(raw);
  const action = safeAction(record.action, request.allowedActions);

  if (action === null) {
    throw new Error(`Agent action must be one of: ${request.allowedActions.join(", ")}`);
  }

  const inputs = asObject(record.inputs);

  return {
    schemaVersion: 1,
    action,
    rationale: safeString(record.rationale) ?? `The research agent selected ${action}.`,
    confidence: safeConfidence(record.confidence),
    inputs: {
      searchQueries: safeStringArray(inputs.searchQueries),
      evidenceTargets: safeStringArray(inputs.evidenceTargets),
      paperIds: safeStringArray(inputs.paperIds),
      criticStage: safeString(inputs.criticStage),
      reason: safeString(inputs.reason)
    },
    expectedOutcome: safeString(record.expectedOutcome) ?? "Advance the research run by one validated action.",
    stopCondition: safeString(record.stopCondition) ?? "Stop when the action produces a checkpointed artifact or a blocker."
  };
}

export function modelUnsuitableActionDecision(
  request: ResearchActionRequest,
  diagnostics: ResearchActionDiagnostic[]
): ResearchActionDecision {
  const recent = diagnostics
    .filter((diagnostic) => diagnostic.phase === request.phase)
    .slice(-3)
    .map((diagnostic) => `${diagnostic.kind}: ${diagnostic.message}`)
    .join("; ");

  return {
    schemaVersion: 1,
    action: "finalize_status_report",
    rationale: `The selected model did not produce reliable structured research actions for ${request.phase}.`,
    confidence: 0,
    inputs: {
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticStage: null,
      reason: recent.length > 0 ? recent : "Structured action selection failed."
    },
    expectedOutcome: "Complete the run with a status-only report and model-suitability diagnostics.",
    stopCondition: "Do not release a full manuscript when the research agent cannot drive the action loop."
  };
}
