import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createResearchWorkStore,
  createResearchWorkStoreEntity,
  loadResearchWorkStore,
  mergeRunSegmentIntoResearchWorkStore,
  patchResearchWorkStoreEntity,
  queryResearchWorkStore,
  readResearchWorkStoreEntity,
  researchWorkStoreFilePath,
  writeResearchWorkStore,
  type WorkStoreCitation,
  type WorkStoreClaim,
  type WorkStoreManuscriptSection,
  type WorkStoreCreateInput,
  type WorkStoreWorkItem
} from "../src/runtime/research-work-store.js";
import type { ManuscriptBundle } from "../src/runtime/research-manuscript.js";

test("research work store supports create, query, read, and patch operations", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-work-store-"));

  try {
    const now = "2026-01-01T00:00:00.000Z";
    let store = createResearchWorkStore({
      projectRoot,
      now,
      brief: {
        topic: "Autonomous research agents",
        researchQuestion: "How should agentic research workspaces be designed?",
        researchDirection: "Compare source handling, evidence ledgers, and critic loops.",
        successCriterion: "Create a claim-supported architecture review."
      }
    });

    store = createResearchWorkStoreEntity<WorkStoreClaim>(store, {
      id: "claim-1",
      kind: "claim",
      runId: "run-1",
      text: "Persistent work stores improve long-horizon research.",
      evidence: "Supported by repeated findings about memory and source traceability.",
      sourceIds: ["paper-1"],
      supportStatus: "partially_supported",
      confidence: "medium",
      usedInSections: ["discussion"],
      risk: "Needs more empirical evidence."
    } satisfies WorkStoreCreateInput<WorkStoreClaim>, now);
    store = createResearchWorkStoreEntity<WorkStoreWorkItem>(store, {
      id: "item-1",
      kind: "workItem",
      runId: "run-1",
      type: "critic_objection",
      status: "open",
      severity: "major",
      title: "Weak citation support",
      description: "The manuscript claims too much from conceptual evidence.",
      targetKind: "claim",
      targetId: "claim-1",
      affectedSourceIds: ["paper-1"],
      affectedClaimIds: ["claim-1"],
      suggestedActions: ["soften the claim", "find empirical evidence"],
      source: "critic"
    } satisfies WorkStoreCreateInput<WorkStoreWorkItem>, now);

    assert.equal(queryResearchWorkStore(store, {
      collection: "claims",
      semanticQuery: "persistent evidence"
    }).count, 1);
    assert.equal(queryResearchWorkStore(store, {
      collection: "workItems",
      filters: {
        status: "open",
        type: "critic_objection"
      }
    }).count, 1);

    const item = readResearchWorkStoreEntity(store, "workItems", "item-1");
    assert.equal(item?.kind, "workItem");

    store = patchResearchWorkStoreEntity(store, {
      collection: "workItems",
      id: "item-1",
      changes: {
        status: "resolved"
      }
    }, "2026-01-01T00:00:01.000Z");

    assert.equal(queryResearchWorkStore(store, {
      collection: "workItems",
      filters: {
        status: "open"
      }
    }).count, 0);

    await writeResearchWorkStore(store);
    const persistedFile = await stat(researchWorkStoreFilePath(projectRoot));
    assert.ok(persistedFile.size > 0);

    const loaded = await loadResearchWorkStore({
      projectRoot,
      now: "2026-01-01T00:00:02.000Z"
    });
    assert.equal(loaded.objects.claims[0]?.text, "Persistent work stores improve long-horizon research.");
    assert.equal(loaded.objects.workItems[0]?.status, "resolved");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("work store segment merge does not re-import rendered manuscript views as canonical objects", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-work-store-merge-"));

  try {
    const now = "2026-01-01T00:00:00.000Z";
    let store = createResearchWorkStore({
      projectRoot,
      now,
      brief: {
        topic: "Autonomous research agents",
        researchQuestion: "How should persistent research state avoid duplicated manuscript objects?",
        researchDirection: "Check canonical work-store objects against rendered paper artifacts.",
        successCriterion: "Keep the work store as the source of truth."
      }
    });

    store = createResearchWorkStoreEntity<WorkStoreClaim>(store, {
      id: "claim-tool-1",
      kind: "claim",
      runId: "run-merge",
      text: "Persistent work stores reduce duplicate research memory.",
      evidence: "The claim was created by the agent claim tool.",
      sourceIds: ["paper-canonical-1"],
      supportStatus: "supported",
      confidence: "medium",
      usedInSections: ["section-tool-1"],
      risk: null
    } satisfies WorkStoreCreateInput<WorkStoreClaim>, now);
    store = createResearchWorkStoreEntity<WorkStoreCitation>(store, {
      id: "citation-tool-1",
      kind: "citation",
      runId: "run-merge",
      sourceId: "paper-canonical-1",
      sourceTitle: "Canonical workspace source",
      evidenceCellId: "evidence-cell-1",
      supportSnippet: "A durable support link keeps the source and evidence snippet available.",
      confidence: "medium",
      relevance: "supports",
      claimIds: ["claim-tool-1"],
      sectionIds: ["section-tool-1"]
    } satisfies WorkStoreCreateInput<WorkStoreCitation>, now);
    store = createResearchWorkStoreEntity<WorkStoreManuscriptSection>(store, {
      id: "section-tool-1",
      kind: "manuscriptSection",
      runId: "run-merge",
      sectionId: "synthesis",
      role: "synthesis",
      title: "Synthesis",
      markdown: "The section was created through manuscript section tools.",
      sourceIds: ["paper-canonical-1"],
      claimIds: ["claim-tool-1"],
      status: "checked"
    } satisfies WorkStoreCreateInput<WorkStoreManuscriptSection>, now);

    const bundle = {
      checks: {
        schemaVersion: 1,
        runId: "run-merge",
        paperPath: "paper.md",
        readinessStatus: "ready_for_revision",
        blockerCount: 0,
        warningCount: 0,
        checks: [],
        blockers: []
      },
      paper: {
        schemaVersion: 1,
        runId: "run-merge",
        briefFingerprint: "fingerprint",
        title: "Rendered paper view",
        abstract: "Rendered from the work store.",
        reviewType: "narrative_review",
        structureRationale: "Rendered view only.",
        scientificRoles: ["synthesis"],
        sections: [{
          id: "synthesis",
          role: "synthesis",
          title: "Synthesis",
          markdown: "Rendered section text.",
          sourceIds: ["paper-rendered-1"],
          claimIds: ["claim-rendered-1"]
        }],
        claims: [{
          claimId: "claim-rendered-1",
          claim: "Rendered duplicate claim.",
          evidence: "Rendered duplicate evidence.",
          sourceIds: ["paper-rendered-1"]
        }],
        citationLinks: [{
          sourceId: "paper-rendered-1",
          claimIds: ["claim-rendered-1"],
          sectionIds: ["synthesis"]
        }],
        referencedPaperIds: ["paper-rendered-1"],
        evidenceTableIds: [],
        limitations: [],
        readinessStatus: "ready_for_revision"
      }
    } as unknown as ManuscriptBundle;

    const merged = mergeRunSegmentIntoResearchWorkStore(store, {
      run: {
        id: "run-merge",
        projectRoot,
        brief: store.brief
      } as never,
      plan: {} as never,
      gathered: null,
      paperExtractions: [],
      evidenceMatrix: null,
      synthesis: {
        executiveSummary: "Rendered synthesis should not become canonical state.",
        themes: [],
        claims: [{
          claim: "Rendered duplicate claim.",
          evidence: "Rendered duplicate evidence.",
          sourceIds: ["paper-rendered-1"]
        }],
        nextQuestions: []
      },
      verification: null,
      agenda: null,
      manuscriptBundle: bundle,
      criticReports: [],
      now: "2026-01-01T00:00:01.000Z"
    });

    assert.deepEqual(merged.objects.claims.map((claim) => claim.id), ["claim-tool-1"]);
    assert.deepEqual(merged.objects.citations.map((citation) => citation.id), ["citation-tool-1"]);
    assert.deepEqual(merged.objects.manuscriptSections.map((section) => section.id), ["section-tool-1"]);
    assert.equal(merged.objects.releaseChecks.length, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
