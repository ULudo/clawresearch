import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	  buildWorkspacePromptContextFromWorkStore,
	  buildNotebookDiagnostics,
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
	  type WorkStoreCanonicalSource,
  type WorkStoreClaim,
  type WorkStoreEvidenceCell,
  type WorkStoreManuscriptSection,
  type WorkStoreCreateInput,
  type WorkStoreWorkItem
} from "../src/runtime/research-work-store.js";
import { writeResearchWorkerState } from "../src/runtime/research-state.js";

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

test("research work store persists the living research notebook with task and artifact links", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-work-store-notebook-"));

  try {
    const now = "2026-01-01T00:00:00.000Z";
    const store = createResearchWorkStore({
      projectRoot,
      now,
      brief: {
        topic: "Research workspaces",
        researchQuestion: "How should the notebook keep the model oriented?",
        researchDirection: "Persist objective, definition of done, readiness, and task links.",
        successCriterion: "Notebook is canonical SQLite state, not a legacy artifact."
      }
    });
    const nextStore = {
      ...store,
      notebook: {
        ...store.notebook,
        objective: "Produce a professional literature review from the workspace.",
        definitionOfDone: ["Extract selected sources", "Support central claims", "Finalize paper.md"],
        currentFocus: "Extract selected sources",
        readiness: "Not sufficient because no claims are linked yet.",
        tasks: [{
          id: "task-extract",
          title: "Extract selected sources",
          status: "in_progress" as const,
          notes: "Start with the strongest selected papers.",
          linkedSourceIds: ["source-1"],
          linkedExtractionIds: ["extraction-1"],
          linkedEvidenceCellIds: ["evidence-1"],
          linkedClaimIds: ["claim-1"],
          linkedSectionIds: ["section-1"],
          linkedArtifactPaths: ["research-notes/extraction-plan.md"]
        }],
        notes: ["Keep the model focused on research sufficiency, not exportability."],
        artifactLinks: [{
          label: "Final paper",
          path: "paper.md",
          kind: "paper" as const,
          createdAt: now
        }],
        updatedAt: now
      }
    };

    await writeResearchWorkStore(nextStore);
    const loaded = await loadResearchWorkStore({
      projectRoot,
      now: "2026-01-01T00:00:01.000Z"
    });

    assert.equal(loaded.notebook.objective, "Produce a professional literature review from the workspace.");
    assert.deepEqual(loaded.notebook.definitionOfDone, ["Extract selected sources", "Support central claims", "Finalize paper.md"]);
    assert.equal(loaded.notebook.tasks[0]?.status, "in_progress");
    assert.deepEqual(loaded.notebook.tasks[0]?.linkedEvidenceCellIds, ["evidence-1"]);
    assert.equal(loaded.notebook.artifactLinks[0]?.path, "paper.md");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("notebook diagnostics expose empty, unwritten, unlinked, and stale project-management state", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-work-store-notebook-diagnostics-"));

  try {
    const now = "2026-01-01T00:00:00.000Z";
    let store = createResearchWorkStore({
      projectRoot,
      now,
      brief: {
        topic: "Notebook diagnostics",
        researchQuestion: "Can the runtime expose notebook drift without judging research quality?",
        researchDirection: "Derive warnings from structural workspace state.",
        successCriterion: "Notebook warnings remain observations."
      }
    });

    store = createResearchWorkStoreEntity<WorkStoreCanonicalSource>(store, {
      id: "source-1",
      kind: "canonicalSource",
      runId: "run-1",
      key: "doi:10.1/notebook",
      title: "Notebook diagnostics for research workspaces",
      citation: "Example (2026). Notebook diagnostics for research workspaces.",
      abstract: "A source used for notebook diagnostic tests.",
      year: 2026,
      authors: ["Example"],
      venue: "Workspace Systems",
      providerIds: ["test"],
      identifiers: {
        doi: "10.1/notebook",
        pmid: null,
        pmcid: null,
        arxivId: null
      },
      accessMode: "metadata_only",
      bestAccessUrl: null,
      screeningDecision: "include",
      screeningRationale: "Selected for the diagnostic fixture.",
      tags: []
    } satisfies WorkStoreCreateInput<WorkStoreCanonicalSource>, "2026-01-01T00:00:01.000Z");
    store = createResearchWorkStoreEntity<WorkStoreEvidenceCell>(store, {
      id: "evidence-1",
      kind: "evidenceCell",
      runId: "run-1",
      sourceId: "source-1",
      extractionId: "extraction-1",
      field: "limitations",
      value: "The source reports that notebooks should keep task state visible.",
      confidence: "medium"
    } satisfies WorkStoreCreateInput<WorkStoreEvidenceCell>, "2026-01-01T00:00:02.000Z");
    store = createResearchWorkStoreEntity<WorkStoreClaim>(store, {
      id: "claim-1",
      kind: "claim",
      runId: "run-1",
      text: "Notebook diagnostics keep the model oriented.",
      evidence: "Evidence is present but not linked to a notebook task.",
      sourceIds: ["source-1"],
      supportStatus: "partially_supported",
      confidence: "medium",
      usedInSections: ["section-1"],
      risk: null
    } satisfies WorkStoreCreateInput<WorkStoreClaim>, "2026-01-01T00:00:03.000Z");
    store = createResearchWorkStoreEntity<WorkStoreManuscriptSection>(store, {
      id: "section-1",
      kind: "manuscriptSection",
      runId: "run-1",
      sectionId: "discussion",
      role: "discussion",
      title: "Discussion",
      markdown: "Notebook diagnostics keep the model oriented.",
      claimIds: ["claim-1"],
      sourceIds: ["source-1"],
      status: "draft"
    } satisfies WorkStoreCreateInput<WorkStoreManuscriptSection>, "2026-01-01T00:00:04.000Z");

    const diagnostics = buildNotebookDiagnostics(store);
    const warningCodes = diagnostics.warnings.map((warning) => warning.code);

    assert.equal(diagnostics.readinessRecorded, false);
    assert.equal(diagnostics.currentFocusSet, false);
    assert.ok(warningCodes.includes("notebook-empty-task-list"));
    assert.ok(warningCodes.includes("notebook-readiness-unwritten"));
    assert.ok(warningCodes.includes("notebook-selected-sources-unlinked"));
    assert.ok(warningCodes.includes("notebook-evidence-unlinked"));
    assert.ok(warningCodes.includes("notebook-claims-unlinked"));
    assert.ok(warningCodes.includes("notebook-sections-unlinked"));
    assert.ok(warningCodes.includes("notebook-stale-after-workspace-change"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("workspace prompt context is a derived SQLite projection without pseudo-memory taxonomy", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-work-store-prompt-context-"));

  try {
    const now = "2026-01-01T00:00:00.000Z";
    let store = createResearchWorkStore({
      projectRoot,
      now,
      brief: {
        topic: "Research notebooks",
        researchQuestion: "How should prompt context expose workspace state?",
        researchDirection: "Use SQLite workspace objects and notebook fields only.",
        successCriterion: "No separate memory taxonomy or query hints are present."
      }
    });
    store = {
      ...store,
      notebook: {
        ...store.notebook,
        objective: "Write a claim-led review from workspace evidence.",
        definitionOfDone: ["Use selected evidence", "Support central claims"],
        currentFocus: "Support central claims",
        readiness: "Not sufficient because only one claim exists.",
        tasks: [{
          id: "task-support-claims",
          title: "Support central claims",
          status: "in_progress",
          notes: null,
          linkedSourceIds: ["source-1"],
          linkedExtractionIds: ["extraction-1"],
          linkedEvidenceCellIds: ["evidence-1"],
          linkedClaimIds: ["claim-1"],
          linkedSectionIds: [],
          linkedArtifactPaths: []
        }],
        notes: [],
        artifactLinks: [],
        updatedAt: now
      }
    };
    store = createResearchWorkStoreEntity<WorkStoreEvidenceCell>(store, {
      id: "evidence-1",
      kind: "evidenceCell",
      runId: "run-1",
      sourceId: "source-1",
      extractionId: "extraction-1",
      field: "limitations",
      value: "The source reports limitations in long-horizon synthesis.",
      confidence: "medium"
    } satisfies WorkStoreCreateInput<WorkStoreEvidenceCell>, now);
    store = createResearchWorkStoreEntity<WorkStoreClaim>(store, {
      id: "claim-1",
      kind: "claim",
      runId: "run-1",
      text: "Research notebooks keep the model oriented.",
      evidence: "Linked to evidence-1.",
      sourceIds: ["source-1"],
      supportStatus: "partially_supported",
      confidence: "medium",
      usedInSections: [],
      risk: null
    } satisfies WorkStoreCreateInput<WorkStoreClaim>, now);
    store = createResearchWorkStoreEntity<WorkStoreWorkItem>(store, {
      id: "workitem-1",
      kind: "workItem",
      runId: "run-1",
      type: "unsupported_claim",
      status: "open",
      severity: "major",
      title: "Strengthen claim support",
      description: "The claim needs more direct evidence.",
      targetKind: "claim",
      targetId: "claim-1",
      affectedSourceIds: ["source-1"],
      affectedClaimIds: ["claim-1"],
      suggestedActions: ["claim.link_support"],
      source: "checks"
    } satisfies WorkStoreCreateInput<WorkStoreWorkItem>, now);

    const context = buildWorkspacePromptContextFromWorkStore(store);
    const serialized = JSON.stringify(context);

    assert.equal(context.available, true);
    assert.equal(context.counts.evidenceCells, 1);
    assert.equal(context.counts.claims, 1);
    assert.equal(context.counts.openWorkItems, 1);
    assert.equal(context.notebook.objective, "Write a claim-led review from workspace evidence.");
    assert.equal(context.notebook.activeTasks[0]?.linkedEvidenceCellIds[0], "evidence-1");
    assert.equal(context.notebook.recentCriticReviews?.length, 0);
    assert.equal(context.recentEvidenceCells[0]?.id, "evidence-1");
    assert.equal(context.recentClaims[0]?.id, "claim-1");
    assert.equal(context.openWorkItems[0]?.id, "workitem-1");
    assert.doesNotMatch(serialized, /queryHints|recordCount|countsByType|method_plan|hypotheses|directions|findings/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("workspace prompt context derives critic summaries from notebook artifact links", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-work-store-critic-context-"));

  try {
    const now = "2026-01-01T00:00:00.000Z";
    const baseStore = createResearchWorkStore({
      projectRoot,
      now,
      brief: {
        topic: "agentic research",
        researchQuestion: "How should critic reviews remain visible?",
        researchDirection: "Keep critic feedback durable without a second memory store.",
        successCriterion: "Expose critic artifact summaries from notebook state."
      }
    });
    const store = {
      ...baseStore,
      notebook: {
        ...baseStore.notebook,
        objective: "Keep critic feedback visible.",
        readiness: "Not ready until critic feedback has been considered.",
        artifactLinks: [
          {
            label: "Critic review: release (revise)",
            path: ".clawresearch/runs/run-test/critic-release-review.json",
            kind: "other" as const,
            createdAt: now
          },
          {
            label: "Critic review: evidence (block)",
            path: ".clawresearch/runs/run-test/critic-evidence-review.json",
            kind: "other" as const,
            createdAt: now
          }
        ]
      }
    };
    const context = buildWorkspacePromptContextFromWorkStore(store);

    assert.equal(context.notebook.recentCriticReviews?.length, 2);
    assert.equal(context.notebook.recentCriticReviews?.[0]?.stage, "release");
    assert.equal(context.notebook.recentCriticReviews?.[0]?.readiness, "revise");
    assert.equal(context.notebook.recentCriticReviews?.[0]?.artifactPath, ".clawresearch/runs/run-test/critic-release-review.json");
    assert.equal(context.notebook.recentCriticReviews?.[1]?.stage, "evidence");
    assert.equal(context.notebook.recentCriticReviews?.[1]?.readiness, "block");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("work store semantic search returns no items instead of unrelated fallback matches", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-work-store-no-semantic-fallback-"));

  try {
    const now = "2026-01-01T00:00:00.000Z";
    let store = createResearchWorkStore({
      projectRoot,
      now,
      brief: {
        topic: "Autonomous research agents",
        researchQuestion: "Can workspace search report honest no-match observations?",
        researchDirection: "Keep search observations useful for the next model step.",
        successCriterion: "Do not return arbitrary workspace objects when the semantic query misses."
      }
    });

    store = createResearchWorkStoreEntity<WorkStoreClaim>(store, {
      id: "claim-memory-1",
      kind: "claim",
      runId: "run-1",
      text: "Persistent work stores improve long-horizon research.",
      evidence: "Supported by durable workspace observations.",
      sourceIds: ["paper-1"],
      supportStatus: "partially_supported",
      confidence: "medium",
      usedInSections: [],
      risk: null
    } satisfies WorkStoreCreateInput<WorkStoreClaim>, now);

    const result = queryResearchWorkStore(store, {
      collection: "claims",
      semanticQuery: "photosynthesis chloroplast marine plankton",
      limit: 10
    });

    assert.equal(result.count, 0);
    assert.equal(result.totalCount, 0);
    assert.deepEqual(result.items, []);
    assert.equal(result.hasMore, false);
    assert.equal(result.nextCursor, null);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("work store segment merge preserves explicit workspace objects without old rendered-view imports", async () => {
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

    const merged = mergeRunSegmentIntoResearchWorkStore(store, {
      run: {
        id: "run-merge",
        projectRoot,
        brief: store.brief
      } as never,
      plan: {} as never,
      gathered: null,
      paperExtractions: [],
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

test("architecture contract: needs_user_decision requires explicit options and a concrete decision record", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-work-store-user-decision-contract-"));

  try {
    await assert.rejects(
      writeResearchWorkerState({
        schemaVersion: 1,
        projectRoot,
        brief: {
          topic: "Autonomous research agents",
          researchQuestion: "When may the worker ask the user to decide?",
          researchDirection: "User decisions require concrete options and a reason the model cannot choose.",
          successCriterion: "Do not mark needs_user_decision from a vague status string."
        },
        status: "needs_user_decision",
        completion: null,
        activeRunId: null,
        lastRunId: "run-user-decision-contract",
        segmentCount: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        statusReason: "Need user decision.",
        paperReadiness: null,
        nextInternalActions: [],
        userBlockers: ["Need user decision."],
        evidence: null,
        critic: null
      }),
      /user decision|option/i
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
