import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildLiteratureContext,
  createLiteratureEntityId,
  LiteratureStore,
  type CanonicalPaper,
  type CanonicalPaperInput,
  type LiteratureNotebookInput,
  type LiteratureThemeInput,
  type LiteratureUpsertResult
} from "./literature-store.js";
import {
  buildProjectMemoryContext,
  MemoryStore
} from "./memory-store.js";
import { applyCredentialsToEnvironment, CredentialStore } from "./credential-store.js";
import {
  authStatesForSelectedProviders,
  formatSelectedLiteratureProviders,
  ProjectConfigStore,
  resolveRuntimeLlmConfig,
  selectedGeneralWebProviders,
  selectedProviderIdsForCategory,
  selectedScholarlySourceProviders,
  type RuntimeLlmConfig
} from "./project-config-store.js";
import type {
  ResearchBackend,
  ResearchPlan
} from "./research-backend.js";
import {
  modelUnsuitableActionDecision,
  workspaceResearchActions,
  type AgentToolResult,
  type AgentVisibleEntityPreview,
  type ResearchActionDecision,
  type ResearchActionDiagnostic,
  type ResearchActionTransport,
  type ResearchActionRequest
} from "./research-agent.js";
import {
  createProjectResearchBackend,
  ResearchBackendError
} from "./research-backend.js";
import {
  buildReviewProtocol,
  reviewProtocolMarkdown,
  type ManuscriptCheck,
  type ManuscriptChecksArtifact,
  type ManuscriptReadinessState,
  type ReferenceRecord,
  type ReferencesArtifact,
  type ReviewPaperArtifact,
  type ReviewProtocol
} from "./research-manuscript.js";
import {
  briefFingerprint,
  buildEvidenceMatrix,
  type PaperClaimSupportStrength,
  type PaperExtraction,
  type PaperExtractionConfidence
} from "./research-evidence.js";
import {
  normalizeCriticReview,
  type CriticReviewScope
} from "./research-critic.js";
import {
  SourceToolRuntime,
  collectResearchLocalFileHints,
  type SourceToolState,
  type ResearchSourceToolRequest,
  type SourceToolProgressEvent,
  type ResearchSourceToolAdapter,
  type ResearchSourceSnapshot,
  type SourceToolObservation
} from "./research-sources.js";
import {
  type RunController
} from "./run-controller.js";
import type { SourceProviderId } from "./provider-registry.js";
import { appendRunEvent, type RunEventKind } from "./run-events.js";
import {
  createResearchDirectionState,
  researchDirectionPath,
  RunStore,
  type RunRecord
} from "./run-store.js";
import {
  createResearchWorkerState,
  loadResearchWorkerState,
  writeResearchWorkerState,
  type ResearchWorkerState
} from "./research-state.js";
import type { ResearchBrief } from "./session-store.js";
import {
  buildLiteratureContextFromWorkStore,
  buildProjectMemoryContextFromWorkStore,
  createResearchWorkStoreEntity,
  loadResearchWorkStore,
  mergeRunSegmentIntoResearchWorkStore,
  patchResearchWorkStoreEntity,
  queryResearchWorkStore,
  readResearchWorkStoreEntity,
  researchWorkStoreFilePath,
  summarizeResearchWorkStore,
  upsertResearchWorkStoreEntities,
  workItemsFromCriticReports,
  writeResearchWorkStore,
  type ResearchWorkStore,
  type WorkStoreCollectionName,
  type WorkStoreCanonicalSource,
  type WorkStoreClaim,
  type WorkStoreCitation,
  type WorkStoreEvidenceCell,
  type WorkStoreEntity,
  type WorkStoreEntityKind,
  type WorkStoreManuscriptSection,
  type WorkStoreProtocol,
  type WorkStoreReleaseCheck,
  type ResearchWorkerStatus,
  type WorkStoreWorkItem
} from "./research-work-store.js";
import {
  guidanceContextForAgent,
  readResearchGuidance,
  recommendResearchGuidance,
  searchResearchGuidance
} from "./research-guidance.js";

type WorkerOptions = {
  projectRoot: string;
  runId: string;
  version: string;
  now?: () => string;
  researchBackend?: ResearchBackend;
  sourceToolAdapter?: ResearchSourceToolAdapter;
  runController?: RunController;
};

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

type ArtifactStatus = {
  schemaVersion: number;
  runId: string;
  artifactKind: string;
  status: "pending" | "in_progress" | "failed" | "skipped";
  stage: string;
  createdAt: string;
  updatedAt: string;
  counts: Record<string, number>;
  error: {
    message: string;
    kind: string;
    operation: string | null;
  } | null;
};

type AgentStepStatus =
  | "started"
  | "completed"
  | "revising"
  | "blocked"
  | "warning";

type AgentStepRecord = {
  schemaVersion: number;
  runId: string;
  step: number;
  timestamp: string;
  actor: "research_agent" | "critic" | "runtime";
  phase: string;
  action: string;
  status: AgentStepStatus;
  summary: string;
  artifactPaths: string[];
  counts: Record<string, number>;
  metadata: Record<string, JsonValue>;
};

type AgentStateArtifact = {
  schemaVersion: number;
  runId: string;
  status: "pending" | "running" | "completed" | "blocked";
  currentPhase: string;
  lastAction: string | null;
  lastStatus: AgentStepStatus | null;
  completedSteps: number;
  updatedAt: string;
  lastMetadata: Record<string, JsonValue>;
};

type LoggedResearchActionTransport =
  | ResearchActionTransport
  | "runtime_fallback"
  | "unknown";

type AgentActionTransportRecord = {
  phase: string;
  action: string;
  attempt: number;
  transport: LoggedResearchActionTransport;
  fallbackFrom?: ResearchActionTransport;
  fallbackKind?: string;
};

function markdownBrief(brief: ResearchBrief): string {
  return [
    "# Research Brief",
    "",
    `- Topic: ${brief.topic ?? "<missing>"}`,
    `- Research question: ${brief.researchQuestion ?? "<missing>"}`,
    `- Research direction: ${brief.researchDirection ?? "<missing>"}`,
    `- Success criterion: ${brief.successCriterion ?? "<missing>"}`
  ].join("\n");
}

function runLoopCommand(runId: string): string[] {
  return [
    "clawresearch",
    "research-loop",
    "--run-id",
    runId,
    "--mode",
    "model-driven-research-session"
  ];
}

async function appendTrace(run: RunRecord, now: () => string, message: string): Promise<void> {
  await appendFile(run.artifacts.tracePath, `[${now()}] ${message}\n`, "utf8");
}

async function appendEvent(
  run: RunRecord,
  now: () => string,
  kind: RunEventKind,
  message: string
): Promise<void> {
  await appendRunEvent(run.artifacts.eventsPath, {
    timestamp: now(),
    kind,
    message
  });
}

async function appendLogLine(filePath: string, message: string): Promise<void> {
  await appendFile(filePath, `${message}\n`, "utf8");
}

async function appendStdout(run: RunRecord, message: string): Promise<void> {
  await appendLogLine(run.artifacts.stdoutPath, message);
}

async function appendStderr(run: RunRecord, message: string): Promise<void> {
  await appendLogLine(run.artifacts.stderrPath, message);
}

async function writeJsonArtifact(filePath: string, value: JsonValue | Record<string, unknown> | unknown[]): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourceProgressEventKind(event: SourceToolProgressEvent): RunEventKind {
  if (event.status === "failed") {
    return "stderr";
  }

  return event.phase === "provider_query" || event.phase === "screening"
    ? "source"
    : "literature";
}

function sourceProgressMessage(event: SourceToolProgressEvent): string {
  const provider = event.providerId === undefined ? "" : ` [${event.providerId}]`;
  return `${event.message}${provider}`;
}

async function writeSourceToolCheckpoint(input: {
  run: RunRecord;
  now: () => string;
  sessionSegment: number;
  event: SourceToolProgressEvent;
  sourceState?: SourceToolState | null;
}): Promise<void> {
  await writeJsonArtifact(input.run.artifacts.sourcesPath, {
    schemaVersion: 1,
    runId: input.run.id,
    status: input.event.phase === "completed" && input.event.status === "completed" ? "completed" : "in_progress",
    stage: "source_tools",
    updatedAt: input.now(),
    modelDrivenSession: {
      segment: input.sessionSegment
    },
    progress: input.event,
    sourceState: input.sourceState ?? null
  });
}

function sourceStateForAgent(session: SourceToolRuntime): ResearchActionRequest["sourceState"] {
  const state = session.state();
  return {
    availableProviderIds: state.availableProviderIds,
    attemptedProviderIds: state.attemptedProviderIds,
    candidateQueries: state.candidateQueries,
    rawSources: state.rawSources,
    screenedSources: state.screenedSources,
    backgroundSources: state.backgroundSources,
    canonicalMergeCompleted: state.canonicalMergeCompleted,
    canonicalPapers: state.canonicalPapers,
    candidatePaperIds: state.candidatePaperIds,
    resolvedPaperIds: state.resolvedPaperIds,
    selectedPapers: state.selectedPapers,
    selectedPaperIds: state.selectedPaperIds,
    newSourcesLastAction: state.newSourcesLastAction,
    consecutiveNoProgressSearches: state.consecutiveNoProgressSearches,
    providerYields: state.providerYields,
    exhaustedProviderIds: state.exhaustedProviderIds,
    repeatedSearchWarnings: state.repeatedSearchWarnings,
    mergeReadiness: state.mergeReadiness,
    recentActions: state.recentActions,
    lastObservation: state.lastObservation
  };
}

function recentlyChangedWorkspaceIds(store: ResearchWorkStore): Array<{ collection: string; id: string; updatedAt: string }> {
  return workStoreCollections
    .flatMap((collection) => store.objects[collection].map((entity) => ({
      collection,
      id: entity.id,
      updatedAt: entity.updatedAt
    })))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 12);
}

const workStoreCollections: WorkStoreCollectionName[] = [
  "providerRuns",
  "sources",
  "canonicalSources",
  "screeningDecisions",
  "fullTextRecords",
  "extractions",
  "evidenceCells",
  "claims",
  "citations",
  "protocols",
  "workItems",
  "manuscriptSections",
  "releaseChecks"
];

const workStoreEntityKinds: WorkStoreEntityKind[] = [
  "providerRun",
  "source",
  "canonicalSource",
  "screeningDecision",
  "fullTextRecord",
  "extraction",
  "evidenceCell",
  "claim",
  "citation",
  "protocol",
  "workItem",
  "manuscriptSection",
  "releaseCheck"
];

function workStoreContextForAgent(store: ResearchWorkStore): ResearchActionRequest["workStore"] {
  const supportReadiness = supportReadinessForWorkspace(store);
  const openWorkItems = store.objects.workItems.filter((item) => item.status === "open");
  const failedReleaseChecks = store.objects.releaseChecks.filter((check) => check.status === "fail");
  const sourceAccess = {
    sourceCandidates: store.objects.sources.length,
    canonicalSources: store.objects.canonicalSources.length,
    screenedInSources: store.objects.canonicalSources.filter((source) => source.screeningDecision === "include").length,
    fullTextAvailableSources: store.objects.fullTextRecords.filter((record) => record.fulltextAvailable).length,
    metadataOnlySources: store.objects.canonicalSources.filter((source) => source.accessMode === "metadata_only").length
  };

  return {
    path: researchWorkStoreFilePath(store.projectRoot),
    summary: summarizeResearchWorkStore(store),
    dashboard: {
      lookupReminder: "The dashboard is only a compact index. Use workspace.list, workspace.search, and workspace.read to inspect older or full workspace objects before deciding.",
      openWorkItems: openWorkItems.length,
      blockingWorkItems: openWorkItems.filter((item) => item.severity === "blocking").length,
      unsupportedClaims: supportReadiness.unsupportedClaimIds.size,
      sectionsNeedingRevision: store.objects.manuscriptSections.filter((section) => section.status === "needs_revision" || section.claimIds.length === 0).length,
      failedReleaseChecks: failedReleaseChecks.length,
      releaseCheckBlockers: failedReleaseChecks.filter((check) => check.severity === "blocker").length,
      sourceAccess,
      recentlyChangedIds: recentlyChangedWorkspaceIds(store),
      suggestedLookupTools: ["workspace.list", "workspace.search", "workspace.read"]
    },
    worker: {
      status: store.worker.status,
      statusReason: store.worker.statusReason,
      paperReadiness: store.worker.paperReadiness,
      nextInternalActions: store.worker.nextInternalActions.slice(0, 8),
      userBlockers: store.worker.userBlockers.slice(0, 8)
    },
    openWorkItems: store.objects.workItems
      .filter((item) => item.status === "open")
      .slice(-12)
      .map((item) => ({
        id: item.id,
        type: item.type,
        severity: item.severity,
        title: item.title,
        description: item.description,
        targetKind: item.targetKind,
        targetId: item.targetId,
        suggestedActions: item.suggestedActions.slice(0, 6)
      })),
    recentProtocols: store.objects.protocols.slice(-4).map((protocol) => ({
      id: protocol.id,
      title: protocol.title,
      objective: protocol.objective,
      evidenceTargets: protocol.evidenceTargets.slice(0, 8),
      author: protocol.author
    })),
    recentSourceCandidates: store.objects.sources.slice(-12).map((source) => ({
      id: source.id,
      title: source.title,
      providerId: source.providerId,
      category: source.category,
      sourceKind: source.sourceKind
    })),
    recentSources: store.objects.canonicalSources.slice(-12).map((source) => ({
      id: source.id,
      title: source.title,
      screeningDecision: source.screeningDecision,
      accessMode: source.accessMode
    })),
    recentClaims: store.objects.claims.slice(-12).map((claim) => ({
      id: claim.id,
      text: claim.text,
      supportStatus: claim.supportStatus,
      sourceIds: claim.sourceIds.slice(0, 8)
    })),
    recentSections: store.objects.manuscriptSections.slice(-8).map((section) => ({
      id: section.id,
      title: section.title,
      status: section.status,
      claimIds: section.claimIds.slice(0, 8),
      sourceIds: section.sourceIds.slice(0, 8)
    })),
    recentCitations: store.objects.citations.slice(-12).map((citation) => ({
      id: citation.id,
      sourceId: citation.sourceId,
      sourceTitle: citation.sourceTitle,
      evidenceCellId: citation.evidenceCellId,
      supportSnippet: compactPreviewText(citation.supportSnippet, 180),
      claimIds: citation.claimIds.slice(0, 8),
      sectionIds: citation.sectionIds.slice(0, 8)
    }))
  };
}

function isSourceSearchAction(action: ResearchActionDecision["action"]): boolean {
  return action === "source.search";
}

function isSourceMergeAction(action: ResearchActionDecision["action"]): boolean {
  return action === "source.merge";
}

function isSourceResolveAccessAction(action: ResearchActionDecision["action"]): boolean {
  return action === "source.resolve_access";
}

function isSourceSelectEvidenceAction(action: ResearchActionDecision["action"]): boolean {
  return action === "source.select_evidence";
}

function isStatusAction(action: ResearchActionDecision["action"]): boolean {
  return action === "workspace.status";
}

function isGuidanceToolAction(action: ResearchActionDecision["action"]): boolean {
  return action === "guidance.search"
    || action === "guidance.read"
    || action === "guidance.recommend";
}

function isWorkStoreToolAction(action: ResearchActionDecision["action"]): boolean {
  return action === "workspace.search"
    || action === "workspace.read"
    || action === "workspace.list"
    || action === "workspace.create"
    || action === "workspace.patch"
    || action === "workspace.link"
    || action === "workspace.unlink";
}

function isResearchObjectToolAction(action: ResearchActionDecision["action"]): boolean {
  return action === "protocol.create_or_revise"
    || action === "claim.create"
    || action === "claim.patch"
    || action === "claim.check_support"
    || action === "claim.link_support"
    || action === "extraction.create"
    || action === "evidence.create_cell"
    || action === "evidence.matrix_view"
    || action === "critic.review"
    || action === "section.create"
    || action === "section.read"
    || action === "section.patch"
    || action === "section.link_claim"
    || action === "section.check_claims"
    || action === "work_item.create"
    || action === "work_item.patch"
    || action === "check.run"
    || action === "release.verify"
    || action === "manuscript.release";
}

function isReadOnlyWorkspaceAction(action: ResearchActionDecision["action"]): boolean {
  return action === "workspace.search"
    || action === "workspace.read"
    || action === "workspace.list"
    || action === "evidence.matrix_view"
    || action === "section.read"
    || action === "guidance.search"
    || action === "guidance.read"
    || action === "guidance.recommend";
}

function safeWorkStoreCollection(value: string | null | undefined): WorkStoreCollectionName | null {
  return workStoreCollections.includes(value as WorkStoreCollectionName)
    ? value as WorkStoreCollectionName
    : null;
}

function safeWorkStoreEntityKind(value: unknown): WorkStoreEntityKind | null {
  return typeof value === "string" && workStoreEntityKinds.includes(value as WorkStoreEntityKind)
    ? value as WorkStoreEntityKind
    : null;
}

function stringInput(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function stringArrayInput(value: unknown, limit = 12): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : []).slice(0, limit)
    : [];
}

function objectInput(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function defaultWorkStoreArgs(): NonNullable<ResearchActionDecision["inputs"]["workStore"]> {
  return {
    collection: null,
    entityId: null,
    filters: {},
    semanticQuery: null,
    limit: null,
    cursor: null,
    changes: {},
    entity: {},
    filterJson: null,
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
  };
}

function compactPreviewText(value: unknown, maxLength = 280): string {
  const text = Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === "string" ? [entry] : []).join("; ")
    : typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : String(value);
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function compactPreviewList(value: unknown, limit = 4, maxLength = 180): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const text = compactPreviewText(entry, maxLength);
      return text.length === 0 ? [] : [text];
    }).slice(0, limit)
    : [];
}

function previewSourceTitle(store: ResearchWorkStore, sourceId: string): string | undefined {
  return store.objects.canonicalSources.find((source) => (
    source.id === sourceId
    || createLiteratureEntityId("paper", source.key) === sourceId
  ))?.title;
}

