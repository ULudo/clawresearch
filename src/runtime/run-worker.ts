import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ResearchBackend,
  ResearchClaim,
  ResearchPlan,
  ResearchSynthesis,
  ResearchTheme
} from "./research-backend.js";
import { createDefaultResearchBackend } from "./research-backend.js";
import {
  buildProjectMemoryContext,
  createMemoryRecordId,
  MemoryStore,
  type MemoryRecordInput
} from "./memory-store.js";
import type {
  ResearchSource,
  ResearchSourceGatherer,
  ResearchSourceGatherResult
} from "./research-sources.js";
import {
  collectResearchLocalFileHints,
  createDefaultResearchSourceGatherer
} from "./research-sources.js";
import type { ResearchBrief } from "./session-store.js";
import { RunStore, type RunRecord } from "./run-store.js";
import { appendRunEvent, type RunEventKind } from "./run-events.js";
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
    "plan-gather-synthesize"
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
  await writeFile(run.artifacts.synthesisPath, "", "utf8");
  await writeFile(run.artifacts.claimsPath, "", "utf8");
  await writeFile(run.artifacts.verificationPath, "", "utf8");
  await writeFile(run.artifacts.nextQuestionsPath, "", "utf8");
  await writeFile(run.artifacts.summaryPath, "", "utf8");
  await writeFile(run.artifacts.memoryPath, "", "utf8");
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
    `- Sources gathered: ${gathered.sources.length}`,
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
    lines.push("- No themes were extracted from the current source set.");
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

  lines.push("", "## Next-Step Questions", "");

  if (synthesis.nextQuestions.length === 0) {
    lines.push("- No next-step questions were generated.");
  } else {
    for (const question of synthesis.nextQuestions) {
      lines.push(`- ${question}`);
    }
  }

  lines.push("", "## Source Gathering Notes", "");

  for (const note of gathered.notes) {
    lines.push(`- ${note}`);
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

  lines.push("", "## Sources", "");

  for (const source of gathered.sources) {
    lines.push(`- ${source.id}: ${source.citation}`);
  }

  return lines.join("\n");
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

function relativeArtifactPath(projectRoot: string, targetPath: string): string {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath.length === 0 ? "." : relativePath;
}

function sourceRecordKey(source: ResearchSource): string {
  if (source.kind === "project_brief") {
    return [
      source.kind,
      source.title,
      source.citation,
      source.excerpt
    ].join(" | ");
  }

  return `${source.kind}:${source.locator ?? source.citation ?? source.title}`;
}

function sourceRecordId(source: ResearchSource): string {
  return createMemoryRecordId("source", sourceRecordKey(source));
}

function claimRecordKey(claim: ResearchClaim): string {
  return claim.claim;
}

function claimRecordId(claim: ResearchClaim): string {
  return createMemoryRecordId("claim", claimRecordKey(claim));
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

function artifactRecordId(key: string): string {
  return createMemoryRecordId("artifact", key);
}

function summaryRecordId(runId: string): string {
  return createMemoryRecordId("summary", `run:${runId}:summary`);
}

function ideaRecordId(key: string): string {
  return createMemoryRecordId("idea", key);
}

function relatedClaimIdsForTheme(
  theme: ResearchTheme,
  claims: ResearchClaim[]
): string[] {
  const themeSources = new Set(theme.sourceIds);

  return claims.flatMap((claim) => {
    if (claim.sourceIds.some((sourceId) => themeSources.has(sourceId))) {
      return [claimRecordId(claim)];
    }

    return [];
  });
}

function fallbackFinding(
  run: RunRecord,
  gathered: ResearchSourceGatherResult,
  summaryText: string,
  failureMessage: string | null
): ResearchTheme {
  return {
    title: failureMessage === null
      ? "Provisional finding"
      : "Evidence gap",
    summary: failureMessage
      ?? summaryText,
    sourceIds: gathered.sources
      .slice(0, 3)
      .map((source) => source.id)
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
      title: "Broaden evidence collection",
      text: `Refine terminology and expand source gathering beyond the current path before the next research pass on ${run.brief.topic ?? "this project"}.`,
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

  if (questionIds.length === 0) {
    return [{
      type: "idea",
      key: `run:${run.id}:follow-up`,
      title: "Follow-up direction",
      text: `Use this first-pass result to continue the bounded ${plan.researchMode} program around ${plan.objective}.`,
      runId: run.id,
      links: [],
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
    text: `Use the current evidence to scope the next pass around: ${questionIds.length > 0 ? "the top open question" : plan.objective}.`,
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
      title: "Source set artifact",
      text: `Saved gathered source set for ${run.id}.`,
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
    : [fallbackFinding(run, gathered, summaryText, failureMessage)];
  const summaryId = summaryRecordId(run.id);

  const sourceRecords: MemoryRecordInput[] = gathered.sources.map((source) => ({
    type: "source",
    key: sourceRecordKey(source),
    title: source.title,
    text: source.excerpt,
    runId: run.id,
    links: [],
    data: {
      citation: source.citation,
      locator: source.locator,
      sourceKind: source.kind
    }
  }));
  const sourceIds = gathered.sources.map(sourceRecordId);

  const verificationByClaimId = new Map(
    verification.verifiedClaims.map((claim) => [claim.claimId, claim])
  );
  const claimRecords: MemoryRecordInput[] = claims.map((claim) => {
    const verifiedClaim = verificationByClaimId.get(claimRecordId(claim));

    return {
      type: "claim",
      key: claimRecordKey(claim),
      title: claim.claim,
      text: claim.evidence,
      runId: run.id,
      links: claim.sourceIds.map((sourceId) => ({
        type: "supports" as const,
        targetId: sourceRecordId(
          gathered.sources.find((source) => source.id === sourceId) ?? {
            id: sourceId,
            kind: "project_brief",
            title: sourceId,
            locator: null,
            citation: sourceId,
            excerpt: sourceId
          }
        )
      })),
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
      ...theme.sourceIds.map((sourceId) => ({
        type: "derived_from" as const,
        targetId: sourceRecordId(
          gathered.sources.find((source) => source.id === sourceId) ?? {
            id: sourceId,
            kind: "project_brief",
            title: sourceId,
            locator: null,
            citation: sourceId,
            excerpt: sourceId
          }
        )
      })),
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

function evidenceSourceCount(gathered: ResearchSourceGatherResult): number {
  return gathered.sources.filter((source) => source.kind !== "project_brief").length;
}

function insufficientEvidenceNextQuestions(plan: ResearchPlan): string[] {
  return [
    "Which terminology, canonical entity names, or spelling corrections should be used to improve retrieval quality for this topic?",
    "Which databases or source families beyond the current search path should be queried next?",
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
    "The current run did not gather any evidence-bearing sources beyond the user brief, so it stopped before generating source-grounded claims.",
    "",
    "## Planned Research Mode",
    "",
    `- Mode: ${plan.researchMode}`,
    `- Objective: ${plan.objective}`,
    `- Rationale: ${plan.rationale}`,
    "",
    "## Source Gathering Notes",
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
  const memoryStore = new MemoryStore(options.projectRoot, now);
  const projectMemory = await memoryStore.load();
  const memoryContext = buildProjectMemoryContext(projectMemory, run.brief);

  try {
    run.workerPid = process.pid;
    run.status = "running";
    run.startedAt = run.startedAt ?? now();
    run.statusMessage = "Run worker started and is preparing the explicit research loop.";
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
    await appendEvent(run, now, "plan", "Plan the research mode and generate initial search queries.");
    await appendStdout(run, `Research backend: ${researchBackend.label}`);
    await appendStdout(run, `Run loop command: ${run.job.command.join(" ")}`);
    await appendStdout(
      run,
      memoryContext.available
        ? `Loaded ${memoryContext.recordCount} prior memory records into the current run context.`
        : "Loaded 0 prior memory records into the current run context."
    );
    await appendEvent(run, now, "exec", run.job.command.join(" "));
    const localFiles = await collectResearchLocalFileHints(run.projectRoot, run.brief);

    const plan = await researchBackend.planResearch({
      projectRoot: run.projectRoot,
      brief: run.brief,
      localFiles,
      memoryContext
    });

    await writeJsonArtifact(run.artifacts.planPath, plan);
    await appendTrace(run, now, `Selected research mode: ${plan.researchMode}`);
    await appendEvent(
      run,
      now,
      "summary",
      `Selected research mode ${plan.researchMode}: ${plan.objective}`
    );
    await appendStdout(run, `Selected research mode: ${plan.researchMode}`);
    await appendStdout(run, `Planning rationale: ${plan.rationale}`);
    await appendEvent(run, now, "next", "Gather local and literature sources for the planned first-pass investigation.");

    const gathered = await sourceGatherer.gather({
      projectRoot: run.projectRoot,
      brief: run.brief,
      plan,
      memoryContext
    });

    await writeJsonArtifact(run.artifacts.sourcesPath, {
      notes: gathered.notes,
      sources: gathered.sources,
      literatureReview: gathered.literatureReview ?? null
    });
    await appendTrace(run, now, `Gathered ${gathered.sources.length} sources.`);
    await appendEvent(run, now, "summary", `Gathered ${gathered.sources.length} sources for synthesis.`);

    for (const note of gathered.notes) {
      await appendStdout(run, note);
    }

    for (const source of gathered.sources.slice(0, 6)) {
      await appendEvent(run, now, "source", summarizeSource(source));
      await appendStdout(run, `Source selected: ${summarizeSource(source)}`);
    }

    if (evidenceSourceCount(gathered) === 0) {
      const nextQuestions = insufficientEvidenceNextQuestions(plan);
      const failureMessage = "Source gathering did not find evidence beyond the user brief. The run stopped before unsupported synthesis.";
      const verification = verifyResearchClaims({
        brief: run.brief,
        sources: gathered.sources,
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

    await appendEvent(run, now, "next", "Synthesize themes, claims, and next-step questions from the gathered sources.");

    const synthesis = await researchBackend.synthesizeResearch({
      projectRoot: run.projectRoot,
      brief: run.brief,
      plan,
      sources: gathered.sources
    });
    const verification = verifyResearchClaims({
      brief: run.brief,
      sources: gathered.sources,
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

    await appendTrace(run, now, "Synthesis completed.");
    await appendEvent(run, now, "summary", synthesis.executiveSummary);
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

    for (const claim of synthesis.claims.slice(0, 4)) {
      await appendEvent(run, now, "claim", summarizeClaim(claim));
      await appendStdout(run, `Claim recorded: ${summarizeClaim(claim)}`);
    }

    for (const claim of verification.verifiedClaims.slice(0, 4)) {
      await appendEvent(run, now, "verify", summarizeVerifiedClaim(claim));
    }

    for (const question of synthesis.nextQuestions.slice(0, 4)) {
      await appendEvent(run, now, "next", question);
      await appendStdout(run, `Next-step question: ${question}`);
    }

    run.job.finishedAt = now();
    run.finishedAt = now();
    run.job.exitCode = 0;
    run.job.signal = null;
    run.workerPid = null;
    run.status = "completed";
    run.statusMessage = "Minimal explicit research loop completed successfully.";
    await store.save(run);
    await appendTrace(run, now, run.statusMessage);
    await appendEvent(run, now, "run", run.statusMessage);

    return 0;
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unknown run worker failure.";

    run.status = "failed";
    run.finishedAt = now();
    run.workerPid = null;
    run.job.finishedAt = now();
    run.job.exitCode = 1;
    run.statusMessage = message;
    await store.save(run);
    await appendStderr(run, message);
    await appendTrace(run, now, `Run worker failed: ${message}`);
    await appendEvent(run, now, "stderr", message);
    await appendEvent(run, now, "run", `Run worker failed: ${message}`);
    return 1;
  }
}
