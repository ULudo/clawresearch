import type { ResearchBrief } from "./session-store.js";
import type { ResearchPlan } from "./research-backend.js";
import type { CriticReviewArtifact } from "./research-critic.js";

export type LegacyResearchActionName =
  | "revise_protocol"
  | "revise_search_strategy"
  | "search_sources"
  | "screen_sources"
  | "merge_sources"
  | "rank_sources"
  | "resolve_access"
  | "select_sources"
  | "select_evidence_set"
  | "extract_papers"
  | "build_evidence_matrix"
  | "ask_critic"
  | "work_store.query"
  | "work_store.read"
  | "work_store.create"
  | "work_store.patch"
  | "evidence.revise_strategy"
  | "evidence.extract"
  | "evidence.build_matrix"
  | "evidence.update_cell"
  | "evidence.find_support"
  | "evidence.find_contradictions"
  | "claim.revise"
  | "claim.attach_citation"
  | "critic.create_work_item"
  | "critic.resolve_work_item"
  | "manuscript.read_section"
  | "manuscript.patch_section"
  | "manuscript.add_paragraph"
  | "manuscript.check_section_claims"
  | "manuscript.status";

export type ResearchWorkspaceToolName =
  | "workspace.search"
  | "workspace.read"
  | "workspace.list"
  | "workspace.create"
  | "workspace.patch"
  | "workspace.link"
  | "workspace.unlink"
  | "workspace.status"
  | "source.search"
  | "source.merge"
  | "source.rank"
  | "source.resolve_access"
  | "source.select_evidence"
  | "claim.create"
  | "claim.patch"
  | "claim.check_support"
  | "claim.link_support"
  | "critic.review"
  | "section.create"
  | "section.read"
  | "section.patch"
  | "section.link_claim"
  | "section.check_claims"
  | "work_item.create"
  | "work_item.patch"
  | "check.run"
  | "manuscript.release";

export type ResearchActionName = LegacyResearchActionName | ResearchWorkspaceToolName;

export const researchWorkspaceToolActions: ResearchWorkspaceToolName[] = [
  "workspace.search",
  "workspace.read",
  "workspace.list",
  "workspace.create",
  "workspace.patch",
  "workspace.link",
  "workspace.unlink",
  "source.search",
  "source.merge",
  "source.rank",
  "source.resolve_access",
  "source.select_evidence",
  "claim.create",
  "claim.patch",
  "claim.check_support",
  "claim.link_support",
  "critic.review",
  "section.create",
  "section.read",
  "section.patch",
  "section.link_claim",
  "section.check_claims",
  "work_item.create",
  "work_item.patch",
  "check.run",
  "manuscript.release",
  "workspace.status"
];

export function workspaceResearchActions(): ResearchActionName[] {
  return [...researchWorkspaceToolActions];
}

export function isResearchWorkspaceToolName(value: ResearchActionName): value is ResearchWorkspaceToolName {
  return (researchWorkspaceToolActions as ResearchActionName[]).includes(value);
}

export type ResearchAgentControlMode =
  | "auto"
  | "native_tool_calls"
  | "strict_json";

export type ResearchActionTransport =
  | "native_tool_call"
  | "strict_json";

export type ResearchActionTransportFallback = {
  from: ResearchActionTransport;
  to: ResearchActionTransport;
  kind: string;
  message: string;
};

export type AgentVisibleEntityPreview = {
  id: string;
  kind: string;
  title?: string;
  text?: string;
  sourceId?: string;
  sourceTitle?: string;
  sourceIds?: string[];
  claimIds?: string[];
  sectionIds?: string[];
  status?: string;
  confidence?: string;
  snippet?: string;
  fields?: Record<string, string | number | boolean | null | string[]>;
};

