import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildProjectMemoryContext,
  countMemoryRecordsByType,
  createMemoryRecordId,
  MemoryStore
} from "../src/runtime/memory-store.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

test("memory store upserts typed records, preserves stable ids, and merges links", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-memory-store-"));
  const now = createNow();

  try {
    const store = new MemoryStore(projectRoot, now);

    const firstUpsert = await store.upsert([
      {
        type: "claim",
        key: "Example claim",
        title: "Example claim",
        text: "Initial evidence for the example claim.",
        runId: "run-1",
        links: [
          {
            type: "supported_by",
            targetKind: "paper",
            targetId: "paper-example-1"
          }
        ],
        data: {
          paperIds: ["paper-example-1"]
        }
      }
    ]);

    assert.equal(firstUpsert.inserted, 1);
    assert.equal(firstUpsert.updated, 0);

    const secondUpsert = await store.upsert([
      {
        type: "claim",
        key: "Example claim",
        title: "Example claim",
        text: "Refined evidence for the example claim.",
        runId: "run-2",
        links: [
          {
            type: "supported_by",
            targetKind: "paper",
            targetId: "paper-example-1"
          },
          {
            type: "related_to",
            targetKind: "memory",
            targetId: createMemoryRecordId("question", "What should be tested next?")
          }
        ],
        data: {
          paperIds: ["paper-example-1", "paper-example-2"],
          note: "updated"
        }
      },
      {
        type: "question",
        key: "What should be tested next?",
        title: "What should be tested next?",
        text: "What should be tested next?",
        runId: "run-2"
      }
    ]);

    assert.equal(secondUpsert.inserted, 1);
    assert.equal(secondUpsert.updated, 1);

    const memory = await store.load();
    const counts = countMemoryRecordsByType(memory);
    const claimRecord = memory.records.find((record) => record.type === "claim");

    assert.equal(memory.recordCount, 2);
    assert.equal(counts.claim, 1);
    assert.equal(counts.question, 1);
    assert.ok(claimRecord);
    assert.equal(claimRecord?.runId, "run-2");
    assert.equal(claimRecord?.text, "Refined evidence for the example claim.");
    assert.equal(claimRecord?.links.length, 2);
    assert.deepEqual(claimRecord?.data.paperIds, ["paper-example-1", "paper-example-2"]);
    assert.equal(claimRecord?.data.note, "updated");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("memory store reads legacy notes file before writing the research journal", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-memory-store-legacy-"));
  const now = createNow();

  try {
    await mkdir(path.join(projectRoot, ".clawresearch"), { recursive: true });
    await writeFile(path.join(projectRoot, ".clawresearch", "notes.json"), `${JSON.stringify({
      schemaVersion: 2,
      projectRoot,
      runtimeDirectory: path.join(projectRoot, ".clawresearch"),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      recordCount: 1,
      records: [{
        id: "finding-legacy",
        type: "finding",
        key: "legacy finding",
        title: "Legacy finding",
        text: "Loaded from the old notes file.",
        runId: "run-legacy",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        links: [],
        data: {}
      }]
    }, null, 2)}\n`, "utf8");

    const store = new MemoryStore(projectRoot, now);
    const memory = await store.load();

    assert.equal(store.filePath, path.join(projectRoot, ".clawresearch", "research-journal.json"));
    assert.equal(memory.recordCount, 1);
    assert.equal(memory.records[0]?.title, "Legacy finding");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("project memory context does not expose runtime artifact paths as planning hints", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-memory-context-artifacts-"));
  const now = createNow();

  try {
    const store = new MemoryStore(projectRoot, now);
    await store.upsert([
      {
        type: "artifact",
        key: ".clawresearch/runs/run-1/paper.json",
        title: "Structured review paper artifact",
        text: "Saved structured paper representation for run-1.",
        runId: "run-1",
        data: {
          path: ".clawresearch/runs/run-1/paper.json"
        }
      },
      {
        type: "artifact",
        key: "notes/source-notes.md",
        title: "Source notes",
        text: "Useful local notes for autonomous research agents.",
        runId: "run-1",
        data: {
          path: "notes/source-notes.md"
        }
      }
    ]);

    const memory = await store.load();
    const context = buildProjectMemoryContext(memory, {
      topic: "autonomous research agents",
      researchQuestion: "How should retrieval be improved?",
      researchDirection: "Review source notes.",
      successCriterion: "Use relevant local context."
    });

    assert.ok(context.artifacts.some((entry) => entry.data.path === "notes/source-notes.md"));
    assert.ok(!context.artifacts.some((entry) => String(entry.data.path).includes(".clawresearch/runs")));
    assert.deepEqual(context.localFileHints, ["notes/source-notes.md"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
