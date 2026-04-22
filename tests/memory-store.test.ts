import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
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