function entityPreviewForAgent(entity: WorkStoreEntity, store: ResearchWorkStore): AgentVisibleEntityPreview {
  switch (entity.kind) {
    case "canonicalSource":
      return {
        id: entity.id,
        kind: entity.kind,
        title: entity.title,
        status: entity.screeningDecision,
        snippet: compactPreviewText(entity.abstract ?? entity.citation),
        fields: {
          year: entity.year,
          venue: entity.venue,
          accessMode: entity.accessMode,
          bestAccessUrl: entity.bestAccessUrl,
          tags: entity.tags.slice(0, 8)
        }
      };
    case "source":
      return {
        id: entity.id,
        kind: entity.kind,
        title: entity.title,
        snippet: compactPreviewText(entity.excerpt),
        fields: {
          providerId: entity.providerId,
          category: entity.category,
          locator: entity.locator
        }
      };
    case "extraction": {
      const extraction = entity.extraction;
      return {
        id: entity.id,
        kind: entity.kind,
        sourceId: entity.sourceId,
        sourceTitle: previewSourceTitle(store, entity.sourceId),
        confidence: extraction.confidence,
        snippet: compactPreviewText(extraction.problemSetting),
        fields: {
          problemSetting: compactPreviewText(extraction.problemSetting),
          systemType: compactPreviewText(extraction.systemType),
          architecture: compactPreviewText(extraction.architecture),
          toolsAndMemory: compactPreviewText(extraction.toolsAndMemory),
          planningStyle: compactPreviewText(extraction.planningStyle),
          evaluationSetup: compactPreviewText(extraction.evaluationSetup),
          successSignals: compactPreviewList(extraction.successSignals),
          failureModes: compactPreviewList(extraction.failureModes),
          limitations: compactPreviewList(extraction.limitations)
        }
      };
    }
    case "evidenceCell":
      return {
        id: entity.id,
        kind: entity.kind,
        sourceId: entity.sourceId,
        sourceTitle: previewSourceTitle(store, entity.sourceId),
        confidence: entity.confidence,
        snippet: compactPreviewText(entity.value),
        fields: {
          extractionId: entity.extractionId,
          field: entity.field,
          value: Array.isArray(entity.value)
            ? compactPreviewList(entity.value)
            : compactPreviewText(entity.value)
        }
      };
    case "claim":
      return {
        id: entity.id,
        kind: entity.kind,
        text: entity.text,
        sourceIds: entity.sourceIds.slice(0, 12),
        sectionIds: entity.usedInSections.slice(0, 12),
        status: entity.supportStatus,
        confidence: entity.confidence,
        snippet: compactPreviewText(entity.evidence),
        fields: {
          risk: entity.risk
        }
      };
    case "citation":
      return {
        id: entity.id,
        kind: entity.kind,
        sourceId: entity.sourceId,
        sourceTitle: entity.sourceTitle || previewSourceTitle(store, entity.sourceId),
        claimIds: entity.claimIds.slice(0, 12),
        sectionIds: entity.sectionIds.slice(0, 12),
        snippet: compactPreviewText(entity.supportSnippet),
        confidence: entity.confidence ?? undefined,
        fields: {
          evidenceCellId: entity.evidenceCellId,
          relevance: entity.relevance
        }
      };
    case "protocol":
      return {
        id: entity.id,
        kind: entity.kind,
        title: entity.title,
        status: entity.author,
        snippet: compactPreviewText(entity.objective),
        fields: {
          protocolId: entity.protocolId,
          researchQuestion: entity.researchQuestion,
          evidenceTargets: entity.evidenceTargets.slice(0, 8),
          manuscriptConstraints: entity.manuscriptConstraints.slice(0, 8)
        }
      };
    case "workItem":
      return {
        id: entity.id,
        kind: entity.kind,
        title: entity.title,
        status: entity.status,
        snippet: compactPreviewText(entity.description),
        sourceIds: entity.affectedSourceIds.slice(0, 12),
        claimIds: entity.affectedClaimIds.slice(0, 12),
        fields: {
          type: entity.type,
          severity: entity.severity,
          targetKind: entity.targetKind,
          targetId: entity.targetId,
          suggestedActions: entity.suggestedActions.slice(0, 8)
        }
      };
    case "manuscriptSection":
      return {
        id: entity.id,
        kind: entity.kind,
        title: entity.title,
        status: entity.status,
        sourceIds: entity.sourceIds.slice(0, 12),
        claimIds: entity.claimIds.slice(0, 12),
        snippet: compactPreviewText(entity.markdown),
        fields: {
          sectionId: entity.sectionId,
          role: entity.role
        }
      };
    case "releaseCheck":
      return {
        id: entity.id,
        kind: entity.kind,
        title: entity.title,
        status: entity.status,
        snippet: compactPreviewText(entity.message),
        fields: {
          checkId: entity.checkId,
          severity: entity.severity
        }
      };
    case "screeningDecision":
      return {
        id: entity.id,
        kind: entity.kind,
        sourceId: entity.sourceId,
        sourceTitle: previewSourceTitle(store, entity.sourceId),
        status: entity.decision,
        snippet: compactPreviewText(entity.rationale),
        fields: {
          stage: entity.stage
        }
      };
    case "fullTextRecord":
      return {
        id: entity.id,
        kind: entity.kind,
        sourceId: entity.sourceId,
        sourceTitle: previewSourceTitle(store, entity.sourceId),
        status: entity.accessMode,
        fields: {
          format: entity.format,
          url: entity.url,
          providerId: entity.providerId,
          fulltextAvailable: entity.fulltextAvailable,
          fulltextFetched: entity.fulltextFetched,
          fulltextExtracted: entity.fulltextExtracted,
          errors: entity.errors.slice(0, 4)
        }
      };
    case "providerRun":
      return {
        id: entity.id,
        kind: entity.kind,
        title: `${entity.providerId} ${entity.phase}`,
        status: entity.error === null ? "ok" : "failed",
        snippet: entity.error ?? undefined,
        fields: {
          providerId: entity.providerId,
          phase: entity.phase,
          providerCalls: entity.providerCalls,
          rawCandidateCount: entity.rawCandidateCount,
          acceptedSourceCount: entity.acceptedSourceCount
        }
      };
  }
}

function makeAgentToolResult(input: {
  run: RunRecord;
  action: string;
  timestamp: string;
  status?: AgentToolResult["status"];
  readOnly: boolean;
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
}): AgentToolResult {
  return {
    id: `tool-result-${input.run.id}-${input.timestamp.replace(/[^0-9]/g, "")}-${input.action.replace(/[^a-z0-9]+/gi, "-")}`,
    action: input.action,
    status: input.status ?? "ok",
    readOnly: input.readOnly,
    timestamp: input.timestamp,
    message: input.message,
    ...(input.collection === undefined ? {} : { collection: input.collection }),
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.count === undefined ? {} : { count: input.count }),
    ...(input.totalCount === undefined ? {} : { totalCount: input.totalCount }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.hasMore === undefined ? {} : { hasMore: input.hasMore }),
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
    ...(input.items === undefined ? {} : { items: input.items }),
    ...(input.entity === undefined ? {} : { entity: input.entity }),
    ...(input.related === undefined ? {} : { related: input.related }),
    ...(input.stateDelta === undefined ? {} : { stateDelta: input.stateDelta }),
    ...(input.nextHints === undefined ? {} : { nextHints: input.nextHints }),
    ...(input.error === undefined ? {} : { error: input.error })
  };
}

type WorkspaceToolExecutionResult = {
  handled: boolean;
  store: ResearchWorkStore;
  message: string | null;
  result?: AgentToolResult | null;
};

function rememberAgentToolResult(results: AgentToolResult[], result: AgentToolResult | null | undefined): AgentToolResult[] {
  if (result === null || result === undefined) {
    return results;
  }

  return [...results, result].slice(-6);
}

function sourceToolStatus(observation: SourceToolObservation): AgentToolResult["status"] {
  if (/\b(failed|not available)\b/i.test(observation.message)) {
    return "failed";
  }

  if (/\b(skipped|no automatic|without automatic|will not|no fallback|requires explicit|contained no known)\b/i.test(observation.message)) {
    return "noop";
  }

  return "ok";
}

function sourceToolCount(observation: SourceToolObservation): number {
  return observation.counts.selectedPapers
    ?? observation.counts.resolvedPapers
    ?? observation.counts.candidatePapers
    ?? observation.counts.canonicalPapers
    ?? observation.counts.newSources
    ?? observation.items?.length
    ?? 0;
}

function sourceToolTotalCount(observation: SourceToolObservation): number {
  return observation.counts.rawCandidates
    ?? observation.counts.canonicalPapers
    ?? observation.counts.scholarlySources
    ?? sourceToolCount(observation);
}

function sourceToolNextHints(observation: SourceToolObservation): string[] {
  switch (observation.action) {
    case "source.search":
      return ["source.search", "source.merge", "workspace.list"];
    case "source.merge":
      return ["workspace.read", "source.resolve_access", "source.select_evidence"];
    case "source.resolve_access":
      return ["workspace.read", "source.select_evidence", "claim.create"];
    case "source.select_evidence":
      return ["workspace.read", "claim.create", "section.create"];
  }
}

function sourceToolItemsForAgent(observation: SourceToolObservation): AgentVisibleEntityPreview[] {
  return (observation.items ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    sourceIds: item.sourceIds,
    status: item.status ?? item.accessMode,
    snippet: item.snippet,
    fields: {
      providerId: item.providerId ?? null,
      locator: item.locator ?? null,
      accessMode: item.accessMode ?? null,
      year: item.year ?? null,
      venue: item.venue ?? null,
      ...(item.fields ?? {})
    }
  }));
}

function sourceToolResultFromObservation(input: {
  run: RunRecord;
  now: () => string;
  decision: ResearchActionDecision;
  observation: SourceToolObservation;
  providerId?: SourceProviderId;
}): AgentToolResult {
  const timestamp = input.now();
  const action = input.observation.action;
  const items = sourceToolItemsForAgent(input.observation);
  const providerIds = input.providerId === undefined
    ? input.decision.inputs.providerIds
    : [input.providerId];

  return makeAgentToolResult({
    run: input.run,
    action,
    timestamp,
    status: sourceToolStatus(input.observation),
    readOnly: false,
    message: input.observation.message,
    collection: action === "source.search" ? "sources" : "canonicalSources",
    query: {
      providerIds,
      searchQueries: input.decision.inputs.searchQueries,
      paperIds: input.decision.inputs.paperIds
    },
    count: sourceToolCount(input.observation),
    totalCount: sourceToolTotalCount(input.observation),
    hasMore: false,
    items,
    stateDelta: Object.fromEntries(
      Object.entries(input.observation.counts)
        .filter(([, value]) => typeof value === "number")
        .map(([key, value]) => [key, value as number])
    ),
    nextHints: sourceToolNextHints(input.observation),
    error: sourceToolStatus(input.observation) === "failed" ? input.observation.message : null
  });
}

function releaseRepairHintsForCheck(check: { id?: string; checkId?: string; message: string; title: string }): string[] {
  const text = `${check.id ?? check.checkId ?? ""} ${check.title} ${check.message}`.toLowerCase();
  if (/section/.test(text) && /claim/.test(text)) {
    return ["workspace.list", "section.link_claim", "claim.create"];
  }
  if (/section/.test(text)) {
    return ["section.create", "section.patch", "workspace.read"];
  }
  if (/claim/.test(text) && /support|citation|reference/.test(text)) {
    return ["workspace.list", "claim.link_support", "claim.check_support"];
  }
  if (/reference|citation/.test(text)) {
    return ["workspace.list", "claim.link_support", "release.verify"];
  }
  return ["workspace.read", "workspace.list", "work_item.create"];
}

function releaseRepairPreviews(checks: Array<{ id: string; title: string; severity: string; message: string }>): AgentVisibleEntityPreview[] {
  return checks.slice(0, 8).map((check) => ({
    id: `repair-${check.id}`,
    kind: "releaseRepair",
    title: check.title,
    status: check.severity,
    snippet: compactPreviewText(check.message, 260),
    fields: {
      checkId: check.id,
      suggestedActions: releaseRepairHintsForCheck(check)
    }
  }));
}

function numericTextIdPart(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "item";
}

function generatedToolEntityId(prefix: string, run: RunRecord, now: string, hint: string): string {
  return `${prefix}-${numericTextIdPart(hint)}-${run.id}-${now.replace(/[^0-9]/g, "")}`;
}

function generatedSupportLinkId(run: RunRecord, claimId: string, sourceId: string, evidenceCellId: string | null): string {
  return `citation-${numericTextIdPart(`${claimId}-${sourceId}-${evidenceCellId ?? "source"}`)}-${run.id}`;
}

function sourceTitleForSupport(store: ResearchWorkStore, sourceId: string): string {
  return previewSourceTitle(store, sourceId) ?? sourceId;
}

function sourceEquivalentIds(store: ResearchWorkStore, sourceId: string): string[] {
  const source = store.objects.canonicalSources.find((candidate) => (
    candidate.id === sourceId || createLiteratureEntityId("paper", candidate.key) === sourceId
  ));
  return source === undefined
    ? [sourceId]
    : uniqueStrings([source.id, createLiteratureEntityId("paper", source.key)]);
}

function renderableSourceIdForSupport(store: ResearchWorkStore, sourceId: string): string {
  return store.objects.canonicalSources.find((candidate) => (
    candidate.id === sourceId || createLiteratureEntityId("paper", candidate.key) === sourceId
  ))?.id ?? sourceId;
}

function evidenceCellForSourceSupport(store: ResearchWorkStore, sourceId: string): WorkStoreEvidenceCell | null {
  const equivalentIds = new Set(sourceEquivalentIds(store, sourceId));
  return store.objects.evidenceCells.find((cell) => (
    equivalentIds.has(cell.sourceId)
    && cell.field !== "confidence"
    && meaningfulSupportSnippet(cell.value) !== null
  )) ?? null;
}

function evidenceCellSupportSnippet(cell: WorkStoreEvidenceCell | null): string {
  return cell === null ? "" : compactPreviewText(cell.value, 700);
}

function meaningfulSupportSnippet(...values: unknown[]): string | null {
  for (const value of values) {
    const text = compactPreviewText(value, 700);
    if (text.length >= 20 && !/^(high|medium|low|unknown|explicit|partial|implied)$/i.test(text)) {
      return text;
    }
  }

  return null;
}

function supportLinkFromInput(input: {
  run: RunRecord;
  now: string;
  store: ResearchWorkStore;
  claimId: string;
  sourceId: string;
  evidenceCellId: string | null;
  sectionIds: string[];
  entity: Record<string, unknown>;
  fallbackSnippet: string | null;
  relation: string | null;
}): WorkStoreCitation | null {
  const claim = readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", input.claimId);
  if (claim === null) {
    return null;
  }
  const requestedEvidenceCell = input.evidenceCellId === null
    ? null
    : readResearchWorkStoreEntity<WorkStoreEvidenceCell>(input.store, "evidenceCells", input.evidenceCellId);
  if (input.evidenceCellId !== null && requestedEvidenceCell === null) {
    return null;
  }
  const evidenceCell = requestedEvidenceCell
    ?? evidenceCellForSourceSupport(input.store, input.sourceId)
    ?? null;
  if (evidenceCell === null) {
    return null;
  }
  const sourceId = renderableSourceIdForSupport(input.store, evidenceCell?.sourceId ?? input.sourceId);
  const supportSnippet = meaningfulSupportSnippet(
    input.entity.supportSnippet,
    input.entity.snippet,
    input.fallbackSnippet,
    evidenceCell?.field === "confidence" ? null : evidenceCellSupportSnippet(evidenceCell),
    claim.evidence
  ) ?? claim.evidence;

  return {
    id: stringInput(input.entity.id, generatedSupportLinkId(input.run, input.claimId, sourceId, evidenceCell?.id ?? input.evidenceCellId)),
    kind: "citation",
    runId: input.run.id,
    createdAt: input.now,
    updatedAt: input.now,
    sourceId,
    sourceTitle: sourceTitleForSupport(input.store, sourceId),
    evidenceCellId: evidenceCell?.id ?? input.evidenceCellId,
    supportSnippet,
    confidence: stringInput(input.entity.confidence, evidenceCell?.confidence ?? claim.confidence),
    relevance: stringInput(input.entity.relevance ?? input.entity.supportRelevance, input.relation ?? "supports"),
    claimIds: [input.claimId],
    sectionIds: input.sectionIds
  };
}

function repairWorkspaceCitationsFromClaimSources(input: {
  run: RunRecord;
  now: string;
  store: ResearchWorkStore;
}): { store: ResearchWorkStore; repairedCount: number } {
  const knownSourceIds = new Set(input.store.objects.canonicalSources.map((source) => source.id));
  let nextStore = input.store;
  let repairedCount = 0;

  for (const claim of input.store.objects.claims) {
    const sectionIds = input.store.objects.manuscriptSections
      .filter((section) => section.claimIds.includes(claim.id))
      .map((section) => section.id);
    if (sectionIds.length === 0) {
      continue;
    }
    for (const sourceId of claim.sourceIds.filter((candidate) => knownSourceIds.has(candidate))) {
      const alreadyLinked = nextStore.objects.citations.some((citation) => (
        citation.sourceId === sourceId && citation.claimIds.includes(claim.id)
      ));
      if (alreadyLinked) {
        continue;
      }
      const evidenceCell = evidenceCellForSourceSupport(input.store, sourceId);
      if (evidenceCell === null) {
        continue;
      }

      const citation: WorkStoreCitation = {
        id: generatedSupportLinkId(input.run, claim.id, sourceId, evidenceCell?.id ?? null),
        kind: "citation",
        runId: input.run.id,
        createdAt: input.now,
        updatedAt: input.now,
        sourceId,
        sourceTitle: sourceTitleForSupport(input.store, sourceId),
        evidenceCellId: evidenceCell?.id ?? null,
        supportSnippet: meaningfulSupportSnippet(evidenceCell?.value, claim.evidence, claim.text) ?? claim.text,
        confidence: claim.confidence,
        relevance: "recovered_from_claim_source",
        claimIds: [claim.id],
        sectionIds
      };
      nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(nextStore, citation, input.now);
      repairedCount += 1;
    }
  }

  return {
    store: nextStore,
    repairedCount
  };
}

type SupportReadinessIssue = {
  kind: "missing_section_claim" | "missing_claim" | "missing_support_link" | "missing_source" | "missing_evidence_cell" | "source_mismatch" | "weak_snippet";
  message: string;
  sectionId: string | null;
  claimId: string | null;
  citationId: string | null;
  sourceId: string | null;
  evidenceCellId: string | null;
  suggestedActions: string[];
};

type ValidSupportChain = {
  section: WorkStoreManuscriptSection | null;
  claim: WorkStoreClaim;
  citation: WorkStoreCitation;
  source: WorkStoreCanonicalSource;
  evidenceCell: WorkStoreEvidenceCell;
};

type SupportReadinessReport = {
  chains: ValidSupportChain[];
  issues: SupportReadinessIssue[];
  supportedClaimIds: Set<string>;
  unsupportedClaimIds: Set<string>;
  renderableSourceIds: Set<string>;
};

function supportIssue(input: SupportReadinessIssue): SupportReadinessIssue {
  return input;
}

function canonicalSourceForId(store: ResearchWorkStore, sourceId: string): WorkStoreCanonicalSource | null {
  return store.objects.canonicalSources.find((source) => (
    source.id === sourceId || createLiteratureEntityId("paper", source.key) === sourceId
  )) ?? null;
}

function evidenceCellMatchesSource(store: ResearchWorkStore, cell: WorkStoreEvidenceCell, source: WorkStoreCanonicalSource): boolean {
  return sourceEquivalentIds(store, source.id).includes(cell.sourceId);
}

function claimHasEquivalentSource(store: ResearchWorkStore, claim: WorkStoreClaim, source: WorkStoreCanonicalSource): boolean {
  const equivalentIds = new Set(sourceEquivalentIds(store, source.id));
  return claim.sourceIds.some((sourceId) => equivalentIds.has(sourceId));
}

function supportLinkCandidate(input: {
  store: ResearchWorkStore;
  section: WorkStoreManuscriptSection | null;
  claim: WorkStoreClaim;
  citation: WorkStoreCitation;
}): { chain: ValidSupportChain | null; issues: SupportReadinessIssue[] } {
  const issues: SupportReadinessIssue[] = [];
  const source = canonicalSourceForId(input.store, input.citation.sourceId);
  if (source === null) {
    issues.push(supportIssue({
      kind: "missing_source",
      message: `Support link ${input.citation.id} references source ${input.citation.sourceId}, but that canonical source is not available.`,
      sectionId: input.section?.id ?? null,
      claimId: input.claim.id,
      citationId: input.citation.id,
      sourceId: input.citation.sourceId,
      evidenceCellId: input.citation.evidenceCellId,
      suggestedActions: ["workspace.read", "source.search", "claim.link_support"]
    }));
    return { chain: null, issues };
  }

  if (!claimHasEquivalentSource(input.store, input.claim, source)) {
    issues.push(supportIssue({
      kind: "missing_source",
      message: `Support link ${input.citation.id} cites ${source.title}, but claim ${input.claim.id} does not list that source as support.`,
      sectionId: input.section?.id ?? null,
      claimId: input.claim.id,
      citationId: input.citation.id,
      sourceId: source.id,
      evidenceCellId: input.citation.evidenceCellId,
      suggestedActions: ["claim.link_support", "claim.patch"]
    }));
  }

  if (input.citation.evidenceCellId === null) {
    issues.push(supportIssue({
      kind: "missing_evidence_cell",
      message: `Support link ${input.citation.id} has no evidence-cell id.`,
      sectionId: input.section?.id ?? null,
      claimId: input.claim.id,
      citationId: input.citation.id,
      sourceId: source.id,
      evidenceCellId: null,
      suggestedActions: ["workspace.list", "claim.link_support"]
    }));
    return { chain: null, issues };
  }

  const evidenceCell = readResearchWorkStoreEntity<WorkStoreEvidenceCell>(input.store, "evidenceCells", input.citation.evidenceCellId);
  if (evidenceCell === null) {
    issues.push(supportIssue({
      kind: "missing_evidence_cell",
      message: `Support link ${input.citation.id} references missing evidence cell ${input.citation.evidenceCellId}.`,
      sectionId: input.section?.id ?? null,
      claimId: input.claim.id,
      citationId: input.citation.id,
      sourceId: source.id,
      evidenceCellId: input.citation.evidenceCellId,
      suggestedActions: ["workspace.list", "claim.link_support"]
    }));
    return { chain: null, issues };
  }

  if (!evidenceCellMatchesSource(input.store, evidenceCell, source)) {
    issues.push(supportIssue({
      kind: "source_mismatch",
      message: `Support link ${input.citation.id} cites ${source.title}, but evidence cell ${evidenceCell.id} belongs to source ${evidenceCell.sourceId}.`,
      sectionId: input.section?.id ?? null,
      claimId: input.claim.id,
      citationId: input.citation.id,
      sourceId: source.id,
      evidenceCellId: evidenceCell.id,
      suggestedActions: ["claim.link_support", "claim.patch"]
    }));
  }

  if (meaningfulSupportSnippet(input.citation.supportSnippet, evidenceCell.value) === null) {
    issues.push(supportIssue({
      kind: "weak_snippet",
      message: `Support link ${input.citation.id} lacks a meaningful support snippet.`,
      sectionId: input.section?.id ?? null,
      claimId: input.claim.id,
      citationId: input.citation.id,
      sourceId: source.id,
      evidenceCellId: evidenceCell.id,
      suggestedActions: ["workspace.read", "claim.link_support"]
    }));
  }

  if (issues.length > 0) {
    return { chain: null, issues };
  }

  return {
    chain: {
      section: input.section,
      claim: input.claim,
      citation: input.citation,
      source,
      evidenceCell
    },
    issues
  };
}