export type AgentToolResult = {
  id: string;
  action: string;
  status: "ok" | "failed" | "blocked" | "noop";
  readOnly: boolean;
  timestamp: string;
  message: string;
  collection?: string | null;
  query?: Record<string, unknown>;
  count?: number;
  totalCount?: number;
  cursor?: string | null;
  hasMore?: boolean;
  nextCursor?: string | null;
  items?: AgentVisibleEntityPreview[];
  entity?: AgentVisibleEntityPreview | null;
  related?: AgentVisibleEntityPreview[];
  stateDelta?: Record<string, number>;
  nextHints?: string[];
  error?: string | null;
};

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
    providerIds: string[];
    searchQueries: string[];
    evidenceTargets: string[];
    paperIds: string[];
    criticStage: string | null;
    reason: string | null;
    workStore?: {
      collection: string | null;
      entityId: string | null;
      filters: Record<string, string | number | boolean | null>;
      filterJson?: string | null;
      semanticQuery: string | null;
      limit: number | null;
      cursor?: string | null;
      changes: Record<string, unknown>;
      entity: Record<string, unknown>;
      payloadJson?: string | null;
      patchJson?: string | null;
      link?: {
        fromCollection: string | null;
        fromId: string | null;
        toCollection: string | null;
        toId: string | null;
        relation: string | null;
        snippet: string | null;
      };
    };
  };
  expectedOutcome: string;
  stopCondition: string;
  transport?: ResearchActionTransport;
  transportFallback?: ResearchActionTransportFallback;
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
  sourceState?: {
    availableProviderIds: string[];
    attemptedProviderIds: string[];
    candidateQueries: string[];
    rawSources: number;
    screenedSources: number;
    backgroundSources: number;
    sourceStage: string;
    canonicalPapers: number;
    candidatePaperIds: string[];
    resolvedPaperIds: string[];
    selectedPapers: number;
    selectedPaperIds: string[];
    newSourcesLastAction: number;
    consecutiveNoProgressSearches: number;
    providerYields: Array<{
      providerId: string;
      calls: number;
      rawCandidates: number;
      newSources: number;
      errors: number;
      lastError: string | null;
    }>;
    exhaustedProviderIds: string[];
    repeatedSearchWarnings: string[];
    mergeReadiness: {
      ready: boolean;
      reason: string;
      recommendedActions: ResearchActionName[];
    };
    recentActions: Array<{
      action: string;
      providerId: string | null;
      queryKey: string | null;
      rawCandidates: number;
      newSources: number;
      error: string | null;
      message: string;
    }>;
    lastObservation: string | null;
  };
  workStore?: {
    path: string;
    summary: {
      canonicalSources: number;
      extractions: number;
      evidenceCells: number;
      claims: number;
      openWorkItems: number;
      releaseChecks: number;
    };
    worker: {
      status: string;
      statusReason: string;
      paperReadiness: string | null;
      nextInternalActions: string[];
      userBlockers: string[];
    };
    openWorkItems: Array<{
      id: string;
      type: string;
      severity: string;
      title: string;
      description: string;
      targetKind: string;
      targetId: string | null;
      suggestedActions: string[];
    }>;
    recentSources: Array<{
      id: string;
      title: string;
      screeningDecision: string;
      accessMode: string;
    }>;
    recentClaims: Array<{
      id: string;
      text: string;
      supportStatus: string;
      sourceIds: string[];
    }>;
    recentSections: Array<{
      id: string;
      title: string;
      status: string;
      claimIds: string[];
      sourceIds: string[];
    }>;
    recentCitations: Array<{
      id: string;
      sourceId: string;
      sourceTitle: string;
      evidenceCellId: string | null;
      supportSnippet: string;
      claimIds: string[];
      sectionIds: string[];
    }>;
  };
  criticReports: CriticReviewArtifact[];
  toolResults?: AgentToolResult[];
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

function safeRecord(value: unknown, limit = 40): Record<string, unknown> {
  return Object.fromEntries(Object.entries(asObject(value)).slice(0, limit));
}

