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

test("care-heavy AI briefs route biomedical providers before broad discovery", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-routing-care-"));
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
        topic: "AI systems and work in nursing homes and elderly care",
        researchQuestion: "How do AI systems affect scheduling, documentation, and alerting work in nursing homes?",
        researchDirection: "Review workforce displacement, role changes, staffing, and policy responses.",
        successCriterion: "Produce a literature-grounded assessment of exposed tasks and responses."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Map the impact of AI systems on work in nursing homes and elderly care.",
        rationale: "This topic is AI-related but should still prioritize biomedical and care-delivery evidence.",
        searchQueries: ["AI nursing homes elderly care workforce displacement"],
        localFocus: ["nursing homes", "elderly care", "workforce displacement"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["pubmed", "europe_pmc", "openalex", "crossref", "arxiv", "dblp"]
    });

    assert.equal(gathered.routing.domain, "biomedical");
    assert.deepEqual(gathered.routing.discoveryProviderIds.slice(0, 4), ["pubmed", "europe_pmc", "openalex", "crossref"]);
    assert.ok(seenPaths.includes("/entrez/eutils/esearch.fcgi"));
    assert.ok(seenPaths.includes("/europepmc/webservices/rest/search"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("general mathematical briefs avoid biomedical discovery providers by default", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-routing-general-"));
  const originalFetch = globalThis.fetch;
  const seenPaths: string[] = [];

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      seenPaths.push(url.pathname);

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
        topic: "Riemann Hypothesis",
        researchQuestion: "How does it influence the distribution of prime numbers?",
        researchDirection: "Review theoretical and computational work in number theory.",
        successCriterion: "Produce a grounded synthesis of prior work."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review number-theory literature around the Riemann Hypothesis.",
        rationale: "This is a general mathematics literature review task.",
        searchQueries: ["Riemann Hypothesis prime number distribution"],
        localFocus: ["number theory", "prime numbers"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex", "crossref", "arxiv", "dblp", "pubmed", "europe_pmc"]
    });

    assert.equal(gathered.routing.domain, "general");
    assert.deepEqual(gathered.routing.discoveryProviderIds, ["openalex", "crossref", "arxiv", "dblp"]);
    assert.ok(!seenPaths.includes("/entrez/eutils/esearch.fcgi"));
    assert.ok(!seenPaths.includes("/europepmc/webservices/rest/search"));
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

test("provider retrieval pages beyond the old five-result ceiling", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-paging-"));
  const originalFetch = globalThis.fetch;
  const seenPages: number[] = [];

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.openalex.org" && url.pathname === "/works") {
        const page = Number(url.searchParams.get("page") ?? "1");
        seenPages.push(page);

        if (page > 2) {
          return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }

        const results = Array.from({ length: 25 }, (_, index) => {
          const id = (page - 1) * 25 + index + 1;
          return {
            id: `https://openalex.org/W${id}`,
            display_name: `Autonomous research agents study ${id}`,
            publication_year: 2025,
            authorships: [
              { author: { display_name: "Example Author" } }
            ],
            primary_location: {
              source: {
                display_name: "AI Systems Review"
              },
              landing_page_url: `https://example.org/agents/${id}`
            },
            doi: `https://doi.org/10.1000/agents-${id}`,
            abstract_inverted_index: toAbstractIndex(
              "Autonomous research agents design patterns and evaluation practices for AI systems."
            )
          };
        });

        return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "What design patterns recur in the literature?",
        researchDirection: "Review architectures and evaluation strategies.",
        successCriterion: "Produce a grounded synthesis of recurring design patterns."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review autonomous research agent architectures.",
        rationale: "We want a broader first-pass retrieval set before screening.",
        searchQueries: ["autonomous research agents design patterns"],
        localFocus: ["architectures", "evaluation strategies"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    assert.ok(seenPages.includes(1));
    assert.ok(seenPages.includes(2));
    assert.ok(gathered.canonicalPapers.length >= 50, `Expected a broader canonical set, saw ${gathered.canonicalPapers.length}`);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("provider fetch retries a transient rate limit before failing the run", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-retry-"));
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.openalex.org" && url.pathname === "/works") {
        attempts += 1;

        if (attempts === 1) {
          return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json" } });
        }

        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W1",
              display_name: "Autonomous research agents and reproducible evaluation",
              publication_year: 2025,
              authorships: [
                { author: { display_name: "Example Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "AI Systems Review"
                },
                landing_page_url: "https://example.org/agents"
              },
              doi: "https://doi.org/10.1000/agents",
              abstract_inverted_index: toAbstractIndex(
                "Autonomous research agents design patterns and evaluation practices for AI systems."
              )
            }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "What design patterns recur in the literature?",
        researchDirection: "Review architectures and evaluation strategies.",
        successCriterion: "Produce a grounded synthesis of recurring design patterns."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review autonomous research agent architectures.",
        rationale: "Transient provider throttling should not collapse the run immediately.",
        searchQueries: ["autonomous research agents design patterns"],
        localFocus: ["architectures", "evaluation strategies"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    assert.ok(attempts >= 2, `Expected at least one retry, saw ${attempts} attempts.`);
    assert.equal(gathered.canonicalPapers.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("literature-review filtering rejects unrelated query noise even when it shares review language", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-topic-filter-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.openalex.org" && url.pathname === "/works") {
        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W1",
              display_name: "On Robin's criterion for the Riemann hypothesis",
              publication_year: 2008,
              authorships: [
                { author: { display_name: "Relevant Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Journal de Theorie des Nombres de Bordeaux"
                },
                landing_page_url: "https://example.org/robin"
              },
              doi: "https://doi.org/10.1000/robin",
              abstract_inverted_index: toAbstractIndex(
                "Riemann Hypothesis Robin criterion analytic number theory explicit criterion."
              )
            },
            {
              id: "https://openalex.org/W2",
              display_name: "Modelling urban sewer flooding and quantitative microbial risk assessment: A critical review",
              publication_year: 2024,
              authorships: [
                { author: { display_name: "Irrelevant Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Journal of Flood Risk Management"
                },
                landing_page_url: "https://example.org/sewer-review"
              },
              doi: "https://doi.org/10.1000/sewer",
              abstract_inverted_index: toAbstractIndex(
                "Critical review of urban sewer flooding and microbial risk assessment methods."
              )
            }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: "What are the credible proof-technique families and their limitations?",
        researchDirection: "Compare analytic number theory approaches and explicit criteria.",
        successCriterion: "Produce a grounded technique map."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Identify credible proof-technique families for the Riemann Hypothesis.",
        rationale: "Query noise should not survive just because it looks like a review paper.",
        searchQueries: ["Riemann Hypothesis proof techniques review"],
        localFocus: ["analytic number theory", "explicit criteria"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    assert.deepEqual(gathered.canonicalPapers.map((paper) => paper.title), [
      "On Robin's criterion for the Riemann hypothesis"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("low-trust repository proof papers are kept out of the reviewed synthesis subset", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-quality-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.openalex.org" && url.pathname === "/works") {
        const page = Number(url.searchParams.get("page") ?? "1");

        if (page > 1) {
          return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }

        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W1",
              display_name: "Mollifier methods and zero-density estimates for the Riemann zeta function",
              publication_year: 2024,
              authorships: [
                { author: { display_name: "Relevant Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Journal of Number Theory"
                },
                landing_page_url: "https://example.org/mollifier"
              },
              doi: "https://doi.org/10.1000/mollifier",
              abstract_inverted_index: toAbstractIndex(
                "Riemann Hypothesis mollifier methods zero density estimates number theory zeta function."
              )
            },
            {
              id: "https://openalex.org/W2",
              display_name: "Paper042_The_Millennium_Woodchipper Complete proof of the Riemann Hypothesis",
              publication_year: 2026,
              authorships: [
                { author: { display_name: "Speculative Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Zenodo"
                },
                landing_page_url: "https://zenodo.org/records/42"
              },
              doi: "https://doi.org/10.5281/zenodo.42",
              best_oa_location: {
                pdf_url: "https://zenodo.org/records/42/files/paper.pdf"
              },
              abstract_inverted_index: toAbstractIndex(
                "Riemann Hypothesis proof complete solution millennium problem."
              )
            },
            {
              id: "https://openalex.org/W3",
              display_name: "Unified Geometric Theory v6.2 for the Riemann Hypothesis and BSD",
              publication_year: 2026,
              authorships: [
                { author: { display_name: "Speculative Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Zenodo"
                },
                landing_page_url: "https://zenodo.org/records/43"
              },
              doi: "https://doi.org/10.5281/zenodo.43",
              best_oa_location: {
                pdf_url: "https://zenodo.org/records/43/files/paper.pdf"
              },
              abstract_inverted_index: toAbstractIndex(
                "Riemann Hypothesis BSD unified geometric theory proof complete structural formalization."
              )
            }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: "Which proof-technique families are most credible?",
        researchDirection: "Review credible proof-technique families in number theory.",
        successCriterion: "Produce a grounded technique map."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review credible proof-technique families for the Riemann Hypothesis.",
        rationale: "Prefer reputable number-theory literature over speculative uploads.",
        searchQueries: ["Riemann Hypothesis proof techniques number theory"],
        localFocus: ["mollifier methods", "zero-density estimates"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    const reputablePaper = gathered.canonicalPapers.find((paper) => /Mollifier methods/i.test(paper.title));
    const suspiciousPapers = gathered.canonicalPapers.filter((paper) => /woodchipper|unified geometric theory/i.test(paper.title));

    assert.equal(reputablePaper?.screeningDecision, "include");
    assert.ok(reputablePaper?.tags.includes("quality:high"));
    assert.equal(suspiciousPapers.length, 2);
    assert.ok(suspiciousPapers.every((paper) => paper.tags.includes("quality:low")));
    assert.ok(suspiciousPapers.every((paper) => paper.screeningDecision !== "include"));
    assert.deepEqual(gathered.reviewedPapers.map((paper) => paper.title), [
      "Mollifier methods and zero-density estimates for the Riemann zeta function"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("review workflow collapses revision-style series into one reviewed paper", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-series-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "export.arxiv.org" && url.pathname === "/api/query") {
        const start = Number(url.searchParams.get("start") ?? "0");

        if (start > 0) {
          return new Response(`<?xml version="1.0" encoding="UTF-8"?><feed></feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } });
        }

        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
          <feed>
            <entry>
              <id>http://arxiv.org/abs/2501.10001</id>
              <title>Mollifier methods for the Riemann Hypothesis</title>
              <summary>Riemann Hypothesis mollifier methods number theory survey.</summary>
              <published>2025-01-10T00:00:00Z</published>
              <author><name>Example Author</name></author>
            </entry>
            <entry>
              <id>http://arxiv.org/abs/2501.10002</id>
              <title>Mollifier methods for the Riemann Hypothesis v2</title>
              <summary>Updated survey of Riemann Hypothesis mollifier methods in number theory.</summary>
              <published>2025-02-10T00:00:00Z</published>
              <author><name>Example Author</name></author>
            </entry>
            <entry>
              <id>http://arxiv.org/abs/2501.10003</id>
              <title>Zero-density estimates near the critical line</title>
              <summary>Riemann Hypothesis zero density estimates analytic number theory.</summary>
              <published>2025-03-10T00:00:00Z</published>
              <author><name>Second Author</name></author>
            </entry>
          </feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: "Which technique families are most relevant?",
        researchDirection: "Review analytic number theory technique families.",
        successCriterion: "Produce a grounded technique map."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review analytic number theory technique families.",
        rationale: "Collapse duplicate revision-series papers before synthesis.",
        searchQueries: ["Riemann Hypothesis mollifier methods", "Riemann Hypothesis zero density estimates"],
        localFocus: ["mollifier methods", "zero-density estimates"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["arxiv"]
    });

    assert.equal(gathered.canonicalPapers.length, 3);
    assert.equal(gathered.reviewedPapers.length, 2);
    assert.equal(
      gathered.reviewedPapers.filter((paper) => /Mollifier methods for the Riemann Hypothesis/i.test(paper.title)).length,
      1
    );
    assert.ok(gathered.reviewedPapers.some((paper) => paper.title === "Zero-density estimates near the critical line"));
    assert.ok(gathered.reviewWorkflow.notes.some((note) => /Collapsed 2 near-duplicate/i.test(note)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