function supportReadinessForWorkspace(store: ResearchWorkStore): SupportReadinessReport {
  const chains: ValidSupportChain[] = [];
  const issues: SupportReadinessIssue[] = [];
  const supportedClaimIds = new Set<string>();
  const unsupportedClaimIds = new Set<string>();
  const renderableSourceIds = new Set<string>();
  const sections = store.objects.manuscriptSections;
  const sectionClaims = sections.flatMap((section) => {
    if (section.claimIds.length === 0) {
      issues.push(supportIssue({
        kind: "missing_section_claim",
        message: `Section ${section.id} has no claim ids attached.`,
        sectionId: section.id,
        claimId: null,
        citationId: null,
        sourceId: null,
        evidenceCellId: null,
        suggestedActions: ["section.link_claim", "claim.create"]
      }));
    }
    return section.claimIds.map((claimId) => ({ section, claimId }));
  });
  const claimTargets = sectionClaims.length > 0
    ? sectionClaims
    : store.objects.claims.map((claim) => ({ section: null, claimId: claim.id }));

  for (const target of claimTargets) {
    const claim = readResearchWorkStoreEntity<WorkStoreClaim>(store, "claims", target.claimId);
    if (claim === null) {
      issues.push(supportIssue({
        kind: "missing_claim",
        message: `Section ${target.section?.id ?? "workspace"} references missing claim ${target.claimId}.`,
        sectionId: target.section?.id ?? null,
        claimId: target.claimId,
        citationId: null,
        sourceId: null,
        evidenceCellId: null,
        suggestedActions: ["section.patch", "claim.create"]
      }));
      unsupportedClaimIds.add(target.claimId);
      continue;
    }

    const citations = store.objects.citations.filter((citation) => citation.claimIds.includes(claim.id));
    if (citations.length === 0) {
      issues.push(supportIssue({
        kind: "missing_support_link",
        message: `Claim ${claim.id} is used in manuscript state but has no support link/citation.`,
        sectionId: target.section?.id ?? null,
        claimId: claim.id,
        citationId: null,
        sourceId: null,
        evidenceCellId: null,
        suggestedActions: ["workspace.list", "claim.link_support"]
      }));
      unsupportedClaimIds.add(claim.id);
      continue;
    }

    const validChainsForClaim = citations.flatMap((citation) => {
      const result = supportLinkCandidate({
        store,
        section: target.section,
        claim,
        citation
      });
      issues.push(...result.issues);
      return result.chain === null ? [] : [result.chain];
    });

    if (validChainsForClaim.length === 0) {
      unsupportedClaimIds.add(claim.id);
      continue;
    }

    for (const chain of validChainsForClaim) {
      chains.push(chain);
      supportedClaimIds.add(claim.id);
      renderableSourceIds.add(chain.source.id);
    }
  }

  return {
    chains,
    issues,
    supportedClaimIds,
    unsupportedClaimIds,
    renderableSourceIds
  };
}

function agentWorkItemFromCreateInput(input: {
  run: RunRecord;
  now: string;
  entity: Record<string, unknown>;
  decision: ResearchActionDecision;
}): WorkStoreWorkItem {
  return {
    id: stringInput(input.entity.id, `agent-work-item-${input.run.id}-${input.now.replace(/[^0-9]/g, "")}`),
    kind: "workItem",
    runId: input.run.id,
    createdAt: input.now,
    updatedAt: input.now,
    type: stringInput(input.entity.type, "agent_next_action") as WorkStoreWorkItem["type"],
    status: stringInput(input.entity.status, "open") as WorkStoreWorkItem["status"],
    severity: stringInput(input.entity.severity, "minor") as WorkStoreWorkItem["severity"],
    title: stringInput(input.entity.title, input.decision.rationale.slice(0, 120) || "Agent-created work item"),
    description: stringInput(input.entity.description, input.decision.expectedOutcome),
    targetKind: stringInput(input.entity.targetKind, "unknown") as WorkStoreWorkItem["targetKind"],
    targetId: typeof input.entity.targetId === "string" ? input.entity.targetId : null,
    affectedSourceIds: stringArrayInput(input.entity.affectedSourceIds),
    affectedClaimIds: stringArrayInput(input.entity.affectedClaimIds),
    suggestedActions: stringArrayInput(input.entity.suggestedActions, 20),
    source: "runtime"
  };
}

function protocolFromToolInput(input: {
  run: RunRecord;
  now: string;
  decision: ResearchActionDecision;
}): WorkStoreProtocol {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const protocolPayload = objectInput(entity.protocol) ?? objectInput(entity.body) ?? objectInput(entity.payload);
  const title = stringInput(entity.title, "Research protocol");
  const objective = stringInput(
    entity.objective,
    stringInput(protocolPayload?.objective, input.decision.inputs.reason ?? input.decision.rationale)
  );
  const researchQuestion = typeof entity.researchQuestion === "string"
    ? entity.researchQuestion
    : typeof protocolPayload?.researchQuestion === "string" ? protocolPayload.researchQuestion : input.run.brief.researchQuestion;

  return {
    id: stringInput(entity.id, generatedToolEntityId("protocol", input.run, input.now, objective)),
    kind: "protocol",
    runId: input.run.id,
    createdAt: input.now,
    updatedAt: input.now,
    protocolId: stringInput(entity.protocolId, "current-protocol"),
    title,
    objective,
    researchQuestion,
    scope: stringArrayInput(entity.scope ?? protocolPayload?.scope, 20),
    inclusionCriteria: stringArrayInput(entity.inclusionCriteria ?? protocolPayload?.inclusionCriteria, 30),
    exclusionCriteria: stringArrayInput(entity.exclusionCriteria ?? protocolPayload?.exclusionCriteria, 30),
    evidenceTargets: stringArrayInput(entity.evidenceTargets ?? protocolPayload?.evidenceTargets, 30),
    manuscriptConstraints: stringArrayInput(entity.manuscriptConstraints ?? protocolPayload?.manuscriptConstraints, 30),
    notes: stringArrayInput(entity.notes ?? protocolPayload?.notes, 30),
    protocol: protocolPayload,
    author: "researcher"
  };
}

const evidenceCellFields: WorkStoreEvidenceCell["field"][] = [
  "problemSetting",
  "systemType",
  "architecture",
  "toolsAndMemory",
  "planningStyle",
  "evaluationSetup",
  "successSignals",
  "failureModes",
  "limitations",
  "confidence"
];

function safeEvidenceCellField(value: unknown): WorkStoreEvidenceCell["field"] {
  return typeof value === "string" && evidenceCellFields.includes(value as WorkStoreEvidenceCell["field"])
    ? value as WorkStoreEvidenceCell["field"]
    : "successSignals";
}

function safeCriticReviewScope(value: unknown): CriticReviewScope {
  return value === "protocol"
    || value === "sources"
    || value === "evidence"
    || value === "release"
    ? value
    : "release";
}

function safeManuscriptReadiness(value: unknown): ManuscriptReadinessState | null {
  return value === "not_started"
    || value === "drafted"
    || value === "needs_more_evidence"
    || value === "needs_human_review"
    || value === "ready_for_revision"
    || value === "blocked"
    ? value
    : null;
}

function safePaperExtractionConfidence(value: unknown): PaperExtractionConfidence {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : "medium";
}

function safePaperClaimSupportStrength(value: unknown): PaperClaimSupportStrength {
  return value === "explicit" || value === "partial" || value === "implied"
    ? value
    : "partial";
}

function knownSourceFromToolInput(input: {
  store: ResearchWorkStore;
  decision: ResearchActionDecision;
  entity: Record<string, unknown>;
}): WorkStoreCanonicalSource | null {
  const candidateIds = uniqueStrings([
    stringInput(input.entity.sourceId, ""),
    stringInput(input.entity.paperId, ""),
    ...input.decision.inputs.paperIds,
    ...stringArrayInput(input.entity.sourceIds, 20)
  ]);

  for (const sourceId of candidateIds) {
    const source = canonicalSourceForId(input.store, sourceId);
    if (source !== null) {
      return source;
    }
  }

  return null;
}

function supportedClaimsFromToolInput(value: unknown, decision: ResearchActionDecision): PaperExtraction["supportedClaims"] {
  if (!Array.isArray(value)) {
    const targets = decision.inputs.evidenceTargets.length > 0
      ? decision.inputs.evidenceTargets
      : [decision.expectedOutcome];
    return targets
      .map((claim) => compactPreviewText(claim, 260))
      .filter((claim) => claim.length > 0)
      .slice(0, 12)
      .map((claim) => ({ claim, support: "partial" }));
  }

  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const claim = compactPreviewText(entry, 260);
      return claim.length === 0 ? [] : [{ claim, support: "partial" as const }];
    }
    const record = objectInput(entry);
    if (record === null) {
      return [];
    }
    const claim = stringInput(record.claim ?? record.text, "");
    return claim.length === 0
      ? []
      : [{
        claim: compactPreviewText(claim, 260),
        support: safePaperClaimSupportStrength(record.support)
      }];
  }).slice(0, 20);
}

function paperExtractionFromToolInput(input: {
  run: RunRecord;
  now: string;
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
}): { extraction: WorkStoreEntity; source: WorkStoreCanonicalSource } | null {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const source = knownSourceFromToolInput({
    store: input.store,
    decision: input.decision,
    entity
  });
  if (source === null) {
    return null;
  }

  const problemSetting = stringInput(entity.problemSetting ?? entity.problem, input.decision.expectedOutcome);
  const paperExtraction: PaperExtraction = {
    id: stringInput(entity.id ?? entity.extractionId, generatedToolEntityId("extraction", input.run, input.now, source.id)),
    paperId: source.id,
    runId: input.run.id,
    problemSetting,
    systemType: stringInput(entity.systemType, "model-authored extraction"),
    architecture: stringInput(entity.architecture, ""),
    toolsAndMemory: stringInput(entity.toolsAndMemory, ""),
    planningStyle: stringInput(entity.planningStyle, ""),
    evaluationSetup: stringInput(entity.evaluationSetup, ""),
    successSignals: stringArrayInput(entity.successSignals ?? entity.findings, 40),
    failureModes: stringArrayInput(entity.failureModes, 40),
    limitations: stringArrayInput(entity.limitations, 40),
    supportedClaims: supportedClaimsFromToolInput(entity.supportedClaims ?? entity.claims, input.decision),
    confidence: safePaperExtractionConfidence(entity.confidence),
    evidenceNotes: stringArrayInput(entity.evidenceNotes ?? entity.notes, 40)
  };

  return {
    source,
    extraction: {
      id: paperExtraction.id,
      kind: "extraction",
      runId: input.run.id,
      createdAt: input.now,
      updatedAt: input.now,
      sourceId: source.id,
      extraction: paperExtraction
    }
  };
}

function claimFromToolInput(input: {
  run: RunRecord;
  now: string;
  decision: ResearchActionDecision;
}): WorkStoreClaim {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const text = stringInput(entity.text, input.decision.inputs.reason ?? input.decision.rationale);
  const sourceIds = uniqueStrings([
    ...input.decision.inputs.paperIds,
    ...stringArrayInput(entity.sourceIds, 20)
  ]);

  return {
    id: stringInput(entity.id, generatedToolEntityId("claim", input.run, input.now, text)),
    kind: "claim",
    runId: input.run.id,
    createdAt: input.now,
    updatedAt: input.now,
    text,
    evidence: stringInput(entity.evidence, input.decision.expectedOutcome),
    sourceIds,
    supportStatus: sourceIds.length > 0 ? "unchecked" : "weak",
    confidence: stringInput(entity.confidence, sourceIds.length > 0 ? "medium" : "low"),
    usedInSections: stringArrayInput(entity.usedInSections, 20),
    risk: typeof entity.risk === "string" ? entity.risk : null
  };
}

function evidenceCellFromToolInput(input: {
  run: RunRecord;
  now: string;
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
}): WorkStoreEvidenceCell | null {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const source = knownSourceFromToolInput({
    store: input.store,
    decision: input.decision,
    entity
  });
  if (source === null) {
    return null;
  }
  const requestedExtractionId = stringInput(entity.extractionId, "");
  const extraction = requestedExtractionId.length > 0
    ? readResearchWorkStoreEntity(input.store, "extractions", requestedExtractionId)
    : input.store.objects.extractions.find((candidate) => sourceEquivalentIds(input.store, source.id).includes(candidate.sourceId)) ?? null;
  if (extraction === null) {
    return null;
  }
  const field = safeEvidenceCellField(entity.field);
  const value = Array.isArray(entity.value)
    ? stringArrayInput(entity.value, 40)
    : stringInput(entity.value, input.decision.inputs.evidenceTargets.join("; ") || input.decision.expectedOutcome);

  return {
    id: stringInput(entity.id, generatedToolEntityId("evidence-cell", input.run, input.now, `${source.id}-${field}`)),
    kind: "evidenceCell",
    runId: input.run.id,
    createdAt: input.now,
    updatedAt: input.now,
    sourceId: source.id,
    extractionId: extraction.id,
    field,
    value,
    confidence: stringInput(entity.confidence, "medium")
  };
}

function manuscriptSectionFromToolInput(input: {
  run: RunRecord;
  now: string;
  decision: ResearchActionDecision;
  existing?: WorkStoreManuscriptSection | null;
}): WorkStoreManuscriptSection {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const changes = input.decision.inputs.workStore?.changes ?? {};
  const sectionId = stringInput(
    entity.sectionId ?? changes.sectionId,
    input.existing?.sectionId ?? stringInput(input.decision.inputs.workStore?.entityId, "discussion")
  );
  const paragraph = stringInput(
    entity.paragraph ?? entity.markdown ?? changes.paragraph ?? changes.markdown,
    input.decision.inputs.reason ?? input.decision.expectedOutcome
  );
  const markdown = paragraph;

  return {
    id: input.existing?.id ?? stringInput(entity.id, generatedToolEntityId("section", input.run, input.now, sectionId)),
    kind: "manuscriptSection",
    runId: input.run.id,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
    sectionId,
    role: stringInput(entity.role ?? changes.role, input.existing?.role ?? "synthesis"),
    title: stringInput(entity.title ?? changes.title, input.existing?.title ?? sectionId.replace(/[-_]+/g, " ")),
    markdown,
    sourceIds: uniqueStrings([
      ...(input.existing?.sourceIds ?? []),
      ...input.decision.inputs.paperIds,
      ...stringArrayInput(entity.sourceIds ?? changes.sourceIds, 40)
    ]),
    claimIds: uniqueStrings([
      ...(input.existing?.claimIds ?? []),
      ...stringArrayInput(entity.claimIds ?? changes.claimIds, 40)
    ]),
    status: "needs_revision"
  };
}

function criticReviewArtifactPath(run: RunRecord, stage: CriticReviewScope): string {
  switch (stage) {
    case "protocol":
      return run.artifacts.criticProtocolReviewPath;
    case "sources":
      return run.artifacts.criticSourceSelectionPath;
    case "evidence":
      return run.artifacts.criticEvidenceReviewPath;
    case "release":
      return run.artifacts.criticReleaseReviewPath;
  }
}

function guidancePreviewForAgent(item: {
  id: string;
  kind: string;
  title: string;
  summary: string;
  tags: string[];
}): AgentVisibleEntityPreview {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    snippet: compactPreviewText(item.summary, 260),
    fields: {
      tags: item.tags.slice(0, 10),
      advisory: true,
      overridable: true,
      notAReleaseGate: true
    }
  };
}

async function executeGuidanceToolAction(input: {
  run: RunRecord;
  now: () => string;
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
}): Promise<WorkspaceToolExecutionResult> {
  if (!isGuidanceToolAction(input.decision.action)) {
    return {
      handled: false,
      store: input.store,
      message: null
    };
  }

  const args = input.decision.inputs.workStore ?? defaultWorkStoreArgs();
  const timestamp = input.now();

  if (input.decision.action === "guidance.read") {
    const guidanceId = args.entityId ?? stringInput(args.entity.id, input.decision.inputs.paperIds[0] ?? "");
    const guidance = readResearchGuidance(guidanceId);
    const message = guidance === null
      ? `Guidance read found no advisory object ${guidanceId || "(missing id)"}.`
      : `Guidance read ${guidance.title}.`;
    return {
      handled: true,
      store: input.store,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp,
        status: guidance === null ? "noop" : "ok",
        readOnly: true,
        message,
        collection: "guidance",
        query: { entityId: guidanceId },
        count: guidance === null ? 0 : 1,
        totalCount: guidance === null ? 0 : 1,
        entity: guidance === null
          ? null
          : {
            ...guidancePreviewForAgent(guidance),
            snippet: compactPreviewText(guidance.body, 900)
          },
        nextHints: guidance === null
          ? ["guidance.search", "guidance.recommend"]
          : ["workspace.search", "source.search", "claim.create", "section.patch"]
      })
    };
  }

  const query = input.decision.action === "guidance.recommend"
    ? null
    : args.semanticQuery ?? input.decision.inputs.searchQueries.join(" ") ?? input.decision.inputs.reason;
  const result = input.decision.action === "guidance.recommend"
    ? recommendResearchGuidance({ brief: input.run.brief, limit: args.limit ?? 6 })
    : searchResearchGuidance(query, args.limit ?? 6);
  const message = input.decision.action === "guidance.recommend"
    ? `Guidance recommend returned ${result.count} advisory object(s).`
    : `Guidance search returned ${result.count} advisory object(s).`;
  return {
    handled: true,
    store: input.store,
    message,
    result: makeAgentToolResult({
      run: input.run,
      action: input.decision.action,
      timestamp,
      readOnly: true,
      message,
      collection: "guidance",
      query: {
        query: result.query,
        advisory: true,
        overridable: true,
        notAReleaseGate: true
      },
      count: result.count,
      totalCount: result.count,
      items: result.items.map(guidancePreviewForAgent),
      nextHints: ["guidance.read", "workspace.search", "source.search", "claim.create"]
    })
  };
}

