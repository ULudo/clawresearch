import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createLiteratureEntityId,
  type CanonicalPaper,
} from "./literature-store.js";
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
  criticUnavailableReview,
  normalizeCriticReview,
  type CriticReviewArtifact,
  type CriticReviewRequest,
  type CriticReviewScope,
  type CriticReviewedWorkspaceSnapshot
} from "./research-critic.js";
import {
  SourceToolRuntime,
  collectResearchLocalFileHints,
  type SourceToolState,
  type ResearchSourceToolRequest,
  type SourceToolProgressEvent,
  type ResearchSourceToolAdapter,
  type ResearchSourceSnapshot,
  type SourceToolObservation,
  type SourceEvidenceSelectionMode
} from "./research-sources.js";
import {
  type RunController
} from "./run-controller.js";
import type { SourceProviderId } from "./provider-registry.js";
import { appendRunEvent, type RunEventKind } from "./run-events.js";
import {
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
	  buildNotebookDiagnostics,
  buildResearchCorpusDiagnosticView,
  buildResearchSynthesisDiagnosticView,
  buildWorkspaceDispositionDiagnostics,
	  buildWorkspacePromptContextFromWorkStore,
	  createResearchWorkStoreEntity,
	  defaultNotebookReadiness,
	  loadResearchWorkStore,
  mergeRunSegmentIntoResearchWorkStore,
  normalizeResearchMissionTarget,
  normalizeResearchPaperMode,
	  patchResearchWorkStoreEntity,
  queryResearchWorkStore,
  readResearchWorkStoreEntity,
  researchObjectIsActive,
  researchObjectLifecycleStatus,
  researchWorkStoreFilePath,
  summarizeResearchWorkStore,
  upsertResearchWorkStoreEntities,
  writeResearchWorkStore,
  type ResearchWorkStore,
  type ResearchWorkerCompletion,
  type ResearchNotebook,
  type ResearchNotebookArtifactLink,
	  type ResearchNotebookTask,
	  type ResearchNotebookDiagnostics,
  type ResearchWorkspaceDispositionDiagnostics,
  type ResearchMissionTarget,
  type ResearchPaperMode,
  type WorkStoreCollectionName,
  type WorkStoreCanonicalSource,
  type WorkStoreClaim,
  type WorkStoreCitation,
  type WorkStoreEvidenceCell,
  type WorkStoreEntity,
  type WorkStoreEntityKind,
  type WorkStoreExtraction,
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

class ActionSelectionProviderUnavailableCheckpoint extends Error {
  constructor(
    public readonly phase: string,
    public readonly diagnostics: ResearchActionDiagnostic[]
  ) {
    const lastMessage = diagnostics.at(-1)?.message ?? "provider unavailable";
    const retryCount = Math.max(0, diagnostics.length - 1);
    super(`Research agent action provider unavailable after ${retryCount} retry(s) and ${diagnostics.length} failed provider call(s): ${lastMessage}`);
    this.name = "ActionSelectionProviderUnavailableCheckpoint";
  }
}

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
    modelPlannedQueries: state.modelPlannedQueries,
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
    repeatedSearchFacts: state.repeatedSearchFacts,
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
  const notebookDiagnostics = buildNotebookDiagnostics(store);
  const corpusView = buildResearchCorpusDiagnosticView(store);
  const synthesisView = buildResearchSynthesisDiagnosticView(store);
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
      notebookDiagnostics,
      recentCriticReviews: criticReviewSummariesFromNotebook(store),
      releaseCriticFreshness: criticFreshnessEvaluationForStore({
        store,
        stage: "release"
      }),
      recentlyChangedIds: recentlyChangedWorkspaceIds(store),
      suggestedLookupTools: ["workspace.list", "workspace.search", "workspace.read"],
      corpus_view: corpusView,
      synthesis_view: synthesisView
    },
	    worker: {
	      status: store.worker.status,
	      completion: store.worker.completion,
	      statusReason: store.worker.statusReason,
	      paperReadiness: store.worker.paperReadiness,
	      nextInternalActions: store.worker.nextInternalActions.slice(0, 8),
	      userBlockers: store.worker.userBlockers.slice(0, 8)
	    },
	    notebook: {
	      missionTarget: store.notebook.missionTarget,
	      paperMode: store.notebook.paperMode,
	      objective: store.notebook.objective,
	      definitionOfDone: store.notebook.definitionOfDone.slice(0, 12),
	      currentFocus: store.notebook.currentFocus,
	      readiness: store.notebook.readiness,
	      tasks: store.notebook.tasks.slice(0, 30).map((task) => ({
	        id: task.id,
	        title: task.title,
	        status: task.status,
	        notes: task.notes,
	        linkedSourceIds: task.linkedSourceIds.slice(0, 12),
	        linkedExtractionIds: task.linkedExtractionIds.slice(0, 12),
	        linkedEvidenceCellIds: task.linkedEvidenceCellIds.slice(0, 12),
	        linkedClaimIds: task.linkedClaimIds.slice(0, 12),
	        linkedSectionIds: task.linkedSectionIds.slice(0, 12),
	        linkedArtifactPaths: task.linkedArtifactPaths.slice(0, 12)
	      })),
	      notes: store.notebook.notes.slice(-8),
	      artifactLinks: store.notebook.artifactLinks.slice(-12).map((artifact) => ({
	        label: artifact.label,
	        path: artifact.path,
	        kind: artifact.kind,
	        createdAt: artifact.createdAt
	      })),
        recentCriticReviews: criticReviewSummariesFromNotebook(store)
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
      sectionId: section.sectionId,
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

function notebookPreviewForAgent(notebook: ResearchNotebook): AgentVisibleEntityPreview {
  const activeTasks = notebook.tasks.filter((task) => task.status === "todo" || task.status === "in_progress" || task.status === "blocked");
  return {
    id: "research-notebook",
    kind: "researchNotebook",
    title: notebook.objective,
    snippet: compactPreviewText(notebook.readiness, 420),
    fields: {
      missionTarget: notebook.missionTarget,
      paperMode: notebook.paperMode,
      definitionOfDoneCount: notebook.definitionOfDone.length,
      taskCount: notebook.tasks.length,
      activeTaskCount: activeTasks.length,
      currentFocus: notebook.currentFocus
    }
  };
}

function safeNotebookTaskStatus(value: unknown): ResearchNotebookTask["status"] {
  return value === "todo"
    || value === "in_progress"
    || value === "done"
    || value === "blocked"
    || value === "abandoned"
    ? value
    : "todo";
}

function generatedNotebookTaskId(run: RunRecord, nowText: string, title: string): string {
  return generatedToolEntityId("task", run, nowText, title);
}

function unsafeArtifactPath(value: string, run: RunRecord): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return "empty artifact path";
  }

  if (path.isAbsolute(trimmed)) {
    const resolved = path.resolve(trimmed);
    const projectRoot = path.resolve(run.projectRoot);
    const runDirectory = path.resolve(run.artifacts.runDirectory);

    return resolved === projectRoot
      || resolved.startsWith(`${projectRoot}${path.sep}`)
      || resolved === runDirectory
      || resolved.startsWith(`${runDirectory}${path.sep}`)
      ? null
      : `artifact path is outside the project: ${trimmed}`;
  }

  const resolvedRelative = path.normalize(trimmed);

  return resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)
    ? `artifact path escapes the project: ${trimmed}`
    : null;
}

function collectUnsafeNotebookArtifactPaths(input: {
  run: RunRecord;
  entity: Record<string, unknown>;
}): string[] {
  const paths = [
    ...stringArrayInput(input.entity.linkedArtifactPaths, 40),
    ...arrayInput(input.entity.tasks).flatMap((entry) => {
      const task = objectInput(entry);
      return task === null ? [] : stringArrayInput(task.linkedArtifactPaths, 40);
    }),
    ...arrayInput(input.entity.artifactLinks).flatMap((entry) => {
      const artifact = objectInput(entry);
      return artifact === null ? [] : [stringInput(artifact.path, "")];
    })
  ];

  return paths
    .map((artifactPath) => unsafeArtifactPath(artifactPath, input.run))
    .filter((message): message is string => message !== null);
}

function taskFromNotebookPatch(input: {
  run: RunRecord;
  nowText: string;
  entry: Record<string, unknown>;
}): ResearchNotebookTask {
  const title = stringInput(input.entry.title ?? input.entry.text, "Untitled research task");

  return {
    id: stringInput(input.entry.id, generatedNotebookTaskId(input.run, input.nowText, title)),
    title,
    status: safeNotebookTaskStatus(input.entry.status),
    notes: nullableStringInput(input.entry.notes ?? input.entry.note),
    linkedSourceIds: stringArrayInput(input.entry.linkedSourceIds ?? input.entry.sourceIds, 40),
    linkedExtractionIds: stringArrayInput(input.entry.linkedExtractionIds ?? input.entry.extractionIds, 40),
    linkedEvidenceCellIds: stringArrayInput(input.entry.linkedEvidenceCellIds ?? input.entry.evidenceCellIds, 40),
    linkedClaimIds: stringArrayInput(input.entry.linkedClaimIds ?? input.entry.claimIds, 40),
    linkedSectionIds: stringArrayInput(input.entry.linkedSectionIds ?? input.entry.sectionIds, 40),
    linkedArtifactPaths: stringArrayInput(input.entry.linkedArtifactPaths ?? input.entry.artifactPaths, 40)
  };
}

function artifactLinkFromNotebookPatch(input: {
  nowText: string;
  entry: Record<string, unknown>;
}): ResearchNotebookArtifactLink {
  const kind = input.entry.kind === "paper"
    || input.entry.kind === "references"
    || input.entry.kind === "checks"
    || input.entry.kind === "source_checkpoint"
    || input.entry.kind === "trace"
    || input.entry.kind === "other"
    ? input.entry.kind
    : "other";

  return {
    label: stringInput(input.entry.label ?? input.entry.title, "Research artifact"),
    path: stringInput(input.entry.path, ""),
    kind,
    createdAt: stringInput(input.entry.createdAt, input.nowText)
  };
}

function patchNotebook(input: {
  run: RunRecord;
  store: ResearchWorkStore;
  nowText: string;
  entity: Record<string, unknown>;
}): ResearchNotebook {
  let tasks = [...input.store.notebook.tasks];
  const upsertTask = (task: ResearchNotebookTask): void => {
    const index = tasks.findIndex((existing) => existing.id === task.id);
    tasks = index === -1
      ? [...tasks, task]
      : tasks.map((existing, existingIndex) => existingIndex === index ? { ...existing, ...task } : existing);
  };

  for (const entry of arrayInput(input.entity.tasks)) {
    const task = objectInput(entry);
    if (task !== null) {
      upsertTask(taskFromNotebookPatch({ run: input.run, nowText: input.nowText, entry: task }));
    }
  }

  const singleTask = objectInput(input.entity.task);
  if (singleTask !== null) {
    upsertTask(taskFromNotebookPatch({ run: input.run, nowText: input.nowText, entry: singleTask }));
  }

  const notes = uniqueStrings([
    ...input.store.notebook.notes,
    ...stringArrayInput(input.entity.notes, 40),
    nullableStringInput(input.entity.note)
  ]).slice(-80);
  const artifactLinks = [...input.store.notebook.artifactLinks];
  const upsertArtifactLink = (artifact: ResearchNotebookArtifactLink): void => {
    const index = artifactLinks.findIndex((existing) => existing.path === artifact.path && existing.label === artifact.label);
    if (index === -1) {
      artifactLinks.push(artifact);
    } else {
      artifactLinks[index] = artifact;
    }
  };

  for (const entry of arrayInput(input.entity.artifactLinks)) {
    const artifact = objectInput(entry);
    if (artifact !== null) {
      upsertArtifactLink(artifactLinkFromNotebookPatch({ nowText: input.nowText, entry: artifact }));
    }
  }

  const singleArtifact = objectInput(input.entity.artifactLink);
  if (singleArtifact !== null) {
    upsertArtifactLink(artifactLinkFromNotebookPatch({ nowText: input.nowText, entry: singleArtifact }));
  }

  return {
    schemaVersion: 1,
    missionTarget: normalizeResearchMissionTarget(input.entity.missionTarget, input.store.notebook.missionTarget),
    paperMode: normalizeResearchPaperMode(input.entity.paperMode, input.store.notebook.paperMode),
    objective: stringInput(input.entity.objective, input.store.notebook.objective),
    definitionOfDone: stringArrayInput(input.entity.definitionOfDone, 40).length > 0
      ? stringArrayInput(input.entity.definitionOfDone, 40)
      : input.store.notebook.definitionOfDone,
    tasks,
    currentFocus: nullableStringInput(input.entity.currentFocus) ?? input.store.notebook.currentFocus,
    readiness: stringInput(input.entity.readiness ?? input.entity.readinessSelfAssessment, input.store.notebook.readiness),
    notes,
    artifactLinks,
    updatedAt: input.nowText
	  };
	}

function notebookPatchFromPlan(plan: ResearchPlan): Record<string, unknown> | null {
  const patch = plan.notebookPatch;
  if (patch === undefined || patch === null) {
    return null;
  }

  return {
    ...(patch.missionTarget === undefined ? {} : { missionTarget: patch.missionTarget }),
    ...(patch.paperMode === undefined ? {} : { paperMode: patch.paperMode }),
    ...(patch.objective === undefined ? {} : { objective: patch.objective }),
    ...(patch.definitionOfDone === undefined ? {} : { definitionOfDone: patch.definitionOfDone }),
    ...(patch.tasks === undefined ? {} : { tasks: patch.tasks }),
    ...(patch.currentFocus === undefined ? {} : { currentFocus: patch.currentFocus }),
    ...(patch.readiness === undefined ? {} : { readiness: patch.readiness }),
    ...(patch.notes === undefined ? {} : { notes: patch.notes })
  };
}