function safeJsonRecord(value: unknown, limit = 40): Record<string, unknown> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  try {
    return safeRecord(JSON.parse(value) as unknown, limit);
  } catch {
    return {};
  }
}

function safeFilterRecord(value: unknown, limit = 24): Record<string, string | number | boolean | null> {
  const entries = Object.entries(asObject(value)).flatMap(([key, entry]) => {
    if (
      typeof entry === "string"
      || typeof entry === "number"
      || typeof entry === "boolean"
      || entry === null
    ) {
      return [[key, entry] as const];
    }

    return [];
  });

  return Object.fromEntries(entries.slice(0, limit));
}

function safeFilterJsonRecord(value: unknown, limit = 24): Record<string, string | number | boolean | null> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  try {
    return safeFilterRecord(JSON.parse(value) as unknown, limit);
  } catch {
    return {};
  }
}

function safeNullableNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(1, Math.min(500, Math.round(value)));
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
  const workStore = asObject(inputs.workStore);
  const filters = safeFilterRecord(workStore.filters);
  const filterJson = safeFilterJsonRecord(workStore.filterJson);
  const changes = safeRecord(workStore.changes);
  const patchJson = safeJsonRecord(workStore.patchJson);
  const entity = safeRecord(workStore.entity);
  const payloadJson = safeJsonRecord(workStore.payloadJson);
  const link = asObject(workStore.link);

  return {
    schemaVersion: 1,
    action,
    rationale: safeString(record.rationale) ?? `The research agent selected ${action}.`,
    confidence: safeConfidence(record.confidence),
    inputs: {
      providerIds: safeStringArray(inputs.providerIds, 12),
      searchQueries: safeStringArray(inputs.searchQueries),
      evidenceTargets: safeStringArray(inputs.evidenceTargets),
      paperIds: safeStringArray(inputs.paperIds),
      criticStage: safeString(inputs.criticStage),
      reason: safeString(inputs.reason),
      workStore: {
        collection: safeString(workStore.collection),
        entityId: safeString(workStore.entityId),
        filters: Object.keys(filters).length > 0 ? filters : filterJson,
        filterJson: safeString(workStore.filterJson),
        semanticQuery: safeString(workStore.semanticQuery),
        limit: safeNullableNumber(workStore.limit),
        cursor: safeString(workStore.cursor),
        changes: Object.keys(changes).length > 0 ? changes : patchJson,
        entity: Object.keys(entity).length > 0 ? entity : payloadJson,
        patchJson: safeString(workStore.patchJson),
        payloadJson: safeString(workStore.payloadJson),
        link: {
          fromCollection: safeString(link.fromCollection),
          fromId: safeString(link.fromId),
          toCollection: safeString(link.toCollection),
          toId: safeString(link.toId),
          relation: safeString(link.relation),
          snippet: safeString(link.snippet)
        }
      }
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

  const fallbackAction = request.allowedActions.includes("workspace.status")
    ? "workspace.status"
    : request.allowedActions.includes("manuscript.status")
      ? "manuscript.status"
      : request.allowedActions[0] ?? "workspace.status";

  return {
    schemaVersion: 1,
    action: fallbackAction,
    rationale: `The selected model did not produce reliable structured research actions for ${request.phase}.`,
    confidence: 0,
    inputs: {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticStage: null,
      reason: recent.length > 0 ? recent : "Structured action selection failed.",
      workStore: {
        collection: null,
        entityId: null,
        filters: {},
        filterJson: null,
        semanticQuery: null,
        limit: null,
        changes: {},
        entity: {},
        patchJson: null,
        payloadJson: null,
        link: {
          fromCollection: null,
          fromId: null,
          toCollection: null,
          toId: null,
          relation: null,
          snippet: null
        }
      }
    },
    expectedOutcome: "Complete the run with a status-only report and model-suitability diagnostics.",
    stopCondition: "Do not release a full manuscript when the research agent cannot drive the action loop."
  };
}
