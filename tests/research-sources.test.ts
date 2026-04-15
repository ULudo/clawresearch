import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultResearchSourceGatherer } from "../src/runtime/research-sources.js";
import type { ProjectMemoryContext } from "../src/runtime/memory-store.js";
import type { LiteratureContext } from "../src/runtime/literature-store.js";

function toAbstractIndex(text: string): Record<string, number[]> {
  const index: Record<string, number[]> = {};
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);

  for (const [position, token] of tokens.entries()) {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (normalized.length === 0) {
      continue;
    }

    if (index[normalized] === undefined) {
      index[normalized] = [];
    }

    index[normalized]!.push(position);
  }

  return index;
}

function emptyMemoryContext(overrides: Partial<ProjectMemoryContext> = {}): ProjectMemoryContext {
  return {
    available: false,
    recordCount: 0,
    countsByType: {
      source: 0,
      claim: 0,
      finding: 0,
      question: 0,
      idea: 0,
      summary: 0,
      artifact: 0
    },
    sources: [],
    claims: [],
    findings: [],
    questions: [],
    ideas: [],
    summaries: [],
    artifacts: [],
    queryHints: [],
    localFileHints: [],
    ...overrides
  };
}

function emptyLiteratureContext(overrides: Partial<LiteratureContext> = {}): LiteratureContext {
  return {
    available: false,
    paperCount: 0,
    themeCount: 0,
    notebookCount: 0,
    papers: [],
    themes: [],
    notebooks: [],
    queryHints: [],
    ...overrides
  };
}

