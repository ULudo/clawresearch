import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  createMemoryRecordId,
  MemoryStore,
  type MemoryLink,
  type MemoryRecordInput
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
  ResearchAgenda,
  ResearchBackend,
  ResearchClaim,
  ResearchPlan,
  ResearchSynthesis,
  ResearchTheme,
  ResearchDirectionCandidate
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
  ResearchBackendError,
  type ResearchBackendOperation
} from "./research-backend.js";
import {
  buildEvidenceMatrix,
  briefFingerprint,
  type EvidenceMatrix,
  type EvidenceMatrixInsight,
  type PaperExtraction
} from "./research-evidence.js";
import {
  applyCriticReportsToManuscriptBundle,
  buildReviewProtocol,
  reviewProtocolMarkdown,
  type ManuscriptBundle,
  type ManuscriptCheck,
  type ManuscriptReadinessState,
  type PaperOutline,
  type ReferenceRecord,
  type ReferencesArtifact,
  type ReviewProtocol,
  type ReviewPaperArtifact
} from "./research-manuscript.js";
import {
  criticReviewPassed,
  criticUnavailableReview,
  type CriticReviewArtifact,
  type CriticReviewRequest,
  type CriticReviewStage
} from "./research-critic.js";
import {
  AgenticSourceGatherSession,
  collectResearchLocalFileHints,
  type AgenticSourceState,
  type ResearchSource,
  type ResearchSourceGatherRequest,
  type SourceGatherProgressEvent,
  type ResearchSourceGatherer,
  type ResearchSourceGatherResult
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
  type ResearchWorkerState,
  type ResearchWorkerStatus
} from "./research-state.js";
import type { ResearchBrief } from "./session-store.js";
import {
  verifyResearchClaims,
  type VerificationReport,
  type VerifiedClaim
} from "./verifier.js";
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
  sourceGatherer?: ResearchSourceGatherer;
  runController?: RunController;
};

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

type PaperExtractionsArtifact = {
  schemaVersion: number;
  runId: string;
  briefFingerprint: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  paperCount: number;
  extractionCount: number;
  completedPaperIds?: string[];
  failedPaperIds?: string[];
  batchAttempts?: ExtractionBatchAttempt[];
  extractions: PaperExtraction[];
};

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

type ExtractionBatchAttempt = {
  attempt: number;
  paperIds: string[];
  batchSize: number;
  status: "succeeded" | "failed";
  compact: boolean;
  errorKind: string | null;
  errorMessage: string | null;
  timeoutMs: number;
};

