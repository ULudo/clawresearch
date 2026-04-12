import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { main } from "../src/cli.js";
import type { ConsoleIo } from "../src/runtime/console-app.js";
import type { IntakeBackend, IntakeRequest, IntakeResponse } from "../src/runtime/intake-backend.js";

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
  const queue = [...lines];

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
  assert.match(sink.output, /Starts the Phase 1 interactive research chat/);
  assert.match(sink.output, /\/go/);
  assert.match(sink.output, /\/status/);
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

test("compiled cli still runs when invoked through a symlinked path", async () => {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-link-"));
  const linkedCliPath = path.join(scratchRoot, "clawresearch");
  const sourceCliPath = path.resolve("dist/src/cli.js");

  try {
    await symlink(sourceCliPath, linkedCliPath);
    const { stdout } = await execFileAsync(process.execPath, [linkedCliPath, "--help"], {
      cwd: path.resolve(".")
    });

    assert.match(stdout, /Starts the Phase 1 interactive research chat/);
    assert.match(stdout, /\/quit/);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
});