test("provider routing biases openalex, arxiv, and dblp for CS/AI briefs", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-routing-cs-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.pathname === "/works") {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/api/query") {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?><feed></feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } });
      }

      if (url.pathname === "/search/publ/api") {
        return new Response(JSON.stringify({ result: { hits: { hit: [] } } }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "How should autonomous research agents be designed for publishable AI research?",
        researchDirection: "Review design patterns, agent workflows, and evaluation strategies.",
        successCriterion: "Produce a literature-grounded best-practice note."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Synthesize best practices for autonomous research agents.",
        rationale: "This is a CS/AI literature review task.",
        searchQueries: ["autonomous research agents design patterns"],
        localFocus: ["agent workflows", "evaluation strategies"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex", "arxiv", "dblp"]
    });

    assert.deepEqual(gathered.routing.discoveryProviderIds, ["openalex", "arxiv", "dblp"]);
    assert.equal(gathered.routing.domain, "cs_ai");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("provider routing biases pubmed and europe pmc for biomedical briefs", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-routing-bio-"));
  const originalFetch = globalThis.fetch;
  const seenPaths: string[] = [];

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      seenPaths.push(url.pathname);

      if (url.pathname === "/entrez/eutils/esearch.fcgi") {
        return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/europepmc/webservices/rest/search") {
        return new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/works") {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "clinical triage in nursing homes",
        researchQuestion: "What evidence exists about clinical triage in nursing-home care?",
        researchDirection: "Review current biomedical and care-delivery evidence.",
        successCriterion: "Produce a grounded evidence map."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Map biomedical and care-delivery evidence around clinical triage in nursing homes.",
        rationale: "The topic is biomedical and healthcare-adjacent.",
        searchQueries: ["clinical triage nursing homes patient care"],
        localFocus: ["patient care"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["pubmed", "europe_pmc", "openalex"]
    });

    assert.deepEqual(gathered.routing.discoveryProviderIds, ["pubmed", "europe_pmc", "openalex"]);
    assert.equal(gathered.routing.domain, "biomedical");
    assert.ok(seenPaths.includes("/entrez/eutils/esearch.fcgi"));
    assert.ok(seenPaths.includes("/europepmc/webservices/rest/search"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("canonical merge combines duplicate provider hits and chooses the best readable access route", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-merge-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.openalex.org" && url.pathname === "/works") {
        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W1",
              display_name: "Design Patterns for Autonomous Research Agents",
              publication_year: 2026,
              authorships: [
                { author: { display_name: "Relevant Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "AI Systems Review"
                },
                landing_page_url: "https://example.org/agents"
              },
              doi: "https://doi.org/10.1000/agents",
              best_oa_location: {
                pdf_url: "https://example.org/agents.pdf"
              },
              abstract_inverted_index: toAbstractIndex(
                "This review compares design patterns and evaluation practices for autonomous research agents."
              )
            }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.hostname === "api.crossref.org" && url.pathname === "/works") {
        return new Response(JSON.stringify({
          message: {
            items: [
              {
                title: ["Design Patterns for Autonomous Research Agents"],
                DOI: "10.1000/agents",
                URL: "https://doi.org/10.1000/agents",
                issued: {
                  "date-parts": [[2026]]
                },
                author: [
                  {
                    given: "Relevant",
                    family: "Author"
                  }
                ],
                "container-title": ["AI Systems Review"]
              }
            ]
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "What design patterns in the literature matter most?",
        researchDirection: "Run a literature synthesis comparing architectures and evaluation practices.",
        successCriterion: "Produce a literature-grounded note."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Synthesize best practices for autonomous research agents.",
        rationale: "This is explicitly a literature review task.",
        searchQueries: ["autonomous research agents best practices"],
        localFocus: ["design patterns", "evaluation practices"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex", "crossref"]
    });

    assert.equal(gathered.canonicalPapers.length, 1);
    assert.equal(gathered.canonicalPapers[0]?.identifiers.doi, "10.1000/agents");
    assert.equal(gathered.canonicalPapers[0]?.accessMode, "fulltext_open");
    assert.equal(gathered.canonicalPapers[0]?.bestAccessProvider, "openalex");
    assert.match(gathered.mergeDiagnostics.join("\n"), /Merged 2 provider hits into canonical paper/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("direct arxiv full text beats metadata-only alternatives during access resolution", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-arxiv-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "export.arxiv.org" && url.pathname === "/api/query") {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
          <feed>
            <entry>
              <id>http://arxiv.org/abs/2501.12345</id>
              <title>Autonomous research agents and reproducible evaluation</title>
              <summary>Survey of evaluation practices for autonomous research agents.</summary>
              <published>2025-01-10T00:00:00Z</published>
              <author><name>Example Author</name></author>
            </entry>
          </feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } });
      }

      if (url.hostname === "api.crossref.org" && url.pathname === "/works") {
        return new Response(JSON.stringify({
          message: {
            items: [
              {
                title: ["Autonomous research agents and reproducible evaluation"],
                URL: "https://doi.org/10.1000/agents-eval",
                issued: {
                  "date-parts": [[2025]]
                },
                author: [
                  {
                    given: "Example",
                    family: "Author"
                  }
                ],
                "container-title": ["Evaluation Review"]
              }
            ]
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "How should these systems be evaluated reproducibly?",
        researchDirection: "Review evaluation practices and benchmarks.",
        successCriterion: "Produce a grounded best-practice note."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review reproducible evaluation practices.",
        rationale: "Start with papers that are directly readable.",
        searchQueries: ["autonomous research agents reproducible evaluation"],
        localFocus: ["evaluation"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["arxiv", "crossref"]
    });

    assert.equal(gathered.canonicalPapers.length, 1);
    assert.equal(gathered.canonicalPapers[0]?.bestAccessProvider, "arxiv");
    assert.equal(gathered.canonicalPapers[0]?.accessMode, "fulltext_open");
    assert.equal(gathered.canonicalPapers[0]?.fulltextFormat, "pdf");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("literature and memory hints influence the next retrieval pass", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-memory-hints-"));
  const originalFetch = globalThis.fetch;
  const seenQueries: string[] = [];

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.pathname === "/works") {
        seenQueries.push(url.searchParams.get("search") ?? "");

        return new Response(JSON.stringify({
          results: []
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
    await gatherer.gather({
      projectRoot,
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: "What bounded follow-up should we pursue next?",
        researchDirection: "Build on the strongest prior lead.",
        successCriterion: "Produce a focused follow-up synthesis."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Follow the best prior lead.",
        rationale: "Prior project and literature memory should shape retrieval.",
        searchQueries: [],
        localFocus: []
      },
      memoryContext: emptyMemoryContext({
        available: true,
        recordCount: 1,
        countsByType: {
          source: 0,
          claim: 0,
          finding: 0,
          question: 1,
          idea: 0,
          summary: 0,
          artifact: 0
        },
        questions: [
          {
            id: "question-1",
            title: "Which obstacles limit mollifier methods for the Riemann Hypothesis?",
            text: "Which obstacles limit mollifier methods for the Riemann Hypothesis?",
            runId: "run-prior",
            linkedRecordIds: [],
            data: {}
          }
        ],
        queryHints: [
          "mollifier methods"
        ]
      }),
      literatureContext: emptyLiteratureContext({
        available: true,
        paperCount: 1,
        themeCount: 0,
        notebookCount: 0,
        papers: [],
        themes: [],
        notebooks: [],
        queryHints: [
          "zero-free region"
        ]
      }),
      scholarlyProviderIds: ["openalex"]
    });

    assert.ok(
      seenQueries.some((query) => /mollifier methods/i.test(query)),
      `Expected a memory-derived query, saw: ${seenQueries.join(" | ")}`
    );
    assert.ok(
      seenQueries.some((query) => /zero[- ]free region/i.test(query)),
      `Expected a literature-memory-derived query, saw: ${seenQueries.join(" | ")}`
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
