import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runtimeDirectoryPath,
  type ResearchBrief
} from "./session-store.js";
import type { ResearchAgenda } from "./research-backend.js";

const runSchemaVersion = 1;

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type RunStage = "literature_review";

export type RunJobRecord = {
  command: string[];
  launchCommand: string[] | null;
  cwd: string;
  pid: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
};

export type RunArtifactRecord = {
  runDirectory: string;
  tracePath: string;
  eventsPath: string;
  stdoutPath: string;
  stderrPath: string;
  agentStatePath: string;
  agentStepsPath: string;
  briefPath: string;
  planPath: string;
  sourcesPath: string;
  literaturePath: string;
  reviewProtocolPath: string;
  reviewProtocolMarkdownPath: string;
  criticProtocolReviewPath: string;
  criticSourceSelectionPath: string;
  criticEvidenceReviewPath: string;
  criticReleaseReviewPath: string;
  paperExtractionsPath: string;
  evidenceMatrixPath: string;
  synthesisPath: string;
  synthesisJsonPath: string;
  claimsPath: string;
  verificationPath: string;
  paperOutlinePath: string;
  paperPath: string;
  paperJsonPath: string;
  referencesPath: string;
  manuscriptChecksPath: string;
  qualityReportPath: string;
  nextQuestionsPath: string;
  agendaPath: string;
  agendaMarkdownPath: string;
  summaryPath: string;
  memoryPath: string;
};

export type RunRecord = {
  schemaVersion: number;
  appVersion: string;
  id: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  stage: RunStage;
  statusMessage: string | null;
  brief: ResearchBrief;
  workerPid: number | null;
  job: RunJobRecord;
  artifacts: RunArtifactRecord;
};

export type ResearchDirectionState = ResearchAgenda & {
  schemaVersion: number;
  sourceRunId: string | null;
  sourceRunStage: RunStage | null;
  sourceRunAgendaPath: string | null;
  acceptedAt: string;
};

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === "string" ? [entry] : [])
    : [];
}

function relativeProjectPath(projectRoot: string, targetPath: string): string {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath.length === 0 ? "." : relativePath;
}

export function createResearchDirectionState(
  agenda: ResearchAgenda,
  run: RunRecord,
  acceptedAt: string,
  options: {
    sourceRun?: RunRecord | null;
  } = {}
): ResearchDirectionState {
  const sourceRun = options.sourceRun ?? run;

  return {
    ...agenda,
    schemaVersion: 1,
    sourceRunId: sourceRun.id,
    sourceRunStage: sourceRun.stage,
    sourceRunAgendaPath: relativeProjectPath(run.projectRoot, sourceRun.artifacts.agendaPath),
    acceptedAt
  };
}

function normalizeBrief(raw: unknown): ResearchBrief {
  const brief = asObject(raw);

  return {
    topic: readString(brief.topic),
    researchQuestion: readString(brief.researchQuestion),
    researchDirection: readString(brief.researchDirection),
    successCriterion: readString(brief.successCriterion)
  };
}

function sanitizeTimestampForId(timestamp: string): string {
  return timestamp
    .replace(/[:-]/g, "")
    .replace(/\.(\d{3})Z$/, "$1z")
    .replace("T", "-");
}

function createRunId(timestamp: string): string {
  return `run-${sanitizeTimestampForId(timestamp)}`;
}

export function runsDirectoryPath(projectRoot: string): string {
  return path.join(runtimeDirectoryPath(projectRoot), "runs");
}

export function runDirectoryPath(projectRoot: string, runId: string): string {
  return path.join(runsDirectoryPath(projectRoot), runId);
}

export function runFilePath(projectRoot: string, runId: string): string {
  return path.join(runDirectoryPath(projectRoot, runId), "run.json");
}

export function researchDirectionPath(projectRoot: string): string {
  return path.join(runtimeDirectoryPath(projectRoot), "research-direction.json");
}

