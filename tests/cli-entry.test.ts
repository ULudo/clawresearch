import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { main } from "../src/cli.js";
import type { ConsoleIo } from "../src/runtime/console-app.js";
import type { IntakeBackend, IntakeRequest, IntakeResponse } from "../src/runtime/intake-backend.js";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import { SessionStore } from "../src/runtime/session-store.js";

const execFileAsync = promisify(execFile);

function capture(): { output: string; writer: { write: (chunk: string) => void } } {
  let output = "";

  return {
    get output() {
      return output;
    },
    writer: {
      write(chunk: string) {
        output += chunk;
      }
    }
  };
}

function createScriptedIo(lines: string[]): ConsoleIo & { output: string } {
  const sink = capture();
  const queue = [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ...lines
  ];

  return {
    get output() {
      return sink.output;
    },
    writer: sink.writer,
    async prompt(): Promise<string | null> {
      return queue.shift() ?? null;
    },
    close(): void {}
  };
}

class QuietStubBackend implements IntakeBackend {
  readonly label = "stub:quiet";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    if (request.mode === "start") {
      return {
        assistantMessage: "What research project would you like to scope?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The brief has not been discussed yet.",
        openQuestions: ["What is the project about?"],
        summary: null
      };
    }

    return {
      assistantMessage: "Tell me a bit more.",
      brief: request.brief,
      readiness: "needs_clarification",
      readinessRationale: "The brief still needs clarification.",
      openQuestions: ["What exactly should the project investigate?"],
      summary: null
    };
  }
}

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 3, 20, 10, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

async function runCompiledCliWithInput(
  args: string[],
  input: string,
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/src/cli.js"), ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Compiled CLI timed out. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}

test("docs flag prints concept files", async () => {
  const sink = capture();
  const code = await main(["--docs"], { writer: sink.writer });

  assert.equal(code, 0);
  assert.match(sink.output, /docs\/reset-development-concept\.md/);
  assert.match(sink.output, /docs\/autonomous-research-agent-literature-synthesis\.md/);
});

test("help flag prints interactive usage and slash commands", async () => {
  const sink = capture();
  const code = await main(["--help"], { writer: sink.writer });

  assert.equal(code, 0);
  assert.match(sink.output, /`\/go` starts or continues the autonomous research worker/);
  assert.match(sink.output, /Use `--plain` to force the older line-oriented console/);
  assert.match(sink.output, /--project-root PATH/);
  assert.match(sink.output, /\/go/);
  assert.match(sink.output, /\/status/);
  assert.match(sink.output, /\/paper checks/);
  assert.match(sink.output, /\/pause/);
  assert.match(sink.output, /\/resume/);
});

test("plain cli honors explicit project root outside current working directory", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-cli-project-root-"));

  try {
    const io = createScriptedIo(["/quit"]);
    const code = await main(["--plain", "--project-root", projectRoot], {
      io,
      intakeBackend: new QuietStubBackend()
    });

    assert.equal(code, 0);
    assert.match(io.output, new RegExp(`Project root: ${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await access(path.join(projectRoot, ".clawresearch", "session.json"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("default entry launches the console runtime in the current project directory", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-cli-"));

  try {
    const io = createScriptedIo(["/quit"]);
    const code = await main([], { io, projectRoot, intakeBackend: new QuietStubBackend() });

    assert.equal(code, 0);
    assert.match(io.output, /Project root:/);
    assert.match(io.output, /\.clawresearch\/session\.json/);
    assert.match(io.output, /What research project would you like to scope\?/);
    assert.match(io.output, /Session saved\. Closing ClawResearch\./);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiled plain cli processes piped quit during source setup", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-cli-plain-quit-"));

  try {
    const { stdout, stderr, code } = await runCompiledCliWithInput(["--plain"], "/quit\n", projectRoot);

    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /Session saved\. Closing ClawResearch\./);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiled plain cli writes state under explicit project root", async () => {
  const cwdRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-cli-explicit-cwd-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-cli-explicit-root-"));

  try {
    const { stdout, stderr, code } = await runCompiledCliWithInput(
      ["--plain", "--project-root", projectRoot],
      "/quit\n",
      cwdRoot
    );

    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, new RegExp(`Project root: ${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await access(path.join(projectRoot, ".clawresearch", "session.json"));
  } finally {
    await rm(cwdRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiled plain cli processes piped status after source setup", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-cli-plain-status-"));
  const now = createNow();

  try {
    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    session.conversation.push({
      id: "assistant-1",
      kind: "chat",
      role: "assistant",
      text: "Ready.",
      timestamp: "2026-04-20T10:00:00.000Z"
    });
    await sessionStore.save(session);

    const { stdout, stderr, code } = await runCompiledCliWithInput(["--plain"], "/status\n/quit\n", projectRoot);

    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /Current brief:/);
    assert.match(stdout, /Session saved\. Closing ClawResearch\./);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiled plain cli does not swallow a brief typed during first source setup prompt", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-cli-plain-brief-setup-"));

  try {
    const { stdout, stderr, code } = await runCompiledCliWithInput(
      ["--plain"],
      "Topic: autonomous research agents for literature review automation\n/quit\n",
      projectRoot
    );
    const session = await new SessionStore(projectRoot, "0.6.0").load();

    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /Detected a research brief during source setup/i);
    assert.equal(session.brief.topic, "autonomous research agents for literature review automation");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiled cli still runs when invoked through a symlinked path", async () => {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-link-"));
  const linkedCliPath = path.join(scratchRoot, "clawresearch");
  const sourceCliPath = path.resolve("dist/src/cli.js");

  try {
    await symlink(sourceCliPath, linkedCliPath);
    const { stdout } = await execFileAsync(process.execPath, [linkedCliPath, "--help"], {
      cwd: path.resolve(".")
    });

    assert.match(stdout, /`\/go` starts or continues the autonomous research worker/);
    assert.match(stdout, /\/quit/);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
});
