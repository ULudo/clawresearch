import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SourceToolRuntime,
  type ResearchSourceToolRequest,
  type ResearchSourceSnapshot
} from "../src/runtime/research-sources.js";
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

async function runSourceTools(request: ResearchSourceToolRequest): Promise<ResearchSourceSnapshot> {
  const session = await SourceToolRuntime.create(request);
  const queries = request.plan.searchQueries.length > 0
    ? request.plan.searchQueries
    : session.state().candidateQueries;

  for (const providerId of session.state().availableProviderIds) {
    await session.queryProvider(providerId, queries);
  }

  await session.mergeSources();
  return session.result();
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

    const gathered = await runSourceTools({
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
    assert.match(gathered.notes.join("\n"), /Model-selected providers attempted: wikipedia/i);
    assert.equal(gathered.sourceToolState?.attemptedProviderIds.includes("wikipedia"), true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