async function persistPlanningNotebookPatch(input: {
  run: RunRecord;
  store: ResearchWorkStore;
  plan: ResearchPlan;
  nowText: string;
}): Promise<ResearchWorkStore> {
  const entity = notebookPatchFromPlan(input.plan);
  if (entity === null || Object.keys(entity).length === 0) {
    return input.store;
  }

  const unsafePaths = collectUnsafeNotebookArtifactPaths({ run: input.run, entity });
  if (unsafePaths.length > 0) {
    return input.store;
  }

  const notebook = patchNotebook({
    run: input.run,
    store: input.store,
    nowText: input.nowText,
    entity
  });
  const nextStore = {
    ...input.store,
    notebook
  };
  await writeResearchWorkStore(nextStore);
  return nextStore;
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

function safeSourceEvidenceSelectionMode(value: unknown): SourceEvidenceSelectionMode | null {
  return value === "append" || value === "replace" || value === "remove" ? value : null;
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
    || action === "extraction.patch"
    || action === "evidence.create_cell"
    || action === "evidence.patch"
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
    || action === "manuscript.finalize";
}

function isReadOnlyWorkspaceAction(action: ResearchActionDecision["action"]): boolean {
  return action === "notebook.read"
    || action === "workspace.search"
    || action === "workspace.read"
    || action === "workspace.list"
    || action === "evidence.matrix_view"
    || action === "section.read"
    || action === "guidance.search"
    || action === "guidance.read"
    || action === "guidance.recommend";
}

function criticReviewAvailable(backend: ResearchBackend): boolean {
  return backend.capabilities?.criticReview === true
    && typeof backend.reviewResearchArtifact === "function";
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

function arrayInput(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nullableStringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

function manuscriptSectionBlocks(markdown: string): string[] {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function manuscriptSectionWordCount(markdown: string): number {
  const words = markdown.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu);
  return words?.length ?? 0;
}

type ManuscriptCompilerDiagnostic = {
  code: string;
  severity: "error" | "warning";
  sectionId: string;
  sectionTitle: string;
  blockIndex: number | null;
  lineNumber: number | null;
  message: string;
  repairHint: string;
  sourceIds: string[];
  claimIds: string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMarkdownHeadingText(value: string): string {
  return value
    .replace(/^#+\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function markdownContainsWorkspaceCitation(markdown: string, sourceIds: string[]): boolean {
  if (sourceIds.length === 0) {
    return true;
  }
  return sourceIds.some((sourceId) => {
    const pattern = new RegExp(`\\[[^\\]]*@?${escapeRegExp(sourceId)}[^\\]]*\\]`);
    return pattern.test(markdown);
  });
}

function markdownWorkspaceCitationMarkers(markdown: string, knownSourceIds: string[]): Array<{
  sourceId: string;
  known: boolean;
  lineNumber: number;
}> {
  const knownSourceIdSet = new Set(knownSourceIds);
  const markers: Array<{ sourceId: string; known: boolean; lineNumber: number }> = [];
  const seen = new Set<string>();
  const bracketPattern = /\[([^\]\n]+)\]/g;
  for (const [lineIndex, line] of markdown.split(/\r?\n/).entries()) {
    bracketPattern.lastIndex = 0;
    for (let match = bracketPattern.exec(line); match !== null; match = bracketPattern.exec(line)) {
      const content = match[1] ?? "";
      const rawTokens = content
        .split(/[\s,;]+/)
        .map((token) => token.trim().replace(/^@/, "").replace(/^[({]+/, "").replace(/[.)}]+$/, ""))
        .filter((token) => token.length > 0);
      for (const token of rawTokens) {
        const sourceId = knownSourceIdSet.has(token)
          ? token
          : /^source[-_:][A-Za-z0-9_.:-]+$/i.test(token)
            ? token
            : null;
        if (sourceId === null) {
          continue;
        }
        const key = `${sourceId}:${lineIndex + 1}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        markers.push({
          sourceId,
          known: knownSourceIdSet.has(sourceId),
          lineNumber: lineIndex + 1
        });
      }
    }
  }
  return markers;
}

function manuscriptCompilerDiagnostics(input: {
  store: ResearchWorkStore;
  references: ReferencesArtifact;
}): ManuscriptCompilerDiagnostic[] {
  const diagnostics: ManuscriptCompilerDiagnostic[] = [];
  const activeCitations = input.store.objects.citations.filter(researchObjectIsActive);
  const referenceSourceIds = new Set(input.references.references.map((reference) => reference.sourceId));
  const knownSourceIds = uniqueStrings(input.store.objects.canonicalSources.map((source) => source.id));

  for (const section of input.store.objects.manuscriptSections) {
    const inlineCitationMarkers = markdownWorkspaceCitationMarkers(section.markdown, knownSourceIds);
    for (const marker of inlineCitationMarkers.filter((candidate) => !candidate.known)) {
      diagnostics.push({
        code: "manuscript.unknown_inline_workspace_citation",
        severity: "error",
        sectionId: section.id,
        sectionTitle: section.title,
        blockIndex: null,
        lineNumber: marker.lineNumber,
        message: `Section ${section.id} contains inline citation marker [${marker.sourceId}], but no canonical workspace source has that id.`,
        repairHint: "Use workspace.list or workspace.search to inspect source ids, then use section.patch to replace the marker with a known source id or remove the unsupported marker.",
        sourceIds: [marker.sourceId],
        claimIds: section.claimIds.slice(0, 12)
      });
    }
    for (const marker of inlineCitationMarkers.filter((candidate) => candidate.known && !section.sourceIds.includes(candidate.sourceId))) {
      diagnostics.push({
        code: "manuscript.section_provenance_mismatch",
        severity: "error",
        sectionId: section.id,
        sectionTitle: section.title,
        blockIndex: null,
        lineNumber: marker.lineNumber,
        message: `Section ${section.id} cites [${marker.sourceId}] inline, but section.sourceIds does not include ${marker.sourceId}.`,
        repairHint: `Use section.patch with sourceIds including ${marker.sourceId}, or link a supported claim/source to this section so provenance can be propagated mechanically.`,
        sourceIds: [marker.sourceId],
        claimIds: section.claimIds.slice(0, 12)
      });
    }
    for (const claimId of section.claimIds) {
      const claimSupportLinks = activeCitations.filter((citation) => citation.claimIds.includes(claimId));
      const missingSectionLinks = claimSupportLinks.filter((citation) => !citation.sectionIds.includes(section.id));
      for (const citation of missingSectionLinks.slice(0, 8)) {
        diagnostics.push({
          code: "manuscript.support_link_section_mismatch",
          severity: "error",
          sectionId: section.id,
          sectionTitle: section.title,
          blockIndex: null,
          lineNumber: null,
          message: `Section ${section.id} links claim ${claimId}, but active support link ${citation.id} for source ${citation.sourceId} is not attached to the section.`,
          repairHint: `Use section.link_claim for section ${section.id} and claim ${claimId}, or claim.link_support with sectionIds including ${section.id}, so the support link and section metadata agree.`,
          sourceIds: [citation.sourceId],
          claimIds: [claimId]
        });
      }
    }
    const blocks = manuscriptSectionBlocks(section.markdown);
    const firstContentLine = section.markdown
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), index }))
      .find((entry) => entry.line.length > 0);
    if (
      firstContentLine !== undefined
      && /^#{2,6}\s+/.test(firstContentLine.line)
      && normalizeMarkdownHeadingText(firstContentLine.line) === normalizeMarkdownHeadingText(section.title)
    ) {
      diagnostics.push({
        code: "manuscript.duplicate_section_heading",
        severity: "error",
        sectionId: section.id,
        sectionTitle: section.title,
        blockIndex: null,
        lineNumber: firstContentLine.index + 1,
        message: `Section ${section.id} starts with a markdown heading that duplicates the stored section title "${section.title}". The exporter already renders "## ${section.title}" for this section.`,
        repairHint: "Use section.patch to remove the duplicated leading heading from section.markdown, or change it to a real lower-level subsection title if it is different from the section title.",
        sourceIds: section.sourceIds.slice(0, 12),
        claimIds: section.claimIds.slice(0, 12)
      });
    }
    for (const [blockIndex, block] of blocks.entries()) {
      const lines = block.split(/\r?\n/);
      for (const [lineIndex, line] of lines.entries()) {
        if (/^#\s+/.test(line.trim())) {
          diagnostics.push({
            code: "manuscript.top_level_heading_inside_section",
            severity: "error",
            sectionId: section.id,
            sectionTitle: section.title,
            blockIndex: blockIndex + 1,
            lineNumber: lineIndex + 1,
            message: `Section ${section.id} contains a top-level "# " heading inside section block ${blockIndex + 1}, line ${lineIndex + 1}. The exporter already renders the paper title and the section title.`,
            repairHint: "Use section.patch to remove the inner top-level heading or convert it to a lower-level subsection heading such as ### if it is genuinely needed.",
            sourceIds: section.sourceIds.slice(0, 12),
            claimIds: section.claimIds.slice(0, 12)
          });
        }
      }
    }

    const supportedSectionSourceIds = uniqueStrings(activeCitations
      .filter((citation) => (
        citation.sectionIds.includes(section.id)
        || citation.claimIds.some((claimId) => section.claimIds.includes(claimId))
      ))
      .map((citation) => citation.sourceId)
      .filter((sourceId) => referenceSourceIds.has(sourceId)));
    if (supportedSectionSourceIds.length > 0 && !markdownContainsWorkspaceCitation(section.markdown, supportedSectionSourceIds)) {
      diagnostics.push({
        code: "manuscript.missing_inline_workspace_citation",
        severity: "error",
        sectionId: section.id,
        sectionTitle: section.title,
        blockIndex: null,
        lineNumber: null,
        message: `Section ${section.id} is linked to renderable workspace references but contains no inline workspace citation marker for those sources.`,
        repairHint: `Use section.patch to add inline citation markers with rendered source ids, for example [${supportedSectionSourceIds[0]}].`,
        sourceIds: supportedSectionSourceIds.slice(0, 12),
        claimIds: section.claimIds.slice(0, 12)
      });
    }
  }

  return diagnostics;
}

function manuscriptCompilerDiagnosticPreviews(diagnostics: ManuscriptCompilerDiagnostic[]): AgentVisibleEntityPreview[] {
  return diagnostics.slice(0, 16).map((diagnostic, index) => ({
    id: `manuscript-compiler-${index + 1}`,
    kind: "manuscriptCompilerDiagnostic",
    title: diagnostic.code,
    status: diagnostic.severity,
    snippet: diagnostic.message,
    sourceIds: diagnostic.sourceIds,
    claimIds: diagnostic.claimIds,
    fields: {
      code: diagnostic.code,
      severity: diagnostic.severity,
      sectionId: diagnostic.sectionId,
      sectionTitle: diagnostic.sectionTitle,
      blockIndex: diagnostic.blockIndex,
      lineNumber: diagnostic.lineNumber,
      repairHint: diagnostic.repairHint,
      suggestedActions: ["section.read", "section.patch", "release.verify"]
    }
  }));
}

function manuscriptSectionHygieneWarnings(section: WorkStoreManuscriptSection, store?: ResearchWorkStore): string[] {
  const warnings: string[] = [];
  const markdown = section.markdown.trim();
  const markdownWithoutCitationMarkers = markdown.replace(/\[[^\]]*(?:source|paper|claim|evidence|extraction|citation)[-_][^\]]+\]/gi, "");
  const contextText = [
    section.sectionId,
    section.role,
    section.title,
    store?.notebook.objective,
    store?.notebook.currentFocus,
    store?.notebook.readiness,
    ...(store?.notebook.definitionOfDone ?? []),
    ...(store?.notebook.tasks.map((task) => `${task.title} ${task.notes ?? ""}`) ?? [])
  ].join(" ");
  const toolingOrRuntimeTopic = /\b(?:clawresearch|tool(?:ing)?|runtime|sdk|workspace|research ide|section repair|critic feedback|critic\.review|release\.verify|section\.read|section\.patch|claim\.link_support|workspace\.read|source\.search)\b/i.test(contextText);

  if (markdown.length === 0) {
    warnings.push("Section markdown is empty.");
  }
  if (/\b(?:TODO|TBD|FIXME|placeholder)\b/i.test(markdown)) {
    warnings.push("Section contains placeholder/TODO-style prose.");
  }
  if (/\b(?:source|paper|claim|evidence|extraction|citation)[-_][A-Za-z0-9][A-Za-z0-9_.:-]*\b/.test(markdownWithoutCitationMarkers)) {
    warnings.push("Section prose appears to contain raw workspace ids instead of rendered source/claim language.");
  }
  const imperativeToolInstruction = /\b(?:call|run|invoke|execute)\s+(?:critic\.review|release\.verify|section\.patch|workspace\.read|claim\.link_support|section\.read)\b/i.test(markdown)
    || /\bnext step(?:s)?\s*:/i.test(markdown)
    || /\b(?:todo|remaining work|action item|follow-up)\s*:/i.test(markdown)
    || /\b(?:create|draft|add|patch|link|inspect)\s+(?:a|the|more|new)\b/i.test(markdown);
  const bareInternalToolMention = /\b(?:critic\.review|release\.verify|section\.patch|workspace\.read|claim\.link_support|section\.read)\b/i.test(markdown);
  if (imperativeToolInstruction) {
    warnings.push("Section prose looks like process instructions rather than manuscript content.");
  } else if (bareInternalToolMention && !toolingOrRuntimeTopic) {
    warnings.push("Section prose mentions internal tool names; verify this is manuscript content rather than a process note.");
  }
  if (section.claimIds.length === 0) {
    warnings.push("Section has no linked claim ids.");
  }

  return uniqueStrings(warnings).slice(0, 12);
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
        status: researchObjectLifecycleStatus(entity),
        confidence: extraction.confidence,
        snippet: compactPreviewText(extraction.problemSetting),
        fields: {
          supersededBy: entity.supersededBy ?? null,
          statusReason: entity.statusReason ?? null,
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
        status: researchObjectLifecycleStatus(entity),
        confidence: entity.confidence,
        snippet: compactPreviewText(entity.value),
        fields: {
          supersededBy: entity.supersededBy ?? null,
          statusReason: entity.statusReason ?? null,
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
        status: researchObjectLifecycleStatus(entity),
        snippet: compactPreviewText(entity.supportSnippet),
        confidence: entity.confidence ?? undefined,
        fields: {
          supersededBy: entity.supersededBy ?? null,
          statusReason: entity.statusReason ?? null,
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
        text: entity.markdown,
        status: entity.status,
        sourceIds: entity.sourceIds.slice(0, 12),
        claimIds: entity.claimIds.slice(0, 12),
        snippet: compactPreviewText(entity.markdown),
        fields: {
          sectionId: entity.sectionId,
          role: entity.role,
          orderIndex: entity.orderIndex ?? null,
          wordCount: manuscriptSectionWordCount(entity.markdown),
          blockCount: manuscriptSectionBlocks(entity.markdown).length,
          hygieneWarnings: manuscriptSectionHygieneWarnings(entity, store).slice(0, 8)
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
  if (/\bblocked\b/i.test(observation.message)) {
    return "blocked";
  }

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
      paperIds: input.decision.inputs.paperIds,
      mode: input.decision.action === "source.select_evidence"
        ? safeSourceEvidenceSelectionMode(input.decision.inputs.workStore?.entity.mode)
        : null
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

function notebookDiagnosticPreviews(diagnostics: ResearchNotebookDiagnostics): AgentVisibleEntityPreview[] {
  return diagnostics.warnings.slice(0, 8).map((warning) => ({
    id: `notebook-diagnostic-${warning.code}`,
    kind: "notebookDiagnostic",
    title: warning.code,
    status: "warning",
    snippet: compactPreviewText(warning.message, 260),
    fields: {
      count: warning.count,
      suggestedActions: warning.suggestedActions
    }
  }));
}

function notebookReadinessRepairPreviews(issue: string | null): AgentVisibleEntityPreview[] {
  if (issue === null) {
    return [];
  }
  return [{
    id: "notebook-readiness-finalization-repair",
    kind: "notebookReadinessRepair",
    title: "Notebook readiness must be explicit before finalization",
    status: "not_ready",
    snippet: compactPreviewText(issue, 320),
    fields: {
      repairClass: "notebook_only",
      patchTarget: "notebook.readiness",
      suggestedActions: ["notebook.read", "notebook.patch", "release.verify"]
    }
  }];
}

function notebookReadinessTextIsExplicitRelease(readiness: string): boolean {
  return /\b(ready|finali[sz]e|release|submit|export)\b/i.test(readiness)
    && /\b(caveat|limitation|bounded|despite|sufficient|complete|meets?|satisfies|acceptable)\b/i.test(readiness);
}

function notebookFinalizationReadinessIssue(notebook: ResearchNotebook): string | null {
  const readiness = notebook.readiness.trim();
  if (readiness.length === 0 || readiness === defaultNotebookReadiness) {
    return "Research readiness has not been recorded in the notebook. Use notebook.patch to write the model-owned readiness assessment before manuscript.finalize.";
  }
  if (/\b(not sufficient|not ready|insufficient|needs more|not enough|unfinished|cannot finali[sz]e|blocked)\b/i.test(readiness)
    && !notebookReadinessTextIsExplicitRelease(readiness)) {
    return "Notebook readiness currently says the project is not sufficient or not ready. Patch notebook.readiness to an intentional release statement with caveats before manuscript.finalize.";
  }
  return null;
}

function notebookAfterManuscriptFinalization(input: {
  notebook: ResearchNotebook;
  completion: NonNullable<ResearchWorkerCompletion>;
  artifactLinks: ResearchNotebookArtifactLink[];
  now: string;
}): ResearchNotebook {
  const previousReadiness = input.notebook.readiness.trim();
  const notes = [...input.notebook.notes];
  if (previousReadiness.length > 0 && previousReadiness !== defaultNotebookReadiness) {
    const note = `Pre-finalization notebook readiness (${input.now}): ${previousReadiness}`;
    if (!notes.includes(note)) {
      notes.push(note);
    }
  }

  const paperPath = input.completion.artifactPaths.find((artifactPath) => artifactPath.endsWith("paper.md"))
    ?? input.completion.artifactPaths[0]
    ?? "paper.md";
  return {
    ...input.notebook,
    readiness: [
      `Runtime finalization record: manuscript_finalized at ${input.completion.finalizedAt}; ${path.basename(paperPath)} was written after explicit model-selected manuscript.finalize and hard mechanical checks passed.`,
      "This records export completion only; it is not a runtime judgment of scientific quality."
    ].join(" "),
    notes: notes.slice(-40),
    artifactLinks: input.artifactLinks,
    updatedAt: input.now
  };
}

type CriticFreshnessStatus =
  | "missing"
  | "fresh"
  | "stale"
  | "incomplete";

type CriticFreshnessObject = {
  kind: string;
  id: string;
  reason: string;
};

type CriticFreshnessEvaluation = {
  status: CriticFreshnessStatus;
  stage: CriticReviewScope;
  message: string;
  reviewArtifactPath: string | null;
  reviewReadiness: string | null;
  reviewedFingerprint: string | null;
  currentFingerprint: string;
  changedObjects: CriticFreshnessObject[];
  missingObjects: CriticFreshnessObject[];
  newObjects: CriticFreshnessObject[];
  suggestedActions: string[];
};

function stableJsonString(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonString(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonString(entry)}`)
    .join(",")}}`;
}

function fingerprintJson(value: unknown): string {
  return createHash("sha256")
    .update(stableJsonString(value))
    .digest("hex")
    .slice(0, 24);
}

function criticSnapshotObject(kind: string, id: string, value: unknown): CriticReviewedWorkspaceSnapshot["objects"][number] {
  return {
    kind,
    id,
    fingerprint: fingerprintJson(value)
  };
}

function criticFreshnessSnapshotForStore(store: ResearchWorkStore): CriticReviewedWorkspaceSnapshot {
  const objects: CriticReviewedWorkspaceSnapshot["objects"] = [
    criticSnapshotObject("notebook", "current", {
      missionTarget: store.notebook.missionTarget,
      paperMode: store.notebook.paperMode,
      objective: store.notebook.objective,
      definitionOfDone: store.notebook.definitionOfDone
    }),
    ...store.objects.extractions
      .filter(researchObjectIsActive)
      .map((extraction) => criticSnapshotObject("extraction", extraction.id, {
        sourceId: extraction.sourceId,
        status: researchObjectLifecycleStatus(extraction),
        supersededBy: extraction.supersededBy ?? null,
        statusReason: extraction.statusReason ?? null,
        extraction: extraction.extraction
      })),
    ...store.objects.evidenceCells
      .filter(researchObjectIsActive)
      .map((cell) => criticSnapshotObject("evidenceCell", cell.id, {
        sourceId: cell.sourceId,
        extractionId: cell.extractionId,
        field: cell.field,
        value: cell.value,
        confidence: cell.confidence,
        status: researchObjectLifecycleStatus(cell),
        supersededBy: cell.supersededBy ?? null,
        statusReason: cell.statusReason ?? null
      })),
    ...store.objects.claims.map((claim) => criticSnapshotObject("claim", claim.id, {
      text: claim.text,
      evidence: claim.evidence,
      sourceIds: claim.sourceIds,
      supportStatus: claim.supportStatus,
      confidence: claim.confidence,
      usedInSections: claim.usedInSections,
      risk: claim.risk
    })),
    ...store.objects.citations
      .filter(researchObjectIsActive)
      .map((citation) => criticSnapshotObject("citation", citation.id, {
        sourceId: citation.sourceId,
        sourceTitle: citation.sourceTitle,
        evidenceCellId: citation.evidenceCellId,
        supportSnippet: citation.supportSnippet,
        confidence: citation.confidence,
        relevance: citation.relevance,
        claimIds: citation.claimIds,
        sectionIds: citation.sectionIds,
        status: researchObjectLifecycleStatus(citation),
        supersededBy: citation.supersededBy ?? null,
        statusReason: citation.statusReason ?? null
      })),
    ...store.objects.manuscriptSections.map((section) => criticSnapshotObject("manuscriptSection", section.id, {
      sectionId: section.sectionId,
      role: section.role,
      orderIndex: section.orderIndex ?? null,
      title: section.title,
      markdown: section.markdown,
      sourceIds: section.sourceIds,
      claimIds: section.claimIds,
      status: section.status
    }))
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));

  const counts = objects.reduce<Record<string, number>>((accumulator, object) => {
    accumulator[object.kind] = (accumulator[object.kind] ?? 0) + 1;
    return accumulator;
  }, {});

  return {
    schemaVersion: 1,
    fingerprint: fingerprintJson(objects),
    objects,
    counts
  };
}

function readCriticReviewArtifact(filePath: string): CriticReviewArtifact | null {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return typeof value === "object" && value !== null && (value as { schemaVersion?: unknown }).schemaVersion === 1
      ? value as CriticReviewArtifact
      : null;
  } catch {
    return null;
  }
}

function criticObjectionStableKey(objection: CriticReviewArtifact["objections"][number]): string {
  const code = objection.code.trim().toLowerCase();
  const target = `${objection.target}:${objection.targetId ?? "global"}`;
  const messageKey = objection.message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join(" ");
  return `${target}|${code || messageKey}`;
}

function criticObjectionDiff(previous: CriticReviewArtifact | null, current: CriticReviewArtifact): {
  newObjections: CriticReviewArtifact["objections"];
  repeatedObjections: CriticReviewArtifact["objections"];
  resolvedObjections: CriticReviewArtifact["objections"];
} {
  if (previous === null) {
    return {
      newObjections: current.objections,
      repeatedObjections: [],
      resolvedObjections: []
    };
  }

  const currentKeys = new Set(current.objections.map(criticObjectionStableKey));
  const previousKeys = new Set(previous.objections.map(criticObjectionStableKey));
  return {
    newObjections: current.objections.filter((objection) => !previousKeys.has(criticObjectionStableKey(objection))),
    repeatedObjections: current.objections.filter((objection) => previousKeys.has(criticObjectionStableKey(objection))),
    resolvedObjections: previous.objections.filter((objection) => !currentKeys.has(criticObjectionStableKey(objection)))
  };
}

function criticObjectionPreview(
  objection: CriticReviewArtifact["objections"][number],
  input: {
    id: string;
    kind?: string;
    titlePrefix?: string;
  }
): AgentVisibleEntityPreview {
  return {
    id: input.id,
    kind: input.kind ?? "criticObjection",
    title: `${input.titlePrefix ?? ""}${objection.severity} objection`.trim(),
    text: objection.message,
    snippet: compactPreviewText(objection.suggestedRevision ?? ""),
    sourceIds: objection.affectedPaperIds.slice(0, 12),
    claimIds: objection.affectedClaimIds.slice(0, 12),
    sectionIds: objection.affectedSectionIds.slice(0, 12),
    fields: {
      code: objection.code,
      target: objection.target,
      targetId: objection.targetId,
      severity: objection.severity,
      suggestedRevision: compactPreviewText(objection.suggestedRevision ?? "")
    }
  };
}

function latestTrustedCriticReviewLink(
  store: ResearchWorkStore,
  stage: CriticReviewScope,
  artifactPath?: string
): ResearchNotebookArtifactLink | null {
  return store.notebook.artifactLinks
    .filter((artifact) => artifact.createdBy === "runtime")
    .filter((artifact) => {
      const summary = criticReviewSummaryFromArtifactLink(artifact);
      return summary !== null && summary.stage === stage;
    })
    .filter((artifact) => artifactPath === undefined || artifact.path === artifactPath)
    .slice(-1)[0] ?? null;
}

function criticFreshnessEvaluationForStore(input: {
  store: ResearchWorkStore;
  stage: CriticReviewScope;
  artifactPath?: string;
}): CriticFreshnessEvaluation {
  const currentSnapshot = criticFreshnessSnapshotForStore(input.store);
  const artifact = latestTrustedCriticReviewLink(input.store, input.stage, input.artifactPath);
  if (artifact === null) {
    return {
      status: "missing",
      stage: input.stage,
      message: `No runtime-owned ${input.stage} critic review is recorded.`,
      reviewArtifactPath: input.artifactPath ?? null,
      reviewReadiness: null,
      reviewedFingerprint: null,
      currentFingerprint: currentSnapshot.fingerprint,
      changedObjects: [],
      missingObjects: [],
      newObjects: [],
      suggestedActions: ["critic.review"]
    };
  }

  const review = readCriticReviewArtifact(artifact.path);
  const reviewedSnapshot = review?.reviewedSnapshot ?? null;
  if (review === null || reviewedSnapshot === null) {
    return {
      status: "incomplete",
      stage: input.stage,
      message: `Latest ${input.stage} critic review has no review snapshot metadata, so it cannot validate the current workspace.`,
      reviewArtifactPath: artifact.path,
      reviewReadiness: review?.readiness ?? null,
      reviewedFingerprint: null,
      currentFingerprint: currentSnapshot.fingerprint,
      changedObjects: [],
      missingObjects: [],
      newObjects: [],
      suggestedActions: ["critic.review"]
    };
  }

  const reviewedByKey = new Map(reviewedSnapshot.objects.map((object) => [`${object.kind}:${object.id}`, object]));
  const currentByKey = new Map(currentSnapshot.objects.map((object) => [`${object.kind}:${object.id}`, object]));
  const changedObjects: CriticFreshnessObject[] = [];
  const missingObjects: CriticFreshnessObject[] = [];
  const newObjects: CriticFreshnessObject[] = [];

  for (const [key, reviewed] of reviewedByKey.entries()) {
    const current = currentByKey.get(key);
    if (current === undefined) {
      missingObjects.push({
        kind: reviewed.kind,
        id: reviewed.id,
        reason: `${reviewed.kind} ${reviewed.id} was reviewed but is no longer active/present in the critic-relevant workspace.`
      });
      continue;
    }
    if (current.fingerprint !== reviewed.fingerprint) {
      changedObjects.push({
        kind: reviewed.kind,
        id: reviewed.id,
        reason: `${reviewed.kind} ${reviewed.id} changed after the critic review.`
      });
    }
  }

  for (const [key, current] of currentByKey.entries()) {
    if (!reviewedByKey.has(key)) {
      newObjects.push({
        kind: current.kind,
        id: current.id,
        reason: `${current.kind} ${current.id} was added after the critic review.`
      });
    }
  }

  const status: CriticFreshnessStatus = changedObjects.length > 0 || missingObjects.length > 0
    ? "stale"
    : newObjects.length > 0
      ? "incomplete"
      : "fresh";
  const message = status === "fresh"
    ? `Latest ${input.stage} critic review is fresh for the current critic-relevant workspace.`
    : status === "stale"
      ? `Latest ${input.stage} critic review is stale because reviewed workspace objects changed or disappeared.`
      : `Latest ${input.stage} critic review is incomplete because new critic-relevant workspace objects were added after review.`;

  return {
    status,
    stage: input.stage,
    message,
    reviewArtifactPath: artifact.path,
    reviewReadiness: review.readiness,
    reviewedFingerprint: reviewedSnapshot.fingerprint,
    currentFingerprint: currentSnapshot.fingerprint,
    changedObjects,
    missingObjects,
    newObjects,
    suggestedActions: status === "fresh" ? [] : ["critic.review"]
  };
}

type ArtifactContractEvaluation = {
  missionTarget: ResearchMissionTarget;
  requestedMissionTarget: ResearchMissionTarget;
  paperMode: ResearchPaperMode;
  canFinalize: boolean;
  supportedCheckpoint: ResearchMissionTarget | null;
  failures: string[];
  warnings: string[];
  nextHints: string[];
  disposition: ResearchWorkspaceDispositionDiagnostics;
  releaseCriticFreshness: CriticFreshnessEvaluation;
};

function requestedMissionTargetFromToolInput(input: {
  entity: Record<string, unknown>;
  notebook: ResearchNotebook;
}): ResearchMissionTarget {
  return normalizeResearchMissionTarget(
    input.entity.missionTarget
      ?? input.entity.exportType
      ?? input.entity.artifactType
      ?? input.entity.targetArtifact,
    input.notebook.missionTarget
  );
}

function uniqueSourceCount(values: string[]): number {
  return new Set(values.filter((value) => value.trim().length > 0)).size;
}

function manuscriptSectionMatches(section: WorkStoreManuscriptSection, pattern: RegExp): boolean {
  return pattern.test(`${section.sectionId} ${section.role} ${section.title} ${section.markdown}`);
}

function notebookReadinessAddressesArtifact(notebook: ResearchNotebook): boolean {
  const readiness = notebook.readiness.toLowerCase();
  const missionWords = notebook.missionTarget.replace(/_/g, " ").split(/\s+/);
  const modeWords = notebook.paperMode.replace(/_/g, " ").split(/\s+/);
  return [...missionWords, ...modeWords, "paper", "review", "manuscript"]
    .some((word) => word.length > 3 && readiness.includes(word));
}

function evaluateArtifactContract(input: {
  run: RunRecord;
  store: ResearchWorkStore;
  references: ReferencesArtifact;
  hardInvariantFailures: ManuscriptCheck[];
  requestedMissionTarget: ResearchMissionTarget;
  criticAvailable: boolean;
  releaseCriticFreshness?: CriticFreshnessEvaluation;
}): ArtifactContractEvaluation {
  const { store, references } = input;
  const failures: string[] = [];
  const warnings: string[] = [];
  const nextHints = new Set<string>();
  const sections = store.objects.manuscriptSections;
  const releaseCriticArtifactPath = criticReviewArtifactPath(input.run, "release");
  const untrustedReleaseCriticReviews = criticReviewSummariesFromNotebook(store, {
    stage: "release",
    artifactPath: releaseCriticArtifactPath
  }).length - criticReviewSummariesFromNotebook(store, {
    trustedOnly: true,
    stage: "release",
    artifactPath: releaseCriticArtifactPath
  }).length;
  const releaseCriticFreshness = input.releaseCriticFreshness ?? criticFreshnessEvaluationForStore({
    store,
    stage: "release",
    artifactPath: releaseCriticArtifactPath
  });
  const disposition = buildWorkspaceDispositionDiagnostics(store, {
    renderedReferenceSourceIds: references.references.map((reference) => reference.sourceId)
  });
  const hasCorpusOrProtocolSection = sections.some((section) => manuscriptSectionMatches(section, /\b(method|protocol|corpus|source selection|search strategy|included sources)\b/i));
  const hasLimitationsSection = sections.some((section) => manuscriptSectionMatches(section, /\b(limitation|limitations|threats? to validity|uncertainty|uncertainties|caveat|future work)\b/i));

  if (input.requestedMissionTarget !== store.notebook.missionTarget) {
    if (store.notebook.missionTarget === "professional_paper") {
      failures.push(`Notebook missionTarget is professional_paper, but manuscript.finalize requested ${input.requestedMissionTarget}. Do not downgrade the mission to a brief/status export just to stop; continue professional-paper work or explicitly revise the notebook mission with a real user/research reason.`);
      nextHints.add("workspace.read");
    } else {
      warnings.push(`Requested artifact target ${input.requestedMissionTarget} differs from notebook missionTarget ${store.notebook.missionTarget}.`);
    }
  }

  if (input.hardInvariantFailures.length > 0) {
    failures.push(`${input.hardInvariantFailures.length} hard mechanical invariant(s) still fail; repair release checks before finalization.`);
    nextHints.add("release.verify");
  }

  if (store.notebook.missionTarget === "research_brief" || store.notebook.missionTarget === "professional_paper") {
    if (releaseCriticFreshness.status === "missing") {
      const fakeLinkNote = untrustedReleaseCriticReviews > 0
        ? " Model-authored notebook artifact links for critic reviews are visible context but do not satisfy this runtime-owned release gate."
        : "";
      failures.push(input.criticAvailable
        ? `No runtime-owned release-scope critic.review pass is recorded. Run critic.review with criticScope release before manuscript.finalize.${fakeLinkNote}`
        : `A runtime-owned release-scope critic.review pass is required before ${store.notebook.missionTarget} finalization, but no critic backend is currently available. Configure a critic backend or revise the mission instead of exporting paper.md.${fakeLinkNote}`);
      if (input.criticAvailable) {
        nextHints.add("critic.review");
      }
    } else if (releaseCriticFreshness.reviewReadiness !== "pass") {
      failures.push(`Latest runtime-owned release critic.review readiness is ${releaseCriticFreshness.reviewReadiness ?? "unknown"}; ${store.notebook.missionTarget} finalization requires addressing that feedback and obtaining a later passing release critic review before paper.md is written.`);
      nextHints.add("workspace.read");
      nextHints.add("section.read");
      nextHints.add("section.patch");
      nextHints.add("claim.patch");
      nextHints.add("notebook.patch");
    } else if (releaseCriticFreshness.status !== "fresh") {
      failures.push(`${releaseCriticFreshness.message} Changed: ${releaseCriticFreshness.changedObjects.length}; missing/retired: ${releaseCriticFreshness.missingObjects.length}; new: ${releaseCriticFreshness.newObjects.length}. Run critic.review with criticScope release again before manuscript.finalize.`);
      if (input.criticAvailable) {
        nextHints.add("critic.review");
      }
      nextHints.add("workspace.read");
    }

    if (disposition.selectedToRenderedCollapse) {
      failures.push(`Selected-to-rendered source disposition collapsed: ${disposition.selectedSourceIds.length} selected source(s), ${disposition.extractedSourceIds.length} extracted source(s), ${disposition.evidenceCellSourceIds.length} evidence-cell source(s), ${disposition.claimSourceIds.length} claim source(s), ${disposition.citationSourceIds.length} citation source(s), and ${disposition.renderedReferenceSourceIds.length} rendered reference source(s). Continue claim/citation/section work before finalization.`);
      nextHints.add("workspace.list");
      nextHints.add("claim.link_support");
      nextHints.add("section.patch");
    }
  }

  if (disposition.missingSelectedExtractionSourceIds.length > 0) {
    warnings.push(`${disposition.missingSelectedExtractionSourceIds.length} selected source(s) are missing structured extraction records.`);
  }
  if (disposition.duplicateExtractionSourceIds.length > 0) {
    warnings.push(`${disposition.duplicateExtractionSourceIds.length} source(s) have duplicate extraction records.`);
  }
  if (disposition.extractedNotEvidenceSourceIds.length > 0) {
    warnings.push(`${disposition.extractedNotEvidenceSourceIds.length} extracted source(s) do not yet have evidence cells.`);
  }
  if (disposition.evidenceNotCitedSourceIds.length > 0) {
    warnings.push(`${disposition.evidenceNotCitedSourceIds.length} evidence-cell source(s) are not cited by support links.`);
  }

  if (store.notebook.missionTarget === "professional_paper") {
    if (sections.length < 2) {
      failures.push(`Only ${sections.length} manuscript section(s) exist. The workspace currently supports a checkpoint brief, not a professional ${store.notebook.paperMode}.`);
      nextHints.add("section.create");
      nextHints.add("section.patch");
    }
    if (!hasCorpusOrProtocolSection) {
      failures.push("No manuscript section records the corpus/protocol/search basis for the paper.");
      nextHints.add("section.create");
    }
    if (!hasLimitationsSection) {
      failures.push("No manuscript section records limitations, caveats, or threats to validity.");
      nextHints.add("section.create");
    }
    if (!notebookReadinessAddressesArtifact(store.notebook)) {
      failures.push(`Notebook readiness does not explicitly state why ${store.notebook.missionTarget}/${store.notebook.paperMode} is ready. Patch the model-owned readiness assessment before finalization.`);
      nextHints.add("notebook.patch");
    }
  }

  if (store.notebook.missionTarget !== "professional_paper" && releaseCriticFreshness.reviewReadiness === "block") {
    warnings.push("Latest runtime-owned release critic.review is blocking. This remains visible feedback for the researcher even when the artifact target is not professional_paper.");
  }

  const supportedCheckpoint = input.hardInvariantFailures.length === 0 && sections.length > 0 && disposition.renderedReferenceSourceIds.length > 0
    ? "research_brief"
    : null;

  return {
    missionTarget: store.notebook.missionTarget,
    requestedMissionTarget: input.requestedMissionTarget,
    paperMode: store.notebook.paperMode,
    canFinalize: failures.length === 0,
    supportedCheckpoint,
    failures,
    warnings,
    nextHints: [...nextHints].filter((hint) => workspaceResearchActions({ criticAvailable: input.criticAvailable }).includes(hint as never)),
    disposition,
    releaseCriticFreshness
  };
}

function artifactContractPreviews(evaluation: ArtifactContractEvaluation): AgentVisibleEntityPreview[] {
  return [
    {
      id: `critic-freshness-${evaluation.releaseCriticFreshness.stage}`,
      kind: "criticFreshnessDiagnostic",
      title: `Release critic freshness: ${evaluation.releaseCriticFreshness.status}`,
      status: evaluation.releaseCriticFreshness.status,
      snippet: compactPreviewText(evaluation.releaseCriticFreshness.message, 360),
      fields: {
        stage: evaluation.releaseCriticFreshness.stage,
        reviewReadiness: evaluation.releaseCriticFreshness.reviewReadiness,
        reviewArtifactPath: evaluation.releaseCriticFreshness.reviewArtifactPath,
        repairClass: evaluation.releaseCriticFreshness.status === "fresh" ? "none" : "critic_review_freshness",
        changedObjects: evaluation.releaseCriticFreshness.changedObjects.slice(0, 8).map((object) => `${object.kind}:${object.id}`),
        changedObjectReasons: evaluation.releaseCriticFreshness.changedObjects.slice(0, 8).map((object) => object.reason),
        missingObjects: evaluation.releaseCriticFreshness.missingObjects.slice(0, 8).map((object) => `${object.kind}:${object.id}`),
        missingObjectReasons: evaluation.releaseCriticFreshness.missingObjects.slice(0, 8).map((object) => object.reason),
        newObjects: evaluation.releaseCriticFreshness.newObjects.slice(0, 8).map((object) => `${object.kind}:${object.id}`),
        newObjectReasons: evaluation.releaseCriticFreshness.newObjects.slice(0, 8).map((object) => object.reason),
        suggestedActions: evaluation.releaseCriticFreshness.suggestedActions
      }
    },
    ...evaluation.failures.map((failure, index): AgentVisibleEntityPreview => ({
      id: `artifact-contract-failure-${index + 1}`,
      kind: "artifactContractDiagnostic",
      title: `${evaluation.missionTarget}/${evaluation.paperMode} contract not ready`,
      status: "not_ready",
      snippet: compactPreviewText(failure, 360),
      fields: {
        missionTarget: evaluation.missionTarget,
        requestedMissionTarget: evaluation.requestedMissionTarget,
        paperMode: evaluation.paperMode,
        supportedCheckpoint: evaluation.supportedCheckpoint,
        suggestedActions: evaluation.nextHints,
        selectedSourceIds: evaluation.disposition.selectedSourceIds.slice(0, 20),
        missingSelectedExtractionSourceIds: evaluation.disposition.missingSelectedExtractionSourceIds.slice(0, 20),
        extractedNotEvidenceSourceIds: evaluation.disposition.extractedNotEvidenceSourceIds.slice(0, 20),
        evidenceNotCitedSourceIds: evaluation.disposition.evidenceNotCitedSourceIds.slice(0, 20),
        selectedToRenderedCollapseSourceIds: evaluation.disposition.selectedToRenderedCollapseSourceIds.slice(0, 20),
        renderedReferenceSourceIds: evaluation.disposition.renderedReferenceSourceIds.slice(0, 20)
      }
    })),
    ...evaluation.warnings.map((warning, index): AgentVisibleEntityPreview => ({
      id: `artifact-contract-warning-${index + 1}`,
      kind: "artifactContractDiagnostic",
      title: `${evaluation.missionTarget}/${evaluation.paperMode} contract warning`,
      status: "warning",
      snippet: compactPreviewText(warning, 360),
      fields: {
        missionTarget: evaluation.missionTarget,
        requestedMissionTarget: evaluation.requestedMissionTarget,
        paperMode: evaluation.paperMode,
        supportedCheckpoint: evaluation.supportedCheckpoint,
        suggestedActions: evaluation.nextHints,
        selectedSourceIds: evaluation.disposition.selectedSourceIds.slice(0, 20),
        missingSelectedExtractionSourceIds: evaluation.disposition.missingSelectedExtractionSourceIds.slice(0, 20),
        extractedNotEvidenceSourceIds: evaluation.disposition.extractedNotEvidenceSourceIds.slice(0, 20),
        evidenceNotCitedSourceIds: evaluation.disposition.evidenceNotCitedSourceIds.slice(0, 20),
        selectedToRenderedCollapseSourceIds: evaluation.disposition.selectedToRenderedCollapseSourceIds.slice(0, 20),
        renderedReferenceSourceIds: evaluation.disposition.renderedReferenceSourceIds.slice(0, 20)
      }
    }))
  ];
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

function stableIdHash(parts: Array<string | null>): string {
  return createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

function generatedSupportLinkId(run: RunRecord, claimId: string, sourceId: string, evidenceCellId: string | null): string {
  const claimPart = numericTextIdPart(claimId).slice(0, 32);
  const sourcePart = numericTextIdPart(sourceId).slice(0, 28);
  const evidencePart = numericTextIdPart(evidenceCellId ?? "source").slice(0, 20);
  const identityHash = stableIdHash([run.id, claimId, sourceId, evidenceCellId]);
  return `citation-${claimPart}-${sourcePart}-${evidencePart}-${identityHash}-${run.id}`;
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
    researchObjectIsActive(cell)
    && equivalentIds.has(cell.sourceId)
    && cell.field !== "confidence"
    && meaningfulSupportSnippet(cell.value) !== null
  )) ?? null;
}

function activeCitationsForClaim(store: ResearchWorkStore, claimId: string): WorkStoreCitation[] {
  return store.objects.citations.filter((citation) => (
    researchObjectIsActive(citation)
    && citation.claimIds.includes(claimId)
  ));
}

function sectionIdsUsingClaim(store: ResearchWorkStore, claimId: string, claim?: WorkStoreClaim | null): string[] {
  const claimEntity = claim ?? readResearchWorkStoreEntity<WorkStoreClaim>(store, "claims", claimId);
  const knownSectionIds = new Set(store.objects.manuscriptSections.map((section) => section.id));
  return uniqueStrings([
    ...(claimEntity?.usedInSections ?? []),
    ...store.objects.manuscriptSections
      .filter((section) => section.claimIds.includes(claimId))
      .map((section) => section.id)
  ]).filter((sectionId) => knownSectionIds.has(sectionId));
}

function activeSupportSourceIdsForClaims(store: ResearchWorkStore, claimIds: string[]): string[] {
  const claimIdSet = new Set(claimIds);
  return uniqueStrings(store.objects.citations
    .filter((citation) => (
      researchObjectIsActive(citation)
      && citation.claimIds.some((claimId) => claimIdSet.has(claimId))
    ))
    .map((citation) => citation.sourceId));
}

function propagateClaimSupportToSections(input: {
  store: ResearchWorkStore;
  claimIds: string[];
  sectionIds: string[];
  now: string;
}): {
  store: ResearchWorkStore;
  sectionIdsUpdated: number;
  sourceIdsAdded: number;
  supportLinksAttachedToSections: number;
} {
  const claimIds = uniqueStrings(input.claimIds);
  const sectionIds = uniqueStrings(input.sectionIds);
  const claimIdSet = new Set(claimIds);
  let nextStore = input.store;
  let sectionIdsUpdated = 0;
  let sourceIdsAdded = 0;
  let supportLinksAttachedToSections = 0;

  for (const sectionId of sectionIds) {
    const section = readResearchWorkStoreEntity<WorkStoreManuscriptSection>(nextStore, "manuscriptSections", sectionId);
    if (section === null) {
      continue;
    }
    const relevantSupportLinks = nextStore.objects.citations.filter((citation) => (
      researchObjectIsActive(citation)
      && citation.claimIds.some((claimId) => claimIdSet.has(claimId))
    ));
    const supportSourceIds = uniqueStrings(relevantSupportLinks.map((citation) => citation.sourceId));
    const missingSourceIds = supportSourceIds.filter((sourceId) => !section.sourceIds.includes(sourceId));
    if (missingSourceIds.length > 0) {
      nextStore = patchResearchWorkStoreEntity(nextStore, {
        collection: "manuscriptSections",
        id: section.id,
        changes: {
          sourceIds: uniqueStrings([...section.sourceIds, ...missingSourceIds])
        }
      }, input.now);
      sectionIdsUpdated += 1;
      sourceIdsAdded += missingSourceIds.length;
    }

    for (const supportLink of relevantSupportLinks) {
      const latestSupportLink = readResearchWorkStoreEntity<WorkStoreCitation>(nextStore, "citations", supportLink.id);
      if (latestSupportLink === null || latestSupportLink.sectionIds.includes(section.id)) {
        continue;
      }
      nextStore = patchResearchWorkStoreEntity(nextStore, {
        collection: "citations",
        id: latestSupportLink.id,
        changes: {
          sectionIds: uniqueStrings([...latestSupportLink.sectionIds, section.id])
        }
      }, input.now);
      supportLinksAttachedToSections += 1;
    }
  }

  return {
    store: nextStore,
    sectionIdsUpdated,
    sourceIdsAdded,
    supportLinksAttachedToSections
  };
}

function uniqueEntitiesById<T extends { id: string }>(entities: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entity of entities) {
    if (seen.has(entity.id)) {
      continue;
    }
    seen.add(entity.id);
    result.push(entity);
  }
  return result;
}

function canonicalSourceByEquivalentId(store: ResearchWorkStore, sourceId: string): WorkStoreCanonicalSource | null {
  const equivalentIds = new Set(sourceEquivalentIds(store, sourceId));
  return store.objects.canonicalSources.find((source) => equivalentIds.has(source.id)) ?? null;
}

function sectionBlockPreviews(section: WorkStoreManuscriptSection): AgentVisibleEntityPreview[] {
  return manuscriptSectionBlocks(section.markdown).map((block, index): AgentVisibleEntityPreview => ({
    id: `${section.id}#block-${index + 1}`,
    kind: "manuscriptSectionBlock",
    title: `Block ${index + 1}`,
    text: block,
    snippet: compactPreviewText(block, 420),
    fields: {
      sectionId: section.id,
      blockIndex: index + 1,
      wordCount: manuscriptSectionWordCount(block)
    }
  }));
}

function sectionCriticObjectionPreviews(store: ResearchWorkStore, section: WorkStoreManuscriptSection): AgentVisibleEntityPreview[] {
  const sectionIds = new Set([section.id, section.sectionId]);
  return store.notebook.artifactLinks
    .filter((artifact) => artifact.createdBy === "runtime")
    .flatMap((artifact) => {
      const review = readCriticReviewArtifact(artifact.path);
      return review === null
        ? []
        : review.objections.flatMap((objection, index): AgentVisibleEntityPreview[] => {
          const targetsSection = objection.target === "section"
            || objection.target === "manuscript"
            || (objection.targetId !== null && sectionIds.has(objection.targetId))
            || objection.affectedSectionIds.some((id) => sectionIds.has(id));
          if (!targetsSection) {
            return [];
          }
          return [{
            id: `${review.stage}-critic-objection-${index + 1}`,
            kind: "criticObjection",
            title: `${objection.severity} ${review.stage} critic objection`,
            text: objection.message,
            snippet: compactPreviewText(objection.suggestedRevision ?? objection.message, 420),
            sourceIds: objection.affectedPaperIds.slice(0, 12),
            claimIds: objection.affectedClaimIds.slice(0, 12),
            sectionIds: objection.affectedSectionIds.slice(0, 12),
            fields: {
              stage: review.stage,
              readiness: review.readiness,
              target: objection.target,
              targetId: objection.targetId,
              severity: objection.severity,
              suggestedRevision: compactPreviewText(objection.suggestedRevision ?? "")
            }
          }];
        });
    })
    .slice(-12);
}

function sectionRepairRelatedPreviews(store: ResearchWorkStore, section: WorkStoreManuscriptSection): AgentVisibleEntityPreview[] {
  const linkedClaims = section.claimIds.flatMap((claimId) => {
    const claim = readResearchWorkStoreEntity<WorkStoreClaim>(store, "claims", claimId);
    return claim === null ? [] : [claim];
  });
  const linkedCitations = uniqueEntitiesById(linkedClaims.flatMap((claim) => activeCitationsForClaim(store, claim.id))
    .filter((citation) => citation.sectionIds.length === 0 || citation.sectionIds.includes(section.id) || citation.claimIds.some((claimId) => section.claimIds.includes(claimId))));
  const linkedEvidenceCells = uniqueEntitiesById(linkedCitations.flatMap((citation) => {
    if (citation.evidenceCellId === null) {
      return [];
    }
    const cell = readResearchWorkStoreEntity<WorkStoreEvidenceCell>(store, "evidenceCells", citation.evidenceCellId);
    return cell === null ? [] : [cell];
  }));
  const linkedSources = uniqueEntitiesById([
    ...section.sourceIds.flatMap((sourceId) => {
      const source = canonicalSourceByEquivalentId(store, sourceId);
      return source === null ? [] : [source];
    }),
    ...linkedCitations.flatMap((citation) => {
      const source = canonicalSourceByEquivalentId(store, citation.sourceId);
      return source === null ? [] : [source];
    })
  ]);
  const workItems = store.objects.workItems
    .filter((item) => item.status === "open")
    .filter((item) => (
      item.targetId === section.id
      || item.targetId === section.sectionId
      || item.affectedClaimIds.some((claimId) => section.claimIds.includes(claimId))
    ));
  const hygieneWarnings = manuscriptSectionHygieneWarnings(section, store).map((warning, index): AgentVisibleEntityPreview => ({
    id: `${section.id}-hygiene-${index + 1}`,
    kind: "manuscriptHygieneWarning",
    title: "Mechanical section hygiene warning",
    status: "warning",
    snippet: warning,
    fields: {
      sectionId: section.id,
      suggestedActions: ["section.read", "section.patch"]
    }
  }));

  return [
    ...hygieneWarnings,
    ...linkedClaims.map((claim) => entityPreviewForAgent(claim, store)),
    ...linkedCitations.map((citation) => entityPreviewForAgent(citation, store)),
    ...linkedEvidenceCells.map((cell) => entityPreviewForAgent(cell, store)),
    ...linkedSources.map((source) => entityPreviewForAgent(source, store)),
    ...workItems.map((item) => entityPreviewForAgent(item, store)),
    ...sectionCriticObjectionPreviews(store, section)
  ].slice(0, 40);
}

function claimSourceIdsAfterSupportRetirement(input: {
  store: ResearchWorkStore;
  claim: WorkStoreClaim;
  retiredSourceIds: string[];
}): string[] {
  const retiredSources = new Set(input.retiredSourceIds);
  const activeSources = new Set(activeCitationsForClaim(input.store, input.claim.id).map((citation) => citation.sourceId));
  return input.claim.sourceIds.filter((sourceId) => !retiredSources.has(sourceId) || activeSources.has(sourceId));
}

function safeSupportLinkMode(value: unknown): "append" | "replace" | "remove" {
  return value === "replace" || value === "remove" ? value : "append";
}

function safeLifecycleStatus(value: unknown): "active" | "superseded" | "retired" | null {
  return value === "active" || value === "superseded" || value === "retired" ? value : null;
}

function lifecyclePatchFromEntity(entity: Record<string, unknown>): Record<string, unknown> {
  const status = safeLifecycleStatus(entity.status ?? entity.lifecycleStatus ?? entity.lifecycle);
  const patch: Record<string, unknown> = {};
  if (status !== null) {
    patch.status = status;
  }
  if (typeof entity.supersededBy === "string" || entity.supersededBy === null) {
    patch.supersededBy = entity.supersededBy;
  }
  const statusReason = stringInput(entity.statusReason ?? entity.reason ?? entity.rationale, "");
  if (statusReason.length > 0) {
    patch.statusReason = statusReason;
  }
  return patch;
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
    status: "active",
    supersededBy: null,
    statusReason: null,
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

function supportLinkCaution(): string {
  return "Only link support when the evidence snippet actually supports the claim; otherwise create better evidence, revise the claim, or search/read more sources.";
}

function recentClaimPreviews(store: ResearchWorkStore): AgentVisibleEntityPreview[] {
  return store.objects.claims
    .slice(-8)
    .map((claim) => entityPreviewForAgent(claim, store));
}

function recentEvidenceCellPreviews(store: ResearchWorkStore, sourceId?: string | null): AgentVisibleEntityPreview[] {
  const equivalentIds = sourceId === undefined || sourceId === null
    ? null
    : new Set(sourceEquivalentIds(store, sourceId));
  return store.objects.evidenceCells
    .filter((cell) => equivalentIds === null || equivalentIds.has(cell.sourceId))
    .slice(-12)
    .map((cell) => entityPreviewForAgent(cell, store));
}

function recentExtractionPreviews(store: ResearchWorkStore, sourceId?: string | null): AgentVisibleEntityPreview[] {
  const equivalentIds = sourceId === undefined || sourceId === null
    ? null
    : new Set(sourceEquivalentIds(store, sourceId));
  return store.objects.extractions
    .filter((extraction) => equivalentIds === null || equivalentIds.has(extraction.sourceId))
    .slice(-8)
    .map((extraction) => entityPreviewForAgent(extraction, store));
}

function recentCitationPreviews(store: ResearchWorkStore, claimId?: string | null): AgentVisibleEntityPreview[] {
  return store.objects.citations
    .filter((citation) => claimId === undefined || claimId === null || citation.claimIds.includes(claimId))
    .slice(-8)
    .map((citation) => entityPreviewForAgent(citation, store));
}

function recentSourcePreviews(store: ResearchWorkStore): AgentVisibleEntityPreview[] {
  return store.objects.canonicalSources
    .slice(-8)
    .map((source) => entityPreviewForAgent(source, store));
}

function claimLinkSupportBlockedResult(input: {
  run: RunRecord;
  timestamp: string;
  message: string;
  store: ResearchWorkStore;
  query?: Record<string, unknown>;
  sourceId?: string | null;
  nextHints?: string[];
}): AgentToolResult {
  return makeAgentToolResult({
    run: input.run,
    action: "claim.link_support",
    timestamp: input.timestamp,
    status: "blocked",
    readOnly: false,
    message: `${input.message} ${supportLinkCaution()}`,
    collection: "citations",
    query: input.query,
    items: recentClaimPreviews(input.store),
    related: [
      ...recentEvidenceCellPreviews(input.store, input.sourceId),
      ...recentExtractionPreviews(input.store, input.sourceId),
      ...recentCitationPreviews(input.store),
      ...(input.sourceId === undefined || input.sourceId === null ? recentSourcePreviews(input.store) : [])
    ].slice(0, 24),
    nextHints: input.nextHints ?? ["workspace.list", "workspace.read", "evidence.create_cell", "claim.link_support", "claim.patch"]
  });
}

function extractionQualityWarnings(extraction: WorkStoreExtraction, existingForSource: WorkStoreExtraction[]): string[] {
  const record = extraction.extraction;
  const populatedStructuredFields = [
    record.architecture,
    record.toolsAndMemory,
    record.planningStyle,
    record.evaluationSetup,
    ...record.successSignals,
    ...record.failureModes,
    ...record.limitations,
    ...record.evidenceNotes
  ].filter((value) => compactPreviewText(value).length > 0);
  const warnings: string[] = [];

  if (populatedStructuredFields.length <= 1) {
    warnings.push("Most structured extraction fields are empty.");
  }

  const instructionLike = [
    record.problemSetting,
    ...record.supportedClaims.map((claim) => claim.claim)
  ].some((text) => /\b(create|add|persist|fill|extract|structured extraction|comparison matrix|future claims|later claims)\b/i.test(text));
  if (instructionLike) {
    warnings.push("Some extraction text looks like an instruction or task description rather than source-derived content.");
  }

  if (existingForSource.length > 0) {
    warnings.push(`${existingForSource.length} extraction record(s) already exist for this source.`);
  }

  return warnings;
}

function evidenceCellQualityWarnings(cell: WorkStoreEvidenceCell): string[] {
  const valueText = compactPreviewText(cell.value, 700);
  const warnings: string[] = [];

  if (/\b(create|add|persist|fill|extract|comparison matrix|future claims|later claims)\b/i.test(valueText)) {
    warnings.push("Evidence-cell value looks like an instruction or task description rather than source-derived evidence.");
  }

  if (valueText.length < 40) {
    warnings.push("Evidence-cell value is very short.");
  }

  return warnings;
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
        researchObjectIsActive(citation) && citation.sourceId === sourceId && citation.claimIds.includes(claim.id)
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
        status: "active",
        supersededBy: null,
        statusReason: null,
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

  if (!researchObjectIsActive(evidenceCell)) {
    issues.push(supportIssue({
      kind: "missing_evidence_cell",
      message: `Support link ${input.citation.id} references evidence cell ${evidenceCell.id}, but that evidence cell is ${researchObjectLifecycleStatus(evidenceCell)}.`,
      sectionId: input.section?.id ?? null,
      claimId: input.claim.id,
      citationId: input.citation.id,
      sourceId: source.id,
      evidenceCellId: evidenceCell.id,
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

    const citations = activeCitationsForClaim(store, claim.id);
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

function supportedClaimsFromToolInput(value: unknown): PaperExtraction["supportedClaims"] {
  if (!Array.isArray(value)) {
    return [];
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
}): { extraction: WorkStoreExtraction; source: WorkStoreCanonicalSource } | null {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const source = knownSourceFromToolInput({
    store: input.store,
    decision: input.decision,
    entity
  });
  if (source === null) {
    return null;
  }

  const problemSetting = stringInput(entity.problemSetting ?? entity.problem, "");
  const successSignals = stringArrayInput(entity.successSignals ?? entity.findings, 40);
  const failureModes = stringArrayInput(entity.failureModes, 40);
  const limitations = stringArrayInput(entity.limitations, 40);
  const supportedClaims = supportedClaimsFromToolInput(entity.supportedClaims ?? entity.claims);
  const evidenceNotes = stringArrayInput(entity.evidenceNotes ?? entity.notes, 40);
  const extractionContentPresent = [
    problemSetting,
    stringInput(entity.systemType, ""),
    stringInput(entity.architecture, ""),
    stringInput(entity.toolsAndMemory, ""),
    stringInput(entity.planningStyle, ""),
    stringInput(entity.evaluationSetup, ""),
    ...successSignals,
    ...failureModes,
    ...limitations,
    ...supportedClaims.map((claim) => claim.claim),
    ...evidenceNotes
  ].some((value) => value.trim().length > 0);
  if (!extractionContentPresent) {
    return null;
  }

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
    successSignals,
    failureModes,
    limitations,
    supportedClaims,
    confidence: safePaperExtractionConfidence(entity.confidence),
    evidenceNotes
  };

  return {
    source,
    extraction: {
      id: paperExtraction.id,
      kind: "extraction",
      runId: input.run.id,
      createdAt: input.now,
      updatedAt: input.now,
      status: "active",
      supersededBy: null,
      statusReason: null,
      sourceId: source.id,
      extraction: paperExtraction
    }
  };
}

function claimFromToolInput(input: {
  run: RunRecord;
  now: string;
  decision: ResearchActionDecision;
}): WorkStoreClaim | null {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const text = stringInput(entity.text ?? entity.claim, "");
  if (text.length === 0) {
    return null;
  }
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
    : stringInput(entity.value ?? entity.evidenceText ?? entity.text, "");
  const hasEvidenceValue = Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
  if (!hasEvidenceValue) {
    return null;
  }

  return {
    id: stringInput(entity.id, generatedToolEntityId("evidence-cell", input.run, input.now, `${source.id}-${field}`)),
    kind: "evidenceCell",
    runId: input.run.id,
    createdAt: input.now,
    updatedAt: input.now,
    status: "active",
    supersededBy: null,
    statusReason: null,
    sourceId: source.id,
    extractionId: extraction.id,
    field,
    value,
    confidence: stringInput(entity.confidence, "medium")
  };
}

function numberInput(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

type SectionPatchOperation =
  | "replace_all"
  | "replace_block"
  | "insert_after_block"
  | "append_paragraph"
  | "remove_block"
  | "update_title"
  | "set_order"
  | "set_claim_links";

function safeSectionPatchOperation(value: unknown, fallback: SectionPatchOperation): SectionPatchOperation {
  return value === "replace_all"
    || value === "replace_block"
    || value === "insert_after_block"
    || value === "append_paragraph"
    || value === "remove_block"
    || value === "update_title"
    || value === "set_order"
    || value === "set_claim_links"
    ? value
    : fallback;
}

const validManuscriptSectionStatuses = ["draft", "needs_revision", "ready_for_review", "checked"] as const;

function safeManuscriptSectionStatus(value: unknown, fallback: WorkStoreManuscriptSection["status"]): WorkStoreManuscriptSection["status"] {
  return typeof value === "string" && (validManuscriptSectionStatuses as readonly string[]).includes(value)
    ? value as WorkStoreManuscriptSection["status"]
    : fallback;
}

function manuscriptSectionStatusValidation(input: {
  entity: Record<string, unknown>;
  changes: Record<string, unknown>;
}): {
  ok: boolean;
  status: WorkStoreManuscriptSection["status"] | null;
  invalidValue: string | null;
} {
  const rawStatus = input.entity.status ?? input.changes.status;
  if (rawStatus === undefined || rawStatus === null || rawStatus === "") {
    return {
      ok: true,
      status: null,
      invalidValue: null
    };
  }
  if (typeof rawStatus === "string" && (validManuscriptSectionStatuses as readonly string[]).includes(rawStatus)) {
    return {
      ok: true,
      status: rawStatus as WorkStoreManuscriptSection["status"],
      invalidValue: null
    };
  }
  const serialized = JSON.stringify(rawStatus);
  return {
    ok: false,
    status: null,
    invalidValue: typeof rawStatus === "string" ? rawStatus : serialized ?? String(rawStatus)
  };
}

function explicitSectionMarkdown(entity: Record<string, unknown>, changes: Record<string, unknown>): string {
  const paragraphs = stringArrayInput(entity.paragraphs ?? changes.paragraphs, 80);
  return stringInput(
    entity.markdown
      ?? entity.content
      ?? entity.paragraph
      ?? entity.text
      ?? changes.markdown
      ?? changes.content
      ?? changes.paragraph
      ?? changes.text,
    paragraphs.join("\n\n")
  );
}

function patchedSectionMarkdown(input: {
  existing: WorkStoreManuscriptSection | null | undefined;
  operation: SectionPatchOperation;
  blockIndex: number | null;
  markdown: string;
}): string | null {
  if (input.existing === null || input.existing === undefined) {
    return input.markdown.length > 0 ? input.markdown : null;
  }

  const blocks = manuscriptSectionBlocks(input.existing.markdown);
  switch (input.operation) {
    case "replace_all":
      return input.markdown.length > 0 ? input.markdown : input.existing.markdown;
    case "replace_block": {
      if (input.markdown.length === 0 || input.blockIndex === null || input.blockIndex < 1 || input.blockIndex > blocks.length) {
        return null;
      }
      blocks[input.blockIndex - 1] = input.markdown;
      return blocks.join("\n\n");
    }
    case "insert_after_block": {
      if (input.markdown.length === 0 || input.blockIndex === null || input.blockIndex < 0 || input.blockIndex > blocks.length) {
        return null;
      }
      blocks.splice(input.blockIndex, 0, input.markdown);
      return blocks.join("\n\n");
    }
    case "append_paragraph":
      return input.markdown.length === 0
        ? null
        : [...blocks, input.markdown].join("\n\n");
    case "remove_block": {
      if (input.blockIndex === null || input.blockIndex < 1 || input.blockIndex > blocks.length) {
        return null;
      }
      blocks.splice(input.blockIndex - 1, 1);
      return blocks.join("\n\n");
    }
    case "update_title":
    case "set_order":
    case "set_claim_links":
      return input.existing.markdown;
  }
}

function sectionOrderIndexFromToolInput(
  entity: Record<string, unknown>,
  changes: Record<string, unknown>,
  existing: WorkStoreManuscriptSection | null | undefined
): number | null {
  const parsed = numberInput(entity.orderIndex ?? entity.sectionOrder ?? entity.order ?? changes.orderIndex ?? changes.sectionOrder ?? changes.order);
  return parsed ?? existing?.orderIndex ?? null;
}

function manuscriptSectionFromToolInput(input: {
  run: RunRecord;
  now: string;
  decision: ResearchActionDecision;
  existing?: WorkStoreManuscriptSection | null;
}): WorkStoreManuscriptSection | null {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const changes = input.decision.inputs.workStore?.changes ?? {};
  const operation = safeSectionPatchOperation(
    entity.operation ?? entity.patchOperation ?? changes.operation ?? changes.patchOperation,
    "replace_all"
  );
  const sectionId = stringInput(
    entity.sectionId ?? changes.sectionId,
    input.existing?.sectionId ?? stringInput(input.decision.inputs.workStore?.entityId, "discussion")
  );
  const markdown = patchedSectionMarkdown({
    existing: input.existing,
    operation,
    blockIndex: numberInput(entity.blockIndex ?? entity.block ?? changes.blockIndex ?? changes.block),
    markdown: explicitSectionMarkdown(entity, changes)
  });
  if (markdown === null || markdown.length === 0) {
    return null;
  }
  const exactClaimIds = operation === "set_claim_links"
    ? stringArrayInput(entity.claimIds ?? changes.claimIds, 40)
    : null;

  return {
    id: input.existing?.id ?? stringInput(entity.id, generatedToolEntityId("section", input.run, input.now, sectionId)),
    kind: "manuscriptSection",
    runId: input.run.id,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
    sectionId,
    role: stringInput(entity.role ?? changes.role, input.existing?.role ?? "synthesis"),
    orderIndex: sectionOrderIndexFromToolInput(entity, changes, input.existing),
    title: stringInput(entity.title ?? changes.title, input.existing?.title ?? sectionId.replace(/[-_]+/g, " ")),
    markdown,
    sourceIds: uniqueStrings([
      ...(input.existing?.sourceIds ?? []),
      ...input.decision.inputs.paperIds,
      ...stringArrayInput(entity.sourceIds ?? changes.sourceIds, 40)
    ]),
    claimIds: exactClaimIds ?? uniqueStrings([
      ...(input.existing?.claimIds ?? []),
      ...stringArrayInput(entity.claimIds ?? changes.claimIds, 40)
    ]),
    status: safeManuscriptSectionStatus(entity.status ?? changes.status, input.existing?.status ?? "needs_revision")
  };
}

function stringCandidates(...values: unknown[]): string[] {
  const candidates: string[] = [];

  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      candidates.push(value.trim());
      continue;
    }

    candidates.push(...stringArrayInput(value, 20));
  }

  return uniqueStrings(candidates);
}

function resolveSectionReference(store: ResearchWorkStore, candidates: string[]): WorkStoreManuscriptSection | null {
  for (const candidate of candidates) {
    const byId = readResearchWorkStoreEntity<WorkStoreManuscriptSection>(store, "manuscriptSections", candidate);
    if (byId !== null) {
      return byId;
    }
  }

  for (const candidate of candidates) {
    const bySectionId = store.objects.manuscriptSections.find((section) => section.sectionId === candidate);
    if (bySectionId !== undefined) {
      return bySectionId;
    }
  }

  return candidates.length === 0 && store.objects.manuscriptSections.length === 1
    ? store.objects.manuscriptSections[0] ?? null
    : null;
}

function resolveClaimReference(store: ResearchWorkStore, candidates: string[]): WorkStoreClaim | null {
  for (const candidate of candidates) {
    const byId = readResearchWorkStoreEntity<WorkStoreClaim>(store, "claims", candidate);
    if (byId !== null) {
      return byId;
    }
  }

  return candidates.length === 0 && store.objects.claims.length === 1
    ? store.objects.claims[0] ?? null
    : null;
}

function sectionClaimLinkTargets(input: {
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
}): {
  section: WorkStoreManuscriptSection | null;
  claim: WorkStoreClaim | null;
  sectionCandidates: string[];
  claimCandidates: string[];
} {
  const args = input.decision.inputs.workStore;
  if (args === undefined) {
    const sectionCandidates: string[] = [];
    const claimCandidates: string[] = [];
    return {
      section: resolveSectionReference(input.store, sectionCandidates),
      claim: resolveClaimReference(input.store, claimCandidates),
      sectionCandidates,
      claimCandidates
    };
  }
  const entity = args.entity;
  const changes = args.changes;
  const link = args.link ?? {
    fromId: null,
    toId: null
  };
  const sectionCandidates = stringCandidates(
    args.entityId,
    link.fromId,
    entity.sectionId,
    entity.manuscriptSectionId,
    entity.section_id,
    entity.id,
    entity.fromId,
    entity.from,
    changes.sectionId,
    changes.manuscriptSectionId
  );
  const claimCandidates = stringCandidates(
    link.toId,
    entity.claimId,
    entity.claim_id,
    entity.claimIds,
    entity.toId,
    entity.to,
    changes.claimId,
    changes.claimIds,
    input.decision.inputs.paperIds
  );
  const directSection = resolveSectionReference(input.store, sectionCandidates);
  const directClaim = resolveClaimReference(input.store, claimCandidates);

  if (directSection !== null && directClaim !== null) {
    return {
      section: directSection,
      claim: directClaim,
      sectionCandidates,
      claimCandidates
    };
  }

  const swappedSection = resolveSectionReference(input.store, claimCandidates);
  const swappedClaim = resolveClaimReference(input.store, sectionCandidates);
  return {
    section: directSection ?? swappedSection,
    claim: directClaim ?? swappedClaim,
    sectionCandidates,
    claimCandidates
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

function criticReviewArtifactLink(input: {
  run: RunRecord;
  stage: CriticReviewScope;
  review: CriticReviewArtifact;
  nowText: string;
}): ResearchNotebookArtifactLink {
  return {
    label: `Critic review: ${input.stage} (${input.review.readiness})`,
    path: criticReviewArtifactPath(input.run, input.stage),
    kind: "other",
    createdAt: input.nowText,
    createdBy: "runtime"
  };
}

function upsertNotebookArtifactLink(
  store: ResearchWorkStore,
  artifact: ResearchNotebookArtifactLink,
  nowText: string
): ResearchWorkStore {
  const artifactLinks = store.notebook.artifactLinks
    .filter((existing) => existing.path !== artifact.path);
  artifactLinks.push(artifact);

  return {
    ...store,
    updatedAt: nowText,
    notebook: {
      ...store.notebook,
      artifactLinks,
      updatedAt: nowText
    }
  };
}

function criticReviewSummaryFromArtifactLink(artifact: ResearchNotebookArtifactLink): Record<string, string | number | null> | null {
  const match = /^Critic review: ([a-z_]+) \((pass|revise|block)\)$/i.exec(artifact.label);
  if (match === null) {
    return null;
  }

  return {
    stage: match[1]?.toLowerCase() ?? "release",
    readiness: match[2]?.toLowerCase() ?? "revise",
    artifactPath: artifact.path,
    createdAt: artifact.createdAt
  };
}

function criticReviewSummariesFromNotebook(
  store: ResearchWorkStore,
  options: {
    trustedOnly?: boolean;
    stage?: CriticReviewScope;
    artifactPath?: string;
  } = {}
): Array<Record<string, string | number | null>> {
  return store.notebook.artifactLinks
    .filter((artifact) => options.trustedOnly !== true || artifact.createdBy === "runtime")
    .flatMap((artifact) => {
      const summary = criticReviewSummaryFromArtifactLink(artifact);
      return summary === null ? [] : [summary];
    })
    .filter((summary) => options.stage === undefined || summary.stage === options.stage)
    .filter((summary) => options.artifactPath === undefined || summary.artifactPath === options.artifactPath)
    .slice(-8);
}

function criticSourcePacket(source: WorkStoreCanonicalSource): Record<string, unknown> {
  return {
    id: source.id,
    title: source.title,
    year: source.year,
    venue: source.venue,
    citation: source.citation,
    abstract: compactPreviewText(source.abstract ?? "", 700),
    screeningDecision: source.screeningDecision,
    screeningRationale: compactPreviewText(source.screeningRationale ?? "", 300),
    accessMode: source.accessMode,
    providerIds: source.providerIds
  };
}

function buildCriticReviewRequest(input: {
  run: RunRecord;
  store: ResearchWorkStore;
  stage: CriticReviewScope;
}): CriticReviewRequest {
  const references = referencesFromWorkStore(input.run, input.store);
  const checks = workspaceManuscriptChecks({
    run: input.run,
    store: input.store,
    references
  });
  const paper = workspacePaperArtifact({
    run: input.run,
    store: input.store,
    references,
    readinessStatus: checks.readinessStatus
  });
  const citedSourceIds = new Set([
    ...input.store.objects.citations.map((citation) => citation.sourceId),
    ...paper.referencedPaperIds
  ]);
  const disposition = buildWorkspaceDispositionDiagnostics(input.store, {
    renderedReferenceSourceIds: paper.referencedPaperIds
  });
  const selectedSourceIdSet = new Set(disposition.selectedSourceIds);
  const selectedSources = input.store.objects.canonicalSources
    .filter((source) => selectedSourceIdSet.has(source.id) || citedSourceIds.has(source.id))
    .slice(0, 40)
    .map(criticSourcePacket);
  const citedSources = input.store.objects.canonicalSources
    .filter((source) => citedSourceIds.has(source.id))
    .slice(0, 40)
    .map(criticSourcePacket);

  return {
    projectRoot: input.run.projectRoot,
    runId: input.run.id,
    stage: input.stage,
    brief: input.run.brief,
    paper: null,
    draftManuscriptPreview: paper,
    paperExportExists: input.store.worker.completion?.kind === "manuscript_finalized"
      && input.store.worker.completion.artifactPaths.includes(input.run.artifacts.paperPath),
    finalizedArtifactPaths: input.store.worker.completion?.kind === "manuscript_finalized"
      ? input.store.worker.completion.artifactPaths
      : [],
    releaseChecksExist: input.store.objects.releaseChecks.length > 0,
    manuscriptFinalized: input.store.worker.completion?.kind === "manuscript_finalized",
    references,
    manuscriptChecks: checks,
    workspace: {
      notebook: input.store.notebook,
      workspaceSummary: summarizeResearchWorkStore(input.store),
      corpus_view: buildResearchCorpusDiagnosticView(input.store, {
        renderedReferenceSourceIds: paper.referencedPaperIds
      }),
      synthesis_view: buildResearchSynthesisDiagnosticView(input.store, {
        renderedReferenceSourceIds: paper.referencedPaperIds
      }),
      selectedSources,
      citedSources,
      protocols: input.store.objects.protocols.slice(-6).map((protocol) => ({
        id: protocol.id,
        title: protocol.title,
        objective: protocol.objective,
        researchQuestion: protocol.researchQuestion,
        evidenceTargets: protocol.evidenceTargets,
        manuscriptConstraints: protocol.manuscriptConstraints,
        notes: protocol.notes,
        author: protocol.author
      })),
      extractions: input.store.objects.extractions.slice(-30).map((extraction) => ({
        id: extraction.id,
        sourceId: extraction.sourceId,
        extraction: extraction.extraction
      })),
      evidenceCells: input.store.objects.evidenceCells.slice(-60).map((cell) => ({
        id: cell.id,
        sourceId: cell.sourceId,
        extractionId: cell.extractionId,
        field: cell.field,
        value: cell.value,
        confidence: cell.confidence
      })),
      claims: input.store.objects.claims.slice(-50).map((claim) => ({
        id: claim.id,
        text: claim.text,
        evidence: claim.evidence,
        sourceIds: claim.sourceIds,
        supportStatus: claim.supportStatus,
        confidence: claim.confidence,
        usedInSections: claim.usedInSections,
        risk: claim.risk
      })),
      citations: input.store.objects.citations.slice(-80).map((citation) => ({
        id: citation.id,
        sourceId: citation.sourceId,
        sourceTitle: citation.sourceTitle,
        evidenceCellId: citation.evidenceCellId,
        supportSnippet: citation.supportSnippet,
        confidence: citation.confidence,
        relevance: citation.relevance,
        claimIds: citation.claimIds,
        sectionIds: citation.sectionIds
      })),
      manuscriptSections: input.store.objects.manuscriptSections.map((section) => ({
        id: section.id,
        sectionId: section.sectionId,
        role: section.role,
        title: section.title,
        markdown: section.markdown,
        sourceIds: section.sourceIds,
        claimIds: section.claimIds,
        status: section.status
      })),
      releaseChecks: input.store.objects.releaseChecks.slice(-40).map((check) => ({
        id: check.id,
        checkId: check.checkId,
        title: check.title,
        status: check.status,
        severity: check.severity,
        message: check.message
      }))
    }
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

async function executeNotebookToolAction(input: {
  run: RunRecord;
  now: () => string;
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
}): Promise<WorkspaceToolExecutionResult> {
  if (input.decision.action !== "notebook.read" && input.decision.action !== "notebook.patch") {
    return {
      handled: false,
      store: input.store,
      message: null
    };
  }

  const timestamp = input.now();
  const args = input.decision.inputs.workStore ?? defaultWorkStoreArgs();

  if (input.decision.action === "notebook.read") {
    const message = `Notebook read: mission ${input.store.notebook.missionTarget}/${input.store.notebook.paperMode}, ${input.store.notebook.tasks.length} task(s), ${input.store.notebook.definitionOfDone.length} definition-of-done item(s).`;
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
        collection: "notebook",
        count: 1,
        totalCount: 1,
        entity: notebookPreviewForAgent(input.store.notebook),
        items: input.store.notebook.tasks.slice(0, 30).map((task): AgentVisibleEntityPreview => ({
          id: task.id,
          kind: "notebookTask",
          title: task.title,
          status: task.status,
          snippet: compactPreviewText(task.notes ?? "", 260),
          sourceIds: task.linkedSourceIds.slice(0, 12),
          claimIds: task.linkedClaimIds.slice(0, 12),
          sectionIds: task.linkedSectionIds.slice(0, 12),
          fields: {
            linkedExtractionIds: task.linkedExtractionIds.slice(0, 12),
            linkedEvidenceCellIds: task.linkedEvidenceCellIds.slice(0, 12),
            linkedArtifactPaths: task.linkedArtifactPaths.slice(0, 12)
          }
        })),
        nextHints: ["notebook.patch", "workspace.list", "workspace.read"]
      })
    };
  }

  const entity = {
    ...args.changes,
    ...args.entity
  };
  const unsafePaths = collectUnsafeNotebookArtifactPaths({ run: input.run, entity });
  if (unsafePaths.length > 0) {
    const message = `Notebook patch blocked because artifact link path validation failed: ${unsafePaths.slice(0, 3).join(" | ")}`;
    return {
      handled: true,
      store: input.store,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp,
        status: "blocked",
        readOnly: false,
        message,
        collection: "notebook",
        entity: notebookPreviewForAgent(input.store.notebook),
        nextHints: ["notebook.read", "notebook.patch"]
      })
    };
  }

  const notebook = patchNotebook({
    run: input.run,
    store: input.store,
    nowText: timestamp,
    entity
  });
  const nextStore = {
    ...input.store,
    notebook
  };
  await writeResearchWorkStore(nextStore);
  const message = `Notebook patched: mission ${notebook.missionTarget}/${notebook.paperMode}, ${notebook.tasks.length} task(s), current focus ${notebook.currentFocus ?? "unset"}.`;
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
      collection: "notebook",
      count: 1,
      totalCount: 1,
      entity: notebookPreviewForAgent(notebook),
      stateDelta: {
        notebooksPatched: 1,
        notebookTasks: notebook.tasks.length
      },
      nextHints: ["notebook.read", "workspace.list", "source.search"]
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
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
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
    if (!criticReviewAvailable(input.researchBackend)) {
      const message = "Critic review is not available in this project because no critic backend transport is configured.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "failed",
          readOnly: false,
          message,
          collection: "criticReviews",
          count: 0,
          totalCount: 0,
          error: message,
          nextHints: ["workspace.read", "work_item.create", "check.run", "release.verify"]
        })
      };
    }

    const reviewPath = criticReviewArtifactPath(input.run, stage);
    const previousReview = readCriticReviewArtifact(reviewPath);
    const request = buildCriticReviewRequest({
      run: input.run,
      store: input.store,
      stage
    });
    let review: CriticReviewArtifact | undefined;
    try {
      review = await callBackendProviderWithRetries({
        run: input.run,
        now: input.now,
        operation: "critic",
        label: "Critic review",
        call: () => input.researchBackend.reviewResearchArtifact!(request, {
          operation: "critic",
          timeoutMs: input.runtimeConfig.criticTimeoutMs
        })
      });
    } catch (error) {
      const message = `Critic review failed: ${errorMessage(error)}`;
      const unavailableReview = criticUnavailableReview(request, errorMessage(error));
      await writeJsonArtifact(criticReviewArtifactPath(input.run, stage), unavailableReview);
      const nextStore = upsertNotebookArtifactLink(input.store, criticReviewArtifactLink({
        run: input.run,
        stage,
        review: unavailableReview,
        nowText
      }), nowText);
      await writeResearchWorkStore(nextStore);
      return {
        handled: true,
        store: nextStore,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "failed",
          readOnly: false,
          message,
          collection: "criticReviews",
          count: 1,
          totalCount: 1,
          entity: {
            id: `${unavailableReview.stage}-critic-review`,
            kind: "criticReview",
            title: `Critic review: ${stage}`,
            status: unavailableReview.readiness,
            snippet: compactPreviewText(unavailableReview.summary, 320),
            fields: {
              stage: unavailableReview.stage,
              readiness: unavailableReview.readiness,
              confidence: unavailableReview.confidence,
              artifactPath: reviewPath,
              objections: unavailableReview.objections.length,
              positiveFindings: unavailableReview.positiveFindings.length,
              recommendedNextActions: unavailableReview.recommendedNextActions.slice(0, 6)
            }
          },
          items: unavailableReview.objections.map((objection, index) => criticObjectionPreview(objection, {
            id: `${unavailableReview.stage}-critic-objection-${index + 1}`
          })),
          error: message,
          stateDelta: {
            criticReviewsCreated: 1,
            criticBlockingObjections: unavailableReview.objections.filter((objection) => objection.severity === "blocking").length,
            notebookArtifactLinksCreated: 1
          },
          nextHints: ["workspace.read", "work_item.create", "check.run", "release.verify"]
        })
      };
    }

    if (review === undefined) {
      const message = "Critic review failed: backend did not return a critic report.";
      return {
        handled: true,
        store: input.store,
        message,
        result: makeAgentToolResult({
          run: input.run,
          action: input.decision.action,
          timestamp: nowText,
          status: "failed",
          readOnly: false,
          message,
          collection: "criticReviews",
          count: 0,
          totalCount: 0,
          error: message,
          nextHints: ["workspace.read", "work_item.create", "check.run", "release.verify"]
        })
      };
    }
    review = {
      ...normalizeCriticReview(review, request),
      reviewedSnapshot: criticFreshnessSnapshotForStore(input.store)
    };
    const diff = criticObjectionDiff(previousReview, review);

    await writeJsonArtifact(reviewPath, review);
    const nextStore = upsertNotebookArtifactLink(input.store, criticReviewArtifactLink({
      run: input.run,
      stage,
      review,
      nowText
    }), nowText);
    await writeResearchWorkStore(nextStore);
    const blockingObjections = review.objections.filter((objection) => objection.severity === "blocking").length;
    const message = [
      `Fresh critic review ${stage} persisted as feedback only; readiness ${review.readiness}, ${blockingObjections} blocking objection(s).`,
      `Objection diff: ${diff.newObjections.length} new, ${diff.repeatedObjections.length} repeated, ${diff.resolvedObjections.length} resolved.`
    ].join(" ");
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
        collection: "criticReviews",
        count: 1,
        totalCount: 1,
        entity: {
          id: `${review.stage}-critic-review`,
          kind: "criticReview",
          title: `Critic review: ${stage}`,
          status: review.readiness,
          snippet: compactPreviewText(review.summary, 320),
          fields: {
            stage: review.stage,
            readiness: review.readiness,
            confidence: review.confidence,
              artifactPath: reviewPath,
              objections: review.objections.length,
              positiveFindings: review.positiveFindings.length,
              newObjections: diff.newObjections.length,
              repeatedObjections: diff.repeatedObjections.length,
              resolvedObjections: diff.resolvedObjections.length,
              reviewedFingerprint: review.reviewedSnapshot?.fingerprint ?? null,
              reviewedObjects: review.reviewedSnapshot?.objects.length ?? 0,
              recommendedNextActions: review.recommendedNextActions.slice(0, 6)
            }
        },
        items: review.objections.slice(0, 12).map((objection, index) => criticObjectionPreview(objection, {
          id: `${review.stage}-critic-objection-${index + 1}`
        })),
        related: [
          ...diff.resolvedObjections.slice(0, 6).map((objection, index) => criticObjectionPreview(objection, {
            id: `${review.stage}-critic-resolved-objection-${index + 1}`,
            kind: "criticResolvedObjection",
            titlePrefix: "resolved "
          })),
          ...diff.repeatedObjections.slice(0, 6).map((objection, index) => criticObjectionPreview(objection, {
            id: `${review.stage}-critic-repeated-objection-${index + 1}`,
            kind: "criticRepeatedObjection",
            titlePrefix: "repeated "
          }))
        ],
        stateDelta: {
          criticReviewsCreated: 1,
          criticBlockingObjections: blockingObjections,
          criticNewObjections: diff.newObjections.length,
          criticRepeatedObjections: diff.repeatedObjections.length,
          criticResolvedObjections: diff.resolvedObjections.length,
          notebookArtifactLinksCreated: 1
        },
        nextHints: review.readiness === "pass"
          ? ["release.verify", "workspace.status"]
          : blockingObjections === 0
            ? ["workspace.read", "section.read", "section.patch", "claim.patch", "notebook.patch"]
            : ["workspace.read", "work_item.create", "claim.patch", "section.patch", "source.search"]
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
    if (claim === null) {
      const message = "Claim create blocked because explicit claim text is required in workStore.entity.text or workStore.entity.claim; process rationale/expectedOutcome is never persisted as claim content.";
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
          collection: "claims",
          count: 0,
          totalCount: input.store.objects.claims.length,
          nextHints: ["workspace.read", "claim.create", "notebook.patch"]
        })
      };
    }
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
    const link = args.link ?? defaultWorkStoreArgs().link;
    const mode = safeSupportLinkMode(args.entity.mode ?? args.entity.supportMode ?? args.entity.operation ?? args.changes.mode);
    const claimCandidates = stringCandidates(
      args.entityId,
      args.entity.claimId,
      args.entity.claim_id,
      args.entity.claimIds,
      link?.fromCollection === "claims" ? link.fromId : null,
      link?.toCollection === "claims" ? link.toId : null
    );
    const supportLinkIdCandidates = stringCandidates(
      args.entity.citationId,
      args.entity.supportLinkId,
      args.entity.linkId,
      args.entity.oldCitationId,
      args.entity.replaceCitationId,
      args.entity.previousCitationId,
      link?.fromCollection === "citations" ? link.fromId : null,
      link?.toCollection === "citations" ? link.toId : null
    );
    const supportLinkCandidate = supportLinkIdCandidates
      .map((candidate) => readResearchWorkStoreEntity<WorkStoreCitation>(input.store, "citations", candidate))
      .find((candidate): candidate is WorkStoreCitation => candidate !== null) ?? null;
    const resolvedClaim = resolveClaimReference(input.store, claimCandidates);
    const claimFromSupportLink = supportLinkCandidate?.claimIds[0] === undefined
      ? null
      : readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", supportLinkCandidate.claimIds[0]);
    const claimId = resolvedClaim?.id ?? claimFromSupportLink?.id ?? null;
    const evidenceCellId = stringInput(
      args.entity.evidenceCellId
        ?? stringArrayInput(args.entity.evidenceCellIds, 1)[0]
        ?? (link?.toCollection === "evidenceCells" ? link.toId : null)
        ?? (link?.fromCollection === "evidenceCells" ? link.fromId : null),
      ""
    );
    const evidenceCell = evidenceCellId.length === 0
      ? null
      : readResearchWorkStoreEntity<WorkStoreEvidenceCell>(input.store, "evidenceCells", evidenceCellId);
    const sourceIds = uniqueStrings([
      ...input.decision.inputs.paperIds,
      stringInput(args.entity.paperId, ""),
      ...stringArrayInput(args.entity.sourceIds, 20),
      stringInput(args.entity.oldSourceId, ""),
      stringInput(args.entity.replaceSourceId, ""),
      link?.toCollection === "canonicalSources" || link?.toCollection === "sources" ? link.toId : null,
      link?.fromCollection === "canonicalSources" || link?.fromCollection === "sources" ? link.fromId : null,
      evidenceCell?.sourceId ?? null
    ]);
    const sourceId = stringInput(args.entity.sourceId, sourceIds[0] ?? "");
    const resolvedSourceId = sourceId.length > 0
      ? sourceId
      : evidenceCell?.sourceId ?? "";
    if (claimId === null || (mode !== "remove" && resolvedSourceId.length === 0)) {
      const missing = [
        claimId === null ? "claimId" : null,
        mode !== "remove" && resolvedSourceId.length === 0 ? "sourceId or evidenceCellId" : null
      ].filter((item): item is string => item !== null);
      const message = `claim.link_support ${mode} blocked because ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing or could not be resolved.`;
      return {
        handled: true,
        store: input.store,
        message,
        result: claimLinkSupportBlockedResult({
          run: input.run,
          timestamp: nowText,
          message,
          store: input.store,
          query: {
            missing,
            mode,
            claimCandidates,
            supportLinkIdCandidates,
            sourceCandidates: sourceIds,
            evidenceCellId: evidenceCellId || null
          }
        })
      };
    }
    const claim = resolvedClaim ?? readResearchWorkStoreEntity<WorkStoreClaim>(input.store, "claims", claimId);
    if (claim === null) {
      const message = `claim.link_support blocked because claim ${claimId} was not found.`;
      return {
        handled: true,
        store: input.store,
        message,
        result: claimLinkSupportBlockedResult({
          run: input.run,
          timestamp: nowText,
          message,
          store: input.store,
          sourceId: resolvedSourceId,
          query: {
            mode,
            claimId,
            claimCandidates,
            supportLinkIdCandidates,
            sourceId: resolvedSourceId,
            evidenceCellId: evidenceCellId || null
          },
          nextHints: ["workspace.search", "claim.create", "claim.link_support"]
        })
      };
    }
    const activeSupportLinks = activeCitationsForClaim(input.store, claimId);
    if (mode === "remove") {
      const oldEvidenceCellIds = new Set(stringCandidates(
        evidenceCell?.id ?? null,
        evidenceCellId,
        args.entity.oldEvidenceCellId,
        args.entity.replaceEvidenceCellId,
        args.entity.previousEvidenceCellId
      ));
      const oldSourceIds = new Set(sourceIds.filter((candidate) => candidate.length > 0));
      const supportLinksToRetire = activeSupportLinks.filter((citation) => (
        supportLinkIdCandidates.includes(citation.id)
        || (oldEvidenceCellIds.size > 0 && citation.evidenceCellId !== null && oldEvidenceCellIds.has(citation.evidenceCellId))
        || (oldSourceIds.size > 0 && oldSourceIds.has(citation.sourceId))
      ));
      if (supportLinksToRetire.length === 0) {
        const message = "claim.link_support remove blocked because no active support link matched the provided citationId, evidenceCellId, or sourceId.";
        return {
          handled: true,
          store: input.store,
          message,
          result: claimLinkSupportBlockedResult({
            run: input.run,
            timestamp: nowText,
            message,
            store: input.store,
            sourceId: resolvedSourceId.length > 0 ? resolvedSourceId : null,
            query: {
              mode,
              claimId,
              supportLinkIdCandidates,
              evidenceCellId: evidenceCellId || null,
              sourceCandidates: sourceIds,
              activeSupportLinkIds: activeSupportLinks.map((citation) => citation.id)
            },
            nextHints: ["workspace.list", "workspace.read", "claim.link_support"]
          })
        };
      }

      let nextStore = input.store;
      const statusReason = stringInput(args.entity.statusReason ?? args.entity.reason ?? input.decision.inputs.reason, "Retired by explicit claim.link_support remove action.");
      for (const citation of supportLinksToRetire) {
        nextStore = patchResearchWorkStoreEntity(nextStore, {
          collection: "citations",
          id: citation.id,
          changes: {
            status: "retired",
            supersededBy: null,
            statusReason
          }
        }, nowText);
      }
      const claimAfterRetire = readResearchWorkStoreEntity<WorkStoreClaim>(nextStore, "claims", claimId) ?? claim;
      nextStore = patchResearchWorkStoreEntity(nextStore, {
        collection: "claims",
        id: claimId,
        changes: {
          sourceIds: claimSourceIdsAfterSupportRetirement({
            store: nextStore,
            claim: claimAfterRetire,
            retiredSourceIds: supportLinksToRetire.map((citation) => citation.sourceId)
          })
        }
      }, nowText);
      const supportReadiness = supportReadinessForWorkspace(nextStore);
      const supported = supportReadiness.supportedClaimIds.has(claimId);
      const claimIssues = supportReadiness.issues.filter((issue) => issue.claimId === claimId);
      nextStore = patchResearchWorkStoreEntity(nextStore, {
        collection: "claims",
        id: claimId,
        changes: {
          supportStatus: supported ? "supported" : "weak",
          risk: supported ? null : claimIssues[0]?.message ?? "No active evidence-backed support link currently supports this claim."
        }
      }, nowText);
      await writeResearchWorkStore(nextStore);
      const updatedClaim = readResearchWorkStoreEntity<WorkStoreClaim>(nextStore, "claims", claimId);
      const retiredPreviews = supportLinksToRetire.flatMap((citation) => {
        const updated = readResearchWorkStoreEntity<WorkStoreCitation>(nextStore, "citations", citation.id);
        return updated === null ? [] : [entityPreviewForAgent(updated, nextStore)];
      });
      const message = `Retired ${supportLinksToRetire.length} support link(s) for claim ${claimId}.`;
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
          count: supportLinksToRetire.length,
          totalCount: nextStore.objects.citations.length,
          items: retiredPreviews,
          related: updatedClaim === null ? [] : [entityPreviewForAgent(updatedClaim, nextStore)],
          stateDelta: {
            supportLinksRetired: supportLinksToRetire.length,
            claimsPatched: 1
          },
          nextHints: supported ? ["release.verify", "workspace.read"] : ["claim.link_support", "claim.patch", "workspace.list"]
        })
      };
    }
    const requestedSectionIds = stringArrayInput(args.entity.sectionIds, 20)
      .filter((sectionId) => readResearchWorkStoreEntity<WorkStoreManuscriptSection>(input.store, "manuscriptSections", sectionId) !== null);
    const sectionIds = uniqueStrings([
      ...requestedSectionIds,
      ...sectionIdsUsingClaim(input.store, claimId, claim)
    ]);
    const citation = supportLinkFromInput({
      run: input.run,
      now: nowText,
      store: input.store,
      claimId,
      sourceId: resolvedSourceId,
      evidenceCellId: evidenceCell?.id ?? (evidenceCellId.length === 0 ? null : evidenceCellId),
      sectionIds,
      entity: args.entity,
      fallbackSnippet: null,
      relation: "supports"
    });
    if (citation === null) {
      const message = evidenceCellId.length > 0 && evidenceCell === null
        ? `claim.link_support blocked because evidence cell ${evidenceCellId} was not found.`
        : `claim.link_support blocked because source ${resolvedSourceId} has no existing evidence cell that can support claim ${claimId}.`;
      return {
        handled: true,
        store: input.store,
        message,
        result: claimLinkSupportBlockedResult({
          run: input.run,
          timestamp: nowText,
          message,
          store: input.store,
          sourceId: resolvedSourceId,
          query: {
            mode,
            claimId,
            sourceId: resolvedSourceId,
            evidenceCellId: evidenceCellId || null
          },
          nextHints: ["workspace.list", "workspace.read", "evidence.create_cell", "claim.link_support"]
        })
      };
    }
    const existingCitation = readResearchWorkStoreEntity<WorkStoreCitation>(input.store, "citations", citation.id);
    let nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, citation, nowText);
    let replacedCount = 0;
    let replacementTargets: WorkStoreCitation[] = [];
    if (mode === "replace") {
      const replacementEvidenceCellIds = new Set(stringCandidates(
        args.entity.oldEvidenceCellId,
        args.entity.replaceEvidenceCellId,
        args.entity.previousEvidenceCellId
      ));
      const replacementSourceIds = new Set(stringCandidates(
        args.entity.oldSourceId,
        args.entity.replaceSourceId
      ));
      replacementTargets = activeSupportLinks.filter((candidate) => (
        candidate.id !== citation.id
        && (
          supportLinkIdCandidates.length === 0 && replacementEvidenceCellIds.size === 0 && replacementSourceIds.size === 0
            ? true
            : supportLinkIdCandidates.includes(candidate.id)
              || (candidate.evidenceCellId !== null && replacementEvidenceCellIds.has(candidate.evidenceCellId))
              || replacementSourceIds.has(candidate.sourceId)
        )
      ));
      const statusReason = stringInput(args.entity.statusReason ?? args.entity.reason ?? input.decision.inputs.reason, `Superseded by ${citation.id}.`);
      for (const oldCitation of replacementTargets) {
        nextStore = patchResearchWorkStoreEntity(nextStore, {
          collection: "citations",
          id: oldCitation.id,
          changes: {
            status: "superseded",
            supersededBy: citation.id,
            statusReason
          }
        }, nowText);
      }
      replacedCount = replacementTargets.length;
    }
    const retiredSourceIds = mode === "replace"
      ? input.store.objects.citations
        .filter((candidate) => {
          const nextCandidate = readResearchWorkStoreEntity<WorkStoreCitation>(nextStore, "citations", candidate.id);
          return nextCandidate !== null
            && nextCandidate.claimIds.includes(claimId)
            && researchObjectLifecycleStatus(nextCandidate) === "superseded";
        })
        .map((candidate) => candidate.sourceId)
      : [];
    const retainedClaimSourceIds = mode === "replace"
      ? claimSourceIdsAfterSupportRetirement({
        store: nextStore,
        claim,
        retiredSourceIds
      })
      : claim.sourceIds;
    const nextClaimSourceIds = uniqueStrings([
      ...retainedClaimSourceIds,
      ...activeCitationsForClaim(nextStore, claimId).map((activeCitation) => activeCitation.sourceId),
      citation.sourceId
    ]);
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
    const propagation = propagateClaimSupportToSections({
      store: nextStore,
      claimIds: [claimId],
      sectionIds,
      now: nowText
    });
    nextStore = propagation.store;
    await writeResearchWorkStore(nextStore);
    const updatedClaim = readResearchWorkStoreEntity<WorkStoreClaim>(nextStore, "claims", claimId);
    const updatedSectionPreviews = sectionIds.flatMap((sectionId) => {
      const section = readResearchWorkStoreEntity<WorkStoreManuscriptSection>(nextStore, "manuscriptSections", sectionId);
      return section === null ? [] : [entityPreviewForAgent(section, nextStore)];
    });
    const changedOldSupportPreviews = replacementTargets.flatMap((target) => {
      const updated = readResearchWorkStoreEntity<WorkStoreCitation>(nextStore, "citations", target.id);
      return updated === null ? [] : [entityPreviewForAgent(updated, nextStore)];
    });
    const message = mode === "replace"
      ? existingCitation === null
        ? replacedCount > 0
          ? `claim.link_support replace created support link ${citation.id} from ${citation.sourceTitle} to claim ${claimId} and superseded ${replacedCount} old support link(s).`
          : `claim.link_support replace created support link ${citation.id} from ${citation.sourceTitle} to claim ${claimId}; no older active support links matched the replacement criteria.`
        : replacedCount > 0
          ? `claim.link_support replace updated existing support link ${citation.id} for claim ${claimId} and superseded ${replacedCount} old support link(s).`
          : `claim.link_support replace updated existing support link ${citation.id} for claim ${claimId}; no other active support links matched the replacement criteria.`
      : existingCitation === null
        ? `claim.link_support append created support link ${citation.id} from ${citation.sourceTitle} to claim ${claimId}.`
        : `claim.link_support append updated existing support link ${citation.id} from ${citation.sourceTitle} to claim ${claimId}.`;
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
        related: [
          ...changedOldSupportPreviews,
          ...updatedSectionPreviews,
          ...(updatedClaim === null ? [] : [entityPreviewForAgent(updatedClaim, nextStore)])
        ],
        stateDelta: existingCitation === null
          ? {
            supportLinksCreated: 1,
            supportLinksSuperseded: replacedCount,
            supportLinksAttachedToSections: propagation.supportLinksAttachedToSections,
            sectionIdsUpdated: propagation.sectionIdsUpdated,
            sourceIdsAdded: propagation.sourceIdsAdded
          }
          : {
            supportLinksUpdated: 1,
            supportLinksSuperseded: replacedCount,
            supportLinksAttachedToSections: propagation.supportLinksAttachedToSections,
            sectionIdsUpdated: propagation.sectionIdsUpdated,
            sourceIdsAdded: propagation.sourceIdsAdded
          },
        nextHints: ["section.link_claim", "claim.check_support", "release.verify"]
      })
    };
  }

  if (input.decision.action === "extraction.patch") {
    const extractionId = args.entityId ?? stringInput(args.entity.extractionId ?? args.entity.id, "");
    const extraction = extractionId.length === 0 ? null : readResearchWorkStoreEntity<WorkStoreExtraction>(input.store, "extractions", extractionId);
    if (extraction === null) {
      const message = "Extraction patch blocked because no known extraction id was provided.";
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
          items: recentExtractionPreviews(input.store),
          nextHints: ["workspace.list", "workspace.read", "extraction.patch"]
        })
      };
    }
    const lifecyclePatch = lifecyclePatchFromEntity(args.entity);
    const supersededBy = typeof lifecyclePatch.supersededBy === "string" ? lifecyclePatch.supersededBy : null;
    if (supersededBy !== null && readResearchWorkStoreEntity<WorkStoreExtraction>(input.store, "extractions", supersededBy) === null) {
      const message = `Extraction patch blocked because supersededBy extraction ${supersededBy} was not found.`;
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
          query: { entityId: extractionId, supersededBy },
          items: recentExtractionPreviews(input.store, extraction.sourceId),
          nextHints: ["workspace.list", "workspace.read", "extraction.patch"]
        })
      };
    }
    const extractionFieldPatch: Partial<PaperExtraction> = {};
    for (const field of [
      "problemSetting",
      "systemType",
      "architecture",
      "toolsAndMemory",
      "planningStyle",
      "evaluationSetup",
      "confidence"
    ] as const) {
      const value = args.entity[field] ?? args.changes[field];
      if (typeof value === "string") {
        (extractionFieldPatch as Record<string, unknown>)[field] = value;
      }
    }
    for (const field of ["successSignals", "failureModes", "limitations", "evidenceNotes"] as const) {
      const value = args.entity[field] ?? args.changes[field];
      if (Array.isArray(value)) {
        (extractionFieldPatch as Record<string, unknown>)[field] = stringArrayInput(value, 80);
      }
    }
    const supportedClaimsValue = args.entity.supportedClaims ?? args.changes.supportedClaims;
    if (supportedClaimsValue !== undefined) {
      extractionFieldPatch.supportedClaims = supportedClaimsFromToolInput(supportedClaimsValue);
    }
    const changes: Record<string, unknown> = {
      ...args.changes,
      ...lifecyclePatch
    };
    for (const field of Object.keys(extractionFieldPatch)) {
      delete changes[field];
    }
    if (Object.keys(extractionFieldPatch).length > 0) {
      changes.extraction = {
        ...extraction.extraction,
        ...extractionFieldPatch
      };
    }
    if (Object.keys(changes).length === 0) {
      const message = `Extraction patch skipped for ${extractionId} because no patch fields were provided.`;
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
          collection: "extractions",
          entity: entityPreviewForAgent(extraction, input.store),
          nextHints: ["workspace.read", "evidence.patch", "extraction.patch"]
        })
      };
    }
    const nextStore = patchResearchWorkStoreEntity(input.store, {
      collection: "extractions",
      id: extractionId,
      changes
    }, nowText);
    await writeResearchWorkStore(nextStore);
    const updatedExtraction = readResearchWorkStoreEntity<WorkStoreExtraction>(nextStore, "extractions", extractionId);
    const message = `Extraction patched ${extractionId}; status is ${updatedExtraction === null ? "unknown" : researchObjectLifecycleStatus(updatedExtraction)}.`;
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
        query: { entityId: extractionId },
        count: updatedExtraction === null ? 0 : 1,
        totalCount: nextStore.objects.extractions.length,
        entity: updatedExtraction === null ? null : entityPreviewForAgent(updatedExtraction, nextStore),
        stateDelta: { extractionsPatched: 1 },
        nextHints: ["workspace.read", "evidence.patch", "evidence.create_cell"]
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
      const message = "Extraction create blocked because it requires a known canonical source id plus explicit source-derived extraction content; process rationale/expectedOutcome is never persisted as extraction content.";
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
          items: recentSourcePreviews(input.store),
          nextHints: ["workspace.read", "workspace.list", "extraction.create"]
        })
      };
    }
    const existingExtractionsForSource = input.store.objects.extractions.filter((extraction) => (
      sourceEquivalentIds(input.store, extractionResult.source.id).includes(extraction.sourceId)
    ));
    const warnings = extractionQualityWarnings(extractionResult.extraction, existingExtractionsForSource);
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, extractionResult.extraction, nowText);
    await writeResearchWorkStore(nextStore);
    const message = [
      `Extraction created for source ${extractionResult.source.title}.`,
      ...warnings.map((warning) => `Diagnostic: ${warning}`)
    ].join(" ");
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
        related: [
          entityPreviewForAgent(extractionResult.source, nextStore),
          ...existingExtractionsForSource.slice(-4).map((extraction) => entityPreviewForAgent(extraction, input.store))
        ],
        stateDelta: {
          extractionsCreated: 1,
          extractionDiagnostics: warnings.length
        },
        nextHints: warnings.length > 0
          ? ["workspace.read", "extraction.create", "evidence.create_cell"]
          : ["evidence.create_cell", "workspace.read", "claim.create"]
      })
    };
  }

  if (input.decision.action === "evidence.patch") {
    const evidenceCellId = args.entityId ?? stringInput(args.entity.evidenceCellId ?? args.entity.id, "");
    const cell = evidenceCellId.length === 0 ? null : readResearchWorkStoreEntity<WorkStoreEvidenceCell>(input.store, "evidenceCells", evidenceCellId);
    if (cell === null) {
      const message = "Evidence patch blocked because no known evidence cell id was provided.";
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
          items: recentEvidenceCellPreviews(input.store),
          nextHints: ["workspace.list", "workspace.read", "evidence.patch"]
        })
      };
    }
    const lifecyclePatch = lifecyclePatchFromEntity(args.entity);
    const supersededBy = typeof lifecyclePatch.supersededBy === "string" ? lifecyclePatch.supersededBy : null;
    if (supersededBy !== null && readResearchWorkStoreEntity<WorkStoreEvidenceCell>(input.store, "evidenceCells", supersededBy) === null) {
      const message = `Evidence patch blocked because supersededBy evidence cell ${supersededBy} was not found.`;
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
          query: { entityId: evidenceCellId, supersededBy },
          items: recentEvidenceCellPreviews(input.store, cell.sourceId),
          nextHints: ["workspace.list", "workspace.read", "evidence.patch"]
        })
      };
    }
    const requestedExtractionId = stringInput(args.entity.extractionId ?? args.changes.extractionId, "");
    if (requestedExtractionId.length > 0 && readResearchWorkStoreEntity<WorkStoreExtraction>(input.store, "extractions", requestedExtractionId) === null) {
      const message = `Evidence patch blocked because extraction ${requestedExtractionId} was not found.`;
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
          query: { entityId: evidenceCellId, extractionId: requestedExtractionId },
          related: recentExtractionPreviews(input.store, cell.sourceId),
          nextHints: ["workspace.list", "workspace.read", "extraction.create"]
        })
      };
    }
    const changes: Record<string, unknown> = {
      ...args.changes,
      ...lifecyclePatch
    };
    delete changes.field;
    delete changes.value;
    delete changes.text;
    delete changes.evidenceText;
    delete changes.confidence;
    delete changes.extractionId;
    const field = args.entity.field ?? args.changes.field;
    if (typeof field === "string" && evidenceCellFields.includes(field as WorkStoreEvidenceCell["field"])) {
      changes.field = field;
    }
    const value = args.entity.value ?? args.entity.evidenceText ?? args.entity.text ?? args.changes.value ?? args.changes.text;
    if (value !== undefined) {
      changes.value = Array.isArray(value) ? stringArrayInput(value, 80) : stringInput(value, "");
    }
    const confidence = stringInput(args.entity.confidence ?? args.changes.confidence, "");
    if (confidence.length > 0) {
      changes.confidence = confidence;
    }
    if (requestedExtractionId.length > 0) {
      changes.extractionId = requestedExtractionId;
    }
    if (Object.keys(changes).length === 0) {
      const message = `Evidence patch skipped for ${evidenceCellId} because no patch fields were provided.`;
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
          collection: "evidenceCells",
          entity: entityPreviewForAgent(cell, input.store),
          nextHints: ["workspace.read", "evidence.patch", "claim.link_support"]
        })
      };
    }
    const nextStore = patchResearchWorkStoreEntity(input.store, {
      collection: "evidenceCells",
      id: evidenceCellId,
      changes
    }, nowText);
    await writeResearchWorkStore(nextStore);
    const updatedCell = readResearchWorkStoreEntity<WorkStoreEvidenceCell>(nextStore, "evidenceCells", evidenceCellId);
    const message = `Evidence cell patched ${evidenceCellId}; status is ${updatedCell === null ? "unknown" : researchObjectLifecycleStatus(updatedCell)}.`;
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
        query: { entityId: evidenceCellId },
        count: updatedCell === null ? 0 : 1,
        totalCount: nextStore.objects.evidenceCells.length,
        entity: updatedCell === null ? null : entityPreviewForAgent(updatedCell, nextStore),
        stateDelta: { evidenceCellsPatched: 1 },
        nextHints: ["workspace.read", "claim.link_support", "release.verify"]
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
      const requestedSource = knownSourceFromToolInput({
        store: input.store,
        decision: input.decision,
        entity: args.entity
      });
      const message = "Evidence cell create blocked because it requires a known source id, an existing extraction for that source, and explicit evidence value/text; process rationale/expectedOutcome is never persisted as evidence content.";
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
          items: requestedSource === null ? recentSourcePreviews(input.store) : [entityPreviewForAgent(requestedSource, input.store)],
          related: recentExtractionPreviews(input.store, requestedSource?.id ?? null),
          query: {
            sourceId: requestedSource?.id ?? null,
            extractionId: stringInput(args.entity.extractionId, "") || null,
            required: ["known sourceId", "existing extraction for that source", "explicit evidence value/text"]
          },
          nextHints: ["extraction.create", "workspace.list", "workspace.read"]
        })
      };
    }
    const warnings = evidenceCellQualityWarnings(cell);
    const source = canonicalSourceForId(input.store, cell.sourceId);
    const extraction = readResearchWorkStoreEntity<WorkStoreExtraction>(input.store, "extractions", cell.extractionId);
    const nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, cell, nowText);
    await writeResearchWorkStore(nextStore);
    const message = [
      `Evidence cell created ${cell.id}.`,
      ...warnings.map((warning) => `Diagnostic: ${warning}`)
    ].join(" ");
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
        related: [
          ...(source === null ? [] : [entityPreviewForAgent(source, nextStore)]),
          ...(extraction === null ? [] : [entityPreviewForAgent(extraction, nextStore)])
        ],
        stateDelta: {
          evidenceCellsCreated: 1,
          evidenceCellDiagnostics: warnings.length
        },
        nextHints: warnings.length > 0
          ? ["workspace.read", "evidence.create_cell", "claim.link_support"]
          : ["claim.create", "claim.link_support", "evidence.matrix_view"]
      })
    };
  }

  if (input.decision.action === "evidence.matrix_view") {
    const timestamp = input.now();
    const matrix = buildEvidenceMatrix({
      runId: input.run.id,
      brief: input.run.brief,
      paperExtractions: input.store.objects.extractions
        .filter(researchObjectIsActive)
        .map((entry) => entry.extraction)
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
    const sectionCandidates = stringCandidates(
      args.entityId,
      args.entity.id,
      args.entity.sectionId,
      args.entity.manuscriptSectionId,
      input.decision.inputs.paperIds[0]
    );
    const section = resolveSectionReference(input.store, sectionCandidates);
    const message = section === null
      ? "Section read found no section."
      : `Section read ${section.title}: ${manuscriptSectionBlocks(section.markdown).length} block(s), ${section.claimIds.length} linked claim(s), ${manuscriptSectionHygieneWarnings(section, input.store).length} mechanical hygiene warning(s).`;
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
          entityId: sectionCandidates[0] ?? null
        },
        count: section === null ? 0 : 1,
        totalCount: section === null ? 0 : 1,
        entity: section === null ? null : entityPreviewForAgent(section, input.store),
        items: section === null ? [] : sectionBlockPreviews(section),
        related: section === null ? input.store.objects.manuscriptSections.slice(-8).map((entry) => entityPreviewForAgent(entry, input.store)) : sectionRepairRelatedPreviews(input.store, section),
        nextHints: section === null ? ["section.create"] : ["section.patch", "section.link_claim", "section.check_claims"]
      })
    };
  }

  if (input.decision.action === "section.create" || input.decision.action === "section.patch") {
    const statusValidation = manuscriptSectionStatusValidation({
      entity: args.entity,
      changes: args.changes
    });
    if (!statusValidation.ok) {
      const message = `Section create/patch blocked. Invalid manuscript section status "${statusValidation.invalidValue ?? "(unknown)"}". Use one of: ${validManuscriptSectionStatuses.join(", ")}. No section was persisted.`;
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
          collection: "manuscriptSections",
          count: 0,
          totalCount: input.store.objects.manuscriptSections.length,
          items: input.store.objects.manuscriptSections.slice(-8).map((entry) => entityPreviewForAgent(entry, input.store)),
          nextHints: ["section.read", "section.patch", "section.check_claims"]
        })
      };
    }
    const existing = input.decision.action === "section.patch"
      ? resolveSectionReference(input.store, stringCandidates(
        args.entityId,
        args.entity.id,
        args.entity.sectionId,
        args.entity.manuscriptSectionId,
        input.decision.inputs.paperIds[0]
      ))
      : null;
    const section = manuscriptSectionFromToolInput({
      run: input.run,
      now: nowText,
      decision: input.decision,
      existing
    });
    if (section === null) {
      const message = "Section create/patch blocked. section.create requires explicit manuscript content in workStore.entity.markdown, content, paragraph, or paragraphs. section.patch accepts replace_all, replace_block, insert_after_block, append_paragraph, remove_block, update_title, set_order, or set_claim_links; block operations require a 1-based blockIndex when relevant. Use orderIndex with set_order to control model-owned export order. Process rationale/expectedOutcome is never persisted as section prose.";
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
          collection: "manuscriptSections",
          count: 0,
          totalCount: input.store.objects.manuscriptSections.length,
          items: input.store.objects.manuscriptSections.slice(-8).map((entry) => entityPreviewForAgent(entry, input.store)),
          nextHints: ["section.read", "workspace.read", "section.create", "section.patch", "notebook.patch"]
        })
      };
    }
    const supportSourceIds = activeSupportSourceIdsForClaims(input.store, section.claimIds);
    const sectionSourceIdsBefore = new Set(section.sourceIds);
    const sectionWithDerivedProvenance = {
      ...section,
      sourceIds: uniqueStrings([...section.sourceIds, ...supportSourceIds])
    };
    let nextStore = createResearchWorkStoreEntity<WorkStoreEntity>(input.store, sectionWithDerivedProvenance, nowText);
    const propagation = propagateClaimSupportToSections({
      store: nextStore,
      claimIds: sectionWithDerivedProvenance.claimIds,
      sectionIds: [sectionWithDerivedProvenance.id],
      now: nowText
    });
    nextStore = propagation.store;
    await writeResearchWorkStore(nextStore);
    const updatedSection = readResearchWorkStoreEntity<WorkStoreManuscriptSection>(nextStore, "manuscriptSections", sectionWithDerivedProvenance.id) ?? sectionWithDerivedProvenance;
    const sourceIdsAddedOnCreate = updatedSection.sourceIds.filter((sourceId) => !sectionSourceIdsBefore.has(sourceId)).length;
    const hygieneWarningCount = manuscriptSectionHygieneWarnings(updatedSection, nextStore).length;
    const message = `Section updated ${updatedSection.id}: ${manuscriptSectionBlocks(updatedSection.markdown).length} block(s), ${updatedSection.claimIds.length} linked claim(s), ${hygieneWarningCount} mechanical hygiene warning(s).`;
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
        entity: entityPreviewForAgent(updatedSection, nextStore),
        items: sectionBlockPreviews(updatedSection),
        related: sectionRepairRelatedPreviews(nextStore, updatedSection),
        stateDelta: {
          [input.decision.action === "section.create" ? "sectionsCreated" : "sectionsPatched"]: 1,
          sectionHygieneWarnings: hygieneWarningCount,
          sectionIdsUpdated: propagation.sectionIdsUpdated,
          sourceIdsAdded: sourceIdsAddedOnCreate + propagation.sourceIdsAdded,
          supportLinksAttachedToSections: propagation.supportLinksAttachedToSections
        },
        nextHints: hygieneWarningCount > 0
          ? ["section.read", "section.patch", "section.link_claim", "section.check_claims"]
          : ["section.link_claim", "section.check_claims", "release.verify"]
      })
    };
  }

  if (input.decision.action === "section.link_claim") {
    const targets = sectionClaimLinkTargets({
      decision: input.decision,
      store: input.store
    });
    if (targets.section === null || targets.claim === null) {
      const availableSections = input.store.objects.manuscriptSections.slice(-8).map((section) => entityPreviewForAgent(section, input.store));
      const availableClaims = input.store.objects.claims.slice(-8).map((claim) => entityPreviewForAgent(claim, input.store));
      const missingParts = [
        targets.section === null ? "known section id" : null,
        targets.claim === null ? "known claim id" : null
      ].filter((part): part is string => part !== null);
      const message = `Section claim link skipped because ${missingParts.join(" and ")} could not be resolved. Use a manuscript section id/sectionId and a claim id from the related previews.`;
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
          query: {
            sectionCandidates: targets.sectionCandidates,
            claimCandidates: targets.claimCandidates
          },
          items: availableSections,
          related: availableClaims,
          nextHints: ["workspace.list", "workspace.read", "section.link_claim"]
        })
      };
    }
    const section = targets.section;
    const claim = targets.claim;
    const supportSourceIds = activeSupportSourceIdsForClaims(input.store, [claim.id]);
    const sourceIdsBefore = new Set(section.sourceIds);
    const sectionPatched = patchResearchWorkStoreEntity(input.store, {
      collection: "manuscriptSections",
      id: section.id,
      changes: {
        claimIds: uniqueStrings([...section.claimIds, claim.id]),
        sourceIds: uniqueStrings([...section.sourceIds, ...supportSourceIds])
      }
    }, nowText);
    let nextStore = patchResearchWorkStoreEntity(sectionPatched, {
      collection: "claims",
      id: claim.id,
      changes: {
        usedInSections: uniqueStrings([...claim.usedInSections, section.id])
      }
    }, nowText);
    const propagation = propagateClaimSupportToSections({
      store: nextStore,
      claimIds: [claim.id],
      sectionIds: [section.id],
      now: nowText
    });
    nextStore = propagation.store;
    await writeResearchWorkStore(nextStore);
    const updatedSection = readResearchWorkStoreEntity<WorkStoreManuscriptSection>(nextStore, "manuscriptSections", section.id);
    const updatedClaim = readResearchWorkStoreEntity<WorkStoreClaim>(nextStore, "claims", claim.id);
    const sourceIdsAddedBeforePropagation = (updatedSection?.sourceIds ?? [])
      .filter((sourceId) => !sourceIdsBefore.has(sourceId)).length;
    const message = `Section ${section.id} linked to claim ${claim.id}.`;
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
        query: { sectionId: section.id, claimId: claim.id },
        count: updatedSection === null ? 0 : 1,
        totalCount: nextStore.objects.manuscriptSections.length,
        entity: updatedSection === null ? null : entityPreviewForAgent(updatedSection, nextStore),
        related: updatedClaim === null ? [] : [entityPreviewForAgent(updatedClaim, nextStore)],
        stateDelta: {
          sectionClaimLinksCreated: 1,
          sectionIdsUpdated: propagation.sectionIdsUpdated,
          sourceIdsAdded: sourceIdsAddedBeforePropagation + propagation.sourceIdsAdded,
          supportLinksAttachedToSections: propagation.supportLinksAttachedToSections
        },
        nextHints: ["section.check_claims", "release.verify", "workspace.read"]
      })
    };
  }

  if (input.decision.action === "release.verify" || (input.decision.action === "check.run" && args.entityId === null)) {
    const references = referencesFromWorkStore(input.run, input.store);
    const notebookDiagnostics = buildNotebookDiagnostics(input.store);
    const notebookReadinessIssue = notebookFinalizationReadinessIssue(input.store.notebook);
    const checkBundle = workspaceManuscriptChecks({
      run: input.run,
      store: input.store,
      references
    });
    const compilerDiagnostics = manuscriptCompilerDiagnostics({
      store: input.store,
      references
    });
    const releaseChecks = releaseCheckEntitiesFromChecks(input.run, checkBundle.checks, nowText);
    const nextStore = upsertResearchWorkStoreEntities(input.store, releaseChecks, nowText);
    await writeResearchWorkStore(nextStore);
    await writeJsonArtifact(input.run.artifacts.referencesPath, references);
    await writeJsonArtifact(input.run.artifacts.manuscriptChecksPath, checkBundle);
    const hardFailures = releaseChecks.filter((check) => check.status === "fail" && check.severity === "blocker");
    const requestedMissionTarget = requestedMissionTargetFromToolInput({
      entity: args.entity,
      notebook: input.store.notebook
    });
    const releaseCriticFreshness = criticFreshnessEvaluationForStore({
      store: input.store,
      stage: "release",
      artifactPath: criticReviewArtifactPath(input.run, "release")
    });
    const artifactContract = evaluateArtifactContract({
      run: input.run,
      store: input.store,
      references,
      hardInvariantFailures: checkBundle.checks.filter((check) => check.status === "fail" && check.severity === "blocker"),
      requestedMissionTarget,
      criticAvailable: criticReviewAvailable(input.researchBackend),
      releaseCriticFreshness
    });
    const mechanicalChecksPassed = hardFailures.length === 0;
    const finalizationReady = mechanicalChecksPassed && notebookReadinessIssue === null && artifactContract.canFinalize;
    const status = mechanicalChecksPassed ? "ok" : "not_ready";
    const message = hardFailures.length > 0
      ? `Mechanical release verification only: found ${hardFailures.length} hard invariant repair item(s); manuscript is not ready yet. This does not assess research quality.`
      : notebookReadinessIssue !== null
        ? `Mechanical release verification only: checks passed and release checks were persisted, but finalization is not ready because research readiness has not been intentionally recorded: ${notebookReadinessIssue} This is a finalization diagnostic, not a scientific-quality approval.`
        : artifactContract.canFinalize
          ? `Mechanical release verification only: checks passed. Release critic freshness is ${releaseCriticFreshness.status}. Artifact contract ${artifactContract.missionTarget}/${artifactContract.paperMode} is structurally ready for manuscript.finalize. Passing this does not assess research quality or scientific sufficiency.`
          : `Mechanical release verification only: checks passed and release checks were persisted, but finalization is not ready for ${artifactContract.missionTarget}/${artifactContract.paperMode}: ${artifactContract.failures.slice(0, 3).join(" ")} Continue machine-actionable research work; do not stop as a brief.`;
    return {
      handled: true,
      store: nextStore,
      message,
      result: makeAgentToolResult({
        run: input.run,
        action: input.decision.action,
        timestamp: nowText,
        status,
        readOnly: false,
        message,
        collection: "releaseChecks",
        count: releaseChecks.length,
        totalCount: releaseChecks.length,
        items: releaseChecks.map((check) => entityPreviewForAgent(check, nextStore)),
        related: [
          ...releaseRepairPreviews(hardFailures),
          ...manuscriptCompilerDiagnosticPreviews(compilerDiagnostics),
          ...artifactContractPreviews(artifactContract),
          ...notebookReadinessRepairPreviews(notebookReadinessIssue),
          ...notebookDiagnosticPreviews(notebookDiagnostics)
        ],
        stateDelta: {
          releaseChecksCreated: releaseChecks.length,
          mechanicalReleaseChecksPassed: mechanicalChecksPassed ? 1 : 0,
          finalizationReady: finalizationReady ? 1 : 0,
          hardInvariantBlockers: hardFailures.length,
          manuscriptCompilerErrors: compilerDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
          artifactContractFailures: artifactContract.failures.length,
          releaseCriticFreshnessProblems: releaseCriticFreshness.status === "fresh" ? 0 : 1,
          notebookDiagnosticWarnings: notebookDiagnostics.warningCount,
          notebookReadinessRecorded: notebookReadinessIssue === null ? 1 : 0
        },
        nextHints: hardFailures.length > 0
          ? ["workspace.read", "claim.link_support", "section.link_claim"]
          : !artifactContract.canFinalize
            ? uniqueStrings([
              ...artifactContract.nextHints,
              ...(notebookReadinessIssue !== null ? ["notebook.read", "notebook.patch"] : []),
              ...(notebookDiagnostics.warningCount > 0 ? ["notebook.read"] : []),
              "release.verify"
            ]).filter((hint) => workspaceResearchActions({ criticAvailable: criticReviewAvailable(input.researchBackend) }).includes(hint as never))
            : notebookReadinessIssue !== null || notebookDiagnostics.warningCount > 0
              ? ["notebook.read", "notebook.patch", "release.verify"]
              : criticReviewAvailable(input.researchBackend)
                ? ["manuscript.finalize", "critic.review"]
                : ["manuscript.finalize"]
      })
    };
  }

  if (input.decision.action === "manuscript.finalize") {
    const references = referencesFromWorkStore(input.run, input.store);
    const notebookDiagnostics = buildNotebookDiagnostics(input.store);
    const notebookReadinessIssue = notebookFinalizationReadinessIssue(input.store.notebook);
    const checkBundle = workspaceManuscriptChecks({
      run: input.run,
      store: input.store,
      references
    });
    const compilerDiagnostics = manuscriptCompilerDiagnostics({
      store: input.store,
      references
    });
    const releaseChecks = releaseCheckEntitiesFromChecks(input.run, checkBundle.checks, nowText);
    const hardFailures = checkBundle.checks.filter((check) => check.status === "fail" && check.severity === "blocker");
    const nextStore = upsertResearchWorkStoreEntities(input.store, releaseChecks, nowText);
    await writeResearchWorkStore(nextStore);
    await writeJsonArtifact(input.run.artifacts.referencesPath, references);
    await writeJsonArtifact(input.run.artifacts.manuscriptChecksPath, checkBundle);
    const requestedMissionTarget = requestedMissionTargetFromToolInput({
      entity: args.entity,
      notebook: input.store.notebook
    });
    const releaseCriticFreshness = criticFreshnessEvaluationForStore({
      store: input.store,
      stage: "release",
      artifactPath: criticReviewArtifactPath(input.run, "release")
    });
    const artifactContract = evaluateArtifactContract({
      run: input.run,
      store: input.store,
      references,
      hardInvariantFailures: hardFailures,
      requestedMissionTarget,
      criticAvailable: criticReviewAvailable(input.researchBackend),
      releaseCriticFreshness
    });

    if (hardFailures.length > 0 || notebookReadinessIssue !== null || !artifactContract.canFinalize) {
      const message = notebookReadinessIssue !== null
        ? [
          `Manuscript finalization is not ready: ${notebookReadinessIssue}`,
          ...artifactContract.failures.slice(0, 1)
        ].join(" ")
        : hardFailures.length > 0
          ? `Manuscript finalization is not ready: ${hardFailures.length} hard invariant repair item(s) remain.`
          : [
            `Manuscript finalization is not ready for ${artifactContract.missionTarget}/${artifactContract.paperMode}.`,
            artifactContract.supportedCheckpoint === null
              ? "No export was written; continue machine-actionable research work."
              : `The current workspace may support a ${artifactContract.supportedCheckpoint} checkpoint, but the mission remains ${artifactContract.missionTarget}; continue research instead of stopping.`,
            ...artifactContract.failures.slice(0, 3)
          ].join(" ");
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
          related: [
            ...releaseRepairPreviews(releaseChecks.filter((check) => check.status === "fail" && check.severity === "blocker")),
            ...manuscriptCompilerDiagnosticPreviews(compilerDiagnostics),
            ...artifactContractPreviews(artifactContract),
            ...notebookReadinessRepairPreviews(notebookReadinessIssue),
            ...notebookDiagnosticPreviews(notebookDiagnostics)
          ],
          stateDelta: {
            releaseChecksCreated: releaseChecks.length,
            hardInvariantBlockers: hardFailures.length,
            manuscriptCompilerErrors: compilerDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
            artifactContractFailures: artifactContract.failures.length,
            releaseCriticFreshnessProblems: releaseCriticFreshness.status === "fresh" ? 0 : 1,
            notebookDiagnosticWarnings: notebookDiagnostics.warningCount,
            notebookReadinessRecorded: notebookReadinessIssue === null ? 1 : 0,
            manuscriptFinalized: 0
          },
          nextHints: notebookReadinessIssue !== null
            ? artifactContract.canFinalize
              ? ["notebook.read", "notebook.patch", "release.verify"]
              : uniqueStrings([...artifactContract.nextHints, "notebook.read", "notebook.patch", "release.verify"])
            : artifactContract.canFinalize
              ? ["workspace.read", "claim.link_support", "section.link_claim", "release.verify"]
              : artifactContract.nextHints
        })
      };
    }

    const paper = workspacePaperArtifact({
      run: input.run,
      store: input.store,
      references,
      readinessStatus: checkBundle.readinessStatus
    });
    await writeJsonArtifact(input.run.artifacts.paperJsonPath, paper);
    const markdown = renderWorkspacePaperMarkdown(paper, references);
    await writeFile(input.run.artifacts.paperPath, `${markdown}\n`, "utf8");
    const completion: ResearchWorkerCompletion = {
      kind: "manuscript_finalized",
      artifactPaths: [
        input.run.artifacts.paperPath,
        input.run.artifacts.paperJsonPath,
        input.run.artifacts.referencesPath,
        input.run.artifacts.manuscriptChecksPath
      ],
      finalizedAt: nowText
    };
    const finalizedArtifactLinks: ResearchNotebookArtifactLink[] = [
      { label: "Final paper", path: input.run.artifacts.paperPath, kind: "paper", createdAt: nowText },
      { label: "Paper JSON", path: input.run.artifacts.paperJsonPath, kind: "paper", createdAt: nowText },
      { label: "References", path: input.run.artifacts.referencesPath, kind: "references", createdAt: nowText },
      { label: "Manuscript checks", path: input.run.artifacts.manuscriptChecksPath, kind: "checks", createdAt: nowText }
    ];
    const artifactLinks = [...nextStore.notebook.artifactLinks];
    for (const artifact of finalizedArtifactLinks) {
      const index = artifactLinks.findIndex((existing) => existing.path === artifact.path);
      if (index === -1) {
        artifactLinks.push(artifact);
      } else {
        artifactLinks[index] = artifact;
      }
    }
    const completedStore = {
      ...nextStore,
      notebook: notebookAfterManuscriptFinalization({
        notebook: nextStore.notebook,
        completion,
        artifactLinks,
        now: nowText
      }),
      worker: {
        ...nextStore.worker,
        completion,
        updatedAt: nowText
      }
    };
    await writeResearchWorkStore(completedStore);
    const message = `Manuscript finalized from workspace state with ${paper.sections.length} section(s) and ${references.referenceCount} reference(s).`;
    return {
      handled: true,
      store: completedStore,
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
          notebookDiagnosticWarnings: notebookDiagnostics.warningCount,
          notebookReadinessRecorded: 1,
          manuscriptFinalized: 1
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
        nextHints: sectionReady ? ["release.verify", "manuscript.finalize"] : ["claim.link_support", "section.patch", "workspace.read"]
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
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
}): Promise<WorkspaceToolExecutionResult> {
  const notebookResult = await executeNotebookToolAction(input);
  if (notebookResult.handled) {
    return notebookResult;
  }

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
  const chosenProviderQueryFacts = state.repeatedSearchFacts.filter((fact) => (
    input.providerIds.includes(fact.providerId)
    && input.queries.length > 0
    && fact.queries.join("\u0000") === input.queries.join("\u0000")
  ));
  const reasons = [
    state.canonicalMergeCompleted
      ? "Canonical source records are already available; another source.search will refresh the source runtime view."
      : null,
    state.mergeReadiness.ready
      ? state.mergeReadiness.reason
      : null,
    chosenProviderQueryFacts.length > 0
      ? `The same provider/query set has already been attempted: ${chosenProviderQueryFacts.map((fact) => `${fact.providerId} ${fact.attempts} attempt(s), last raw ${fact.lastRawCandidates}, last new ${fact.lastNewSources}${fact.lastError === null ? "" : `, last error ${fact.lastError}`}`).join("; ")}.`
      : null,
    state.consecutiveNoProgressSearches >= 2
      ? `${state.consecutiveNoProgressSearches} consecutive source.search actions added 0 new screened sources.`
      : null
  ].filter((reason): reason is string => reason !== null);

  if (reasons.length === 0) {
    return null;
  }

  const recommended = "These are execution facts only; decide the meaning yourself and choose the next tool action.";

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
  const gathered = input.session.snapshot();
  const mergedStore = mergeRunSegmentIntoResearchWorkStore(input.workStore, {
    run: input.run,
    plan: input.plan,
    gathered,
    paperExtractions: [],
    criticReports: [],
    now: timestamp
  });
  const selectedSourceIds = gathered.reviewWorkflow.synthesisPaperIds.slice(0, 500);
  const includedPapers = mergedStore.objects.canonicalSources
    .filter((source) => source.screeningDecision === "include")
    .length;
  const nextStore = {
    ...mergedStore,
    updatedAt: timestamp,
    worker: {
      ...mergedStore.worker,
      updatedAt: timestamp,
      evidence: {
        canonicalPapers: mergedStore.objects.canonicalSources.length,
        includedPapers,
        selectedSourceIds,
        explicitlySelectedEvidencePapers: selectedSourceIds.length,
        selectedPapers: selectedSourceIds.length,
        extractedPapers: mergedStore.objects.extractions.length,
        evidenceRows: mergedStore.objects.evidenceCells.length,
        referencedPapers: new Set(mergedStore.objects.citations.map((citation) => citation.sourceId)).size
      }
    }
  };
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
    const selectionMode = safeSourceEvidenceSelectionMode(input.decision.inputs.workStore?.entity.mode);
    const observation = await input.session.selectEvidenceSet(input.decision.inputs.paperIds, selectionMode);
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

  const results: AgentToolResult[] = [];
  let lastMessage: string | null = null;
  for (const providerId of providers) {
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
  completion: ResearchWorkerCompletion;
  statusReason: string;
  paperReadiness: ManuscriptReadinessState | null;
  nextInternalActions: string[];
  userBlockers: string[];
  terminalAction: string | null;
  stepsUsed: number;
};

function sessionObservations(input: {
  sourceState: ReturnType<SourceToolRuntime["state"]>;
  workStore: ResearchWorkStore;
  step: number;
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
  const workspaceSelectedSourceIds = input.workStore.worker.evidence?.selectedSourceIds.length ?? 0;

  return {
    sourceCandidates: Math.max(input.sourceState.rawSources, input.workStore.objects.sources.length),
    canonicalSources,
    screenedInSources,
    explicitlySelectedEvidenceSources,
    resolvedAccessSources,
    sourceSessionCandidates: input.sourceState.rawSources,
    sourceSessionCanonicalSources: input.sourceState.canonicalPapers,
    sourceSessionSelectedPapers: input.sourceState.selectedPapers,
    workspaceSourceCandidates: input.workStore.objects.sources.length,
    workspaceCanonicalSources: input.workStore.objects.canonicalSources.length,
    workspaceSelectedSourceIds,
    canonicalPapers: canonicalSources,
    selectedPapers: explicitlySelectedEvidenceSources,
    extractedPapers: input.workStore.objects.extractions.length,
    evidenceRows: input.workStore.objects.evidenceCells.length,
    evidenceInsights: 0,
    manuscriptReadiness: input.workStore.worker.paperReadiness,
    sessionStepsUsed: Math.max(0, input.step - 1)
  };
}

function statusDecisionOutcome(input: {
  decision: ResearchActionDecision;
  store: ResearchWorkStore;
  toolResults: AgentToolResult[];
}): {
  terminal: boolean;
  workerStatus: ResearchWorkerStatus;
  statusReason: string;
  nextInternalActions: string[];
  userBlockers: string[];
  observationStatus: AgentToolResult["status"];
  message: string;
  nextHints: string[];
} {
  const entity = input.decision.inputs.workStore?.entity ?? {};
  const requestedStatus = stringInput(entity.status, "");
  const statusReason = stringInput(entity.statusReason ?? entity.reason, input.decision.inputs.reason ?? input.decision.rationale);
  const nextInternalActions = stringArrayInput(entity.nextInternalActions ?? entity.options ?? entity.choices, 12);
  const userBlockers = stringArrayInput(entity.userBlockers ?? entity.blockers, 12);
  const openExternalBlockers = input.store.objects.workItems
    .filter((item) => item.status === "open" && item.severity === "blocking" && (item.type === "external_blocker" || item.type === "source_access"))
    .map((item) => item.description);
  const diagnosticNextActions = checkpointDiagnosticNextActions({
    store: input.store,
    toolResults: input.toolResults
  });

  if (requestedStatus === "externally_blocked" && (openExternalBlockers.length > 0 || userBlockers.some(isExternalBlockerMessage))) {
    const blockers = openExternalBlockers.length > 0 ? openExternalBlockers : userBlockers;
    return {
      terminal: true,
      workerStatus: "externally_blocked",
      statusReason,
      nextInternalActions: [],
      userBlockers: blockers,
      observationStatus: "ok",
      message: `Validated external blocker status: ${blockers.join(" | ")}`,
      nextHints: []
    };
  }

  if (requestedStatus === "needs_user_decision" && nextInternalActions.length >= 2) {
    const combinedNextActions = uniqueStrings([
      ...nextInternalActions,
      ...diagnosticNextActions
    ]).slice(0, 12);
    return {
      terminal: true,
      workerStatus: "needs_user_decision",
      statusReason,
      nextInternalActions: combinedNextActions,
      userBlockers: userBlockers.length > 0 ? userBlockers : [statusReason],
      observationStatus: "ok",
      message: `Validated user-decision status: ${statusReason}`,
      nextHints: []
    };
  }

  const invalidTerminalRequest = requestedStatus === "externally_blocked"
    || requestedStatus === "needs_user_decision"
    || requestedStatus === "paused"
    || /\b(ready|complete|completed|done|finalized)\b/i.test(requestedStatus);
  const diagnosticActions = nextInternalActions.length > 0
    ? nextInternalActions
    : diagnosticNextActions;
  const message = invalidTerminalRequest
    ? `workspace.status did not stop the worker because "${requestedStatus}" was not validated. Continue with machine-actionable tools or provide the required structured blocker/decision data.`
    : `Workspace status noted without stopping the worker: ${statusReason}`;

  return {
    terminal: false,
    workerStatus: "working",
    statusReason: message,
    nextInternalActions: diagnosticActions,
    userBlockers: [],
    observationStatus: invalidTerminalRequest ? "not_ready" : "ok",
    message,
    nextHints: diagnosticActions.length > 0
      ? ["workspace.read", "workspace.list", "work_item.create"]
      : ["workspace.list", "source.search", "release.verify"]
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
    : ["Continue with the next machine-actionable research tool."];
}

function finalizationSucceeded(result: AgentToolResult | null | undefined): boolean {
  return result?.status !== "blocked"
    && result?.stateDelta?.manuscriptFinalized === 1
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
  const sessionSegment = 1;
  const criticAvailable = criticReviewAvailable(input.researchBackend);
  const allowedActions = workspaceResearchActions({ criticAvailable });
  await appendStdout(input.run, "Model-driven research session active; every step is selected by the researcher model from the full tool surface.");
  if (!criticAvailable) {
    await appendEvent(input.run, input.now, "summary", `Critic review unavailable: backend ${input.researchBackend.label} does not expose a critic review transport.`);
    await appendStdout(input.run, `Critic review unavailable: backend ${input.researchBackend.label} does not expose a critic review transport.`);
  }

  for (let step = 1; ; step += 1) {
    const sourceState = sourceSession.state();
    let decision: ResearchActionDecision;
    try {
      decision = await chooseResearchActionStrict({
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
          allowedActions,
          brief: input.run.brief,
          plan: input.plan,
          observations: sessionObservations({ sourceState, workStore, step }),
          sourceState: sourceStateForAgent(sourceSession),
          workStore: workStoreContextForAgent(workStore),
          guidance: guidanceContextForAgent({ brief: input.run.brief, plan: input.plan }),
          toolResults,
          criticReports: [],
          retryInstruction: [
            "This is a state-driven research session, not a phase workflow.",
            "Inspect the current workspace/source/tool observations, choose exactly one next action, and let the runtime execute only that action.",
            criticAvailable
              ? "All available production tools are available regardless of milestone; do not stop for machine-actionable source, evidence, claim, critic, section, check, or release work."
              : "All available production tools are available regardless of milestone; do not stop for machine-actionable source, evidence, claim, section, check, or release work.",
            "Use workspace.status only for a validated external blocker or real user decision that cannot be resolved with tools; otherwise continue working."
          ].join(" ")
        }
      });
    } catch (error) {
      if (error instanceof ActionSelectionProviderUnavailableCheckpoint) {
        const message = `${error.message}. The workspace has been checkpointed and /go can resume when the provider recovers.`;
        await appendEvent(input.run, input.now, "memory", message);
        await appendStdout(input.run, message);
        return {
          workStore,
          gathered: await sourceSession.result(),
          workerStatus: "working",
          completion: workStore.worker.completion,
          statusReason: message,
          paperReadiness: safeManuscriptReadiness(workStore.worker.paperReadiness),
          nextInternalActions: [
            "Retry the model-driven research session when the model provider recovers.",
            "Continue from the latest workspace/source state; do not restart source discovery unless the researcher model chooses it."
          ],
          userBlockers: [],
          terminalAction: "agent_action_provider_unavailable",
          stepsUsed: step - 1
        };
      }

      throw error;
    }

    if (isStatusAction(decision.action)) {
      const outcome = statusDecisionOutcome({ decision, store: workStore, toolResults });
      await appendEvent(input.run, input.now, "next", outcome.statusReason);
      await appendStdout(input.run, `Research status observation: ${outcome.statusReason}`);
      const result = makeAgentToolResult({
        run: input.run,
        action: decision.action,
        timestamp: input.now(),
        status: outcome.observationStatus,
        readOnly: true,
        message: outcome.message,
        stateDelta: {
          terminalStateAccepted: outcome.terminal ? 1 : 0
        },
        nextHints: outcome.nextHints
      });
      toolResults = rememberAgentToolResult(toolResults, result);
      if (outcome.terminal) {
        return {
          workStore,
          gathered: await sourceSession.result(),
          workerStatus: outcome.workerStatus,
          completion: workStore.worker.completion,
          statusReason: outcome.statusReason,
          paperReadiness: safeManuscriptReadiness(workStore.worker.paperReadiness),
          nextInternalActions: outcome.nextInternalActions,
          userBlockers: outcome.userBlockers,
          terminalAction: decision.action,
          stepsUsed: step
        };
      }
      continue;
    }

    const workspaceExecution = await executeWorkspaceToolAction({
      run: input.run,
      now: input.now,
      researchBackend: input.researchBackend,
      runtimeConfig: input.runtimeConfig,
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
      if (decision.action === "manuscript.finalize" && finalizationSucceeded(workspaceExecution.result)) {
        const result = workspaceExecution.result;
        await input.agent.record({
          actor: "runtime",
          phase: "finalization",
          action: "manuscript.finalize_result",
          status: "completed",
          summary: result?.message ?? "Manuscript finalization completed.",
          artifactPaths: [
            input.run.artifacts.paperPath,
            input.run.artifacts.paperJsonPath,
            input.run.artifacts.referencesPath,
            input.run.artifacts.manuscriptChecksPath
          ],
          counts: {
            releaseChecksCreated: result?.stateDelta?.releaseChecksCreated ?? 0,
            hardInvariantBlockers: result?.stateDelta?.hardInvariantBlockers ?? 0,
            manuscriptFinalized: result?.stateDelta?.manuscriptFinalized ?? 1
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
          workerStatus: "working",
          completion: workStore.worker.completion,
          statusReason: "Manuscript finalized after explicit model-selected manuscript.finalize action and hard invariant checks passed.",
          paperReadiness: "ready_for_revision",
          nextInternalActions: [],
          userBlockers: [],
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

function providerRetryDelayMs(attempt: number): number {
  const configured = Number.parseInt(process.env.CLAWRESEARCH_AGENT_PROVIDER_RETRY_DELAY_MS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }

  return Math.min(2_000, Math.max(100, attempt * 250));
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const minimumProviderRetryCount = 10;

function isRetryableBackendProviderFailure(error: unknown, operation?: string): boolean {
  return error instanceof ResearchBackendError
    && (operation === undefined || error.operation === operation)
    && isExternalBlockerMessage(error.message);
}

function isRetryableAgentProviderFailure(error: unknown): boolean {
  return isRetryableBackendProviderFailure(error, "agent_step");
}

async function callBackendProviderWithRetries<T>(input: {
  run: RunRecord;
  now: () => string;
  operation: string;
  label: string;
  call: () => Promise<T>;
}): Promise<T> {
  let providerFailures = 0;

  for (;;) {
    try {
      return await input.call();
    } catch (error) {
      if (!isRetryableBackendProviderFailure(error, input.operation)) {
        throw error;
      }

      providerFailures += 1;
      await appendEvent(input.run, input.now, "stderr", `${input.label} provider call failed (${providerFailures}/${minimumProviderRetryCount + 1}): ${errorMessage(error)}`);
      await appendStdout(input.run, `${input.label} provider unavailable: ${errorMessage(error)}`);

      if (providerFailures > minimumProviderRetryCount) {
        throw error;
      }

      const retryDelayMs = providerRetryDelayMs(providerFailures);
      await appendEvent(input.run, input.now, "next", `${input.label} provider unavailable; retrying (${providerFailures}/${minimumProviderRetryCount}) after ${retryDelayMs} ms.`);
      await delay(retryDelayMs);
    }
  }
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
  const maxMalformedAttempts = Math.max(1, runtimeConfig.agentInvalidActionBudget);
  const maxProviderRetries = Math.max(minimumProviderRetryCount, maxMalformedAttempts);
  const localDiagnostics: ResearchActionDiagnostic[] = [];
  let malformedAttempts = 0;
  let providerFailures = 0;
  let totalAttempts = 0;

  while (malformedAttempts < maxMalformedAttempts && providerFailures <= maxProviderRetries) {
    totalAttempts += 1;
    const modelAttempt = malformedAttempts + 1;
    const actionRequest: ResearchActionRequest = {
      ...request,
      attempt: modelAttempt,
      maxAttempts: maxMalformedAttempts,
      retryInstruction: malformedAttempts === 0
        ? request.retryInstruction
        : "Your previous response was not a valid structured action. Return exactly one allowed action with valid JSON arguments. Do not explain in prose."
    };

    try {
      await appendEvent(run, now, "next", `Ask research agent for next ${request.phase} action (${modelAttempt}/${maxMalformedAttempts}; provider retry ${providerFailures}/${maxProviderRetries}).`);
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
        attempt: totalAttempts,
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
        attempt: totalAttempts,
        kind: researchActionDiagnosticKind(error),
        message: errorMessage(error)
      };
      localDiagnostics.push(diagnostic);
      diagnostics.push(diagnostic);
      await appendEvent(run, now, "stderr", `Research agent action selection failed (${diagnostic.kind}): ${diagnostic.message}`);
      await appendStdout(run, `Research agent action selection failed: ${diagnostic.message}`);

      if (isRetryableAgentProviderFailure(error)) {
        providerFailures += 1;
        if (providerFailures <= maxProviderRetries) {
          const retryDelayMs = providerRetryDelayMs(providerFailures);
          await appendEvent(run, now, "next", `Provider unavailable during agent action selection; retrying (${providerFailures}/${maxProviderRetries}) after ${retryDelayMs} ms.`);
          await delay(retryDelayMs);
          continue;
        }

        break;
      }

      malformedAttempts += 1;
    }
  }

  const providerFailureDiagnostics = localDiagnostics.filter((diagnostic) => diagnostic.kind === "provider_failure");
  const invalidActions = localDiagnostics.filter((diagnostic) => diagnostic.kind !== "provider_failure").length;
  if (providerFailureDiagnostics.length > maxProviderRetries && invalidActions === 0) {
    await agent.record({
      phase: request.phase,
      action: "agent_action_provider_unavailable",
      status: "blocked",
      summary: `Research agent provider unavailable after ${maxProviderRetries} retry(s); checkpointing this worker segment as resumable.`,
      artifactPaths: [run.artifacts.agentStatePath],
      counts: {
        providerFailures: providerFailureDiagnostics.length,
        providerRetries: maxProviderRetries
      },
      metadata: {
        transport: "none"
      }
    });
    await appendEvent(run, now, "stderr", "Research agent provider stayed unavailable; checkpointing the worker segment as resumable instead of failing the run.");
    throw new ActionSelectionProviderUnavailableCheckpoint(request.phase, providerFailureDiagnostics);
  }

  await agent.record({
    phase: request.phase,
    action: "agent_action_selection_failed",
    status: "blocked",
    summary: `Research agent could not produce a reliable structured action after ${invalidActions} attempt(s).`,
    artifactPaths: [run.artifacts.agentStatePath],
    counts: {
      invalidActions
    },
    metadata: {
      transport: "none"
    }
  });
  await appendEvent(run, now, "stderr", "Research agent could not produce a reliable structured action; aborting this worker process instead of fabricating a terminal status.");
  throw new Error(`Research agent could not produce a reliable structured action after ${invalidActions} attempt(s).`);
}

function isExternalBlockerMessage(text: string): boolean {
  return /\b(credential|api key|quota|rate limit|paywall|permission|access denied|forbidden|unauthori[sz]ed|license|tdm|missing required|provider outage|provider unavailable|service unavailable|server unavailable|server busy|overloaded|try again later|required external resource)\b/i.test(text);
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
  await writeJsonArtifact(run.artifacts.reviewProtocolPath, pendingArtifactStatus(run, "review-protocol", createdAt));
  await writeFile(run.artifacts.reviewProtocolMarkdownPath, "# Review Protocol\n\nStatus: pending.\n", "utf8");
}

function relativeArtifactPath(projectRoot: string, targetPath: string): string {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath.length === 0 ? "." : relativePath;
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

function orderedManuscriptSections(sections: WorkStoreManuscriptSection[]): WorkStoreManuscriptSection[] {
  const hasExplicitOrder = sections.some((section) => typeof section.orderIndex === "number");
  if (!hasExplicitOrder) {
    return [...sections];
  }
  return [...sections].sort((left, right) => {
    const leftOrder = typeof left.orderIndex === "number" ? left.orderIndex : Number.POSITIVE_INFINITY;
    const rightOrder = typeof right.orderIndex === "number" ? right.orderIndex : Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
}

function modelAuthoredAbstractFromSections(sections: WorkStoreManuscriptSection[]): string {
  const abstractSection = sections.find((section) => (
    /\babstract\b/i.test(`${section.sectionId} ${section.role} ${section.title}`)
  ));
  return abstractSection?.markdown.trim() ?? "";
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
  const orderedSections = orderedManuscriptSections(input.store.objects.manuscriptSections);
  const sections = orderedSections.map((section) => ({
    id: section.id,
    role: section.role,
    orderIndex: section.orderIndex ?? null,
    title: section.title,
    markdown: section.markdown,
    sourceIds: section.sourceIds,
    claimIds: section.claimIds
  }));
  const activeCitations = input.store.objects.citations.filter(researchObjectIsActive);
  const activeEvidenceCells = input.store.objects.evidenceCells.filter(researchObjectIsActive);
  const activeExtractions = input.store.objects.extractions.filter(researchObjectIsActive);
  const citationLinks = activeCitations.map((citation) => ({
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
    ...activeExtractions.flatMap((extraction) => extraction.extraction.limitations),
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
    abstract: modelAuthoredAbstractFromSections(orderedSections),
    reviewType: "narrative_review",
    structureRationale: "This artifact is an explicit manuscript.finalize export from workspace state, not a hidden synthesis step.",
    scientificRoles: ["workspace_export"],
    sections,
    claims,
    citationLinks,
    referencedPaperIds: input.references.references.map((reference) => reference.sourceId),
    evidenceTableIds: activeEvidenceCells.map((cell) => cell.id),
    limitations,
    readinessStatus: input.readinessStatus
  };
}

function renderWorkspacePaperMarkdown(paper: ReviewPaperArtifact, references: ReferencesArtifact): string {
  const lines = [
    `# ${paper.title}`,
    ""
  ];

  for (const section of paper.sections) {
    lines.push(`## ${section.title}`, "", section.markdown, "");
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
	  const notebookDiagnostics = buildNotebookDiagnostics(input.store);
	  const readinessIssue = notebookFinalizationReadinessIssue(input.store.notebook);
	  const unsupportedClaims = claims.filter((claim) => supportReadiness.unsupportedClaimIds.has(claim.id));
  const supportIssueMessages = supportReadiness.issues.map((issue) => issue.message);
  const unsupportedSectionCount = sections.filter((section) => (
    section.claimIds.length === 0 || section.claimIds.some((claimId) => !supportReadiness.supportedClaimIds.has(claimId))
  )).length;
  const emptySectionCount = sections.filter((section) => section.markdown.trim().length === 0).length;
  const extractionRows = input.store.objects.extractions.length;
  const compilerDiagnostics = manuscriptCompilerDiagnostics(input);
  const compilerErrors = compilerDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
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
      title: "Extraction coverage diagnostic",
      status: extractionRows >= 3 ? "pass" : "warning",
      severity: "warning",
      message: extractionRows >= 3
        ? "The workspace has multiple structured extraction record(s)."
	        : `Only ${extractionRows} structured extraction record(s) are available. This is a diagnostic for the researcher, not a semantic release blocker.`
	    },
	    {
	      id: "notebook-readiness-recorded",
	      title: "Notebook readiness is model-authored",
	      status: readinessIssue === null ? "pass" : "warning",
	      severity: "warning",
	      message: readinessIssue === null
	        ? "Notebook readiness contains an explicit model-authored assessment for finalization."
	        : readinessIssue
	    },
	    {
	      id: "notebook-project-management",
	      title: "Notebook project-management diagnostics",
	      status: notebookDiagnostics.warningCount === 0 ? "pass" : "warning",
	      severity: "warning",
	      message: notebookDiagnostics.warningCount === 0
	        ? "Notebook task list, current focus, readiness, and task links are current."
	        : `${notebookDiagnostics.warningCount} notebook warning(s): ${notebookDiagnostics.warnings.map((warning) => warning.message).slice(0, 4).join(" ")}`
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
      id: "section-content",
      title: "Manuscript sections contain explicit content",
      status: sections.length > 0 && emptySectionCount === 0 ? "pass" : "fail",
      severity: "blocker",
      message: sections.length === 0
        ? "No manuscript sections exist yet."
        : emptySectionCount === 0
          ? "All manuscript sections contain explicit markdown content."
          : `${emptySectionCount} manuscript section(s) have empty markdown content.`
    },
    {
      id: "manuscript-compiler",
      title: "Manuscript markdown compiles structurally",
      status: compilerErrors.length === 0 ? "pass" : "fail",
      severity: "blocker",
      message: compilerErrors.length === 0
        ? "Manuscript sections have no compiler-level markdown/provenance errors."
        : `${compilerErrors.length} manuscript compiler error(s): ${compilerErrors.slice(0, 4).map((diagnostic) => `${diagnostic.code} in ${diagnostic.sectionId}${diagnostic.blockIndex === null ? "" : ` block ${diagnostic.blockIndex}`}: ${diagnostic.repairHint}`).join(" ")}`
    },
    {
      id: "claim-citation-support",
      title: "Claims have citation support",
      status: unsupportedClaims.length === 0 && claims.length > 0 ? "pass" : "fail",
      severity: "blocker",
      message: unsupportedClaims.length === 0 && claims.length > 0
        ? "All manuscript claims have durable evidence-backed support links."
        : claims.length === 0
          ? "No claims exist yet; the researcher should create and support claims before manuscript finalization."
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
  error: unknown,
  input: { externalBlocker?: boolean } = {}
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
	      input.externalBlocker
	        ? `Run paused on an external blocker during ${run.stage}.`
	        : `Run failed during ${run.stage}.`,
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
  const workspaceContext = buildWorkspacePromptContextFromWorkStore(workStore);
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
      summary: "Initialized run artifacts and loaded the SQLite workspace context, literature context, providers, and credentials.",
      artifactPaths: [
        run.artifacts.briefPath,
        run.artifacts.agentStatePath,
        run.artifacts.agentStepsPath
      ],
      counts: {
        workspaceObjects: Object.values(workspaceContext.counts).reduce((total, count) => total + count, 0),
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
      "summary",
      workspaceContext.available
        ? `Loaded SQLite workspace context with ${workspaceContext.counts.canonicalSources} canonical sources, ${workspaceContext.counts.evidenceCells} evidence cells, ${workspaceContext.counts.claims} claims, and ${workspaceContext.counts.openWorkItems} open work items.`
        : "No prior SQLite workspace objects were available to inform planning."
    );
    await appendEvent(
      run,
      now,
      "literature",
      literatureContext.available
        ? `Loaded ${literatureContext.paperCount} prior canonical papers, ${literatureContext.themeCount} theme boards, and ${literatureContext.notebookCount} review notebooks.`
        : "No prior literature context was available for this run."
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

    let plan = await callBackendProviderWithRetries({
      run,
      now,
      operation: "planning",
      label: "Planning",
      call: () => researchBackend.planResearch({
        projectRoot: run.projectRoot,
        brief: run.brief,
        localFiles,
        workspaceContext,
        literatureContext,
        workerState: previousWorkerState
      }, {
        operation: "planning",
        timeoutMs: runtimeLlmConfig.planningTimeoutMs
      })
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
	    workStore = await persistPlanningNotebookPatch({
	      run,
	      store: workStore,
	      plan,
	      nowText: now()
	    });
	    const planningNotebookDiagnostics = buildNotebookDiagnostics(workStore);
	    await appendEvent(
	      run,
	      now,
	      "memory",
	      plan.notebookPatch === undefined || plan.notebookPatch === null
	        ? "Planning did not include a model-authored notebook patch; notebook diagnostics will keep this visible to the researcher model."
	        : `Persisted model-authored notebook patch from planning: ${workStore.notebook.tasks.length} task(s), current focus ${workStore.notebook.currentFocus ?? "unset"}, ${planningNotebookDiagnostics.warningCount} notebook warning(s).`
	    );
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
    const workspaceCorpus = buildResearchCorpusDiagnosticView(workStore);

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
      workspaceCorpus,
      mergeDiagnostics: gathered.mergeDiagnostics,
      literatureReview: gathered.literatureReview ?? null
    });
    await appendTrace(run, now, `Model-driven research session ${sessionSegment} source tool session gathered ${gathered.sources.length} raw sources and ${gathered.canonicalPapers.length} newly merged canonical papers. Workspace corpus has ${workspaceCorpus.canonicalSourceCount} canonical source(s) and ${workspaceCorpus.selectedSourceCount} selected source(s).`);
    await appendEvent(run, now, "summary", `Model-driven research session ${sessionSegment}: source tool session observed ${gathered.canonicalPapers.length} newly merged canonical papers; workspace corpus contains ${workspaceCorpus.canonicalSourceCount} canonical source(s).`);
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
	      completion: sessionOutcome.completion,
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
        selectedSourceIds: gathered.reviewWorkflow.synthesisPaperIds.slice(0, 500),
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
	      action: sessionOutcome.completion?.kind === "manuscript_finalized" ? "manuscript_finalized" : "checkpoint_workspace_state",
      status: "completed",
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
	    run.status = "completed";
	    run.statusMessage = sessionOutcome.completion?.kind === "manuscript_finalized"
	        ? "Research manuscript finalized after explicit model-selected manuscript.finalize."
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
	    run.job.exitCode = externalBlocker ? 0 : 1;
	    run.job.signal = null;
	    run.workerPid = null;
	    run.status = externalBlocker ? "completed" : "failed";
	    run.statusMessage = externalBlocker
	      ? `Autonomous research worker hit an external blocker: ${message}`
	      : `Run worker failed: ${message}`;
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
	    await writeFailureDiagnostics(run, finishedAt, error, { externalBlocker });
	    if (externalBlocker) {
	      await appendStdout(run, run.statusMessage);
	    } else {
	      await appendStderr(run, run.statusMessage);
	    }
	    await appendTrace(run, now, run.statusMessage);
	    if (!externalBlocker) {
	      await appendEvent(run, now, "stderr", run.statusMessage);
	    }
	    await appendEvent(run, now, "run", run.statusMessage);
	    return externalBlocker ? 0 : 1;
	  }
}