async function executeWorkStoreToolAction(input: {
  run: RunRecord;
  now: () => string;
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
}): Promise<WorkspaceToolExecutionResult> {
  if (!isWorkStoreToolAction(input.decision.action)) {
    return {
      handled: false,
      store: input.store,
      message: null
    };
  }

  const args = input.decision.inputs.workStore ?? defaultWorkStoreArgs();
  const collection = safeWorkStoreCollection(args.collection);

  if (input.decision.action === "workspace.search" || input.decision.action === "workspace.list") {
    const queryCollection = collection ?? "workItems";
    const timestamp = input.now();
    const result = queryResearchWorkStore(input.store, {
      collection: queryCollection,
      filters: args.filters,
      semanticQuery: input.decision.action === "workspace.list" ? null : args.semanticQuery,
      limit: args.limit ?? 12,
      cursor: args.cursor ?? null
    });
    const message = `Workspace ${input.decision.action === "workspace.list" ? "list" : "search"} ${queryCollection} returned ${result.count}/${result.totalCount} item(s).${result.hasMore ? ` More available with cursor ${result.nextCursor}.` : ""}`;
    return {
      handled: true,
      store: input.store,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp,
        readOnly: true,
        message,
        collection: queryCollection,
        query: {
          filters: args.filters,
          semanticQuery: input.decision.action === "workspace.list" ? null : args.semanticQuery,
          limit: args.limit ?? 12,
          cursor: args.cursor ?? null
        },
        count: result.count,
        totalCount: result.totalCount,
        cursor: result.cursor,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        items: result.items.map((entity) => entityPreviewForAgent(entity, input.store)),
        nextHints: queryCollection === "extractions" || queryCollection === "evidenceCells"
          ? ["claim.create", "workspace.read", "workspace.search"]
          : ["workspace.read", "workspace.search"]
      })
    };
  }

  if (input.decision.action === "workspace.read") {
    const timestamp = input.now();
    if (collection === null || args.entityId === null) {
      const message = "Workspace read skipped because collection or entityId was missing.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp,
          status: "noop",
          readOnly: true,
          message,
          collection,
          nextHints: ["workspace.list", "workspace.search"]
        })
      };
    }

    const entity = readResearchWorkStoreEntity(input.store, collection, args.entityId);
    const message = entity === null
      ? `Workspace read found no ${collection} entity ${args.entityId}.`
      : `Workspace read loaded ${collection} entity ${args.entityId}.`;
    return {
      handled: true,
      store: input.store,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp,
        status: entity === null ? "noop" : "ok",
        readOnly: true,
        message,
        collection,
        query: {
          entityId: args.entityId
        },
        count: entity === null ? 0 : 1,
        totalCount: entity === null ? 0 : 1,
        entity: entity === null ? null : entityPreviewForAgent(entity, input.store),
        nextHints: entity === null ? ["workspace.list", "workspace.search"] : ["claim.create", "section.create", "workspace.link"]
      })
    };
  }

  if (input.decision.action === "workspace.patch") {
    const timestamp = input.now();
    if (collection === null || args.entityId === null || Object.keys(args.changes).length === 0) {
      const message = "Workspace patch skipped because collection, entityId, or changes were missing.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp,
          status: "noop",
          readOnly: false,
          message,
          collection,
          nextHints: ["workspace.list", "workspace.read"]
        })
      };
    }

    const existing = readResearchWorkStoreEntity(input.store, collection, args.entityId);
    if (existing === null) {
      const message = `Workspace patch found no ${collection} entity ${args.entityId}.`;
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp,
          status: "noop",
          readOnly: false,
          message,
          collection,
          query: { entityId: args.entityId },
          nextHints: ["workspace.list", "workspace.search"]
        })
      };
    }

    const nextStore = patchResearchWorkStoreEntity(input.store, {
      collection,
      id: args.entityId,
      changes: args.changes
    }, timestamp);
    await writeResearchWorkStore(nextStore);
    const patched = readResearchWorkStoreEntity(nextStore, collection, args.entityId);
    const message = `Workspace patched ${collection} entity ${args.entityId}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp,
        readOnly: false,
        message,
        collection,
        query: { entityId: args.entityId },
        count: patched === null ? 0 : 1,
        totalCount: nextStore.objects[collection].length,
        entity: patched === null ? null : entityPreviewForAgent(patched, nextStore),
        stateDelta: { workspaceEntitiesPatched: 1 },
        nextHints: ["workspace.read", "workspace.status"]
      })
    };
  }

  if (input.decision.action === "workspace.link" || input.decision.action === "workspace.unlink") {
    const link = args.link ?? defaultWorkStoreArgs().link;
    const unlink = input.decision.action === "workspace.unlink";
    const nowText = input.now();
    if (link?.fromCollection === "claims" && link.fromId !== null && link.toId !== null) {
      const claim = readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", link.fromId);
      if (claim === null) {
        const message = `Workspace link found no claim ${link.fromId}.`;
        return {
          handled: true,
          store: input.store,
          message,
          result: makeAgentToolResult({
            run: input.run,
            action: input.decision.action,
            timestamp: nowText,
            status: "noop",
            readOnly: false,
            message,
            collection: "claims",
            query: { entityId: link.fromId },
            nextHints: ["workspace.search", "claim.create"]
          })
        };
      }
      const linkedEvidenceCell = link.toCollection === "evidenceCells"
        ? readResearchWorkStoreEntity<WorkStoreEvidenceCell>(input.store, "evidenceCells", link.toId)
        : null;
      const sourceId = linkedEvidenceCell?.sourceId ?? link.toId;
      const evidenceCellId = linkedEvidenceCell?.id ?? null;
      let nextStore = input.store;
      if (unlink) {
        nextStore = patchResearchWorkStoreEntity(nextStore, {
          collection: "claims",
          id: claim.id,
          changes: {
            sourceIds: claim.sourceIds.filter((claimSourceId) => claimSourceId !== sourceId)
          }
        }, nowText);
      } else {
        const citation = supportLinkFromInput({
          run: input.run,
          now: nowText,
          store: input.store,
          claimId: claim.id,
          sourceId,
          evidenceCellId,
          sectionIds: [],
          entity: args.entity,
          fallbackSnippet: link.snippet,
          relation: link.relation
        });
        if (citation !== null) {
          nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(nextStore, citation, nowText);
        }
        nextStore = patchResearchWorkStoreEntity(nextStore, {
          collection: "claims",
          id: claim.id,
          changes: {
            sourceIds: uniqueStrings([...claim.sourceIds, sourceId])
          }
        }, nowText);
        const supportReadiness = supportReadinessForWorkspace(nextStore);
        const supported = supportReadiness.supportedClaimIds.has(claim.id);
        const claimIssues = supportReadiness.issues.filter((issue) => issue.claimId === claim.id);
        nextStore = patchResearchWorkStoreEntity(nextStore, {
          collection: "claims",
          id: claim.id,
          changes: {
            supportStatus: supported ? "supported" : claim.supportStatus,
            risk: supported ? null : claimIssues[0]?.message ?? claim.risk
          }
        }, nowText);
      }
      await writeResearchWorkStore(nextStore);
      const updatedClaim = readResearchWorkStoreEntity<WorkStoreClaim>(nextStore, "claims", claim.id);
      const message = `Workspace ${unlink ? "unlinked" : "linked"} claim ${claim.id} ${unlink ? "from" : "to"} source ${sourceId}.`;
      return {
        handled: true,
        store: nextStore,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          readOnly: false,
          message,
          collection: "claims",
          query: {
            fromId: claim.id,
            toId: sourceId,
            relation: link.relation
          },
          count: updatedClaim === null ? 0 : 1,
          totalCount: nextStore.objects.claims.length,
          entity: updatedClaim === null ? null : entityPreviewForAgent(updatedClaim, nextStore),
          related: nextStore.objects.citations
            .filter((citation) => citation.claimIds.includes(claim.id))
            .slice(-4)
            .map((citation) => entityPreviewForAgent(citation, nextStore)),
          stateDelta: { supportLinksChanged: unlink ? -1 : 1 },
          nextHints: ["claim.check_support", "section.link_claim", "release.verify"]
        })
      };
    }

    const message = "Workspace link skipped because the requested relation is not a supported primitive yet.";
    return {
      handled: true,
      store: input.store,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        status: "noop",
        readOnly: false,
        message,
        collection,
        nextHints: ["claim.link_support", "workspace.read"]
      })
    };
  }

  const requestedKind = safeWorkStoreEntityKind(args.entity.kind);
  if (requestedKind !== null && requestedKind !== "workItem") {
    return {
      handled: true,
      store: input.store,
      message: `Workspace create for ${requestedKind} is handled by its domain tool; no generic entity was created.`
    };
  }

  const nowText = input.now();
  const workItem = agentWorkItemFromCreateInput({
    run: input.run,
    now: nowText,
    entity: args.entity,
    decision: input.decision
  });
  const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, workItem, nowText);
  await writeResearchWorkStore(nextStore);
  const message = `Workspace created work item ${workItem.id}.`;
  return {
    handled: true,
    store: nextStore,
    message,
    result: makeAgentToolResult({
      run: input.run,
      action: input.decision.action,
      timestamp: nowText,
      readOnly: false,
      message,
      collection: "workItems",
      count: 1,
      totalCount: nextStore.objects.workItems.length,
      entity: entityPreviewForAgent(workItem, nextStore),
      stateDelta: { workItemsCreated: 1 },
      nextHints: ["workspace.read", "work_item.patch", "workspace.status"]
    })
  };
}

async function executeResearchObjectToolAction(input: {
  run: RunRecord;
  now: () => string;
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
}): Promise<WorkspaceToolExecutionResult> {
  if (!isResearchObjectToolAction(input.decision.action)) {
    return {
      handled: false,
      store: input.store,
      message: null
    };
  }

  const args = input.decision.inputs.workStore ?? defaultWorkStoreArgs();
  const nowText = input.now();

  if (input.decision.action === "protocol.create_or_revise") {
    const protocol = protocolFromToolInput({
      run: input.run,
      now: nowText,
      decision: input.decision
    });
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, protocol, nowText);
    await writeResearchWorkStore(nextStore);
    const message = `Researcher-authored protocol ${protocol.id} persisted in the workspace.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "protocols",
        count: 1,
        totalCount: nextStore.objects.protocols.length,
        entity: entityPreviewForAgent(protocol, nextStore),
        stateDelta: { protocolsCreated: 1 },
        nextHints: ["workspace.read", "source.search", "guidance.read"]
      })
    };
  }

  if (input.decision.action === "critic.review") {
    const stage = safeCriticReviewScope(args.entity.stage ?? input.decision.inputs.criticScope);
    const rawReview = objectInput(args.entity.review)
      ?? objectInput(args.entity.criticReview)
      ?? (
        "readiness" in args.entity || "objections" in args.entity || "recoveryAdvice" in args.entity || "revisionAdvice" in args.entity
          ? args.entity
          : null
      );
    if (rawReview === null) {
      const message = "Critic review was not run because no critic review payload was provided and no critic backend transport is wired for this explicit tool yet.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "noop",
          readOnly: false,
          message,
          collection: "workItems",
          count: 0,
          totalCount: input.store.objects.workItems.length,
          nextHints: ["work_item.create", "workspace.read", "check.run"]
        })
      };
    }

    const references = referencesFromWorkStore(input.run, input.store);
    const checks = workspaceManuscriptChecks({ run: input.run, store: input.store, references });
    const paper = workspacePaperArtifact({
      run: input.run,
      store: input.store,
      references,
      readinessStatus: checks.readinessStatus
    });
    const review = normalizeCriticReview(rawReview, {
      projectRoot: input.run.projectRoot,
      runId: input.run.id,
      stage,
      brief: input.run.brief,
      selectedPapers: [],
      relevanceAssessments: input.store.objects.canonicalSources.map((source) => ({
        paperId: source.id,
        title: source.title,
        status: "in_scope",
        sourceRole: "background",
        selectionDecision: "selected_supporting",
        selectionReason: "Source is visible in the canonical workspace.",
        criticConcerns: [],
        requiredForManuscript: false,
        reviewer: "advisory_protocol_review",
        matchedCriteria: [],
        missingCriteria: [],
        reason: "Workspace source made visible to explicit critic.review."
      })),
      paper,
      references,
      manuscriptChecks: checks
    });
    const workItems = workItemsFromCriticReports(input.run, [review], nowText);
    const nextStore = upsertResearchWorkStoreEntities(input.store, workItems, nowText);
    await writeResearchWorkStore(nextStore);
    await writeJsonArtifact(criticReviewArtifactPath(input.run, stage), review);
    const message = `Critic review ${stage} persisted ${workItems.length} work item(s); readiness ${review.readiness}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "workItems",
        count: workItems.length,
        totalCount: nextStore.objects.workItems.length,
        items: workItems.map((item) => entityPreviewForAgent(item, nextStore)),
        stateDelta: {
          criticWorkItemsCreated: workItems.length
        },
        nextHints: review.readiness === "pass"
          ? ["release.verify", "workspace.status"]
          : ["workspace.read", "work_item.patch", "claim.patch", "source.search"]
      })
    };
  }

  if (input.decision.action === "work_item.create") {
    const workItem = agentWorkItemFromCreateInput({
      run: input.run,
      now: nowText,
      entity: args.entity,
      decision: input.decision
    });
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, workItem, nowText);
    await writeResearchWorkStore(nextStore);
    const message = `Critic work item created ${workItem.id}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "workItems",
        count: 1,
        totalCount: nextStore.objects.workItems.length,
        entity: entityPreviewForAgent(workItem, nextStore),
        stateDelta: { workItemsCreated: 1 },
        nextHints: ["workspace.read", "work_item.patch", "workspace.status"]
      })
    };
  }

  if (input.decision.action === "work_item.patch") {
    const workItemId = args.entityId ?? input.decision.inputs.paperIds[0] ?? null;
    if (workItemId === null) {
      const message = "Critic work item resolution skipped because no work item id was provided.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "noop",
          readOnly: false,
          message,
          collection: "workItems",
          nextHints: ["workspace.list", "workspace.search"]
        })
      };
    }
    const nextStore = patchResearchWorkStoreEntity(input.store, {
      collection: "workItems",
      id: workItemId,
      changes: Object.keys(args.changes).length > 0 ? args.changes : {
        status: "resolved"
      }
    }, nowText);
    await writeResearchWorkStore(nextStore);
    const updatedWorkItem = readResearchWorkStoreEntity<WorkStoreWorkItem>(nextStore, "workItems", workItemId);
    const message = `Critic work item resolved ${workItemId}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "workItems",
        query: { entityId: workItemId },
        count: updatedWorkItem === null ? 0 : 1,
        totalCount: nextStore.objects.workItems.length,
        entity: updatedWorkItem === null ? null : entityPreviewForAgent(updatedWorkItem, nextStore),
        stateDelta: { workItemsPatched: 1 },
        nextHints: ["workspace.status", "release.verify", "workspace.list"]
      })
    };
  }

  if (input.decision.action === "claim.create") {
    const claim = claimFromToolInput({
      run: input.run,
      now: nowText,
      decision: input.decision
    });
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, claim, nowText);
    await writeResearchWorkStore(nextStore);
    const message = `Claim created ${claim.id}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "claims",
        count: 1,
        totalCount: nextStore.objects.claims.length,
        entity: entityPreviewForAgent(claim, nextStore),
        stateDelta: { claimsCreated: 1 },
        nextHints: ["claim.link_support", "section.link_claim", "workspace.read"]
      })
    };
  }

  if (input.decision.action === "claim.patch") {
    const claimId = args.entityId;
    if (claimId === null) {
      const message = "Claim patch skipped because no claim id was provided.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "noop",
          readOnly: false,
          message,
          collection: "claims",
          nextHints: ["workspace.list", "workspace.search"]
        })
      };
    }
    const nextStore = patchResearchWorkStoreEntity(input.store, {
      collection: "claims",
      id: claimId,
      changes: args.changes
    }, nowText);
    await writeResearchWorkStore(nextStore);
    const updatedClaim = readResearchWorkStoreEntity<WorkStoreClaim>(nextStore, "claims", claimId);
    const message = `Claim patched ${claimId}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "claims",
        query: { entityId: claimId },
        count: updatedClaim === null ? 0 : 1,
        totalCount: nextStore.objects.claims.length,
        entity: updatedClaim === null ? null : entityPreviewForAgent(updatedClaim, nextStore),
        stateDelta: { claimsPatched: 1 },
        nextHints: ["claim.check_support", "section.patch", "release.verify"]
      })
    };
  }

  if (input.decision.action === "claim.check_support") {
    const claimId = args.entityId;
    const claim = claimId === null ? null : readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", claimId);
    if (claim === null) {
      const message = "Claim support check skipped because the claim was not found.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "noop",
          readOnly: false,
          message,
          collection: "claims",
          query: { entityId: claimId },
          nextHints: ["workspace.list", "claim.create"]
        })
      };
    }
    const supportReadiness = supportReadinessForWorkspace(input.store);
    const supported = supportReadiness.supportedClaimIds.has(claim.id);
    const claimIssues = supportReadiness.issues.filter((issue) => issue.claimId === claim.id);
    const nextStore = patchResearchWorkStoreEntity(input.store, {
      collection: "claims",
      id: claim.id,
      changes: {
        supportStatus: supported ? "supported" : "weak",
        confidence: supported ? claim.confidence : "low",
        risk: supported ? null : claimIssues[0]?.message ?? "No durable evidence-backed support link currently supports this claim."
      }
    }, nowText);
    await writeResearchWorkStore(nextStore);
    const updatedClaim = readResearchWorkStoreEntity<WorkStoreClaim>(nextStore, "claims", claim.id);
    const message = `Claim support checked ${claim.id}: ${supported ? "supported" : "weak"}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        status: supported ? "ok" : "blocked",
        readOnly: false,
        message,
        collection: "claims",
        query: { entityId: claim.id },
        count: 1,
        totalCount: nextStore.objects.claims.length,
        entity: updatedClaim === null ? null : entityPreviewForAgent(updatedClaim, nextStore),
        related: claimIssues.slice(0, 6).map((issue) => ({
          id: `${issue.kind}-${issue.claimId ?? "claim"}`,
          kind: `supportIssue:${issue.kind}`,
          text: issue.message,
          sourceId: issue.sourceId ?? undefined,
          claimIds: issue.claimId === null ? [] : [issue.claimId],
          fields: {
            suggestedActions: issue.suggestedActions
          }
        })),
        stateDelta: { claimsChecked: 1 },
        nextHints: supported ? ["section.link_claim", "release.verify"] : ["workspace.list", "claim.link_support"]
      })
    };
  }

  if (input.decision.action === "claim.link_support") {
    const claimId = args.entityId;
    const evidenceCellId = stringInput(args.entity.evidenceCellId, stringArrayInput(args.entity.evidenceCellIds, 1)[0] ?? "");
    const evidenceCell = evidenceCellId.length === 0
      ? null
      : readResearchWorkStoreEntity<WorkStoreEvidenceCell>(input.store, "evidenceCells", evidenceCellId);
    const sourceIds = uniqueStrings([
      ...input.decision.inputs.paperIds,
      ...stringArrayInput(args.entity.sourceIds, 20),
      evidenceCell?.sourceId ?? null
    ]);
    const sourceId = stringInput(args.entity.sourceId, sourceIds[0] ?? "");
    if (claimId === null || sourceId.length === 0) {
      const message = "Claim support link skipped because claim id or source id was missing.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "noop",
          readOnly: false,
          message,
          collection: "citations",
          nextHints: ["workspace.list", "workspace.read", "claim.create"]
        })
      };
    }
    const claim = readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", claimId);
    if (claim === null) {
      const message = `Claim support link skipped because claim ${claimId} was not found.`;
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "noop",
          readOnly: false,
          message,
          collection: "claims",
          query: { entityId: claimId },
          nextHints: ["workspace.search", "claim.create"]
        })
      };
    }
    const sectionIds = stringArrayInput(args.entity.sectionIds, 20);
    const citation = supportLinkFromInput({
      run: input.run,
      now: nowText,
      store: input.store,
      claimId,
      sourceId,
      evidenceCellId: evidenceCell?.id ?? (evidenceCellId.length === 0 ? null : evidenceCellId),
      sectionIds,
      entity: args.entity,
      fallbackSnippet: null,
      relation: "supports"
    });
    if (citation === null) {
      const message = `Claim support link skipped because claim ${claimId} or evidence cell ${evidenceCellId || "(auto)"} was not available.`;
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "noop",
          readOnly: false,
          message,
          collection: "citations",
          query: {
            claimId,
            sourceId,
            evidenceCellId: evidenceCellId || null
          },
          nextHints: ["workspace.list", "evidence.create_cell", "claim.create"]
        })
      };
    }
    let nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, citation, nowText);
    const nextClaimSourceIds = uniqueStrings([...claim.sourceIds, citation.sourceId]);
    const nextUsedInSections = uniqueStrings([...claim.usedInSections, ...sectionIds]);
    nextStore = patchResearchWorkStoreEntity(nextStore, {
      collection: "claims",
      id: claimId,
      changes: {
        sourceIds: nextClaimSourceIds,
        usedInSections: nextUsedInSections,
        confidence: citation.confidence ?? claim.confidence
      }
    }, nowText);
    const supportReadiness = supportReadinessForWorkspace(nextStore);
    const supported = supportReadiness.supportedClaimIds.has(claimId);
    const claimIssues = supportReadiness.issues.filter((issue) => issue.claimId === claimId);
    nextStore = patchResearchWorkStoreEntity(nextStore, {
      collection: "claims",
      id: claimId,
      changes: {
        supportStatus: supported ? "supported" : claim.supportStatus,
        risk: supported ? null : claimIssues[0]?.message ?? claim.risk
      }
    }, nowText);
    await writeResearchWorkStore(nextStore);
    const updatedClaim = readResearchWorkStoreEntity<WorkStoreClaim>(nextStore, "claims", claimId);
    const message = `Support link attached from ${citation.sourceTitle} to claim ${claimId}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "citations",
        count: 1,
        totalCount: nextStore.objects.citations.length,
        entity: entityPreviewForAgent(citation, nextStore),
        related: updatedClaim === null ? [] : [entityPreviewForAgent(updatedClaim, nextStore)],
        stateDelta: { supportLinksCreated: 1 },
        nextHints: ["section.link_claim", "claim.check_support", "release.verify"]
      })
    };
  }

  if (input.decision.action === "extraction.create") {
    const extractionResult = paperExtractionFromToolInput({
      run: input.run,
      now: nowText,
      decision: input.decision,
      store: input.store
    });
    if (extractionResult === null) {
      const message = "Extraction create blocked because no known canonical source id was provided.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "blocked",
          readOnly: false,
          message,
          collection: "extractions",
          count: 0,
          totalCount: input.store.objects.extractions.length,
          nextHints: ["workspace.list", "source.search", "source.merge"]
        })
      };
    }
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, extractionResult.extraction, nowText);
    await writeResearchWorkStore(nextStore);
    const message = `Extraction created for source ${extractionResult.source.title}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "extractions",
        count: 1,
        totalCount: nextStore.objects.extractions.length,
        entity: entityPreviewForAgent(extractionResult.extraction, nextStore),
        stateDelta: {
          extractionsCreated: 1
        },
        nextHints: ["evidence.create_cell", "workspace.read", "claim.create"]
      })
    };
  }

  if (input.decision.action === "evidence.create_cell") {
    const cell = evidenceCellFromToolInput({
      run: input.run,
      now: nowText,
      decision: input.decision,
      store: input.store
    });
    if (cell === null) {
      const message = "Evidence cell create blocked because it requires a known source id and an existing extraction for that source.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "blocked",
          readOnly: false,
          message,
          collection: "evidenceCells",
          count: 0,
          totalCount: input.store.objects.evidenceCells.length,
          nextHints: ["extraction.create", "workspace.list", "workspace.read"]
        })
      };
    }
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, cell, nowText);
    await writeResearchWorkStore(nextStore);
    const message = `Evidence cell created ${cell.id}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "evidenceCells",
        count: 1,
        totalCount: nextStore.objects.evidenceCells.length,
        entity: entityPreviewForAgent(cell, nextStore),
        stateDelta: {
          evidenceCellsCreated: 1
        },
        nextHints: ["claim.create", "claim.link_support", "evidence.matrix_view"]
      })
    };
  }

  if (input.decision.action === "evidence.matrix_view") {
    const timestamp = input.now();
    const matrix = buildEvidenceMatrix({
      runId: input.run.id,
      brief: input.run.brief,
      paperExtractions: input.store.objects.extractions.map((entry) => entry.extraction)
    });
    const rowItems = matrix.rows.slice(0, 20).map((row): AgentVisibleEntityPreview => ({
      id: row.extractionId,
      kind: "evidenceMatrixRow",
      sourceId: row.paperId,
      sourceTitle: previewSourceTitle(input.store, row.paperId),
      confidence: row.confidence,
      snippet: compactPreviewText(row.problemSetting),
      fields: {
        problemSetting: compactPreviewText(row.problemSetting),
        architecture: compactPreviewText(row.architecture),
        evaluationSetup: compactPreviewText(row.evaluationSetup),
        successSignals: compactPreviewList(row.successSignals),
        limitations: compactPreviewList(row.limitations),
        claimCount: row.claimCount
      }
    }));
    const insightItems = matrix.derivedInsights.slice(0, 12).map((insight): AgentVisibleEntityPreview => ({
      id: insight.id,
      kind: `evidenceMatrixInsight:${insight.kind}`,
      title: insight.title,
      sourceIds: insight.paperIds.slice(0, 12),
      text: insight.summary,
      snippet: compactPreviewText(insight.summary),
      fields: {
        claimTexts: insight.claimTexts.slice(0, 6)
      }
    }));
    const message = `Evidence matrix view returned ${matrix.rowCount} row(s) and ${matrix.derivedInsights.length} derived insight(s) without mutating workspace state.`;
    return {
      handled: true,
      store: input.store,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp,
        readOnly: true,
        message,
        collection: "evidenceCells",
        count: rowItems.length,
        totalCount: matrix.rowCount,
        items: [...rowItems, ...insightItems],
        stateDelta: {
          evidenceCellsCreated: 0
        },
        nextHints: ["claim.create", "workspace.read", "evidence.create_cell"]
      })
    };
  }

  if (input.decision.action === "section.read") {
    const timestamp = input.now();
    const sectionId = args.entityId;
    const section = sectionId === null ? null : readResearchWorkStoreEntity<WorkStoreManuscriptSection>(input.store, "manuscriptSections", sectionId);
    const message = section === null
      ? "Section read found no section."
      : `Section read ${section.title}.`;
    return {
      handled: true,
      store: input.store,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp,
        status: section === null ? "noop" : "ok",
        readOnly: true,
        message,
        collection: "manuscriptSections",
        query: {
          entityId: sectionId
        },
        count: section === null ? 0 : 1,
        totalCount: section === null ? 0 : 1,
        entity: section === null ? null : entityPreviewForAgent(section, input.store),
        nextHints: section === null ? ["section.create"] : ["section.patch", "section.link_claim", "section.check_claims"]
      })
    };
  }

  if (input.decision.action === "section.create" || input.decision.action === "section.patch") {
    const sectionId = args.entityId;
    const existing = sectionId === null ? null : readResearchWorkStoreEntity<WorkStoreManuscriptSection>(input.store, "manuscriptSections", sectionId);
    const section = manuscriptSectionFromToolInput({
      run: input.run,
      now: nowText,
      decision: input.decision,
      existing
    });
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, section, nowText);
    await writeResearchWorkStore(nextStore);
    const message = `Section updated ${section.id}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "manuscriptSections",
        count: 1,
        totalCount: nextStore.objects.manuscriptSections.length,
        entity: entityPreviewForAgent(section, nextStore),
        stateDelta: {
          [input.decision.action === "section.create" ? "sectionsCreated" : "sectionsPatched"]: 1
        },
        nextHints: ["section.link_claim", "section.check_claims", "release.verify"]
      })
    };
  }

  if (input.decision.action === "section.link_claim") {
    const sectionId = args.entityId ?? args.link?.fromId ?? null;
    const claimId = args.link?.toId ?? stringInput(args.entity.claimId, input.decision.inputs.paperIds[0] ?? "");
    const section = sectionId === null ? null : readResearchWorkStoreEntity<WorkStoreManuscriptSection>(input.store, "manuscriptSections", sectionId);
    if (section === null || claimId.length === 0) {
      const message = "Section claim link skipped because section id or claim id was missing.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "noop",
          readOnly: false,
          message,
          collection: "manuscriptSections",
          query: { sectionId, claimId },
          nextHints: ["workspace.list", "section.create", "claim.create"]
        })
      };
    }
    const nextStore = patchResearchWorkStoreEntity(input.store, {
      collection: "manuscriptSections",
      id: section.id,
      changes: {
        claimIds: uniqueStrings([...section.claimIds, claimId])
      }
    }, nowText);
    await writeResearchWorkStore(nextStore);
    const updatedSection = readResearchWorkStoreEntity<WorkStoreManuscriptSection>(nextStore, "manuscriptSections", section.id);
    const message = `Section ${section.id} linked to claim ${claimId}.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "manuscriptSections",
        query: { sectionId: section.id, claimId },
        count: updatedSection === null ? 0 : 1,
        totalCount: nextStore.objects.manuscriptSections.length,
        entity: updatedSection === null ? null : entityPreviewForAgent(updatedSection, nextStore),
        related: nextStore.objects.claims
          .filter((claim) => claim.id === claimId)
          .map((claim) => entityPreviewForAgent(claim, nextStore)),
        stateDelta: { sectionClaimLinksCreated: 1 },
        nextHints: ["section.check_claims", "release.verify", "workspace.read"]
      })
    };
  }

  if (input.decision.action === "release.verify" || (input.decision.action === "check.run" && args.entityId === null)) {
    const references = referencesFromWorkStore(input.run, input.store);
    const checkBundle = workspaceManuscriptChecks({
      run: input.run,
      store: input.store,
      references
    });
    const releaseChecks = releaseCheckEntitiesFromChecks(input.run, checkBundle.checks, nowText);
    const nextStore = upsertResearchWorkStoreEntities(input.store, releaseChecks, nowText);
    await writeResearchWorkStore(nextStore);
    await writeJsonArtifact(input.run.artifacts.referencesPath, references);
    await writeJsonArtifact(input.run.artifacts.manuscriptChecksPath, checkBundle);
    const hardFailures = releaseChecks.filter((check) => check.status === "fail" && check.severity === "blocker");
    const message = hardFailures.length > 0
      ? `Release verification found ${hardFailures.length} hard invariant repair item(s); manuscript is not ready yet.`
      : `Release verification wrote ${releaseChecks.length} check(s): ${hardFailures.length} hard invariant blocker(s).`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        status: hardFailures.length > 0 ? "not_ready" : "ok",
        readOnly: false,
        message,
        collection: "releaseChecks",
        count: releaseChecks.length,
        totalCount: releaseChecks.length,
        items: releaseChecks.map((check) => entityPreviewForAgent(check, nextStore)),
        related: hardFailures.length > 0 ? releaseRepairPreviews(hardFailures) : [],
        stateDelta: {
          releaseChecksCreated: releaseChecks.length,
          hardInvariantBlockers: hardFailures.length
        },
        nextHints: hardFailures.length > 0
          ? ["workspace.read", "claim.link_support", "section.link_claim"]
          : ["manuscript.release", "critic.review"]
      })
    };
  }

  if (input.decision.action === "manuscript.release") {
    const references = referencesFromWorkStore(input.run, input.store);
    const checkBundle = workspaceManuscriptChecks({
      run: input.run,
      store: input.store,
      references
    });
    const releaseChecks = releaseCheckEntitiesFromChecks(input.run, checkBundle.checks, nowText);
    const paper = workspacePaperArtifact({
      run: input.run,
      store: input.store,
      references,
      readinessStatus: checkBundle.readinessStatus
    });
    const hardFailures = checkBundle.checks.filter((check) => check.status === "fail" && check.severity === "blocker");
    const nextStore = upsertResearchWorkStoreEntities(input.store, releaseChecks, nowText);
    await writeResearchWorkStore(nextStore);
    await writeJsonArtifact(input.run.artifacts.referencesPath, references);
    await writeJsonArtifact(input.run.artifacts.manuscriptChecksPath, checkBundle);
    await writeJsonArtifact(input.run.artifacts.paperJsonPath, paper);

    if (hardFailures.length > 0) {
      const message = `Manuscript release is not ready: ${hardFailures.length} hard invariant repair item(s) remain.`;
      await writeFile(
        input.run.artifacts.paperPath,
        [
          "# Review Paper",
          "",
          "Manuscript release was explicitly requested, but computable release invariants failed.",
          "",
          "## Blocking Invariants",
          "",
          ...hardFailures.map((check) => `- ${check.message}`)
        ].join("\n"),
        "utf8"
      );
      return {
        handled: true,
        store: nextStore,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "not_ready",
          readOnly: false,
          message,
          collection: "releaseChecks",
          count: releaseChecks.length,
          totalCount: releaseChecks.length,
          items: releaseChecks.map((check) => entityPreviewForAgent(check, nextStore)),
          related: releaseRepairPreviews(releaseChecks.filter((check) => check.status === "fail" && check.severity === "blocker")),
          stateDelta: {
            releaseChecksCreated: releaseChecks.length,
            hardInvariantBlockers: hardFailures.length,
            manuscriptExportsCreated: 0
          },
          nextHints: ["workspace.read", "claim.link_support", "section.link_claim", "release.verify"]
        })
      };
    }

    const markdown = renderWorkspacePaperMarkdown(paper, references);
    await writeFile(input.run.artifacts.paperPath, `${markdown}\n`, "utf8");
    const message = `Manuscript released from workspace state with ${paper.sections.length} section(s) and ${references.referenceCount} reference(s).`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        readOnly: false,
        message,
        collection: "manuscriptSections",
        count: paper.sections.length,
        totalCount: paper.sections.length,
        items: paper.sections.map((section): AgentVisibleEntityPreview => ({
          id: section.id,
          kind: "manuscriptSection",
          title: section.title,
          sourceIds: section.sourceIds.slice(0, 12),
          claimIds: section.claimIds.slice(0, 12),
          snippet: compactPreviewText(section.markdown),
          status: "released"
        })),
        stateDelta: {
          releaseChecksCreated: releaseChecks.length,
          hardInvariantBlockers: 0,
          manuscriptExportsCreated: 1
        },
        nextHints: ["workspace.status"]
      })
    };
  }

  if (input.decision.action === "section.check_claims" || input.decision.action === "check.run") {
    const sectionId = args.entityId;
    const section = sectionId === null ? null : readResearchWorkStoreEntity<WorkStoreManuscriptSection>(input.store, "manuscriptSections", sectionId);
    if (section === null) {
      const message = "Section claim check skipped because the section was not found.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "noop",
          readOnly: false,
          message,
          collection: "manuscriptSections",
          query: { entityId: sectionId },
          nextHints: ["workspace.list", "section.create"]
        })
      };
    }
    const claims = section.claimIds.flatMap((claimId) => {
      const claim = readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", claimId);
      return claim === null ? [] : [claim];
    });
    const supportReadiness = supportReadinessForWorkspace(input.store);
    const unsupportedClaimIds = section.claimIds.filter((claimId) => !supportReadiness.supportedClaimIds.has(claimId));
    const unsupported = claims.filter((claim) => unsupportedClaimIds.includes(claim.id));
    const sectionReady = section.claimIds.length > 0 && unsupportedClaimIds.length === 0;
    let nextStore = patchResearchWorkStoreEntity(input.store, {
      collection: "manuscriptSections",
      id: section.id,
      changes: {
        status: sectionReady ? "checked" : "needs_revision"
      }
    }, nowText);
    if (!sectionReady) {
      const sectionIssues = supportReadiness.issues
        .filter((issue) => issue.sectionId === section.id || (issue.sectionId === null && issue.claimId !== null && section.claimIds.includes(issue.claimId)))
        .slice(0, 4);
      const workItem = agentWorkItemFromCreateInput({
        run: input.run,
        now: nowText,
        decision: input.decision,
        entity: {
          title: `Section claim support needs revision: ${section.title}`,
          description: section.claimIds.length === 0
            ? "The section has no claim ids attached."
            : sectionIssues.length > 0
              ? sectionIssues.map((issue) => issue.message).join(" ")
              : `Unsupported claim ids: ${unsupportedClaimIds.join(", ")}`,
          severity: "major",
          type: "unsupported_claim",
          targetKind: "manuscriptSection",
          targetId: section.id,
          affectedClaimIds: unsupportedClaimIds,
          suggestedActions: ["claim.link_support", "claim.patch", "section.patch"]
        }
      });
      nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(nextStore, workItem, nowText);
    }
    await writeResearchWorkStore(nextStore);
    const updatedSection = readResearchWorkStoreEntity<WorkStoreManuscriptSection>(nextStore, "manuscriptSections", section.id);
    const createdWorkItem = !sectionReady ? nextStore.objects.workItems[nextStore.objects.workItems.length - 1] : null;
    const message = `Section checked ${section.id}: ${unsupportedClaimIds.length} unsupported claim(s).`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        status: sectionReady ? "ok" : "blocked",
        readOnly: false,
        message,
        collection: "manuscriptSections",
        query: { entityId: section.id },
        count: 1,
        totalCount: nextStore.objects.manuscriptSections.length,
        entity: updatedSection === null ? null : entityPreviewForAgent(updatedSection, nextStore),
        related: [
          ...unsupported.slice(0, 6).map((claim) => entityPreviewForAgent(claim, nextStore)),
          ...(createdWorkItem === null ? [] : [entityPreviewForAgent(createdWorkItem, nextStore)])
        ],
        stateDelta: {
          sectionsChecked: 1,
          workItemsCreated: sectionReady ? 0 : 1
        },
        nextHints: sectionReady ? ["release.verify", "manuscript.release"] : ["claim.link_support", "section.patch", "workspace.read"]
      })
    };
  }

  const message = `${input.decision.action} is recognized but did not require a mutation.`;
  return {
    handled: true,
    store: input.store,
    message,
    result: makeAgentToolResult({
      run: input.run,
      action: input.decision.action,
      timestamp: nowText,
      status: "noop",
      readOnly: true,
      message,
      nextHints: ["workspace.status", "workspace.list"]
    })
  };
}

async function executeWorkspaceToolAction(input: {
  run: RunRecord;
  now: () => string;
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
}): Promise<WorkspaceToolExecutionResult> {
  const guidanceResult = await executeGuidanceToolAction(input);
  if (guidanceResult.handled) {
    return guidanceResult;
  }

  const workStoreResult = await executeWorkStoreToolAction(input);
  if (workStoreResult.handled) {
    return workStoreResult;
  }

  return executeResearchObjectToolAction(input);
}

function validSourceProviderChoices(
  decision: ResearchActionDecision,
  session: SourceToolRuntime
): SourceProviderId[] {
  const available = new Set(session.state().availableProviderIds);
  return uniqueStrings(decision.inputs.providerIds)
    .flatMap((providerId) => available.has(providerId as SourceProviderId) ? [providerId as SourceProviderId] : []);
}

function sourceQueriesForAction(
  decision: ResearchActionDecision,
  session: SourceToolRuntime
): string[] {
  void session;
  return uniqueStrings(decision.inputs.searchQueries).slice(0, 6);
}

function sourceSearchReconsiderationReason(input: {
  decision: ResearchActionDecision;
  session: SourceToolRuntime;
  providerIds: SourceProviderId[];
  queries: string[];
}): string | null {
  if (!isSourceSearchAction(input.decision.action)) {
    return null;
  }

  const state = input.session.state();
  const exhaustedChosenProviders = input.providerIds.filter((providerId) => input.session.isSearchExhausted(providerId, input.queries));
  const reasons = [
    state.canonicalMergeCompleted
      ? "Canonical source records are already available; searching again will discard the current canonical source view unless a specific gap requires it."
      : null,
    state.mergeReadiness.ready
      ? state.mergeReadiness.reason
      : null,
    exhaustedChosenProviders.length > 0
      ? `Chosen provider/query targets are already low-yield or exhausted: ${exhaustedChosenProviders.join(", ")}.`
      : null,
    state.consecutiveNoProgressSearches >= 2
      ? `${state.consecutiveNoProgressSearches} consecutive source searches added no new screened sources.`
      : null
  ].filter((reason): reason is string => reason !== null);

  if (reasons.length === 0) {
    return null;
  }

  const recommended = "If you still search, choose a not-yet-exhausted provider/query and name the missing evidence target; otherwise explicitly choose source.merge or another source/workspace tool.";

  return `${reasons.join(" ")} ${recommended}`;
}

async function checkpointSourceToolState(input: {
  run: RunRecord;
  now: () => string;
  session: SourceToolRuntime;
  sessionSegment: number;
  message: string;
}): Promise<void> {
  await writeSourceToolCheckpoint({
    run: input.run,
    now: input.now,
    sessionSegment: input.sessionSegment,
    sourceState: input.session.state(),
    event: {
      phase: "provider_query",
      status: "progress",
      message: input.message
    }
  });
}

async function persistSourceToolWorkspaceSnapshot(input: {
  run: RunRecord;
  now: () => string;
  plan: ResearchPlan;
  session: SourceToolRuntime;
  workStore: ResearchWorkStore;
}): Promise<ResearchWorkStore> {
  const timestamp = input.now();
  const nextStore = mergeRunSegmentIntoResearchWorkStore(input.workStore, {
    run: input.run,
    plan: input.plan,
    gathered: input.session.snapshot(),
    paperExtractions: [],
    criticReports: [],
    now: timestamp
  });
  await writeResearchWorkStore(nextStore);
  return nextStore;
}

type SourceActionExecutionResult = {
  handled: boolean;
  store: ResearchWorkStore;
  message: string | null;
  results: AgentToolResult[];
};

function sourceNoopToolResult(input: {
  run: RunRecord;
  now: () => string;
  decision: ResearchActionDecision;
  message: string;
}): AgentToolResult {
  return sourceToolResultFromObservation({
    run: input.run,
    now: input.now,
    decision: input.decision,
    observation: {
      action: "source.search",
      message: input.message,
      counts: {
        newSources: 0
      },
      items: []
    }
  });
}

async function executeSourceToolAction(input: {
  run: RunRecord;
  now: () => string;
  decision: ResearchActionDecision;
  session: SourceToolRuntime;
  plan: ResearchPlan;
  workStore: ResearchWorkStore;
  sessionSegment: number;
}): Promise<SourceActionExecutionResult> {
  const persistSourceWorkspace = async (): Promise<void> => {
    input.workStore = await persistSourceToolWorkspaceSnapshot({
      run: input.run,
      now: input.now,
      plan: input.plan,
      session: input.session,
      workStore: input.workStore
    });
  };

  if (isSourceMergeAction(input.decision.action)) {
    const observation = await input.session.mergeSources();
    await persistSourceWorkspace();
    await appendEvent(input.run, input.now, "source", observation.message);
    await appendStdout(input.run, `Source tool observation: ${observation.message}`);
    await checkpointSourceToolState({
      run: input.run,
      now: input.now,
      session: input.session,
      sessionSegment: input.sessionSegment,
      message: observation.message
    });
    return {
      handled: true,
      store: input.workStore,
      message: observation.message,
      results: [sourceToolResultFromObservation({
        run: input.run,
        now: input.now,
        decision: input.decision,
        observation
      })]
    };
  }

  if (isSourceResolveAccessAction(input.decision.action)) {
    const observation = await input.session.resolveAccess(input.decision.inputs.paperIds);
    await persistSourceWorkspace();
    await appendEvent(input.run, input.now, "source", observation.message);
    await appendStdout(input.run, `Source tool observation: ${observation.message}`);
    await checkpointSourceToolState({
      run: input.run,
      now: input.now,
      session: input.session,
      sessionSegment: input.sessionSegment,
      message: observation.message
    });
    return {
      handled: true,
      store: input.workStore,
      message: observation.message,
      results: [sourceToolResultFromObservation({
        run: input.run,
        now: input.now,
        decision: input.decision,
        observation
      })]
    };
  }

  if (isSourceSelectEvidenceAction(input.decision.action)) {
    const observation = await input.session.selectEvidenceSet(input.decision.inputs.paperIds);
    await persistSourceWorkspace();
    await appendEvent(input.run, input.now, "source", observation.message);
    await appendStdout(input.run, `Source tool observation: ${observation.message}`);
    await checkpointSourceToolState({
      run: input.run,
      now: input.now,
      session: input.session,
      sessionSegment: input.sessionSegment,
      message: observation.message
    });
    return {
      handled: true,
      store: input.workStore,
      message: observation.message,
      results: [sourceToolResultFromObservation({
        run: input.run,
        now: input.now,
        decision: input.decision,
        observation
      })]
    };
  }

  if (!isSourceSearchAction(input.decision.action)) {
    return {
      handled: false,
      store: input.workStore,
      message: null,
      results: []
    };
  }

  const providers = validSourceProviderChoices(input.decision, input.session);
  const queries = sourceQueriesForAction(input.decision, input.session);
  const reconsiderationReason = sourceSearchReconsiderationReason({
    decision: input.decision,
    session: input.session,
    providerIds: providers,
    queries
  });
  if (reconsiderationReason !== null) {
    await appendEvent(input.run, input.now, "next", `Source dashboard observation: ${reconsiderationReason}`);
    await appendStdout(input.run, `Source dashboard: ${reconsiderationReason}`);
  }

  if (queries.length === 0) {
    const message = "Source search skipped because the researcher did not provide explicit search query text.";
    await appendEvent(input.run, input.now, "next", message);
    await appendStdout(input.run, `Source tool observation: ${message}`);
    return {
      handled: true,
      store: input.workStore,
      message,
      results: [sourceNoopToolResult({
        run: input.run,
        now: input.now,
        decision: input.decision,
        message
      })]
    };
  }

  if (providers.length === 0) {
    const message = "Source search skipped because the researcher did not provide explicit valid provider ids; no fallback provider was selected.";
    await appendEvent(input.run, input.now, "next", message);
    await appendStdout(input.run, `Source tool observation: ${message}`);
    return {
      handled: true,
      store: input.workStore,
      message,
      results: [sourceNoopToolResult({
        run: input.run,
        now: input.now,
        decision: input.decision,
        message
      })]
    };
  }

  const executableProviderOrder = providers
    .filter((providerId) => !input.session.isSearchExhausted(providerId, queries));
  if (executableProviderOrder.length === 0) {
    const message = "No executable source search target remained after filtering low-yield choices; checkpointing current source state without automatic merge or selection.";
    await appendEvent(input.run, input.now, "next", message);
    await appendStdout(input.run, `Source tool observation: ${message}`);
    return {
      handled: true,
      store: input.workStore,
      message,
      results: [sourceNoopToolResult({
        run: input.run,
        now: input.now,
        decision: input.decision,
        message
      })]
    };
  }

  const results: AgentToolResult[] = [];
  let lastMessage: string | null = null;
  for (const providerId of executableProviderOrder.slice(0, 2)) {
    const observation = await input.session.queryProvider(providerId, queries);
    await persistSourceWorkspace();
    await appendEvent(input.run, input.now, "source", observation.message);
    await appendStdout(input.run, `Source tool observation: ${observation.message}`);
    await checkpointSourceToolState({
      run: input.run,
      now: input.now,
      session: input.session,
      sessionSegment: input.sessionSegment,
      message: observation.message
    });
    results.push(sourceToolResultFromObservation({
      run: input.run,
      now: input.now,
      decision: input.decision,
      observation,
      providerId
    }));
    lastMessage = observation.message;
  }

  return {
    handled: true,
    store: input.workStore,
    message: lastMessage,
    results
  };
}

type ModelDrivenSessionOutcome = {
  workStore: ResearchWorkStore;
  gathered: ResearchSourceSnapshot;
  workerStatus: ResearchWorkerStatus;
  statusReason: string;
  paperReadiness: ManuscriptReadinessState | null;
  nextInternalActions: string[];
  userBlockers: string[];
  checkpointedByBudget: boolean;
  terminalAction: string | null;
  stepsUsed: number;
};

function sessionObservations(input: {
  sourceState: ReturnType<SourceToolRuntime["state"]>;
  workStore: ResearchWorkStore;
  step: number;
  maxSteps: number;
}): ResearchActionRequest["observations"] {
  const canonicalSources = Math.max(input.sourceState.canonicalPapers, input.workStore.objects.canonicalSources.length);
  const screenedInSources = Math.max(
    input.sourceState.screenedSources,
    input.workStore.objects.canonicalSources.filter((source) => source.screeningDecision === "include").length
  );
  const resolvedAccessSources = Math.max(
    input.sourceState.resolvedPaperIds.length,
    input.workStore.objects.canonicalSources.filter((source) => source.accessMode !== "metadata_only").length
  );
  const explicitlySelectedEvidenceSources = input.sourceState.selectedPapers;

  return {
    sourceCandidates: Math.max(input.sourceState.rawSources, input.workStore.objects.sources.length),
    canonicalSources,
    screenedInSources,
    explicitlySelectedEvidenceSources,
    resolvedAccessSources,
    canonicalPapers: canonicalSources,
    selectedPapers: explicitlySelectedEvidenceSources,
    extractedPapers: input.workStore.objects.extractions.length,
    evidenceRows: input.workStore.objects.evidenceCells.length,
    evidenceInsights: 0,
    manuscriptReadiness: input.workStore.worker.paperReadiness,
    sessionStepsUsed: Math.max(0, input.step - 1),
    sessionStepsRemaining: Math.max(0, input.maxSteps - input.step + 1)
  };
}

function statusDecisionOutcome(input: {
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
  toolResults: AgentToolResult[];
}): {
  workerStatus: ResearchWorkerStatus;
  statusReason: string;
  nextInternalActions: string[];
  userBlockers: string[];
} {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const requestedStatus = stringInput(entity.status, "");
  const statusReason = stringInput(entity.statusReason ?? entity.reason, input.decision.inputs.reason ?? input.decision.rationale);
  const nextInternalActions = stringArrayInput(entity.nextInternalActions ?? entity.options ?? entity.choices, 12);
  const userBlockers = stringArrayInput(entity.userBlockers ?? entity.blockers, 12);
  const openExternalBlockers = input.store.objects.workItems
    .filter((item) => item.status === "open" && item.severity === "blocking" && (item.type === "external_blocker" || item.type === "source_access"))
    .map((item) => item.description);

  if (requestedStatus === "externally_blocked" && (openExternalBlockers.length > 0 || userBlockers.some(isExternalBlockerMessage))) {
    return {
      workerStatus: "externally_blocked",
      statusReason,
      nextInternalActions: [],
      userBlockers: openExternalBlockers.length > 0 ? openExternalBlockers : userBlockers
    };
  }

  if (requestedStatus === "needs_user_decision" && nextInternalActions.length >= 2) {
    return {
      workerStatus: "needs_user_decision",
      statusReason,
      nextInternalActions,
      userBlockers: userBlockers.length > 0 ? userBlockers : [statusReason]
    };
  }

  const diagnosticNextActions = checkpointDiagnosticNextActions({
    store: input.store,
    toolResults: input.toolResults
  });

  return {
    workerStatus: "working",
    statusReason: `Researcher checkpointed the model-driven session: ${statusReason}`,
    nextInternalActions: nextInternalActions.length > 0
      ? nextInternalActions
      : diagnosticNextActions,
    userBlockers: []
  };
}

function checkpointDiagnosticNextActions(input: {
  store: ResearchWorkStore;
  toolResults: AgentToolResult[];
}): string[] {
  const actions: string[] = [];
  const lastNotReady = [...input.toolResults].reverse().find((result) => result.status === "not_ready" || result.status === "blocked" || result.status === "failed");
  if (lastNotReady !== undefined) {
    actions.push(`Inspect the last ${lastNotReady.status} tool result from ${lastNotReady.action}; it reported: ${lastNotReady.message}`);
  }

  const failedReleaseChecks = input.store.objects.releaseChecks.filter((check) => check.status === "fail" && check.severity === "blocker");
  if (failedReleaseChecks.length > 0) {
    actions.push(`Inspect release checks with workspace.list/read; ${failedReleaseChecks.length} hard invariant repair item(s) remain.`);
  }

  const supportReadiness = supportReadinessForWorkspace(input.store);
  if (supportReadiness.unsupportedClaimIds.size > 0) {
    actions.push(`Inspect claims and support links with workspace.list/read; ${supportReadiness.unsupportedClaimIds.size} claim(s) lack durable support.`);
  }

  const sectionsNeedingRevision = input.store.objects.manuscriptSections.filter((section) => section.status === "needs_revision" || section.claimIds.length === 0);
  if (sectionsNeedingRevision.length > 0) {
    actions.push(`Inspect manuscript sections with workspace.list/read; ${sectionsNeedingRevision.length} section(s) need claim links or revision.`);
  }

  return actions.length > 0
    ? actions.slice(0, 5)
    : ["Resume the model-driven research session with /go."];
}

function releaseSucceeded(result: AgentToolResult | null | undefined): boolean {
  return result?.status !== "blocked"
    && result?.stateDelta?.manuscriptExportsCreated === 1
    && result.stateDelta.hardInvariantBlockers === 0;
}

async function runModelDrivenResearchSession(input: {
  run: RunRecord;
  now: () => string;
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
  agent: AgentStepRecorder;
  sourceRequest: ResearchSourceToolRequest;
  diagnostics: ResearchActionDiagnostic[];
  actionTransports: AgentActionTransportRecord[];
  plan: ResearchPlan;
  workStore: ResearchWorkStore;
}): Promise<ModelDrivenSessionOutcome> {
  // This is only the execution shell around model decisions. It must not become
  // a research workflow: each iteration observes state, asks the model for one
  // tool action, executes exactly that action, persists the result, and repeats.
  let workStore = input.workStore;
  let toolResults: AgentToolResult[] = [];
  const sourceSession = await SourceToolRuntime.create(input.sourceRequest);
  const maxSteps = Math.max(1, input.runtimeConfig.agentSegmentMaxSteps);
  const sessionSegment = 1;
  await appendStdout(input.run, "Model-driven research session active; every step is selected by the researcher model from the full tool surface.");

  for (let step = 1; step <= maxSteps; step += 1) {
    const sourceState = sourceSession.state();
    const decision = await chooseResearchActionStrict({
      run: input.run,
      now: input.now,
      researchBackend: input.researchBackend,
      runtimeConfig: input.runtimeConfig,
      agent: input.agent,
      diagnostics: input.diagnostics,
      actionTransports: input.actionTransports,
      request: {
        projectRoot: input.run.projectRoot,
        runId: input.run.id,
        phase: "research",
        allowedActions: workspaceResearchActions(),
        brief: input.run.brief,
        plan: input.plan,
        observations: sessionObservations({ sourceState, workStore, step, maxSteps }),
        sourceState: sourceStateForAgent(sourceSession),
        workStore: workStoreContextForAgent(workStore),
        guidance: guidanceContextForAgent({ brief: input.run.brief, plan: input.plan }),
        toolResults,
        criticReports: [],
        retryInstruction: [
          "This is a state-driven research session, not a phase workflow.",
          "Inspect the current workspace/source/tool observations, choose exactly one next action, and let the runtime execute only that action.",
          "All production tools are available regardless of milestone; do not stop for machine-actionable source, evidence, claim, critic, section, check, or release work.",
          "Use workspace.status only for a true checkpoint, external blocker, or user decision that cannot be resolved with tools."
        ].join(" ")
      }
    });

    if (isStatusAction(decision.action)) {
      const outcome = statusDecisionOutcome({ decision, store: workStore, toolResults });
      await appendEvent(input.run, input.now, "next", outcome.statusReason);
      await appendStdout(input.run, `Research session checkpoint: ${outcome.statusReason}`);
      return {
        workStore,
        gathered: await sourceSession.result(),
        workerStatus: outcome.workerStatus,
        statusReason: outcome.statusReason,
        paperReadiness: safeManuscriptReadiness(workStore.worker.paperReadiness),
        nextInternalActions: outcome.nextInternalActions,
        userBlockers: outcome.userBlockers,
        checkpointedByBudget: false,
        terminalAction: decision.action,
        stepsUsed: step
      };
    }

    const workspaceExecution = await executeWorkspaceToolAction({
      run: input.run,
      now: input.now,
      decision,
      store: workStore
    });
    if (workspaceExecution.handled) {
      workStore = workspaceExecution.store;
      toolResults = rememberAgentToolResult(toolResults, workspaceExecution.result);
      if (workspaceExecution.message !== null) {
        await appendEvent(input.run, input.now, "memory", workspaceExecution.message);
        await appendStdout(input.run, `Research tool observation: ${workspaceExecution.message}`);
      }
      if (decision.action === "manuscript.release" && releaseSucceeded(workspaceExecution.result)) {
        const result = workspaceExecution.result;
        await input.agent.record({
          actor: "runtime",
          phase: "release",
          action: "manuscript.release_result",
          status: "completed",
          summary: result?.message ?? "Manuscript release completed.",
          artifactPaths: [
            input.run.artifacts.paperPath,
            input.run.artifacts.paperJsonPath,
            input.run.artifacts.referencesPath,
            input.run.artifacts.manuscriptChecksPath
          ],
          counts: {
            releaseChecksCreated: result?.stateDelta?.releaseChecksCreated ?? 0,
            hardInvariantBlockers: result?.stateDelta?.hardInvariantBlockers ?? 0,
            manuscriptExportsCreated: result?.stateDelta?.manuscriptExportsCreated ?? 1
          },
          metadata: {
            toolAction: result?.action ?? decision.action,
            toolStatus: result?.status ?? "ok",
            collection: result?.collection ?? null,
            count: result?.count ?? 0,
            totalCount: result?.totalCount ?? 0,
            nextHints: result?.nextHints ?? []
          }
        });
        return {
          workStore,
          gathered: await sourceSession.result(),
          workerStatus: "release_ready",
          statusReason: "Manuscript release completed after explicit model-selected release action and hard invariant checks passed.",
          paperReadiness: "ready_for_revision",
          nextInternalActions: [],
          userBlockers: [],
          checkpointedByBudget: false,
          terminalAction: decision.action,
          stepsUsed: step
        };
      }
      continue;
    }

    const sourceExecution = await executeSourceToolAction({
      run: input.run,
      now: input.now,
      decision,
      session: sourceSession,
      plan: input.plan,
      workStore,
      sessionSegment
    });
    if (sourceExecution.handled) {
      workStore = sourceExecution.store;
      for (const result of sourceExecution.results) {
        toolResults = rememberAgentToolResult(toolResults, result);
      }
      continue;
    }

    const message = `${decision.action} is available in the action surface but has no executor yet; checkpointed as visible runtime diagnostic.`;
    const result = makeAgentToolResult({
      run: input.run,
      action: decision.action,
      timestamp: input.now(),
      status: "noop",
      readOnly: true,
      message,
      nextHints: ["workspace.status", "workspace.read", "work_item.create"]
    });
    toolResults = rememberAgentToolResult(toolResults, result);
    await appendEvent(input.run, input.now, "next", message);
    await appendStdout(input.run, `Research tool observation: ${message}`);
  }

  await appendEvent(input.run, input.now, "next", "Model-driven research session reached its segment step budget; checkpointing current workspace state.");
  await appendStdout(input.run, "Model-driven research session reached its segment step budget; checkpointing current workspace state.");
  workStore = await persistSourceToolWorkspaceSnapshot({
    run: input.run,
    now: input.now,
    plan: input.plan,
    session: sourceSession,
    workStore
  });
  return {
    workStore,
    gathered: await sourceSession.result(),
    workerStatus: "checkpointed_budget_exhausted",
    statusReason: "The model-driven research session exhausted this segment budget and checkpointed durable workspace state for the next /go continuation.",
    paperReadiness: safeManuscriptReadiness(workStore.worker.paperReadiness),
    nextInternalActions: checkpointDiagnosticNextActions({ store: workStore, toolResults }),
    userBlockers: [],
    checkpointedByBudget: true,
    terminalAction: null,
    stepsUsed: maxSteps
  };
}

class AgentStepRecorder {
  private completedSteps = 0;

  constructor(
    private readonly run: RunRecord,
    private readonly now: () => string
  ) {}

  async record(input: {
    actor?: AgentStepRecord["actor"];
    phase: string;
    action: string;
    status: AgentStepStatus;
    summary: string;
    artifactPaths?: string[];
    counts?: Record<string, number>;
    metadata?: Record<string, JsonValue>;
  }): Promise<void> {
    const timestamp = this.now();
    this.completedSteps += 1;
    const artifactPaths = (input.artifactPaths ?? [])
      .map((artifactPath) => relativeArtifactPath(this.run.projectRoot, artifactPath));
    const record: AgentStepRecord = {
      schemaVersion: 1,
      runId: this.run.id,
      step: this.completedSteps,
      timestamp,
      actor: input.actor ?? "research_agent",
      phase: input.phase,
      action: input.action,
      status: input.status,
      summary: input.summary,
      artifactPaths,
      counts: input.counts ?? {},
      metadata: input.metadata ?? {}
    };
    const state: AgentStateArtifact = {
      schemaVersion: 1,
      runId: this.run.id,
      status: input.status === "blocked" ? "blocked" : input.status === "completed" ? "completed" : "running",
      currentPhase: input.phase,
      lastAction: input.action,
      lastStatus: input.status,
      completedSteps: this.completedSteps,
      updatedAt: timestamp,
      lastMetadata: input.metadata ?? {}
    };

    await appendFile(this.run.artifacts.agentStepsPath, `${JSON.stringify(record)}\n`, "utf8");
    await writeJsonArtifact(this.run.artifacts.agentStatePath, state);
  }
}

function pendingAgentState(run: RunRecord, timestamp: string): AgentStateArtifact {
  return {
    schemaVersion: 1,
    runId: run.id,
    status: "pending",
    currentPhase: run.stage,
    lastAction: null,
    lastStatus: null,
    completedSteps: 0,
    updatedAt: timestamp,
    lastMetadata: {}
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = typeof value === "string"
      ? value.replace(/\s+/g, " ").trim()
      : "";

    if (normalized.length === 0) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

async function chooseResearchActionStrict(input: {
  run: RunRecord;
  now: () => string;
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
  agent: AgentStepRecorder;
  request: Omit<ResearchActionRequest, "attempt" | "maxAttempts">;
  diagnostics: ResearchActionDiagnostic[];
  actionTransports: AgentActionTransportRecord[];
}): Promise<ResearchActionDecision> {
  const {
    run,
    now,
    researchBackend,
    runtimeConfig,
    agent,
    request,
    diagnostics,
    actionTransports
  } = input;
  const maxAttempts = Math.max(1, runtimeConfig.agentInvalidActionBudget);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const actionRequest: ResearchActionRequest = {
      ...request,
      attempt,
      maxAttempts,
      retryInstruction: attempt === 1
        ? request.retryInstruction
        : "Your previous response was not a valid structured action. Return exactly one allowed action with valid JSON arguments. Do not explain in prose."
    };

    try {
      await appendEvent(run, now, "next", `Ask research agent for next ${request.phase} action (${attempt}/${maxAttempts}).`);
      const decision = await researchBackend.chooseResearchAction(actionRequest, {
        operation: "agent_step",
        timeoutMs: runtimeConfig.agentStepTimeoutMs,
        agentControlMode: runtimeConfig.agentControlMode
      });
      const transport = decision.transport ?? "unknown";
      const transportMetadata: Record<string, JsonValue> = {
        transport
      };

      if (decision.transportFallback !== undefined) {
        transportMetadata.transportFallback = {
          from: decision.transportFallback.from,
          to: decision.transportFallback.to,
          kind: decision.transportFallback.kind,
          message: decision.transportFallback.message
        };
      }

      actionTransports.push({
        phase: request.phase,
        action: decision.action,
        attempt,
        transport,
        ...(decision.transportFallback === undefined
          ? {}
          : {
            fallbackFrom: decision.transportFallback.from,
            fallbackKind: decision.transportFallback.kind
          })
      });
      await agent.record({
        phase: request.phase,
        action: decision.action,
        status: "completed",
        summary: decision.rationale,
        artifactPaths: [run.artifacts.agentStatePath],
        counts: {
          confidencePercent: Math.round(decision.confidence * 100),
          providerIds: decision.inputs.providerIds.length,
          searchQueries: decision.inputs.searchQueries.length,
          evidenceTargets: decision.inputs.evidenceTargets.length
        },
        metadata: transportMetadata
      });
      await appendStdout(run, `Research agent action (${request.phase}): ${decision.action} - ${decision.rationale}`);
      return decision;
    } catch (error) {
      const diagnostic: ResearchActionDiagnostic = {
        phase: request.phase,
        attempt,
        kind: researchActionDiagnosticKind(error),
        message: errorMessage(error)
      };
      diagnostics.push(diagnostic);
      await appendEvent(run, now, "stderr", `Research agent action selection failed (${diagnostic.kind}): ${diagnostic.message}`);
      await appendStdout(run, `Research agent action selection failed: ${diagnostic.message}`);
    }
  }

  const fallback = modelUnsuitableActionDecision({
    ...request,
    attempt: maxAttempts,
    maxAttempts
  }, diagnostics);
  actionTransports.push({
    phase: request.phase,
    action: fallback.action,
    attempt: maxAttempts,
    transport: "runtime_fallback"
  });
  await agent.record({
    phase: request.phase,
    action: fallback.action,
    status: "warning",
    summary: fallback.rationale,
    artifactPaths: [run.artifacts.agentStatePath],
    counts: {
      invalidActions: diagnostics.filter((diagnostic) => diagnostic.phase === request.phase).length
    },
    metadata: {
      transport: "runtime_fallback"
    }
  });
  await appendEvent(run, now, "next", "Research agent could not produce a reliable structured action; finalizing status-only diagnostics.");
  return fallback;
}

function isExternalBlockerMessage(text: string): boolean {
  return /\b(credential|api key|quota|rate limit|paywall|permission|access denied|forbidden|unauthori[sz]ed|license|tdm|missing required|provider outage|required external resource)\b/i.test(text);
}

function pendingArtifactStatus(run: RunRecord, artifactKind: string, timestamp: string): ArtifactStatus {
  return {
    schemaVersion: 1,
    runId: run.id,
    artifactKind,
    status: "pending",
    stage: run.stage,
    createdAt: timestamp,
    updatedAt: timestamp,
    counts: {},
    error: null
  };
}

function skippedArtifactStatus(run: RunRecord, artifactKind: string, timestamp: string, reason: string): ArtifactStatus {
  return {
    schemaVersion: 1,
    runId: run.id,
    artifactKind,
    status: "skipped",
    stage: run.stage,
    createdAt: run.startedAt ?? run.createdAt,
    updatedAt: timestamp,
    counts: {},
    error: {
      message: reason,
      kind: "skipped",
      operation: "critic"
    }
  };
}

async function writeRunArtifacts(run: RunRecord): Promise<void> {
  await mkdir(run.artifacts.runDirectory, { recursive: true });
  const createdAt = run.startedAt ?? run.createdAt;
  await writeJsonArtifact(run.artifacts.briefPath, run.brief);
  await writeFile(run.artifacts.tracePath, "", "utf8");
  await writeFile(run.artifacts.eventsPath, "", "utf8");
  await writeFile(run.artifacts.stdoutPath, "", "utf8");
  await writeFile(run.artifacts.stderrPath, "", "utf8");
  await writeJsonArtifact(run.artifacts.agentStatePath, pendingAgentState(run, createdAt));
  await writeFile(run.artifacts.agentStepsPath, "", "utf8");
  await writeJsonArtifact(run.artifacts.planPath, pendingArtifactStatus(run, "plan", createdAt));
  await writeJsonArtifact(run.artifacts.sourcesPath, pendingArtifactStatus(run, "sources", createdAt));
  await writeJsonArtifact(run.artifacts.literaturePath, pendingArtifactStatus(run, "literature-review", createdAt));
  await writeJsonArtifact(run.artifacts.reviewProtocolPath, pendingArtifactStatus(run, "review-protocol", createdAt));
  await writeFile(run.artifacts.reviewProtocolMarkdownPath, "# Review Protocol\n\nStatus: pending.\n", "utf8");
  await writeJsonArtifact(run.artifacts.criticProtocolReviewPath, pendingArtifactStatus(run, "critic-protocol-review", createdAt));
  await writeJsonArtifact(run.artifacts.criticSourceSelectionPath, pendingArtifactStatus(run, "critic-source-selection", createdAt));
  await writeJsonArtifact(run.artifacts.criticEvidenceReviewPath, pendingArtifactStatus(run, "critic-evidence-review", createdAt));
  await writeJsonArtifact(run.artifacts.criticReleaseReviewPath, pendingArtifactStatus(run, "critic-release-review", createdAt));
  await writeJsonArtifact(run.artifacts.paperExtractionsPath, pendingArtifactStatus(run, "paper-extractions", createdAt));
  await writeJsonArtifact(run.artifacts.verificationPath, pendingArtifactStatus(run, "verification", createdAt));
  await writeFile(run.artifacts.paperPath, "# Review Paper\n\nStatus: pending.\n", "utf8");
  await writeJsonArtifact(run.artifacts.paperJsonPath, pendingArtifactStatus(run, "paper", createdAt));
  await writeJsonArtifact(run.artifacts.manuscriptChecksPath, pendingArtifactStatus(run, "manuscript-checks", createdAt));
  await writeJsonArtifact(run.artifacts.qualityReportPath, pendingArtifactStatus(run, "quality-report", createdAt));
  await writeJsonArtifact(run.artifacts.nextQuestionsPath, pendingArtifactStatus(run, "next-questions", createdAt));
  await writeJsonArtifact(run.artifacts.agendaPath, pendingArtifactStatus(run, "agenda", createdAt));
  await writeFile(run.artifacts.agendaMarkdownPath, "# Research Agenda\n\nStatus: pending.\n", "utf8");
}

function relativeArtifactPath(projectRoot: string, targetPath: string): string {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath.length === 0 ? "." : relativePath;
}

function paperEntityId(paper: CanonicalPaper): string {
  return createLiteratureEntityId("paper", paper.key);
}

function canonicalPaperIdMap(papers: CanonicalPaper[]): Map<string, string> {
  const mapping = new Map<string, string>();

  for (const paper of papers) {
    const canonicalId = paperEntityId(paper);
    mapping.set(paper.id, canonicalId);
    mapping.set(canonicalId, canonicalId);
  }

  return mapping;
}

function remapPaperIds(sourceIds: string[], canonicalIdByAnyId: Map<string, string>): string[] {
  return [...new Set(sourceIds.map((sourceId) => canonicalIdByAnyId.get(sourceId) ?? sourceId))];
}

function canonicalizePaper(paper: CanonicalPaper): CanonicalPaper {
  return {
    ...paper,
    id: paperEntityId(paper)
  };
}

function canonicalizePapers(papers: CanonicalPaper[]): CanonicalPaper[] {
  return papers.map((paper) => canonicalizePaper(paper));
}

function remapReviewWorkflow(
  reviewWorkflow: ResearchSourceSnapshot["reviewWorkflow"],
  canonicalIdByAnyId: Map<string, string>
): ResearchSourceSnapshot["reviewWorkflow"] {
  return {
    ...reviewWorkflow,
    titleScreenedPaperIds: remapPaperIds(reviewWorkflow.titleScreenedPaperIds, canonicalIdByAnyId),
    abstractScreenedPaperIds: remapPaperIds(reviewWorkflow.abstractScreenedPaperIds, canonicalIdByAnyId),
    fulltextScreenedPaperIds: remapPaperIds(reviewWorkflow.fulltextScreenedPaperIds, canonicalIdByAnyId),
    includedPaperIds: remapPaperIds(reviewWorkflow.includedPaperIds, canonicalIdByAnyId),
    excludedPaperIds: remapPaperIds(reviewWorkflow.excludedPaperIds, canonicalIdByAnyId),
    uncertainPaperIds: remapPaperIds(reviewWorkflow.uncertainPaperIds, canonicalIdByAnyId),
    blockedPaperIds: remapPaperIds(reviewWorkflow.blockedPaperIds, canonicalIdByAnyId),
    synthesisPaperIds: remapPaperIds(reviewWorkflow.synthesisPaperIds, canonicalIdByAnyId),
    deferredPaperIds: remapPaperIds(reviewWorkflow.deferredPaperIds, canonicalIdByAnyId)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryFailureKind(error: unknown): string {
  if (error instanceof ResearchBackendError) {
    return error.kind;
  }

  const message = errorMessage(error);

  if (/timeout|aborted/i.test(message)) {
    return "timeout";
  }

  if (/json|parse/i.test(message)) {
    return "malformed_json";
  }

  if (/empty/i.test(message)) {
    return "empty_result";
  }

  return "unexpected";
}

function researchActionDiagnosticKind(error: unknown): ResearchActionDiagnostic["kind"] {
  if (error instanceof ResearchBackendError) {
    return "provider_failure";
  }

  const message = errorMessage(error);
  if (/invalid|unknown|unsupported action/i.test(message)) {
    return "invalid_action";
  }

  return "malformed_action";
}

function referenceFromCanonicalSource(source: ResearchWorkStore["objects"]["canonicalSources"][number]): ReferenceRecord {
  return {
    sourceId: source.id,
    title: source.title,
    authors: source.authors,
    year: source.year,
    venue: source.venue,
    doi: source.identifiers.doi ?? null,
    arxivId: source.identifiers.arxivId ?? null,
    pmid: source.identifiers.pmid ?? null,
    pmcid: source.identifiers.pmcid ?? null,
    url: source.bestAccessUrl,
    citation: source.citation
  };
}

function referencesFromWorkStore(run: RunRecord, store: ResearchWorkStore): ReferencesArtifact {
  const supportReadiness = supportReadinessForWorkspace(store);
  const citedSourceIds = supportReadiness.renderableSourceIds;
  const referenced = store.objects.canonicalSources
    .filter((source) => citedSourceIds.has(source.id))
    .map(referenceFromCanonicalSource);

  return {
    schemaVersion: 1,
    runId: run.id,
    referenceCount: referenced.length,
    references: referenced
  };
}

function workspacePaperArtifact(input: {
  run: RunRecord;
  store: ResearchWorkStore;
  references: ReferencesArtifact;
  readinessStatus: ManuscriptReadinessState;
}): ReviewPaperArtifact {
  const title = stringInput(
    input.run.brief.researchQuestion ?? input.run.brief.topic,
    "Workspace research paper"
  );
  const claims = input.store.objects.claims.map((claim) => ({
    claimId: claim.id,
    claim: claim.text,
    evidence: claim.evidence,
    sourceIds: claim.sourceIds
  }));
  const sections = input.store.objects.manuscriptSections.map((section) => ({
    id: section.id,
    role: section.role,
    title: section.title,
    markdown: section.markdown,
    sourceIds: section.sourceIds,
    claimIds: section.claimIds
  }));
  const citationLinks = input.store.objects.citations.map((citation) => ({
    sourceId: citation.sourceId,
    sourceTitle: citation.sourceTitle,
    evidenceCellId: citation.evidenceCellId,
    supportSnippet: citation.supportSnippet,
    confidence: citation.confidence,
    relevance: citation.relevance,
    claimIds: citation.claimIds,
    sectionIds: citation.sectionIds
  }));
  const limitations = uniqueStrings([
    ...input.store.objects.extractions.flatMap((extraction) => extraction.extraction.limitations),
    ...input.store.objects.claims.flatMap((claim) => claim.risk === null ? [] : [claim.risk]),
    ...input.store.objects.workItems
      .filter((item) => item.status === "open" && item.severity !== "minor")
      .map((item) => item.description)
  ]).slice(0, 20);

  return {
    schemaVersion: 1,
    runId: input.run.id,
    briefFingerprint: briefFingerprint(input.run.brief),
    title,
    abstract: sections.length > 0
      ? "This manuscript export is rendered from durable workspace sections, claims, support links, and references."
      : "No manuscript sections are available for export yet.",
    reviewType: "narrative_review",
    structureRationale: "This artifact is an explicit manuscript.release export from workspace state, not a hidden synthesis step.",
    scientificRoles: ["workspace_export"],
    sections,
    claims,
    citationLinks,
    referencedPaperIds: input.references.references.map((reference) => reference.sourceId),
    evidenceTableIds: input.store.objects.evidenceCells.map((cell) => cell.id),
    limitations,
    readinessStatus: input.readinessStatus
  };
}

function renderWorkspacePaperMarkdown(paper: ReviewPaperArtifact, references: ReferencesArtifact): string {
  const lines = [
    `# ${paper.title}`,
    "",
    "## Abstract",
    "",
    paper.abstract,
    "",
    "## Manuscript Structure",
    "",
    paper.structureRationale,
    ""
  ];

  for (const section of paper.sections) {
    lines.push(`## ${section.title}`, "", section.markdown, "");
  }

  if (paper.claims.length > 0) {
    lines.push("## Claim Ledger", "");
    for (const claim of paper.claims) {
      const sources = claim.sourceIds.length > 0
        ? ` Sources: ${claim.sourceIds.map((sourceId) => `[${sourceId}]`).join(", ")}.`
        : "";
      lines.push(`- ${claim.claim} ${claim.evidence}${sources}`);
    }
    lines.push("");
  }

  if (paper.limitations.length > 0) {
    lines.push("## Limitations", "", ...paper.limitations.map((limitation) => `- ${limitation}`), "");
  }

  lines.push("## References", "");
  if (references.references.length === 0) {
    lines.push("- No renderable references are available from workspace support links.");
  } else {
    for (const reference of references.references) {
      lines.push(`- [${reference.sourceId}] ${reference.citation}`);
    }
  }

  return lines.join("\n");
}

