import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/runtime/session-store.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

test("phase one session files are preserved when the schema adds run tracking", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-phase-one-session-"));

  try {
    const runtimeDirectory = path.join(projectRoot, ".clawresearch");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(
      path.join(runtimeDirectory, "session.json"),
      JSON.stringify({
        schemaVersion: 2,
        appVersion: "0.5.0",
        projectRoot,
        runtimeDirectory,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
        status: "ready",
        goCount: 1,
        lastGoRequestedAt: "2026-01-01T00:00:04.000Z",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: "What are the main proof techniques?",
          researchDirection: "Review prior approaches and compare their core techniques.",
          successCriterion: "Produce a grounded note on the main proof-technique families."
        },
        intake: {
          backendLabel: "ollama:qwen3:14b",
          readiness: "ready",
          rationale: "The brief is concrete enough to start a first-pass research run.",
          openQuestions: [],
          summary: "A first-pass brief on proof techniques for the Riemann Hypothesis.",
          lastError: null
        },
        conversation: [
          {
            id: "1",
            kind: "chat",
            role: "user",
            text: "I want to study proof techniques for the Riemann Hypothesis",
            timestamp: "2026-01-01T00:00:01.000Z"
          }
        ]
      }, null, 2),
      "utf8"
    );

    const store = new SessionStore(projectRoot, "0.6.0", createNow());
    const session = await store.load();

    assert.equal(session.schemaVersion, 3);
    assert.equal(session.brief.topic, "Riemann Hypothesis");
    assert.equal(session.brief.researchQuestion, "What are the main proof techniques?");
    assert.equal(session.activeRunId, null);
    assert.equal(session.lastRunId, null);
    assert.equal(session.conversation.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("placeholder schema strings are sanitized out of saved sessions on load", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-placeholder-session-"));

  try {
    const runtimeDirectory = path.join(projectRoot, ".clawresearch");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(
      path.join(runtimeDirectory, "session.json"),
      JSON.stringify({
        schemaVersion: 3,
        appVersion: "0.6.0",
        projectRoot,
        runtimeDirectory,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
        status: "ready",
        goCount: 1,
        lastGoRequestedAt: "2026-01-01T00:00:04.000Z",
        activeRunId: null,
        lastRunId: null,
        brief: {
          topic: "string or null",
          researchQuestion: "string or null",
          researchDirection: "string or null",
          successCriterion: "string or null"
        },
        intake: {
          backendLabel: "ollama:qwen3:14b",
          readiness: "ready",
          rationale: "string or null",
          openQuestions: [],
          summary: "string or null",
          lastError: null
        },
        conversation: []
      }, null, 2),
      "utf8"
    );

    const store = new SessionStore(projectRoot, "0.6.0", createNow());
    const session = await store.load();

    assert.equal(session.brief.topic, null);
    assert.equal(session.brief.researchQuestion, null);
    assert.equal(session.brief.researchDirection, null);
    assert.equal(session.brief.successCriterion, null);
    assert.equal(session.intake.rationale, "The research brief still needs clarification.");
    assert.equal(session.intake.summary, null);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
