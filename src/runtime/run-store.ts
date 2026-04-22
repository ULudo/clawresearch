import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runtimeDirectoryPath,
  type ResearchBrief
} from "./session-store.js";

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
  const runDirectory = runDirectoryPath(projectRoot, id);

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
      cwd: projectRoot,
      pid: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      signal: null
    },
    artifacts: {
      runDirectory,
      tracePath: path.join(runDirectory, "trace.log"),
      eventsPath: path.join(runDirectory, "events.jsonl"),
      stdoutPath: path.join(runDirectory, "stdout.log"),
      stderrPath: path.join(runDirectory, "stderr.log"),
      briefPath: path.join(runDirectory, "brief.json"),
      planPath: path.join(runDirectory, "plan.json"),
      sourcesPath: path.join(runDirectory, "sources.json"),
      literaturePath: path.join(runDirectory, "literature.json"),
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
      memoryPath: path.join(runDirectory, "memory.json")
    }
  };
}

function mergeRunRecord(
  raw: unknown,
  projectRoot: string,
  version: string,
  runId: string
): RunRecord {
  const record = asObject(raw);
  const artifacts = asObject(record.artifacts);
  const job = asObject(record.job);
  const resolvedId = readString(record.id) ?? runId;
  const runDirectory = runDirectoryPath(projectRoot, resolvedId);

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
      command: Array.isArray(job.command)
        ? job.command.flatMap((entry) => typeof entry === "string" ? [entry] : [])
        : [],
      cwd: readString(job.cwd) ?? projectRoot,
      pid: readInteger(job.pid),
      startedAt: readString(job.startedAt),
      finishedAt: readString(job.finishedAt),
      exitCode: readInteger(job.exitCode),
      signal: readString(job.signal)
    },
    artifacts: {
      runDirectory: readString(artifacts.runDirectory) ?? runDirectory,
      tracePath: readString(artifacts.tracePath) ?? path.join(runDirectory, "trace.log"),
      eventsPath: readString(artifacts.eventsPath) ?? path.join(runDirectory, "events.jsonl"),
      stdoutPath: readString(artifacts.stdoutPath) ?? path.join(runDirectory, "stdout.log"),
      stderrPath: readString(artifacts.stderrPath) ?? path.join(runDirectory, "stderr.log"),
      briefPath: readString(artifacts.briefPath) ?? path.join(runDirectory, "brief.json"),
      planPath: readString(artifacts.planPath) ?? path.join(runDirectory, "plan.json"),
      sourcesPath: readString(artifacts.sourcesPath) ?? path.join(runDirectory, "sources.json"),
      literaturePath: readString(artifacts.literaturePath) ?? path.join(runDirectory, "literature.json"),
      synthesisPath: readString(artifacts.synthesisPath) ?? path.join(runDirectory, "synthesis.md"),
      claimsPath: readString(artifacts.claimsPath) ?? path.join(runDirectory, "claims.json"),
      verificationPath: readString(artifacts.verificationPath) ?? path.join(runDirectory, "verification.json"),
      nextQuestionsPath: readString(artifacts.nextQuestionsPath) ?? path.join(runDirectory, "next-questions.json"),
      agendaPath: readString(artifacts.agendaPath) ?? path.join(runDirectory, "agenda.json"),
      agendaMarkdownPath: readString(artifacts.agendaMarkdownPath) ?? path.join(runDirectory, "agenda.md"),
      workPackagePath: readString(artifacts.workPackagePath) ?? path.join(runDirectory, "work-package.json"),
      methodPlanPath: readString(artifacts.methodPlanPath) ?? path.join(runDirectory, "method-plan.json"),
      executionChecklistPath: readString(artifacts.executionChecklistPath) ?? path.join(runDirectory, "execution-checklist.json"),
      findingsPath: readString(artifacts.findingsPath) ?? path.join(runDirectory, "findings.json"),
      decisionPath: readString(artifacts.decisionPath) ?? path.join(runDirectory, "decision.json"),
      summaryPath: readString(artifacts.summaryPath) ?? path.join(runDirectory, "summary.md"),
      memoryPath: readString(artifacts.memoryPath) ?? path.join(runDirectory, "memory.json")
    }
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
    const run = createRunRecord(
      this.projectRoot,
      this.version,
      brief,
      command,
      this.timestampFactory()
    );

    await writeRunFile(this.projectRoot, run);
    return run;
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
    run.artifacts.runDirectory = runDirectoryPath(this.projectRoot, run.id);
    run.artifacts.tracePath = path.join(run.artifacts.runDirectory, "trace.log");
    run.artifacts.eventsPath = path.join(run.artifacts.runDirectory, "events.jsonl");
    run.artifacts.stdoutPath = path.join(run.artifacts.runDirectory, "stdout.log");
    run.artifacts.stderrPath = path.join(run.artifacts.runDirectory, "stderr.log");
    run.artifacts.briefPath = path.join(run.artifacts.runDirectory, "brief.json");
    run.artifacts.planPath = path.join(run.artifacts.runDirectory, "plan.json");
    run.artifacts.sourcesPath = path.join(run.artifacts.runDirectory, "sources.json");
    run.artifacts.synthesisPath = path.join(run.artifacts.runDirectory, "synthesis.md");
    run.artifacts.claimsPath = path.join(run.artifacts.runDirectory, "claims.json");
    run.artifacts.verificationPath = path.join(run.artifacts.runDirectory, "verification.json");
    run.artifacts.nextQuestionsPath = path.join(run.artifacts.runDirectory, "next-questions.json");
    run.artifacts.agendaPath = path.join(run.artifacts.runDirectory, "agenda.json");
    run.artifacts.agendaMarkdownPath = path.join(run.artifacts.runDirectory, "agenda.md");
    run.artifacts.workPackagePath = path.join(run.artifacts.runDirectory, "work-package.json");
    run.artifacts.methodPlanPath = path.join(run.artifacts.runDirectory, "method-plan.json");
    run.artifacts.executionChecklistPath = path.join(run.artifacts.runDirectory, "execution-checklist.json");
    run.artifacts.findingsPath = path.join(run.artifacts.runDirectory, "findings.json");
    run.artifacts.decisionPath = path.join(run.artifacts.runDirectory, "decision.json");
    run.artifacts.summaryPath = path.join(run.artifacts.runDirectory, "summary.md");
    run.artifacts.memoryPath = path.join(run.artifacts.runDirectory, "memory.json");
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