function releaseCheckEntitiesFromChecks(run: RunRecord, checks: ManuscriptCheck[], now: string): WorkStoreReleaseCheck[] {
  return checks.map((check): WorkStoreReleaseCheck => ({
    id: `release-check-${numericTextIdPart(check.id)}-${run.id}`,
    kind: "releaseCheck",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    checkId: check.id,
    title: check.title,
    status: check.status,
    severity: check.severity,
    message: check.message
  }));
}

function manuscriptReadinessFromWorkspace(input: {
  store: ResearchWorkStore;
  checks: ManuscriptCheck[];
}): ManuscriptReadinessState {
  const failedBlockers = input.checks
    .filter((check) => check.status === "fail" && check.severity === "blocker");
  const blockerMessages = failedBlockers.map((check) => check.message).join(" ");
  if (/\b(credential|api key|quota|rate limit|permission|access denied|forbidden|unauthori[sz]ed|paywall|license)\b/i.test(blockerMessages)) {
    return "blocked";
  }
  if (failedBlockers.length > 0) {
    return "needs_human_review";
  }
  return "ready_for_revision";
}

function workspaceManuscriptChecks(input: {
  run: RunRecord;
  store: ResearchWorkStore;
  references: ReferencesArtifact;
}): ManuscriptChecksArtifact {
  const claims = input.store.objects.claims;
  const sections = input.store.objects.manuscriptSections;
  const openBlockingWorkItems = input.store.objects.workItems
    .filter((item) => item.status === "open" && item.severity === "blocking");
  const openExternalBlockers = openBlockingWorkItems
    .filter((item) => item.type === "external_blocker" || item.type === "source_access");
  const supportReadiness = supportReadinessForWorkspace(input.store);
  const unsupportedClaims = claims.filter((claim) => supportReadiness.unsupportedClaimIds.has(claim.id));
  const supportIssueMessages = supportReadiness.issues.map((issue) => issue.message);
  const unsupportedSectionCount = sections.filter((section) => (
    section.claimIds.length === 0 || section.claimIds.some((claimId) => !supportReadiness.supportedClaimIds.has(claimId))
  )).length;
  const evidenceRows = input.store.objects.extractions.length;
  const checks: ManuscriptCheck[] = [
    {
      id: "workspace-sources",
      title: "Workspace has canonical sources",
      status: input.store.objects.canonicalSources.length > 0 ? "pass" : "warning",
      severity: "warning",
      message: input.store.objects.canonicalSources.length > 0
        ? `${input.store.objects.canonicalSources.length} canonical source(s) are available.`
        : "No canonical sources are available in the work store; this is research work to perform, not a hard invariant failure."
    },
    {
      id: "workspace-evidence",
      title: "Workspace has evidence cells",
      status: input.store.objects.evidenceCells.length > 0 ? "pass" : "warning",
      severity: "warning",
      message: input.store.objects.evidenceCells.length > 0
        ? `${input.store.objects.evidenceCells.length} evidence cell(s) are available.`
        : "No evidence cells are available for claim-led synthesis; the researcher can search, read, or extract more."
    },
    {
      id: "evidence-coverage",
      title: "Evidence coverage diagnostic",
      status: evidenceRows >= 3 ? "pass" : "warning",
      severity: "warning",
      message: evidenceRows >= 3
        ? "The workspace has multiple reviewed evidence rows."
        : `Only ${evidenceRows} reviewed evidence row(s) are available. This is a diagnostic for the researcher, not a semantic release blocker.`
    },
    {
      id: "workspace-claims",
      title: "Workspace has claims",
      status: claims.length > 0 ? "pass" : "fail",
      severity: "blocker",
      message: claims.length > 0
        ? `${claims.length} claim(s) are available.`
        : "No claims have been created through claim tools; a manuscript export needs claim objects before release."
    },
    {
      id: "workspace-sections",
      title: "Workspace has manuscript sections",
      status: sections.length > 0 ? "pass" : "fail",
      severity: "blocker",
      message: sections.length > 0
        ? `${sections.length} manuscript section(s) are available.`
        : "No manuscript sections have been created through section tools; a manuscript export needs section objects before release."
    },
    {
      id: "claim-citation-support",
      title: "Claims have citation support",
      status: unsupportedClaims.length === 0 && claims.length > 0 ? "pass" : "fail",
      severity: "blocker",
      message: unsupportedClaims.length === 0 && claims.length > 0
        ? "All manuscript claims have durable evidence-backed support links."
        : claims.length === 0
          ? "No claims exist yet; the researcher should create and support claims before manuscript release."
          : [
            `Unsupported claim count: ${unsupportedClaims.length}.`,
            ...supportIssueMessages.slice(0, 4)
          ].join(" ")
    },
    {
      id: "reference-rendering",
      title: "References resolve from citations",
      status: input.references.referenceCount > 0 ? "pass" : "fail",
      severity: "blocker",
      message: input.references.referenceCount > 0
        ? `${input.references.referenceCount} reference(s) can be rendered from valid support links.`
        : input.store.objects.citations.length > 0 || claims.length > 0
          ? "No references can be rendered from existing workspace support links/citations."
          : "No workspace support links/citations exist yet; a manuscript export needs renderable references before release."
    },
    {
      id: "section-claim-checks",
      title: "Section claim checks passed",
      status: unsupportedSectionCount === 0 && sections.length > 0 ? "pass" : "warning",
      severity: "warning",
      message: unsupportedSectionCount === 0 && sections.length > 0
        ? "All manuscript sections have evidence-backed claim support."
        : `${unsupportedSectionCount} section(s) still need evidence-backed claim support.`
    },
    {
      id: "open-blocking-work-items",
      title: "External blockers",
      status: openExternalBlockers.length === 0 ? openBlockingWorkItems.length === 0 ? "pass" : "warning" : "fail",
      severity: openExternalBlockers.length === 0 ? "warning" : "blocker",
      message: openExternalBlockers.length === 0
        ? openBlockingWorkItems.length === 0
          ? "No open blocking work items remain."
          : `Open non-external blocking work item count: ${openBlockingWorkItems.length}; these are visible research debt, not runtime stop conditions.`
        : `Open external/source-access blocker count: ${openExternalBlockers.length}.`
    }
  ];
  const readinessStatus = manuscriptReadinessFromWorkspace({
    store: input.store,
    checks
  });
  const blockers = checks
    .filter((check) => check.status === "fail" && check.severity === "blocker")
    .map((check) => check.message);

  return {
    schemaVersion: 1,
    runId: input.run.id,
    paperPath: input.run.artifacts.paperPath,
    readinessStatus,
    blockerCount: blockers.length,
    warningCount: checks.filter((check) => check.status === "warning").length,
    checks,
    blockers
  };
}

