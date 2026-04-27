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
  agendaHasActionableWorkPackage,
  autoRunnableMode,
  isWorkPackageAutoContinuable,
  workPackageAutoContinueBlockers,
  type ExecutionChecklist,
  type ExecutionChecklistItem,
  type MethodPlan,
  type WorkPackageDecisionRecord,
  type WorkPackageFinding
} from "./research-agenda.js";
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
  ResearchDirectionCandidate,
  WorkPackage
} from "./research-backend.js";
import {
  modelUnsuitableActionDecision,
  type ResearchActionDecision,
  type ResearchActionDiagnostic,
  type ResearchActionRequest
} from "./research-agent.js";
import {
  createDefaultResearchBackend,
  ResearchBackendError,
  type ResearchBackendOperation
} from "./research-backend.js";
import {
  buildEvidenceMatrix,
  briefFingerprint,
  evidenceMatrixNextQuestions,
  type EvidenceMatrix,
  type EvidenceMatrixInsight,
  type PaperExtraction
} from "./research-evidence.js";
import {
  applyCriticReportsToManuscriptBundle,
  buildManuscriptBundle,
  buildReviewProtocol,
  reviewProtocolMarkdown,
  type ManuscriptBundle
} from "./research-manuscript.js";
import {
  criticRevisionTexts,
  criticReviewNeedsRevision,
  criticReviewPassed,
  criticUnavailableReview,
  type CriticReviewArtifact,
  type CriticReviewRequest,
  type CriticReviewStage
} from "./research-critic.js";
import {
  collectResearchLocalFileHints,
  createDefaultResearchSourceGatherer,
  type ResearchSource,
  type ResearchSourceGatherer,
  type ResearchSourceGatherResult
} from "./research-sources.js";
import {
  createDefaultRunController,
  type RunController
} from "./run-controller.js";
import { appendRunEvent, type RunEventKind } from "./run-events.js";
import {
  createResearchDirectionState,
  researchDirectionPath,
  RunStore,
  type RunRecord
} from "./run-store.js";
import type { ResearchBrief } from "./session-store.js";
import {
  verifyResearchClaims,
  type VerificationReport,
  type VerifiedClaim
} from "./verifier.js";
import {
  isRetrievalQualityConstraintPhrase,
  isSubstantiveReviewFacet
} from "./literature-review.js";

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
};

type SynthesisAttempt = {
  attempt: number;
  clusterId: string;
  paperIds: string[];
  clusterSize: number;
  status: "succeeded" | "failed" | "fallback";
  errorKind: string | null;
  errorMessage: string | null;
  timeoutMs: number;
};