type ClaimsArtifact = {
  schemaVersion: number;
  runId: string;
  briefFingerprint: string;
  claimCount: number;
  claims: ResearchClaim[];
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
    "provider-aware-literature-loop"
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

function sourceProgressEventKind(event: SourceGatherProgressEvent): RunEventKind {
  if (event.status === "failed") {
    return "stderr";
  }

  return event.phase === "provider_query" || event.phase === "screening"
    ? "source"
    : "literature";
}

function sourceProgressMessage(event: SourceGatherProgressEvent): string {
  const provider = event.providerId === undefined ? "" : ` [${event.providerId}]`;
  return `${event.message}${provider}`;
}

async function writeSourceGatherCheckpoint(input: {
  run: RunRecord;
  now: () => string;
  evidencePass: number;
  revisionPasses: number;
  maxRevisionPasses: number;
  event: SourceGatherProgressEvent;
  sourceState?: AgenticSourceState | null;
}): Promise<void> {
  await writeJsonArtifact(input.run.artifacts.sourcesPath, {
    schemaVersion: 1,
    runId: input.run.id,
    status: input.event.phase === "completed" && input.event.status === "completed" ? "completed" : "in_progress",
    stage: "source_gathering",
    updatedAt: input.now(),
    autonomousEvidence: {
      pass: input.evidencePass,
      revisionPasses: input.revisionPasses,
      maxRevisionPasses: input.maxRevisionPasses
    },
    progress: input.event,
    sourceState: input.sourceState ?? null
  });
}

function sourceStateForAgent(session: AgenticSourceGatherSession): ResearchActionRequest["sourceState"] {
  const state = session.state();
  return {
    availableProviderIds: state.availableProviderIds,
    attemptedProviderIds: state.attemptedProviderIds,
    candidateQueries: state.candidateQueries,
    rawSources: state.rawSources,
    screenedSources: state.screenedSources,
    backgroundSources: state.backgroundSources,
    sourceStage: state.sourceStage,
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
  return {
    path: researchWorkStoreFilePath(store.projectRoot),
    summary: summarizeResearchWorkStore(store),
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
  return action === "source.search"
    || action === "search_sources"
    || action === "revise_search_strategy"
    || action === "evidence.revise_strategy";
}

function isSourceMergeAction(action: ResearchActionDecision["action"]): boolean {
  return action === "source.merge" || action === "merge_sources";
}

function isSourceRankAction(action: ResearchActionDecision["action"]): boolean {
  return action === "source.rank" || action === "rank_sources";
}

function isSourceResolveAccessAction(action: ResearchActionDecision["action"]): boolean {
  return action === "source.resolve_access" || action === "resolve_access";
}

function isSourceSelectEvidenceAction(action: ResearchActionDecision["action"]): boolean {
  return action === "source.select_evidence"
    || action === "select_evidence_set"
    || action === "select_sources";
}

function isStatusAction(action: ResearchActionDecision["action"]): boolean {
  return action === "workspace.status" || action === "manuscript.status";
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
    || action === "workspace.unlink"
    || action === "work_store.query"
    || action === "work_store.read"
    || action === "work_store.create"
    || action === "work_store.patch";
}

function isResearchObjectToolAction(action: ResearchActionDecision["action"]): boolean {
  return action === "protocol.create_or_revise"
    || action === "claim.create"
    || action === "claim.patch"
    || action === "claim.revise"
    || action === "claim.check_support"
    || action === "claim.link_support"
    || action === "claim.attach_citation"
    || action === "evidence.update_cell"
    || action === "evidence.find_support"
    || action === "evidence.find_contradictions"
    || action === "section.create"
    || action === "section.read"
    || action === "section.patch"
    || action === "section.link_claim"
    || action === "section.check_claims"
    || action === "work_item.create"
    || action === "work_item.patch"
    || action === "check.run"
    || action === "release.verify"
    || action === "manuscript.read_section"
    || action === "manuscript.patch_section"
    || action === "manuscript.add_paragraph"
    || action === "manuscript.check_section_claims"
    || action === "critic.create_work_item"
    || action === "critic.resolve_work_item";
}

function isReadOnlyWorkspaceAction(action: ResearchActionDecision["action"]): boolean {
  return action === "workspace.search"
    || action === "workspace.read"
    || action === "workspace.list"
    || action === "work_store.query"
    || action === "work_store.read"
    || action === "evidence.find_support"
    || action === "evidence.find_contradictions"
    || action === "section.read"
    || action === "manuscript.read_section"
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
}): WorkStoreEvidenceCell {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const sourceId = stringInput(entity.sourceId, input.decision.inputs.paperIds[0] ?? "unknown-source");
  const field = safeEvidenceCellField(entity.field);
  const value = Array.isArray(entity.value)
    ? stringArrayInput(entity.value, 40)
    : stringInput(entity.value, input.decision.inputs.evidenceTargets.join("; ") || input.decision.expectedOutcome);

  return {
    id: stringInput(entity.id, generatedToolEntityId("evidence-cell", input.run, input.now, `${sourceId}-${field}`)),
    kind: "evidenceCell",
    runId: input.run.id,
    createdAt: input.now,
    updatedAt: input.now,
    sourceId,
    extractionId: stringInput(entity.extractionId, `extraction-${sourceId}`),
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
  const existingMarkdown = input.existing?.markdown ?? "";
  const markdown = input.decision.action === "manuscript.add_paragraph" && existingMarkdown.trim().length > 0
    ? `${existingMarkdown.trim()}\n\n${paragraph}`
    : paragraph;

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

  if (input.decision.action === "workspace.search" || input.decision.action === "workspace.list" || input.decision.action === "work_store.query") {
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
          ? ["claim.create", "workspace.read", "evidence.find_support"]
          : ["workspace.read", "workspace.search"]
      })
    };
  }

  if (input.decision.action === "workspace.read" || input.decision.action === "work_store.read") {
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

  if (input.decision.action === "workspace.patch" || input.decision.action === "work_store.patch") {
    if (collection === null || args.entityId === null || Object.keys(args.changes).length === 0) {
      return {
        handled: true,
        store: input.store,
        message: "Workspace patch skipped because collection, entityId, or changes were missing."
      };
    }

    const existing = readResearchWorkStoreEntity(input.store, collection, args.entityId);
    if (existing === null) {
      return {
        handled: true,
        store: input.store,
        message: `Workspace patch found no ${collection} entity ${args.entityId}.`
      };
    }

    const nextStore = patchResearchWorkStoreEntity(input.store, {
      collection,
      id: args.entityId,
      changes: args.changes
    }, input.now());
    await writeResearchWorkStore(nextStore);
    return {
      handled: true,
      store: nextStore,
      message: `Workspace patched ${collection} entity ${args.entityId}.`
    };
  }

  if (input.decision.action === "workspace.link" || input.decision.action === "workspace.unlink") {
    const link = args.link ?? defaultWorkStoreArgs().link;
    const unlink = input.decision.action === "workspace.unlink";
    const nowText = input.now();
    if (link?.fromCollection === "claims" && link.fromId !== null && link.toId !== null) {
      const claim = readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", link.fromId);
      if (claim === null) {
        return {
          handled: true,
          store: input.store,
          message: `Workspace link found no claim ${link.fromId}.`
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
      return {
        handled: true,
        store: nextStore,
        message: `Workspace ${unlink ? "unlinked" : "linked"} claim ${claim.id} ${unlink ? "from" : "to"} source ${sourceId}.`
      };
    }

    return {
      handled: true,
      store: input.store,
      message: "Workspace link skipped because the requested relation is not a supported primitive yet."
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
  return {
    handled: true,
    store: nextStore,
    message: `Workspace created work item ${workItem.id}.`
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
    return {
      handled: true,
      store: nextStore,
      message: `Researcher-authored protocol ${protocol.id} persisted in the workspace.`
    };
  }

  if (input.decision.action === "critic.create_work_item" || input.decision.action === "work_item.create") {
    const workItem = agentWorkItemFromCreateInput({
      run: input.run,
      now: nowText,
      entity: args.entity,
      decision: input.decision
    });
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, workItem, nowText);
    await writeResearchWorkStore(nextStore);
    return {
      handled: true,
      store: nextStore,
      message: `Critic work item created ${workItem.id}.`
    };
  }

  if (input.decision.action === "critic.resolve_work_item" || input.decision.action === "work_item.patch") {
    const workItemId = args.entityId ?? input.decision.inputs.paperIds[0] ?? null;
    if (workItemId === null) {
      return {
        handled: true,
        store: input.store,
        message: "Critic work item resolution skipped because no work item id was provided."
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
    return {
      handled: true,
      store: nextStore,
      message: `Critic work item resolved ${workItemId}.`
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
    return {
      handled: true,
      store: nextStore,
      message: `Claim created ${claim.id}.`
    };
  }

  if (input.decision.action === "claim.patch" || input.decision.action === "claim.revise") {
    const claimId = args.entityId;
    if (claimId === null) {
      return {
        handled: true,
        store: input.store,
      message: "Claim patch skipped because no claim id was provided."
      };
    }
    const nextStore = patchResearchWorkStoreEntity(input.store, {
      collection: "claims",
      id: claimId,
      changes: args.changes
    }, nowText);
    await writeResearchWorkStore(nextStore);
    return {
      handled: true,
      store: nextStore,
      message: `Claim patched ${claimId}.`
    };
  }

  if (input.decision.action === "claim.check_support") {
    const claimId = args.entityId;
    const claim = claimId === null ? null : readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", claimId);
    if (claim === null) {
      return {
        handled: true,
        store: input.store,
        message: "Claim support check skipped because the claim was not found."
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
    return {
      handled: true,
      store: nextStore,
      message: `Claim support checked ${claim.id}: ${supported ? "supported" : "weak"}.`
    };
  }

  if (input.decision.action === "claim.link_support" || input.decision.action === "claim.attach_citation") {
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
      return {
        handled: true,
        store: input.store,
        message: "Claim support link skipped because claim id or source id was missing."
      };
    }
    const claim = readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", claimId);
    if (claim === null) {
      return {
        handled: true,
        store: input.store,
        message: `Claim support link skipped because claim ${claimId} was not found.`
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
      return {
        handled: true,
        store: input.store,
        message: `Claim support link skipped because claim ${claimId} or evidence cell ${evidenceCellId || "(auto)"} was not available.`
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
    return {
      handled: true,
      store: nextStore,
      message: `Support link attached from ${citation.sourceTitle} to claim ${claimId}.`
    };
  }

  if (input.decision.action === "evidence.update_cell") {
    const cell = evidenceCellFromToolInput({
      run: input.run,
      now: nowText,
      decision: input.decision
    });
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, cell, nowText);
    await writeResearchWorkStore(nextStore);
    return {
      handled: true,
      store: nextStore,
      message: `Evidence cell updated ${cell.id}.`
    };
  }

  if (input.decision.action === "evidence.find_support" || input.decision.action === "evidence.find_contradictions") {
    const timestamp = input.now();
    const semanticQuery = args.semanticQuery ?? input.decision.inputs.evidenceTargets.join(" ");
    const result = queryResearchWorkStore(input.store, {
      collection: "evidenceCells",
      semanticQuery,
      limit: args.limit ?? 12,
      cursor: args.cursor ?? null
    });
    const message = `${input.decision.action} found ${result.count}/${result.totalCount} evidence cell(s).${result.hasMore ? ` More available with cursor ${result.nextCursor}.` : ""}`;
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
        query: {
          semanticQuery,
          limit: args.limit ?? 12,
          cursor: args.cursor ?? null
        },
        count: result.count,
        totalCount: result.totalCount,
        cursor: result.cursor,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        items: result.items.map((entity) => entityPreviewForAgent(entity, input.store)),
        nextHints: ["claim.create", "claim.link_support", "workspace.read"]
      })
    };
  }

  if (input.decision.action === "section.read" || input.decision.action === "manuscript.read_section") {
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

  if (input.decision.action === "section.create" || input.decision.action === "section.patch" || input.decision.action === "manuscript.patch_section" || input.decision.action === "manuscript.add_paragraph") {
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
    return {
      handled: true,
      store: nextStore,
      message: `Section updated ${section.id}.`
    };
  }

  if (input.decision.action === "section.link_claim") {
    const sectionId = args.entityId ?? args.link?.fromId ?? null;
    const claimId = args.link?.toId ?? stringInput(args.entity.claimId, input.decision.inputs.paperIds[0] ?? "");
    const section = sectionId === null ? null : readResearchWorkStoreEntity<WorkStoreManuscriptSection>(input.store, "manuscriptSections", sectionId);
    if (section === null || claimId.length === 0) {
      return {
        handled: true,
        store: input.store,
        message: "Section claim link skipped because section id or claim id was missing."
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
    return {
      handled: true,
      store: nextStore,
      message: `Section ${section.id} linked to claim ${claimId}.`
    };
  }

  if (input.decision.action === "release.verify" || (input.decision.action === "check.run" && args.entityId === null)) {
    const references = referencesFromWorkStore(input.run, input.store);
    const checkBundle = workspaceManuscriptChecks({
      run: input.run,
      store: input.store,
      references
    });
    const releaseChecks = checkBundle.checks.map((check): WorkStoreReleaseCheck => ({
      id: `release-check-${numericTextIdPart(check.id)}-${input.run.id}`,
      kind: "releaseCheck",
      runId: input.run.id,
      createdAt: nowText,
      updatedAt: nowText,
      checkId: check.id,
      title: check.title,
      status: check.status,
      severity: check.severity,
      message: check.message
    }));
    const nextStore = upsertResearchWorkStoreEntities(input.store, releaseChecks, nowText);
    await writeResearchWorkStore(nextStore);
    const hardFailures = releaseChecks.filter((check) => check.status === "fail" && check.severity === "blocker");
    const message = `Release verification wrote ${releaseChecks.length} check(s): ${hardFailures.length} hard invariant blocker(s).`;
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
        collection: "releaseChecks",
        count: releaseChecks.length,
        totalCount: releaseChecks.length,
        items: releaseChecks.map((check) => entityPreviewForAgent(check, nextStore)),
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

  if (input.decision.action === "section.check_claims" || input.decision.action === "manuscript.check_section_claims" || input.decision.action === "check.run") {
    const sectionId = args.entityId;
    const section = sectionId === null ? null : readResearchWorkStoreEntity<WorkStoreManuscriptSection>(input.store, "manuscriptSections", sectionId);
    if (section === null) {
      return {
        handled: true,
        store: input.store,
        message: "Section claim check skipped because the section was not found."
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
    return {
      handled: true,
      store: nextStore,
      message: `Section checked ${section.id}: ${unsupportedClaimIds.length} unsupported claim(s).`
    };
  }

  return {
    handled: true,
    store: input.store,
    message: `${input.decision.action} is recognized but did not require a mutation.`
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
  session: AgenticSourceGatherSession
): SourceProviderId[] {
  const available = new Set(session.state().availableProviderIds);
  return uniqueStrings(decision.inputs.providerIds)
    .flatMap((providerId) => available.has(providerId as SourceProviderId) ? [providerId as SourceProviderId] : []);
}

function sourceQueriesForAction(
  decision: ResearchActionDecision,
  session: AgenticSourceGatherSession
): string[] {
  void session;
  return uniqueStrings(decision.inputs.searchQueries).slice(0, 6);
}

function sourceSearchReconsiderationReason(input: {
  decision: ResearchActionDecision;
  session: AgenticSourceGatherSession;
  providerIds: SourceProviderId[];
  queries: string[];
}): string | null {
  if (!isSourceSearchAction(input.decision.action)) {
    return null;
  }

  const state = input.session.state();
  const exhaustedChosenProviders = input.providerIds.filter((providerId) => input.session.isSearchExhausted(providerId, input.queries));
  const reasons = [
    state.sourceStage !== "querying"
      ? `Source stage is already ${state.sourceStage}; searching again will discard the current canonical review state unless a specific gap requires it.`
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

  const recommended = state.mergeReadiness.recommendedActions.length > 0
    ? `Recommended next source actions: ${state.mergeReadiness.recommendedActions.join(", ")}.`
    : "If you still search, choose a not-yet-exhausted provider/query and name the missing evidence target.";

  return `${reasons.join(" ")} ${recommended}`;
}

async function checkpointAgenticSourceState(input: {
  run: RunRecord;
  now: () => string;
  session: AgenticSourceGatherSession;
  evidencePassNumber: number;
  maxRevisionPasses: number;
  message: string;
}): Promise<void> {
  await writeSourceGatherCheckpoint({
    run: input.run,
    now: input.now,
    evidencePass: input.evidencePassNumber,
    revisionPasses: Math.max(0, input.evidencePassNumber - 1),
    maxRevisionPasses: input.maxRevisionPasses,
    sourceState: input.session.state(),
    event: {
      phase: "provider_query",
      status: "progress",
      message: input.message
    }
  });
}

async function runAgenticSourceGathering(input: {
  run: RunRecord;
  now: () => string;
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
  agent: AgentStepRecorder;
  request: ResearchSourceGatherRequest;
  diagnostics: ResearchActionDiagnostic[];
  actionTransports: AgentActionTransportRecord[];
  evidencePassNumber: number;
  workStore: ResearchWorkStore;
}): Promise<{ gathered: ResearchSourceGatherResult; workStore: ResearchWorkStore }> {
  const {
    run,
    now,
    researchBackend,
    runtimeConfig,
    agent,
    request,
    diagnostics,
    actionTransports,
    evidencePassNumber
  } = input;
  let workStore = input.workStore;
  let toolResults: AgentToolResult[] = [];
  const session = await AgenticSourceGatherSession.create(request);
  const maxSourceToolSteps = 10;

  for (let step = 1; step <= maxSourceToolSteps; step += 1) {
    const state = session.state();
    let decision = await chooseResearchActionStrict({
      run,
      now,
      researchBackend,
      runtimeConfig,
      agent,
      diagnostics,
      actionTransports,
      request: {
        projectRoot: run.projectRoot,
        runId: run.id,
        phase: "source_selection",
        allowedActions: workspaceResearchActions(),
        brief: run.brief,
        plan: request.plan,
        observations: {
          canonicalPapers: state.canonicalPapers,
          selectedPapers: state.selectedPapers,
          extractedPapers: 0,
          evidenceRows: 0,
          evidenceInsights: 0,
          manuscriptReadiness: null,
          revisionPassesUsed: evidencePassNumber - 1,
          revisionPassesRemaining: Math.max(0, runtimeConfig.evidenceRecoveryMaxPasses - (evidencePassNumber - 1))
        },
        sourceState: sourceStateForAgent(session),
        workStore: workStoreContextForAgent(workStore),
        guidance: guidanceContextForAgent({ brief: run.brief, plan: request.plan }),
        toolResults,
        criticReports: [],
        retryInstruction: [
          "Use the stable workspace tool surface. The source_selection milestone is progress context, not a restricted menu.",
          "Use source.search with providerIds and searchQueries to query specific databases.",
          "Use source.merge, source.rank, source.resolve_access, and source.select_evidence when those operations fit the current work-store/source state.",
          "Use workspace.search/read/list/patch/create when you need to inspect or update durable research state before choosing a source operation.",
          "Do not ask the runtime to query every provider unless the observations justify it."
        ].join(" ")
      }
    });
    let providers = validSourceProviderChoices(decision, session);
    let queries = sourceQueriesForAction(decision, session);
    const reconsiderationReason = sourceSearchReconsiderationReason({
      decision,
      session,
      providerIds: providers,
      queries
    });

    if (reconsiderationReason !== null) {
      await appendEvent(run, now, "next", `Source dashboard asks the research agent to reconsider a low-yield search: ${reconsiderationReason}`);
      await appendStdout(run, `Source dashboard: ${reconsiderationReason}`);
      decision = await chooseResearchActionStrict({
        run,
        now,
        researchBackend,
        runtimeConfig,
        agent,
        diagnostics,
        actionTransports,
        request: {
          projectRoot: run.projectRoot,
          runId: run.id,
          phase: "source_selection",
          allowedActions: workspaceResearchActions(),
          brief: run.brief,
          plan: request.plan,
          observations: {
            canonicalPapers: session.state().canonicalPapers,
            selectedPapers: session.state().selectedPapers,
            extractedPapers: 0,
            evidenceRows: 0,
            evidenceInsights: 0,
            manuscriptReadiness: null,
            revisionPassesUsed: evidencePassNumber - 1,
            revisionPassesRemaining: Math.max(0, runtimeConfig.evidenceRecoveryMaxPasses - (evidencePassNumber - 1))
          },
          sourceState: sourceStateForAgent(session),
          workStore: workStoreContextForAgent(workStore),
          guidance: guidanceContextForAgent({ brief: run.brief, plan: request.plan }),
          toolResults,
          criticReports: [],
          retryInstruction: [
            reconsiderationReason,
            "You may still choose source.search, but only with a provider/query combination that is not exhausted and a concrete missing evidence target.",
            "If the current screened sources are enough for this pass, choose source.merge, source.rank, source.resolve_access, or source.select_evidence."
          ].join(" ")
        }
      });
      providers = validSourceProviderChoices(decision, session);
      queries = sourceQueriesForAction(decision, session);
    }

    const workStoreExecution = await executeWorkspaceToolAction({
      run,
      now,
      decision,
      store: workStore
    });
    if (workStoreExecution.handled) {
      workStore = workStoreExecution.store;
      toolResults = rememberAgentToolResult(toolResults, workStoreExecution.result);
      if (workStoreExecution.message !== null) {
        await appendEvent(run, now, "memory", workStoreExecution.message);
        await appendStdout(run, `Work store tool observation: ${workStoreExecution.message}`);
      }
      continue;
    }

    if (isSourceMergeAction(decision.action)) {
      const observation = await session.mergeSources();
      await appendEvent(run, now, "source", observation.message);
      await appendStdout(run, `Source tool observation: ${observation.message}`);
      await checkpointAgenticSourceState({
        run,
        now,
        session,
        evidencePassNumber,
        maxRevisionPasses: runtimeConfig.evidenceRecoveryMaxPasses,
        message: observation.message
      });
      continue;
    }

    if (isSourceRankAction(decision.action)) {
      const observation = await session.rankSources();
      await appendEvent(run, now, "source", observation.message);
      await appendStdout(run, `Source tool observation: ${observation.message}`);
      await checkpointAgenticSourceState({
        run,
        now,
        session,
        evidencePassNumber,
        maxRevisionPasses: runtimeConfig.evidenceRecoveryMaxPasses,
        message: observation.message
      });
      continue;
    }

    if (isSourceResolveAccessAction(decision.action)) {
      const observation = await session.resolveAccess(decision.inputs.paperIds);
      await appendEvent(run, now, "source", observation.message);
      await appendStdout(run, `Source tool observation: ${observation.message}`);
      await checkpointAgenticSourceState({
        run,
        now,
        session,
        evidencePassNumber,
        maxRevisionPasses: runtimeConfig.evidenceRecoveryMaxPasses,
        message: observation.message
      });
      continue;
    }

    if (isSourceSelectEvidenceAction(decision.action)) {
      const observation = await session.selectEvidenceSet(decision.inputs.paperIds);
      await appendEvent(run, now, "source", observation.message);
      await appendStdout(run, `Source tool observation: ${observation.message}`);
      await checkpointAgenticSourceState({
        run,
        now,
        session,
        evidencePassNumber,
        maxRevisionPasses: runtimeConfig.evidenceRecoveryMaxPasses,
        message: observation.message
      });
      return {
        gathered: await session.result(),
        workStore
      };
    }

    if (isStatusAction(decision.action)) {
      await appendEvent(run, now, "next", "Research agent ended source tool loop with a status-report action; selecting from gathered sources.");
      return {
        gathered: await session.result(),
        workStore
      };
    }

    if (!isSourceSearchAction(decision.action)) {
      await appendEvent(
        run,
        now,
        "next",
        `Research agent chose ${decision.action}, but the source milestone has no direct executor for that tool yet; continuing with source state inspection.`
      );
      await appendStdout(
        run,
        `Source tool observation: ${decision.action} is not directly executable before an evidence set exists; choose a source or workspace tool next.`
      );
      continue;
    }

    if (queries.length === 0) {
      const message = "Source search skipped because the researcher did not provide explicit search query text.";
      await appendEvent(run, now, "next", message);
      await appendStdout(run, `Source tool observation: ${message}`);
      continue;
    }

    const fallbackProvider = session.state().availableProviderIds
      .find((providerId) => !session.state().attemptedProviderIds.includes(providerId));
    const providerOrder = providers.length > 0
      ? providers
      : fallbackProvider === undefined ? [] : [fallbackProvider];

    if (providerOrder.length === 0) {
      await appendEvent(run, now, "next", "No unused source provider remained for the agentic source loop; selecting from gathered sources.");
      return {
        gathered: await session.result(),
        workStore
      };
    }

    const executableProviderOrder = providerOrder
      .filter((providerId) => !session.isSearchExhausted(providerId, queries));

    if (executableProviderOrder.length === 0 && session.state().mergeReadiness.ready) {
      await appendEvent(run, now, "next", "All chosen source searches are low-yield or exhausted; using the current screened sources for canonical merge.");
      const observation = await session.mergeSources();
      await appendEvent(run, now, "source", observation.message);
      await appendStdout(run, `Source tool observation: ${observation.message}`);
      await checkpointAgenticSourceState({
        run,
        now,
        session,
        evidencePassNumber,
        maxRevisionPasses: runtimeConfig.evidenceRecoveryMaxPasses,
        message: observation.message
      });
      continue;
    }

    if (executableProviderOrder.length === 0) {
      await appendEvent(run, now, "next", "No executable source search target remained after the source dashboard filtered low-yield choices; selecting from gathered sources.");
      return {
        gathered: await session.result(),
        workStore
      };
    }

    for (const providerId of executableProviderOrder.slice(0, 2)) {
      const observation = await session.queryProvider(providerId, queries);
      await appendEvent(run, now, "source", observation.message);
      await appendStdout(run, `Source tool observation: ${observation.message}`);
      await checkpointAgenticSourceState({
        run,
        now,
        session,
        evidencePassNumber,
        maxRevisionPasses: runtimeConfig.evidenceRecoveryMaxPasses,
        message: observation.message
      });
    }
  }

  await appendEvent(run, now, "next", "Agentic source tool loop reached its step budget; selecting from gathered sources.");
  return {
    gathered: await session.result(),
    workStore
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

function paperExtractionsArtifact(
  run: RunRecord,
  paperCount: number,
  extractions: PaperExtraction[],
  options: {
    status?: "pending" | "in_progress" | "completed" | "failed";
    completedPaperIds?: string[];
    failedPaperIds?: string[];
    batchAttempts?: ExtractionBatchAttempt[];
  } = {}
): PaperExtractionsArtifact {
  return {
    schemaVersion: 1,
    runId: run.id,
    briefFingerprint: briefFingerprint(run.brief),
    status: options.status ?? (extractions.length >= paperCount ? "completed" : "in_progress"),
    paperCount,
    extractionCount: extractions.length,
    completedPaperIds: options.completedPaperIds ?? extractions.map((extraction) => extraction.paperId),
    failedPaperIds: options.failedPaperIds ?? [],
    batchAttempts: options.batchAttempts ?? [],
    extractions
  };
}

function claimsArtifact(run: RunRecord, claims: ResearchClaim[]): ClaimsArtifact {
  return {
    schemaVersion: 1,
    runId: run.id,
    briefFingerprint: briefFingerprint(run.brief),
    claimCount: claims.length,
    claims
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

const recoveryQueryStopWords = new Set([
  "about",
  "after",
  "against",
  "also",
  "and",
  "are",
  "because",
  "before",
  "between",
  "comprehensive",
  "comprehensiveness",
  "could",
  "does",
  "evidence",
  "expected",
  "from",
  "have",
  "high-quality",
  "into",
  "including",
  "meet",
  "meets",
  "more",
  "needs",
  "paper",
  "papers",
  "review",
  "reviewed",
  "selected",
  "should",
  "source",
  "sources",
  "standard",
  "standards",
  "that",
  "the",
  "this",
  "typically",
  "search",
  "with"
]);

function normalizedRecoveryQueryKey(query: string): string {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function isFileLikeResearchTerm(text: string): boolean {
  const compact = text.trim();
  return /(^|[/\\])[\w.-]+\.(txt|md|json|jsonl|log|csv|ts|tsx|js|jsx|py|yaml|yml)$/i.test(compact)
    || /^[\w.-]+\.(txt|md|json|jsonl|log|csv|ts|tsx|js|jsx|py|yaml|yml)$/i.test(compact);
}

function isUnsafeRevisionQueryText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return true;
  }

  return [
    /\bdid not provide (?:a )?structured objection\b/i,
    /\brevise the prior research stage\b/i,
    /\bmore focused evidence before release\b/i,
    /\bcritic review was unavailable\b/i,
    /\bworking critic backend\b/i,
    /\bbefore releasing a full manuscript\b/i,
    /\bfull manuscript\b/i,
    /\bstatus-only\b/i,
    /\bquality report\b/i,
    /\bmanuscript checks?\b/i,
    /\bpaper artifacts?\b/i,
    /\b(?:protocol|source-selection|source selection|evidence|release) critic (?:did not pass|returned|still had concerns)\b/i
  ].some((pattern) => pattern.test(compact));
}

function compactRecoveryQuery(text: string | null | undefined, limit = 12): string | null {
  if (typeof text !== "string") {
    return null;
  }
  if (isFileLikeResearchTerm(text)) {
    return null;
  }
  if (isUnsafeRevisionQueryText(text)) {
    return null;
  }

  const queryText = text
    .replace(/^\s*(?:search|find|retrieve|collect|seek)\s+(?:for\s+)?/i, "")
    .replace(/^\s*(?:run|rerun)\s+retrieval\s+(?:with|for)\s+/i, "");
  const tokens = queryText.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
  const filtered = tokens
    .filter((token) => token.length > 1)
    .filter((token) => !recoveryQueryStopWords.has(token));

  const compact = filtered.length > 0 ? filtered.slice(0, limit).join(" ") : null;
  return compact !== null
    && !isUnsafeRevisionQueryText(compact)
    ? compact
    : null;
}

function stripRecoveryQueryCommand(text: string): string {
  return text
    .replace(/^\s*(?:search|find|retrieve|collect|seek)\s+(?:for\s+)?/i, "")
    .replace(/^\s*(?:run|rerun)\s+retrieval\s+(?:with|for)\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?;:]+$/g, "")
    .trim();
}

function sanitizeRecoveryQuery(query: string | null | undefined, limit = 12): string | null {
  if (typeof query !== "string") {
    return null;
  }
  if (isFileLikeResearchTerm(query) || isUnsafeRevisionQueryText(query)) {
    return null;
  }

  const direct = stripRecoveryQueryCommand(query);
  if (
    direct.length > 0
    && !isFileLikeResearchTerm(direct)
    && !isUnsafeRevisionQueryText(direct)
  ) {
    const tokenCount = direct.match(/[a-z0-9][a-z0-9-]*/gi)?.length ?? 0;
    const looksLikeDiagnosticSentence = /\b(?:lacks?|missing|needs?|should|revise|revised?|prior|stage|release|manuscript|artifact|critic)\b/i.test(direct);

    if (tokenCount > 1 && tokenCount <= limit && !looksLikeDiagnosticSentence) {
      return direct;
    }
  }

  const compact = compactRecoveryQuery(direct, limit);
  return compact === null ? null : compact;
}

function sanitizeRecoveryQueries(queries: Array<string | null | undefined>, limit = 12): string[] {
  return uniqueStrings(queries.flatMap((query) => {
    const sanitized = sanitizeRecoveryQuery(query, limit);
    return sanitized === null ? [] : [sanitized];
  }));
}

function evidenceRecoveryPlanUpdate(
  plan: ResearchPlan,
  queries: string[],
  focusTerms: string[]
): { plan: ResearchPlan; recoveryQueries: string[] } | null {
  const existingQueryKeys = new Set(plan.searchQueries.map(normalizedRecoveryQueryKey));
  const recoveryQueries = sanitizeRecoveryQueries(queries, 12)
    .filter((query) => !existingQueryKeys.has(normalizedRecoveryQueryKey(query)))
    .slice(0, 12);

  if (recoveryQueries.length === 0) {
    return null;
  }

  const rationaleSuffix = "Autonomous evidence revision may expand retrieval when manuscript checks require more evidence.";

  return {
    recoveryQueries,
    plan: {
      ...plan,
      rationale: plan.rationale.includes(rationaleSuffix)
        ? plan.rationale
        : `${plan.rationale} ${rationaleSuffix}`,
      searchQueries: uniqueStrings([...plan.searchQueries, ...recoveryQueries]).slice(0, 28),
      localFocus: uniqueStrings([...plan.localFocus, ...focusTerms])
        .filter((focus) => compactRecoveryQuery(focus, 8) !== null)
        .slice(0, 16)
    }
  };
}

function evidenceRecoveryBudgetExhausted(startedAtMs: number, runtimeConfig: RuntimeLlmConfig): boolean {
  return Date.now() - startedAtMs >= runtimeConfig.totalRecoveryBudgetMs;
}

function criticArtifactPath(run: RunRecord, stage: CriticReviewStage): string {
  switch (stage) {
    case "protocol":
      return run.artifacts.criticProtocolReviewPath;
    case "source_selection":
      return run.artifacts.criticSourceSelectionPath;
    case "evidence":
      return run.artifacts.criticEvidenceReviewPath;
    case "release":
      return run.artifacts.criticReleaseReviewPath;
  }
}

function criticStructuredRetryNeeded(report: CriticReviewArtifact): boolean {
  return report.readiness !== "pass"
    && report.objections.length === 1
    && report.objections[0]?.code === `critic-${report.stage}-nonpass`;
}

function criticRevisionIsActionable(report: CriticReviewArtifact): boolean {
  if (criticReviewPassed(report)) {
    return true;
  }

  const substantiveObjections = report.objections.filter((objection) => (
    objection.code !== `critic-${report.stage}-nonpass`
    && !isUnsafeRevisionQueryText(objection.message)
    && (objection.suggestedRevision === null || !isUnsafeRevisionQueryText(objection.suggestedRevision))
  ));
  const actionableText = [
    ...report.revisionAdvice.searchQueries,
    ...report.revisionAdvice.evidenceTargets,
    ...report.revisionAdvice.claimsToSoften,
    ...report.objections.flatMap((objection) => objection.suggestedRevision === null ? [] : [objection.suggestedRevision])
  ].some((text) => !isUnsafeRevisionQueryText(text) && compactRecoveryQuery(text, 8) !== null);
  const actionableSourceSetChange = report.revisionAdvice.papersToExclude.length > 0
    || report.revisionAdvice.papersToPromote.length > 0;

  return substantiveObjections.length > 0 || actionableText || actionableSourceSetChange;
}

async function reviewWithCritic(input: {
  run: RunRecord;
  now: () => string;
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
  request: CriticReviewRequest;
}): Promise<CriticReviewArtifact> {
  const { run, now, researchBackend, runtimeConfig, request } = input;
  await appendEvent(run, now, "next", `Run ${request.stage.replace(/_/g, " ")} critic review.`);

  try {
    let report = await researchBackend.reviewResearchArtifact(request, {
      operation: "critic",
      timeoutMs: runtimeConfig.criticTimeoutMs
    });
    if (criticStructuredRetryNeeded(report) && request.retryInstruction === undefined) {
      await appendEvent(
        run,
        now,
        "next",
        `${request.stage.replace(/_/g, " ")} critic returned no structured objections; retrying once for precise feedback.`
      );
      report = await researchBackend.reviewResearchArtifact({
        ...request,
        retryInstruction: "Your previous critic response did not include structured objections. Return JSON with concrete objections, precise affected criteria or paper IDs when known, and actionable revision advice. If no severe issue remains, return pass."
      }, {
        operation: "critic",
        timeoutMs: runtimeConfig.criticTimeoutMs
      });
    }
    await writeJsonArtifact(criticArtifactPath(run, request.stage), report);
    await appendEvent(
      run,
      now,
      report.readiness === "pass" ? "summary" : "stderr",
      `${request.stage.replace(/_/g, " ")} critic returned ${report.readiness}.`
    );
    for (const objection of report.objections.slice(0, 4)) {
      await appendStdout(run, `Critic ${request.stage}: ${objection.severity} - ${objection.message}`);
    }
    return report;
  } catch (error) {
    const report = criticUnavailableReview(request, errorMessage(error));
    await writeJsonArtifact(criticArtifactPath(run, request.stage), report);
    await appendEvent(run, now, "stderr", `${request.stage.replace(/_/g, " ")} critic unavailable: ${errorMessage(error)}`);
    await appendStdout(run, `Critic ${request.stage} unavailable: ${errorMessage(error)}`);
    return report;
  }
}

function researchActionDiagnosticKind(error: unknown): ResearchActionDiagnostic["kind"] {
  if (error instanceof ResearchBackendError) {
    return error.kind === "malformed_json" ? "malformed_action" : "provider_failure";
  }

  return /action/i.test(errorMessage(error)) ? "invalid_action" : "provider_failure";
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

async function runProtocolWorkspaceLoop(input: {
  run: RunRecord;
  now: () => string;
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
  agent: AgentStepRecorder;
  diagnostics: ResearchActionDiagnostic[];
  actionTransports: AgentActionTransportRecord[];
  plan: ResearchPlan;
  workStore: ResearchWorkStore;
}): Promise<ResearchWorkStore> {
  let workStore = input.workStore;
  let toolResults: AgentToolResult[] = [];
  const maxToolSteps = 4;

  if (workspaceProtocolEntity(workStore) !== null) {
    return workStore;
  }

  await appendEvent(input.run, input.now, "memory", "Ask the research agent to author the durable ResearchProtocol workspace object.");

  for (let step = 1; step <= maxToolSteps; step += 1) {
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
        phase: "protocol",
        allowedActions: workspaceResearchActions(),
        brief: input.run.brief,
        plan: input.plan,
        observations: {
          canonicalPapers: workStore.objects.canonicalSources.length,
          selectedPapers: 0,
          extractedPapers: workStore.objects.extractions.length,
          evidenceRows: workStore.objects.evidenceCells.length,
          evidenceInsights: 0,
          manuscriptReadiness: null,
          revisionPassesUsed: 0,
          revisionPassesRemaining: input.runtimeConfig.evidenceRecoveryMaxPasses
        },
        workStore: workStoreContextForAgent(workStore),
        guidance: guidanceContextForAgent({ brief: input.run.brief, plan: input.plan }),
        toolResults,
        criticReports: [],
        retryInstruction: [
          "Create or revise the model-authored ResearchProtocol as durable workspace state before provider/source work begins.",
          "Use protocol.create_or_revise when the current brief and plan are enough to define scope, inclusion/exclusion criteria, evidence targets, and manuscript constraints.",
          "Guidance and workspace read/list/search tools may be used first if you need inspectable context.",
          "Do not turn output-style requirements into evidence targets; semantic choices belong in the protocol object and can be revised later."
        ].join(" ")
      }
    });

    if (isStatusAction(decision.action)) {
      const message = decision.inputs.reason ?? decision.rationale;
      await appendEvent(input.run, input.now, "next", `Research agent did not author a protocol yet: ${message}`);
      await appendStdout(input.run, `Protocol tool observation: ${message}`);
      break;
    }

    const protocolStageExecutable = isGuidanceToolAction(decision.action)
      || isWorkStoreToolAction(decision.action)
      || decision.action === "protocol.create_or_revise"
      || decision.action === "work_item.create"
      || decision.action === "work_item.patch";

    if (!protocolStageExecutable) {
      const timestamp = input.now();
      const message = `${decision.action} was deferred until a ResearchProtocol exists.`;
      const result = makeAgentToolResult({
        run: input.run,
        action: decision.action,
        timestamp,
        status: "noop",
        readOnly: true,
        message,
        count: 0,
        totalCount: 0,
        nextHints: ["protocol.create_or_revise", "guidance.recommend", "workspace.read"]
      });
      toolResults = rememberAgentToolResult(toolResults, result);
      await appendEvent(input.run, input.now, "next", message);
      await appendStdout(input.run, `Protocol tool observation: ${message}`);
      continue;
    }

    const execution = await executeWorkspaceToolAction({
      run: input.run,
      now: input.now,
      decision,
      store: workStore
    });

    if (execution.handled) {
      workStore = execution.store;
      toolResults = rememberAgentToolResult(toolResults, execution.result);
      if (execution.message !== null) {
        await appendEvent(input.run, input.now, "memory", execution.message);
        await appendStdout(input.run, `Protocol tool observation: ${execution.message}`);
      }
      if (workspaceProtocolEntity(workStore) !== null) {
        await input.agent.record({
          phase: "protocol",
          action: "persist_research_protocol",
          status: "completed",
          summary: "Researcher-authored protocol is now canonical workspace state.",
          artifactPaths: [
            researchWorkStoreFilePath(input.run.projectRoot),
            input.run.artifacts.reviewProtocolPath
          ],
          counts: {
            protocols: workStore.objects.protocols.length
          }
        });
        return workStore;
      }
      continue;
    }

    const message = `${decision.action} is not executable during the protocol checkpoint.`;
    const result = makeAgentToolResult({
      run: input.run,
      action: decision.action,
      timestamp: input.now(),
      status: "noop",
      readOnly: true,
      message,
      count: 0,
      totalCount: 0,
      nextHints: ["protocol.create_or_revise"]
    });
    toolResults = rememberAgentToolResult(toolResults, result);
    await appendEvent(input.run, input.now, "next", message);
    await appendStdout(input.run, `Protocol tool observation: ${message}`);
  }

  await appendEvent(
    input.run,
    input.now,
    "memory",
    "No researcher-authored protocol was persisted during the protocol checkpoint; using a neutral model-plan protocol shell without runtime-derived semantic requirements."
  );
  return workStore;
}

async function runManuscriptWorkspaceLoop(input: {
  run: RunRecord;
  now: () => string;
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
  agent: AgentStepRecorder;
  diagnostics: ResearchActionDiagnostic[];
  actionTransports: AgentActionTransportRecord[];
  plan: ResearchPlan;
  gathered: ResearchSourceGatherResult;
  paperExtractions: PaperExtraction[];
  evidenceMatrix: EvidenceMatrix;
  workStore: ResearchWorkStore;
  revisionPassesUsed: number;
}): Promise<{
  workStore: ResearchWorkStore;
  requestedRevision: boolean;
  revisionQueries: string[];
  revisionFocusTerms: string[];
  stopReason: string | null;
}> {
  let workStore = input.workStore;
  let toolResults: AgentToolResult[] = [];
  let consecutiveReadOnlyActions = 0;
  const maxToolSteps = 12;

  for (let step = 1; step <= maxToolSteps; step += 1) {
    const citationRepair = repairWorkspaceCitationsFromClaimSources({
      run: input.run,
      now: input.now(),
      store: workStore
    });
    if (citationRepair.repairedCount > 0) {
      workStore = citationRepair.store;
      await writeResearchWorkStore(workStore);
      await appendEvent(input.run, input.now, "memory", `Repaired ${citationRepair.repairedCount} missing workspace citation/support link(s) from claim source ids.`);
      await appendStdout(input.run, `Workspace citation repair: ${citationRepair.repairedCount} support link(s) created from existing claim-source provenance.`);
    }

    const checks = workspaceManuscriptChecks({
      run: input.run,
      store: workStore,
      references: referencesFromWorkStore(input.run, workStore),
      gathered: input.gathered,
      evidenceMatrix: input.evidenceMatrix
    });
    if (checks.readinessStatus === "ready_for_revision") {
      await appendEvent(input.run, input.now, "summary", "Workspace manuscript checks passed; release review can run.");
      return {
        workStore,
        requestedRevision: false,
        revisionQueries: [],
        revisionFocusTerms: [],
        stopReason: null
      };
    }

    const readOnlyProgressInstruction = consecutiveReadOnlyActions >= 3
      ? [
        `${consecutiveReadOnlyActions} consecutive read-only workspace actions have already returned agent-visible tool results.`,
        "Use those returned ids, extraction/evidence previews, snippets, and source titles to mutate the workspace with claim.create, claim.link_support, section.create, section.link_claim, section.check_claims, work_item.patch, or read one specific entity id if a precise drill-down is needed.",
        "Do not repeat another broad workspace.list/search/read unless the query is materially narrower and uses a cursor or entity id from recent tool results."
      ].join(" ")
      : null;
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
        phase: "synthesis",
        allowedActions: workspaceResearchActions(),
        brief: input.run.brief,
        plan: input.plan,
        observations: {
          canonicalPapers: input.gathered.canonicalPapers.length,
          selectedPapers: input.gathered.reviewedPapers.length,
          extractedPapers: input.paperExtractions.length,
          evidenceRows: input.evidenceMatrix.rowCount,
          evidenceInsights: input.evidenceMatrix.derivedInsights.length,
          manuscriptReadiness: checks.readinessStatus,
          revisionPassesUsed: input.revisionPassesUsed,
          revisionPassesRemaining: Math.max(0, input.runtimeConfig.evidenceRecoveryMaxPasses - input.revisionPassesUsed)
        },
        workStore: workStoreContextForAgent(workStore),
        guidance: guidanceContextForAgent({ brief: input.run.brief, plan: input.plan }),
        toolResults,
        criticReports: [],
        retryInstruction: [
          "Construct the manuscript through first-class research objects only.",
          "Use claim.create/patch/check_support/link_support, section.create/read/patch/link_claim/check_claims, work_item.create/patch, and workspace.search/read/list/link.",
          "Do not choose old high-level synthesis or report-writing actions.",
          "Use source.search only when the workspace lacks evidence that can be gathered autonomously.",
          "Use workspace.status only for a genuine external blocker.",
          readOnlyProgressInstruction
        ].filter((instruction): instruction is string => instruction !== null).join(" ")
      }
    });

    if (decision.action === "source.search" || decision.action === "evidence.revise_strategy") {
      const revisionQueries = uniqueStrings(decision.inputs.searchQueries);
      if (revisionQueries.length === 0) {
        const timestamp = input.now();
        const result = makeAgentToolResult({
          run: input.run,
          action: decision.action,
          timestamp,
          status: "noop",
          readOnly: true,
          message: "Source revision skipped because the researcher did not provide explicit search query text.",
          count: 0,
          totalCount: 0,
          nextHints: ["source.search", "workspace.search", "work_item.create"]
        });
        toolResults = rememberAgentToolResult(toolResults, result);
        await appendEvent(input.run, input.now, "next", result.message);
        await appendStdout(input.run, `Workspace tool observation: ${result.message}`);
        continue;
      }
      return {
        workStore,
        requestedRevision: true,
        revisionQueries,
        revisionFocusTerms: decision.inputs.evidenceTargets,
        stopReason: decision.rationale
      };
    }

    if (isStatusAction(decision.action)) {
      return {
        workStore,
        requestedRevision: false,
        revisionQueries: [],
        revisionFocusTerms: [],
        stopReason: decision.inputs.reason ?? decision.rationale
      };
    }

    if (decision.action === "manuscript.release") {
      return {
        workStore,
        requestedRevision: false,
        revisionQueries: [],
        revisionFocusTerms: [],
        stopReason: null
      };
    }

    const execution = await executeWorkspaceToolAction({
      run: input.run,
      now: input.now,
      decision,
      store: workStore
    });

    if (execution.handled) {
      workStore = execution.store;
      toolResults = rememberAgentToolResult(toolResults, execution.result);
      consecutiveReadOnlyActions = isReadOnlyWorkspaceAction(decision.action)
        ? consecutiveReadOnlyActions + 1
        : 0;
      if (execution.message !== null) {
        await appendEvent(input.run, input.now, "memory", execution.message);
        await appendStdout(input.run, `Workspace tool observation: ${execution.message}`);
      }
      continue;
    }

    await appendEvent(input.run, input.now, "next", `No workspace executor is available for ${decision.action}; asking for another first-class tool.`);
  }

  return {
    workStore,
    requestedRevision: false,
    revisionQueries: [],
    revisionFocusTerms: [],
    stopReason: "The manuscript workspace loop reached its tool-step budget before release checks passed."
  };
}

function emptyGatheredResult(plan: ResearchPlan): ResearchSourceGatherResult {
  return {
    notes: [],
    sources: [],
    canonicalPapers: [],
    reviewedPapers: [],
    routing: {
      domain: "mixed",
      plannedQueries: plan.searchQueries,
      discoveryProviderIds: [],
      resolverProviderIds: [],
      acquisitionProviderIds: []
    },
    mergeDiagnostics: [],
    authStatus: [],
    reviewWorkflow: {
      titleScreenedPaperIds: [],
      abstractScreenedPaperIds: [],
      fulltextScreenedPaperIds: [],
      includedPaperIds: [],
      excludedPaperIds: [],
      uncertainPaperIds: [],
      blockedPaperIds: [],
      synthesisPaperIds: [],
      deferredPaperIds: [],
      counts: {
        titleScreened: 0,
        abstractScreened: 0,
        fulltextScreened: 0,
        included: 0,
        excluded: 0,
        uncertain: 0,
        blocked: 0,
        selectedForSynthesis: 0,
        deferred: 0
      },
      notes: []
    }
  };
}

type EvidenceQualitySnapshot = {
  inScopeIds: Set<string>;
  inScopeCount: number;
  borderlineCount: number;
  excludedCount: number;
  selectedCount: number;
  score: number;
};

function evidenceQualitySnapshot(gathered: ResearchSourceGatherResult): EvidenceQualitySnapshot {
  const relevanceAssessments = gathered.relevanceAssessments ?? [];
  const inScopeIds = new Set(relevanceAssessments
    .filter((assessment) => assessment.status === "in_scope")
    .map((assessment) => assessment.paperId));
  const inScopeCount = inScopeIds.size;
  const borderlineCount = relevanceAssessments.filter((assessment) => assessment.status === "borderline").length;
  const excludedCount = relevanceAssessments.filter((assessment) => assessment.status === "excluded").length;
  const selectedCount = gathered.reviewedPapers.length;

  return {
    inScopeIds,
    inScopeCount,
    borderlineCount,
    excludedCount,
    selectedCount,
    score: inScopeCount * 20 + selectedCount * 5 - borderlineCount * 3 - excludedCount
  };
}

function evidenceQualityImproved(previous: EvidenceQualitySnapshot | null, next: EvidenceQualitySnapshot): boolean {
  if (previous === null) {
    return true;
  }

  return [...next.inScopeIds].some((paperId) => !previous.inScopeIds.has(paperId))
    || next.score > previous.score;
}

type CriticIterationSummary = {
  stage: CriticReviewStage;
  iterations: number;
  finalReadiness: string;
  finalConfidence: number;
  objectionCount: number;
  topObjections: string[];
};

function finalCriticIterationSummaries(
  reportsByStage: Map<CriticReviewStage, CriticReviewArtifact[]>
): CriticIterationSummary[] {
  return (["protocol", "source_selection", "evidence", "release"] as CriticReviewStage[])
    .flatMap((stage) => {
      const reports = reportsByStage.get(stage) ?? [];
      const finalReport = reports.at(-1);
      if (finalReport === undefined) {
        return [];
      }

      return [{
        stage,
        iterations: reports.length,
        finalReadiness: finalReport.readiness,
        finalConfidence: finalReport.confidence,
        objectionCount: finalReport.objections.length,
        topObjections: finalReport.objections.slice(0, 4).map((objection) => objection.message)
      }];
    });
}

function modelSuitabilityRating(input: {
  reviewedPaperCount: number;
  selectedPaperCount: number;
  extractionCount: number;
  evidenceRowCount: number;
  manuscriptReadiness: string;
  criticSummaries: CriticIterationSummary[];
  actionDiagnostics: ResearchActionDiagnostic[];
}): { score: number; label: "strong" | "adequate" | "limited" | "poor"; rationale: string[] } {
  const rationale: string[] = [];
  let score = 100;
  const nonPassingCritics = input.criticSummaries.filter((summary) => summary.finalReadiness !== "pass");

  if (input.selectedPaperCount < 3) {
    score -= 25;
    rationale.push("Fewer than three papers were selected for synthesis.");
  } else if (input.selectedPaperCount < 8) {
    score -= 10;
    rationale.push("The selected evidence set is modest.");
  }

  if (input.extractionCount < input.selectedPaperCount) {
    score -= 20;
    rationale.push("Not every selected paper was extracted.");
  }

  if (input.evidenceRowCount < 3) {
    score -= 20;
    rationale.push("The evidence matrix remained thin.");
  }

  if (nonPassingCritics.length > 0) {
    score -= Math.min(30, nonPassingCritics.length * 10);
    rationale.push(`Critic review ended with unresolved ${nonPassingCritics.map((summary) => `${summary.stage}:${summary.finalReadiness}`).join(", ")} status.`);
  }

  if (input.actionDiagnostics.length > 0) {
    score -= Math.min(35, input.actionDiagnostics.length * 15);
    rationale.push(`Research-agent action control had ${input.actionDiagnostics.length} structured-output issue(s).`);
  }

  if (input.manuscriptReadiness !== "ready_for_revision") {
    score -= input.manuscriptReadiness === "needs_human_review" ? 10 : 20;
    rationale.push(`Manuscript readiness ended as ${input.manuscriptReadiness}.`);
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  const label = boundedScore >= 80
    ? "strong"
    : boundedScore >= 60
    ? "adequate"
    : boundedScore >= 40
    ? "limited"
    : "poor";

  return {
    score: boundedScore,
    label,
    rationale: rationale.length > 0 ? rationale : ["The run completed with sufficient evidence, extraction, and critic agreement signals."]
  };
}

function buildQualityReport(input: {
  run: RunRecord;
  backendLabel: string;
  gathered: ResearchSourceGatherResult | null;
  paperExtractions: PaperExtraction[];
  evidenceMatrix: EvidenceMatrix;
  manuscriptBundle: ManuscriptBundle;
  criticReportsByStage: Map<CriticReviewStage, CriticReviewArtifact[]>;
  agentActionDiagnostics?: ResearchActionDiagnostic[];
  agentActionTransports?: AgentActionTransportRecord[];
  agentControlMode?: RuntimeLlmConfig["agentControlMode"];
  autonomousRevisionPasses: number;
  revisionBudgetPasses: number;
}): Record<string, unknown> {
  const criticIterations = finalCriticIterationSummaries(input.criticReportsByStage);
  const actionDiagnostics = input.agentActionDiagnostics ?? [];
  const actionTransports = input.agentActionTransports ?? [];
  const transportCounts = actionTransports.reduce<Record<string, number>>((counts, record) => {
    counts[record.transport] = (counts[record.transport] ?? 0) + 1;
    return counts;
  }, {});
  const reviewedPaperCount = input.gathered?.reviewedPapers.length ?? 0;
  const selectedPaperCount = input.gathered?.reviewWorkflow.counts.selectedForSynthesis ?? reviewedPaperCount;
  const suitability = modelSuitabilityRating({
    reviewedPaperCount,
    selectedPaperCount,
    extractionCount: input.paperExtractions.length,
    evidenceRowCount: input.evidenceMatrix.rowCount,
    manuscriptReadiness: input.manuscriptBundle.checks.readinessStatus,
    criticSummaries: criticIterations,
    actionDiagnostics
  });

  return {
    schemaVersion: 1,
    runId: input.run.id,
    status: "completed",
    backend: input.backendLabel,
    evidence: {
      rawSources: input.gathered?.sources.length ?? 0,
      canonicalPapers: input.gathered?.canonicalPapers.length ?? 0,
      titleScreened: input.gathered?.reviewWorkflow.counts.titleScreened ?? 0,
      abstractScreened: input.gathered?.reviewWorkflow.counts.abstractScreened ?? 0,
      fulltextScreened: input.gathered?.reviewWorkflow.counts.fulltextScreened ?? 0,
      includedPapers: input.gathered?.reviewWorkflow.counts.included ?? 0,
      selectedForSynthesis: selectedPaperCount,
      reviewedPapers: reviewedPaperCount,
      extractedPapers: input.paperExtractions.length,
      evidenceRows: input.evidenceMatrix.rowCount,
      referencedPapers: input.manuscriptBundle.references.referenceCount
    },
    critic: {
      autonomousRevisionPasses: input.autonomousRevisionPasses,
      revisionBudgetPasses: input.revisionBudgetPasses,
      iterations: criticIterations,
      finalSatisfaction: criticIterations.every((summary) => summary.finalReadiness === "pass") ? "pass" : "unresolved"
    },
    agentControl: {
      mode: input.agentControlMode ?? "strict_json",
      transportCounts,
      actions: actionTransports.slice(-20),
      invalidActionCount: actionDiagnostics.length,
      diagnostics: actionDiagnostics
    },
    manuscript: {
      readinessStatus: input.manuscriptBundle.checks.readinessStatus,
      blockerCount: input.manuscriptBundle.checks.blockerCount,
      warningCount: input.manuscriptBundle.checks.warningCount,
      fullManuscriptReleased: input.manuscriptBundle.checks.readinessStatus === "ready_for_revision"
    },
    modelSuitability: suitability
  };
}

function externalBlockersFromManuscript(bundle: ManuscriptBundle): string[] {
  const blockerText = [
    ...bundle.checks.blockers,
    ...bundle.checks.checks
      .filter((check) => check.status === "fail")
      .map((check) => check.message)
  ];

  return blockerText.filter((text) => (
    /\b(credential|api key|quota|rate limit|paywall|permission|access denied|forbidden|unauthori[sz]ed|license|tdm|missing required)\b/i.test(text)
  )).slice(0, 8);
}

function internalActionsFromRun(input: {
  synthesis: ResearchSynthesis;
  agenda: ResearchAgenda;
  manuscriptBundle: ManuscriptBundle;
  criticReportsByStage: Map<CriticReviewStage, CriticReviewArtifact[]>;
}): string[] {
  const criticActions = finalCriticIterationSummaries(input.criticReportsByStage)
    .filter((summary) => summary.finalReadiness !== "pass")
    .flatMap((summary) => summary.topObjections.map((objection) => `${summary.stage}: ${objection}`));
  const failedChecks = input.manuscriptBundle.checks.checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.title}: ${check.message}`);

  return uniqueStrings([
    ...criticActions,
    ...failedChecks,
    ...input.synthesis.nextQuestions,
    ...input.agenda.holdReasons
  ]).slice(0, 16);
}

function researchWorkerStatusFromRun(input: {
  manuscriptBundle: ManuscriptBundle;
  internalActions: string[];
  externalBlockers: string[];
}): ResearchWorkerStatus {
  if (input.manuscriptBundle.checks.readinessStatus === "ready_for_revision") {
    return "release_ready";
  }

  if (input.externalBlockers.length > 0) {
    return "externally_blocked";
  }

  return "working";
}

function researchWorkerStatusReason(status: ResearchWorkerStatus, readiness: string): string {
  switch (status) {
    case "release_ready":
      return "The current evidence, synthesis, references, and manuscript checks are ready for scientific revision.";
    case "externally_blocked":
      return "The autonomous worker needs external access, credentials, quota, or permission before it can continue safely.";
    case "needs_user_decision":
      return "The autonomous worker needs a genuine research-direction decision before continuing.";
    case "working":
      return `The latest run segment ended with ${readiness}; remaining work is machine-actionable and should continue internally.`;
    case "paused":
      return "The autonomous research worker is paused.";
    case "not_started":
      return "No autonomous research worker segment has started yet.";
  }
}

async function writeWorkerStateForRun(input: {
  run: RunRecord;
  previousState: ResearchWorkerState | null;
  gathered: ResearchSourceGatherResult | null;
  paperExtractions: PaperExtraction[];
  evidenceMatrix: EvidenceMatrix;
  synthesis: ResearchSynthesis;
  agenda: ResearchAgenda;
  manuscriptBundle: ManuscriptBundle;
  criticReportsByStage: Map<CriticReviewStage, CriticReviewArtifact[]>;
  revisionPasses: number;
  revisionBudgetPasses: number;
  continuationLimitReason?: string | null;
  now: string;
}): Promise<ResearchWorkerState> {
  const internalActions = internalActionsFromRun({
    synthesis: input.synthesis,
    agenda: input.agenda,
    manuscriptBundle: input.manuscriptBundle,
    criticReportsByStage: input.criticReportsByStage
  });
  const externalBlockers = externalBlockersFromManuscript(input.manuscriptBundle);
  const status = researchWorkerStatusFromRun({
    manuscriptBundle: input.manuscriptBundle,
    internalActions,
    externalBlockers
  });
  const criticIterations = finalCriticIterationSummaries(input.criticReportsByStage);
  const state: ResearchWorkerState = {
    schemaVersion: 1,
    projectRoot: input.run.projectRoot,
    brief: input.run.brief,
    status,
    activeRunId: null,
    lastRunId: input.run.id,
    segmentCount: (input.previousState?.segmentCount ?? 0) + 1,
    updatedAt: input.now,
    statusReason: status === "needs_user_decision" && input.continuationLimitReason !== null && input.continuationLimitReason !== undefined
      ? input.continuationLimitReason
      : researchWorkerStatusReason(status, input.manuscriptBundle.checks.readinessStatus),
    paperReadiness: input.manuscriptBundle.checks.readinessStatus,
    nextInternalActions: status === "working" ? internalActions : [],
    userBlockers: status === "externally_blocked" || status === "needs_user_decision"
      ? externalBlockers.length > 0 ? externalBlockers : internalActions
      : [],
    evidence: {
      canonicalPapers: input.gathered?.canonicalPapers.length ?? 0,
      selectedPapers: input.gathered?.reviewedPapers.length ?? 0,
      extractedPapers: input.paperExtractions.length,
      evidenceRows: input.evidenceMatrix.rowCount,
      referencedPapers: input.manuscriptBundle.references.referenceCount
    },
    critic: {
      finalSatisfaction: criticIterations.every((summary) => summary.finalReadiness === "pass") ? "pass" : "unresolved",
      unresolvedStages: criticIterations
        .filter((summary) => summary.finalReadiness !== "pass")
        .map((summary) => summary.stage),
      objections: criticIterations.flatMap((summary) => summary.topObjections).slice(0, 12)
    }
  };

  await writeResearchWorkerState(state);
  return state;
}

async function writeResearchDirection(
  run: RunRecord,
  agenda: ResearchAgenda,
  acceptedAt: string,
  sourceRun: RunRecord | null = run
): Promise<void> {
  await writeJsonArtifact(
    researchDirectionPath(run.projectRoot),
    createResearchDirectionState(agenda, run, acceptedAt, { sourceRun })
  );
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

function summarizeSource(source: ResearchSource): string {
  const locator = source.locator ?? "no external locator";
  return `${source.id}: ${source.title} (${source.kind}; ${locator})`;
}

function summarizeReviewedPaper(paper: CanonicalPaper): string {
  const venue = paper.venue ?? "unknown venue";
  return `${paperEntityId(paper)}: ${paper.title} (${venue}; ${paper.accessMode}; ${paper.screeningDecision})`;
}

function summarizeClaim(claim: ResearchClaim): string {
  const sources = claim.sourceIds.length > 0
    ? ` [${claim.sourceIds.join(", ")}]`
    : "";
  return `${claim.claim}${sources}`;
}

function summarizeVerifiedClaim(claim: VerifiedClaim): string {
  return `${claim.supportStatus} (${claim.confidence}): ${claim.claim}`;
}

function reviewWorkflowLines(gathered: ResearchSourceGatherResult): string[] {
  return [
    `- Title screened: ${gathered.reviewWorkflow.counts.titleScreened}`,
    `- Abstract screened: ${gathered.reviewWorkflow.counts.abstractScreened}`,
    `- Full-text screened: ${gathered.reviewWorkflow.counts.fulltextScreened}`,
    `- Included after review: ${gathered.reviewWorkflow.counts.included}`,
    `- Blocked or credential-limited: ${gathered.reviewWorkflow.counts.blocked}`,
    `- Selected for synthesis: ${gathered.reviewWorkflow.counts.selectedForSynthesis}`,
    `- Deferred included papers: ${gathered.reviewWorkflow.counts.deferred}`
  ];
}

function researchSummaryMarkdown(
  run: RunRecord,
  plan: ResearchPlan,
  gathered: ResearchSourceGatherResult,
  paperExtractions: PaperExtraction[],
  evidenceMatrix: EvidenceMatrix,
  synthesis: ResearchSynthesis,
  verification: VerificationReport
): string {
  const lines = [
    "# Run Summary",
    "",
    `- Topic: ${run.brief.topic ?? "<missing>"}`,
    `- Research mode: ${plan.researchMode}`,
    `- Objective: ${plan.objective}`,
    `- Raw sources gathered: ${gathered.sources.length}`,
    `- Canonical papers retained: ${gathered.canonicalPapers.length}`,
    `- Reviewed papers selected for synthesis: ${gathered.reviewedPapers.length}`,
    `- Paper extractions written: ${paperExtractions.length}`,
    `- Evidence matrix rows: ${evidenceMatrix.rowCount}`,
    "",
    "## Executive Summary",
    "",
    synthesis.executiveSummary,
    "",
    "## Verification",
    "",
    verification.summary,
    "",
    "## Review Workflow",
    "",
    ...reviewWorkflowLines(gathered),
    "",
    "## Main Themes",
    ""
  ];

  if (synthesis.themes.length === 0) {
    lines.push("- No stable themes were extracted.");
  } else {
    for (const theme of synthesis.themes) {
      lines.push(`- ${theme.title}: ${theme.summary}`);
    }
  }

  lines.push("", "## Evidence Highlights", "");

  if (evidenceMatrix.derivedInsights.length === 0) {
    lines.push("- No stable cross-paper evidence insights were derived.");
  } else {
    for (const insight of evidenceMatrix.derivedInsights.slice(0, 6)) {
      lines.push(`- ${insight.kind}: ${insight.title} (${insight.paperIds.join(", ") || "no linked papers"})`);
    }
  }

  lines.push("", "## Next-Step Questions", "");

  if (synthesis.nextQuestions.length === 0) {
    lines.push("- No concrete next-step questions were generated.");
  } else {
    for (const question of synthesis.nextQuestions) {
      lines.push(`- ${question}`);
    }
  }

  return lines.join("\n");
}

function synthesisMarkdown(
  run: RunRecord,
  plan: ResearchPlan,
  gathered: ResearchSourceGatherResult,
  paperExtractions: PaperExtraction[],
  evidenceMatrix: EvidenceMatrix,
  synthesis: ResearchSynthesis,
  verification: VerificationReport
): string {
  const lines = [
    "# Research Synthesis",
    "",
    "## Brief",
    "",
    `- Topic: ${run.brief.topic ?? "<missing>"}`,
    `- Research question: ${run.brief.researchQuestion ?? "<missing>"}`,
    `- Research direction: ${run.brief.researchDirection ?? "<missing>"}`,
    `- Success criterion: ${run.brief.successCriterion ?? "<missing>"}`,
    "",
    "## Planned Research Mode",
    "",
    `- Mode: ${plan.researchMode}`,
    `- Objective: ${plan.objective}`,
    `- Rationale: ${plan.rationale}`,
    "",
    "## Retrieval Overview",
    "",
    `- Domain routing: ${gathered.routing.domain}`,
    `- Discovery providers: ${gathered.routing.discoveryProviderIds.join(", ") || "none"}`,
    `- Resolver providers: ${gathered.routing.resolverProviderIds.join(", ") || "none"}`,
    `- Raw sources gathered: ${gathered.sources.length}`,
    `- Canonical papers retained: ${gathered.canonicalPapers.length}`,
    `- Reviewed papers selected for synthesis: ${gathered.reviewedPapers.length}`,
    `- Paper extractions written: ${paperExtractions.length}`,
    `- Evidence matrix rows: ${evidenceMatrix.rowCount}`,
    "",
    "## Review Workflow",
    "",
    ...reviewWorkflowLines(gathered),
    "",
    "## Executive Summary",
    "",
    synthesis.executiveSummary,
    "",
    "## Verification",
    "",
    `- Overall status: ${verification.overallStatus}`,
    `- Summary: ${verification.summary}`,
    `- Supported claims: ${verification.counts.supported}`,
    `- Partially supported claims: ${verification.counts.partiallySupported}`,
    `- Unverified claims: ${verification.counts.unverified}`,
    `- Explicit unknowns: ${verification.counts.unknown}`,
    "",
    "## Themes",
    ""
  ];

  if (synthesis.themes.length === 0) {
    lines.push("- No themes were extracted from the current canonical paper set.");
  } else {
    for (const theme of synthesis.themes) {
      const sources = theme.sourceIds.length > 0
        ? ` Sources: ${theme.sourceIds.join(", ")}.`
        : "";
      lines.push(`- ${theme.title}: ${theme.summary}${sources}`);
    }
  }

  lines.push("", "## Claims and Evidence", "");

  if (synthesis.claims.length === 0) {
    lines.push("- No source-grounded claims were extracted.");
  } else {
    for (const claim of synthesis.claims) {
      const sources = claim.sourceIds.length > 0
        ? ` Sources: ${claim.sourceIds.join(", ")}.`
        : "";
      lines.push(`- Claim: ${claim.claim}`);
      lines.push(`  Evidence: ${claim.evidence}${sources}`);
    }
  }

  lines.push("", "## Evidence Matrix Insights", "");

  if (evidenceMatrix.derivedInsights.length === 0) {
    lines.push("- No evidence-matrix insights were derived.");
  } else {
    for (const insight of evidenceMatrix.derivedInsights) {
      lines.push(`- ${insight.kind}: ${insight.title} - ${insight.summary}`);
    }
  }

  lines.push("", "## Paper Extractions", "");

  if (paperExtractions.length === 0) {
    lines.push("- No paper-by-paper extraction records were produced.");
  } else {
    for (const extraction of paperExtractions.slice(0, 12)) {
      lines.push(`- ${extraction.paperId}: confidence ${extraction.confidence}; system type "${extraction.systemType || "<unspecified>"}"; planning "${extraction.planningStyle || "<unspecified>"}"`);
    }
  }

  lines.push("", "## Reviewed Papers", "");

  if (gathered.reviewedPapers.length === 0) {
    lines.push("- No reviewed papers were selected for synthesis.");
  } else {
    for (const paper of gathered.reviewedPapers) {
      lines.push(`- ${paperEntityId(paper)}: ${paper.citation} [${paper.accessMode}]`);
    }
  }

  if (gathered.reviewWorkflow.counts.deferred > 0) {
    lines.push("", "## Deferred Included Papers", "");
    lines.push(`- ${gathered.reviewWorkflow.counts.deferred} additional included papers were kept in the review backlog for later synthesis passes.`);
  }

  lines.push("", "## Next-Step Questions", "");

  if (synthesis.nextQuestions.length === 0) {
    lines.push("- No next-step questions were generated.");
  } else {
    for (const question of synthesis.nextQuestions) {
      lines.push(`- ${question}`);
    }
  }

  if (verification.unverifiedClaims.length > 0 || verification.unknowns.length > 0) {
    lines.push("", "## Verification Gaps", "");

    for (const claim of verification.unverifiedClaims) {
      lines.push(`- ${claim.claim}: ${claim.reason}`);
    }

    for (const unknown of verification.unknowns) {
      lines.push(`- ${unknown}`);
    }
  }

  return lines.join("\n");
}

async function readJsonArtifactOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const contents = await readFile(filePath, "utf8");
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

function agendaMarkdown(
  run: RunRecord,
  plan: ResearchPlan,
  agenda: ResearchAgenda
): string {
  const lines = [
    "# Research Agenda",
    "",
    `- Run id: ${run.id}`,
    `- Stage: ${run.stage}`,
    `- Research mode: ${plan.researchMode}`,
    `- Objective: ${plan.objective}`,
    "",
    "## Executive Summary",
    "",
    agenda.executiveSummary,
    "",
    "## Gaps",
    ""
  ];

  if (agenda.gaps.length === 0) {
    lines.push("- No explicit gaps were extracted from the current reviewed evidence.");
  } else {
    for (const gap of agenda.gaps) {
      const evidence = gap.sourceIds.length > 0
        ? ` Sources: ${gap.sourceIds.join(", ")}.`
        : "";
      const claims = gap.claimIds.length > 0
        ? ` Claims: ${gap.claimIds.join(", ")}.`
        : "";
      lines.push(`- ${gap.title} [${gap.gapKind}; ${gap.severity}]: ${gap.summary}${evidence}${claims}`);
    }
  }

  lines.push("", "## Candidate Directions", "");

  if (agenda.candidateDirections.length === 0) {
    lines.push("- No candidate directions were selected from the current evidence.");
  } else {
    for (const candidate of agenda.candidateDirections) {
      const marker = candidate.id === agenda.selectedDirectionId ? " (selected)" : "";
      lines.push(`- ${candidate.title}${marker}`);
      lines.push(`  Mode: ${candidate.mode}`);
      lines.push(`  Summary: ${candidate.summary}`);
      lines.push(`  Why now: ${candidate.whyNow}`);
      lines.push(`  Scores: evidence ${candidate.scores.evidenceBase}/5, novelty ${candidate.scores.novelty}/5, tractability ${candidate.scores.tractability}/5, cost ${candidate.scores.expectedCost}/5, risk ${candidate.scores.risk}/5, overall ${candidate.scores.overall}/5`);
    }
  }

  lines.push("", "## Internal Continuation", "");
  lines.push("- Candidate directions and gaps are used as internal planning context for the autonomous worker.");
  lines.push("- No separate handoff artifact is generated for the user to execute.");

  if (agenda.holdReasons.length > 0) {
    lines.push("", "## Hold Reasons", "");
    for (const reason of agenda.holdReasons) {
      lines.push(`- ${reason}`);
    }
  }

  lines.push("", "## Recommended Human Decision", "", agenda.recommendedHumanDecision);
  return lines.join("\n");
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

function paperLookupByAnyId(papers: CanonicalPaper[]): Map<string, CanonicalPaper> {
  const lookup = new Map<string, CanonicalPaper>();

  for (const paper of papers) {
    const canonicalId = paperEntityId(paper);
    lookup.set(paper.id, paper);
    lookup.set(canonicalId, paper);
  }

  return lookup;
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

function remapPaperExtractions(
  paperExtractions: PaperExtraction[],
  canonicalIdByAnyId: Map<string, string>
): PaperExtraction[] {
  return paperExtractions.map((extraction) => ({
    ...extraction,
    paperId: canonicalIdByAnyId.get(extraction.paperId) ?? extraction.paperId
  }));
}

function remapEvidenceMatrix(
  evidenceMatrix: EvidenceMatrix,
  canonicalIdByAnyId: Map<string, string>
): EvidenceMatrix {
  return {
    ...evidenceMatrix,
    rows: evidenceMatrix.rows.map((row) => ({
      ...row,
      paperId: canonicalIdByAnyId.get(row.paperId) ?? row.paperId
    })),
    derivedInsights: evidenceMatrix.derivedInsights.map((insight) => ({
      ...insight,
      paperIds: remapPaperIds(insight.paperIds, canonicalIdByAnyId)
    }))
  };
}

function remapSynthesisSourceIds(
  synthesis: ResearchSynthesis,
  canonicalIdByAnyId: Map<string, string>
): ResearchSynthesis {
  return {
    ...synthesis,
    themes: synthesis.themes.map((theme) => ({
      ...theme,
      sourceIds: remapPaperIds(theme.sourceIds, canonicalIdByAnyId)
    })),
    claims: synthesis.claims.map((claim) => ({
      ...claim,
      sourceIds: remapPaperIds(claim.sourceIds, canonicalIdByAnyId)
    }))
  };
}

function remapAgendaSourceIds(
  agenda: ResearchAgenda,
  canonicalIdByAnyId: Map<string, string>
): ResearchAgenda {
  return {
    ...agenda,
    gaps: agenda.gaps.map((gap) => ({
      ...gap,
      sourceIds: remapPaperIds(gap.sourceIds, canonicalIdByAnyId)
    })),
    candidateDirections: agenda.candidateDirections.map((direction) => ({
      ...direction,
      sourceIds: remapPaperIds(direction.sourceIds, canonicalIdByAnyId)
    }))
  };
}

function remapReviewWorkflow(
  reviewWorkflow: ResearchSourceGatherResult["reviewWorkflow"],
  canonicalIdByAnyId: Map<string, string>
): ResearchSourceGatherResult["reviewWorkflow"] {
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

function targetKindForId(targetId: string): MemoryLink["targetKind"] {
  if (targetId.startsWith("paper-")) {
    return "paper";
  }

  if (targetId.startsWith("theme-")) {
    return "theme";
  }

  if (targetId.startsWith("notebook-")) {
    return "notebook";
  }

  return "memory";
}

function link(type: MemoryLink["type"], targetId: string): MemoryLink {
  return {
    type,
    targetKind: targetKindForId(targetId),
    targetId
  };
}

function claimRecordId(claim: ResearchClaim): string {
  return createMemoryRecordId("claim", claim.claim);
}

function findingRecordKey(theme: ResearchTheme): string {
  return `${theme.title} | ${theme.summary}`;
}

function findingRecordId(theme: ResearchTheme): string {
  return createMemoryRecordId("finding", findingRecordKey(theme));
}

function questionRecordId(question: string): string {
  return createMemoryRecordId("question", question);
}

function ideaRecordId(key: string): string {
  return createMemoryRecordId("idea", key);
}

function summaryRecordId(runId: string): string {
  return createMemoryRecordId("summary", `run:${runId}:summary`);
}

function relatedClaimIdsForTheme(theme: ResearchTheme, claims: ResearchClaim[]): string[] {
  const themeSources = new Set(theme.sourceIds);

  return claims.flatMap((claim) => claim.sourceIds.some((sourceId) => themeSources.has(sourceId))
    ? [claimRecordId(claim)]
    : []);
}

function fallbackFinding(
  gathered: ResearchSourceGatherResult,
  summaryText: string,
  failureMessage: string | null
): ResearchTheme {
  return {
    title: failureMessage === null ? "Provisional finding" : "Evidence gap",
    summary: failureMessage ?? summaryText,
    sourceIds: gathered.canonicalPapers.slice(0, 3).map((paper) => paperEntityId(paper))
  };
}

function buildIdeaRecords(
  run: RunRecord,
  plan: ResearchPlan,
  questionIds: string[],
  failureMessage: string | null
): MemoryRecordInput[] {
  if (failureMessage !== null) {
    return [{
      type: "idea",
      key: `run:${run.id}:retrieval-revision`,
      title: "Broaden literature retrieval",
      text: `Refine the query plan, provider routing, or access configuration before the next research pass on ${run.brief.topic ?? "this project"}.`,
      runId: run.id,
      links: questionIds.map((targetId) => link("refines", targetId)),
      data: {
        researchMode: plan.researchMode,
        objective: plan.objective
      }
    }];
  }

  return [{
    type: "idea",
    key: `run:${run.id}:follow-up`,
    title: "Follow-up direction",
    text: `Use the canonical paper set from this run to continue the bounded ${plan.researchMode} program around ${plan.objective}.`,
    runId: run.id,
    links: questionIds.slice(0, 2).map((targetId) => link("refines", targetId)),
    data: {
      researchMode: plan.researchMode,
      objective: plan.objective
    }
  }];
}

function buildArtifactRecords(
  run: RunRecord,
  sourceIds: string[],
  claimIds: string[],
  findingIds: string[],
  questionIds: string[],
  ideaIds: string[],
  summaryId: string
): MemoryRecordInput[] {
  const artifactSpecs = [
    {
      path: run.artifacts.planPath,
      title: "Research plan artifact",
      text: `Saved explicit research plan for ${run.id}.`,
      linkIds: ideaIds.length > 0 ? ideaIds : [summaryId]
    },
    {
      path: run.artifacts.sourcesPath,
      title: "Raw retrieval artifact",
      text: `Saved raw provider hits, routing notes, and merge diagnostics for ${run.id}.`,
      linkIds: sourceIds
    },
    {
      path: run.artifacts.literaturePath,
      title: "Literature review artifact",
      text: `Saved the run-level literature review snapshot for ${run.id}.`,
      linkIds: sourceIds
    },
    {
      path: run.artifacts.reviewProtocolPath,
      title: "Review protocol artifact",
      text: `Saved the review protocol for ${run.id}.`,
      linkIds: sourceIds.length > 0 ? sourceIds : [summaryId]
    },
    {
      path: run.artifacts.reviewProtocolMarkdownPath,
      title: "Review protocol summary artifact",
      text: `Saved the human-readable review protocol for ${run.id}.`,
      linkIds: sourceIds.length > 0 ? sourceIds : [summaryId]
    },
    {
      path: run.artifacts.paperExtractionsPath,
      title: "Paper extractions artifact",
      text: `Saved paper-by-paper extraction records for ${run.id}.`,
      linkIds: sourceIds
    },
    {
      path: run.artifacts.verificationPath,
      title: "Verification artifact",
      text: `Saved verification report for ${run.id}.`,
      linkIds: claimIds.length > 0 ? claimIds : [summaryId]
    },
    {
      path: run.artifacts.paperPath,
      title: "Review paper draft artifact",
      text: `Saved the review-paper draft for ${run.id}.`,
      linkIds: [
        summaryId,
        ...findingIds,
        ...claimIds
      ]
    },
    {
      path: run.artifacts.paperJsonPath,
      title: "Structured review paper artifact",
      text: `Saved the structured paper representation for ${run.id}.`,
      linkIds: claimIds.length > 0 ? claimIds : [summaryId]
    },
    {
      path: run.artifacts.manuscriptChecksPath,
      title: "Manuscript checks artifact",
      text: `Saved manuscript readiness checks for ${run.id}.`,
      linkIds: claimIds.length > 0 ? claimIds : [summaryId]
    },
    {
      path: run.artifacts.nextQuestionsPath,
      title: "Next questions artifact",
      text: `Saved follow-up questions for ${run.id}.`,
      linkIds: questionIds
    },
    {
      path: run.artifacts.agendaPath,
      title: "Research agenda artifact",
      text: `Saved the ranked research agenda for ${run.id}.`,
      linkIds: ideaIds.length > 0 ? ideaIds : [summaryId]
    },
    {
      path: run.artifacts.memoryPath,
      title: "Research workspace database",
      text: `Saved canonical SQLite research workspace state for ${run.id}.`,
      linkIds: [
        summaryId,
        ...findingIds,
        ...claimIds,
        ...questionIds
      ]
    }
  ];

  return artifactSpecs.map((artifact) => ({
    type: "artifact",
    key: relativeArtifactPath(run.projectRoot, artifact.path),
    title: artifact.title,
    text: artifact.text,
    runId: run.id,
    links: artifact.linkIds.map((targetId) => link("contains", targetId)),
    data: {
      path: relativeArtifactPath(run.projectRoot, artifact.path)
    }
  }));
}

function themeFromInsight(insight: EvidenceMatrixInsight): ResearchTheme {
  return {
    title: insight.title,
    summary: insight.summary,
    sourceIds: insight.paperIds
  };
}

function questionFromInsight(insight: EvidenceMatrixInsight): string {
  return insight.kind === "gap"
    ? `Which bounded follow-up would best close this evidence gap: ${insight.title.toLowerCase()}?`
    : `What evidence or comparison would best resolve this conflict: ${insight.title.toLowerCase()}?`;
}

function completePaperExtractions(
  run: RunRecord,
  reviewedPapers: CanonicalPaper[],
  paperExtractions: PaperExtraction[]
): PaperExtraction[] {
  const byPaperId = new Map(paperExtractions.map((extraction) => [extraction.paperId, extraction]));

  for (const paper of reviewedPapers) {
    if (byPaperId.has(paper.id)) {
      continue;
    }

    byPaperId.set(paper.id, {
      id: `extraction-${paper.id}`,
      paperId: paper.id,
      runId: run.id,
      problemSetting: "",
      systemType: "",
      architecture: "",
      toolsAndMemory: "",
      planningStyle: "",
      evaluationSetup: "",
      successSignals: [],
      failureModes: [],
      limitations: [],
      supportedClaims: [],
      confidence: "low",
      evidenceNotes: ["No structured extraction was completed for this reviewed paper; the record remains intentionally sparse."]
    });
  }

  return reviewedPapers
    .map((paper) => byPaperId.get(paper.id))
    .filter((extraction): extraction is PaperExtraction => extraction !== undefined);
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

function isRecoverableExtractionError(error: unknown): boolean {
  return ["timeout", "malformed_json", "empty_result"].includes(recoveryFailureKind(error));
}

class ResearchStageBlockedError extends Error {
  constructor(
    message: string,
    public readonly operation: ResearchBackendOperation,
    public readonly attempts: ExtractionBatchAttempt[]
  ) {
    super(message);
    this.name = "ResearchStageBlockedError";
  }
}

async function writeExtractionCheckpoint(
  run: RunRecord,
  reviewedPapers: CanonicalPaper[],
  extractions: PaperExtraction[],
  attempts: ExtractionBatchAttempt[],
  status: "in_progress" | "completed" | "failed",
  failedPaperIds: string[] = []
): Promise<void> {
  await writeJsonArtifact(run.artifacts.paperExtractionsPath, paperExtractionsArtifact(
    run,
    reviewedPapers.length,
    extractions,
    {
      status,
      completedPaperIds: [...new Set(extractions.map((extraction) => extraction.paperId))],
      failedPaperIds,
      batchAttempts: attempts
    }
  ));
}

async function extractReviewedPapersWithRecovery(options: {
  run: RunRecord;
  now: () => string;
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
  plan: ResearchPlan;
  papers: CanonicalPaper[];
  literatureContext: Parameters<ResearchBackend["extractReviewedPapers"]>[0]["literatureContext"];
}): Promise<{
  extractions: PaperExtraction[];
  attempts: ExtractionBatchAttempt[];
}> {
  const {
    run,
    now,
    researchBackend,
    runtimeConfig,
    plan,
    papers,
    literatureContext
  } = options;
  const attempts: ExtractionBatchAttempt[] = [];
  const extractions: PaperExtraction[] = [];
  let cursor = 0;
  let batchSize = Math.max(
    runtimeConfig.extractionMinBatchSize,
    Math.min(runtimeConfig.extractionInitialBatchSize, Math.max(1, papers.length))
  );
  const minBatchSize = Math.max(1, runtimeConfig.extractionMinBatchSize);
  const startedAt = Date.now();

  await writeExtractionCheckpoint(run, papers, extractions, attempts, "in_progress");

  while (cursor < papers.length) {
    if (attempts.filter((attempt) => attempt.status === "failed").length >= runtimeConfig.extractionRetryBudget) {
      const failedPaperIds = papers.slice(cursor).map((paper) => paper.id);
      await writeExtractionCheckpoint(run, papers, extractions, attempts, "failed", failedPaperIds);
      throw new ResearchStageBlockedError(
        `Extraction retry budget exhausted before all selected papers were extracted (${cursor}/${papers.length} batches complete).`,
        "extraction",
        attempts
      );
    }

    if (Date.now() - startedAt > runtimeConfig.totalRecoveryBudgetMs) {
      const failedPaperIds = papers.slice(cursor).map((paper) => paper.id);
      await writeExtractionCheckpoint(run, papers, extractions, attempts, "failed", failedPaperIds);
      throw new ResearchStageBlockedError(
        `Extraction retry time budget exhausted before all selected papers were extracted (${cursor}/${papers.length} papers complete).`,
        "extraction",
        attempts
      );
    }

    const batch = papers.slice(cursor, Math.min(papers.length, cursor + batchSize));
    const compact = batchSize <= minBatchSize && attempts.some((attempt) => (
      attempt.status === "failed"
      && attempt.paperIds.join("\0") === batch.map((paper) => paper.id).join("\0")
    ));
    const attemptBase = {
      attempt: attempts.length + 1,
      paperIds: batch.map((paper) => paper.id),
      batchSize,
      compact,
      timeoutMs: runtimeConfig.extractionTimeoutMs
    };

    await appendEvent(
      run,
      now,
      "next",
      `Extracting reviewed paper batch ${cursor + 1}-${cursor + batch.length} of ${papers.length} (${batch.length} papers${compact ? ", compact prompt" : ""}).`
    );

    try {
      const batchExtractions = await researchBackend.extractReviewedPapers({
        projectRoot: run.projectRoot,
        runId: run.id,
        brief: run.brief,
        plan,
        papers: batch,
        literatureContext,
        compact
      }, {
        operation: "extraction",
        timeoutMs: runtimeConfig.extractionTimeoutMs
      });

      if (batchExtractions.length === 0 && batch.length > 0) {
        throw new Error("empty extraction result");
      }

      attempts.push({
        ...attemptBase,
        status: "succeeded",
        errorKind: null,
        errorMessage: null
      });
      extractions.push(...batchExtractions);
      cursor += batch.length;
      await writeExtractionCheckpoint(run, papers, extractions, attempts, "in_progress");
      await appendStdout(run, `Extraction batch succeeded: ${cursor}/${papers.length} selected papers processed.`);
    } catch (error) {
      const kind = recoveryFailureKind(error);
      const message = errorMessage(error);
      attempts.push({
        ...attemptBase,
        status: "failed",
        errorKind: kind,
        errorMessage: message
      });
      await writeExtractionCheckpoint(run, papers, extractions, attempts, "in_progress", batch.map((paper) => paper.id));
      await appendEvent(
        run,
        now,
        "stderr",
        `Extraction batch failed (${kind}): ${message}`
      );

      if (!isRecoverableExtractionError(error)) {
        await writeExtractionCheckpoint(run, papers, extractions, attempts, "failed", batch.map((paper) => paper.id));
        throw new ResearchStageBlockedError(
          `Extraction failed with an unrecoverable ${kind}: ${message}`,
          "extraction",
          attempts
        );
      }

      if (batchSize > minBatchSize) {
        batchSize = Math.max(minBatchSize, Math.ceil(batchSize / 2));
        await appendEvent(
          run,
          now,
          "next",
          `Retrying extraction by shrinking the next batch size to ${batchSize}.`
        );
        continue;
      }

      if (!compact) {
        await appendEvent(run, now, "next", "Retrying extraction with a compact single-paper prompt.");
        continue;
      }

      await writeExtractionCheckpoint(run, papers, extractions, attempts, "failed", batch.map((paper) => paper.id));
      throw new ResearchStageBlockedError(
        `Extraction could not complete after retries for selected paper ${batch[0]?.id ?? "<unknown>"}: ${message}`,
        "extraction",
        attempts
      );
    }
  }

  await writeExtractionCheckpoint(run, papers, extractions, attempts, "completed");
  return {
    extractions,
    attempts
  };
}

function workspaceSynthesisFromStore(input: {
  run: RunRecord;
  store: ResearchWorkStore;
}): ResearchSynthesis {
  const claims: ResearchClaim[] = input.store.objects.claims.map((claim) => ({
    claim: claim.text,
    evidence: claim.evidence,
    sourceIds: claim.sourceIds
  }));
  const themes: ResearchTheme[] = input.store.objects.evidenceCells
    .filter((cell) => ["architecture", "toolsAndMemory", "planningStyle", "evaluationSetup", "successSignals", "failureModes", "limitations"].includes(cell.field))
    .slice(0, 12)
    .map((cell) => ({
      title: `${cell.field} evidence`,
      summary: Array.isArray(cell.value) ? cell.value.join("; ") : cell.value,
      sourceIds: [cell.sourceId]
    }));
  const nextQuestions = uniqueStrings([
    ...input.store.objects.workItems
      .filter((item) => item.status === "open")
      .map((item) => item.description),
    ...input.store.worker.nextInternalActions
  ]).slice(0, 10);

  return {
    executiveSummary: claims.length > 0
      ? `The workspace contains ${claims.length} claim-led synthesis item(s) grounded in ${input.store.objects.evidenceCells.length} evidence cell(s).`
      : "The workspace does not yet contain claim-led synthesis items.",
    themes,
    claims,
    nextQuestions
  };
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
  gathered?: ResearchSourceGatherResult;
  evidenceMatrix?: EvidenceMatrix;
}): ManuscriptBundle["checks"] {
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
  const evidenceRows = input.evidenceMatrix?.rowCount ?? input.store.objects.extractions.length;
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

function workspacePaperOutline(input: {
  run: RunRecord;
  store: ResearchWorkStore;
  synthesis: ResearchSynthesis;
}): PaperOutline {
  const title = input.run.brief.topic ?? input.run.brief.researchQuestion ?? "ClawResearch Review";
  return {
    schemaVersion: 1,
    runId: input.run.id,
    briefFingerprint: briefFingerprint(input.run.brief),
    title,
    reviewType: "technical_survey",
    structureRationale: "The outline is derived from work-store manuscript sections, claims, and evidence cells.",
    abstractClaims: input.synthesis.claims.slice(0, 3).map((claim) => claim.claim),
    rhetoricalPlan: input.store.objects.manuscriptSections.map((section) => ({
      id: section.sectionId,
      role: section.role,
      title: section.title,
      intent: `Develop ${section.role} using checked workspace claims and citations.`,
      evidenceIds: section.sourceIds,
      claimIds: section.claimIds
    })),
    keyThemes: input.synthesis.themes.map((theme) => theme.title).slice(0, 8),
    evidenceTablesToCite: input.store.objects.evidenceCells.map((cell) => cell.id).slice(0, 12),
    openQuestions: input.synthesis.nextQuestions,
    limitations: input.store.objects.workItems
      .filter((item) => item.status === "open")
      .map((item) => item.description)
      .slice(0, 8),
    agendaImplications: input.store.worker.nextInternalActions.slice(0, 8)
  };
}

function workspacePaperArtifact(input: {
  run: RunRecord;
  store: ResearchWorkStore;
  outline: PaperOutline;
  references: ReferencesArtifact;
  checks: ManuscriptBundle["checks"];
}): ReviewPaperArtifact {
  const claims = input.store.objects.claims.map((claim) => ({
    claimId: claim.id,
    claim: claim.text,
    evidence: claim.evidence,
    sourceIds: claim.sourceIds
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
  const referencedPaperIds = uniqueStrings([
    ...input.references.references.map((reference) => reference.sourceId),
    ...claims.flatMap((claim) => claim.sourceIds)
  ]);

  return {
    schemaVersion: 1,
    runId: input.run.id,
    briefFingerprint: briefFingerprint(input.run.brief),
    title: input.outline.title,
    abstract: claims.length > 0
      ? claims.slice(0, 3).map((claim) => claim.claim).join(" ")
      : "The workspace does not yet contain enough checked claims for a professional abstract.",
    reviewType: input.outline.reviewType,
    structureRationale: input.outline.structureRationale,
    scientificRoles: uniqueStrings(input.store.objects.manuscriptSections.map((section) => section.role)),
    sections: input.store.objects.manuscriptSections.map((section) => ({
      id: section.sectionId,
      role: section.role,
      title: section.title,
      markdown: section.markdown,
      sourceIds: section.sourceIds,
      claimIds: section.claimIds
    })),
    claims,
    citationLinks,
    referencedPaperIds,
    evidenceTableIds: input.store.objects.evidenceCells.map((cell) => cell.id),
    limitations: input.checks.blockers,
    readinessStatus: input.checks.readinessStatus
  };
}

function renderWorkspacePaperMarkdown(paper: ReviewPaperArtifact, references: ReferencesArtifact): string {
  if (paper.readinessStatus !== "ready_for_revision") {
    return [
      `# ${paper.title}`,
      "",
      `Readiness: ${paper.readinessStatus}`,
      "",
      "No full review manuscript was released because the workspace checks did not pass.",
      "",
      "Current evidence-backed state:",
      ...paper.claims.map((claim) => `- ${claim.claim} [${claim.sourceIds.join(", ")}]`),
      "",
      "Open blockers:",
      ...paper.limitations.map((limitation) => `- ${limitation}`)
    ].join("\n");
  }

  const referenceLines = references.references.map((reference) => `- [${reference.sourceId}] ${reference.citation}`);
  return [
    `# ${paper.title}`,
    "",
    "## Abstract",
    "",
    paper.abstract,
    "",
    ...paper.sections.flatMap((section) => [
      `## ${section.title}`,
      "",
      section.markdown,
      ""
    ]),
    "## References",
    "",
    ...(referenceLines.length > 0 ? referenceLines : ["- No references rendered."])
  ].join("\n").trim();
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

function workspaceManuscriptBundle(input: {
  run: RunRecord;
  plan: ResearchPlan;
  store: ResearchWorkStore;
  synthesis: ResearchSynthesis;
  scholarlyDiscoveryProviders: string[];
  publisherFullTextProviders: string[];
  oaRetrievalHelperProviders: string[];
  generalWebProviders: string[];
  localContextEnabled: boolean;
  gathered: ResearchSourceGatherResult;
  evidenceMatrix?: EvidenceMatrix;
}): ManuscriptBundle {
  const fallbackProtocol = buildReviewProtocol({
    run: input.run,
    plan: input.plan,
    scholarlyDiscoveryProviders: input.scholarlyDiscoveryProviders,
    publisherFullTextProviders: input.publisherFullTextProviders,
    oaRetrievalHelperProviders: input.oaRetrievalHelperProviders,
    generalWebProviders: input.generalWebProviders,
    localContextEnabled: input.localContextEnabled,
    gathered: input.gathered
  });
  const protocol = reviewProtocolFromWorkspace({
    fallback: fallbackProtocol,
    store: input.store
  });
  const references = referencesFromWorkStore(input.run, input.store);
  const checks = workspaceManuscriptChecks({
    run: input.run,
    store: input.store,
    references,
    gathered: input.gathered,
    evidenceMatrix: input.evidenceMatrix
  });
  const outline = workspacePaperOutline({
    run: input.run,
    store: input.store,
    synthesis: input.synthesis
  });
  const paper = workspacePaperArtifact({
    run: input.run,
    store: input.store,
    outline,
    references,
    checks
  });

  return {
    protocol,
    protocolMarkdown: reviewProtocolMarkdown(protocol),
    outline,
    paper,
    paperMarkdown: renderWorkspacePaperMarkdown(paper, references),
    references,
    checks
  };
}

function buildMemoryInputs(
  run: RunRecord,
  plan: ResearchPlan,
  gathered: ResearchSourceGatherResult,
  evidenceMatrix: EvidenceMatrix,
  summaryText: string,
  themes: ResearchTheme[],
  claims: ResearchClaim[],
  verification: VerificationReport,
  nextQuestions: string[],
  failureMessage: string | null
): MemoryRecordInput[] {
  const matrixThemes = evidenceMatrix.derivedInsights
    .filter((insight) => insight.kind === "pattern" || insight.kind === "anti_pattern" || insight.kind === "conflict")
    .map((insight) => themeFromInsight(insight));
  const effectiveThemes = matrixThemes.length > 0
    ? matrixThemes
    : themes.length > 0
      ? themes
      : [fallbackFinding(gathered, summaryText, failureMessage)];
  const effectiveQuestions = nextQuestions.length > 0
    ? nextQuestions
    : evidenceMatrix.derivedInsights
      .filter((insight) => insight.kind === "gap" || insight.kind === "conflict")
      .map((insight) => questionFromInsight(insight))
      .slice(0, 6);
  const summaryId = summaryRecordId(run.id);
  const paperByAnyId = paperLookupByAnyId(gathered.canonicalPapers);
  const paperIds = gathered.canonicalPapers.map(paperEntityId);

  const verificationByClaimId = new Map(
    verification.verifiedClaims.map((claim) => [claim.claimId, claim])
  );
  const claimRecords: MemoryRecordInput[] = claims.flatMap((claim) => {
    const verifiedClaim = verificationByClaimId.get(claimRecordId(claim));
    const supportStatus = verifiedClaim?.supportStatus ?? "unverified";
    const linkedPaperIds = claim.sourceIds.flatMap((sourceId) => {
      const paper = paperByAnyId.get(sourceId);
      return paper === undefined ? [] : [paperEntityId(paper)];
    });

    if (
      linkedPaperIds.length === 0
      || (supportStatus !== "supported" && supportStatus !== "partially_supported")
    ) {
      return [];
    }

    return [{
      type: "claim",
      key: claim.claim,
      title: claim.claim,
      text: claim.evidence,
      runId: run.id,
      links: linkedPaperIds.map((paperId) => link("supported_by", paperId)),
      data: {
        paperIds: linkedPaperIds,
        supportStatus,
        confidence: verifiedClaim?.confidence ?? "unknown",
        verificationNotes: verifiedClaim?.verificationNotes ?? []
      }
    }];
  });
  const claimIds = claimRecords.map((record) => createMemoryRecordId(record.type, record.key));
  const claimIdSet = new Set(claimIds);

  const findingRecords: MemoryRecordInput[] = effectiveThemes.map((theme) => ({
    type: "finding",
    key: findingRecordKey(theme),
    title: theme.title,
    text: theme.summary,
    runId: run.id,
      links: [
      ...theme.sourceIds.flatMap((sourceId) => {
        const paper = paperByAnyId.get(sourceId);
        return paper === undefined ? [] : [link("supported_by", paperEntityId(paper))];
      }),
      ...relatedClaimIdsForTheme(theme, claims)
        .filter((targetId) => claimIdSet.has(targetId))
        .map((targetId) => link("derived_from", targetId))
    ],
    data: {
      paperIds: theme.sourceIds.flatMap((sourceId) => {
        const paper = paperByAnyId.get(sourceId);
        return paper === undefined ? [] : [paperEntityId(paper)];
      })
    }
  }));
  const findingIds = effectiveThemes.map(findingRecordId);

  const questionRecords: MemoryRecordInput[] = effectiveQuestions.map((question) => ({
    type: "question",
    key: question,
    title: question,
    text: question,
    runId: run.id,
    links: findingIds.slice(0, 3).map((targetId) => link("derived_from", targetId)),
    data: {
      researchMode: plan.researchMode
    }
  }));
  const questionIds = effectiveQuestions.map(questionRecordId);

  const ideaRecords = buildIdeaRecords(run, plan, questionIds, failureMessage);
  const ideaIds = ideaRecords.map((record) => ideaRecordId(record.key));

  const summaryRecord: MemoryRecordInput = {
    type: "summary",
    key: `run:${run.id}:summary`,
    title: `Run ${run.id} summary`,
    text: summaryText,
    runId: run.id,
    links: [
      ...findingIds.map((targetId) => link("summarizes", targetId)),
      ...claimIds.map((targetId) => link("summarizes", targetId)),
      ...questionIds.map((targetId) => link("summarizes", targetId)),
      ...ideaIds.map((targetId) => link("summarizes", targetId))
    ],
    data: {
      researchMode: plan.researchMode,
      objective: plan.objective,
      failure: failureMessage,
      verificationStatus: verification.overallStatus
    }
  };

  const artifactRecords = buildArtifactRecords(
    run,
    paperIds,
    claimIds,
    findingIds,
    questionIds,
    ideaIds,
    summaryId
  );

  return [
    ...claimRecords,
    ...findingRecords,
    ...questionRecords,
    ...ideaRecords,
    summaryRecord,
    ...artifactRecords
  ];
}

function buildAgendaMemoryInputs(
  run: RunRecord,
  agenda: ResearchAgenda
): MemoryRecordInput[] {
  const directionRecords: MemoryRecordInput[] = agenda.candidateDirections.map((direction) => ({
    type: "direction",
    key: `${direction.mode}:${direction.title}`,
    title: direction.title,
    text: direction.summary,
    runId: run.id,
    links: direction.claimIds.map((targetId) => link("derived_from", targetId)),
    data: {
      status: direction.id === agenda.selectedDirectionId ? "selected" : "candidate",
      mode: direction.mode,
      whyNow: direction.whyNow,
      overallScore: String(direction.scores.overall),
      sourceIds: direction.sourceIds,
      gapIds: direction.gapIds
    }
  }));

  return directionRecords;
}

function buildLiteratureInputs(
  run: RunRecord,
  plan: ResearchPlan,
  gathered: ResearchSourceGatherResult,
  summaryText: string,
  themes: ResearchTheme[],
  claims: ResearchClaim[],
  nextQuestions: string[]
): {
  papers: CanonicalPaperInput[];
  themes: LiteratureThemeInput[];
  notebooks: LiteratureNotebookInput[];
} {
  const storePaperIdByAnyPaperId = canonicalPaperIdMap(gathered.canonicalPapers);
  const themeInputs: LiteratureThemeInput[] = themes.map((theme) => ({
    key: theme.title,
    title: theme.title,
    summary: theme.summary,
    runId: run.id,
    paperIds: theme.sourceIds.flatMap((sourceId) => {
      const storePaperId = storePaperIdByAnyPaperId.get(sourceId);
      return storePaperId === undefined ? [] : [storePaperId];
    }),
    claimIds: relatedClaimIdsForTheme(theme, claims),
    questionTexts: nextQuestions
  }));
  const themeIds = themeInputs.map((theme) => createLiteratureEntityId("theme", theme.key));
  const paperInputs: CanonicalPaperInput[] = gathered.canonicalPapers.map((paper) => ({
    key: paper.key,
    title: paper.title,
    citation: paper.citation,
    abstract: paper.abstract,
    year: paper.year,
    authors: paper.authors,
    venue: paper.venue,
    discoveredVia: paper.discoveredVia,
    identifiers: paper.identifiers,
    discoveryRecords: paper.discoveryRecords,
    accessCandidates: paper.accessCandidates,
    bestAccessUrl: paper.bestAccessUrl,
    bestAccessProvider: paper.bestAccessProvider,
    accessMode: paper.accessMode,
    fulltextFormat: paper.fulltextFormat,
    license: paper.license,
    tdmAllowed: paper.tdmAllowed,
    contentStatus: paper.contentStatus,
    screeningHistory: paper.screeningHistory,
    screeningStage: paper.screeningStage,
    screeningDecision: paper.screeningDecision,
    screeningRationale: paper.screeningRationale,
    accessErrors: paper.accessErrors,
    runId: run.id,
    linkedThemeIds: themeInputs
      .filter((theme) => theme.paperIds.includes(storePaperIdByAnyPaperId.get(paper.id) ?? paperEntityId(paper)))
      .map((theme) => createLiteratureEntityId("theme", theme.key)),
    linkedClaimIds: claims.flatMap((claim) => claim.sourceIds.includes(storePaperIdByAnyPaperId.get(paper.id) ?? paperEntityId(paper))
      ? [claimRecordId(claim)]
      : [])
  }));
  const notebook: LiteratureNotebookInput = {
    key: `run:${run.id}`,
    title: `Literature notebook for ${run.id}`,
    runId: run.id,
    objective: plan.objective,
    summary: summaryText,
    paperIds: gathered.canonicalPapers.map((paper) => storePaperIdByAnyPaperId.get(paper.id) ?? paperEntityId(paper)),
    themeIds,
    claimIds: claims.map(claimRecordId),
    nextQuestions,
    providerIds: gathered.routing.discoveryProviderIds
  };

  return {
    papers: paperInputs,
    themes: themeInputs,
    notebooks: [notebook]
  };
}

async function writeLiteratureSnapshot(
  run: RunRecord,
  literatureStore: LiteratureStore,
  result: LiteratureUpsertResult,
  gathered: ResearchSourceGatherResult
): Promise<void> {
  const canonicalIdByAnyId = canonicalPaperIdMap(gathered.canonicalPapers);
  await writeJsonArtifact(run.artifacts.literaturePath, {
    storePath: relativeArtifactPath(run.projectRoot, literatureStore.filePath),
    paperCount: gathered.canonicalPapers.length,
    reviewedPaperCount: gathered.reviewedPapers.length,
    papers: canonicalizePapers(gathered.canonicalPapers),
    reviewedPapers: canonicalizePapers(gathered.reviewedPapers),
    reviewWorkflow: remapReviewWorkflow(gathered.reviewWorkflow, canonicalIdByAnyId),
    relevanceAssessments: gathered.relevanceAssessments ?? [],
    mergeDiagnostics: gathered.mergeDiagnostics,
    authStatus: gathered.authStatus,
    retrievalDiagnostics: gathered.retrievalDiagnostics ?? null,
    inserted: result.inserted,
    updated: result.updated,
    stateCounts: {
      papers: result.state.paperCount,
      themes: result.state.themeCount,
      notebooks: result.state.notebookCount
    }
  });
}

async function writeManuscriptArtifacts(
  run: RunRecord,
  bundle: ManuscriptBundle
): Promise<void> {
  await writeJsonArtifact(run.artifacts.reviewProtocolPath, bundle.protocol);
  await writeFile(run.artifacts.reviewProtocolMarkdownPath, `${bundle.protocolMarkdown}\n`, "utf8");
  await writeFile(run.artifacts.paperPath, `${bundle.paperMarkdown}\n`, "utf8");
  await writeJsonArtifact(run.artifacts.paperJsonPath, bundle.paper);
  await writeJsonArtifact(run.artifacts.manuscriptChecksPath, bundle.checks);
}

async function writeMemorySnapshot(
  run: RunRecord,
  memoryStore: MemoryStore,
  records: MemoryRecordInput[]
): Promise<{ inserted: number; updated: number; recordCount: number }> {
  const result = await memoryStore.upsert(records);

  return {
    inserted: result.inserted,
    updated: result.updated,
    recordCount: result.records.length
  };
}

async function commitWorkStoreSegment(input: {
  store: ResearchWorkStore;
  run: RunRecord;
  plan: ResearchPlan;
  gathered: ResearchSourceGatherResult | null;
  paperExtractions: PaperExtraction[];
  evidenceMatrix: EvidenceMatrix | null;
  synthesis: ResearchSynthesis | null;
  verification: VerificationReport | null;
  agenda: ResearchAgenda | null;
  manuscriptBundle: ManuscriptBundle | null;
  criticReportsByStage: Map<CriticReviewStage, CriticReviewArtifact[]>;
  now: string;
}): Promise<ResearchWorkStore> {
  const criticReports = [...input.criticReportsByStage.values()].flat();
  const nextStore = mergeRunSegmentIntoResearchWorkStore(input.store, {
    run: input.run,
    plan: input.plan,
    gathered: input.gathered,
    paperExtractions: input.paperExtractions,
    evidenceMatrix: input.evidenceMatrix,
    synthesis: input.synthesis,
    verification: input.verification,
    agenda: input.agenda,
    manuscriptBundle: input.manuscriptBundle,
    criticReports,
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

function insufficientEvidenceNextQuestions(plan: ResearchPlan, gathered?: ResearchSourceGatherResult): string[] {
  const diagnostics = gathered?.retrievalDiagnostics;
  const suggestedQueries = diagnostics?.suggestedNextQueries.slice(0, 3) ?? [];
  const providerErrors = diagnostics?.providerAttempts
    .filter((attempt) => attempt.error !== null)
    .map((attempt) => `${attempt.providerId}: ${attempt.error}`)
    .slice(0, 2) ?? [];
  const accessLimitations = diagnostics?.accessLimitations.slice(0, 2) ?? [];
  const diagnosticQuestions = [
    suggestedQueries.length > 0
      ? `Which of these revision queries should be tried next: ${suggestedQueries.join(" | ")}?`
      : null,
    providerErrors.length > 0
      ? `Which provider failure should be addressed first: ${providerErrors.join(" | ")}?`
      : null,
    accessLimitations.length > 0
      ? `Which access limitation should be configured first: ${accessLimitations.join(" | ")}?`
      : null
  ].filter((question): question is string => question !== null);

  return [
    ...diagnosticQuestions,
    "Which terminology, entity names, or domain cues should be refined to improve scholarly retrieval quality?",
    "Which provider configuration or credentials are still limiting access to relevant papers?",
    `Which of these planned queries should be refined first: ${plan.searchQueries.slice(0, 3).join(" | ") || "no queries were generated"}?`
  ].slice(0, 5);
}

function insufficientEvidenceAgenda(
  run: RunRecord,
  plan: ResearchPlan,
  nextQuestions: string[],
  failureMessage: string
): ResearchAgenda {
  return {
    executiveSummary: failureMessage,
    gaps: [{
      id: `gap-${run.id}-evidence`,
      title: "Evidence base too thin",
      summary: failureMessage,
      sourceIds: [],
      claimIds: [],
      severity: "high",
      gapKind: "coverage_gap"
    }],
    candidateDirections: [],
    selectedDirectionId: null,
    selectedWorkPackage: null,
    holdReasons: [
      failureMessage,
      ...nextQuestions.slice(0, 2)
    ],
    recommendedHumanDecision: `Continue autonomous literature revision internally. Start with: ${nextQuestions[0] ?? "inspect retrieval settings and revise the retrieval strategy."}`
  };
}

function retrievalDiagnosticHoldReasons(gathered: ResearchSourceGatherResult): string[] {
  const diagnostics = gathered.retrievalDiagnostics;

  if (diagnostics === undefined) {
    return [];
  }

  const providerFailures = diagnostics.providerAttempts
    .filter((attempt) => attempt.error !== null)
    .map((attempt) => `${attempt.providerId} failed: ${attempt.error}`)
    .slice(0, 2);
  const revisionPasses = diagnostics.revisionPasses ?? diagnostics.recoveryPasses ?? 0;
  const recoverySummary = revisionPasses > 0
    ? [`${revisionPasses} revision retrieval pass${revisionPasses === 1 ? "" : "es"} ran, but only ${gathered.reviewedPapers.length} reviewed papers were selected for synthesis.`]
    : [];
  const accessLimitations = diagnostics.accessLimitations.slice(0, 2);
  const suggestedQueries = diagnostics.suggestedNextQueries.length > 0
    ? [`Potential next retrieval queries: ${diagnostics.suggestedNextQueries.slice(0, 3).join(" | ")}.`]
    : [];

  return [
    ...recoverySummary,
    ...providerFailures,
    ...accessLimitations,
    ...suggestedQueries
  ];
}

function agendaWithRetrievalHoldReasons(
  agenda: ResearchAgenda,
  gathered: ResearchSourceGatherResult,
  evidenceMatrix: EvidenceMatrix
): ResearchAgenda {
  if (evidenceMatrix.rowCount >= 3) {
    return agenda;
  }

  const extraReasons = retrievalDiagnosticHoldReasons(gathered);

  if (extraReasons.length === 0) {
    return agenda;
  }

  return {
    ...agenda,
    holdReasons: [...new Set([...agenda.holdReasons, ...extraReasons])].slice(0, 6),
    recommendedHumanDecision: agenda.recommendedHumanDecision.length > 0
      ? agenda.recommendedHumanDecision
      : "Inspect retrieval diagnostics, refine the query plan or provider setup, and rerun the literature pass before continuing."
  };
}

function insufficientEvidenceSynthesisMarkdown(
  run: RunRecord,
  plan: ResearchPlan,
  gathered: ResearchSourceGatherResult,
  nextQuestions: string[],
  failureMessage: string
): string {
  return [
    "# Research Synthesis",
    "",
    "## Outcome",
    "",
    failureMessage,
    "",
    "## Why The Run Stopped",
    "",
    "The current run did not retain any sufficiently reviewed papers to support paper-grounded synthesis, so it stopped before generating claims.",
    "",
    "## Review Workflow",
    "",
    ...reviewWorkflowLines(gathered),
    "",
    "## Planned Research Mode",
    "",
    `- Mode: ${plan.researchMode}`,
    `- Objective: ${plan.objective}`,
    `- Rationale: ${plan.rationale}`,
    "",
    "## Retrieval Notes",
    "",
    ...gathered.notes.map((note) => `- ${note}`),
    "",
    "## Next-Step Questions",
    "",
    ...nextQuestions.map((question) => `- ${question}`)
  ].join("\n");
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
      kind: error instanceof ResearchStageBlockedError
        ? "stage_blocked"
        : backendError?.kind ?? recoveryFailureKind(error),
      operation: error instanceof ResearchStageBlockedError
        ? error.operation
        : backendError?.operation ?? null
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
  const useAgenticSourceLoop = options.sourceGatherer === undefined;
  const injectedSourceGatherer = options.sourceGatherer ?? null;
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
    run.statusMessage = "Run worker started and is preparing the provider-aware research loop.";
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

    const criticReportsByStage = new Map<CriticReviewStage, CriticReviewArtifact[]>();
    const unresolvedNonTerminalCriticReports: CriticReviewArtifact[] = [];
    const agentActionDiagnostics: ResearchActionDiagnostic[] = [];
    const agentActionTransports: AgentActionTransportRecord[] = [];
    const rememberCriticReport = (report: CriticReviewArtifact): void => {
      const reports = criticReportsByStage.get(report.stage) ?? [];
      reports.push(report);
      criticReportsByStage.set(report.stage, reports);
    };

    await writeJsonArtifact(run.artifacts.planPath, plan);
    workStore = await runProtocolWorkspaceLoop({
      run,
      now,
      researchBackend,
      runtimeConfig: runtimeLlmConfig,
      agent,
      diagnostics: agentActionDiagnostics,
      actionTransports: agentActionTransports,
      plan,
      workStore
    });
    const currentProtocol = reviewProtocolFromWorkspace({
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

    const protocolCritic = await reviewWithCritic({
      run,
      now,
      researchBackend,
      runtimeConfig: runtimeLlmConfig,
      request: {
        projectRoot: run.projectRoot,
        runId: run.id,
        stage: "protocol",
        iteration: {
          attempt: 1,
          maxAttempts: Math.max(1, runtimeLlmConfig.evidenceRecoveryMaxPasses + 1),
          revisionPassesUsed: 0
        },
        brief: run.brief,
        protocol: currentProtocol,
        plan
      }
    });
    rememberCriticReport(protocolCritic);
    const protocolCriticWorkItems = workItemsFromCriticReports(run, [protocolCritic], now());
    if (protocolCriticWorkItems.length > 0) {
      workStore = upsertResearchWorkStoreEntities(workStore, protocolCriticWorkItems, now());
      await writeResearchWorkStore(workStore);
      await appendEvent(
        run,
        now,
        "memory",
        `Protocol critic created ${protocolCriticWorkItems.length} visible workspace work item(s).`
      );
    }
    await agent.record({
      actor: "critic",
      phase: "protocol",
      action: "review_protocol",
      status: criticReviewPassed(protocolCritic) ? "completed" : "revising",
      summary: `Protocol critic returned ${protocolCritic.readiness}.`,
      artifactPaths: [run.artifacts.reviewProtocolPath, run.artifacts.criticProtocolReviewPath],
      counts: {
        objections: protocolCritic.objections.length,
        attempt: 1
      }
    });

    if (!criticReviewPassed(protocolCritic)) {
      unresolvedNonTerminalCriticReports.push(protocolCritic);
      await appendEvent(
        run,
        now,
        "literature",
        criticRevisionIsActionable(protocolCritic)
          ? "Protocol critic concerns were recorded as visible work items; the researcher agent owns any protocol revision."
          : "Protocol critic did not provide actionable revision advice; continuing to retrieval and recording the concern as a quality warning."
      );
      await appendStdout(
        run,
        criticRevisionIsActionable(protocolCritic)
          ? "Protocol critic concerns were converted into workspace work items; no protocol search query was invented by the runtime."
          : "Protocol critic gave non-actionable feedback; continuing to retrieval so later concrete checks can validate the actual work."
      );
    }
    await appendTrace(run, now, `Selected research mode: ${plan.researchMode}`);
    await appendEvent(run, now, "summary", `Selected research mode ${plan.researchMode}: ${plan.objective}`);
    await appendStdout(run, `Selected research mode: ${plan.researchMode}`);
    await appendStdout(run, `Planning rationale: ${plan.rationale}`);
    await appendEvent(run, now, "next", "Gather provider-aware scholarly sources and merge them into canonical papers.");

    let pendingRecoveryQueries: string[] = [];
    let autonomousRecoveryPasses = 0;
    const evidenceRecoveryStartedAtMs = Date.now();
    let finalAgenda: ResearchAgenda | null = null;
    let finalManuscriptBundle: ManuscriptBundle | null = null;
    let finalGathered: ResearchSourceGatherResult | null = null;
    let finalPaperExtractions: PaperExtraction[] = [];
    let finalEvidenceMatrix: EvidenceMatrix | null = null;
    let finalSynthesis: ResearchSynthesis | null = null;
    let finalContinuationLimitReason: string | null = null;
    let previousEvidenceQuality: EvidenceQualitySnapshot | null = null;
    let bestUsefulGathered: ResearchSourceGatherResult | null = null;
    let nonImprovingEvidencePasses = 0;

    while (true) {
    await writeJsonArtifact(run.artifacts.planPath, plan);
    const evidencePassNumber = autonomousRecoveryPasses + 1;
    await appendEvent(run, now, "literature", `Starting evidence pass ${evidencePassNumber}.`);
    if (pendingRecoveryQueries.length > 0) {
      await appendStdout(run, `Autonomous evidence revision queries: ${pendingRecoveryQueries.join(" | ")}`);
    }
    await writeSourceGatherCheckpoint({
      run,
      now,
      evidencePass: evidencePassNumber,
      revisionPasses: autonomousRecoveryPasses,
      maxRevisionPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses,
      event: {
        phase: "setup",
        status: "started",
        message: `Starting incremental source gathering for evidence pass ${evidencePassNumber}.`
      }
    });

    const sourceRequest: ResearchSourceGatherRequest = {
      projectRoot: run.projectRoot,
      brief: run.brief,
      plan,
      memoryContext,
      literatureContext,
      revisionQueries: pendingRecoveryQueries,
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
        await writeSourceGatherCheckpoint({
          run,
          now,
          evidencePass: evidencePassNumber,
          revisionPasses: autonomousRecoveryPasses,
          maxRevisionPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses,
          event
        });
      }
    };
    const sourceLoopResult = useAgenticSourceLoop
      ? await runAgenticSourceGathering({
        run,
        now,
        researchBackend,
        runtimeConfig: runtimeLlmConfig,
        agent,
        request: sourceRequest,
        diagnostics: agentActionDiagnostics,
        actionTransports: agentActionTransports,
        evidencePassNumber,
        workStore
      })
      : null;
    if (sourceLoopResult !== null) {
      workStore = sourceLoopResult.workStore;
    }
    if (sourceLoopResult === null && injectedSourceGatherer === null) {
      throw new Error("Source gathering requires the agentic source loop or an explicitly injected test adapter.");
    }
    if (sourceLoopResult === null) {
      await appendEvent(run, now, "summary", "Using explicitly injected source gatherer adapter; production/default execution uses the agentic source tool loop.");
    }
    let gathered = sourceLoopResult?.gathered ?? await injectedSourceGatherer!.gather(sourceRequest);
    if ((gathered.canonicalPapers.length === 0 || gathered.reviewedPapers.length === 0) && bestUsefulGathered !== null) {
      await appendEvent(
        run,
        now,
        "literature",
        "Candidate evidence revision produced no selected sources; preserving the current useful evidence set from the workspace."
      );
      await appendStdout(
        run,
        `Evidence revision candidate produced ${gathered.canonicalPapers.length} canonical papers and ${gathered.reviewedPapers.length} selected papers; preserving ${bestUsefulGathered.canonicalPapers.length} canonical papers and ${bestUsefulGathered.reviewedPapers.length} selected papers.`
      );
      gathered = bestUsefulGathered;
    }
    pendingRecoveryQueries = [];
    const currentEvidenceQuality = evidenceQualitySnapshot(gathered);
    const evidenceImproved = evidenceQualityImproved(previousEvidenceQuality, currentEvidenceQuality);
    if (previousEvidenceQuality !== null) {
      if (evidenceImproved) {
        nonImprovingEvidencePasses = 0;
        await appendEvent(run, now, "literature", "Evidence revision expanded the selected source set or improved source continuity.");
        await appendStdout(run, "Evidence revision improved the source-set continuity score.");
      } else {
        nonImprovingEvidencePasses += 1;
        await appendEvent(run, now, "literature", "Evidence revision did not improve the selected source set.");
        await appendStdout(run, "Evidence revision did not improve the source-set continuity score.");
      }
    }
    previousEvidenceQuality = currentEvidenceQuality;
    const canonicalIdByAnyPaperId = canonicalPaperIdMap(gathered.canonicalPapers);
    const canonicalReviewedPapers = canonicalizePapers(gathered.reviewedPapers);

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
      autonomousEvidence: {
        pass: evidencePassNumber,
        revisionPasses: autonomousRecoveryPasses,
        maxRevisionPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses
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
      agenticSourceState: gathered.agenticSourceState ?? null,
      mergeDiagnostics: gathered.mergeDiagnostics,
      literatureReview: gathered.literatureReview ?? null
    });
    await appendTrace(run, now, `Evidence pass ${evidencePassNumber} gathered ${gathered.sources.length} raw sources and ${gathered.canonicalPapers.length} canonical papers.`);
    await appendEvent(run, now, "summary", `Evidence pass ${evidencePassNumber} gathered ${gathered.canonicalPapers.length} canonical papers for synthesis.`);
    await appendEvent(
      run,
      now,
      "literature",
      `Review workflow: title ${gathered.reviewWorkflow.counts.titleScreened}, abstract ${gathered.reviewWorkflow.counts.abstractScreened}, full-text ${gathered.reviewWorkflow.counts.fulltextScreened}, included ${gathered.reviewWorkflow.counts.included}, selected ${gathered.reviewWorkflow.counts.selectedForSynthesis}.`
    );
    await agent.record({
      phase: "evidence",
      action: "gather_and_screen_sources",
      status: "completed",
      summary: `Evidence pass ${evidencePassNumber} gathered and screened candidate literature.`,
      artifactPaths: [run.artifacts.sourcesPath],
      counts: {
        pass: evidencePassNumber,
        rawSources: gathered.sources.length,
        canonicalPapers: gathered.canonicalPapers.length,
        includedPapers: gathered.reviewWorkflow.counts.included,
        selectedPapers: gathered.reviewWorkflow.counts.selectedForSynthesis
      }
    });

    const currentProtocol = reviewProtocolFromWorkspace({
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

    const sourceSelectionCritic = await reviewWithCritic({
      run,
      now,
      researchBackend,
      runtimeConfig: runtimeLlmConfig,
      request: {
        projectRoot: run.projectRoot,
        runId: run.id,
        stage: "source_selection",
        iteration: {
          attempt: autonomousRecoveryPasses + 1,
          maxAttempts: runtimeLlmConfig.evidenceRecoveryMaxPasses + 1,
          revisionPassesUsed: autonomousRecoveryPasses
        },
        brief: run.brief,
        protocol: currentProtocol,
        plan,
        selectedPapers: canonicalReviewedPapers,
        relevanceAssessments: gathered.relevanceAssessments ?? [],
        gathered: {
          reviewWorkflow: gathered.reviewWorkflow,
          retrievalDiagnostics: gathered.retrievalDiagnostics,
          notes: gathered.notes
        }
      }
    });
    rememberCriticReport(sourceSelectionCritic);
    const sourceCriticWorkItems = workItemsFromCriticReports(run, [sourceSelectionCritic], now());
    if (sourceCriticWorkItems.length > 0) {
      workStore = upsertResearchWorkStoreEntities(workStore, sourceCriticWorkItems, now());
      await writeResearchWorkStore(workStore);
      await appendEvent(
        run,
        now,
        "memory",
        `Source-selection critic created ${sourceCriticWorkItems.length} visible workspace work item(s).`
      );
    }
    await agent.record({
      actor: "critic",
      phase: "source_selection",
      action: "review_selected_sources",
      status: criticReviewPassed(sourceSelectionCritic) ? "completed" : "revising",
      summary: `Source-selection critic returned ${sourceSelectionCritic.readiness}.`,
      artifactPaths: [run.artifacts.criticSourceSelectionPath],
      counts: {
        objections: sourceSelectionCritic.objections.length,
        revisionPasses: autonomousRecoveryPasses
      }
    });

    if (!criticReviewPassed(sourceSelectionCritic)) {
      const criticActionable = criticRevisionIsActionable(sourceSelectionCritic);
      unresolvedNonTerminalCriticReports.push(sourceSelectionCritic);
      await appendEvent(
        run,
        now,
        "next",
        criticActionable
          ? "Source-selection critic concerns were recorded as visible work items; the researcher agent will decide whether to search, exclude, promote, or revise."
          : "Source-selection critic did not provide actionable revision advice; continuing to extraction and recording the concern as a quality warning."
      );
      await appendStdout(
        run,
        criticActionable
          ? "Source-selection critic concerns were converted into workspace work items; no source set was mutated by the runtime."
          : "Source-selection critic gave non-actionable feedback; continuing so evidence, synthesis, and final checks can produce concrete diagnostics."
      );
    }

    for (const note of gathered.notes) {
      await appendStdout(run, note);
    }

    const previewPapers = gathered.reviewedPapers.length > 0
      ? gathered.reviewedPapers.slice(0, 4)
      : gathered.canonicalPapers.slice(0, 4);

    for (const paper of previewPapers) {
      await appendEvent(run, now, "source", summarizeReviewedPaper(paper));
      await appendStdout(run, `Reviewed paper: ${summarizeReviewedPaper(paper)}`);
    }

    if (gathered.canonicalPapers.length === 0 || gathered.reviewedPapers.length === 0) {
      const nextQuestions = insufficientEvidenceNextQuestions(plan, gathered);
      const failureMessage = gathered.canonicalPapers.length === 0
        ? "Literature retrieval did not retain any canonical papers that could ground synthesis."
        : "The review workflow did not retain any sufficiently reviewed papers for synthesis.";
      const terminalFailureMessage = `${failureMessage} The runtime recorded this as machine-actionable research debt rather than inventing replacement search queries.`;
      const paperExtractions: PaperExtraction[] = [];
      const evidenceMatrix = buildEvidenceMatrix({
        runId: run.id,
        brief: run.brief,
        paperExtractions
      });
      const verification = verifyResearchClaims({
        brief: run.brief,
        papers: [],
        claims: []
      });

      await writeJsonArtifact(run.artifacts.paperExtractionsPath, paperExtractionsArtifact(run, canonicalReviewedPapers.length, paperExtractions));
      await writeJsonArtifact(run.artifacts.verificationPath, verification);
      await writeJsonArtifact(run.artifacts.nextQuestionsPath, nextQuestions);
      const agenda = agendaWithRetrievalHoldReasons(
        insufficientEvidenceAgenda(run, plan, nextQuestions, terminalFailureMessage),
        gathered,
        evidenceMatrix
      );
      const insufficientSynthesis: ResearchSynthesis = {
        executiveSummary: terminalFailureMessage,
        themes: [],
        claims: [],
        nextQuestions
      };
      workStore = await commitWorkStoreSegment({
        store: workStore,
        run,
        plan,
        gathered,
        paperExtractions,
        evidenceMatrix,
        synthesis: null,
        verification: null,
        agenda: null,
        manuscriptBundle: null,
        criticReportsByStage,
        now: now()
      });
      let manuscriptBundle = workspaceManuscriptBundle({
        run,
        plan,
        store: workStore,
        synthesis: insufficientSynthesis,
        scholarlyDiscoveryProviders,
        publisherFullTextProviders,
        oaRetrievalHelperProviders,
        generalWebProviders,
        localContextEnabled: localEnabled,
        gathered,
        evidenceMatrix
      });
      if (unresolvedNonTerminalCriticReports.length > 0) {
        manuscriptBundle = applyCriticReportsToManuscriptBundle(
          run,
          manuscriptBundle,
          unresolvedNonTerminalCriticReports
        );
      }
      await writeJsonArtifact(run.artifacts.agendaPath, agenda);
      await writeResearchDirection(run, agenda, now());
      await writeFile(run.artifacts.agendaMarkdownPath, `${agendaMarkdown(run, plan, agenda)}\n`, "utf8");
      await writeManuscriptArtifacts(run, manuscriptBundle);
      await writeJsonArtifact(run.artifacts.qualityReportPath, buildQualityReport({
        run,
        backendLabel: researchBackend.label,
        gathered,
        paperExtractions,
        evidenceMatrix,
        manuscriptBundle,
        criticReportsByStage,
        agentActionDiagnostics,
        agentActionTransports,
        agentControlMode: runtimeLlmConfig.agentControlMode,
        autonomousRevisionPasses: autonomousRecoveryPasses,
        revisionBudgetPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses
      }));
      await appendEvent(run, now, "summary", "Insufficient evidence state was persisted in the workspace and quality artifacts.");
      workStore = await commitWorkStoreSegment({
        store: workStore,
        run,
        plan,
        gathered,
        paperExtractions,
        evidenceMatrix,
        synthesis: insufficientSynthesis,
        verification,
        agenda,
        manuscriptBundle,
        criticReportsByStage,
        now: now()
      });
      const workStoreSummary = summarizeResearchWorkStore(workStore);

      await appendStderr(run, terminalFailureMessage);
      await appendTrace(run, now, terminalFailureMessage);
      await appendEvent(run, now, "summary", terminalFailureMessage);
      await appendEvent(run, now, "verify", verification.summary);
      await appendStdout(run, `Verification: ${verification.summary}`);
      await appendEvent(
        run,
        now,
        "memory",
        `Updated research work store: ${workStoreSummary.canonicalSources} canonical sources, ${workStoreSummary.evidenceCells} evidence cells, ${workStoreSummary.openWorkItems} open work items.`
      );
      await appendStdout(
        run,
        `Research work store updated: ${workStoreSummary.canonicalSources} sources, ${workStoreSummary.openWorkItems} open work items.`
      );

      for (const question of nextQuestions) {
        await appendEvent(run, now, "next", question);
      }

      await appendEvent(run, now, "plan", "Agenda generation completed with a hold after autonomous evidence revision was exhausted.");
      await appendStdout(run, `Agenda hold: ${agenda.recommendedHumanDecision}`);
      await appendEvent(run, now, "summary", `Manuscript status: ${manuscriptBundle.checks.readinessStatus}.`);
      await appendStdout(run, `Paper artifact: ${relativeArtifactPath(run.projectRoot, run.artifacts.paperPath)} (${manuscriptBundle.checks.readinessStatus})`);
      const workerState = await writeWorkerStateForRun({
        run,
        previousState: previousWorkerState,
        gathered,
        paperExtractions,
        evidenceMatrix,
        synthesis: insufficientSynthesis,
        agenda,
        manuscriptBundle,
        criticReportsByStage,
        revisionPasses: autonomousRecoveryPasses,
        revisionBudgetPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses,
        continuationLimitReason: terminalFailureMessage,
        now: now()
      });
      await agent.record({
        phase: "release",
        action: "write_status_only_artifacts",
        status: "completed",
        summary: "Wrote status-only artifacts because autonomous evidence revision could not produce a sufficient reviewed set.",
        artifactPaths: [
          run.artifacts.paperPath,
          run.artifacts.paperJsonPath,
          run.artifacts.manuscriptChecksPath,
          run.artifacts.qualityReportPath,
          researchWorkStoreFilePath(run.projectRoot)
        ],
        counts: {
          reviewedPapers: canonicalReviewedPapers.length,
          extractedPapers: paperExtractions.length,
          revisionPasses: autonomousRecoveryPasses
        }
      });

      run.job.finishedAt = now();
      run.finishedAt = now();
      run.job.exitCode = 0;
      run.job.signal = null;
      run.workerPid = null;
      run.status = "completed";
      run.statusMessage = workerState.status === "externally_blocked"
        ? "Autonomous research worker segment paused because external access or credentials are required."
        : workerState.status === "needs_user_decision"
          ? "Autonomous research worker segment paused because a user research decision is required."
          : "Autonomous research worker segment checkpointed; remaining evidence work is machine-actionable.";
      await store.save(run);
      await appendEvent(run, now, "run", run.statusMessage);
      return 0;
    }

    await appendEvent(run, now, "next", "Extract structured paper records from the reviewed paper set.");
    await agent.record({
      phase: "extraction",
      action: "extract_selected_papers",
      status: "started",
      summary: `Extract structured records for ${canonicalReviewedPapers.length} selected reviewed papers.`,
      artifactPaths: [run.artifacts.paperExtractionsPath],
      counts: {
        selectedPapers: canonicalReviewedPapers.length
      }
    });

    const extractionResult = await extractReviewedPapersWithRecovery({
      run,
      now,
      researchBackend,
      runtimeConfig: runtimeLlmConfig,
      plan,
      papers: canonicalReviewedPapers,
      literatureContext
    });
    const paperExtractions = completePaperExtractions(
      run,
      canonicalReviewedPapers,
      remapPaperExtractions(extractionResult.extractions, canonicalIdByAnyPaperId)
    );

    await writeJsonArtifact(run.artifacts.paperExtractionsPath, paperExtractionsArtifact(
      run,
      canonicalReviewedPapers.length,
      paperExtractions,
      {
        status: "completed",
        completedPaperIds: paperExtractions.map((extraction) => extraction.paperId),
        failedPaperIds: [],
        batchAttempts: extractionResult.attempts
      }
    ));
    await appendEvent(run, now, "summary", `Extracted ${paperExtractions.length} paper records from the reviewed set.`);
    await appendStdout(run, `Paper extractions written: ${paperExtractions.length}`);
    await agent.record({
      phase: "extraction",
      action: "checkpoint_extractions",
      status: "completed",
      summary: `Extracted ${paperExtractions.length}/${canonicalReviewedPapers.length} selected papers with adaptive batches.`,
      artifactPaths: [run.artifacts.paperExtractionsPath],
      counts: {
        extractedPapers: paperExtractions.length,
        selectedPapers: canonicalReviewedPapers.length,
        attempts: extractionResult.attempts.length
      }
    });

    await appendEvent(run, now, "next", "Build the cross-paper evidence matrix from the reviewed extractions.");

    const evidenceMatrix = buildEvidenceMatrix({
      runId: run.id,
      brief: run.brief,
      paperExtractions
    });
    const normalizedEvidenceMatrix = remapEvidenceMatrix(evidenceMatrix, canonicalIdByAnyPaperId);
    if (paperExtractions.length > 0 && normalizedEvidenceMatrix.rowCount > 0) {
      bestUsefulGathered = gathered;
    }

    await appendEvent(run, now, "memory", `Evidence matrix view updated in workspace from ${normalizedEvidenceMatrix.rowCount} extraction row(s).`);
    await appendStdout(run, `Evidence matrix rows: ${normalizedEvidenceMatrix.rowCount}`);
    await agent.record({
      phase: "evidence",
      action: "build_evidence_matrix",
      status: "completed",
      summary: "Built the cross-paper evidence matrix from selected-paper extractions.",
      artifactPaths: [researchWorkStoreFilePath(run.projectRoot)],
      counts: {
        rows: normalizedEvidenceMatrix.rowCount,
        insights: normalizedEvidenceMatrix.derivedInsights.length
      }
    });

    const evidenceCritic = await reviewWithCritic({
      run,
      now,
      researchBackend,
      runtimeConfig: runtimeLlmConfig,
      request: {
        projectRoot: run.projectRoot,
        runId: run.id,
        stage: "evidence",
        iteration: {
          attempt: autonomousRecoveryPasses + 1,
          maxAttempts: runtimeLlmConfig.evidenceRecoveryMaxPasses + 1,
          revisionPassesUsed: autonomousRecoveryPasses
        },
        brief: run.brief,
        protocol: currentProtocol,
        plan,
        selectedPapers: canonicalReviewedPapers,
        relevanceAssessments: gathered.relevanceAssessments ?? [],
        paperExtractions,
        evidenceMatrix: normalizedEvidenceMatrix
      }
    });
    rememberCriticReport(evidenceCritic);
    await agent.record({
      actor: "critic",
      phase: "evidence",
      action: "review_evidence_matrix",
      status: criticReviewPassed(evidenceCritic) ? "completed" : "revising",
      summary: `Evidence critic returned ${evidenceCritic.readiness}.`,
      artifactPaths: [run.artifacts.criticEvidenceReviewPath, researchWorkStoreFilePath(run.projectRoot)],
      counts: {
        objections: evidenceCritic.objections.length,
        rows: normalizedEvidenceMatrix.rowCount,
        revisionPasses: autonomousRecoveryPasses
      }
    });

    if (!criticReviewPassed(evidenceCritic)) {
      const criticActionable = criticRevisionIsActionable(evidenceCritic);
      unresolvedNonTerminalCriticReports.push(evidenceCritic);
      await appendEvent(
        run,
        now,
        "next",
        criticActionable
          ? "Evidence critic concerns were recorded as visible work items; the researcher agent will decide whether to search, re-extract, revise claims, or continue."
          : "Evidence critic did not provide actionable revision advice; continuing to synthesis and recording the concern as a quality warning."
      );
      await appendStdout(
        run,
        criticActionable
          ? "Evidence critic concerns were converted into workspace work items; no search query was invented by the runtime."
          : "Evidence critic gave non-actionable feedback; continuing to synthesis so deterministic manuscript checks can produce concrete diagnostics."
      );
    }

    workStore = await commitWorkStoreSegment({
      store: workStore,
      run,
      plan,
      gathered,
      paperExtractions,
      evidenceMatrix: normalizedEvidenceMatrix,
      synthesis: null,
      verification: null,
      agenda: null,
      manuscriptBundle: null,
      criticReportsByStage,
      now: now()
    });

    const manuscriptLoop = await runManuscriptWorkspaceLoop({
      run,
      now,
      researchBackend,
      runtimeConfig: runtimeLlmConfig,
      agent,
      diagnostics: agentActionDiagnostics,
      actionTransports: agentActionTransports,
      plan,
      gathered,
      paperExtractions,
      evidenceMatrix: normalizedEvidenceMatrix,
      workStore,
      revisionPassesUsed: autonomousRecoveryPasses
    });
    workStore = manuscriptLoop.workStore;

    if (manuscriptLoop.requestedRevision) {
      const recoveryUpdate = evidenceRecoveryPlanUpdate(
        plan,
        manuscriptLoop.revisionQueries,
        manuscriptLoop.revisionFocusTerms
      );
      if (
        recoveryUpdate !== null
        && autonomousRecoveryPasses < runtimeLlmConfig.evidenceRecoveryMaxPasses
        && !evidenceRecoveryBudgetExhausted(evidenceRecoveryStartedAtMs, runtimeLlmConfig)
        && nonImprovingEvidencePasses < 2
      ) {
        autonomousRecoveryPasses += 1;
        plan = recoveryUpdate.plan;
        pendingRecoveryQueries = recoveryUpdate.recoveryQueries;
        await appendEvent(
          run,
          now,
          `next`,
          `Manuscript workspace requested more evidence; continuing autonomously with evidence revision pass ${autonomousRecoveryPasses}.`
        );
        await appendStdout(run, `Evidence revision pass ${autonomousRecoveryPasses}: ${pendingRecoveryQueries.join(" | ")}`);
        continue;
      }
      finalContinuationLimitReason = "The manuscript workspace requested more evidence, but no useful revision budget or unused query plan remained.";
      await appendEvent(run, now, "next", finalContinuationLimitReason);
    }

    const normalizedSynthesis = remapSynthesisSourceIds(workspaceSynthesisFromStore({
      run,
      store: workStore
    }), canonicalIdByAnyPaperId);
    const verification = verifyResearchClaims({
      brief: run.brief,
      papers: canonicalReviewedPapers,
      claims: normalizedSynthesis.claims
    });
    const agenda = await researchBackend.developResearchAgenda({
      projectRoot: run.projectRoot,
      brief: run.brief,
      plan,
      papers: canonicalReviewedPapers,
      paperExtractions,
      evidenceMatrix: normalizedEvidenceMatrix,
      synthesis: normalizedSynthesis,
      verification,
      memoryContext,
      literatureContext
    }, {
      operation: "agenda",
      timeoutMs: runtimeLlmConfig.agendaTimeoutMs
    });
    const normalizedAgenda = agendaWithRetrievalHoldReasons(
      remapAgendaSourceIds(agenda, canonicalIdByAnyPaperId),
      gathered,
      normalizedEvidenceMatrix
    );
    let manuscriptBundle = workspaceManuscriptBundle({
      run,
      plan,
      scholarlyDiscoveryProviders,
      publisherFullTextProviders,
      oaRetrievalHelperProviders,
      generalWebProviders,
      localContextEnabled: localEnabled,
        gathered,
        store: workStore,
        synthesis: normalizedSynthesis,
        evidenceMatrix: normalizedEvidenceMatrix
      });

    if (manuscriptBundle.checks.readinessStatus === "ready_for_revision") {
      const releaseCritic = await reviewWithCritic({
        run,
        now,
        researchBackend,
        runtimeConfig: runtimeLlmConfig,
        request: {
          projectRoot: run.projectRoot,
          runId: run.id,
          stage: "release",
          iteration: {
            attempt: 1,
            maxAttempts: 1,
            revisionPassesUsed: autonomousRecoveryPasses
          },
          brief: run.brief,
          protocol: manuscriptBundle.protocol,
          plan,
          selectedPapers: canonicalReviewedPapers,
          relevanceAssessments: gathered.relevanceAssessments ?? [],
          paperExtractions,
          evidenceMatrix: normalizedEvidenceMatrix,
          synthesis: normalizedSynthesis,
          verification,
          agenda: normalizedAgenda,
          paper: manuscriptBundle.paper,
          references: manuscriptBundle.references,
          manuscriptChecks: manuscriptBundle.checks
        }
      });
      rememberCriticReport(releaseCritic);
      const releaseCriticPassed = criticReviewPassed(releaseCritic);
      await agent.record({
        actor: "critic",
        phase: "release",
        action: "review_release_candidate",
        status: releaseCriticPassed ? "completed" : "revising",
        summary: `Release critic returned ${releaseCritic.readiness}.`,
        artifactPaths: [run.artifacts.criticReleaseReviewPath, run.artifacts.manuscriptChecksPath],
        counts: {
          objections: releaseCritic.objections.length,
          revisionPasses: autonomousRecoveryPasses
        }
      });
      manuscriptBundle = applyCriticReportsToManuscriptBundle(
        run,
        manuscriptBundle,
        [releaseCritic]
      );
      if (!releaseCriticPassed) {
        await appendEvent(run, now, "next", "Release critic diagnostics were recorded as visible warnings/work items; they do not override computable release invariants.");
      }
    } else {
      await writeJsonArtifact(run.artifacts.criticReleaseReviewPath, skippedArtifactStatus(
        run,
        "critic-release-review",
        now(),
        "Release critic only runs after deterministic manuscript checks are ready for revision."
      ));
    }

    if (manuscriptBundle.checks.readinessStatus === "needs_more_evidence") {
      finalContinuationLimitReason = "Manuscript checks still need more evidence; the runtime recorded this as internal research work instead of deriving replacement search queries.";
      await appendEvent(run, now, "next", finalContinuationLimitReason);
    }

    if (unresolvedNonTerminalCriticReports.length > 0) {
      manuscriptBundle = applyCriticReportsToManuscriptBundle(
        run,
        manuscriptBundle,
        unresolvedNonTerminalCriticReports
      );
    }

    await writeJsonArtifact(run.artifacts.nextQuestionsPath, normalizedSynthesis.nextQuestions);
    await writeJsonArtifact(run.artifacts.verificationPath, verification);
    await writeJsonArtifact(run.artifacts.agendaPath, normalizedAgenda);
    await writeResearchDirection(run, normalizedAgenda, now());
    await writeFile(run.artifacts.agendaMarkdownPath, `${agendaMarkdown(run, plan, normalizedAgenda)}\n`, "utf8");
    await writeManuscriptArtifacts(run, manuscriptBundle);
    await writeJsonArtifact(run.artifacts.qualityReportPath, buildQualityReport({
      run,
      backendLabel: researchBackend.label,
      gathered,
      paperExtractions,
      evidenceMatrix: normalizedEvidenceMatrix,
      manuscriptBundle,
      criticReportsByStage,
      agentActionDiagnostics,
      agentActionTransports,
      agentControlMode: runtimeLlmConfig.agentControlMode,
      autonomousRevisionPasses: autonomousRecoveryPasses,
      revisionBudgetPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses
    }));
    await appendEvent(run, now, "summary", "Synthesis state was persisted through workspace claims, support links, sections, and final paper exports.");
    await agent.record({
      phase: "release",
      action: "write_workspace_artifacts",
      status: manuscriptBundle.checks.readinessStatus === "blocked" ? "blocked" : "completed",
      summary: `Derived artifacts written from work-store claims, evidence, citations, and manuscript sections with readiness ${manuscriptBundle.checks.readinessStatus}.`,
      artifactPaths: [
        run.artifacts.paperPath,
        run.artifacts.paperJsonPath,
        run.artifacts.manuscriptChecksPath,
        run.artifacts.qualityReportPath
      ],
      counts: {
        blockerCount: manuscriptBundle.checks.blockerCount,
        warningCount: manuscriptBundle.checks.warningCount,
        claims: normalizedSynthesis.claims.length
      }
    });
    workStore = await commitWorkStoreSegment({
      store: workStore,
      run,
      plan,
      gathered,
      paperExtractions,
      evidenceMatrix: normalizedEvidenceMatrix,
      synthesis: normalizedSynthesis,
      verification,
      agenda: normalizedAgenda,
      manuscriptBundle,
      criticReportsByStage,
      now: now()
    });
    const workStoreSummary = summarizeResearchWorkStore(workStore);

    await appendTrace(run, now, "Workspace manuscript construction completed.");
    await appendEvent(run, now, "summary", normalizedSynthesis.executiveSummary);
    await appendEvent(run, now, "summary", `Manuscript status: ${manuscriptBundle.checks.readinessStatus}.`);
    await appendEvent(run, now, "verify", verification.summary);
    await appendStdout(run, `Verification: ${verification.summary}`);
    await appendStdout(run, `Paper artifact: ${relativeArtifactPath(run.projectRoot, run.artifacts.paperPath)} (${manuscriptBundle.checks.readinessStatus})`);
    for (const verifiedClaim of verification.verifiedClaims.slice(0, 4)) {
      await appendStdout(run, `Verification detail: ${summarizeVerifiedClaim(verifiedClaim)}`);
    }
    await appendEvent(
      run,
      now,
      "memory",
      `Updated research work store: ${workStoreSummary.canonicalSources} canonical sources, ${workStoreSummary.claims} claims, ${workStoreSummary.openWorkItems} open work items.`
    );
    await appendStdout(
      run,
      `Research work store updated: ${workStoreSummary.canonicalSources} sources, ${workStoreSummary.claims} claims, ${workStoreSummary.openWorkItems} open work items.`
    );

    for (const claim of normalizedSynthesis.claims.slice(0, 4)) {
      await appendEvent(run, now, "claim", summarizeClaim(claim));
      await appendStdout(run, `Claim recorded: ${summarizeClaim(claim)}`);
    }

    for (const question of normalizedSynthesis.nextQuestions) {
      await appendEvent(run, now, "next", question);
    }

    await appendEvent(run, now, "plan", `Agenda generated with ${normalizedAgenda.candidateDirections.length} candidate directions.`);

    finalAgenda = normalizedAgenda;
    finalManuscriptBundle = manuscriptBundle;
    finalGathered = gathered;
    finalPaperExtractions = paperExtractions;
    finalEvidenceMatrix = normalizedEvidenceMatrix;
    finalSynthesis = normalizedSynthesis;
    break;
    }

    if (finalAgenda === null || finalManuscriptBundle === null || finalEvidenceMatrix === null || finalSynthesis === null) {
      throw new Error("Literature review loop ended without a final agenda and manuscript bundle.");
    }

    const completedAt = now();
    const workerState = await writeWorkerStateForRun({
      run,
      previousState: previousWorkerState,
      gathered: finalGathered,
      paperExtractions: finalPaperExtractions,
      evidenceMatrix: finalEvidenceMatrix,
      synthesis: finalSynthesis,
      agenda: finalAgenda,
      manuscriptBundle: finalManuscriptBundle,
      criticReportsByStage,
      revisionPasses: autonomousRecoveryPasses,
      revisionBudgetPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses,
      continuationLimitReason: finalContinuationLimitReason,
      now: completedAt
    });
    await appendEvent(run, now, "run", `Autonomous worker state: ${workerState.status}.`);
    run.job.finishedAt = completedAt;
    run.finishedAt = completedAt;
    run.job.exitCode = 0;
    run.job.signal = null;
    run.workerPid = null;
    run.status = "completed";
    run.statusMessage = workerState.status === "release_ready"
      ? "Autonomous research worker segment completed with a release-ready manuscript artifact."
      : workerState.status === "externally_blocked"
        ? "Autonomous research worker segment paused because external access or credentials are required."
        : workerState.status === "needs_user_decision"
          ? "Autonomous research worker segment paused because a user research decision is required."
          : "Autonomous research worker segment checkpointed; remaining work is machine-actionable.";
    await store.save(run);
    await appendEvent(run, now, "run", run.statusMessage);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
      status: error instanceof ResearchStageBlockedError ? "externally_blocked" : "working",
      activeRunId: null,
      lastRunId: run.id,
      segmentCount: (previousWorkerState.segmentCount ?? 0) + 1,
      updatedAt: finishedAt,
      statusReason: error instanceof ResearchStageBlockedError
        ? `Autonomous research worker hit an external blocker: ${message}`
        : `Autonomous research worker segment failed; retry or inspect diagnostics: ${message}`,
      paperReadiness: null,
      nextInternalActions: error instanceof ResearchStageBlockedError ? [] : [`Inspect failed run diagnostics and retry the autonomous worker segment: ${message}`],
      userBlockers: error instanceof ResearchStageBlockedError ? [message] : [],
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
