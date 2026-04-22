import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultResearchSourceGatherer } from "../src/runtime/research-sources.js";
import type { ProjectMemoryContext } from "../src/runtime/memory-store.js";

function emptyMemoryContext(): ProjectMemoryContext {
  return {
    available: false,
    recordCount: 0,
    countsByType: {
      claim: 0,
      finding: 0,
      question: 0,
      idea: 0,
      summary: 0,
      artifact: 0,
      direction: 0,
      hypothesis: 0,
      method_plan: 0
    },
    claims: [],
    findings: [],
    questions: [],
    ideas: [],
    summaries: [],
    artifacts: [],
    directions: [],
    hypotheses: [],
    methodPlans: [],
    queryHints: [],
    localFileHints: []
  };
}

test("source gathering honors grouped provider selection when only background retrieval is enabled", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-provider-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );

      if (url.pathname === "/w/api.php") {
        return new Response(JSON.stringify({
          query: {
            search: [
              {
                title: "Riemann Hypothesis"
              }
            ]
          }
        }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      if (url.pathname.startsWith("/api/rest_v1/page/summary/")) {
        return new Response(JSON.stringify({
          title: "Riemann Hypothesis",
          extract: "The Riemann Hypothesis is a major open problem in number theory with deep links to prime-number distribution.",
          content_urls: {
            desktop: {
              page: "https://example.org/wiki/riemann-hypothesis"
            }
          }
        }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: "What background context should ground a first-pass literature review?",
        researchDirection: "Collect broad background before narrowing into proof-technique families.",
        successCriterion: "Produce a grounded first-pass literature note."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Gather broad background sources for the Riemann Hypothesis.",
        rationale: "Scholarly discovery is intentionally disabled in this test, so background sources should still work.",
        searchQueries: [
          "Riemann Hypothesis background"
        ],
        localFocus: []
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: [],
      generalWebProviderIds: ["wikipedia"],
      projectFilesEnabled: false
    });

    const sourceKinds = gathered.sources.map((source) => source.kind);

    assert.ok(sourceKinds.includes("background_article"));
    assert.equal(gathered.canonicalPapers.length, 0);
    assert.match(gathered.notes.join("\n"), /no scholarly discovery providers/i);
    assert.match(gathered.notes.join("\n"), /Collected 1 general-web sources from wikipedia/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