type SynthesisCheckpointArtifact = {
  schemaVersion: number;
  runId: string;
  briefFingerprint: string;
  status: "pending" | "in_progress" | "completed" | "completed_with_fallback";
  strategy: "clustered";
  clusterSize: number;
  clusterCount: number;
  completedClusterIds: string[];
  failedClusterIds: string[];
  attempts: SynthesisAttempt[];
  synthesis: ResearchSynthesis | null;
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
      counts: input.counts ?? {}
    };
    const state: AgentStateArtifact = {
      schemaVersion: 1,
      runId: this.run.id,
      status: input.status === "blocked" ? "blocked" : input.status === "completed" ? "completed" : "running",
      currentPhase: input.phase,
      lastAction: input.action,
      lastStatus: input.status,
      completedSteps: this.completedSteps,
      updatedAt: timestamp
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
    updatedAt: timestamp
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

function compactRecoveryQuery(text: string | null | undefined, limit = 12): string | null {
  if (typeof text !== "string") {
    return null;
  }
  if (isFileLikeResearchTerm(text)) {
    return null;
  }

  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
  const filtered = tokens
    .filter((token) => token.length > 1)
    .filter((token) => !recoveryQueryStopWords.has(token));

  const compact = filtered.length > 0 ? filtered.slice(0, limit).join(" ") : null;
  return compact !== null && !isRetrievalQualityConstraintPhrase(compact) ? compact : null;
}

function recoveryQueryAnchor(run: RunRecord, plan: ResearchPlan): string {
  return compactRecoveryQuery(run.brief.topic, 6)
    ?? compactRecoveryQuery(run.brief.researchQuestion, 6)
    ?? compactRecoveryQuery(plan.objective, 6)
    ?? "literature";
}

function facetRecoveryQueries(
  run: RunRecord,
  plan: ResearchPlan,
  gathered: ResearchSourceGatherResult
): { queries: string[]; focusTerms: string[] } {
  const anchor = recoveryQueryAnchor(run, plan);
  const missingFacets = [
    ...(gathered.selectionQuality?.missingRequiredFacets ?? []),
    ...(gathered.selectionQuality?.backgroundOnlyFacets ?? [])
  ].filter((facet) => isSubstantiveReviewFacet(facet));
  const focusTerms = uniqueStrings(missingFacets.flatMap((facet) => [
    facet.label,
    ...facet.terms
  ])).filter((term) => !isRetrievalQualityConstraintPhrase(term));
  const queries = focusTerms.flatMap((term) => {
    const compact = compactRecoveryQuery(term, 6);
    return compact === null ? [] : [`${anchor} ${compact}`];
  });

  return {
    queries,
    focusTerms
  };
}

function buildEvidenceRecoveryQueries(input: {
  run: RunRecord;
  plan: ResearchPlan;
  gathered: ResearchSourceGatherResult;
  synthesis?: ResearchSynthesis | null;
  agenda?: ResearchAgenda | null;
  verification?: VerificationReport | null;
  criticReports?: CriticReviewArtifact[];
  extraQuestions?: string[];
}): { queries: string[]; focusTerms: string[] } {
  const anchor = recoveryQueryAnchor(input.run, input.plan);
  const facetQueries = facetRecoveryQueries(input.run, input.plan, input.gathered);
  const diagnosticQueries = input.gathered.retrievalDiagnostics?.suggestedNextQueries ?? [];
  const questionQueries = [
    ...(input.synthesis?.nextQuestions ?? []),
    ...(input.agenda?.holdReasons ?? []),
    ...(input.verification?.unknowns ?? []),
    ...(input.verification?.unverifiedClaims.map((claim) => claim.reason) ?? []),
    ...criticRevisionTexts(input.criticReports ?? []),
    ...(input.extraQuestions ?? [])
  ].flatMap((question) => {
    const compact = compactRecoveryQuery(question, 8);
    return compact === null ? [] : [`${anchor} ${compact}`];
  });
  const thinSetQueries = input.gathered.reviewedPapers.length < 8
    || input.gathered.selectionQuality?.adequacy !== "strong"
    ? [
      `${anchor} systematic review`,
      `${anchor} survey`,
      `${anchor} empirical evaluation`,
      `${anchor} limitations`
    ]
    : [];

  return {
    queries: uniqueStrings([
      ...facetQueries.queries,
      ...diagnosticQueries,
      ...questionQueries,
      ...criticRevisionTexts(input.criticReports ?? []),
      ...thinSetQueries
    ]).slice(0, 16),
    focusTerms: uniqueStrings([
      ...facetQueries.focusTerms,
      ...(input.criticReports ?? []).flatMap((report) => report.revisionAdvice.evidenceTargets)
    ])
  };
}

function buildProtocolCriticRecoveryQueries(input: {
  run: RunRecord;
  plan: ResearchPlan;
  criticReport: CriticReviewArtifact;
}): { queries: string[]; focusTerms: string[] } {
  return {
    queries: uniqueStrings(input.criticReport.revisionAdvice.searchQueries).slice(0, 12),
    focusTerms: uniqueStrings(input.criticReport.revisionAdvice.evidenceTargets)
      .filter((term) => !isFileLikeResearchTerm(term))
  };
}

function protocolRecoveryPlanUpdate(
  plan: ResearchPlan,
  queries: string[],
  focusTerms: string[]
): { plan: ResearchPlan; recoveryQueries: string[] } | null {
  const cleanExistingQueries = plan.searchQueries.filter((query) => compactRecoveryQuery(query, 12) !== null);
  const existingQueryKeys = new Set(cleanExistingQueries.map(normalizedRecoveryQueryKey));
  const recoveryQueries = uniqueStrings(queries)
    .filter((query) => compactRecoveryQuery(query, 12) !== null)
    .filter((query) => !existingQueryKeys.has(normalizedRecoveryQueryKey(query)))
    .slice(0, 8);

  if (recoveryQueries.length === 0) {
    return null;
  }

  const rationaleSuffix = "Autonomous protocol revision refined retrieval scope before source gathering.";

  return {
    recoveryQueries,
    plan: {
      ...plan,
      rationale: plan.rationale.includes(rationaleSuffix)
        ? plan.rationale
        : `${plan.rationale} ${rationaleSuffix}`,
      searchQueries: uniqueStrings([...cleanExistingQueries, ...recoveryQueries]).slice(0, 16),
      localFocus: uniqueStrings([...plan.localFocus, ...focusTerms])
        .filter((focus) => compactRecoveryQuery(focus, 8) !== null)
        .slice(0, 16)
    }
  };
}

function evidenceRecoveryPlanUpdate(
  plan: ResearchPlan,
  queries: string[],
  focusTerms: string[]
): { plan: ResearchPlan; recoveryQueries: string[] } | null {
  const existingQueryKeys = new Set(plan.searchQueries.map(normalizedRecoveryQueryKey));
  const recoveryQueries = uniqueStrings(queries)
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
}): Promise<ResearchActionDecision> {
  const {
    run,
    now,
    researchBackend,
    runtimeConfig,
    agent,
    request,
    diagnostics
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
      await agent.record({
        phase: request.phase,
        action: decision.action,
        status: "completed",
        summary: decision.rationale,
        artifactPaths: [run.artifacts.agentStatePath],
        counts: {
          confidencePercent: Math.round(decision.confidence * 100),
          searchQueries: decision.inputs.searchQueries.length,
          evidenceTargets: decision.inputs.evidenceTargets.length
        }
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
  await agent.record({
    phase: request.phase,
    action: fallback.action,
    status: "warning",
    summary: fallback.rationale,
    artifactPaths: [run.artifacts.agentStatePath],
    counts: {
      invalidActions: diagnostics.filter((diagnostic) => diagnostic.phase === request.phase).length
    }
  });
  await appendEvent(run, now, "next", "Research agent could not produce a reliable structured action; finalizing status-only diagnostics.");
  return fallback;
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
  missingTargetCount: number;
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
  const missingTargetCount = gathered.selectionQuality?.missingRequiredFacets.length ?? 0;
  const selectedCount = gathered.reviewedPapers.length;

  return {
    inScopeIds,
    inScopeCount,
    borderlineCount,
    excludedCount,
    missingTargetCount,
    selectedCount,
    score: inScopeCount * 20 + selectedCount * 5 - missingTargetCount * 12 - borderlineCount * 3 - excludedCount
  };
}

function evidenceQualityImproved(previous: EvidenceQualitySnapshot | null, next: EvidenceQualitySnapshot): boolean {
  if (previous === null) {
    return true;
  }

  return [...next.inScopeIds].some((paperId) => !previous.inScopeIds.has(paperId))
    || next.missingTargetCount < previous.missingTargetCount
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
  agentControlMode?: RuntimeLlmConfig["agentControlMode"];
  autonomousRevisionPasses: number;
  revisionBudgetPasses: number;
}): Record<string, unknown> {
  const criticIterations = finalCriticIterationSummaries(input.criticReportsByStage);
  const actionDiagnostics = input.agentActionDiagnostics ?? [];
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
  await mkdir(run.artifacts.synthesisClusterDirectory, { recursive: true });
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
  await writeJsonArtifact(run.artifacts.evidenceMatrixPath, pendingArtifactStatus(run, "evidence-matrix", createdAt));
  await writeFile(run.artifacts.synthesisPath, "# Research Synthesis\n\nStatus: pending.\n", "utf8");
  await writeJsonArtifact(run.artifacts.synthesisJsonPath, pendingArtifactStatus(run, "synthesis", createdAt));
  await writeJsonArtifact(run.artifacts.claimsPath, pendingArtifactStatus(run, "claims", createdAt));
  await writeJsonArtifact(run.artifacts.verificationPath, pendingArtifactStatus(run, "verification", createdAt));
  await writeJsonArtifact(run.artifacts.paperOutlinePath, pendingArtifactStatus(run, "paper-outline", createdAt));
  await writeFile(run.artifacts.paperPath, "# Review Paper\n\nStatus: pending.\n", "utf8");
  await writeJsonArtifact(run.artifacts.paperJsonPath, pendingArtifactStatus(run, "paper", createdAt));
  await writeJsonArtifact(run.artifacts.referencesPath, pendingArtifactStatus(run, "references", createdAt));
  await writeJsonArtifact(run.artifacts.manuscriptChecksPath, pendingArtifactStatus(run, "manuscript-checks", createdAt));
  await writeJsonArtifact(run.artifacts.qualityReportPath, pendingArtifactStatus(run, "quality-report", createdAt));
  await writeJsonArtifact(run.artifacts.nextQuestionsPath, pendingArtifactStatus(run, "next-questions", createdAt));
  await writeJsonArtifact(run.artifacts.agendaPath, pendingArtifactStatus(run, "agenda", createdAt));
  await writeFile(run.artifacts.agendaMarkdownPath, "# Research Agenda\n\nStatus: pending.\n", "utf8");
  await writeJsonArtifact(run.artifacts.workPackagePath, pendingArtifactStatus(run, "work-package", createdAt));
  if (run.stage === "work_package") {
    await writeJsonArtifact(run.artifacts.methodPlanPath, pendingArtifactStatus(run, "method-plan", createdAt));
    await writeJsonArtifact(run.artifacts.executionChecklistPath, pendingArtifactStatus(run, "execution-checklist", createdAt));
    await writeJsonArtifact(run.artifacts.findingsPath, pendingArtifactStatus(run, "findings", createdAt));
    await writeJsonArtifact(run.artifacts.decisionPath, pendingArtifactStatus(run, "decision", createdAt));
  }
  await writeFile(run.artifacts.summaryPath, "", "utf8");
  await writeJsonArtifact(run.artifacts.memoryPath, pendingArtifactStatus(run, "research-journal", createdAt));
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

function createWorkPackageRunCommand(workPackage: WorkPackage): string[] {
  return [
    "clawresearch",
    "research-loop",
    "--mode",
    "work-package",
    "--work-package-id",
    workPackage.id
  ];
}

async function readJsonArtifactOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const contents = await readFile(filePath, "utf8");
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

function selectedDirection(
  agenda: ResearchAgenda
): ResearchDirectionCandidate | null {
  if (agenda.selectedDirectionId === null) {
    return null;
  }

  return agenda.candidateDirections.find((direction) => direction.id === agenda.selectedDirectionId) ?? null;
}

function agendaMarkdown(
  run: RunRecord,
  plan: ResearchPlan,
  agenda: ResearchAgenda
): string {
  const direction = selectedDirection(agenda);
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

  lines.push("", "## Selected Work Package", "");

  if (agenda.selectedWorkPackage === null || direction === null) {
    lines.push("- No executable work package was selected yet.");
  } else {
    lines.push(`- Direction: ${direction.title}`);
    lines.push(`- Title: ${agenda.selectedWorkPackage.title}`);
    lines.push(`- Objective: ${agenda.selectedWorkPackage.objective}`);
    lines.push(`- Hypothesis / question: ${agenda.selectedWorkPackage.hypothesisOrQuestion}`);
    lines.push(`- Method sketch: ${agenda.selectedWorkPackage.methodSketch}`);
    lines.push(`- Baselines: ${agenda.selectedWorkPackage.baselines.join(" | ") || "<none>"}`);
    lines.push(`- Controls: ${agenda.selectedWorkPackage.controls.join(" | ") || "<none>"}`);
    lines.push(`- Decisive experiment: ${agenda.selectedWorkPackage.decisiveExperiment}`);
    lines.push(`- Stop criterion: ${agenda.selectedWorkPackage.stopCriterion}`);
    lines.push(`- Expected artifact: ${agenda.selectedWorkPackage.expectedArtifact}`);
    lines.push(`- Required inputs: ${agenda.selectedWorkPackage.requiredInputs.join(" | ") || "<none>"}`);
    lines.push(`- Blocked by: ${agenda.selectedWorkPackage.blockedBy.join(" | ") || "<none>"}`);
  }

  if (agenda.holdReasons.length > 0) {
    lines.push("", "## Hold Reasons", "");
    for (const reason of agenda.holdReasons) {
      lines.push(`- ${reason}`);
    }
  }

  lines.push("", "## Recommended Human Decision", "", agenda.recommendedHumanDecision);
  return lines.join("\n");
}

function workPackageDirectionRecordId(direction: ResearchDirectionCandidate): string {
  return createMemoryRecordId("direction", `${direction.mode}:${direction.title}`);
}

function workPackageHypothesisRecordId(workPackage: WorkPackage): string {
  return createMemoryRecordId("hypothesis", `${workPackage.title}:${workPackage.hypothesisOrQuestion}`);
}

function workPackageMethodPlanRecordId(runId: string, title: string): string {
  return createMemoryRecordId("method_plan", `run:${runId}:${title}`);
}

function deriveMethodPlan(
  workPackage: WorkPackage,
  brief: ResearchBrief
): MethodPlan {
  const baselines = workPackage.baselines.length > 0
    ? workPackage.baselines
    : ["Establish the strongest comparable prior approach from the reviewed literature."];
  const controls = workPackage.controls.length > 0
    ? workPackage.controls
    : ["Hold evaluation conditions constant while isolating the claimed intervention."];
  const ablations = workPackage.mode === "ablation"
    ? ["Disable or remove one major component at a time and compare against the intact baseline."]
    : workPackage.mode === "method_improvement"
      ? ["Compare the improved method against the unchanged baseline and one minimal variant."]
      : ["No dedicated ablation is required for the first bounded pass unless a confounder emerges."];

  return {
    assumptions: [
      `The work package remains scoped to ${brief.topic ?? "the current topic"}.`,
      ...workPackage.requiredInputs.map((input) => `Input available: ${input}`),
      workPackage.blockedBy.length > 0
        ? `Potential blocker: ${workPackage.blockedBy.join(" | ")}`
        : "No explicit blocker was declared in the selected work package."
    ],
    evaluationDesign: `${workPackage.decisiveExperiment} Success is bounded by: ${workPackage.stopCriterion}`,
    baselines,
    controls,
    ablations,
    decisiveChecks: [
      workPackage.decisiveExperiment,
      `Produce the expected artifact: ${workPackage.expectedArtifact}`,
      `Stop when this criterion is satisfied or clearly unreachable: ${workPackage.stopCriterion}`
    ]
  };
}

function comparableText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchingLocalFiles(localFiles: string[], requirement: string): string[] {
  const tokens = comparableText(requirement)
    .split(" ")
    .filter((token) => token.length >= 4);

  if (tokens.length === 0) {
    return [];
  }

  return localFiles.filter((filePath) => {
    const comparablePath = comparableText(filePath);
    return tokens.some((token) => comparablePath.includes(token));
  });
}

function deriveExecutionChecklist(
  run: RunRecord,
  workPackage: WorkPackage,
  methodPlan: MethodPlan,
  localFiles: string[]
): ExecutionChecklist {
  const requirementSummary = workPackage.requiredInputs.length === 0
    ? "No explicit required inputs were listed."
    : workPackage.requiredInputs.map((input) => {
      const matches = matchingLocalFiles(localFiles, input);
      return `${input}: ${matches.length > 0 ? `candidate files ${matches.slice(0, 3).join(", ")}` : "not yet found in local context"}`;
    }).join(" | ");
  const items: ExecutionChecklistItem[] = [
    {
      id: "inspect-context",
      title: "Inspect local project context",
      kind: "inspection",
      intent: "Confirm what code, data, notes, and scripts are already available in the current project root.",
      expectedOutput: `${localFiles.length} candidate local files or directories, with a shortlist of likely relevant paths.`,
      failureInterpretation: "If almost no project context exists, the work package may need to stay at planning level first.",
      status: "completed",
      notes: localFiles.slice(0, 8).join(" | ") || "No local files were discovered."
    },
    {
      id: "check-inputs",
      title: "Check required inputs",
      kind: "inspection",
      intent: "Verify whether the work package's required inputs appear to exist in the project context.",
      expectedOutput: requirementSummary,
      failureInterpretation: "Missing inputs mean the package should be revised or blocked rather than executed blindly.",
      status: "completed",
      notes: requirementSummary
    },
    {
      id: "baseline-plan",
      title: "Restate baselines and controls",
      kind: "inspection",
      intent: "Make the comparison frame explicit before continuing into implementation or experimentation.",
      expectedOutput: `Baselines: ${methodPlan.baselines.join(" | ")} | Controls: ${methodPlan.controls.join(" | ")}`,
      failureInterpretation: "If baselines or controls remain ambiguous, the work package is not ready for automatic continuation.",
      status: "completed"
    },
    {
      id: "decisive-check",
      title: "Prepare the decisive check",
      kind: "inspection",
      intent: "Restate the specific decisive experiment or bounded check that will validate or reject the package direction.",
      expectedOutput: workPackage.decisiveExperiment,
      failureInterpretation: "If the decisive check is vague, the package should return to agenda refinement.",
      status: "completed"
    },
    {
      id: "record-next-step",
      title: "Record the next executable step",
      kind: "inspection",
      intent: "Name the concrete next step that should happen after this bounded planning pass.",
      expectedOutput: `Proceed toward: ${workPackage.expectedArtifact}`,
      failureInterpretation: "If no concrete next step is visible, stop at planning rather than pretending execution happened.",
      status: "completed",
      notes: `Run ${run.id} stayed bounded at planning/inspection level.`
    }
  ];

  return {
    items
  };
}

function deriveWorkPackageFindings(
  workPackage: WorkPackage,
  localFiles: string[],
  checklist: ExecutionChecklist
): WorkPackageFinding[] {
  const missingInputs = workPackage.requiredInputs.filter((input) => matchingLocalFiles(localFiles, input).length === 0);

  return [
    {
      id: "finding-context",
      title: "Local context inspection",
      summary: localFiles.length > 0
        ? `The project root already contains ${localFiles.length} locally discoverable paths that can guide the next step.`
        : "The project root currently exposes very little local context for this work package.",
      evidence: localFiles.slice(0, 8),
      status: localFiles.length > 0 ? "observed" : "missing"
    },
    {
      id: "finding-inputs",
      title: "Required input availability",
      summary: missingInputs.length === 0
        ? "All explicitly listed required inputs have at least one plausible local match."
        : `Some required inputs are still missing or ambiguous: ${missingInputs.join(" | ")}`,
      evidence: checklist.items
        .filter((item) => item.id === "check-inputs")
        .flatMap((item) => item.notes === undefined ? [] : [item.notes]),
      status: missingInputs.length === 0 ? "observed" : "blocked"
    },
    {
      id: "finding-eval",
      title: "Evaluation frame",
      summary: `The decisive check is currently framed as: ${workPackage.decisiveExperiment}`,
      evidence: [
        `Expected artifact: ${workPackage.expectedArtifact}`,
        `Stop criterion: ${workPackage.stopCriterion}`
      ],
      status: "observed"
    }
  ];
}

function decideWorkPackageOutcome(
  agenda: ResearchAgenda,
  workPackage: WorkPackage,
  localFiles: string[],
  findings: WorkPackageFinding[]
): WorkPackageDecisionRecord {
  const blockedBy = [
    ...workPackage.blockedBy,
    ...findings
      .filter((finding) => finding.status === "blocked")
      .map((finding) => finding.summary)
  ];

  if (!autoRunnableMode(workPackage)) {
    return {
      outcome: "return_to_agenda",
      rationale: "The selected work package is valuable, but its mode is not in the bounded auto-runnable set for this phase.",
      nextActions: [
        "Review the agenda and either confirm a bounded empirical direction or keep the current package human-guided."
      ],
      blockedBy,
      status: "returned"
    };
  }

  if (blockedBy.length > 0) {
    return {
      outcome: "revise",
      rationale: "The work package is promising but still blocked by missing inputs or explicit blockers.",
      nextActions: [
        "Resolve or replace the blocked inputs before attempting a broader execution loop.",
        "If the blocker is fundamental, return to agenda generation and pick a more actionable direction."
      ],
      blockedBy,
      status: "blocked"
    };
  }

  if (localFiles.length === 0) {
    return {
      outcome: "return_to_agenda",
      rationale: "No meaningful local project context was available, so the package should stay at agenda level.",
      nextActions: [
        "Add or identify the relevant local implementation, data, or notes before continuing.",
        "Alternatively, reframe the work package as pure literature synthesis."
      ],
      blockedBy: ["No relevant local project context was detected."],
      status: "returned"
    };
  }

  return {
    outcome: "continue",
    rationale: "The work package has a bounded scope, an operational artifact, and enough local context for the next step.",
    nextActions: [
      `Use the method plan to work toward the expected artifact: ${workPackage.expectedArtifact}.`,
      `Evaluate progress using the decisive check: ${workPackage.decisiveExperiment}.`
    ],
    blockedBy: [],
    status: "active"
  };
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
      key: `run:${run.id}:retrieval-recovery`,
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
      path: run.artifacts.evidenceMatrixPath,
      title: "Evidence matrix artifact",
      text: `Saved the structured evidence matrix for ${run.id}.`,
      linkIds: sourceIds
    },
    {
      path: run.artifacts.synthesisPath,
      title: "Synthesis artifact",
      text: `Saved synthesis output for ${run.id}.`,
      linkIds: [
        summaryId,
        ...findingIds,
        ...claimIds,
        ...questionIds
      ]
    },
    {
      path: run.artifacts.claimsPath,
      title: "Claims artifact",
      text: `Saved recorded claims for ${run.id}.`,
      linkIds: claimIds
    },
    {
      path: run.artifacts.verificationPath,
      title: "Verification artifact",
      text: `Saved verification report for ${run.id}.`,
      linkIds: claimIds.length > 0 ? claimIds : [summaryId]
    },
    {
      path: run.artifacts.paperOutlinePath,
      title: "Paper outline artifact",
      text: `Saved the structured review-paper outline for ${run.id}.`,
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
      path: run.artifacts.referencesPath,
      title: "References artifact",
      text: `Saved canonical bibliography records for ${run.id}.`,
      linkIds: sourceIds
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
      path: run.artifacts.workPackagePath,
      title: "Selected work package artifact",
      text: `Saved the selected work package for ${run.id}.`,
      linkIds: ideaIds.length > 0 ? ideaIds : [summaryId]
    },
    {
      path: run.artifacts.summaryPath,
      title: "Run summary artifact",
      text: `Saved run summary for ${run.id}.`,
      linkIds: [summaryId]
    },
    {
      path: run.artifacts.memoryPath,
      title: "Research journal snapshot artifact",
      text: `Saved structured research journal snapshot for ${run.id}.`,
      linkIds: [summaryId]
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
      evidenceNotes: ["No structured extraction was recovered for this reviewed paper; the record remains intentionally sparse."]
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
        `Extraction recovery budget exhausted before all selected papers were extracted (${cursor}/${papers.length} batches complete).`,
        "extraction",
        attempts
      );
    }

    if (Date.now() - startedAt > runtimeConfig.totalRecoveryBudgetMs) {
      const failedPaperIds = papers.slice(cursor).map((paper) => paper.id);
      await writeExtractionCheckpoint(run, papers, extractions, attempts, "failed", failedPaperIds);
      throw new ResearchStageBlockedError(
        `Extraction recovery time budget exhausted before all selected papers were extracted (${cursor}/${papers.length} papers complete).`,
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
          `Recovering extraction by shrinking the next batch size to ${batchSize}.`
        );
        continue;
      }

      if (!compact) {
        await appendEvent(run, now, "next", "Recovering extraction with a compact single-paper prompt.");
        continue;
      }

      await writeExtractionCheckpoint(run, papers, extractions, attempts, "failed", batch.map((paper) => paper.id));
      throw new ResearchStageBlockedError(
        `Extraction could not recover for selected paper ${batch[0]?.id ?? "<unknown>"}: ${message}`,
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

function chunkPapers(papers: CanonicalPaper[], chunkSize: number): CanonicalPaper[][] {
  const chunks: CanonicalPaper[][] = [];

  for (let index = 0; index < papers.length; index += chunkSize) {
    chunks.push(papers.slice(index, index + chunkSize));
  }

  return chunks;
}

function evidenceMatrixForPaperIds(evidenceMatrix: EvidenceMatrix, paperIds: Set<string>): EvidenceMatrix {
  const rows = evidenceMatrix.rows.filter((row) => paperIds.has(row.paperId));

  return {
    ...evidenceMatrix,
    rowCount: rows.length,
    rows,
    derivedInsights: evidenceMatrix.derivedInsights
      .map((insight) => ({
        ...insight,
        paperIds: insight.paperIds.filter((paperId) => paperIds.has(paperId))
      }))
      .filter((insight) => insight.paperIds.length > 0)
  };
}

function synthesisCheckpointArtifact(input: {
  run: RunRecord;
  status: SynthesisCheckpointArtifact["status"];
  clusterSize: number;
  clusterCount: number;
  completedClusterIds: string[];
  failedClusterIds: string[];
  attempts: SynthesisAttempt[];
  synthesis: ResearchSynthesis | null;
}): SynthesisCheckpointArtifact {
  return {
    schemaVersion: 1,
    runId: input.run.id,
    briefFingerprint: briefFingerprint(input.run.brief),
    status: input.status,
    strategy: "clustered",
    clusterSize: input.clusterSize,
    clusterCount: input.clusterCount,
    completedClusterIds: input.completedClusterIds,
    failedClusterIds: input.failedClusterIds,
    attempts: input.attempts,
    synthesis: input.synthesis
  };
}

async function writeSynthesisCheckpoint(input: {
  run: RunRecord;
  status: SynthesisCheckpointArtifact["status"];
  clusterSize: number;
  clusterCount: number;
  completedClusterIds: string[];
  failedClusterIds: string[];
  attempts: SynthesisAttempt[];
  synthesis: ResearchSynthesis | null;
}): Promise<void> {
  await writeJsonArtifact(input.run.artifacts.synthesisJsonPath, synthesisCheckpointArtifact(input));
}

function synthesisClusterPath(run: RunRecord, clusterId: string): string {
  return path.join(run.artifacts.synthesisClusterDirectory, `${clusterId}.json`);
}

function fallbackSynthesisForCluster(input: {
  clusterId: string;
  papers: CanonicalPaper[];
  paperExtractions: PaperExtraction[];
  evidenceMatrix: EvidenceMatrix;
  reason: string;
}): ResearchSynthesis {
  const sourceIds = input.papers.map((paper) => paper.id);
  const extractedSignals = input.paperExtractions
    .flatMap((extraction) => extraction.successSignals)
    .filter((signal) => signal.trim().length > 0)
    .slice(0, 6);
  const extractedLimitations = input.paperExtractions
    .flatMap((extraction) => extraction.limitations)
    .filter((limitation) => limitation.trim().length > 0)
    .slice(0, 6);
  const nextQuestions = evidenceMatrixNextQuestions(input.evidenceMatrix);

  return {
    executiveSummary: `Synthesis cluster ${input.clusterId} could not be completed by the model: ${input.reason}. The run retained extraction-grounded status information instead of inventing cross-paper claims.`,
    themes: input.evidenceMatrix.derivedInsights.slice(0, 4).map((insight) => themeFromInsight(insight)),
    claims: [],
    nextQuestions: uniqueStrings([
      ...nextQuestions,
      ...extractedSignals.map((signal) => `Which reviewed evidence best supports this recurring signal: ${signal}?`),
      ...extractedLimitations.map((limitation) => `How should the manuscript qualify evidence limited by: ${limitation}?`)
    ]).slice(0, 6)
  };
}

function mergeClusterSyntheses(input: {
  run: RunRecord;
  papers: CanonicalPaper[];
  syntheses: ResearchSynthesis[];
  usedFallback: boolean;
}): ResearchSynthesis {
  const themeByTitle = new Map<string, ResearchTheme>();
  const claimByText = new Map<string, ResearchClaim>();
  const nextQuestions: string[] = [];

  for (const synthesis of input.syntheses) {
    for (const theme of synthesis.themes) {
      const key = theme.title.toLowerCase();
      const existing = themeByTitle.get(key);
      if (existing === undefined) {
        themeByTitle.set(key, {
          ...theme,
          sourceIds: uniqueStrings(theme.sourceIds)
        });
      } else {
        themeByTitle.set(key, {
          ...existing,
          summary: uniqueStrings([existing.summary, theme.summary]).join(" "),
          sourceIds: uniqueStrings([...existing.sourceIds, ...theme.sourceIds])
        });
      }
    }

    for (const claim of synthesis.claims) {
      const key = claim.claim.toLowerCase();
      const existing = claimByText.get(key);
      if (existing === undefined) {
        claimByText.set(key, {
          ...claim,
          sourceIds: uniqueStrings(claim.sourceIds)
        });
      } else {
        claimByText.set(key, {
          ...existing,
          evidence: uniqueStrings([existing.evidence, claim.evidence]).join(" "),
          sourceIds: uniqueStrings([...existing.sourceIds, ...claim.sourceIds])
        });
      }
    }

    nextQuestions.push(...synthesis.nextQuestions);
  }

  const fallbackClause = input.usedFallback
    ? " Some synthesis clusters used extraction-grounded fallback summaries because the model could not complete those subtasks."
    : "";

  return {
    executiveSummary: [
      `Clustered synthesis covered ${input.papers.length} reviewed papers across ${input.syntheses.length} synthesis work units.`,
      ...input.syntheses.map((synthesis) => synthesis.executiveSummary).slice(0, 4),
      fallbackClause
    ].filter((part) => part.trim().length > 0).join(" "),
    themes: [...themeByTitle.values()].slice(0, 12),
    claims: [...claimByText.values()].slice(0, 16),
    nextQuestions: uniqueStrings(nextQuestions).slice(0, 10)
  };
}

async function synthesizeResearchAdaptively(options: {
  run: RunRecord;
  now: () => string;
  researchBackend: ResearchBackend;
  runtimeConfig: RuntimeLlmConfig;
  agent: AgentStepRecorder;
  plan: ResearchPlan;
  papers: CanonicalPaper[];
  paperExtractions: PaperExtraction[];
  evidenceMatrix: EvidenceMatrix;
  selectionQuality: ResearchSourceGatherResult["selectionQuality"];
  literatureContext: Parameters<ResearchBackend["synthesizeResearch"]>[0]["literatureContext"];
}): Promise<{
  synthesis: ResearchSynthesis;
  attempts: SynthesisAttempt[];
  usedFallback: boolean;
}> {
  const {
    run,
    now,
    researchBackend,
    runtimeConfig,
    agent,
    plan,
    papers,
    paperExtractions,
    evidenceMatrix,
    selectionQuality,
    literatureContext
  } = options;
  const initialClusterSize = Math.max(
    runtimeConfig.synthesisMinClusterSize,
    Math.min(runtimeConfig.synthesisInitialClusterSize, Math.max(1, papers.length))
  );
  const minClusterSize = Math.max(1, runtimeConfig.synthesisMinClusterSize);
  const attempts: SynthesisAttempt[] = [];
  const completedClusterIds: string[] = [];
  const failedClusterIds: string[] = [];
  const clusterSyntheses: ResearchSynthesis[] = [];
  const queue = chunkPapers(papers, initialClusterSize).map((clusterPapers, index) => ({
    id: `cluster-${index + 1}`,
    papers: clusterPapers
  }));
  let clusterSequence = queue.length;
  let usedFallback = false;

  await mkdir(run.artifacts.synthesisClusterDirectory, { recursive: true });
  await writeSynthesisCheckpoint({
    run,
    status: "in_progress",
    clusterSize: initialClusterSize,
    clusterCount: queue.length,
    completedClusterIds,
    failedClusterIds,
    attempts,
    synthesis: null
  });
  await agent.record({
    phase: "synthesis",
    action: "plan_clustered_synthesis",
    status: "started",
    summary: `Plan clustered synthesis for ${papers.length} reviewed papers in chunks of up to ${initialClusterSize}.`,
    artifactPaths: [run.artifacts.synthesisJsonPath],
    counts: {
      papers: papers.length,
      clusters: queue.length,
      clusterSize: initialClusterSize
    }
  });

  while (queue.length > 0) {
    const cluster = queue.shift();

    if (cluster === undefined) {
      break;
    }

    const paperIds = new Set(cluster.papers.map((paper) => paper.id));
    const clusterExtractions = paperExtractions.filter((extraction) => paperIds.has(extraction.paperId));
    const clusterMatrix = evidenceMatrixForPaperIds(evidenceMatrix, paperIds);
    const attemptBase = {
      attempt: attempts.length + 1,
      clusterId: cluster.id,
      paperIds: cluster.papers.map((paper) => paper.id),
      clusterSize: cluster.papers.length,
      timeoutMs: runtimeConfig.synthesisTimeoutMs
    };

    await appendEvent(
      run,
      now,
      "next",
      `Synthesize evidence ${cluster.id} (${cluster.papers.length} reviewed papers).`
    );

    try {
      const synthesis = await researchBackend.synthesizeResearch({
        projectRoot: run.projectRoot,
        brief: run.brief,
        plan,
        papers: cluster.papers,
        paperExtractions: clusterExtractions,
        evidenceMatrix: clusterMatrix,
        selectionQuality: selectionQuality ?? null,
        literatureContext
      }, {
        operation: "synthesis",
        timeoutMs: runtimeConfig.synthesisTimeoutMs
      });

      attempts.push({
        ...attemptBase,
        status: "succeeded",
        errorKind: null,
        errorMessage: null
      });
      completedClusterIds.push(cluster.id);
      clusterSyntheses.push(synthesis);
      await writeJsonArtifact(synthesisClusterPath(run, cluster.id), {
        schemaVersion: 1,
        runId: run.id,
        clusterId: cluster.id,
        status: "completed",
        paperIds: [...paperIds],
        synthesis
      });
      await writeSynthesisCheckpoint({
        run,
        status: "in_progress",
        clusterSize: initialClusterSize,
        clusterCount: completedClusterIds.length + failedClusterIds.length + queue.length,
        completedClusterIds,
        failedClusterIds,
        attempts,
        synthesis: null
      });
      await appendStdout(run, `Synthesis cluster ${cluster.id} completed: ${completedClusterIds.length} cluster(s) done.`);
      await agent.record({
        phase: "synthesis",
        action: "synthesize_evidence_cluster",
        status: "completed",
        summary: `Completed synthesis for ${cluster.id}.`,
        artifactPaths: [synthesisClusterPath(run, cluster.id), run.artifacts.synthesisJsonPath],
        counts: {
          papers: cluster.papers.length,
          themes: synthesis.themes.length,
          claims: synthesis.claims.length
        }
      });
    } catch (error) {
      const kind = recoveryFailureKind(error);
      const message = errorMessage(error);
      attempts.push({
        ...attemptBase,
        status: "failed",
        errorKind: kind,
        errorMessage: message
      });
      await appendEvent(run, now, "stderr", `Synthesis ${cluster.id} failed (${kind}): ${message}`);

      const failedAttempts = attempts.filter((attempt) => attempt.status === "failed").length;
      if (
        ["timeout", "malformed_json", "empty_result"].includes(kind)
        && cluster.papers.length > minClusterSize
        && failedAttempts < runtimeConfig.synthesisRetryBudget
      ) {
        const smallerClusterSize = Math.max(minClusterSize, Math.ceil(cluster.papers.length / 2));
        const splitClusters = chunkPapers(cluster.papers, smallerClusterSize)
          .map((clusterPapers) => {
            clusterSequence += 1;
            return {
              id: `cluster-${clusterSequence}`,
              papers: clusterPapers
            };
          });
        queue.unshift(...splitClusters);
        await appendEvent(
          run,
          now,
          "next",
          `Revising synthesis work unit by splitting ${cluster.id} into ${splitClusters.length} smaller cluster(s).`
        );
        await agent.record({
          phase: "synthesis",
          action: "revise_synthesis_cluster",
          status: "revising",
          summary: `Split ${cluster.id} after ${kind}; continuing with smaller synthesis work units.`,
          artifactPaths: [run.artifacts.synthesisJsonPath],
          counts: {
            papers: cluster.papers.length,
            splitClusters: splitClusters.length,
            failedAttempts
          }
        });
        continue;
      }

      const fallback = fallbackSynthesisForCluster({
        clusterId: cluster.id,
        papers: cluster.papers,
        paperExtractions: clusterExtractions,
        evidenceMatrix: clusterMatrix,
        reason: message
      });
      usedFallback = true;
      failedClusterIds.push(cluster.id);
      clusterSyntheses.push(fallback);
      attempts.push({
        ...attemptBase,
        attempt: attempts.length + 1,
        status: "fallback",
        errorKind: kind,
        errorMessage: message
      });
      await writeJsonArtifact(synthesisClusterPath(run, cluster.id), {
        schemaVersion: 1,
        runId: run.id,
        clusterId: cluster.id,
        status: "fallback",
        paperIds: [...paperIds],
        reason: message,
        synthesis: fallback
      });
      await writeSynthesisCheckpoint({
        run,
        status: "in_progress",
        clusterSize: initialClusterSize,
        clusterCount: completedClusterIds.length + failedClusterIds.length + queue.length,
        completedClusterIds,
        failedClusterIds,
        attempts,
        synthesis: null
      });
      await agent.record({
        phase: "synthesis",
        action: "fallback_synthesis_cluster",
        status: "warning",
        summary: `Retained extraction-grounded status synthesis for ${cluster.id} after model failure.`,
        artifactPaths: [synthesisClusterPath(run, cluster.id), run.artifacts.synthesisJsonPath],
        counts: {
          papers: cluster.papers.length,
          failedAttempts
        }
      });
    }
  }

  const mergedSynthesis = mergeClusterSyntheses({
    run,
    papers,
    syntheses: clusterSyntheses,
    usedFallback
  });
  await writeSynthesisCheckpoint({
    run,
    status: usedFallback ? "completed_with_fallback" : "completed",
    clusterSize: initialClusterSize,
    clusterCount: completedClusterIds.length + failedClusterIds.length,
    completedClusterIds,
    failedClusterIds,
    attempts,
    synthesis: mergedSynthesis
  });
  await agent.record({
    phase: "synthesis",
    action: "merge_cluster_syntheses",
    status: usedFallback ? "warning" : "completed",
    summary: usedFallback
      ? "Merged completed synthesis clusters with fallback status clusters."
      : "Merged completed synthesis clusters into a run-level synthesis.",
    artifactPaths: [run.artifacts.synthesisJsonPath],
    counts: {
      clusters: completedClusterIds.length + failedClusterIds.length,
      fallbackClusters: failedClusterIds.length,
      themes: mergedSynthesis.themes.length,
      claims: mergedSynthesis.claims.length
    }
  });

  return {
    synthesis: mergedSynthesis,
    attempts,
    usedFallback
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

  const workPackage = agenda.selectedWorkPackage;

  if (workPackage === null) {
    return directionRecords;
  }

  const selectedDirection = agenda.candidateDirections.find((direction) => direction.id === agenda.selectedDirectionId) ?? null;

  return [
    ...directionRecords,
    {
      type: "hypothesis",
      key: `${workPackage.title}:${workPackage.hypothesisOrQuestion}`,
      title: workPackage.title,
      text: workPackage.hypothesisOrQuestion,
      runId: run.id,
      links: selectedDirection === null
        ? []
        : [link("derived_from", workPackageDirectionRecordId(selectedDirection))],
      data: {
        status: "selected",
        mode: workPackage.mode,
        expectedArtifact: workPackage.expectedArtifact
      }
    }
  ];
}

function buildWorkPackageArtifactRecords(
  run: RunRecord,
  summaryId: string,
  directionId: string | null,
  hypothesisId: string | null,
  methodPlanId: string | null
): MemoryRecordInput[] {
  const baseLinks = [
    summaryId,
    ...(directionId === null ? [] : [directionId]),
    ...(hypothesisId === null ? [] : [hypothesisId]),
    ...(methodPlanId === null ? [] : [methodPlanId])
  ];

  const artifactSpecs = [
    {
      path: run.artifacts.methodPlanPath,
      title: "Method plan artifact",
      text: `Saved the bounded method plan for ${run.id}.`
    },
    {
      path: run.artifacts.executionChecklistPath,
      title: "Execution checklist artifact",
      text: `Saved the execution checklist for ${run.id}.`
    },
    {
      path: run.artifacts.findingsPath,
      title: "Work-package findings artifact",
      text: `Saved bounded findings for ${run.id}.`
    },
    {
      path: run.artifacts.decisionPath,
      title: "Work-package decision artifact",
      text: `Saved the work-package decision for ${run.id}.`
    }
  ];

  return artifactSpecs.map((artifact) => ({
    type: "artifact",
    key: relativeArtifactPath(run.projectRoot, artifact.path),
    title: artifact.title,
    text: artifact.text,
    runId: run.id,
    links: baseLinks.map((targetId) => link("contains", targetId)),
    data: {
      path: relativeArtifactPath(run.projectRoot, artifact.path)
    }
  }));
}

function buildWorkPackageMemoryInputs(
  run: RunRecord,
  agenda: ResearchAgenda,
  workPackage: WorkPackage,
  methodPlan: MethodPlan,
  findings: WorkPackageFinding[],
  decision: WorkPackageDecisionRecord
): MemoryRecordInput[] {
  const workPackageSummaryId = createMemoryRecordId("summary", `run:${run.id}:work-package-summary`);
  const direction = selectedDirection(agenda);
  const directionId = direction === null ? null : workPackageDirectionRecordId(direction);
  const hypothesisId = workPackageHypothesisRecordId(workPackage);
  const methodPlanId = workPackageMethodPlanRecordId(run.id, workPackage.title);

  const hypothesisRecord: MemoryRecordInput = {
    type: "hypothesis",
    key: `${workPackage.title}:${workPackage.hypothesisOrQuestion}`,
    title: workPackage.title,
    text: workPackage.hypothesisOrQuestion,
    runId: run.id,
    links: directionId === null
      ? []
      : [link("derived_from", directionId)],
    data: {
      status: decision.status === "failed" ? "failed" : decision.status === "blocked" ? "blocked" : "implemented",
      mode: workPackage.mode
    }
  };

  const directionStatusRecord: MemoryRecordInput[] = direction === null
    ? []
    : [{
      type: "direction",
      key: `${direction.mode}:${direction.title}`,
      title: direction.title,
      text: direction.summary,
      runId: run.id,
      links: direction.claimIds.map((targetId) => link("derived_from", targetId)),
      data: {
        status: decision.status === "failed"
          ? "failed"
          : decision.status === "blocked"
            ? "blocked"
            : decision.outcome === "continue"
              ? "implemented"
              : "selected",
        mode: direction.mode,
        whyNow: direction.whyNow,
        overallScore: String(direction.scores.overall),
        sourceIds: direction.sourceIds,
        gapIds: direction.gapIds
      }
    }];

  const methodPlanRecord: MemoryRecordInput = {
    type: "method_plan",
    key: `run:${run.id}:${workPackage.title}`,
    title: `Method plan for ${workPackage.title}`,
    text: methodPlan.evaluationDesign,
    runId: run.id,
    links: [
      link("depends_on", hypothesisId)
    ],
    data: {
      assumptions: methodPlan.assumptions,
      baselines: methodPlan.baselines,
      controls: methodPlan.controls,
      ablations: methodPlan.ablations,
      decisiveChecks: methodPlan.decisiveChecks,
      status: decision.outcome === "continue" ? "implemented" : decision.status
    }
  };

  const findingRecords: MemoryRecordInput[] = findings.map((finding) => ({
    type: "finding",
    key: `${workPackage.title}:${finding.id}`,
    title: finding.title,
    text: finding.summary,
    runId: run.id,
    links: [
      link("derived_from", methodPlanId)
    ],
    data: {
      evidence: finding.evidence,
      status: finding.status
    }
  }));

  const summaryRecord: MemoryRecordInput = {
    type: "summary",
    key: `run:${run.id}:work-package-summary`,
    title: `Run ${run.id} work-package summary`,
    text: decision.rationale,
    runId: run.id,
    links: [
      link("summarizes", hypothesisId),
      link("summarizes", methodPlanId),
      ...findingRecords.map((record) => link("summarizes", createMemoryRecordId(record.type, record.key)))
    ],
    data: {
      outcome: decision.outcome,
      blockedBy: decision.blockedBy
    }
  };

  return [
    ...buildAgendaMemoryInputs(run, agenda),
    ...directionStatusRecord,
    hypothesisRecord,
    methodPlanRecord,
    ...findingRecords,
    summaryRecord,
    ...buildWorkPackageArtifactRecords(run, workPackageSummaryId, directionId, hypothesisId, methodPlanId)
  ];
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
    selectionQuality: gathered.selectionQuality ?? null,
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
  await writeJsonArtifact(run.artifacts.paperOutlinePath, bundle.outline);
  await writeFile(run.artifacts.paperPath, `${bundle.paperMarkdown}\n`, "utf8");
  await writeJsonArtifact(run.artifacts.paperJsonPath, bundle.paper);
  await writeJsonArtifact(run.artifacts.referencesPath, bundle.references);
  await writeJsonArtifact(run.artifacts.manuscriptChecksPath, bundle.checks);
}

async function writeMemorySnapshot(
  run: RunRecord,
  memoryStore: MemoryStore,
  records: MemoryRecordInput[]
): Promise<{ inserted: number; updated: number; recordCount: number }> {
  const result = await memoryStore.upsert(records);

  await writeJsonArtifact(run.artifacts.memoryPath, {
    inserted: result.inserted,
    updated: result.updated,
    recordCount: result.records.length,
    projectMemoryPath: relativeArtifactPath(run.projectRoot, memoryStore.filePath),
    recordIds: result.records.map((record) => record.id),
    records: result.records
  });

  return {
    inserted: result.inserted,
    updated: result.updated,
    recordCount: result.records.length
  };
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

function statusOnlySynthesisFromEvidence(input: {
  reason: string;
  evidenceMatrix: EvidenceMatrix;
  paperExtractions: PaperExtraction[];
}): ResearchSynthesis {
  const extractionLimitations = input.paperExtractions
    .flatMap((extraction) => extraction.limitations)
    .slice(0, 4)
    .map((limitation) => `How should the review qualify evidence limited by: ${limitation}?`);
  const insightQuestions = input.evidenceMatrix.derivedInsights
    .slice(0, 4)
    .map(questionFromInsight);

  return {
    executiveSummary: `${input.reason} The run retained extracted evidence and matrix diagnostics, but withheld full manuscript synthesis until the agent-control step is reliable.`,
    themes: input.evidenceMatrix.derivedInsights.slice(0, 6).map(themeFromInsight),
    claims: [],
    nextQuestions: uniqueStrings([
      ...evidenceMatrixNextQuestions(input.evidenceMatrix),
      ...insightQuestions,
      ...extractionLimitations,
      "Which model or provider should be used for reliable structured research-action control?"
    ]).slice(0, 8)
  };
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
    recommendedHumanDecision: `Refine the literature pass before continuing. Start with: ${nextQuestions[0] ?? "inspect retrieval settings and rerun the review."}`
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
  const recoverySummary = diagnostics.recoveryPasses > 0
    ? [`One revision retrieval pass ran, but only ${gathered.reviewedPapers.length} reviewed papers were selected for synthesis.`]
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

function selectionQualityHoldReasons(gathered: ResearchSourceGatherResult): string[] {
  const selectionQuality = gathered.selectionQuality;

  if (selectionQuality === undefined || selectionQuality === null || selectionQuality.adequacy === "strong") {
    return [];
  }

  const missing = selectionQuality.missingRequiredFacets
    .filter((facet) => !isRetrievalQualityConstraintPhrase(facet.label))
    .map((facet) => facet.label)
    .slice(0, 5);
  const backgroundOnly = selectionQuality.backgroundOnlyFacets
    .filter((facet) => !isRetrievalQualityConstraintPhrase(facet.label))
    .map((facet) => facet.label)
    .slice(0, 3);

  if (missing.length === 0 && backgroundOnly.length === 0 && selectionQuality.adequacy !== "thin") {
    return [];
  }

  const reasons = [
    missing.length > 0
      ? `The reviewed set does not cover required success-criterion facets: ${missing.join(", ")}.`
      : `The reviewed set has only ${selectionQuality.adequacy} coverage of the required review facets.`,
    backgroundOnly.length > 0
      ? `Some required facets appeared only in unselected/background candidates: ${backgroundOnly.join(", ")}.`
      : null
  ].filter((reason): reason is string => reason !== null);

  return reasons;
}

function agendaWithRetrievalHoldReasons(
  agenda: ResearchAgenda,
  gathered: ResearchSourceGatherResult,
  evidenceMatrix: EvidenceMatrix
): ResearchAgenda {
  const selectionReasons = selectionQualityHoldReasons(gathered);

  if (evidenceMatrix.rowCount >= 3 && selectionReasons.length === 0) {
    return agenda;
  }

  const extraReasons = [
    ...selectionReasons,
    ...(evidenceMatrix.rowCount < 3 ? retrievalDiagnosticHoldReasons(gathered) : [])
  ];

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

function workPackageSummaryMarkdown(
  run: RunRecord,
  workPackage: WorkPackage,
  methodPlan: MethodPlan,
  findings: WorkPackageFinding[],
  decision: WorkPackageDecisionRecord
): string {
  return [
    "# Work Package Summary",
    "",
    `- Run id: ${run.id}`,
    `- Parent run id: ${run.parentRunId ?? "<none>"}`,
    `- Work package id: ${workPackage.id}`,
    `- Title: ${workPackage.title}`,
    `- Mode: ${workPackage.mode}`,
    "",
    "## Objective",
    "",
    `- Objective: ${workPackage.objective}`,
    `- Hypothesis / question: ${workPackage.hypothesisOrQuestion}`,
    `- Expected artifact: ${workPackage.expectedArtifact}`,
    "",
    "## Method Plan",
    "",
    `- Evaluation design: ${methodPlan.evaluationDesign}`,
    `- Baselines: ${methodPlan.baselines.join(" | ") || "<none>"}`,
    `- Controls: ${methodPlan.controls.join(" | ") || "<none>"}`,
    `- Ablations: ${methodPlan.ablations.join(" | ") || "<none>"}`,
    "",
    "## Findings",
    "",
    ...findings.map((finding) => `- ${finding.title} [${finding.status}]: ${finding.summary}`),
    "",
    "## Decision",
    "",
    `- Outcome: ${decision.outcome}`,
    `- Status: ${decision.status}`,
    `- Rationale: ${decision.rationale}`,
    `- Blocked by: ${decision.blockedBy.join(" | ") || "<none>"}`,
    "",
    "## Next Actions",
    "",
    ...decision.nextActions.map((action) => `- ${action}`)
  ].join("\n");
}

async function runWorkPackageLoop(
  run: RunRecord,
  store: RunStore,
  now: () => string,
  memoryStore: MemoryStore,
  literatureStore: LiteratureStore,
  researchBackend: ResearchBackend
): Promise<number> {
  if (run.derivedFromWorkPackageId === null) {
    throw new Error("Work-package runs require derivedFromWorkPackageId.");
  }

  const parentRun = run.parentRunId === null ? null : await store.load(run.parentRunId);
  const parentAgenda = parentRun === null
    ? await readJsonArtifactOrNull<ResearchAgenda>(researchDirectionPath(run.projectRoot))
    : await readJsonArtifactOrNull<ResearchAgenda>(parentRun.artifacts.agendaPath);
  const parentWorkPackage = parentRun === null
    ? null
    : await readJsonArtifactOrNull<WorkPackage>(parentRun.artifacts.workPackagePath);
  const selectedWorkPackage = parentWorkPackage?.id === run.derivedFromWorkPackageId
    ? parentWorkPackage
    : parentAgenda?.selectedWorkPackage?.id === run.derivedFromWorkPackageId
      ? parentAgenda.selectedWorkPackage
      : null;

  if (parentAgenda === null || selectedWorkPackage === null) {
    throw new Error("Could not load the selected work package from the parent literature-review run.");
  }

  const localFiles = await collectResearchLocalFileHints(run.projectRoot, run.brief);
  const methodPlan = deriveMethodPlan(selectedWorkPackage, run.brief);
  const checklist = deriveExecutionChecklist(run, selectedWorkPackage, methodPlan, localFiles);
  const findings = deriveWorkPackageFindings(selectedWorkPackage, localFiles, checklist);
  const decision = decideWorkPackageOutcome(parentAgenda, selectedWorkPackage, localFiles, findings);
  const literature = await literatureStore.load();
  const memoryInputs = buildWorkPackageMemoryInputs(
    run,
    parentAgenda,
    selectedWorkPackage,
    methodPlan,
    findings,
    decision
  );
  const memoryResult = await writeMemorySnapshot(run, memoryStore, memoryInputs);

  await writeJsonArtifact(run.artifacts.planPath, {
    stage: run.stage,
    parentRunId: run.parentRunId,
    derivedFromWorkPackageId: run.derivedFromWorkPackageId,
    workPackage: selectedWorkPackage
  });
  await writeJsonArtifact(run.artifacts.agendaPath, parentAgenda);
  await writeResearchDirection(run, parentAgenda, now(), parentRun ?? run);
  await writeFile(run.artifacts.agendaMarkdownPath, `${agendaMarkdown(parentRun ?? run, { researchMode: selectedWorkPackage.mode, objective: selectedWorkPackage.objective, rationale: "Derived from the parent agenda.", searchQueries: [], localFocus: [] }, parentAgenda)}\n`, "utf8");
  await writeJsonArtifact(run.artifacts.workPackagePath, selectedWorkPackage);
  await writeJsonArtifact(run.artifacts.methodPlanPath, methodPlan);
  await writeJsonArtifact(run.artifacts.executionChecklistPath, checklist);
  await writeJsonArtifact(run.artifacts.findingsPath, findings);
  await writeJsonArtifact(run.artifacts.decisionPath, decision);
  await writeJsonArtifact(run.artifacts.literaturePath, {
    parentRunId: parentRun?.id ?? null,
    reusedLiteratureStore: relativeArtifactPath(run.projectRoot, literatureStore.filePath),
    paperCount: literature.paperCount,
    themeCount: literature.themeCount,
    notebookCount: literature.notebookCount
  });
  await writeFile(
    run.artifacts.summaryPath,
    `${workPackageSummaryMarkdown(run, selectedWorkPackage, methodPlan, findings, decision)}\n`,
    "utf8"
  );

  await appendTrace(run, now, `Executing bounded work package ${selectedWorkPackage.id}.`);
  await appendEvent(run, now, "plan", `Restated objective: ${selectedWorkPackage.objective}`);
  await appendEvent(run, now, "next", "Inspect local repo/runtime context.");
  await appendEvent(run, now, "next", "Produce the method plan and bounded execution checklist.");
  await appendStdout(run, `Research backend: ${researchBackend.label}`);
  await appendStdout(run, `Work package: ${selectedWorkPackage.title} (${selectedWorkPackage.mode})`);
  await appendStdout(run, `Local context candidates: ${localFiles.length}`);

  for (const item of checklist.items) {
    await appendEvent(run, now, item.kind === "command" ? "exec" : "plan", `${item.title}: ${item.intent}`);
    if (item.notes !== undefined) {
      await appendStdout(run, `${item.title}: ${item.notes}`);
    }
  }

  for (const finding of findings) {
    await appendEvent(run, now, finding.status === "blocked" ? "stderr" : "summary", `${finding.title}: ${finding.summary}`);
  }

  await appendEvent(run, now, "memory", `Recorded ${memoryResult.recordCount} research journal records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`);
  await appendStdout(run, `Research journal updated: ${memoryResult.recordCount} records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`);
  await appendEvent(run, now, "run", `${decision.outcome}: ${decision.rationale}`);

  run.job.finishedAt = now();
  run.finishedAt = now();
  run.job.exitCode = 0;
  run.job.signal = null;
  run.workerPid = null;
  run.status = "completed";
  run.statusMessage = `Work-package run completed with decision ${decision.outcome}.`;
  await store.save(run);
  await appendEvent(run, now, "run", run.statusMessage);
  return 0;
}

async function launchDerivedWorkPackageRun(
  store: RunStore,
  runController: RunController,
  parentRun: RunRecord,
  agenda: ResearchAgenda
): Promise<RunRecord | null> {
  if (!isWorkPackageAutoContinuable(agenda) || agenda.selectedWorkPackage === null) {
    return null;
  }

  const childRun = await store.createWithOptions(
    parentRun.brief,
    createWorkPackageRunCommand(agenda.selectedWorkPackage),
    {
      stage: "work_package",
      parentRunId: parentRun.id,
      derivedFromWorkPackageId: agenda.selectedWorkPackage.id
    }
  );
  childRun.job.launchCommand = runController.launchCommand(childRun);
  await store.save(childRun);
  const workerPid = await runController.launch(childRun);
  childRun.workerPid = workerPid;
  childRun.status = "queued";
  childRun.statusMessage = "Derived work-package run launched automatically. Waiting for the run worker to start.";
  await store.save(childRun);
  return childRun;
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
  const runController = options.runController ?? createDefaultRunController();
  const researchBackend = options.researchBackend ?? createDefaultResearchBackend();
  const sourceGatherer = options.sourceGatherer ?? createDefaultResearchSourceGatherer();
  const projectConfigStore = new ProjectConfigStore(options.projectRoot, now);
  const projectConfig = await projectConfigStore.load();
  const runtimeLlmConfig = resolveRuntimeLlmConfig(projectConfig);
  const credentialStore = new CredentialStore(options.projectRoot, now);
  const credentials = await credentialStore.load();
  applyCredentialsToEnvironment(credentials);
  const literatureStore = new LiteratureStore(options.projectRoot, now);
  const projectLiterature = await literatureStore.load();
  const literatureContext = buildLiteratureContext(projectLiterature, run.brief);
  const memoryStore = new MemoryStore(options.projectRoot, now);
  const projectMemory = await memoryStore.load();
  const memoryContext = buildProjectMemoryContext(projectMemory, run.brief);
  const scholarlyDiscoveryProviders = selectedProviderIdsForCategory(projectConfig, "scholarlyDiscovery");
  const publisherFullTextProviders = selectedProviderIdsForCategory(projectConfig, "publisherFullText");
  const oaRetrievalHelperProviders = selectedProviderIdsForCategory(projectConfig, "oaRetrievalHelpers");
  const scholarlyProviders = selectedScholarlySourceProviders(projectConfig);
  const generalWebProviders = selectedGeneralWebProviders(projectConfig);
  const localEnabled = projectConfig.sources.localContext.projectFilesEnabled;
  const providerAuthStates = authStatesForSelectedProviders(projectConfig, credentials);

  try {
    run.workerPid = process.pid;
    run.status = "running";
    run.startedAt = run.startedAt ?? now();
    run.statusMessage = run.stage === "work_package"
      ? "Run worker started and is preparing the bounded work-package loop."
      : "Run worker started and is preparing the provider-aware research loop.";
    if (run.job.command.length === 0) {
      run.job.command = run.stage === "work_package" && run.derivedFromWorkPackageId !== null
        ? createWorkPackageRunCommand({
          id: run.derivedFromWorkPackageId,
          title: "selected-work-package",
          mode: "method_improvement",
          objective: "continue the selected work package",
          hypothesisOrQuestion: "continue the selected work package",
          methodSketch: "",
          baselines: [],
          controls: [],
          decisiveExperiment: "",
          stopCriterion: "",
          expectedArtifact: "",
          requiredInputs: [],
          blockedBy: []
        })
        : runLoopCommand(run.id);
    }
    run.job.cwd = run.projectRoot;
    run.job.pid = process.pid;
    run.job.startedAt = now();
    await store.save(run);

    await writeRunArtifacts(run);
    await writeFile(run.artifacts.summaryPath, `${markdownBrief(run.brief)}\n`, "utf8");
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

    if (run.stage === "work_package") {
      return runWorkPackageLoop(
        run,
        store,
        now,
        memoryStore,
        literatureStore,
        researchBackend
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
      literatureContext
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
    const rememberCriticReport = (report: CriticReviewArtifact): void => {
      const reports = criticReportsByStage.get(report.stage) ?? [];
      reports.push(report);
      criticReportsByStage.set(report.stage, reports);
    };

    await writeJsonArtifact(run.artifacts.planPath, plan);
    let currentProtocol = buildReviewProtocol({
      run,
      plan,
      scholarlyDiscoveryProviders,
      publisherFullTextProviders,
      oaRetrievalHelperProviders,
      generalWebProviders,
      localContextEnabled: localEnabled
    });
    await writeJsonArtifact(run.artifacts.reviewProtocolPath, currentProtocol);
    await writeFile(run.artifacts.reviewProtocolMarkdownPath, `${reviewProtocolMarkdown(currentProtocol)}\n`, "utf8");

    let protocolCritic = await reviewWithCritic({
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
    const maxProtocolCriticAttempts = Math.max(1, runtimeLlmConfig.evidenceRecoveryMaxPasses + 1);
    const protocolRecoveryStartedAtMs = Date.now();
    let protocolCriticAttempts = 1;
    rememberCriticReport(protocolCritic);
    await agent.record({
      actor: "critic",
      phase: "protocol",
      action: "review_protocol",
      status: criticReviewPassed(protocolCritic) ? "completed" : "revising",
      summary: `Protocol critic returned ${protocolCritic.readiness}.`,
      artifactPaths: [run.artifacts.reviewProtocolPath, run.artifacts.criticProtocolReviewPath],
      counts: {
        objections: protocolCritic.objections.length,
        attempt: protocolCriticAttempts
      }
    });

    while (
      !criticReviewPassed(protocolCritic)
      && protocolCriticAttempts < maxProtocolCriticAttempts
      && criticReviewNeedsRevision(protocolCritic)
      && !evidenceRecoveryBudgetExhausted(protocolRecoveryStartedAtMs, runtimeLlmConfig)
    ) {
      const recovery = buildProtocolCriticRecoveryQueries({
        run,
        plan,
        criticReport: protocolCritic
      });
      const recoveryUpdate = protocolRecoveryPlanUpdate(plan, recovery.queries, recovery.focusTerms);

      if (recoveryUpdate === null) {
        break;
      }

      protocolCriticAttempts += 1;
      plan = recoveryUpdate.plan;
      currentProtocol = buildReviewProtocol({
        run,
        plan,
        scholarlyDiscoveryProviders,
        publisherFullTextProviders,
        oaRetrievalHelperProviders,
        generalWebProviders,
        localContextEnabled: localEnabled
      });
      await writeJsonArtifact(run.artifacts.planPath, plan);
      await writeJsonArtifact(run.artifacts.reviewProtocolPath, currentProtocol);
      await writeFile(run.artifacts.reviewProtocolMarkdownPath, `${reviewProtocolMarkdown(currentProtocol)}\n`, "utf8");
      await appendEvent(
        run,
        now,
        "next",
        `Protocol critic requested autonomous protocol revision ${protocolCriticAttempts - 1}.`
      );
      await appendStdout(run, `Protocol revision ${protocolCriticAttempts - 1}: ${recoveryUpdate.recoveryQueries.join(" | ")}`);
      protocolCritic = await reviewWithCritic({
        run,
        now,
        researchBackend,
        runtimeConfig: runtimeLlmConfig,
        request: {
          projectRoot: run.projectRoot,
          runId: run.id,
          stage: "protocol",
          iteration: {
            attempt: protocolCriticAttempts,
            maxAttempts: maxProtocolCriticAttempts,
            revisionPassesUsed: protocolCriticAttempts - 1
          },
          brief: run.brief,
          protocol: currentProtocol,
          plan
        }
      });
      rememberCriticReport(protocolCritic);
      await agent.record({
        actor: "critic",
        phase: "protocol",
        action: "review_revised_protocol",
        status: criticReviewPassed(protocolCritic) ? "completed" : "revising",
        summary: `Protocol critic returned ${protocolCritic.readiness} after revision ${protocolCriticAttempts - 1}.`,
        artifactPaths: [run.artifacts.reviewProtocolPath, run.artifacts.criticProtocolReviewPath],
        counts: {
          objections: protocolCritic.objections.length,
          attempt: protocolCriticAttempts,
          revisions: protocolCriticAttempts - 1
        }
      });
    }

    if (!criticReviewPassed(protocolCritic)) {
      unresolvedNonTerminalCriticReports.push(protocolCritic);
      await appendEvent(
        run,
        now,
        "literature",
        "Protocol critic still had concerns after bounded protocol revisions; continuing to retrieval and recording the concerns in the quality report."
      );
      await appendStdout(
        run,
        "Protocol critic still had concerns after bounded self-validation; continuing to retrieval so source-selection, evidence, and release checks can validate the actual work."
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
    let previousEvidenceQuality: EvidenceQualitySnapshot | null = null;
    let nonImprovingEvidencePasses = 0;

    while (true) {
    await writeJsonArtifact(run.artifacts.planPath, plan);
    const evidencePassNumber = autonomousRecoveryPasses + 1;
    await appendEvent(run, now, "literature", `Starting evidence pass ${evidencePassNumber}.`);
    if (pendingRecoveryQueries.length > 0) {
      await appendStdout(run, `Autonomous evidence revision queries: ${pendingRecoveryQueries.join(" | ")}`);
    }

    const gathered = await sourceGatherer.gather({
      projectRoot: run.projectRoot,
      brief: run.brief,
      plan,
      memoryContext,
      literatureContext,
      recoveryQueries: pendingRecoveryQueries,
      scholarlyProviderIds: scholarlyProviders,
      generalWebProviderIds: generalWebProviders,
      projectFilesEnabled: localEnabled,
      credentials
    });
    pendingRecoveryQueries = [];
    const currentEvidenceQuality = evidenceQualitySnapshot(gathered);
    const evidenceImproved = evidenceQualityImproved(previousEvidenceQuality, currentEvidenceQuality);
    if (previousEvidenceQuality !== null) {
      if (evidenceImproved) {
        nonImprovingEvidencePasses = 0;
        await appendEvent(run, now, "literature", "Evidence revision improved the in-scope source set or reduced missing targets.");
        await appendStdout(run, "Evidence revision improved the protocol relevance/coverage score.");
      } else {
        nonImprovingEvidencePasses += 1;
        await appendEvent(run, now, "literature", "Evidence revision did not improve the protocol relevance/coverage score.");
        await appendStdout(run, "Evidence revision did not improve the protocol relevance/coverage score.");
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
        maxRevisionPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses,
        recoveryPasses: autonomousRecoveryPasses,
        maxRecoveryPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses
      },
      scholarlyProviders,
      generalWebProviders,
      routing: gathered.routing,
      authStatus: gathered.authStatus,
      retrievalDiagnostics: gathered.retrievalDiagnostics ?? null,
      notes: gathered.notes,
      rawSources: gathered.sources,
      reviewWorkflow: gathered.reviewWorkflow,
      selectionQuality: gathered.selectionQuality ?? null,
      relevanceAssessments: gathered.relevanceAssessments ?? [],
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

    const currentProtocol = buildReviewProtocol({
      run,
      plan,
      scholarlyDiscoveryProviders,
      publisherFullTextProviders,
      oaRetrievalHelperProviders,
      generalWebProviders,
      localContextEnabled: localEnabled,
      gathered
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
        selectionQuality: gathered.selectionQuality ?? null,
        gathered: {
          reviewWorkflow: gathered.reviewWorkflow,
          retrievalDiagnostics: gathered.retrievalDiagnostics,
          notes: gathered.notes
        }
      }
    });
    rememberCriticReport(sourceSelectionCritic);
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
      const recovery = buildEvidenceRecoveryQueries({
        run,
        plan,
        gathered,
        criticReports: [sourceSelectionCritic]
      });
      const recoveryUpdate = evidenceRecoveryPlanUpdate(plan, recovery.queries, recovery.focusTerms);

      if (
        criticReviewNeedsRevision(sourceSelectionCritic)
        && recoveryUpdate !== null
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
          "next",
          `Source-selection critic requested evidence revision pass ${autonomousRecoveryPasses}.`
        );
        await appendStdout(run, `Evidence revision pass ${autonomousRecoveryPasses}: ${pendingRecoveryQueries.join(" | ")}`);
        continue;
      }

      unresolvedNonTerminalCriticReports.push(sourceSelectionCritic);
      await appendEvent(
        run,
        now,
        "next",
        "Source-selection critic still had concerns after bounded revision; continuing to extraction and recording the concerns in the quality report."
      );
      await appendStdout(
        run,
        "Source-selection critic still had concerns after bounded revision; continuing so later evidence, synthesis, and final quality checks can complete."
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
      const recovery = buildEvidenceRecoveryQueries({
        run,
        plan,
        gathered,
        extraQuestions: nextQuestions
      });
      const recoveryUpdate = evidenceRecoveryPlanUpdate(plan, recovery.queries, recovery.focusTerms);
      if (
        recoveryUpdate !== null
        && autonomousRecoveryPasses < runtimeLlmConfig.evidenceRecoveryMaxPasses
        && !evidenceRecoveryBudgetExhausted(evidenceRecoveryStartedAtMs, runtimeLlmConfig)
        && nonImprovingEvidencePasses < 2
      ) {
        autonomousRecoveryPasses += 1;
        plan = recoveryUpdate.plan;
        pendingRecoveryQueries = recoveryUpdate.recoveryQueries;
        await appendEvent(run, now, "next", `${failureMessage} Continuing autonomously with evidence revision pass ${autonomousRecoveryPasses}.`);
        await appendStdout(run, `Evidence revision pass ${autonomousRecoveryPasses}: ${pendingRecoveryQueries.join(" | ")}`);
        continue;
      }

      const terminalFailureMessage = `${failureMessage} Autonomous evidence revision could not find a stronger evidence set within the configured revision budget.`;
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
      await writeJsonArtifact(run.artifacts.evidenceMatrixPath, evidenceMatrix);
      await writeJsonArtifact(run.artifacts.claimsPath, claimsArtifact(run, []));
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
      let manuscriptBundle = buildManuscriptBundle({
        run,
        plan,
        scholarlyDiscoveryProviders,
        publisherFullTextProviders,
        oaRetrievalHelperProviders,
        generalWebProviders,
        localContextEnabled: localEnabled,
        gathered,
        reviewedPapers: canonicalReviewedPapers,
        evidenceMatrix,
        synthesis: insufficientSynthesis,
        verification,
        agenda
      });
      if (unresolvedNonTerminalCriticReports.length > 0) {
        manuscriptBundle = applyCriticReportsToManuscriptBundle(
          {
            run,
            plan,
            scholarlyDiscoveryProviders,
            publisherFullTextProviders,
            oaRetrievalHelperProviders,
            generalWebProviders,
            localContextEnabled: localEnabled,
            gathered,
            reviewedPapers: canonicalReviewedPapers,
            evidenceMatrix,
            synthesis: insufficientSynthesis,
            verification,
            agenda
          },
          manuscriptBundle,
          unresolvedNonTerminalCriticReports
        );
      }
      await writeJsonArtifact(run.artifacts.agendaPath, agenda);
      await writeResearchDirection(run, agenda, now());
      await writeFile(run.artifacts.agendaMarkdownPath, `${agendaMarkdown(run, plan, agenda)}\n`, "utf8");
      await writeJsonArtifact(run.artifacts.workPackagePath, null);
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
        agentControlMode: runtimeLlmConfig.agentControlMode,
        autonomousRevisionPasses: autonomousRecoveryPasses,
        revisionBudgetPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses
      }));
      await writeFile(
        run.artifacts.synthesisPath,
        `${insufficientEvidenceSynthesisMarkdown(run, plan, gathered, nextQuestions, terminalFailureMessage)}\n`,
        "utf8"
      );
      await writeSynthesisCheckpoint({
        run,
        status: "completed_with_fallback",
        clusterSize: 0,
        clusterCount: 0,
        completedClusterIds: [],
        failedClusterIds: [],
        attempts: [],
        synthesis: insufficientSynthesis
      });
      await writeFile(
        run.artifacts.summaryPath,
        [
          "# Run Summary",
          "",
          `- Topic: ${run.brief.topic ?? "<missing>"}`,
          `- Research mode: ${plan.researchMode}`,
          `- Objective: ${plan.objective}`,
          `- Autonomous evidence revision passes: ${autonomousRecoveryPasses}`,
          "",
          terminalFailureMessage
        ].join("\n"),
        "utf8"
      );
      const memoryResult = await writeMemorySnapshot(
        run,
        memoryStore,
        [
          ...buildMemoryInputs(
            run,
            plan,
            gathered,
            evidenceMatrix,
            terminalFailureMessage,
            [],
            [],
            verification,
            nextQuestions,
            terminalFailureMessage
          ),
          ...buildAgendaMemoryInputs(run, agenda)
        ]
      );
      const literatureResult = await literatureStore.upsert(
        buildLiteratureInputs(
          run,
          plan,
          gathered,
          terminalFailureMessage,
          [],
          [],
          nextQuestions
        )
      );
      await writeLiteratureSnapshot(run, literatureStore, literatureResult, gathered);

      await appendStderr(run, terminalFailureMessage);
      await appendTrace(run, now, terminalFailureMessage);
      await appendEvent(run, now, "summary", terminalFailureMessage);
      await appendEvent(run, now, "verify", verification.summary);
      await appendStdout(run, `Verification: ${verification.summary}`);
      await appendEvent(
        run,
        now,
        "memory",
        `Recorded ${memoryResult.recordCount} research journal records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
      );
      await appendStdout(
        run,
        `Research journal updated: ${memoryResult.recordCount} records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
      );
      await appendEvent(
        run,
        now,
        "literature",
        `Updated literature store: ${literatureResult.state.paperCount} canonical papers, ${literatureResult.state.themeCount} theme boards, ${literatureResult.state.notebookCount} review notebooks.`
      );
      await appendStdout(
        run,
        `Literature store updated: ${literatureResult.state.paperCount} canonical papers, ${literatureResult.state.themeCount} theme boards, ${literatureResult.state.notebookCount} review notebooks.`
      );

      for (const question of nextQuestions) {
        await appendEvent(run, now, "next", question);
      }

      await appendEvent(run, now, "plan", "Agenda generation completed with a hold after autonomous evidence revision was exhausted.");
      await appendStdout(run, `Agenda hold: ${agenda.recommendedHumanDecision}`);
      await appendEvent(run, now, "summary", `Manuscript status: ${manuscriptBundle.checks.readinessStatus}.`);
      await appendStdout(run, `Paper artifact: ${relativeArtifactPath(run.projectRoot, run.artifacts.paperPath)} (${manuscriptBundle.checks.readinessStatus})`);
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
          run.artifacts.synthesisPath
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
      run.statusMessage = "Literature review completed after autonomous evidence revision, but the evidence base remained too thin.";
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

    await writeJsonArtifact(run.artifacts.evidenceMatrixPath, normalizedEvidenceMatrix);
    await appendStdout(run, `Evidence matrix rows: ${normalizedEvidenceMatrix.rowCount}`);
    await agent.record({
      phase: "evidence",
      action: "build_evidence_matrix",
      status: "completed",
      summary: "Built the cross-paper evidence matrix from selected-paper extractions.",
      artifactPaths: [run.artifacts.evidenceMatrixPath],
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
        selectionQuality: gathered.selectionQuality ?? null,
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
      artifactPaths: [run.artifacts.criticEvidenceReviewPath, run.artifacts.evidenceMatrixPath],
      counts: {
        objections: evidenceCritic.objections.length,
        rows: normalizedEvidenceMatrix.rowCount,
        revisionPasses: autonomousRecoveryPasses
      }
    });

    if (!criticReviewPassed(evidenceCritic)) {
      const recovery = buildEvidenceRecoveryQueries({
        run,
        plan,
        gathered,
        criticReports: [evidenceCritic]
      });
      const recoveryUpdate = evidenceRecoveryPlanUpdate(plan, recovery.queries, recovery.focusTerms);

      if (
        criticReviewNeedsRevision(evidenceCritic)
        && recoveryUpdate !== null
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
          "next",
          `Evidence critic requested evidence revision pass ${autonomousRecoveryPasses}.`
        );
        await appendStdout(run, `Evidence revision pass ${autonomousRecoveryPasses}: ${pendingRecoveryQueries.join(" | ")}`);
        continue;
      }

      unresolvedNonTerminalCriticReports.push(evidenceCritic);
      await appendEvent(
        run,
        now,
        "next",
        "Evidence critic still had concerns after bounded revision; continuing to synthesis and recording the concerns in the quality report."
      );
      await appendStdout(
        run,
        "Evidence critic still had concerns after bounded revision; continuing to synthesis with quality warnings."
      );
    }

    const nextAction = await chooseResearchActionStrict({
      run,
      now,
      researchBackend,
      runtimeConfig: runtimeLlmConfig,
      agent,
      diagnostics: agentActionDiagnostics,
      request: {
        projectRoot: run.projectRoot,
        runId: run.id,
        phase: "synthesis",
        allowedActions: ["revise_search_strategy", "synthesize_clustered", "finalize_status_report"],
        brief: run.brief,
        plan,
        observations: {
          canonicalPapers: gathered.canonicalPapers.length,
          selectedPapers: canonicalReviewedPapers.length,
          extractedPapers: paperExtractions.length,
          evidenceRows: normalizedEvidenceMatrix.rowCount,
          evidenceInsights: normalizedEvidenceMatrix.derivedInsights.length,
          manuscriptReadiness: null,
          revisionPassesUsed: autonomousRecoveryPasses,
          revisionPassesRemaining: Math.max(0, runtimeLlmConfig.evidenceRecoveryMaxPasses - autonomousRecoveryPasses)
        },
        criticReports: [evidenceCritic]
      }
    });

    if (nextAction.action === "revise_search_strategy") {
      const actionQueries = uniqueStrings([
        ...nextAction.inputs.searchQueries,
        ...nextAction.inputs.evidenceTargets.map((target) => `${run.brief.topic ?? plan.objective} ${target}`)
      ]);
      const recovery = actionQueries.length > 0
        ? {
          queries: actionQueries,
          focusTerms: nextAction.inputs.evidenceTargets
        }
        : buildEvidenceRecoveryQueries({
          run,
          plan,
          gathered,
          criticReports: [evidenceCritic]
        });
      const recoveryUpdate = evidenceRecoveryPlanUpdate(plan, recovery.queries, recovery.focusTerms);

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
          "next",
          `Research agent requested a strategy revision before synthesis; starting evidence revision pass ${autonomousRecoveryPasses}.`
        );
        await appendStdout(run, `Evidence revision pass ${autonomousRecoveryPasses}: ${pendingRecoveryQueries.join(" | ")}`);
        continue;
      }

      await appendEvent(
        run,
        now,
        "next",
        "Research agent requested source strategy revision, but no useful revision budget or unused query plan remained."
      );
    }

    if (nextAction.action === "finalize_status_report") {
      const statusReason = nextAction.inputs.reason ?? nextAction.rationale;
      const statusSynthesis = statusOnlySynthesisFromEvidence({
        reason: statusReason,
        evidenceMatrix: normalizedEvidenceMatrix,
        paperExtractions
      });
      const verification = verifyResearchClaims({
        brief: run.brief,
        papers: canonicalReviewedPapers,
        claims: []
      });
      const statusAgenda = agendaWithRetrievalHoldReasons(
        insufficientEvidenceAgenda(run, plan, statusSynthesis.nextQuestions, statusReason),
        gathered,
        normalizedEvidenceMatrix
      );
      let statusManuscriptBundle = buildManuscriptBundle({
        run,
        plan,
        scholarlyDiscoveryProviders,
        publisherFullTextProviders,
        oaRetrievalHelperProviders,
        generalWebProviders,
        localContextEnabled: localEnabled,
        gathered,
        reviewedPapers: canonicalReviewedPapers,
        evidenceMatrix: normalizedEvidenceMatrix,
        synthesis: statusSynthesis,
        verification,
        agenda: statusAgenda
      });
      if (unresolvedNonTerminalCriticReports.length > 0) {
        statusManuscriptBundle = applyCriticReportsToManuscriptBundle(
          {
            run,
            plan,
            scholarlyDiscoveryProviders,
            publisherFullTextProviders,
            oaRetrievalHelperProviders,
            generalWebProviders,
            localContextEnabled: localEnabled,
            gathered,
            reviewedPapers: canonicalReviewedPapers,
            evidenceMatrix: normalizedEvidenceMatrix,
            synthesis: statusSynthesis,
            verification,
            agenda: statusAgenda
          },
          statusManuscriptBundle,
          unresolvedNonTerminalCriticReports
        );
      }

      await writeJsonArtifact(run.artifacts.claimsPath, claimsArtifact(run, []));
      await writeJsonArtifact(run.artifacts.nextQuestionsPath, statusSynthesis.nextQuestions);
      await writeJsonArtifact(run.artifacts.verificationPath, verification);
      await writeJsonArtifact(run.artifacts.agendaPath, statusAgenda);
      await writeResearchDirection(run, statusAgenda, now());
      await writeFile(run.artifacts.agendaMarkdownPath, `${agendaMarkdown(run, plan, statusAgenda)}\n`, "utf8");
      await writeJsonArtifact(run.artifacts.workPackagePath, null);
      await writeManuscriptArtifacts(run, statusManuscriptBundle);
      await writeJsonArtifact(run.artifacts.qualityReportPath, buildQualityReport({
        run,
        backendLabel: researchBackend.label,
        gathered,
        paperExtractions,
        evidenceMatrix: normalizedEvidenceMatrix,
        manuscriptBundle: statusManuscriptBundle,
        criticReportsByStage,
        agentActionDiagnostics,
        agentControlMode: runtimeLlmConfig.agentControlMode,
        autonomousRevisionPasses: autonomousRecoveryPasses,
        revisionBudgetPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses
      }));
      await writeFile(
        run.artifacts.synthesisPath,
        `${synthesisMarkdown(run, plan, gathered, paperExtractions, normalizedEvidenceMatrix, statusSynthesis, verification)}\n`,
        "utf8"
      );
      await writeFile(
        run.artifacts.summaryPath,
        `${researchSummaryMarkdown(run, plan, gathered, paperExtractions, normalizedEvidenceMatrix, statusSynthesis, verification)}\n`,
        "utf8"
      );
      await writeSynthesisCheckpoint({
        run,
        status: "completed_with_fallback",
        clusterSize: 0,
        clusterCount: 0,
        completedClusterIds: [],
        failedClusterIds: [],
        attempts: [],
        synthesis: statusSynthesis
      });
      await agent.record({
        phase: "release",
        action: "write_status_only_artifacts",
        status: "completed",
        summary: "Wrote status-only artifacts because the research agent could not safely proceed to manuscript synthesis.",
        artifactPaths: [
          run.artifacts.paperPath,
          run.artifacts.paperJsonPath,
          run.artifacts.manuscriptChecksPath,
          run.artifacts.qualityReportPath,
          run.artifacts.synthesisPath
        ],
        counts: {
          selectedPapers: canonicalReviewedPapers.length,
          extractedPapers: paperExtractions.length,
          invalidActions: agentActionDiagnostics.length
        }
      });
      const memoryResult = await writeMemorySnapshot(
        run,
        memoryStore,
        [
          ...buildMemoryInputs(
            run,
            plan,
            gathered,
            normalizedEvidenceMatrix,
            statusSynthesis.executiveSummary,
            statusSynthesis.themes,
            [],
            verification,
            statusSynthesis.nextQuestions,
            statusReason
          ),
          ...buildAgendaMemoryInputs(run, statusAgenda)
        ]
      );
      const literatureResult = await literatureStore.upsert(
        buildLiteratureInputs(
          run,
          plan,
          gathered,
          statusSynthesis.executiveSummary,
          statusSynthesis.themes,
          [],
          statusSynthesis.nextQuestions
        )
      );
      await writeLiteratureSnapshot(run, literatureStore, literatureResult, gathered);

      await appendEvent(run, now, "summary", statusSynthesis.executiveSummary);
      await appendEvent(run, now, "summary", `Manuscript status: ${statusManuscriptBundle.checks.readinessStatus}.`);
      await appendEvent(run, now, "verify", verification.summary);
      await appendStdout(run, `Verification: ${verification.summary}`);
      await appendStdout(run, `Paper artifact: ${relativeArtifactPath(run.projectRoot, run.artifacts.paperPath)} (${statusManuscriptBundle.checks.readinessStatus})`);
      await appendEvent(
        run,
        now,
        "memory",
        `Recorded ${memoryResult.recordCount} research journal records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
      );
      await appendStdout(
        run,
        `Research journal updated: ${memoryResult.recordCount} records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
      );
      await appendEvent(
        run,
        now,
        "literature",
        `Updated literature store: ${literatureResult.state.paperCount} canonical papers, ${literatureResult.state.themeCount} theme boards, ${literatureResult.state.notebookCount} review notebooks.`
      );
      await appendStdout(
        run,
        `Literature store updated: ${literatureResult.state.paperCount} canonical papers, ${literatureResult.state.themeCount} theme boards, ${literatureResult.state.notebookCount} review notebooks.`
      );

      for (const question of statusSynthesis.nextQuestions) {
        await appendEvent(run, now, "next", question);
      }

      finalAgenda = statusAgenda;
      finalManuscriptBundle = statusManuscriptBundle;
      break;
    }

    await appendEvent(run, now, "next", "Synthesize themes, claims, and next-step questions from the evidence matrix.");

    const synthesisResult = await synthesizeResearchAdaptively({
      run,
      now,
      researchBackend,
      runtimeConfig: runtimeLlmConfig,
      agent,
      plan,
      papers: canonicalReviewedPapers,
      paperExtractions,
      evidenceMatrix: normalizedEvidenceMatrix,
      selectionQuality: gathered.selectionQuality,
      literatureContext
    });
    const normalizedSynthesis = remapSynthesisSourceIds(synthesisResult.synthesis, canonicalIdByAnyPaperId);
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
      selectionQuality: gathered.selectionQuality ?? null,
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
    let manuscriptBundle = buildManuscriptBundle({
      run,
      plan,
      scholarlyDiscoveryProviders,
      publisherFullTextProviders,
      oaRetrievalHelperProviders,
      generalWebProviders,
      localContextEnabled: localEnabled,
      gathered,
      reviewedPapers: canonicalReviewedPapers,
      evidenceMatrix: normalizedEvidenceMatrix,
      synthesis: normalizedSynthesis,
      verification,
      agenda: normalizedAgenda
    });

    let releaseCriticBlocked = false;
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
          selectionQuality: gathered.selectionQuality ?? null,
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
      releaseCriticBlocked = !criticReviewPassed(releaseCritic);
      await agent.record({
        actor: "critic",
        phase: "release",
        action: "review_release_candidate",
        status: criticReviewPassed(releaseCritic) ? "completed" : "revising",
        summary: `Release critic returned ${releaseCritic.readiness}.`,
        artifactPaths: [run.artifacts.criticReleaseReviewPath, run.artifacts.manuscriptChecksPath],
        counts: {
          objections: releaseCritic.objections.length,
          revisionPasses: autonomousRecoveryPasses
        }
      });
      manuscriptBundle = applyCriticReportsToManuscriptBundle(
        {
          run,
          plan,
          scholarlyDiscoveryProviders,
          publisherFullTextProviders,
          oaRetrievalHelperProviders,
          generalWebProviders,
          localContextEnabled: localEnabled,
          gathered,
          reviewedPapers: canonicalReviewedPapers,
          evidenceMatrix: normalizedEvidenceMatrix,
          synthesis: normalizedSynthesis,
          verification,
          agenda: normalizedAgenda
        },
        manuscriptBundle,
        [releaseCritic]
      );
    } else {
      await writeJsonArtifact(run.artifacts.criticReleaseReviewPath, skippedArtifactStatus(
        run,
        "critic-release-review",
        now(),
        "Release critic only runs after deterministic manuscript checks are ready for revision."
      ));
    }

    if (manuscriptBundle.checks.readinessStatus === "needs_more_evidence" && !releaseCriticBlocked) {
      const recovery = buildEvidenceRecoveryQueries({
        run,
        plan,
        gathered,
        synthesis: normalizedSynthesis,
        agenda: normalizedAgenda,
        verification
      });
      const recoveryUpdate = evidenceRecoveryPlanUpdate(plan, recovery.queries, recovery.focusTerms);

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
          "next",
          `Manuscript checks need more evidence; continuing autonomously with evidence revision pass ${autonomousRecoveryPasses}.`
        );
        await appendStdout(run, `Evidence revision pass ${autonomousRecoveryPasses}: ${pendingRecoveryQueries.join(" | ")}`);
        continue;
      }

      await appendEvent(
        run,
        now,
        "next",
        nonImprovingEvidencePasses >= 2
          ? "Manuscript checks still need more evidence, but repeated evidence revision passes did not improve relevance or coverage."
          : recoveryUpdate === null
          ? "Manuscript checks still need more evidence, but no unused revision queries remained."
          : "Manuscript checks still need more evidence, but the autonomous evidence revision budget was exhausted."
      );
    }

    if (unresolvedNonTerminalCriticReports.length > 0) {
      manuscriptBundle = applyCriticReportsToManuscriptBundle(
        {
          run,
          plan,
          scholarlyDiscoveryProviders,
          publisherFullTextProviders,
          oaRetrievalHelperProviders,
          generalWebProviders,
          localContextEnabled: localEnabled,
          gathered,
          reviewedPapers: canonicalReviewedPapers,
          evidenceMatrix: normalizedEvidenceMatrix,
          synthesis: normalizedSynthesis,
          verification,
          agenda: normalizedAgenda
        },
        manuscriptBundle,
        unresolvedNonTerminalCriticReports
      );
    }

    await writeJsonArtifact(run.artifacts.claimsPath, claimsArtifact(run, normalizedSynthesis.claims));
    await writeJsonArtifact(run.artifacts.nextQuestionsPath, normalizedSynthesis.nextQuestions);
    await writeJsonArtifact(run.artifacts.verificationPath, verification);
    await writeJsonArtifact(run.artifacts.agendaPath, normalizedAgenda);
    await writeResearchDirection(run, normalizedAgenda, now());
    await writeFile(run.artifacts.agendaMarkdownPath, `${agendaMarkdown(run, plan, normalizedAgenda)}\n`, "utf8");
    await writeJsonArtifact(run.artifacts.workPackagePath, normalizedAgenda.selectedWorkPackage);
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
      agentControlMode: runtimeLlmConfig.agentControlMode,
      autonomousRevisionPasses: autonomousRecoveryPasses,
      revisionBudgetPasses: runtimeLlmConfig.evidenceRecoveryMaxPasses
    }));
    await writeFile(run.artifacts.synthesisPath, `${synthesisMarkdown(run, plan, gathered, paperExtractions, normalizedEvidenceMatrix, normalizedSynthesis, verification)}\n`, "utf8");
    await writeFile(run.artifacts.summaryPath, `${researchSummaryMarkdown(run, plan, gathered, paperExtractions, normalizedEvidenceMatrix, normalizedSynthesis, verification)}\n`, "utf8");
    await agent.record({
      phase: "release",
      action: "write_final_artifacts",
      status: manuscriptBundle.checks.readinessStatus === "blocked" ? "blocked" : "completed",
      summary: `Final artifacts written with manuscript readiness ${manuscriptBundle.checks.readinessStatus}.`,
      artifactPaths: [
        run.artifacts.paperPath,
        run.artifacts.paperJsonPath,
        run.artifacts.manuscriptChecksPath,
        run.artifacts.qualityReportPath,
        run.artifacts.synthesisPath
      ],
      counts: {
        blockerCount: manuscriptBundle.checks.blockerCount,
        warningCount: manuscriptBundle.checks.warningCount,
        claims: normalizedSynthesis.claims.length
      }
    });
    const memoryResult = await writeMemorySnapshot(
      run,
      memoryStore,
      [
        ...buildMemoryInputs(
          run,
          plan,
          gathered,
          normalizedEvidenceMatrix,
          normalizedSynthesis.executiveSummary,
          normalizedSynthesis.themes,
          normalizedSynthesis.claims,
          verification,
          normalizedSynthesis.nextQuestions,
          null
        ),
        ...buildAgendaMemoryInputs(run, normalizedAgenda)
      ]
    );
    const literatureResult = await literatureStore.upsert(
      buildLiteratureInputs(
        run,
        plan,
        gathered,
        normalizedSynthesis.executiveSummary,
        normalizedSynthesis.themes,
        normalizedSynthesis.claims,
        normalizedSynthesis.nextQuestions
      )
    );
    await writeLiteratureSnapshot(run, literatureStore, literatureResult, gathered);

    await appendTrace(run, now, "Synthesis completed.");
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
      `Recorded ${memoryResult.recordCount} research journal records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
    );
    await appendStdout(
      run,
      `Research journal updated: ${memoryResult.recordCount} records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
    );
    await appendEvent(
      run,
      now,
      "literature",
      `Updated literature store: ${literatureResult.state.paperCount} canonical papers, ${literatureResult.state.themeCount} theme boards, ${literatureResult.state.notebookCount} review notebooks.`
    );
    await appendStdout(
      run,
      `Literature store updated: ${literatureResult.state.paperCount} canonical papers, ${literatureResult.state.themeCount} theme boards, ${literatureResult.state.notebookCount} review notebooks.`
    );

    for (const claim of normalizedSynthesis.claims.slice(0, 4)) {
      await appendEvent(run, now, "claim", summarizeClaim(claim));
      await appendStdout(run, `Claim recorded: ${summarizeClaim(claim)}`);
    }

    for (const question of normalizedSynthesis.nextQuestions) {
      await appendEvent(run, now, "next", question);
    }

    await appendEvent(run, now, "plan", `Agenda generated with ${normalizedAgenda.candidateDirections.length} candidate directions.`);

    if (normalizedAgenda.selectedWorkPackage !== null) {
      await appendEvent(
        run,
        now,
        "next",
        `Selected work package: ${normalizedAgenda.selectedWorkPackage.title}`
      );
      await appendStdout(run, `Selected work package: ${normalizedAgenda.selectedWorkPackage.title}`);
    }

    finalAgenda = normalizedAgenda;
    finalManuscriptBundle = manuscriptBundle;
    break;
    }

    if (finalAgenda === null || finalManuscriptBundle === null) {
      throw new Error("Literature review loop ended without a final agenda and manuscript bundle.");
    }

    let derivedRun: RunRecord | null = null;

    if (projectConfig.runtime.postReviewBehavior === "auto_continue") {
      derivedRun = await launchDerivedWorkPackageRun(store, runController, run, finalAgenda);

      if (derivedRun === null && agendaHasActionableWorkPackage(finalAgenda)) {
        const blockers = workPackageAutoContinueBlockers(finalAgenda);
        await appendEvent(
          run,
          now,
          "next",
          blockers.length > 0
            ? `Auto-continue skipped: ${blockers.join(" | ")}`
            : "Auto-continue was configured, but the selected work package did not satisfy the bounded safety gate."
        );
      }
    }

    const completedAt = now();
    run.job.finishedAt = completedAt;
    run.finishedAt = completedAt;
    run.job.exitCode = 0;
    run.job.signal = null;
    run.workerPid = null;
    run.status = "completed";
    run.statusMessage = derivedRun !== null
      ? `Provider-aware literature run completed and auto-launched derived work-package run ${derivedRun.id}.`
      : finalManuscriptBundle.checks.readinessStatus === "needs_more_evidence"
        ? "Provider-aware literature run completed after autonomous evidence revision, but the evidence base still needs more work."
        : finalManuscriptBundle.checks.readinessStatus === "blocked"
          ? "Provider-aware literature run completed with blockers; no full paper was released."
        : finalManuscriptBundle.checks.readinessStatus === "needs_human_review"
          ? "Provider-aware literature run completed, but manuscript checks require human review before release."
        : !agendaHasActionableWorkPackage(finalAgenda)
        ? "Provider-aware literature run completed, but no actionable bounded work package was selected."
        : projectConfig.runtime.postReviewBehavior === "confirm"
          ? "Provider-aware literature run completed and is waiting for `/continue` on the selected work package."
          : "Provider-aware literature run completed successfully.";
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
    await writeFailureDiagnostics(run, finishedAt, error);
    await appendStderr(run, run.statusMessage);
    await appendTrace(run, now, run.statusMessage);
    await appendEvent(run, now, "stderr", run.statusMessage);
    await appendEvent(run, now, "run", run.statusMessage);
    return 1;
  }
}