function workspaceProtocolEntity(store: ResearchWorkStore): WorkStoreProtocol | null {
  return store.objects.protocols
    .slice()
    .reverse()
    .find((protocol) => protocol.author === "researcher")
    ?? store.objects.protocols.slice().reverse()[0]
    ?? null;
}

function neutralReviewProtocolShell(input: Parameters<typeof buildReviewProtocol>[0]): ReviewProtocol {
  const protocol = buildReviewProtocol(input);
  const planAuthoredEvidenceTargets = uniqueStrings(
    input.plan.localFocus.length > 0
      ? input.plan.localFocus
      : [input.plan.objective]
  ).slice(0, 12);

  return {
    ...protocol,
    evidenceTargets: planAuthoredEvidenceTargets,
    qualityAppraisalCriteria: protocol.qualityAppraisalCriteria
      .filter((criterion) => !/facet/i.test(criterion)),
    stoppingConditions: [
      "checkpoint progress without treating a budget boundary as research completion",
      "release only when computable provenance, citation, schema, and export invariants pass",
      "surface semantic concerns as critic diagnostics or work items for the researcher agent"
    ],
    protocolLimitations: uniqueStrings([
      ...protocol.protocolLimitations,
      "This neutral protocol shell preserves model-authored plan fields and runtime provider metadata without deriving required semantic facets from prompt wording."
    ])
  };
}

