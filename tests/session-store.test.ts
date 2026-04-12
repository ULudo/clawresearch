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

test("legacy session files are migrated away from the old slot-filling transcript", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-legacy-"));

  try {
    const runtimeDirectory = path.join(projectRoot, ".clawresearch");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(
      path.join(runtimeDirectory, "session.json"),
      JSON.stringify({
        schemaVersion: 1,
        appVersion: "0.4.0",
        projectRoot,
        runtimeDirectory,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        status: "startup_chat",
        goCount: 0,
        lastGoRequestedAt: null,
        brief: {
          topic: "Hi, can you hear me?",
          researchQuestion: "Do research on the rimon hypothesis",
          researchDirection: "some math thing",
          successCriterion: "math it selfe is solved"
        },
        conversation: [
          {
            id: "1",
            role: "assistant",
            text: "Captured topic: Hi, can you hear me?",
            timestamp: "2026-01-01T00:00:00.000Z"
          },
          {
            id: "2",
            role: "assistant",
            text: "Next up: describe the research question.",
            timestamp: "2026-01-01T00:00:01.000Z"
          },
          {
            id: "3",
            role: "user",
            text: "I want to research the Riemann hypothesis",
            timestamp: "2026-01-01T00:00:02.000Z"
          },
          {
            id: "4",
            role: "user",
            text: "/go",
            timestamp: "2026-01-01T00:00:03.000Z"
          }
        ]
      }, null, 2),
      "utf8"
    );

    const store = new SessionStore(projectRoot, "0.5.0", createNow());
    const session = await store.load();

    assert.equal(session.schemaVersion, 2);
    assert.equal(session.brief.topic, null);
    assert.equal(session.brief.researchQuestion, null);
    assert.equal(session.conversation.length, 1);
    assert.equal(session.conversation[0]?.role, "user");
    assert.equal(session.conversation[0]?.text, "I want to research the Riemann hypothesis");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
