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
  createMemoryRecordId,
  MemoryStore,
  type MemoryRecordInput
} from "./memory-store.js";
import {
  authStatesForSelectedProviders,
  formatSelectedLiteratureProviders,
  ProjectConfigStore
} from "./project-config-store.js";
import type {
  ResearchBackend,
  ResearchClaim,
  ResearchPlan,
  ResearchSynthesis,
  ResearchTheme
} from "./research-backend.js";
import { createDefaultResearchBackend } from "./research-backend.js";
import {
  collectResearchLocalFileHints,
  createDefaultResearchSourceGatherer,
  type ResearchSource,
  type ResearchSourceGatherer,
  type ResearchSourceGatherResult
} from "./research-sources.js";
import { appendRunEvent, type RunEventKind } from "./run-events.js";
import { RunStore, type RunRecord } from "./run-store.js";
import type { ResearchBrief } from "./session-store.js";
import {
  verifyResearchClaims,
  type VerificationReport,
  type VerifiedClaim
} from "./verifier.js";

type WorkerOptions = {
  projectRoot: string;
  runId: string;
  version: string;
  now?: () => string;
  researchBackend?: ResearchBackend;
  sourceGatherer?: ResearchSourceGatherer;
};

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

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

async function writeRunArtifacts(run: RunRecord): Promise<void> {
  await mkdir(run.artifacts.runDirectory, { recursive: true });
  await writeJsonArtifact(run.artifacts.briefPath, run.brief);
  await writeFile(run.artifacts.tracePath, "", "utf8");
  await writeFile(run.artifacts.eventsPath, "", "utf8");
  await writeFile(run.artifacts.stdoutPath, "", "utf8");
  await writeFile(run.artifacts.stderrPath, "", "utf8");
  await writeFile(run.artifacts.planPath, "", "utf8");
  await writeFile(run.artifacts.sourcesPath, "", "utf8");
  await writeFile(run.artifacts.literaturePath, "", "utf8");
  await writeFile(run.artifacts.synthesisPath, "", "utf8");
  await writeFile(run.artifacts.claimsPath, "", "utf8");
  await writeFile(run.artifacts.verificationPath, "", "utf8");
  await writeFile(run.artifacts.nextQuestionsPath, "", "utf8");
  await writeFile(run.artifacts.summaryPath, "", "utf8");
  await writeFile(run.artifacts.memoryPath, "", "utf8");
}

function relativeArtifactPath(projectRoot: string, targetPath: string): string {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath.length === 0 ? "." : relativePath;
}

