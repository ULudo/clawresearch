import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultResearchSourceGatherer } from "../src/runtime/research-sources.js";
import type { ProjectMemoryContext } from "../src/runtime/memory-store.js";

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

test("source gathering filters out broad OpenAlex results that do not match the project anchors closely enough", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-"));
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

      if (url.pathname === "/works") {
        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W1",
              display_name: "AI adoption in nursing homes and workforce change",
              publication_year: 2024,
              authorships: [
                {
                  author: {
                    display_name: "Relevant Author"
                  }
                }
              ],
              primary_location: {
                source: {
                  display_name: "Journal of Long-Term Care Studies"
                },
                landing_page_url: "https://example.org/nursing-homes"
              },
              abstract_inverted_index: toAbstractIndex(
                "This study examines nursing homes workforce displacement risks from AI supported automation and staffing changes."
              )
            },
            {
              id: "https://openalex.org/W2",
              display_name: "AI and workforce displacement in healthcare",
              publication_year: 2024,
              authorships: [
                {
                  author: {
                    display_name: "Generic Author"
                  }
                }
              ],
              primary_location: {
                source: {
                  display_name: "Healthcare Labor Review"
                },
                landing_page_url: "https://example.org/healthcare"
              },
              abstract_inverted_index: toAbstractIndex(
                "This paper studies hospital and clinic labor markets under automation across healthcare systems."
              )
            }
          ]
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
        topic: "AI adoption and workforce displacement in nursing homes",
        researchQuestion: "How might AI adoption affect workforce displacement across nursing-home jobs in general?",
        researchDirection: "Review current evidence on nursing homes and displacement risks across job categories.",
        successCriterion: "Produce a grounded first-pass note on displacement risks in nursing homes."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Map evidence on AI adoption and workforce displacement in nursing homes.",
        rationale: "Start with the literature most directly tied to the domain.",
        searchQueries: [
          "AI nursing homes workforce displacement",
          "nursing homes automation staffing"
        ],
        localFocus: [
          "nursing homes",
          "workforce displacement"
        ]
      },
      memoryContext: emptyMemoryContext()
    });

    const sourceTitles = gathered.sources.map((source) => source.title);

    assert.ok(sourceTitles.includes("AI adoption in nursing homes and workforce change"));
    assert.ok(!sourceTitles.includes("AI and workforce displacement in healthcare"));
    assert.match(
      gathered.notes.join("\n"),
      /Filtered \d+ low-relevance OpenAlex candidates that did not match the project anchors closely enough\./
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source gathering uses project memory query hints to expand OpenAlex retrieval", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-memory-"));
  const originalFetch = globalThis.fetch;
  const seenQueries: string[] = [];

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );

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

      if (url.pathname === "/w/api.php") {
        return new Response(JSON.stringify({
          query: {
            search: []
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
        rationale: "Prior project memory should shape retrieval.",
        searchQueries: [],
        localFocus: []
      },
      memoryContext: emptyMemoryContext({
        available: true,
        recordCount: 2,
        countsByType: {
          source: 0,
          claim: 0,
          finding: 1,
          question: 1,
          idea: 0,
          summary: 0,
          artifact: 0
        },
        findings: [
          {
            id: "finding-1",
            title: "Mollifier limitations remain central",
            text: "Prior work suggests mollifier limitations are the clearest bounded follow-up.",
            runId: "run-prior",
            linkedRecordIds: [],
            data: {}
          }
        ],
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
          "Which obstacles limit mollifier methods for the Riemann Hypothesis?"
        ]
      })
    });

    assert.ok(
      seenQueries.some((query) => /mollifier methods/i.test(query)),
      `Expected memory-derived OpenAlex query, saw: ${seenQueries.join(" | ")}`
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source gathering can retain a strongly matched OpenAlex title-only source when the abstract is missing", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-title-only-"));
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

      if (url.pathname === "/works") {
        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W-title-only",
              display_name: "Riemann Hypothesis proof techniques survey",
              publication_year: 2024,
              authorships: [
                {
                  author: {
                    display_name: "Relevant Author"
                  }
                }
              ],
              primary_location: {
                source: {
                  display_name: "Number Theory Review"
                },
                landing_page_url: "https://example.org/rh-techniques"
              },
              abstract_inverted_index: null
            }
          ]
        }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      if (url.pathname === "/w/api.php") {
        return new Response(JSON.stringify({
          query: {
            search: []
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
        researchQuestion: "What proof techniques are most prominent?",
        researchDirection: "Survey current proof-technique families.",
        successCriterion: "Produce a bounded technique overview."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Survey proof-technique families.",
        rationale: "Use directly relevant literature first.",
        searchQueries: [
          "Riemann Hypothesis proof techniques"
        ],
        localFocus: [
          "proof techniques"
        ]
      },
      memoryContext: emptyMemoryContext()
    });

    assert.ok(
      gathered.sources.some((source) => source.title === "Riemann Hypothesis proof techniques survey"),
      "Expected the strongly matched title-only OpenAlex source to be retained."
    );
    assert.match(
      gathered.notes.join("\n"),
      /Retained 1 strongly matched OpenAlex works even though OpenAlex did not provide abstracts for them\./
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source gathering preserves named topic anchors so partial name overlap does not admit irrelevant sources", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-topic-anchor-"));
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

      if (url.pathname === "/works") {
        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W-rh",
              display_name: "Riemann Hypothesis proof techniques survey",
              publication_year: 2024,
              authorships: [
                {
                  author: {
                    display_name: "Relevant Author"
                  }
                }
              ],
              primary_location: {
                source: {
                  display_name: "Journal of Number Theory"
                },
                landing_page_url: "https://example.org/rh"
              },
              abstract_inverted_index: toAbstractIndex(
                "This survey reviews proof techniques and current limitations related to the Riemann Hypothesis."
              )
            },
            {
              id: "https://openalex.org/W-manifold",
              display_name: "Riemann Manifold Langevin and Hamiltonian Monte Carlo Methods",
              publication_year: 2010,
              authorships: [
                {
                  author: {
                    display_name: "Irrelevant Author"
                  }
                }
              ],
              primary_location: {
                source: {
                  display_name: "Statistics Journal"
                },
                landing_page_url: "https://example.org/manifold"
              },
              abstract_inverted_index: toAbstractIndex(
                "This paper studies sampling methods on Riemann manifolds."
              )
            }
          ]
        }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      if (url.pathname === "/w/api.php") {
        return new Response(JSON.stringify({
          query: {
            search: []
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
        researchQuestion: "Which proof techniques are most prominent and what are their limitations?",
        researchDirection: "Compare the main approaches and identify the clearest gaps.",
        successCriterion: "Produce a grounded first-pass comparison."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Compare proof techniques for the Riemann Hypothesis.",
        rationale: "Prioritize directly relevant literature.",
        searchQueries: [
          "Riemann Hypothesis proof techniques limitations"
        ],
        localFocus: [
          "proof techniques",
          "limitations"
        ]
      },
      memoryContext: emptyMemoryContext()
    });

    const sourceTitles = gathered.sources.map((source) => source.title);

    assert.ok(sourceTitles.includes("Riemann Hypothesis proof techniques survey"));
    assert.ok(!sourceTitles.includes("Riemann Manifold Langevin and Hamiltonian Monte Carlo Methods"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source gathering uses the literature-review subsystem to reject generic background sources for review tasks", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-literature-subsystem-"));
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

      if (url.pathname === "/works") {
        return new Response(JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W-agents",
              display_name: "Design Patterns for Autonomous Research Agents",
              publication_year: 2026,
              authorships: [
                {
                  author: {
                    display_name: "Relevant Author"
                  }
                }
              ],
              primary_location: {
                source: {
                  display_name: "AI Systems Review"
                },
                landing_page_url: "https://example.org/agents"
              },
              abstract_inverted_index: toAbstractIndex(
                "This review compares design patterns and evaluation practices for autonomous research agents."
              )
            },
            {
              id: "https://openalex.org/W-generic",
              display_name: "Learning analytics and AI: Politics, pedagogy and practices",
              publication_year: 2020,
              authorships: [
                {
                  author: {
                    display_name: "Generic Author"
                  }
                }
              ],
              primary_location: {
                source: {
                  display_name: "Education Journal"
                },
                landing_page_url: "https://example.org/education"
              },
              abstract_inverted_index: toAbstractIndex(
                "This paper discusses AI practices in learning analytics and educational settings."
              )
            }
          ]
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
        topic: "autonomous research agents",
        researchQuestion: "What design and implementation best practices does the literature suggest for autonomous research agents?",
        researchDirection: "Run a literature synthesis comparing design patterns and evaluation practices.",
        successCriterion: "Produce a literature-grounded note."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Synthesize best practices for autonomous research agents.",
        rationale: "This is explicitly a literature review task.",
        searchQueries: [
          "autonomous research agents best practices"
        ],
        localFocus: [
          "design patterns",
          "evaluation practices"
        ]
      },
      memoryContext: emptyMemoryContext()
    });

    const sourceTitles = gathered.sources.map((source) => source.title);

    assert.ok(sourceTitles.includes("Design Patterns for Autonomous Research Agents"));
    assert.ok(!sourceTitles.includes("Learning analytics and AI: Politics, pedagogy and practices"));
    assert.match(gathered.notes.join("\n"), /Literature review subsystem active\./);
    assert.match(gathered.notes.join("\n"), /Task-aware paper ranking attributes:/);
    assert.equal(gathered.literatureReview?.active, true);
    assert.equal(gathered.literatureReview?.selectedAssessments.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source gathering falls back to Wikipedia summaries when OpenAlex returns malformed data", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-sources-wikipedia-fallback-"));
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

      if (url.pathname === "/works") {
        return new Response("null", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      if (url.pathname === "/w/api.php") {
        return new Response(JSON.stringify({
          query: {
            search: [
              {
                title: "Riemann hypothesis"
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

      if (url.pathname === "/api/rest_v1/page/summary/Riemann%20hypothesis") {
        return new Response(JSON.stringify({
          title: "Riemann hypothesis",
          extract: "The Riemann hypothesis is a conjecture about the zeros of the Riemann zeta function and the distribution of prime numbers.",
          content_urls: {
            desktop: {
              page: "https://en.wikipedia.org/wiki/Riemann_hypothesis"
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
        researchQuestion: "What are the main proof-technique families around the Riemann Hypothesis?",
        researchDirection: "Gather initial background and literature anchors.",
        successCriterion: "Produce a grounded starting note."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Find a credible starting source set for the Riemann Hypothesis.",
        rationale: "Fallback sources should be allowed when the literature endpoint misbehaves.",
        searchQueries: [
          "Riemann Hypothesis proof techniques"
        ],
        localFocus: [
          "proof techniques"
        ]
      },
      memoryContext: emptyMemoryContext()
    });

    assert.ok(
      gathered.sources.some((source) => source.kind === "wikipedia_article" && /Riemann hypothesis/i.test(source.title)),
      "Expected a Wikipedia fallback source when OpenAlex returned malformed data."
    );
    assert.match(
      gathered.notes.join("\n"),
      /OpenAlex query failed/i
    );
    assert.match(
      gathered.notes.join("\n"),
      /Collected 1 Wikipedia fallback background sources\./
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
