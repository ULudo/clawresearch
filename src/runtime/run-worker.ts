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
  selectedGeneralWebProviders,
  selectedProviderIdsForCategory,
  selectedScholarlySourceProviders
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
import { createDefaultResearchBackend } from "./research-backend.js";
import {
  buildEvidenceMatrix,
  briefFingerprint,
  type EvidenceMatrix,
  type EvidenceMatrixInsight,
  type PaperExtraction
} from "./research-evidence.js";
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
  paperCount: number;
  extractionCount: number;
  extractions: PaperExtraction[];
};

type ClaimsArtifact = {
  schemaVersion: number;
  runId: string;
  briefFingerprint: string;
  claimCount: number;
  claims: ResearchClaim[];
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

function paperExtractionsArtifact(
  run: RunRecord,
  paperCount: number,
  extractions: PaperExtraction[]
): PaperExtractionsArtifact {
  return {
    schemaVersion: 1,
    runId: run.id,
    briefFingerprint: briefFingerprint(run.brief),
    paperCount,
    extractionCount: extractions.length,
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
  await writeFile(run.artifacts.paperExtractionsPath, "", "utf8");
  await writeFile(run.artifacts.evidenceMatrixPath, "", "utf8");
  await writeFile(run.artifacts.synthesisPath, "", "utf8");
  await writeFile(run.artifacts.claimsPath, "", "utf8");
  await writeFile(run.artifacts.verificationPath, "", "utf8");
  await writeFile(run.artifacts.nextQuestionsPath, "", "utf8");
  await writeFile(run.artifacts.agendaPath, "", "utf8");
  await writeFile(run.artifacts.agendaMarkdownPath, "", "utf8");
  await writeFile(run.artifacts.workPackagePath, "", "utf8");
  if (run.stage === "work_package") {
    await writeFile(run.artifacts.methodPlanPath, "", "utf8");
    await writeFile(run.artifacts.executionChecklistPath, "", "utf8");
    await writeFile(run.artifacts.findingsPath, "", "utf8");
    await writeFile(run.artifacts.decisionPath, "", "utf8");
  }
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
      ? `Which of these recovery queries should be tried next: ${suggestedQueries.join(" | ")}?`
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
    ? [`One recovery retrieval pass ran, but only ${gathered.reviewedPapers.length} reviewed papers were selected for synthesis.`]
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

  const missing = selectionQuality.missingRequiredFacets.map((facet) => facet.label).slice(0, 5);
  const backgroundOnly = selectionQuality.backgroundOnlyFacets.map((facet) => facet.label).slice(0, 3);
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

export async function runDetachedJobWorker(options: WorkerOptions): Promise<number> {
  const now = options.now ?? (() => new Date().toISOString());
  const store = new RunStore(options.projectRoot, options.version, now);
  const run = await store.load(options.runId);
  const runController = options.runController ?? createDefaultRunController();
  const researchBackend = options.researchBackend ?? createDefaultResearchBackend();
  const sourceGatherer = options.sourceGatherer ?? createDefaultResearchSourceGatherer();
  const projectConfigStore = new ProjectConfigStore(options.projectRoot, now);
  const projectConfig = await projectConfigStore.load();
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
      generalWebProviderIds: generalWebProviders,
      projectFilesEnabled: localEnabled,
      credentials
    });
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
      scholarlyProviders,
      generalWebProviders,
      routing: gathered.routing,
      authStatus: gathered.authStatus,
      retrievalDiagnostics: gathered.retrievalDiagnostics ?? null,
      notes: gathered.notes,
      rawSources: gathered.sources,
      reviewWorkflow: gathered.reviewWorkflow,
      selectionQuality: gathered.selectionQuality ?? null,
      mergeDiagnostics: gathered.mergeDiagnostics,
      literatureReview: gathered.literatureReview ?? null
    });
    await appendTrace(run, now, `Gathered ${gathered.sources.length} raw sources and ${gathered.canonicalPapers.length} canonical papers.`);
    await appendEvent(run, now, "summary", `Gathered ${gathered.canonicalPapers.length} canonical papers for synthesis.`);
    await appendEvent(
      run,
      now,
      "literature",
      `Review workflow: title ${gathered.reviewWorkflow.counts.titleScreened}, abstract ${gathered.reviewWorkflow.counts.abstractScreened}, full-text ${gathered.reviewWorkflow.counts.fulltextScreened}, included ${gathered.reviewWorkflow.counts.included}, selected ${gathered.reviewWorkflow.counts.selectedForSynthesis}.`
    );

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
        ? "Literature retrieval did not retain any canonical papers that could ground synthesis. The run stopped before unsupported synthesis."
        : "The review workflow did not retain any sufficiently reviewed papers for synthesis. The run stopped before unsupported synthesis.";
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
        insufficientEvidenceAgenda(run, plan, nextQuestions, failureMessage),
        gathered,
        evidenceMatrix
      );
      await writeJsonArtifact(run.artifacts.agendaPath, agenda);
      await writeResearchDirection(run, agenda, now());
      await writeFile(run.artifacts.agendaMarkdownPath, `${agendaMarkdown(run, plan, agenda)}\n`, "utf8");
      await writeJsonArtifact(run.artifacts.workPackagePath, null);
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
        [
          ...buildMemoryInputs(
            run,
            plan,
            gathered,
            evidenceMatrix,
            failureMessage,
            [],
            [],
            verification,
            nextQuestions,
            failureMessage
          ),
          ...buildAgendaMemoryInputs(run, agenda)
        ]
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

      await appendEvent(run, now, "plan", "Agenda generation completed with a hold because the evidence base remained too thin.");
      await appendStdout(run, `Agenda hold: ${agenda.recommendedHumanDecision}`);

      run.job.finishedAt = now();
      run.finishedAt = now();
      run.job.exitCode = 0;
      run.job.signal = null;
      run.workerPid = null;
      run.status = "completed";
      run.statusMessage = "Literature review completed, but the agenda is on hold because the evidence base was too thin.";
      await store.save(run);
      await appendEvent(run, now, "run", run.statusMessage);
      return 0;
    }

    await appendEvent(run, now, "next", "Extract structured paper records from the reviewed paper set.");

    const extractedPapers = await researchBackend.extractReviewedPapers({
      projectRoot: run.projectRoot,
      runId: run.id,
      brief: run.brief,
      plan,
      papers: canonicalReviewedPapers,
      literatureContext
    });
    const paperExtractions = completePaperExtractions(
      run,
      canonicalReviewedPapers,
      remapPaperExtractions(extractedPapers, canonicalIdByAnyPaperId)
    );

    await writeJsonArtifact(run.artifacts.paperExtractionsPath, paperExtractionsArtifact(run, canonicalReviewedPapers.length, paperExtractions));
    await appendEvent(run, now, "summary", `Extracted ${paperExtractions.length} paper records from the reviewed set.`);
    await appendStdout(run, `Paper extractions written: ${paperExtractions.length}`);

    await appendEvent(run, now, "next", "Build the cross-paper evidence matrix from the reviewed extractions.");

    const evidenceMatrix = buildEvidenceMatrix({
      runId: run.id,
      brief: run.brief,
      paperExtractions
    });
    const normalizedEvidenceMatrix = remapEvidenceMatrix(evidenceMatrix, canonicalIdByAnyPaperId);

    await writeJsonArtifact(run.artifacts.evidenceMatrixPath, normalizedEvidenceMatrix);
    await appendStdout(run, `Evidence matrix rows: ${normalizedEvidenceMatrix.rowCount}`);

    await appendEvent(run, now, "next", "Synthesize themes, claims, and next-step questions from the evidence matrix.");

    const synthesis = await researchBackend.synthesizeResearch({
      projectRoot: run.projectRoot,
      brief: run.brief,
      plan,
      papers: canonicalReviewedPapers,
      paperExtractions,
      evidenceMatrix: normalizedEvidenceMatrix,
      selectionQuality: gathered.selectionQuality ?? null,
      literatureContext
    });
    const normalizedSynthesis = remapSynthesisSourceIds(synthesis, canonicalIdByAnyPaperId);
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
    });
    const normalizedAgenda = agendaWithRetrievalHoldReasons(
      remapAgendaSourceIds(agenda, canonicalIdByAnyPaperId),
      gathered,
      normalizedEvidenceMatrix
    );

    await writeJsonArtifact(run.artifacts.claimsPath, claimsArtifact(run, normalizedSynthesis.claims));
    await writeJsonArtifact(run.artifacts.nextQuestionsPath, normalizedSynthesis.nextQuestions);
    await writeJsonArtifact(run.artifacts.verificationPath, verification);
    await writeJsonArtifact(run.artifacts.agendaPath, normalizedAgenda);
    await writeResearchDirection(run, normalizedAgenda, now());
    await writeFile(run.artifacts.agendaMarkdownPath, `${agendaMarkdown(run, plan, normalizedAgenda)}\n`, "utf8");
    await writeJsonArtifact(run.artifacts.workPackagePath, normalizedAgenda.selectedWorkPackage);
    await writeFile(run.artifacts.synthesisPath, `${synthesisMarkdown(run, plan, gathered, paperExtractions, normalizedEvidenceMatrix, normalizedSynthesis, verification)}\n`, "utf8");
    await writeFile(run.artifacts.summaryPath, `${researchSummaryMarkdown(run, plan, gathered, paperExtractions, normalizedEvidenceMatrix, normalizedSynthesis, verification)}\n`, "utf8");
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
    await appendEvent(run, now, "verify", verification.summary);
    await appendStdout(run, `Verification: ${verification.summary}`);
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

    let derivedRun: RunRecord | null = null;

    if (projectConfig.runtime.postReviewBehavior === "auto_continue") {
      derivedRun = await launchDerivedWorkPackageRun(store, runController, run, normalizedAgenda);

      if (derivedRun === null && agendaHasActionableWorkPackage(normalizedAgenda)) {
        const blockers = workPackageAutoContinueBlockers(normalizedAgenda);
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

    run.job.finishedAt = now();
    run.finishedAt = now();
    run.job.exitCode = 0;
    run.job.signal = null;
    run.workerPid = null;
    run.status = "completed";
    run.statusMessage = derivedRun !== null
      ? `Provider-aware literature run completed and auto-launched derived work-package run ${derivedRun.id}.`
      : !agendaHasActionableWorkPackage(normalizedAgenda)
        ? "Provider-aware literature run completed, but the agenda remains on hold for human review."
        : projectConfig.runtime.postReviewBehavior === "confirm"
          ? "Provider-aware literature run completed and is waiting for `/continue` on the selected work package."
          : "Provider-aware literature run completed successfully.";
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