function reviewProtocolFromWorkspace(input: {
  fallback: ReviewProtocol;
  store: ResearchWorkStore;
}): ReviewProtocol {
  const entity = workspaceProtocolEntity(input.store);
  if (entity === null) {
    return input.fallback;
  }

  return {
    ...input.fallback,
    researchQuestion: entity.researchQuestion ?? input.fallback.researchQuestion,
    objective: entity.objective,
    scope: {
      ...input.fallback.scope,
      coreQuestion: entity.researchQuestion ?? input.fallback.scope.coreQuestion,
      boundaries: entity.scope
    },
    inclusionCriteria: entity.inclusionCriteria,
    exclusionCriteria: entity.exclusionCriteria,
    evidenceTargets: entity.evidenceTargets,
    manuscriptConstraints: entity.manuscriptConstraints,
    manuscriptRequirements: entity.manuscriptConstraints,
    workflowNotes: entity.notes,
    protocolLimitations: [
      ...input.fallback.protocolLimitations,
      `Canonical protocol authored by ${entity.author} workspace object ${entity.id}.`
    ]
  };
}

async function commitWorkStoreSegment(input: {
  store: ResearchWorkStore;
  run: RunRecord;
  plan: ResearchPlan;
  gathered: ResearchSourceSnapshot | null;
  now: string;
}): Promise<ResearchWorkStore> {
  const nextStore = mergeRunSegmentIntoResearchWorkStore(input.store, {
    run: input.run,
    plan: input.plan,
    gathered: input.gathered,
    paperExtractions: [],
    criticReports: [],
    now: input.now
  });

  await writeResearchWorkStore(nextStore);
  if (input.gathered !== null) {
    const canonicalIdByAnyId = canonicalPaperIdMap(input.gathered.canonicalPapers);
    await writeJsonArtifact(input.run.artifacts.literaturePath, {
      schemaVersion: 1,
      runId: input.run.id,
      artifactKind: "source-review-checkpoint",
      storePath: relativeArtifactPath(input.run.projectRoot, researchWorkStoreFilePath(input.run.projectRoot)),
      paperCount: input.gathered.canonicalPapers.length,
      reviewedPaperCount: input.gathered.reviewedPapers.length,
      papers: canonicalizePapers(input.gathered.canonicalPapers),
      reviewedPapers: canonicalizePapers(input.gathered.reviewedPapers),
      reviewWorkflow: remapReviewWorkflow(input.gathered.reviewWorkflow, canonicalIdByAnyId),
      relevanceAssessments: input.gathered.relevanceAssessments ?? [],
      mergeDiagnostics: input.gathered.mergeDiagnostics,
      authStatus: input.gathered.authStatus,
      retrievalDiagnostics: input.gathered.retrievalDiagnostics ?? null,
      stateCounts: summarizeResearchWorkStore(nextStore)
    });
  }
  return nextStore;
}

