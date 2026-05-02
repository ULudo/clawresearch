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

test("dynamic query expansion preserves plan queries and adds brief entities for unfamiliar topics", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-query-dynamic-"));

  try {
    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "ritual soundscapes in medieval Icelandic legal assemblies",
        researchQuestion: "How did acoustic practices shape legal memory and authority in assembly culture?",
        researchDirection: "Run a literature synthesis of legal anthropology, sound studies, and saga evidence.",
        successCriterion: "Identify known evidence, open interpretive gaps, and one grounded next archival task."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review ritual soundscape evidence in medieval Icelandic assemblies.",
        rationale: "This should work for an unfamiliar humanities-style topic.",
        searchQueries: ["medieval Icelandic assemblies soundscape legal memory"],
        localFocus: ["legal anthropology", "sound studies"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: []
    });

    const queries = gathered.retrievalDiagnostics?.queries ?? [];

    assert.equal(queries[0]?.source, "plan");
    assert.equal(queries[0]?.query, "medieval Icelandic assemblies soundscape legal memory");
    assert.ok(queries.some((query) => query.source === "brief_entity"));
    assert.ok(queries.some((query) => query.source === "brief_task"));
    assert.ok(gathered.routing.plannedQueries[0]?.includes("medieval Icelandic assemblies"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("dynamic query expansion adds broad mathematical verification vocabulary without topic hardcoding", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-query-math-"));

  try {
    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "rigorous numerical verification of Riemann zeta zeros",
        researchQuestion: "What evidence exists for reliable numerical verification and error control?",
        researchDirection: "Run a literature synthesis of verification methods and unresolved computational tasks.",
        successCriterion: "Identify reliability gaps and a bounded computational follow-up."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review rigorous numerical verification methods.",
        rationale: "Mathematical verification requires search vocabulary beyond the initial phrasing.",
        searchQueries: ["Riemann zeta zeros numerical verification"],
        localFocus: ["verification methods", "error control"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: []
    });

    const domainQueries = (gathered.retrievalDiagnostics?.queries ?? [])
      .filter((query) => query.source === "domain_vocabulary")
      .map((query) => query.query.toLowerCase());

    assert.ok(domainQueries.some((query) => query.includes("rigorous computation")));
    assert.ok(domainQueries.some((query) => query.includes("error bounds")));
    assert.ok(domainQueries.some((query) => query.includes("interval arithmetic") || query.includes("ball arithmetic")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("dynamic query expansion adds care-workforce vocabulary from brief intent", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-query-care-"));

  try {
    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "AI tools in nursing homes and workforce effects",
        researchQuestion: "What evidence exists that AI tools change staffing patterns, care quality, and worker displacement risk?",
        researchDirection: "Run a literature synthesis comparing deployment patterns and workforce impacts.",
        successCriterion: "Produce a grounded summary and concrete next research task."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review AI in nursing homes and workforce outcomes.",
        rationale: "Care-delivery evidence uses long-term-care and staffing vocabulary.",
        searchQueries: ["AI tools nursing homes workforce effects"],
        localFocus: ["staffing", "care quality"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: []
    });

    const queries = (gathered.retrievalDiagnostics?.queries ?? []).map((query) => query.query.toLowerCase());
    const domainQueries = (gathered.retrievalDiagnostics?.queries ?? [])
      .filter((query) => query.source === "domain_vocabulary")
      .map((query) => query.query.toLowerCase());

    assert.ok(domainQueries.some((query) => query.includes("long-term care")));
    assert.ok(queries.some((query) => query.includes("care quality")));
    assert.ok(queries.some((query) => query.includes("staffing") || query.includes("workforce")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("dynamic query expansion adds research-agent evaluation vocabulary from brief intent", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-query-agents-"));

  try {
    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "autonomous research agents for literature synthesis",
        researchQuestion: "What architectures synthesize literature and propose next research tasks?",
        researchDirection: "Compare agent architectures, evaluation practices, memory, and provenance designs.",
        successCriterion: "Produce a grounded map of gaps and one engineering work package."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review autonomous research-agent architectures.",
        rationale: "Agent evaluation and tool-use vocabulary should expand the search.",
        searchQueries: ["autonomous research agents literature synthesis"],
        localFocus: ["evaluation", "memory", "provenance"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: []
    });

    const domainQueries = (gathered.retrievalDiagnostics?.queries ?? [])
      .filter((query) => query.source === "domain_vocabulary")
      .map((query) => query.query.toLowerCase());

    assert.ok(domainQueries.some((query) => query.includes("agent evaluation")));
    assert.ok(domainQueries.some((query) => query.includes("literature synthesis agents")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("role-aware source classification separates primary systems from surveys and benchmarks", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-role-classification-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.openalex.org" && url.pathname === "/works") {
        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W-agent-lab",
              display_name: "Agent Laboratory: Using LLM Agents as Research Assistants",
              publication_year: 2025,
              authorships: [{ author: { display_name: "Agent Author" } }],
              primary_location: { source: { display_name: "AI Research Systems" }, landing_page_url: "https://example.org/agent-lab" },
              doi: "https://doi.org/10.1000/agent-lab",
              best_oa_location: { pdf_url: "https://example.org/agent-lab.pdf" },
              abstract_inverted_index: toAbstractIndex(
                "This framework uses LLM agents as research assistants for literature review experiment execution critique and scientific paper writing."
              )
            },
            {
              id: "https://openalex.org/W-genxai",
              display_name: "Explainable Generative AI (GenXAI): a survey, conceptualization, and research agenda",
              publication_year: 2024,
              authorships: [{ author: { display_name: "Survey Author" } }],
              primary_location: { source: { display_name: "AI Survey Journal" }, landing_page_url: "https://example.org/genxai" },
              doi: "https://doi.org/10.1000/genxai",
              best_oa_location: { pdf_url: "https://example.org/genxai.pdf" },
              abstract_inverted_index: toAbstractIndex(
                "This survey and conceptualization reviews explainable generative AI for autonomous research agents and scientific workflows."
              )
            },
            {
              id: "https://openalex.org/W-paperarena",
              display_name: "PaperArena: An Evaluation Benchmark for Tool-Augmented Agentic Reasoning on Scientific Literature",
              publication_year: 2025,
              authorships: [{ author: { display_name: "Benchmark Author" } }],
              primary_location: { source: { display_name: "Agent Evaluation" }, landing_page_url: "https://example.org/paperarena" },
              doi: "https://doi.org/10.1000/paperarena",
              best_oa_location: { pdf_url: "https://example.org/paperarena.pdf" },
              abstract_inverted_index: toAbstractIndex(
                "This benchmark evaluates autonomous research agents and tool-augmented agentic reasoning on scientific literature and retrieval tasks."
              )
            },
            {
              id: "https://openalex.org/W-legomem",
              display_name: "LEGOMem: Modular Procedural Memory for Multi-agent LLM Systems for Workflow Automation",
              publication_year: 2025,
              authorships: [{ author: { display_name: "Memory Author" } }],
              primary_location: { source: { display_name: "Workflow Automation" }, landing_page_url: "https://example.org/legomem" },
              doi: "https://doi.org/10.1000/legomem",
              best_oa_location: { pdf_url: "https://example.org/legomem.pdf" },
              abstract_inverted_index: toAbstractIndex(
                "This modular procedural memory method supports multi-agent LLM systems for autonomous research agents and workflow automation."
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
        topic: "LLM-based autonomous research agents",
        researchQuestion: "How should autonomous research agents be designed and evaluated?",
        researchDirection: "Compare existing research-agent systems and frameworks.",
        successCriterion: "Compare at least five existing research-agent systems or frameworks."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Compare autonomous research-agent systems.",
        rationale: "The review needs primary system/framework evidence rather than only surveys or benchmarks.",
        searchQueries: ["autonomous research agents systems frameworks"],
        localFocus: ["planning", "tool use", "evaluation"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    const assessments = gathered.relevanceAssessments ?? [];
    const byTitle = (title: string) => assessments.find((assessment) => assessment.title.includes(title));

    assert.equal(byTitle("Agent Laboratory")?.sourceRole, "primary_system");
    assert.equal(byTitle("GenXAI")?.sourceRole, "survey");
    assert.notEqual(byTitle("GenXAI")?.selectionDecision, "selected_primary");
    assert.equal(byTitle("PaperArena")?.sourceRole, "benchmark");
    assert.notEqual(byTitle("PaperArena")?.selectionDecision, "selected_primary");
    assert.equal(byTitle("LEGOMem")?.sourceRole, "method_component");
    assert.notEqual(gathered.selectionQuality?.adequacy, "strong");
    assert.ok(gathered.selectionQuality?.selectionRationale.some((line) => /Role-aware source diagnostic/i.test(line)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

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

test("mathematical briefs route through mathematics-aware providers by default", async () => {
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
      scholarlyProviderIds: ["openalex", "crossref", "arxiv", "dblp", "pubmed", "europe_pmc", "elsevier", "ieee_xplore"]
    });

    assert.equal(gathered.routing.domain, "mathematics");
    assert.deepEqual(gathered.routing.discoveryProviderIds, ["openalex", "arxiv", "crossref", "elsevier", "dblp", "ieee_xplore"]);
    assert.ok(!seenPaths.includes("/entrez/eutils/esearch.fcgi"));
    assert.ok(!seenPaths.includes("/europepmc/webservices/rest/search"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("mathematical briefs are not pulled into cs-ai routing by generated computational search queries", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-routing-math-computational-"));
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

      if (url.pathname === "/works") {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/content/search/scopus") {
        return new Response(JSON.stringify({ "search-results": { entry: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/api/v1/search/articles") {
        return new Response(JSON.stringify({ articles: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: "What new computational approaches could be applied to the Riemann Hypothesis?",
        researchDirection: "Review computational work in number theory and zeta-function analysis.",
        successCriterion: "Produce a grounded synthesis of realistic computational directions."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Evaluate computational approaches around the Riemann Hypothesis.",
        rationale: "This is a mathematics problem that may involve computational methods but still belongs to number theory.",
        searchQueries: [
          "machine learning applications in analytic number theory",
          "high-performance computing for number theory problems",
          "riemann hypothesis computational methods"
        ],
        localFocus: ["number theory", "zeta function"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex", "crossref", "arxiv", "dblp", "elsevier", "ieee_xplore"]
    });

    assert.equal(gathered.routing.domain, "mathematics");
    assert.deepEqual(gathered.routing.discoveryProviderIds.slice(0, 4), ["openalex", "arxiv", "crossref", "elsevier"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("social-science briefs prioritize broad scholarly and publisher sources over cs-only indexes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-routing-social-science-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.pathname === "/works") {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/content/search/scopus") {
        return new Response(JSON.stringify({ "search-results": { entry: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/meta/v2/json") {
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/api/query") {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?><feed></feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "AI adoption and employment effects in social services",
        researchQuestion: "How is AI adoption affecting jobs, workforce organization, and policy responses in social services?",
        researchDirection: "Review labor-market effects, policy responses, and organizational change.",
        successCriterion: "Produce a literature-grounded synthesis of employment and policy effects."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Map employment, workforce, and policy effects of AI adoption in social services.",
        rationale: "This is a social-science and policy literature review, not a computer-science systems review.",
        searchQueries: ["AI adoption employment policy social services"],
        localFocus: ["employment", "policy", "workforce"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex", "crossref", "elsevier", "springer_nature", "dblp", "arxiv"]
    });

    assert.equal(gathered.routing.domain, "social_science");
    assert.deepEqual(gathered.routing.discoveryProviderIds.slice(0, 4), ["openalex", "crossref", "elsevier", "springer_nature"]);
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
          claim: 0,
          finding: 0,
          question: 1,
          idea: 0,
          summary: 0,
          artifact: 0,
          direction: 0,
          hypothesis: 0,
          method_plan: 0
        },
        questions: [
          {
            id: "question-1",
            title: "Which obstacles limit mollifier methods for the Riemann Hypothesis?",
            text: "Which obstacles limit mollifier methods for the Riemann Hypothesis?",
            runId: "run-prior",
            links: [],
            data: {}
          }
        ],
        directions: [],
        hypotheses: [],
        methodPlans: [],
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

test("source gathering emits progress and resolves access only for promising papers", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-incremental-"));
  const originalFetch = globalThis.fetch;
  const progressPhases: string[] = [];
  let unpaywallCalls = 0;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.openalex.org" && url.pathname === "/works") {
        const page = Number(url.searchParams.get("page") ?? "1");

        if (page > 3) {
          return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }

        const results = Array.from({ length: 25 }, (_, index) => {
          const id = (page - 1) * 25 + index + 1;
          return {
            id: `https://openalex.org/W${id}`,
            display_name: `Autonomous research agent harness architecture and evaluation ${id}`,
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
            doi: `https://doi.org/10.1000/agent-harness-${id}`,
            abstract_inverted_index: toAbstractIndex(
              "Autonomous research agent harness architecture planning tool use retrieval code execution verification reproducibility evaluation benchmark workflow."
            )
          };
        });

        return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.hostname === "api.unpaywall.org") {
        unpaywallCalls += 1;
        return new Response(JSON.stringify({
          best_oa_location: {
            url_for_pdf: `https://example.org/fulltext/${unpaywallCalls}.pdf`
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "autonomous research agent harnesses",
        researchQuestion: "How should autonomous research agent harnesses be designed for digital scientific workflows?",
        researchDirection: "Review architectures, planning, tool use, retrieval, verification, reproducibility, and evaluation.",
        successCriterion: "Produce design principles grounded in research-agent harness architecture and evaluation evidence."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review autonomous research agent harness architectures and evaluation practices.",
        rationale: "The run needs a broad metadata pass but should not resolve every paper before source selection.",
        searchQueries: ["autonomous research agent harness architecture evaluation"],
        localFocus: ["planning", "tool use", "verification", "reproducibility"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex", "unpaywall"],
      credentials: {
        schemaVersion: 1,
        projectRoot,
        runtimeDirectory: path.join(projectRoot, ".clawresearch"),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        providers: {
          unpaywall: {
            email: "researcher@example.org"
          }
        }
      },
      progress: (event) => {
        progressPhases.push(`${event.phase}:${event.status}`);
      }
    });

    assert.ok(gathered.canonicalPapers.length > 32, `Expected a broad metadata set, saw ${gathered.canonicalPapers.length}`);
    assert.ok(unpaywallCalls > 0, "Expected targeted OA resolution calls.");
    assert.ok(unpaywallCalls <= 32, `Expected targeted access resolution, saw ${unpaywallCalls} Unpaywall calls.`);
    assert.ok(progressPhases.some((phase) => phase.startsWith("provider_query:")));
    assert.ok(progressPhases.includes("access_resolution:started"));
    assert.ok(progressPhases.includes("completed:completed"));
    assert.ok((gathered.retrievalDiagnostics?.providerAttempts[0]?.providerCalls ?? 0) > 0);
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
          return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json", "retry-after": "0" } });
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
    assert.equal(gathered.retrievalDiagnostics?.providerAttempts[0]?.error, null);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("missing unpaywall email is reported as an access limitation", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-unpaywall-diagnostic-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.openalex.org" && url.pathname === "/works") {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
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
        rationale: "Missing resolver configuration should be explicit.",
        searchQueries: ["autonomous research agents design patterns"],
        localFocus: ["architectures", "evaluation strategies"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex", "unpaywall"]
    });

    assert.ok(
      gathered.retrievalDiagnostics?.accessLimitations.some((limitation) => /Unpaywall resolver unavailable/i.test(limitation))
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("literature-review screening keeps query noise visible with advisory diagnostics", async () => {
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
      "On Robin's criterion for the Riemann hypothesis",
      "Modelling urban sewer flooding and quantitative microbial risk assessment: A critical review"
    ]);
    assert.ok((gathered.retrievalDiagnostics?.screeningSummary.rejected ?? 0) >= 1);
    assert.match(gathered.notes.join("\n"), /retained them for researcher-visible screening/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("literature-review screening retains strong task and focus matches without exact domain-anchor wording", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-relaxed-screening-"));
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
              id: "https://openalex.org/W-relaxed",
              display_name: "Planning-loop evaluation benchmarks for tool-using scientific assistants",
              publication_year: 2025,
              authorships: [
                { author: { display_name: "Relevant Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "AI Systems Review"
                },
                landing_page_url: "https://example.org/scientific-assistants"
              },
              doi: "https://doi.org/10.1000/scientific-assistants",
              abstract_inverted_index: toAbstractIndex(
                "Evaluation benchmark architecture for planning loops memory provenance and tool use in scientific assistants."
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
        researchQuestion: "What architectures synthesize literature and propose next research tasks?",
        researchDirection: "Compare planning loops, evaluation practices, memory, and provenance designs.",
        successCriterion: "Produce a grounded map of gaps and one engineering work package."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review autonomous research-agent architectures.",
        rationale: "Relevant papers may use scientific-assistant terminology instead of exact domain anchors.",
        searchQueries: ["autonomous research agents literature synthesis"],
        localFocus: ["planning loops", "evaluation", "memory", "provenance"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    assert.equal(gathered.canonicalPapers.length, 1);
    assert.equal(gathered.canonicalPapers[0]?.screeningDecision, "uncertain");
    assert.equal(gathered.reviewedPapers.length, 1);
    assert.match(gathered.canonicalPapers[0]?.screeningRationale ?? "", /Retained because the combined topic, task, and focus evidence/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("review workflow promotes high-quality uncertain abstract papers when included evidence is sparse", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-review-promotion-"));
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
              id: "https://openalex.org/W-include",
              display_name: "Autonomous research agents for literature synthesis and evaluation",
              publication_year: 2025,
              authorships: [
                { author: { display_name: "Included Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "AI Systems Review"
                },
                landing_page_url: "https://example.org/include"
              },
              doi: "https://doi.org/10.1000/include",
              abstract_inverted_index: toAbstractIndex(
                "Autonomous research agents literature synthesis evaluation memory provenance and research task generation."
              )
            },
            {
              id: "https://openalex.org/W-uncertain-1",
              display_name: "Tool-using scientific assistants for planning-loop evaluation",
              publication_year: 2024,
              authorships: [
                { author: { display_name: "Uncertain Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "AI Systems Review"
                },
                landing_page_url: "https://example.org/uncertain-1"
              },
              doi: "https://doi.org/10.1000/uncertain-1",
              abstract_inverted_index: toAbstractIndex(
                "Planning-loop evaluation benchmark architecture for memory provenance and tool use in scientific assistants."
              )
            },
            {
              id: "https://openalex.org/W-uncertain-2",
              display_name: "Scientific assistant memory architectures for reproducible task generation",
              publication_year: 2023,
              authorships: [
                { author: { display_name: "Another Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Proceedings of AI Evaluation"
                },
                landing_page_url: "https://example.org/uncertain-2"
              },
              doi: "https://doi.org/10.1000/uncertain-2",
              abstract_inverted_index: toAbstractIndex(
                "Evaluation architecture memory provenance and reproducible planning for tool using scientific assistants."
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
        researchQuestion: "What architectures synthesize literature and propose next research tasks?",
        researchDirection: "Compare planning loops, evaluation practices, memory, and provenance designs.",
        successCriterion: "Produce a grounded map of gaps and one engineering work package."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review autonomous research-agent architectures.",
        rationale: "Sparse included evidence should promote cautious high-quality uncertain papers.",
        searchQueries: ["autonomous research agents literature synthesis"],
        localFocus: ["planning loops", "evaluation", "memory", "provenance"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    assert.equal(gathered.reviewedPapers.length, 3);
    assert.equal(gathered.reviewWorkflow.counts.included, 1);
    assert.equal(gathered.reviewWorkflow.counts.selectedForSynthesis, 3);
    assert.match(gathered.reviewWorkflow.notes.join("\n"), /Promoted 2 high\/medium-quality uncertain papers/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("review workflow reports off-topic diagnostics without hiding researcher-visible papers", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-topic-gate-"));
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
              id: "https://openalex.org/W-agent-review",
              display_name: "Autonomous research agents for literature review and summarization",
              publication_year: 2025,
              authorships: [
                { author: { display_name: "Relevant Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "AI Systems Review"
                },
                landing_page_url: "https://example.org/agent-review"
              },
              doi: "https://doi.org/10.1000/agent-review",
              abstract_inverted_index: toAbstractIndex(
                "Autonomous research agents perform literature review workflows with information retrieval summarization and information organization."
              )
            },
            {
              id: "https://openalex.org/W-cmip6",
              display_name: "Overview of CMIP6 experimental design and organization",
              publication_year: 2016,
              authorships: [
                { author: { display_name: "Climate Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Geoscientific Model Development"
                },
                landing_page_url: "https://example.org/cmip6"
              },
              doi: "https://doi.org/10.1000/cmip6",
              abstract_inverted_index: toAbstractIndex(
                "Experimental design architecture evaluation memory provenance and efficient organization for climate model comparison."
              )
            },
            {
              id: "https://openalex.org/W-industrial-iot",
              display_name: "Resource-efficient federated learning in industrial IoT environments",
              publication_year: 2024,
              authorships: [
                { author: { display_name: "IoT Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Industrial AI"
                },
                landing_page_url: "https://example.org/iot"
              },
              doi: "https://doi.org/10.1000/iot",
              abstract_inverted_index: toAbstractIndex(
                "Efficient architecture evaluation benchmarks memory provenance and task organization for industrial IoT systems."
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
        topic: "Design and build efficient autonomous research agents",
        researchQuestion: "How can autonomous research agents perform literature review, information retrieval, summarization, and information organization?",
        researchDirection: "Review systems for autonomous literature-review workflows.",
        successCriterion: "Meet the standards of quality and comprehensiveness typically expected in academic research."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review autonomous research-agent literature review systems.",
        rationale: "Generic design and efficiency papers should remain visible with diagnostics.",
        searchQueries: ["autonomous research agents literature review summarization"],
        localFocus: ["information retrieval", "summarization", "information organization"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    assert.equal(gathered.reviewedPapers.length, 3);
    assert.match(gathered.reviewedPapers[0]?.title ?? "", /Autonomous research agents/i);
    assert.equal(gathered.reviewWorkflow.counts.selectedForSynthesis, 3);
    assert.match(gathered.reviewWorkflow.notes.join("\n"), /Advisory relevance diagnostics/i);
    assert.equal(gathered.relevanceAssessments?.filter((assessment) => assessment.status === "excluded").length, 2);
    assert.ok(gathered.reviewedPapers.some((paper) => /CMIP6/i.test(paper.title)));
    assert.ok(gathered.reviewedPapers.some((paper) => /industrial IoT/i.test(paper.title)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("review selection records success-criterion facet coverage for the selected papers", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-facet-coverage-"));
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
              id: "https://openalex.org/W-nursing-workforce",
              display_name: "Artificial intelligence adoption, staffing, and care quality in nursing homes",
              publication_year: 2025,
              authorships: [
                { author: { display_name: "Care Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Journal of Long-Term Care"
                },
                landing_page_url: "https://example.org/nursing-workforce"
              },
              doi: "https://doi.org/10.1000/nursing-workforce",
              abstract_inverted_index: toAbstractIndex(
                "Nursing homes artificial intelligence adoption staffing workforce displacement and care quality in long-term care."
              )
            },
            {
              id: "https://openalex.org/W-healthcare-ai",
              display_name: "Artificial intelligence in healthcare review",
              publication_year: 2024,
              authorships: [
                { author: { display_name: "Broad Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Healthcare Review"
                },
                landing_page_url: "https://example.org/healthcare-ai"
              },
              doi: "https://doi.org/10.1000/healthcare-ai",
              abstract_inverted_index: toAbstractIndex(
                "A broad healthcare review of artificial intelligence systems across clinical settings."
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
        topic: "AI adoption in nursing homes",
        researchQuestion: "How does AI adoption affect staffing, workforce displacement, and care quality in nursing homes?",
        researchDirection: "Review evidence on nursing-home staffing and quality impacts.",
        successCriterion: "Produce a research note that distinguishes observed staffing and care-quality effects from speculation."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Synthesize AI adoption evidence in nursing homes.",
        rationale: "The selected reviewed set should cover the success criterion facets.",
        searchQueries: ["AI adoption nursing homes staffing care quality"],
        localFocus: ["staffing", "workforce displacement", "care quality"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    const selectionQuality = gathered.selectionQuality;
    const targetedPaper = gathered.reviewedPapers.find((paper) => /staffing, and care quality/i.test(paper.title));
    const targetedCoverage = selectionQuality?.paperFacetCoverage.find((coverage) => coverage.paperId === targetedPaper?.id);
    const coveredLabels = selectionQuality?.requiredFacets
      .filter((facet) => targetedCoverage?.coveredFacetIds.includes(facet.id))
      .map((facet) => facet.label.toLowerCase()) ?? [];

    assert.ok(selectionQuality !== undefined && selectionQuality !== null);
    assert.ok(targetedPaper !== undefined);
    assert.ok(coveredLabels.some((label) => /nursing homes/.test(label)));
    assert.ok(coveredLabels.some((label) => /staffing|workforce/.test(label)));
    assert.ok(coveredLabels.some((label) => /care quality/.test(label)));
    assert.match(gathered.reviewWorkflow.notes.join("\n"), /Review facet adequacy/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("review selection records missing method facets when zeta evidence drifts away from verification", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-facet-missing-"));
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
              id: "https://openalex.org/W-zeta-differences",
              display_name: "Distributions of differences of Riemann zeta zeros",
              publication_year: 2024,
              authorships: [
                { author: { display_name: "Zeta Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "Journal of Number Theory"
                },
                landing_page_url: "https://example.org/zeta-differences"
              },
              doi: "https://doi.org/10.1000/zeta-differences",
              abstract_inverted_index: toAbstractIndex(
                "Riemann zeta zeros zero spacing statistics pair correlation and number theory."
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
        topic: "rigorous numerical verification of Riemann zeta zeros",
        researchQuestion: "What evidence exists for reliable numerical verification and error control?",
        researchDirection: "Review rigorous computation methods for verifying zeta zeros.",
        successCriterion: "Identify verification methods with explicit error bounds and implementation constraints."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review rigorous numerical verification methods for zeta zeros.",
        rationale: "Adjacent zeta statistics papers should not satisfy verification-method facets.",
        searchQueries: ["Riemann zeta zeros numerical verification error bounds"],
        localFocus: ["error bounds", "rigorous computation", "implementation constraints"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    const missingLabels = gathered.selectionQuality?.missingRequiredFacets.map((facet) => facet.label.toLowerCase()) ?? [];

    assert.equal(gathered.reviewedPapers.length, 1);
    assert.equal(gathered.relevanceAssessments?.[0]?.status, "borderline");
    assert.ok(missingLabels.some((label) => /error bounds|rigorous numerical verification|verification/.test(label)));
    assert.notEqual(gathered.selectionQuality?.adequacy, "strong");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("thin evidence triggers one revision pass and records diagnostics", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-revision-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.openalex.org" && url.pathname === "/works") {
        const search = url.searchParams.get("search") ?? "";

        if (!/(limitations|evaluation)/i.test(search)) {
          return new Response(JSON.stringify({
            results: [
              {
                id: "https://openalex.org/W-noise",
                display_name: "Unrelated survey of aquarium maintenance",
                publication_year: 2024,
                authorships: [
                  { author: { display_name: "Noise Author" } }
                ],
                primary_location: {
                  source: {
                    display_name: "Maintenance Review"
                  },
                  landing_page_url: "https://example.org/noise"
                },
                abstract_inverted_index: toAbstractIndex(
                  "A survey review of aquarium maintenance procedures."
                )
              }
            ]
          }), { status: 200, headers: { "content-type": "application/json" } });
        }

        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W-revision",
              display_name: "Autonomous research agents limitations and evaluation practices",
              publication_year: 2025,
              authorships: [
                { author: { display_name: "Revision Author" } }
              ],
              primary_location: {
                source: {
                  display_name: "AI Systems Review"
                },
                landing_page_url: "https://example.org/revision"
              },
              doi: "https://doi.org/10.1000/revision",
              abstract_inverted_index: toAbstractIndex(
                "Autonomous research agents limitations evaluation practices memory provenance and literature synthesis."
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
        researchQuestion: "What remains unresolved?",
        researchDirection: "Review planning and evaluation gaps.",
        successCriterion: "Find a grounded next task."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review autonomous research-agent evidence.",
        rationale: "The first pass should be too thin and trigger revision.",
        searchQueries: ["autonomous research agents evidence"],
        localFocus: ["planning", "evaluation"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["openalex"]
    });

    assert.equal(gathered.retrievalDiagnostics?.revisionPasses, 1);
    assert.ok(gathered.retrievalDiagnostics?.providerAttempts.some((attempt) => attempt.phase === "revision"));
    assert.ok(gathered.retrievalDiagnostics?.queries.some((query) => query.source === "revision" || query.source === "rejected_candidate"));
    assert.ok(gathered.canonicalPapers.some((paper) => /limitations and evaluation/i.test(paper.title)));
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

test("ieee xplore discovery yields canonical papers with honest access state", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-ieee-"));
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.IEEE_XPLORE_API_KEY;

  try {
    process.env.IEEE_XPLORE_API_KEY = "ieee-test-key";

    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "ieeexploreapi.ieee.org" && url.pathname === "/api/v1/search/articles") {
        return new Response(JSON.stringify({
          articles: [
            {
              title: "Benchmarking autonomous research agents in engineering workflows",
              abstract: "Autonomous research agents engineering workflows evaluation benchmarks reproducibility.",
              publication_year: 2025,
              publication_title: "IEEE Transactions on Engineering Management",
              doi: "10.1109/example.2025.1",
              accessType: "Open Access",
              html_url: "https://ieeexplore.ieee.org/document/1",
              pdf_url: "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=1",
              authors: {
                authors: [
                  {
                    full_name: "Ada Lovelace"
                  }
                ]
              }
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
        researchQuestion: "How are engineering workflows benchmarked?",
        researchDirection: "Review benchmark design and reproducibility.",
        successCriterion: "Produce a benchmark-grounded synthesis."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review engineering benchmark papers for autonomous research agents.",
        rationale: "IEEE Xplore should contribute engineering-oriented discovery.",
        searchQueries: ["autonomous research agents engineering benchmarks"],
        localFocus: ["benchmarks", "reproducibility"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["ieee_xplore"]
    });

    assert.equal(gathered.canonicalPapers.length, 1);
    assert.equal(gathered.canonicalPapers[0]?.bestAccessProvider, "ieee_xplore");
    assert.equal(gathered.canonicalPapers[0]?.accessMode, "fulltext_open");
    assert.equal(gathered.canonicalPapers[0]?.authors[0], "Ada Lovelace");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.IEEE_XPLORE_API_KEY;
    } else {
      process.env.IEEE_XPLORE_API_KEY = originalApiKey;
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("elsevier discovery and acquisition upgrade a canonical paper to licensed full text", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-elsevier-"));
  const originalFetch = globalThis.fetch;
  const originalScopusKey = process.env.SCOPUS_API_KEY;
  const originalInstitutionToken = process.env.SCIENCEDIRECT_INSTITUTION_TOKEN;

  try {
    process.env.SCOPUS_API_KEY = "elsevier-test-key";
    process.env.SCIENCEDIRECT_INSTITUTION_TOKEN = "inst-token";

    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.elsevier.com" && url.pathname === "/content/search/scopus") {
        assert.equal(url.searchParams.get("view"), "STANDARD");
        return new Response(JSON.stringify({
          "search-results": {
            entry: [
              {
                "dc:title": "Autonomous research agents for scientific planning",
                "dc:description": "Autonomous research agents scientific planning literature review and evaluation.",
                "prism:publicationName": "Journal of Research Systems",
                "prism:coverDate": "2025-02-01",
                "prism:doi": "10.1016/j.example.2025.1001",
                "prism:url": "https://api.elsevier.com/content/abstract/scopus_id/123456",
                authors: {
                  author: [
                    {
                      given: "Grace",
                      surname: "Hopper"
                    }
                  ]
                },
                openaccessArticle: false
              }
            ]
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.hostname === "api.elsevier.com" && url.pathname === "/content/search/sciencedirect") {
        return new Response(JSON.stringify({
          "search-results": {
            entry: [
              {
                "dc:title": "Autonomous research agents for scientific planning",
                "dc:description": "Autonomous research agents scientific planning literature review and evaluation.",
                "prism:publicationName": "Journal of Research Systems",
                "prism:coverDate": "2025-02-01",
                "prism:doi": "10.1016/j.example.2025.1001",
                "prism:url": "https://api.elsevier.com/content/article/pii/S000000000000001",
                authors: {
                  author: [
                    {
                      given: "Grace",
                      surname: "Hopper"
                    }
                  ]
                },
                openaccessArticle: false
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
        researchQuestion: "How should planning loops be structured?",
        researchDirection: "Review planning strategies and evaluation setups.",
        successCriterion: "Produce a planning-grounded synthesis."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review planning-loop papers for autonomous research agents.",
        rationale: "Scopus discovery should merge with ScienceDirect publisher access when available.",
        searchQueries: ["autonomous research agents scientific planning"],
        localFocus: ["planning", "evaluation"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["elsevier"]
    });

    assert.equal(gathered.canonicalPapers.length, 1);
    assert.equal(gathered.canonicalPapers[0]?.bestAccessProvider, "elsevier");
    assert.equal(gathered.canonicalPapers[0]?.accessMode, "fulltext_licensed");
    assert.equal(gathered.canonicalPapers[0]?.identifiers.doi, "10.1016/j.example.2025.1001");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalScopusKey === undefined) {
      delete process.env.SCOPUS_API_KEY;
    } else {
      process.env.SCOPUS_API_KEY = originalScopusKey;
    }
    if (originalInstitutionToken === undefined) {
      delete process.env.SCIENCEDIRECT_INSTITUTION_TOKEN;
    } else {
      process.env.SCIENCEDIRECT_INSTITUTION_TOKEN = originalInstitutionToken;
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("elsevier discovery keeps scopus results even when the science direct entitlement route fails", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-elsevier-fallback-"));
  const originalFetch = globalThis.fetch;
  const originalScopusKey = process.env.SCOPUS_API_KEY;
  const originalInstitutionToken = process.env.SCIENCEDIRECT_INSTITUTION_TOKEN;

  try {
    process.env.SCOPUS_API_KEY = "elsevier-test-key";
    process.env.SCIENCEDIRECT_INSTITUTION_TOKEN = "bad-inst-token";

    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.elsevier.com" && url.pathname === "/content/search/scopus") {
        return new Response(JSON.stringify({
          "search-results": {
            entry: [
              {
                "dc:title": "Autonomous research agents for scientific planning",
                "dc:description": "Autonomous research agents scientific planning literature review and evaluation.",
                "prism:publicationName": "Journal of Research Systems",
                "prism:coverDate": "2025-02-01",
                "prism:doi": "10.1016/j.example.2025.1001",
                "prism:url": "https://api.elsevier.com/content/abstract/scopus_id/123456",
                authors: {
                  author: [
                    {
                      given: "Grace",
                      surname: "Hopper"
                    }
                  ]
                },
                openaccessArticle: false
              }
            ]
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.hostname === "api.elsevier.com" && url.pathname === "/content/search/sciencedirect") {
        return new Response(JSON.stringify({
          error: "unauthorized"
        }), { status: 401, statusText: "Unauthorized", headers: { "content-type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const gatherer = new DefaultResearchSourceGatherer();
    const gathered = await gatherer.gather({
      projectRoot,
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "How should planning loops be structured?",
        researchDirection: "Review planning strategies and evaluation setups.",
        successCriterion: "Produce a planning-grounded synthesis."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review planning-loop papers for autonomous research agents.",
        rationale: "Scopus discovery should still work even when ScienceDirect entitlement fails.",
        searchQueries: ["autonomous research agents scientific planning"],
        localFocus: ["planning", "evaluation"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["elsevier"]
    });

    assert.equal(gathered.canonicalPapers.length, 1);
    assert.equal(gathered.canonicalPapers[0]?.bestAccessProvider, "elsevier");
    assert.match(gathered.notes.join("\n"), /Canonical merge produced 1 scholarly papers/i);
    assert.doesNotMatch(gathered.notes.join("\n"), /elsevier query failed/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalScopusKey === undefined) {
      delete process.env.SCOPUS_API_KEY;
    } else {
      process.env.SCOPUS_API_KEY = originalScopusKey;
    }
    if (originalInstitutionToken === undefined) {
      delete process.env.SCIENCEDIRECT_INSTITUTION_TOKEN;
    } else {
      process.env.SCIENCEDIRECT_INSTITUTION_TOKEN = originalInstitutionToken;
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("springer nature discovery and OA lookup resolve an open full-text route", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-springer-"));
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SPRINGER_NATURE_API_KEY;

  try {
    process.env.SPRINGER_NATURE_API_KEY = "springer-test-key";

    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "api.springernature.com" && url.pathname === "/meta/v2/json") {
        return new Response(JSON.stringify({
          records: [
            {
              title: "Autonomous research agents and reproducible literature synthesis",
              abstract: "Autonomous research agents reproducible literature synthesis evaluation methods.",
              publicationDate: "2025-03-01",
              publicationName: "AI and Society",
              doi: "10.1007/example-2025-1",
              creators: [
                {
                  creator: "Karen Sparck Jones"
                }
              ],
              url: [
                {
                  format: "html",
                  value: "https://link.springer.com/article/10.1007/example-2025-1"
                }
              ]
            }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.hostname === "api.springernature.com" && url.pathname === "/openaccess/json") {
        return new Response(JSON.stringify({
          records: [
            {
              title: "Autonomous research agents and reproducible literature synthesis",
              abstract: "Autonomous research agents reproducible literature synthesis evaluation methods.",
              publicationDate: "2025-03-01",
              publicationName: "AI and Society",
              doi: "10.1007/example-2025-1",
              creators: [
                {
                  creator: "Karen Sparck Jones"
                }
              ],
              url: [
                {
                  format: "pdf",
                  value: "https://media.springernature.com/full/springer-static/pdf/example.pdf"
                }
              ],
              license: "CC BY 4.0"
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
        researchQuestion: "How can literature synthesis be made reproducible?",
        researchDirection: "Review synthesis workflows and evaluation practices.",
        successCriterion: "Produce a reproducibility-grounded synthesis."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review reproducible literature-synthesis workflows for autonomous research agents.",
        rationale: "Springer Nature should contribute publisher metadata and OA access routes.",
        searchQueries: ["autonomous research agents reproducible literature synthesis"],
        localFocus: ["literature synthesis", "reproducibility"]
      },
      memoryContext: emptyMemoryContext(),
      scholarlyProviderIds: ["springer_nature"]
    });

    assert.equal(gathered.canonicalPapers.length, 1);
    assert.equal(gathered.canonicalPapers[0]?.bestAccessProvider, "springer_nature");
    assert.equal(gathered.canonicalPapers[0]?.accessMode, "fulltext_open");
    assert.equal(gathered.canonicalPapers[0]?.fulltextFormat, "pdf");
    assert.equal(gathered.canonicalPapers[0]?.license, "CC BY 4.0");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.SPRINGER_NATURE_API_KEY;
    } else {
      process.env.SPRINGER_NATURE_API_KEY = originalApiKey;
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});
