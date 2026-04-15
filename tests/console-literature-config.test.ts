import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ConsoleIo,
  runPhaseOneConsole
} from "../src/runtime/console-app.js";
import type {
  IntakeBackend,
  IntakeRequest,
  IntakeResponse
} from "../src/runtime/intake-backend.js";
import { projectConfigPath } from "../src/runtime/project-config-store.js";

type CapturedIo = ConsoleIo & {
  output: string;
};

function createScriptedIo(lines: string[]): CapturedIo {
  let output = "";
  const queue = [...lines];

  return {
    get output() {
      return output;
    },
    writer: {
      write(chunk: string) {
        output += chunk;
      }
    },
    async prompt(): Promise<string | null> {
      return queue.shift() ?? null;
    },
    close(): void {}
  };
}

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

class MinimalIntakeBackend implements IntakeBackend {
  readonly label = "stub:minimal-intake";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    if (request.mode === "start") {
      return {
        assistantMessage: "Hello! Tell me what research topic you want to explore.",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The topic is still missing.",
        openQuestions: ["What topic should the project address?"],
        summary: null
      };
    }

    return {
      assistantMessage: "Tell me more about the topic.",
      brief: request.brief,
      readiness: "needs_clarification",
      readinessRationale: "The project still needs clarification.",
      openQuestions: ["What topic should the project address?"],
      summary: null
    };
  }
}

test("console startup configures grouped source categories and stores auth env refs without secrets", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-sources-"));
  const originalOpenAlexKey = process.env.OPENALEX_API_KEY;
  const originalUnpaywallEmail = process.env.UNPAYWALL_TEST_EMAIL;

  try {
    delete process.env.OPENALEX_API_KEY;
    process.env.UNPAYWALL_TEST_EMAIL = "research@example.org";

    const io = createScriptedIo([
      "openalex, unpaywall",
      "wikipedia",
      "off",
      "",
      "UNPAYWALL_TEST_EMAIL",
      "/sources",
      "/quit"
    ]);

    const exitCode = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.7.0",
      now: createNow(),
      intakeBackend: new MinimalIntakeBackend(),
      watchRuns: false
    });

    assert.equal(exitCode, 0);
    assert.match(io.output, /Source setup/);
    assert.match(io.output, /Leaving openalex without an auth env ref for now\./);
    assert.match(io.output, /Saved unpaywall auth ref: UNPAYWALL_TEST_EMAIL/);
    assert.match(io.output, /Providers for this project:/);
    assert.match(io.output, /openalex: missing optional/);
    assert.match(io.output, /unpaywall: configured \(UNPAYWALL_TEST_EMAIL\)/);
    assert.match(io.output, /Local project files: off/);

    const configContents = await readFile(projectConfigPath(projectRoot), "utf8");

    assert.match(configContents, /"sources"/);
    assert.match(configContents, /"scholarly"/);
    assert.match(configContents, /"background"/);
    assert.match(configContents, /"projectFilesEnabled": false/);
    assert.match(configContents, /"openalex": null/);
    assert.match(configContents, /"UNPAYWALL_TEST_EMAIL"/);
    assert.doesNotMatch(configContents, /research@example\.org/);
  } finally {
    if (originalOpenAlexKey === undefined) {
      delete process.env.OPENALEX_API_KEY;
    } else {
      process.env.OPENALEX_API_KEY = originalOpenAlexKey;
    }

    if (originalUnpaywallEmail === undefined) {
      delete process.env.UNPAYWALL_TEST_EMAIL;
    } else {
      process.env.UNPAYWALL_TEST_EMAIL = originalUnpaywallEmail;
    }

    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source setup accepts slash commands like /sources before the intake chat starts", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-setup-commands-"));

  try {
    const io = createScriptedIo([
      "/sources",
      "",
      "",
      "",
      "",
      "",
      "",
      "/quit"
    ]);

    const exitCode = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.7.0",
      now: createNow(),
      intakeBackend: new MinimalIntakeBackend(),
      watchRuns: false
    });

    assert.equal(exitCode, 0);
    assert.match(io.output, /Providers for this project:/);
    assert.doesNotMatch(io.output, /Could not parse that scholarly provider selection/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