function createRunArtifacts(projectRoot: string, runId: string): RunArtifactRecord {
  const runDirectory = runDirectoryPath(projectRoot, runId);

  return {
    runDirectory,
    tracePath: path.join(runDirectory, "trace.log"),
    eventsPath: path.join(runDirectory, "events.jsonl"),
    stdoutPath: path.join(runDirectory, "stdout.log"),
    stderrPath: path.join(runDirectory, "stderr.log"),
    agentStatePath: path.join(runDirectory, "agent-state.json"),
    agentStepsPath: path.join(runDirectory, "agent-steps.jsonl"),
    briefPath: path.join(runDirectory, "brief.json"),
    planPath: path.join(runDirectory, "plan.json"),
    sourcesPath: path.join(runDirectory, "sources.json"),
    literaturePath: path.join(runDirectory, "literature-review.json"),
    reviewProtocolPath: path.join(runDirectory, "review-protocol.json"),
    reviewProtocolMarkdownPath: path.join(runDirectory, "review-protocol.md"),
    criticProtocolReviewPath: path.join(runDirectory, "critic-protocol-review.json"),
    criticSourceSelectionPath: path.join(runDirectory, "critic-source-selection.json"),
    criticEvidenceReviewPath: path.join(runDirectory, "critic-evidence-review.json"),
    criticReleaseReviewPath: path.join(runDirectory, "critic-release-review.json"),
    paperExtractionsPath: path.join(runDirectory, "paper-extractions.json"),
    evidenceMatrixPath: path.join(runDirectory, "evidence-matrix.json"),
    synthesisPath: path.join(runDirectory, "synthesis.md"),
    synthesisJsonPath: path.join(runDirectory, "synthesis.json"),
    claimsPath: path.join(runDirectory, "claims.json"),
    verificationPath: path.join(runDirectory, "verification.json"),
    paperOutlinePath: path.join(runDirectory, "paper-outline.json"),
    paperPath: path.join(runDirectory, "paper.md"),
    paperJsonPath: path.join(runDirectory, "paper.json"),
    referencesPath: path.join(runDirectory, "references.json"),
    manuscriptChecksPath: path.join(runDirectory, "manuscript-checks.json"),
    qualityReportPath: path.join(runDirectory, "quality-report.json"),
    nextQuestionsPath: path.join(runDirectory, "next-questions.json"),
    agendaPath: path.join(runDirectory, "agenda.json"),
    agendaMarkdownPath: path.join(runDirectory, "agenda.md"),
    summaryPath: path.join(runDirectory, "summary.md"),
    memoryPath: path.join(runtimeDirectoryPath(projectRoot), "workspace.sqlite")
  };
}

function mergeRunArtifacts(raw: unknown, projectRoot: string, runId: string): RunArtifactRecord {
  const artifacts = asObject(raw);
  const defaults = createRunArtifacts(projectRoot, runId);

  return {
    runDirectory: readString(artifacts.runDirectory) ?? defaults.runDirectory,
    tracePath: readString(artifacts.tracePath) ?? defaults.tracePath,
    eventsPath: readString(artifacts.eventsPath) ?? defaults.eventsPath,
    stdoutPath: readString(artifacts.stdoutPath) ?? defaults.stdoutPath,
    stderrPath: readString(artifacts.stderrPath) ?? defaults.stderrPath,
    agentStatePath: readString(artifacts.agentStatePath) ?? defaults.agentStatePath,
    agentStepsPath: readString(artifacts.agentStepsPath) ?? defaults.agentStepsPath,
    briefPath: readString(artifacts.briefPath) ?? defaults.briefPath,
    planPath: readString(artifacts.planPath) ?? defaults.planPath,
    sourcesPath: readString(artifacts.sourcesPath) ?? defaults.sourcesPath,
    literaturePath: readString(artifacts.literaturePath) ?? defaults.literaturePath,
    reviewProtocolPath: readString(artifacts.reviewProtocolPath) ?? defaults.reviewProtocolPath,
    reviewProtocolMarkdownPath: readString(artifacts.reviewProtocolMarkdownPath) ?? defaults.reviewProtocolMarkdownPath,
    criticProtocolReviewPath: readString(artifacts.criticProtocolReviewPath) ?? defaults.criticProtocolReviewPath,
    criticSourceSelectionPath: readString(artifacts.criticSourceSelectionPath) ?? defaults.criticSourceSelectionPath,
    criticEvidenceReviewPath: readString(artifacts.criticEvidenceReviewPath) ?? defaults.criticEvidenceReviewPath,
    criticReleaseReviewPath: readString(artifacts.criticReleaseReviewPath) ?? defaults.criticReleaseReviewPath,
    paperExtractionsPath: readString(artifacts.paperExtractionsPath) ?? defaults.paperExtractionsPath,
    evidenceMatrixPath: readString(artifacts.evidenceMatrixPath) ?? defaults.evidenceMatrixPath,
    synthesisPath: readString(artifacts.synthesisPath) ?? defaults.synthesisPath,
    synthesisJsonPath: readString(artifacts.synthesisJsonPath) ?? defaults.synthesisJsonPath,
    claimsPath: readString(artifacts.claimsPath) ?? defaults.claimsPath,
    verificationPath: readString(artifacts.verificationPath) ?? defaults.verificationPath,
    paperOutlinePath: readString(artifacts.paperOutlinePath) ?? defaults.paperOutlinePath,
    paperPath: readString(artifacts.paperPath) ?? defaults.paperPath,
    paperJsonPath: readString(artifacts.paperJsonPath) ?? defaults.paperJsonPath,
    referencesPath: readString(artifacts.referencesPath) ?? defaults.referencesPath,
    manuscriptChecksPath: readString(artifacts.manuscriptChecksPath) ?? defaults.manuscriptChecksPath,
    qualityReportPath: readString(artifacts.qualityReportPath) ?? defaults.qualityReportPath,
    nextQuestionsPath: readString(artifacts.nextQuestionsPath) ?? defaults.nextQuestionsPath,
    agendaPath: readString(artifacts.agendaPath) ?? defaults.agendaPath,
    agendaMarkdownPath: readString(artifacts.agendaMarkdownPath) ?? defaults.agendaMarkdownPath,
    summaryPath: readString(artifacts.summaryPath) ?? defaults.summaryPath,
    memoryPath: readString(artifacts.memoryPath) ?? defaults.memoryPath
  };
}

