import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import type { ResearchBrief } from "./session-store.js";
import { RunStore, type RunRecord } from "./run-store.js";
import { appendRunEvent, type RunEventKind } from "./run-events.js";

type WorkerOptions = {
  projectRoot: string;
  runId: string;
  version: string;
  now?: () => string;
  bootstrapSleepSeconds?: number;
};

type ShellCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
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

function buildBootstrapShellCommand(
  run: RunRecord,
  bootstrapSleepSeconds: number
): ShellCommand {
  const shellScript = [
    "set -eu",
    "echo \"ClawResearch detached run bootstrap\"",
    "echo \"Project root: $CLAW_PROJECT_ROOT\"",
    "echo \"Run id: $CLAW_RUN_ID\"",
    "echo \"Topic: $CLAW_TOPIC\"",
    "echo \"Research question: $CLAW_RESEARCH_QUESTION\"",
    "echo \"Research direction: $CLAW_RESEARCH_DIRECTION\"",
    "echo \"Success criterion: $CLAW_SUCCESS_CRITERION\"",
    "echo \"Preparing initial run artifacts...\"",
    `sleep ${Math.max(0, bootstrapSleepSeconds)}`,
    "echo \"Initial detached run bootstrap complete.\""
  ].join("\n");

  return {
    command: "bash",
    args: ["-lc", shellScript],
    env: {
      CLAW_PROJECT_ROOT: run.projectRoot,
      CLAW_RUN_ID: run.id,
      CLAW_TOPIC: run.brief.topic ?? "<missing>",
      CLAW_RESEARCH_QUESTION: run.brief.researchQuestion ?? "<missing>",
      CLAW_RESEARCH_DIRECTION: run.brief.researchDirection ?? "<missing>",
      CLAW_SUCCESS_CRITERION: run.brief.successCriterion ?? "<missing>"
    }
  };
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

async function writeRunArtifacts(run: RunRecord): Promise<void> {
  await mkdir(run.artifacts.runDirectory, { recursive: true });
  await writeFile(run.artifacts.briefPath, `${JSON.stringify(run.brief, null, 2)}\n`, "utf8");
  await writeFile(run.artifacts.summaryPath, `${markdownBrief(run.brief)}\n`, "utf8");
}

function createLineEventCollector(
  run: RunRecord,
  now: () => string,
  kind: "stdout" | "stderr",
  pendingWrites: Promise<void>[]
): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";

  return {
    push(chunk: string): void {
      buffer += chunk.replace(/\r\n/g, "\n");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }

        pendingWrites.push(appendEvent(run, now, kind, line));
      }
    },
    flush(): void {
      if (buffer.trim().length === 0) {
        buffer = "";
        return;
      }

      pendingWrites.push(appendEvent(run, now, kind, buffer));
      buffer = "";
    }
  };
}

function writeChunk(stream: WriteStream, chunk: string): void {
  stream.write(chunk);
}

async function closeStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  if (stream.closed || stream.destroyed) {
    return;
  }

  stream.end();
  await finished(stream);
}

export async function runDetachedJobWorker(options: WorkerOptions): Promise<number> {
  const now = options.now ?? (() => new Date().toISOString());
  const bootstrapSleepSeconds = options.bootstrapSleepSeconds ?? 1;
  const store = new RunStore(options.projectRoot, options.version, now);
  const run = await store.load(options.runId);

  try {
    run.workerPid = process.pid;
    run.status = "running";
    run.startedAt = run.startedAt ?? now();
    run.statusMessage = "Run worker started and is preparing the initial detached job.";
    await store.save(run);
    await writeRunArtifacts(run);
    await appendTrace(run, now, "Run worker started.");
    await appendEvent(run, now, "run", "Run worker started.");
    await appendEvent(
      run,
      now,
      "plan",
      "Persist the research brief, prepare initial run artifacts, and launch the detached bootstrap command."
    );
    await appendTrace(run, now, "Saved the research brief artifacts.");
    await appendEvent(run, now, "summary", "Saved the research brief and summary artifacts for this run.");

    const shellCommand = buildBootstrapShellCommand(run, bootstrapSleepSeconds);
    run.job.command = [shellCommand.command, ...shellCommand.args];
    await appendEvent(run, now, "next", "Launch the initial bootstrap command in the project directory.");

    const child = spawn(shellCommand.command, shellCommand.args, {
      cwd: run.projectRoot,
      env: {
        ...process.env,
        ...shellCommand.env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    run.job.pid = child.pid ?? null;
    run.job.startedAt = now();
    run.statusMessage = "The detached shell job is running.";
    await store.save(run);
    await appendTrace(run, now, `Started shell job: ${run.job.command.join(" ")}`);
    await appendEvent(run, now, "exec", run.job.command.join(" "));

    const stdoutStream = createWriteStream(run.artifacts.stdoutPath, { flags: "a" });
    const stderrStream = createWriteStream(run.artifacts.stderrPath, { flags: "a" });
    const pendingEventWrites: Promise<void>[] = [];
    const stdoutEvents = createLineEventCollector(run, now, "stdout", pendingEventWrites);
    const stderrEvents = createLineEventCollector(run, now, "stderr", pendingEventWrites);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      writeChunk(stdoutStream, text);
      stdoutEvents.push(text);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      writeChunk(stderrStream, text);
      stderrEvents.push(text);
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    stdoutEvents.flush();
    stderrEvents.flush();
    await Promise.all([
      closeStream(stdoutStream),
      closeStream(stderrStream),
      ...pendingEventWrites
    ]);

    run.job.finishedAt = now();
    run.finishedAt = now();
    run.job.exitCode = exit.code;
    run.job.signal = exit.signal;
    run.workerPid = null;

    if (exit.code === 0) {
      run.status = "completed";
      run.statusMessage = "Initial detached run bootstrap completed successfully.";
      await appendTrace(run, now, "Detached shell job completed successfully.");
      await appendEvent(run, now, "summary", "Initial detached bootstrap finished successfully.");
      await appendEvent(run, now, "run", run.statusMessage);
    } else {
      run.status = "failed";
      run.statusMessage = exit.signal === null
        ? `Detached shell job failed with exit code ${exit.code ?? "unknown"}.`
        : `Detached shell job exited due to signal ${exit.signal}.`;
      await appendTrace(run, now, run.statusMessage);
      await appendEvent(run, now, "run", run.statusMessage);
    }

    await store.save(run);
    return run.status === "completed" ? 0 : 1;
  } catch (error) {
    run.status = "failed";
    run.finishedAt = now();
    run.workerPid = null;
    run.statusMessage = error instanceof Error
      ? error.message
      : "Unknown run worker failure.";
    await store.save(run);
    await appendTrace(run, now, `Run worker failed: ${run.statusMessage}`);
    await appendEvent(run, now, "run", `Run worker failed: ${run.statusMessage}`);
    return 1;
  }
}
