import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildLiteratureContext,
  LiteratureStore,
  literatureStoreFilePath
} from "../src/runtime/literature-store.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

test("literature store persists canonical papers, access state, theme boards, and review notebooks", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-literature-store-"));
  const now = createNow();

  try {
    const store = new LiteratureStore(projectRoot, now);

    await store.upsert({
      papers: [
        {
          key: "doi:10.1000/rh-proof-techniques",
          title: "Survey of proof techniques for the Riemann Hypothesis",
          citation: "Example Author (2025). Survey of proof techniques for the Riemann Hypothesis.",
          abstract: "Survey of proof techniques, recurring limitations, and open research questions around the Riemann Hypothesis.",
          year: 2025,
          authors: ["Example Author"],
          venue: "Number Theory Review",
          discoveredVia: ["openalex", "crossref"],
          identifiers: {
            doi: "10.1000/rh-proof-techniques"
          },
          bestAccessUrl: "https://example.org/rh-proof-techniques.pdf",
          bestAccessProvider: "openalex",
          accessMode: "fulltext_open",
          fulltextFormat: "pdf",
          screeningStage: "fulltext",
          screeningDecision: "include",
          screeningRationale: "Directly relevant survey paper with open full text.",
          runId: "run-1"
        }
      ],
      themes: [
        {
          key: "Proof-technique families",
          title: "Proof-technique families",
          summary: "Analytic techniques dominate and the same limitations recur across survey papers.",
          runId: "run-1",
          paperIds: [],
          questionTexts: [
            "Which proof-technique family offers the clearest bounded next-step follow-up?"
          ]
        }
      ],
      notebooks: [
        {
          key: "run:run-1",
          title: "Literature notebook for run-1",
          runId: "run-1",
          objective: "Map proof-technique families for the Riemann Hypothesis.",
          summary: "First-pass literature notebook centered on proof-technique families and limitations.",
          paperIds: [],
          themeIds: [],
          claimIds: [],
          nextQuestions: [
            "Which proof-technique family offers the clearest bounded next-step follow-up?"
          ],
          providerIds: ["openalex", "crossref"]
        }
      ]
    });

    const state = await store.load();
    const context = buildLiteratureContext(state, {
      topic: "Riemann Hypothesis",
      researchQuestion: "What proof-technique families are most prominent?",
      researchDirection: "Review and compare prior proof-technique families.",
      successCriterion: "Produce a concise technique map with limitations."
    });
    const serializedStore = await readFile(literatureStoreFilePath(projectRoot), "utf8");

    assert.equal(state.paperCount, 1);
    assert.equal(state.themeCount, 1);
    assert.equal(state.notebookCount, 1);
    assert.equal(state.papers[0]?.accessMode, "fulltext_open");
    assert.equal(state.papers[0]?.fulltextFormat, "pdf");
    assert.equal(state.papers[0]?.identifiers.doi, "10.1000/rh-proof-techniques");
    assert.equal(context.available, true);
    assert.match(context.papers[0]?.title ?? "", /Riemann Hypothesis/);
    assert.equal(context.papers[0]?.accessMode, "fulltext_open");
    assert.match(context.themes[0]?.title ?? "", /Proof-technique families/);
    assert.match(context.notebooks[0]?.summary ?? "", /First-pass literature notebook/);
    assert.ok(
      context.queryHints.some((hint) => /proof-technique/i.test(hint)),
      `Expected proof-technique query hint, saw: ${context.queryHints.join(" | ")}`
    );
    assert.match(serializedStore, /"paperCount": 1/);
    assert.match(serializedStore, /"fulltext_open"/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