function normalizeRunStatus(value: unknown): RunStatus {
  switch (value) {
    case "queued":
    case "running":
    case "paused":
    case "completed":
    case "failed":
      return value;
    default:
      return "queued";
  }
}

function normalizeRunStage(_value: unknown): RunStage {
  return "literature_review";
}

function createRunRecord(
  projectRoot: string,
  version: string,
  brief: ResearchBrief,
  command: string[],
  timestamp: string,
  options: {
    stage?: RunStage;
  } = {}
): RunRecord {
  const id = createRunId(timestamp);

  return {
    schemaVersion: runSchemaVersion,
    appVersion: version,
    id,
    projectRoot,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    status: "queued",
    stage: options.stage ?? "literature_review",
    statusMessage: "Detached run launched. Waiting for the run worker to start.",
    brief,
    workerPid: null,
    job: {
      command,
      launchCommand: null,
      cwd: projectRoot,
      pid: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      signal: null
    },
    artifacts: createRunArtifacts(projectRoot, id)
  };
}

function mergeRunRecord(
  raw: unknown,
  projectRoot: string,
  version: string,
  runId: string
): RunRecord {
  const record = asObject(raw);
  const job = asObject(record.job);
  const resolvedId = readString(record.id) ?? runId;

  return {
    schemaVersion: runSchemaVersion,
    appVersion: version,
    id: resolvedId,
    projectRoot,
    createdAt: readString(record.createdAt) ?? new Date().toISOString(),
    updatedAt: readString(record.updatedAt) ?? new Date().toISOString(),
    startedAt: readString(record.startedAt),
    finishedAt: readString(record.finishedAt),
    status: normalizeRunStatus(record.status),
    stage: normalizeRunStage(record.stage),
    statusMessage: readString(record.statusMessage),
    brief: normalizeBrief(record.brief),
    workerPid: readInteger(record.workerPid),
    job: {
      command: readStringArray(job.command),
      launchCommand: readStringArray(job.launchCommand).length > 0
        ? readStringArray(job.launchCommand)
        : null,
      cwd: readString(job.cwd) ?? projectRoot,
      pid: readInteger(job.pid),
      startedAt: readString(job.startedAt),
      finishedAt: readString(job.finishedAt),
      exitCode: readInteger(job.exitCode),
      signal: readString(job.signal)
    },
    artifacts: mergeRunArtifacts(record.artifacts, projectRoot, resolvedId)
  };
}

async function writeRunFile(projectRoot: string, run: RunRecord): Promise<void> {
  await mkdir(run.artifacts.runDirectory, { recursive: true });
  const targetPath = runFilePath(projectRoot, run.id);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await rename(tempPath, targetPath);
}

export class RunStore {
  constructor(
    public readonly projectRoot: string,
    private readonly version: string,
    private readonly timestampFactory: () => string = () => new Date().toISOString()
  ) {}

  get runsDirectory(): string {
    return runsDirectoryPath(this.projectRoot);
  }

  async create(brief: ResearchBrief, command: string[]): Promise<RunRecord> {
    return this.createWithOptions(brief, command, {});
  }

  async createWithOptions(
    brief: ResearchBrief,
    command: string[],
    options: {
      stage?: RunStage;
    }
  ): Promise<RunRecord> {
    const run = createRunRecord(
      this.projectRoot,
      this.version,
      brief,
      command,
      this.timestampFactory(),
      options
    );

    await writeRunFile(this.projectRoot, run);
    return run;
  }

  async load(runId: string): Promise<RunRecord> {
    const contents = await readFile(runFilePath(this.projectRoot, runId), "utf8");
    return mergeRunRecord(
      JSON.parse(contents),
      this.projectRoot,
      this.version,
      runId
    );
  }

  async save(run: RunRecord): Promise<void> {
    run.updatedAt = this.timestampFactory();
    run.appVersion = this.version;
    run.projectRoot = this.projectRoot;
    run.artifacts = createRunArtifacts(this.projectRoot, run.id);
    await writeRunFile(this.projectRoot, run);
  }

  async list(): Promise<RunRecord[]> {
    await mkdir(this.runsDirectory, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(this.runsDirectory, { withFileTypes: true });
    const runs = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return await this.load(entry.name);
        } catch {
          return null;
        }
      }));

    return runs
      .filter((run): run is RunRecord => run !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async latest(): Promise<RunRecord | null> {
    const runs = await this.list();
    return runs[0] ?? null;
  }
}
