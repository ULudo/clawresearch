import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export type RunStage =
  | "literature_review"
  | "work_package";

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
  briefPath: string;
  planPath: string;
  sourcesPath: string;
  literaturePath: string;
  paperExtractionsPath: string;
  evidenceMatrixPath: string;
  synthesisPath: string;
  claimsPath: string;
  verificationPath: string;
  nextQuestionsPath: string;
  agendaPath: string;
  agendaMarkdownPath: string;
  workPackagePath: string;
  methodPlanPath: string;
  executionChecklistPath: string;
  findingsPath: string;
  decisionPath: string;
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
  parentRunId: string | null;
  derivedFromWorkPackageId: string | null;
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
    briefPath: path.join(runDirectory, "brief.json"),
    planPath: path.join(runDirectory, "plan.json"),
    sourcesPath: path.join(runDirectory, "sources.json"),
    literaturePath: path.join(runDirectory, "literature-review.json"),
    paperExtractionsPath: path.join(runDirectory, "paper-extractions.json"),
    evidenceMatrixPath: path.join(runDirectory, "evidence-matrix.json"),
    synthesisPath: path.join(runDirectory, "synthesis.md"),
    claimsPath: path.join(runDirectory, "claims.json"),
    verificationPath: path.join(runDirectory, "verification.json"),
    nextQuestionsPath: path.join(runDirectory, "next-questions.json"),
    agendaPath: path.join(runDirectory, "agenda.json"),
    agendaMarkdownPath: path.join(runDirectory, "agenda.md"),
    workPackagePath: path.join(runDirectory, "work-package.json"),
    methodPlanPath: path.join(runDirectory, "method-plan.json"),
    executionChecklistPath: path.join(runDirectory, "execution-checklist.json"),
    findingsPath: path.join(runDirectory, "findings.json"),
    decisionPath: path.join(runDirectory, "decision.json"),
    summaryPath: path.join(runDirectory, "summary.md"),
    memoryPath: path.join(runDirectory, "research-journal.json")
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
    briefPath: readString(artifacts.briefPath) ?? defaults.briefPath,
    planPath: readString(artifacts.planPath) ?? defaults.planPath,
    sourcesPath: readString(artifacts.sourcesPath) ?? defaults.sourcesPath,
    literaturePath: readString(artifacts.literaturePath) ?? defaults.literaturePath,
    paperExtractionsPath: readString(artifacts.paperExtractionsPath) ?? defaults.paperExtractionsPath,
    evidenceMatrixPath: readString(artifacts.evidenceMatrixPath) ?? defaults.evidenceMatrixPath,
    synthesisPath: readString(artifacts.synthesisPath) ?? defaults.synthesisPath,
    claimsPath: readString(artifacts.claimsPath) ?? defaults.claimsPath,
    verificationPath: readString(artifacts.verificationPath) ?? defaults.verificationPath,
    nextQuestionsPath: readString(artifacts.nextQuestionsPath) ?? defaults.nextQuestionsPath,
    agendaPath: readString(artifacts.agendaPath) ?? defaults.agendaPath,
    agendaMarkdownPath: readString(artifacts.agendaMarkdownPath) ?? defaults.agendaMarkdownPath,
    workPackagePath: readString(artifacts.workPackagePath) ?? defaults.workPackagePath,
    methodPlanPath: readString(artifacts.methodPlanPath) ?? defaults.methodPlanPath,
    executionChecklistPath: readString(artifacts.executionChecklistPath) ?? defaults.executionChecklistPath,
    findingsPath: readString(artifacts.findingsPath) ?? defaults.findingsPath,
    decisionPath: readString(artifacts.decisionPath) ?? defaults.decisionPath,
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

function normalizeRunStage(value: unknown): RunStage {
  switch (value) {
    case "work_package":
      return "work_package";
    case "literature_review":
    default:
      return "literature_review";
  }
}

function createRunRecord(
  projectRoot: string,
  version: string,
  brief: ResearchBrief,
  command: string[],
  timestamp: string,
  options: {
    stage?: RunStage;
    parentRunId?: string | null;
    derivedFromWorkPackageId?: string | null;
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
    parentRunId: options.parentRunId ?? null,
    derivedFromWorkPackageId: options.derivedFromWorkPackageId ?? null,
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
    parentRunId: readString(record.parentRunId),
    derivedFromWorkPackageId: readString(record.derivedFromWorkPackageId),
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
  await writeFile(runFilePath(projectRoot, run.id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
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
      parentRunId?: string | null;
      derivedFromWorkPackageId?: string | null;
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
