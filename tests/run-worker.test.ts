import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../src/runtime/run-store.js";
import { runDetachedJobWorker } from "../src/runtime/run-worker.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

test("detached run worker completes the bootstrap job and writes run artifacts", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-"));
  const now = createNow();

  try {
    const store = new RunStore(projectRoot, "0.6.0", now);
    const run = await store.create(
      {
        topic: "Riemann Hypothesis",
        researchQuestion: "What proof-technique families are most prominent?",
        researchDirection: "Review and compare prior proof-technique families.",
        successCriterion: "Produce a concise technique map with limitations."
      },
      ["bash", "-lc", "clawresearch phase-2 bootstrap"]
    );

    const code = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.6.0",
      now,
      bootstrapSleepSeconds: 0
    });

    assert.equal(code, 0);

    const completedRun = await store.load(run.id);
    assert.equal(completedRun.status, "completed");
    assert.equal(completedRun.workerPid, null);
    assert.equal(completedRun.job.exitCode, 0);
    assert.equal(completedRun.job.signal, null);

    const trace = await readFile(completedRun.artifacts.tracePath, "utf8");
    const events = await readFile(completedRun.artifacts.eventsPath, "utf8");
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const summary = await readFile(completedRun.artifacts.summaryPath, "utf8");

    assert.match(trace, /Run worker started\./);
    assert.match(trace, /Detached shell job completed successfully\./);
    assert.match(events, /"kind":"plan"/);
    assert.match(events, /"kind":"exec"/);
    assert.match(events, /"kind":"summary"/);
    assert.match(stdout, /ClawResearch detached run bootstrap/);
    assert.match(stdout, /Topic: Riemann Hypothesis/);
    assert.match(summary, /# Research Brief/);
    assert.match(summary, /Research question: What proof-technique families are most prominent\?/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