function summarizeSource(source: ResearchSource): string {
  const locator = source.locator ?? "no external locator";
  return `${source.id}: ${source.title} (${source.kind}; ${locator})`;
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

function researchSummaryMarkdown(
  run: RunRecord,
  plan: ResearchPlan,
  gathered: ResearchSourceGatherResult,
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
    "",
    "## Executive Summary",
    "",
    synthesis.executiveSummary,
    "",
    "## Verification",
    "",
    verification.summary,
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

  lines.push("", "## Canonical Papers", "");

  if (gathered.canonicalPapers.length === 0) {
    lines.push("- No canonical papers were retained.");
  } else {
    for (const paper of gathered.canonicalPapers) {
      lines.push(`- ${paper.id}: ${paper.citation} [${paper.accessMode}]`);
    }
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

function paperRecordKey(paper: CanonicalPaper): string {
  return `paper:${paper.id}`;
}

function paperRecordId(paper: CanonicalPaper): string {
  return createMemoryRecordId("source", paperRecordKey(paper));
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
    sourceIds: gathered.canonicalPapers.slice(0, 3).map((paper) => paper.id)
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
      links: questionIds.map((targetId) => ({
        type: "suggests" as const,
        targetId
      })),
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
    links: questionIds.slice(0, 2).map((targetId) => ({
      type: "suggests" as const,
      targetId
    })),
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
      title: "Canonical literature artifact",
      text: `Saved canonical paper cards and access state for ${run.id}.`,
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
      path: run.artifacts.nextQuestionsPath,
      title: "Next questions artifact",
      text: `Saved follow-up questions for ${run.id}.`,
      linkIds: questionIds
    },
    {
      path: run.artifacts.summaryPath,
      title: "Run summary artifact",
      text: `Saved run summary for ${run.id}.`,
      linkIds: [summaryId]
    },
    {
      path: run.artifacts.memoryPath,
      title: "Memory snapshot artifact",
      text: `Saved structured memory snapshot for ${run.id}.`,
      linkIds: [summaryId]
    }
  ];

  return artifactSpecs.map((artifact) => ({
    type: "artifact",
    key: relativeArtifactPath(run.projectRoot, artifact.path),
    title: artifact.title,
    text: artifact.text,
    runId: run.id,
    links: artifact.linkIds.map((targetId) => ({
      type: "contains" as const,
      targetId
    })),
    data: {
      path: relativeArtifactPath(run.projectRoot, artifact.path)
    }
  }));
}

function buildMemoryInputs(
  run: RunRecord,
  plan: ResearchPlan,
  gathered: ResearchSourceGatherResult,
  summaryText: string,
  themes: ResearchTheme[],
  claims: ResearchClaim[],
  verification: VerificationReport,
  nextQuestions: string[],
  failureMessage: string | null
): MemoryRecordInput[] {
  const effectiveThemes = themes.length > 0
    ? themes
    : [fallbackFinding(gathered, summaryText, failureMessage)];
  const summaryId = summaryRecordId(run.id);

  const sourceRecords: MemoryRecordInput[] = gathered.canonicalPapers.map((paper) => ({
    type: "source",
    key: paperRecordKey(paper),
    title: paper.title,
    text: paper.abstract ?? `${paper.citation} [${paper.accessMode}]`,
    runId: run.id,
    links: [],
    data: {
      citation: paper.citation,
      locator: paper.bestAccessUrl,
      sourceKind: "canonical_paper",
      accessMode: paper.accessMode,
      providerIds: paper.discoveredVia.join(", ")
    }
  }));
  const sourceIds = gathered.canonicalPapers.map(paperRecordId);

  const verificationByClaimId = new Map(
    verification.verifiedClaims.map((claim) => [claim.claimId, claim])
  );
  const claimRecords: MemoryRecordInput[] = claims.map((claim) => {
    const verifiedClaim = verificationByClaimId.get(claimRecordId(claim));

    return {
      type: "claim",
      key: claim.claim,
      title: claim.claim,
      text: claim.evidence,
      runId: run.id,
      links: claim.sourceIds.flatMap((sourceId) => {
        const paper = gathered.canonicalPapers.find((candidate) => candidate.id === sourceId);
        return paper === undefined
          ? []
          : [{
            type: "supports" as const,
            targetId: paperRecordId(paper)
          }];
      }),
      data: {
        sourceIds: claim.sourceIds,
        supportStatus: verifiedClaim?.supportStatus ?? "unverified",
        confidence: verifiedClaim?.confidence ?? "unknown",
        verificationNotes: verifiedClaim?.verificationNotes ?? []
      }
    };
  });
  const claimIds = claims.map(claimRecordId);

  const findingRecords: MemoryRecordInput[] = effectiveThemes.map((theme) => ({
    type: "finding",
    key: findingRecordKey(theme),
    title: theme.title,
    text: theme.summary,
    runId: run.id,
    links: [
      ...theme.sourceIds.flatMap((sourceId) => {
        const paper = gathered.canonicalPapers.find((candidate) => candidate.id === sourceId);
        return paper === undefined
          ? []
          : [{
            type: "derived_from" as const,
            targetId: paperRecordId(paper)
          }];
      }),
      ...relatedClaimIdsForTheme(theme, claims).map((targetId) => ({
        type: "related_to" as const,
        targetId
      }))
    ],
    data: {
      sourceIds: theme.sourceIds
    }
  }));
  const findingIds = effectiveThemes.map(findingRecordId);

  const questionRecords: MemoryRecordInput[] = nextQuestions.map((question) => ({
    type: "question",
    key: question,
    title: question,
    text: question,
    runId: run.id,
    links: findingIds.slice(0, 3).map((targetId) => ({
      type: "raises" as const,
      targetId
    })),
    data: {
      researchMode: plan.researchMode
    }
  }));
  const questionIds = nextQuestions.map(questionRecordId);

  const ideaRecords = buildIdeaRecords(run, plan, questionIds, failureMessage);
  const ideaIds = ideaRecords.map((record) => ideaRecordId(record.key));

  const summaryRecord: MemoryRecordInput = {
    type: "summary",
    key: `run:${run.id}:summary`,
    title: `Run ${run.id} summary`,
    text: summaryText,
    runId: run.id,
    links: [
      ...findingIds.map((targetId) => ({
        type: "summarizes" as const,
        targetId
      })),
      ...claimIds.map((targetId) => ({
        type: "summarizes" as const,
        targetId
      })),
      ...questionIds.map((targetId) => ({
        type: "summarizes" as const,
        targetId
      })),
      ...ideaIds.map((targetId) => ({
        type: "summarizes" as const,
        targetId
      }))
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
    sourceIds,
    claimIds,
    findingIds,
    questionIds,
    ideaIds,
    summaryId
  );

  return [
    ...sourceRecords,
    ...claimRecords,
    ...findingRecords,
    ...questionRecords,
    ...ideaRecords,
    summaryRecord,
    ...artifactRecords
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
  const storePaperIdByRunPaperId = new Map(
    gathered.canonicalPapers.map((paper) => [paper.id, createLiteratureEntityId("paper", paper.key)])
  );
  const themeInputs: LiteratureThemeInput[] = themes.map((theme) => ({
    key: theme.title,
    title: theme.title,
    summary: theme.summary,
    runId: run.id,
    paperIds: theme.sourceIds.flatMap((sourceId) => {
      const storePaperId = storePaperIdByRunPaperId.get(sourceId);
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
    screeningStage: paper.screeningStage,
    screeningDecision: paper.screeningDecision,
    screeningRationale: paper.screeningRationale,
    accessErrors: paper.accessErrors,
    runId: run.id,
    linkedThemeIds: themeInputs
      .filter((theme) => theme.paperIds.includes(storePaperIdByRunPaperId.get(paper.id) ?? paper.id))
      .map((theme) => createLiteratureEntityId("theme", theme.key)),
    linkedClaimIds: claims.flatMap((claim) => claim.sourceIds.includes(paper.id)
      ? [claimRecordId(claim)]
      : [])
  }));
  const notebook: LiteratureNotebookInput = {
    key: `run:${run.id}`,
    title: `Literature notebook for ${run.id}`,
    runId: run.id,
    objective: plan.objective,
    summary: summaryText,
    paperIds: gathered.canonicalPapers.map((paper) => storePaperIdByRunPaperId.get(paper.id) ?? paper.id),
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
  await writeJsonArtifact(run.artifacts.literaturePath, {
    storePath: relativeArtifactPath(run.projectRoot, literatureStore.filePath),
    paperCount: gathered.canonicalPapers.length,
    papers: gathered.canonicalPapers,
    mergeDiagnostics: gathered.mergeDiagnostics,
    authStatus: gathered.authStatus,
    inserted: result.inserted,
    updated: result.updated,
    stateCounts: {
      papers: result.state.paperCount,
      themes: result.state.themeCount,
      notebooks: result.state.notebookCount
    }
  });
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

function insufficientEvidenceNextQuestions(plan: ResearchPlan): string[] {
  return [
    "Which terminology, entity names, or domain cues should be refined to improve scholarly retrieval quality?",
    "Which provider configuration or credentials are still limiting access to relevant papers?",
    `Which of these planned queries should be refined first: ${plan.searchQueries.slice(0, 3).join(" | ") || "no queries were generated"}?`
  ];
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
    "The current run did not retain any readable or screenable canonical papers, so it stopped before generating paper-grounded claims.",
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

export async function runDetachedJobWorker(options: WorkerOptions): Promise<number> {
  const now = options.now ?? (() => new Date().toISOString());
  const store = new RunStore(options.projectRoot, options.version, now);
  const run = await store.load(options.runId);
  const researchBackend = options.researchBackend ?? createDefaultResearchBackend();
  const sourceGatherer = options.sourceGatherer ?? createDefaultResearchSourceGatherer();
  const projectConfigStore = new ProjectConfigStore(options.projectRoot, now);
  const projectConfig = await projectConfigStore.load();
  const literatureStore = new LiteratureStore(options.projectRoot, now);
  const projectLiterature = await literatureStore.load();
  const literatureContext = buildLiteratureContext(projectLiterature, run.brief);
  const memoryStore = new MemoryStore(options.projectRoot, now);
  const projectMemory = await memoryStore.load();
  const memoryContext = buildProjectMemoryContext(projectMemory, run.brief);
  const scholarlyProviders = projectConfig.sources.scholarly.selectedProviderIds;
  const backgroundProviders = projectConfig.sources.background.selectedProviderIds;
  const localEnabled = projectConfig.sources.local.projectFilesEnabled;
  const providerAuthStates = authStatesForSelectedProviders(projectConfig);

  try {
    run.workerPid = process.pid;
    run.status = "running";
    run.startedAt = run.startedAt ?? now();
    run.statusMessage = "Run worker started and is preparing the provider-aware research loop.";
    run.job.command = runLoopCommand(run.id);
    run.job.cwd = run.projectRoot;
    run.job.pid = process.pid;
    run.job.startedAt = now();
    await store.save(run);

    await writeRunArtifacts(run);
    await writeFile(run.artifacts.summaryPath, `${markdownBrief(run.brief)}\n`, "utf8");

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
    await appendEvent(run, now, "plan", "Plan the research mode and generate initial retrieval queries.");
    await appendStdout(run, `Research backend: ${researchBackend.label}`);
    await appendStdout(run, `Run loop command: ${run.job.command.join(" ")}`);
    await appendStdout(run, `Selected scholarly providers: ${formatSelectedLiteratureProviders(scholarlyProviders)}`);
    await appendStdout(run, `Selected background providers: ${formatSelectedLiteratureProviders(backgroundProviders)}`);
    await appendStdout(run, `Local project files: ${localEnabled ? "enabled" : "disabled"}`);

    for (const authState of providerAuthStates) {
      await appendStdout(
        run,
        `Provider auth: ${authState.definition.label} -> ${authState.status}${authState.authRef === null ? "" : ` (${authState.authRef})`}`
      );
    }

    const localFiles = await collectResearchLocalFileHints(run.projectRoot, run.brief);

    const plan = await researchBackend.planResearch({
      projectRoot: run.projectRoot,
      brief: run.brief,
      localFiles,
      memoryContext,
      literatureContext
    });

    await writeJsonArtifact(run.artifacts.planPath, plan);
    await appendTrace(run, now, `Selected research mode: ${plan.researchMode}`);
    await appendEvent(run, now, "summary", `Selected research mode ${plan.researchMode}: ${plan.objective}`);
    await appendStdout(run, `Selected research mode: ${plan.researchMode}`);
    await appendStdout(run, `Planning rationale: ${plan.rationale}`);
    await appendEvent(run, now, "next", "Gather provider-aware scholarly sources and merge them into canonical papers.");

    const gathered = await sourceGatherer.gather({
      projectRoot: run.projectRoot,
      brief: run.brief,
      plan,
      memoryContext,
      literatureContext,
      scholarlyProviderIds: scholarlyProviders,
      backgroundProviderIds: backgroundProviders,
      projectFilesEnabled: localEnabled,
      authRefs: projectConfig.sources.authRefs
    });

    await writeJsonArtifact(run.artifacts.sourcesPath, {
      scholarlyProviders,
      backgroundProviders,
      projectFilesEnabled: localEnabled,
      routing: gathered.routing,
      authStatus: gathered.authStatus,
      notes: gathered.notes,
      rawSources: gathered.sources,
      mergeDiagnostics: gathered.mergeDiagnostics,
      literatureReview: gathered.literatureReview ?? null
    });
    await appendTrace(run, now, `Gathered ${gathered.sources.length} raw sources and ${gathered.canonicalPapers.length} canonical papers.`);
    await appendEvent(run, now, "summary", `Gathered ${gathered.canonicalPapers.length} canonical papers for synthesis.`);

    for (const note of gathered.notes) {
      await appendStdout(run, note);
    }

    for (const source of gathered.sources.slice(0, 6)) {
      await appendEvent(run, now, "source", summarizeSource(source));
      await appendStdout(run, `Source selected: ${summarizeSource(source)}`);
    }

    if (gathered.canonicalPapers.length === 0) {
      const nextQuestions = insufficientEvidenceNextQuestions(plan);
      const failureMessage = "Literature retrieval did not retain any canonical papers that could ground synthesis. The run stopped before unsupported synthesis.";
      const verification = verifyResearchClaims({
        brief: run.brief,
        papers: [],
        claims: []
      });

      await writeJsonArtifact(run.artifacts.claimsPath, []);
      await writeJsonArtifact(run.artifacts.verificationPath, verification);
      await writeJsonArtifact(run.artifacts.nextQuestionsPath, nextQuestions);
      await writeFile(
        run.artifacts.synthesisPath,
        `${insufficientEvidenceSynthesisMarkdown(run, plan, gathered, nextQuestions, failureMessage)}\n`,
        "utf8"
      );
      await writeFile(
        run.artifacts.summaryPath,
        [
          "# Run Summary",
          "",
          `- Topic: ${run.brief.topic ?? "<missing>"}`,
          `- Research mode: ${plan.researchMode}`,
          `- Objective: ${plan.objective}`,
          "",
          failureMessage
        ].join("\n"),
        "utf8"
      );
      const memoryResult = await writeMemorySnapshot(
        run,
        memoryStore,
        buildMemoryInputs(
          run,
          plan,
          gathered,
          failureMessage,
          [],
          [],
          verification,
          nextQuestions,
          failureMessage
        )
      );
      const literatureResult = await literatureStore.upsert(
        buildLiteratureInputs(
          run,
          plan,
          gathered,
          failureMessage,
          [],
          [],
          nextQuestions
        )
      );
      await writeLiteratureSnapshot(run, literatureStore, literatureResult, gathered);

      await appendStderr(run, failureMessage);
      await appendTrace(run, now, failureMessage);
      await appendEvent(run, now, "summary", failureMessage);
      await appendEvent(run, now, "verify", verification.summary);
      await appendStdout(run, `Verification: ${verification.summary}`);
      await appendEvent(
        run,
        now,
        "memory",
        `Recorded ${memoryResult.recordCount} structured memory records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
      );
      await appendStdout(
        run,
        `Structured memory updated: ${memoryResult.recordCount} records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
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

      run.job.finishedAt = now();
      run.finishedAt = now();
      run.job.exitCode = 1;
      run.job.signal = null;
      run.workerPid = null;
      run.status = "failed";
      run.statusMessage = failureMessage;
      await store.save(run);
      await appendEvent(run, now, "run", failureMessage);
      return 1;
    }

    await appendEvent(run, now, "next", "Synthesize themes, claims, and next-step questions from the canonical paper set.");

    const synthesis = await researchBackend.synthesizeResearch({
      projectRoot: run.projectRoot,
      brief: run.brief,
      plan,
      papers: gathered.canonicalPapers,
      literatureContext
    });
    const verification = verifyResearchClaims({
      brief: run.brief,
      papers: gathered.canonicalPapers,
      claims: synthesis.claims
    });

    await writeJsonArtifact(run.artifacts.claimsPath, synthesis.claims);
    await writeJsonArtifact(run.artifacts.nextQuestionsPath, synthesis.nextQuestions);
    await writeJsonArtifact(run.artifacts.verificationPath, verification);
    await writeFile(run.artifacts.synthesisPath, `${synthesisMarkdown(run, plan, gathered, synthesis, verification)}\n`, "utf8");
    await writeFile(run.artifacts.summaryPath, `${researchSummaryMarkdown(run, plan, gathered, synthesis, verification)}\n`, "utf8");
    const memoryResult = await writeMemorySnapshot(
      run,
      memoryStore,
      buildMemoryInputs(
        run,
        plan,
        gathered,
        synthesis.executiveSummary,
        synthesis.themes,
        synthesis.claims,
        verification,
        synthesis.nextQuestions,
        null
      )
    );
    const literatureResult = await literatureStore.upsert(
      buildLiteratureInputs(
        run,
        plan,
        gathered,
        synthesis.executiveSummary,
        synthesis.themes,
        synthesis.claims,
        synthesis.nextQuestions
      )
    );
    await writeLiteratureSnapshot(run, literatureStore, literatureResult, gathered);

    await appendTrace(run, now, "Synthesis completed.");
    await appendEvent(run, now, "summary", synthesis.executiveSummary);
    await appendEvent(run, now, "verify", verification.summary);
    await appendStdout(run, `Verification: ${verification.summary}`);
    for (const verifiedClaim of verification.verifiedClaims.slice(0, 4)) {
      await appendStdout(run, `Verification detail: ${summarizeVerifiedClaim(verifiedClaim)}`);
    }
    await appendEvent(
      run,
      now,
      "memory",
      `Recorded ${memoryResult.recordCount} structured memory records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
    );
    await appendStdout(
      run,
      `Structured memory updated: ${memoryResult.recordCount} records (${memoryResult.inserted} new, ${memoryResult.updated} updated).`
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

    for (const claim of synthesis.claims.slice(0, 4)) {
      await appendEvent(run, now, "claim", summarizeClaim(claim));
      await appendStdout(run, `Claim recorded: ${summarizeClaim(claim)}`);
    }

    for (const question of synthesis.nextQuestions) {
      await appendEvent(run, now, "next", question);
    }

    run.job.finishedAt = now();
    run.finishedAt = now();
    run.job.exitCode = 0;
    run.job.signal = null;
    run.workerPid = null;
    run.status = "completed";
    run.statusMessage = "Provider-aware literature run completed successfully.";
    await store.save(run);
    await appendEvent(run, now, "run", run.statusMessage);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.job.finishedAt = now();
    run.finishedAt = now();
    run.job.exitCode = 1;
    run.job.signal = null;
    run.workerPid = null;
    run.status = "failed";
    run.statusMessage = `Run worker failed: ${message}`;
    await store.save(run);
    await appendStderr(run, run.statusMessage);
    await appendTrace(run, now, run.statusMessage);
    await appendEvent(run, now, "stderr", run.statusMessage);
    await appendEvent(run, now, "run", run.statusMessage);
    return 1;
  }
}