function failedArtifactStatus(
  run: RunRecord,
  artifactKind: string,
  timestamp: string,
  error: unknown
): ArtifactStatus {
  const backendError = error instanceof ResearchBackendError ? error : null;
  return {
    schemaVersion: 1,
    runId: run.id,
    artifactKind,
    status: "failed",
    stage: run.stage,
    createdAt: run.startedAt ?? run.createdAt,
    updatedAt: timestamp,
    counts: {},
    error: {
      message: errorMessage(error),
      kind: backendError?.kind ?? recoveryFailureKind(error),
      operation: backendError?.operation ?? null
    }
  };
}

async function writeFailureDiagnostics(
  run: RunRecord,
  timestamp: string,
  error: unknown
): Promise<void> {
  const paperStatus = failedArtifactStatus(run, "paper", timestamp, error);
  const checkStatus = failedArtifactStatus(run, "manuscript-checks", timestamp, error);

  await writeJsonArtifact(run.artifacts.paperJsonPath, paperStatus);
  await writeJsonArtifact(run.artifacts.manuscriptChecksPath, checkStatus);
  await writeFile(
    run.artifacts.paperPath,
    [
      "# Review Paper",
      "",
      "No review-paper draft was produced.",
      "",
      `Run failed during ${run.stage}.`,
      `Reason: ${errorMessage(error)}`
    ].join("\n"),
    "utf8"
  );
}

export async function runDetachedJobWorker(options: WorkerOptions): Promise<number> {
  const now = options.now ?? (() => new Date().toISOString());
  const store = new RunStore(options.projectRoot, options.version, now);
  const run = await store.load(options.runId);
  const projectConfigStore = new ProjectConfigStore(options.projectRoot, now);
  const projectConfig = await projectConfigStore.load();
  const researchBackend = options.researchBackend ?? await createProjectResearchBackend({
    projectRoot: options.projectRoot,
    projectConfig,
    timestampFactory: now
  });
  const runtimeLlmConfig = resolveRuntimeLlmConfig(projectConfig);
  const credentialStore = new CredentialStore(options.projectRoot, now);
  const credentials = await credentialStore.load();
  applyCredentialsToEnvironment(credentials);
  let workStore = await loadResearchWorkStore({
    projectRoot: options.projectRoot,
    brief: run.brief,
    now: now()
  });
  const literatureContext = buildLiteratureContextFromWorkStore(workStore);
  const memoryContext = buildProjectMemoryContextFromWorkStore(workStore);
  const scholarlyDiscoveryProviders = selectedProviderIdsForCategory(projectConfig, "scholarlyDiscovery");
  const publisherFullTextProviders = selectedProviderIdsForCategory(projectConfig, "publisherFullText");
  const oaRetrievalHelperProviders = selectedProviderIdsForCategory(projectConfig, "oaRetrievalHelpers");
  const scholarlyProviders = selectedScholarlySourceProviders(projectConfig);
  const generalWebProviders = selectedGeneralWebProviders(projectConfig);
  const localEnabled = projectConfig.sources.localContext.projectFilesEnabled;
  const providerAuthStates = authStatesForSelectedProviders(projectConfig, credentials);
  const previousWorkerState = await loadResearchWorkerState(run.projectRoot)
    ?? createResearchWorkerState({
      projectRoot: run.projectRoot,
      brief: run.brief,
      now: now()
    });

  try {
    run.workerPid = process.pid;
    run.status = "running";
    run.startedAt = run.startedAt ?? now();
    run.statusMessage = "Run worker started and is preparing the model-driven research session.";
    if (run.job.command.length === 0) {
      run.job.command = runLoopCommand(run.id);
    }
    run.job.cwd = run.projectRoot;
    run.job.pid = process.pid;
    run.job.startedAt = now();
    await store.save(run);
    await writeResearchWorkerState({
      ...previousWorkerState,
      projectRoot: run.projectRoot,
      brief: run.brief,
      status: "working",
      activeRunId: run.id,
      lastRunId: run.id,
      updatedAt: now(),
      statusReason: "Autonomous research worker segment is running.",
      userBlockers: []
    });

    await writeRunArtifacts(run);
    await appendEvent(run, now, "summary", "Captured the initial brief in the canonical workspace context.");
    const agent = new AgentStepRecorder(run, now);
    await agent.record({
      actor: "runtime",
      phase: "startup",
      action: "observe_brief_and_project_state",
      status: "started",
      summary: "Initialized run artifacts and loaded project memory, literature memory, providers, and credentials.",
      artifactPaths: [
        run.artifacts.briefPath,
        run.artifacts.agentStatePath,
        run.artifacts.agentStepsPath
      ],
      counts: {
        memoryRecords: memoryContext.recordCount,
        literaturePapers: literatureContext.paperCount,
        openWorkItems: workStore.objects.workItems.filter((item) => item.status === "open").length,
        selectedProviders: scholarlyProviders.length + generalWebProviders.length
      }
    });

    await appendTrace(run, now, "Run worker started.");
    await appendEvent(run, now, "run", "Run worker started.");
    await appendEvent(
      run,
      now,
      "memory",
      memoryContext.available
        ? `Loaded ${memoryContext.recordCount} prior memory records to inform planning and retrieval.`
        : "No prior project memory was available to inform planning and retrieval."
    );
    await appendEvent(
      run,
      now,
      "literature",
      literatureContext.available
        ? `Loaded ${literatureContext.paperCount} prior canonical papers, ${literatureContext.themeCount} theme boards, and ${literatureContext.notebookCount} review notebooks.`
        : "No prior literature memory was available for this run."
    );
    await appendStdout(run, `Research backend: ${researchBackend.label}`);
    await appendStdout(run, `Run loop command: ${run.job.command.join(" ")}`);
    if (run.job.launchCommand !== null) {
      await appendStdout(run, `Launch command: ${run.job.launchCommand.join(" ")}`);
    }
    await appendStdout(run, `Selected scholarly-discovery providers: ${formatSelectedLiteratureProviders(scholarlyDiscoveryProviders)}`);
    await appendStdout(run, `Selected publisher/full-text providers: ${formatSelectedLiteratureProviders(publisherFullTextProviders)}`);
    await appendStdout(run, `Selected OA/retrieval helpers: ${formatSelectedLiteratureProviders(oaRetrievalHelperProviders)}`);
    await appendStdout(run, `Selected general-web providers: ${formatSelectedLiteratureProviders(generalWebProviders)}`);
    await appendStdout(run, `Local context: ${localEnabled ? "enabled" : "disabled"}`);

    for (const authState of providerAuthStates) {
      await appendStdout(
        run,
        `Provider auth: ${authState.definition.label} -> ${authState.status}`
      );
    }

    await appendEvent(run, now, "plan", "Plan the research mode and generate initial retrieval queries.");
    await agent.record({
      phase: "planning",
      action: "plan_next_research_step",
      status: "started",
      summary: "Ask the research model to choose the initial research mode, objective, retrieval queries, and local focus.",
      artifactPaths: [run.artifacts.planPath]
    });

    const localFiles = await collectResearchLocalFileHints(run.projectRoot, run.brief);

    let plan = await researchBackend.planResearch({
      projectRoot: run.projectRoot,
      brief: run.brief,
      localFiles,
      memoryContext,
      literatureContext,
      workerState: previousWorkerState
    }, {
      operation: "planning",
      timeoutMs: runtimeLlmConfig.planningTimeoutMs
    });
    await agent.record({
      phase: "planning",
      action: "write_research_plan",
      status: "completed",
      summary: `Selected ${plan.researchMode} with ${plan.searchQueries.length} initial retrieval queries.`,
      artifactPaths: [run.artifacts.planPath],
      counts: {
        searchQueries: plan.searchQueries.length,
        localFocus: plan.localFocus.length
      }
    });

    const agentActionDiagnostics: ResearchActionDiagnostic[] = [];
    const agentActionTransports: AgentActionTransportRecord[] = [];

    await writeJsonArtifact(run.artifacts.planPath, plan);
    let currentProtocol = reviewProtocolFromWorkspace({
      fallback: neutralReviewProtocolShell({
        run,
        plan,
        scholarlyDiscoveryProviders,
        publisherFullTextProviders,
        oaRetrievalHelperProviders,
        generalWebProviders,
        localContextEnabled: localEnabled
      }),
      store: workStore
    });
    await writeJsonArtifact(run.artifacts.reviewProtocolPath, currentProtocol);
    await writeFile(run.artifacts.reviewProtocolMarkdownPath, `${reviewProtocolMarkdown(currentProtocol)}\n`, "utf8");

    await writeJsonArtifact(run.artifacts.criticProtocolReviewPath, skippedArtifactStatus(
      run,
      "critic-protocol-review",
      now(),
      "Critic review is model-selected; the runtime does not run mandatory semantic critic phases."
    ));
    await appendTrace(run, now, `Selected research mode: ${plan.researchMode}`);
    await appendEvent(run, now, "summary", `Selected research mode ${plan.researchMode}: ${plan.objective}`);
    await appendStdout(run, `Selected research mode: ${plan.researchMode}`);
    await appendStdout(run, `Planning rationale: ${plan.rationale}`);
    await appendEvent(run, now, "next", "Starting model-driven research session from the current workspace state.");

    const sessionSegment = 1;
    await writeJsonArtifact(run.artifacts.planPath, plan);
    await appendEvent(run, now, "literature", `Starting model-driven research session ${sessionSegment}.`);
    await writeSourceToolCheckpoint({
      run,
      now,
      sessionSegment,
      event: {
        phase: "setup",
        status: "started",
        message: `Starting model-driven research session ${sessionSegment}.`
      }
    });

    const sourceRequest: ResearchSourceToolRequest = {
      projectRoot: run.projectRoot,
      brief: run.brief,
      plan,
      memoryContext,
      literatureContext,
      revisionQueries: [],
      criticExcludedPaperIds: [],
      criticPromotedPaperIds: [],
      scholarlyProviderIds: scholarlyProviders,
      generalWebProviderIds: generalWebProviders,
      projectFilesEnabled: localEnabled,
      credentials,
      progress: async (event) => {
        await appendEvent(run, now, sourceProgressEventKind(event), sourceProgressMessage(event));
        if (event.status === "completed" || event.status === "failed" || event.status === "skipped") {
          await appendStdout(run, sourceProgressMessage(event));
        }
        await writeSourceToolCheckpoint({
          run,
          now,
          sessionSegment,
          event
        });
      }
    };
    if (options.sourceToolAdapter !== undefined) {
      await appendEvent(run, now, "summary", "Ignoring injected source tool adapter because the model-driven session executes only model-selected source tools.");
    }
    const sessionOutcome = await runModelDrivenResearchSession({
      run,
      now,
      researchBackend,
      runtimeConfig: runtimeLlmConfig,
      agent,
      sourceRequest,
      diagnostics: agentActionDiagnostics,
      actionTransports: agentActionTransports,
      plan,
      workStore
    });
    workStore = sessionOutcome.workStore;
    const gathered = sessionOutcome.gathered;

    await writeJsonArtifact(run.artifacts.sourcesPath, {
      sourceConfig: {
        scholarlyDiscoveryProviders,
        publisherFullTextProviders,
        oaRetrievalHelperProviders,
        generalWebProviders,
        localContextEnabled: localEnabled,
        configuredCredentials: providerAuthStates
          .filter((state) => state.configuredFieldIds.length > 0)
          .map((state) => ({
            providerId: state.providerId,
            fields: state.configuredFieldIds
          }))
      },
      modelDrivenSession: {
        segment: sessionSegment
      },
      scholarlyProviders,
      generalWebProviders,
      routing: gathered.routing,
      authStatus: gathered.authStatus,
      retrievalDiagnostics: gathered.retrievalDiagnostics ?? null,
      notes: gathered.notes,
      rawSources: gathered.sources,
      reviewWorkflow: gathered.reviewWorkflow,
      relevanceAssessments: gathered.relevanceAssessments ?? [],
      sourceToolState: gathered.sourceToolState ?? null,
      mergeDiagnostics: gathered.mergeDiagnostics,
      literatureReview: gathered.literatureReview ?? null
    });
    await appendTrace(run, now, `Model-driven research session ${sessionSegment} gathered ${gathered.sources.length} raw sources and ${gathered.canonicalPapers.length} canonical papers.`);
    await appendEvent(run, now, "summary", `Model-driven research session ${sessionSegment} observed ${gathered.canonicalPapers.length} canonical papers.`);
    await appendEvent(
      run,
      now,
      "literature",
      `Review workflow: title ${gathered.reviewWorkflow.counts.titleScreened}, abstract ${gathered.reviewWorkflow.counts.abstractScreened}, full-text ${gathered.reviewWorkflow.counts.fulltextScreened}, included ${gathered.reviewWorkflow.counts.included}, selected ${gathered.reviewWorkflow.counts.selectedForSynthesis}.`
    );
    await agent.record({
      phase: "research",
      action: "model_driven_research_session",
      status: "completed",
      summary: `Model-driven research session executed ${sessionOutcome.stepsUsed} researcher-selected action(s).`,
      artifactPaths: [run.artifacts.sourcesPath],
      counts: {
        steps: sessionOutcome.stepsUsed,
        rawSources: gathered.sources.length,
        canonicalPapers: gathered.canonicalPapers.length,
        includedPapers: gathered.reviewWorkflow.counts.included,
        selectedPapers: gathered.reviewWorkflow.counts.selectedForSynthesis
      }
    });

    currentProtocol = reviewProtocolFromWorkspace({
      fallback: neutralReviewProtocolShell({
        run,
        plan,
        scholarlyDiscoveryProviders,
        publisherFullTextProviders,
        oaRetrievalHelperProviders,
        generalWebProviders,
        localContextEnabled: localEnabled,
        gathered
      }),
      store: workStore
    });
    await writeJsonArtifact(run.artifacts.reviewProtocolPath, currentProtocol);
    await writeFile(run.artifacts.reviewProtocolMarkdownPath, `${reviewProtocolMarkdown(currentProtocol)}\n`, "utf8");

    workStore = await commitWorkStoreSegment({
      store: workStore,
      run,
      plan,
      gathered,
      now: now()
    });
    const workStoreSummary = summarizeResearchWorkStore(workStore);
    const explicitlySelectedEvidencePapers = gathered.reviewWorkflow.counts.selectedForSynthesis;
    const includedPapers = workStore.objects.canonicalSources.filter((source) => source.screeningDecision === "include").length;
    const completedAt = now();
    await writeResearchWorkerState({
      ...previousWorkerState,
      projectRoot: run.projectRoot,
      brief: run.brief,
      status: sessionOutcome.workerStatus,
      activeRunId: null,
      lastRunId: run.id,
      segmentCount: (previousWorkerState.segmentCount ?? 0) + 1,
      updatedAt: completedAt,
      statusReason: sessionOutcome.statusReason,
      paperReadiness: sessionOutcome.paperReadiness,
      nextInternalActions: sessionOutcome.nextInternalActions,
      userBlockers: sessionOutcome.userBlockers,
      evidence: {
        canonicalPapers: workStore.objects.canonicalSources.length,
        includedPapers,
        explicitlySelectedEvidencePapers,
        selectedPapers: explicitlySelectedEvidencePapers,
        extractedPapers: workStore.objects.extractions.length,
        evidenceRows: workStore.objects.evidenceCells.length,
        referencedPapers: new Set(workStore.objects.citations.map((citation) => citation.sourceId)).size
      },
      critic: {
        finalSatisfaction: workStore.objects.workItems.some((item) => item.source === "critic" && item.status === "open")
          ? "unresolved"
          : workStore.objects.workItems.some((item) => item.source === "critic")
            ? "pass"
            : null,
        unresolvedStages: [],
        objections: workStore.objects.workItems
          .filter((item) => item.source === "critic" && item.status === "open")
          .map((item) => item.description)
          .slice(0, 12)
      }
    });
    await appendEvent(
      run,
      now,
      "memory",
      `Checkpointed research work store after source/tool actions: ${workStoreSummary.canonicalSources} canonical sources, ${workStoreSummary.extractions} extractions, ${workStoreSummary.evidenceCells} evidence cells.`
    );
    await appendStdout(
      run,
      `Research work store checkpointed: ${workStoreSummary.canonicalSources} canonical sources, ${workStoreSummary.sources} source candidates, ${workStoreSummary.openWorkItems} open work items.`
    );
    await agent.record({
      phase: "checkpoint",
      action: sessionOutcome.checkpointedByBudget ? "checkpoint_budget_exhausted" : sessionOutcome.workerStatus === "release_ready" ? "release_ready" : "checkpoint_workspace_state",
      status: sessionOutcome.checkpointedByBudget ? "warning" : "completed",
      summary: sessionOutcome.statusReason,
      artifactPaths: [
        run.artifacts.sourcesPath,
        researchWorkStoreFilePath(run.projectRoot)
      ],
      counts: {
        canonicalPapers: workStore.objects.canonicalSources.length,
        includedPapers,
        selectedPapers: explicitlySelectedEvidencePapers,
        extractedPapers: workStore.objects.extractions.length,
        evidenceCells: workStore.objects.evidenceCells.length
      }
    });

    run.job.finishedAt = completedAt;
    run.finishedAt = completedAt;
    run.job.exitCode = 0;
    run.job.signal = null;
    run.workerPid = null;
    run.status = sessionOutcome.checkpointedByBudget ? "paused" : "completed";
    run.statusMessage = sessionOutcome.checkpointedByBudget
      ? "Worker segment checkpointed because the model-driven action budget was exhausted; the research objective remains active."
      : sessionOutcome.workerStatus === "release_ready"
        ? "Research objective reached release-ready after explicit model-selected release."
        : `Worker segment exited normally after model-selected action(s); research objective status is ${sessionOutcome.workerStatus}.`;
    await store.save(run);
    await appendEvent(run, now, "run", run.statusMessage);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const externalBlocker = isExternalBlockerMessage(message);
    const finishedAt = now();
    run.job.finishedAt = now();
    run.finishedAt = finishedAt;
    run.job.exitCode = 1;
    run.job.signal = null;
    run.workerPid = null;
    run.status = "failed";
    run.statusMessage = `Run worker failed: ${message}`;
    await store.save(run);
    await writeResearchWorkerState({
      ...previousWorkerState,
      projectRoot: run.projectRoot,
      brief: run.brief,
      status: externalBlocker ? "externally_blocked" : "working",
      activeRunId: null,
      lastRunId: run.id,
      segmentCount: (previousWorkerState.segmentCount ?? 0) + 1,
      updatedAt: finishedAt,
      statusReason: externalBlocker
        ? `Autonomous research worker hit an external blocker: ${message}`
        : `Autonomous research worker segment failed; retry or inspect diagnostics: ${message}`,
      paperReadiness: null,
      nextInternalActions: externalBlocker ? [] : [`Inspect failed run diagnostics and retry the autonomous worker segment: ${message}`],
      userBlockers: externalBlocker ? [message] : [],
      evidence: previousWorkerState.evidence,
      critic: previousWorkerState.critic
    });
    await writeFailureDiagnostics(run, finishedAt, error);
    await appendStderr(run, run.statusMessage);
    await appendTrace(run, now, run.statusMessage);
    await appendEvent(run, now, "stderr", run.statusMessage);
    await appendEvent(run, now, "run", run.statusMessage);
    return 1;
  }
}
