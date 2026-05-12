import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import type { RunController } from "../src/runtime/run-controller.js";
import { SessionStore } from "../src/runtime/session-store.js";
import { runTerminalUi } from "../src/runtime/terminal-ui.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 4, 12, 9, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

class FakeTerminalInput extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  resumed = false;
  paused = false;

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }

  resume(): this {
    this.resumed = true;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }
}

class FakeTerminalOutput extends EventEmitter {
  isTTY = true;
  columns = 90;
  rows = 28;
  text = "";

  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

class NoopRunController implements RunController {
  launchCommand(run: { id: string; projectRoot: string }): string[] {
    return ["node", "stub-cli.js", "--run-job", run.id, "--project-root", run.projectRoot];
  }

  async launch(): Promise<number> {
    return 4444;
  }

  async pause(): Promise<void> {}

  async resume(): Promise<void> {}

  isProcessAlive(): boolean {
    return true;
  }
}

function emitText(input: FakeTerminalInput, text: string): void {
  for (const character of text) {
    input.emit("keypress", character, {
      name: character,
      ctrl: false,
      meta: false,
      sequence: character
    });
  }
}

test("terminal UI quit restores terminal state and pauses stdin", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-terminal-quit-"));
  const now = createNow();

  try {
    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.runtime.model = {
      provider: "ollama",
      model: "qwen3:14b",
      host: "127.0.0.1:11434",
      baseUrl: null,
      configured: true
    };
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const sessionStore = new SessionStore(projectRoot, "0.7.0", now);
    const session = await sessionStore.load();
    session.conversation.push({
      id: "assistant-1",
      kind: "chat",
      role: "assistant",
      text: "Ready.",
      timestamp: now()
    });
    await sessionStore.save(session);

    const input = new FakeTerminalInput();
    const output = new FakeTerminalOutput();
    const runPromise = runTerminalUi({
      projectRoot,
      version: "0.7.0",
      now,
      input: input as unknown as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void },
      output: output as unknown as NodeJS.WriteStream & { columns?: number; rows?: number },
      runController: new NoopRunController()
    });

    await delay(25);
    emitText(input, "/quit");
    input.emit("keypress", "\r", {
      name: "return",
      ctrl: false,
      meta: false,
      sequence: "\r"
    });

    const code = await Promise.race([
      runPromise,
      delay(1000).then(() => -1)
    ]);

    assert.equal(code, 0);
    assert.equal(input.resumed, true);
    assert.equal(input.paused, true);
    assert.deepEqual(input.rawModes, [true, false]);
    assert.match(output.text, /\u001b\[\?1049l/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
