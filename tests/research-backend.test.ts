import test from "node:test";
import assert from "node:assert/strict";
import { OllamaResearchBackend } from "../src/runtime/research-backend.js";
import type { ProjectMemoryContext } from "../src/runtime/memory-store.js";
import type { EvidenceMatrix, PaperExtraction } from "../src/runtime/research-evidence.js";

function extractionForPaper(paperId: string): PaperExtraction {
  return {
    id: `extraction-${paperId}`,
    paperId,
    runId: "run-test",
    problemSetting: "Autonomous research-agent design.",
    systemType: "research agent",
    architecture: "planning plus tool use",
    toolsAndMemory: "tools plus bounded memory",
    planningStyle: "iterative",
    evaluationSetup: "literature comparison",
    successSignals: ["bounded autonomy"],
    failureModes: ["weak evaluation"],
    limitations: ["small reviewed set"],
    supportedClaims: [{
      claim: "Bounded autonomy matters.",
      support: "explicit"
    }],
    confidence: "high",
    evidenceNotes: ["Grounded in the reviewed paper."]
  };
}

function matrixForPaper(paperId: string): EvidenceMatrix {
  const extraction = extractionForPaper(paperId);
  return {
    schemaVersion: 1,
    runId: "run-test",
    briefFingerprint: "brief-fingerprint",
    rowCount: 1,
    rows: [{
      paperId,
      extractionId: extraction.id,
      problemSetting: extraction.problemSetting,
      systemType: extraction.systemType,
      architecture: extraction.architecture,
      toolsAndMemory: extraction.toolsAndMemory,
      planningStyle: extraction.planningStyle,
      evaluationSetup: extraction.evaluationSetup,
      successSignals: extraction.successSignals,
      failureModes: extraction.failureModes,
      limitations: extraction.limitations,
      claimCount: extraction.supportedClaims.length,
      confidence: extraction.confidence
    }],
    derivedInsights: [{
      id: "insight-gap-1",
      kind: "gap",
      title: "Evaluation remains weak",
      summary: "Evaluation remains weak across the reviewed evidence.",
      paperIds: [paperId],
      claimTexts: []
    }]
  };
}

function emptyMemoryContext(): ProjectMemoryContext {
  return {
    available: true,
    recordCount: 3,
    countsByType: {
      claim: 0,
      finding: 1,
      question: 1,
      idea: 1,
      summary: 0,
      artifact: 0,
      direction: 0,
      hypothesis: 0,
      method_plan: 0
    },
    claims: [],
    findings: [
      {
        id: "finding-1",
        title: "Mollifier limitations remain central",
        text: "Prior work suggests mollifier limitations are the clearest bounded follow-up.",
        runId: "run-prior",
        links: [],
        data: {}
      }
    ],
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
    ideas: [
      {
        id: "idea-1",
        title: "Follow the mollifier thread",
        text: "Use mollifier limitations as the next bounded literature pass.",
        runId: "run-prior",
        links: [],
        data: {}
      }
    ],
    summaries: [],
    artifacts: [],
    directions: [],
    hypotheses: [],
    methodPlans: [],
    queryHints: [
      "Which obstacles limit mollifier methods for the Riemann Hypothesis?",
      "Follow the mollifier thread"
    ],
    localFileHints: []
  };
}

test("planning backend includes project memory context in the prompt it sends to Ollama", async () => {
  const originalFetch = globalThis.fetch;
  let capturedPrompt = "";

  try {
    globalThis.fetch = async (_input, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: string }>;
      };
      capturedPrompt = body.messages?.[0]?.content ?? "";

      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            researchMode: "literature_synthesis",
            objective: "Follow prior mollifier limitations work.",
            rationale: "Project memory already identified the next bounded question.",
            searchQueries: ["mollifier methods Riemann Hypothesis limitations"],
            localFocus: ["mollifier methods"]
          })
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const backend = new OllamaResearchBackend("127.0.0.1:11434", "stub-model");
    const plan = await backend.planResearch({
      projectRoot: "/tmp/project",
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: "What bounded follow-up should we pursue next?",
        researchDirection: "Build on the strongest prior lead.",
        successCriterion: "Produce a focused follow-up synthesis."
      },
      localFiles: [],
      memoryContext: emptyMemoryContext()
    });

    assert.equal(plan.researchMode, "literature_synthesis");
    assert.match(capturedPrompt, /Project memory context:/);
    assert.match(capturedPrompt, /mollifier limitations/i);
    assert.match(capturedPrompt, /Follow the mollifier thread/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama backend accumulates streamed JSON chunks instead of relying on one response blob", async () => {
  const originalFetch = globalThis.fetch;
  let capturedStreamFlag: unknown = null;

  try {
    globalThis.fetch = async (_input, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        stream?: unknown;
      };
      capturedStreamFlag = body.stream;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify({
            message: {
              content: "{\"researchMode\":\"literature_synthesis\",\"objective\":\"Streamed"
            }
          })}\n`));
          controller.enqueue(encoder.encode(`${JSON.stringify({
            message: {
              content: " planning\",\"rationale\":\"The streamed response was assembled.\",\"searchQueries\":[\"streamed planning\"],\"localFocus\":[\"streaming\"]}"
            }
          })}\n`));
          controller.enqueue(encoder.encode(`${JSON.stringify({ done: true })}\n`));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson"
        }
      });
    };

    const backend = new OllamaResearchBackend("127.0.0.1:11434", "stub-model");
    const plan = await backend.planResearch({
      projectRoot: "/tmp/project",
      brief: {
        topic: "streaming",
        researchQuestion: "Can streamed responses be assembled?",
        researchDirection: "Test streaming LLM orchestration.",
        successCriterion: "Return a valid plan."
      },
      localFiles: [],
      memoryContext: emptyMemoryContext()
    });

    assert.equal(capturedStreamFlag, true);
    assert.equal(plan.objective, "Streamed planning");
    assert.deepEqual(plan.searchQueries, ["streamed planning"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("research-agent backend asks for one allowed structured action", async () => {
  const originalFetch = globalThis.fetch;
  let capturedPrompt = "";

  try {
    globalThis.fetch = async (_input, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: string }>;
      };
      capturedPrompt = body.messages?.[0]?.content ?? "";

      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            action: "synthesize_clustered",
            rationale: "The selected evidence is ready for clustered synthesis.",
            confidence: 0.88,
            inputs: {
              searchQueries: [],
              evidenceTargets: [],
              paperIds: ["paper-1"],
              criticStage: null,
              reason: null
            },
            expectedOutcome: "A synthesis checkpoint is written.",
            stopCondition: "Stop after synthesis artifacts are checkpointed."
          })
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const backend = new OllamaResearchBackend("127.0.0.1:11434", "stub-model");
    const decision = await backend.chooseResearchAction({
      projectRoot: "/tmp/project",
      runId: "run-agent-step",
      phase: "synthesis",
      attempt: 1,
      maxAttempts: 2,
      allowedActions: ["revise_search_strategy", "synthesize_clustered", "finalize_status_report"],
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "How should the runtime continue?",
        researchDirection: "Use an action loop.",
        successCriterion: "Choose the next validated action."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Review action-loop designs.",
        rationale: "The brief asks for autonomous research behavior.",
        searchQueries: ["autonomous research agents tool use"],
        localFocus: ["action loop"]
      },
      observations: {
        canonicalPapers: 5,
        selectedPapers: 4,
        extractedPapers: 4,
        evidenceRows: 4,
        evidenceInsights: 2,
        manuscriptReadiness: null,
        revisionPassesUsed: 0,
        revisionPassesRemaining: 3
      },
      criticReports: []
    });

    assert.equal(decision.action, "synthesize_clustered");
    assert.equal(decision.inputs.paperIds[0], "paper-1");
    assert.match(capturedPrompt, /Allowed actions: revise_search_strategy, synthesize_clustered, finalize_status_report/);
    assert.match(capturedPrompt, /Do not execute the action yourself/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("critic backend uses the separate critic model and excludes research memory context", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: {
    model?: string;
    messages?: Array<{ content?: string }>;
  } = {};

  try {
    globalThis.fetch = async (input, init): Promise<Response> => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;

      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            readiness: "pass",
            confidence: 0.9,
            objections: [],
            revisionAdvice: {
              searchQueries: [],
              evidenceTargets: [],
              papersToExclude: [],
              claimsToSoften: []
            }
          })
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const backend = new OllamaResearchBackend("normal-host:11434", "normal-model", "critic-host:11434", "critic-model");
    const report = await backend.reviewResearchArtifact({
      projectRoot: "/tmp/project",
      runId: "run-test",
      stage: "protocol",
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "What evidence supports literature-review automation?",
        researchDirection: "Review scoped evidence.",
        successCriterion: "Use traceable citations."
      },
      protocol: null
    });

    const prompt = capturedBody.messages?.[0]?.content ?? "";
    assert.equal(report.readiness, "pass");
    assert.match(capturedUrl, /critic-host:11434/);
    assert.equal(capturedBody.model, "critic-model");
    assert.match(prompt, /stateless critic reviewer/);
    assert.match(prompt, /no tools/i);
    assert.match(prompt, /Missing selected papers is expected/i);
    assert.doesNotMatch(prompt, /Selected papers:/);
    assert.doesNotMatch(prompt, /Project memory context/i);
    assert.doesNotMatch(prompt, /trace\.log|events\.jsonl|recovery history/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("synthesis backend uses canonical papers in the specialized literature-review prompt", async () => {
  const originalFetch = globalThis.fetch;
  let capturedPrompt = "";

  try {
    globalThis.fetch = async (_input, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: string }>;
      };
      capturedPrompt = body.messages?.[0]?.content ?? "";

      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            executiveSummary: "A literature-grounded summary.",
            themes: [],
            claims: [],
            nextQuestions: []
          })
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const backend = new OllamaResearchBackend("127.0.0.1:11434", "stub-model");
    await backend.synthesizeResearch({
      projectRoot: "/tmp/project",
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "What best practices in the literature matter most?",
        researchDirection: "Run a literature synthesis comparing architectures and evaluation practices.",
        successCriterion: "Produce a literature-grounded note."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Synthesize the literature on autonomous research agents.",
        rationale: "This is a literature review task.",
        searchQueries: ["autonomous research agents literature review"],
        localFocus: ["evaluation practices"]
      },
      papers: [
        {
          id: "paper-1",
          key: "doi:10.1000/agents",
          title: "Design Patterns for Autonomous Research Agents",
          citation: "Example Author (2026). Design Patterns for Autonomous Research Agents.",
          abstract: "This review compares architecture choices and evaluation practices.",
          year: 2026,
          authors: ["Example Author"],
          venue: "AI Systems Review",
          discoveredVia: ["openalex"],
          identifiers: {
            doi: "10.1000/agents",
            pmid: null,
            pmcid: null,
            arxivId: null
          },
          discoveryRecords: [],
          accessCandidates: [],
          bestAccessUrl: "https://example.org/agents.pdf",
          bestAccessProvider: "openalex",
          accessMode: "fulltext_open",
          fulltextFormat: "pdf",
          license: null,
          tdmAllowed: true,
          contentStatus: {
            abstractAvailable: true,
            fulltextAvailable: true,
            fulltextFetched: false,
            fulltextExtracted: false
          },
          screeningHistory: [{
            stage: "title",
            decision: "uncertain",
            rationale: "Retained after title screening for deeper review."
          }, {
            stage: "abstract",
            decision: "include",
            rationale: "Abstract-level screening supported deeper review."
          }, {
            stage: "fulltext",
            decision: "include",
            rationale: "Highly relevant."
          }],
          screeningStage: "fulltext",
          screeningDecision: "include",
          screeningRationale: "Highly relevant.",
          accessErrors: [],
          tags: ["quality:high", "quality-signal:journal-like-venue"],
          runIds: [],
          linkedThemeIds: [],
          linkedClaimIds: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      paperExtractions: [extractionForPaper("paper-1")],
      evidenceMatrix: matrixForPaper("paper-1"),
      selectionQuality: {
        schemaVersion: 1,
        requiredFacets: [{
          id: "facet-1",
          label: "agent evaluation",
          kind: "evaluation",
          required: true,
          terms: ["agent evaluation"],
          source: "success_criterion",
          rationale: "Test facet."
        }],
        optionalFacets: [],
        paperFacetCoverage: [{
          paperId: "paper-1",
          coveredFacetIds: ["facet-1"],
          missingRequiredFacetIds: [],
          coverageScore: 4,
          matchedTerms: ["agent evaluation"],
          rationale: "Covered."
        }],
        selectedSetCoverage: [{
          facetId: "facet-1",
          label: "agent evaluation",
          required: true,
          coveredByPaperIds: ["paper-1"],
          count: 1
        }],
        missingRequiredFacets: [],
        backgroundOnlyFacets: [],
        adequacy: "partial",
        selectionRationale: ["Selected set covers the test facet."]
      }
    });

    assert.match(capturedPrompt, /dedicated literature-review synthesis module/i);
    assert.match(capturedPrompt, /Treat this as a literature review subsystem/i);
    assert.match(capturedPrompt, /Sources:/);
    assert.match(capturedPrompt, /canonical_paper/);
    assert.match(capturedPrompt, /agents\.pdf/);
    assert.match(capturedPrompt, /Paper extractions:/);
    assert.match(capturedPrompt, /Evidence matrix:/);
    assert.match(capturedPrompt, /Use only exact sourceIds from the provided reviewed paper set/i);
    assert.match(capturedPrompt, /quality:low/i);
    assert.match(capturedPrompt, /Do not treat a loosely related background source as direct evidence/i);
    assert.match(capturedPrompt, /Review selection quality:/);
    assert.match(capturedPrompt, /agent evaluation/);
    assert.match(capturedPrompt, /evidence-boundary report/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extraction backend normalizes paper-by-paper extraction records", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            extractions: [{
              paperId: "paper-1",
              problemSetting: "Autonomous research-agent design",
              systemType: "research agent",
              architecture: "planner plus tools",
              toolsAndMemory: "",
              planningStyle: "iterative",
              evaluationSetup: "",
              successSignals: ["bounded autonomy"],
              failureModes: [],
              limitations: ["limited evaluation"],
              supportedClaims: [{
                claim: "Bounded autonomy matters.",
                support: "explicit"
              }],
              confidence: "medium",
              evidenceNotes: ["Grounded in the reviewed paper."]
            }]
          })
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const backend = new OllamaResearchBackend("127.0.0.1:11434", "stub-model");
    const extractions = await backend.extractReviewedPapers({
      projectRoot: "/tmp/project",
      runId: "run-test",
      brief: {
        topic: "autonomous research agents",
        researchQuestion: "Which design patterns matter most?",
        researchDirection: "Extract paper-by-paper evidence.",
        successCriterion: "Produce structured extractions."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Extract paper-level evidence.",
        rationale: "We need structured paper records before synthesis.",
        searchQueries: ["autonomous research agents design patterns"],
        localFocus: ["design patterns"]
      },
      papers: [{
        id: "paper-1",
        key: "doi:10.1000/agents",
        title: "Design Patterns for Autonomous Research Agents",
        citation: "Example Author (2026). Design Patterns for Autonomous Research Agents.",
        abstract: "This review compares architecture choices and evaluation practices.",
        year: 2026,
        authors: ["Example Author"],
        venue: "AI Systems Review",
        discoveredVia: ["openalex"],
        identifiers: {
          doi: "10.1000/agents",
          pmid: null,
          pmcid: null,
          arxivId: null
        },
        discoveryRecords: [],
        accessCandidates: [],
        bestAccessUrl: "https://example.org/agents.pdf",
        bestAccessProvider: "openalex",
        accessMode: "fulltext_open",
        fulltextFormat: "pdf",
        license: null,
        tdmAllowed: true,
        contentStatus: {
          abstractAvailable: true,
          fulltextAvailable: true,
          fulltextFetched: false,
          fulltextExtracted: false
        },
        screeningHistory: [{
          stage: "title",
          decision: "uncertain",
          rationale: "Retained after title screening for deeper review."
        }, {
          stage: "abstract",
          decision: "include",
          rationale: "Abstract-level screening supported deeper review."
        }, {
          stage: "fulltext",
          decision: "include",
          rationale: "Highly relevant."
        }],
        screeningStage: "fulltext",
        screeningDecision: "include",
        screeningRationale: "Highly relevant.",
        accessErrors: [],
        tags: ["quality:high"],
        runIds: [],
        linkedThemeIds: [],
        linkedClaimIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }]
    });

    assert.equal(extractions.length, 1);
    assert.equal(extractions[0]?.paperId, "paper-1");
    assert.equal(extractions[0]?.confidence, "medium");
    assert.deepEqual(extractions[0]?.successSignals, ["bounded autonomy"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("synthesis backend reconciles near-miss source ids to the reviewed paper set", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            executiveSummary: "A literature-grounded summary.",
            themes: [
              {
                title: "Technique families",
                summary: "The literature clusters around a few families.",
                sourceIds: ["paper-pv8531"]
              }
            ],
            claims: [
              {
                claim: "Mollifier methods remain central.",
                evidence: "Reviewed papers emphasize mollifier limitations.",
                sourceIds: ["paper-pv8531"]
              }
            ],
            nextQuestions: ["Which obstacle matters most next?"]
          })
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const backend = new OllamaResearchBackend("127.0.0.1:11434", "stub-model");
    const synthesis = await backend.synthesizeResearch({
      projectRoot: "/tmp/project",
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: "Which technique families matter most?",
        researchDirection: "Review proof-technique families.",
        successCriterion: "Produce a grounded technique map."
      },
      plan: {
        researchMode: "literature_synthesis",
        objective: "Synthesize proof-technique families.",
        rationale: "This is a literature review task.",
        searchQueries: ["Riemann Hypothesis proof techniques"],
        localFocus: ["mollifier methods"]
      },
      papers: [
        {
          id: "paper-pv8536",
          key: "doi:10.1000/mollifier",
          title: "Mollifier Methods for the Riemann Hypothesis",
          citation: "Example Author (2025). Mollifier Methods for the Riemann Hypothesis.",
          abstract: "Survey of mollifier methods and known limitations.",
          year: 2025,
          authors: ["Example Author"],
          venue: "Journal of Number Theory",
          discoveredVia: ["openalex"],
          identifiers: {
            doi: "10.1000/mollifier",
            pmid: null,
            pmcid: null,
            arxivId: null
          },
          discoveryRecords: [],
          accessCandidates: [],
          bestAccessUrl: "https://example.org/mollifier.pdf",
          bestAccessProvider: "openalex",
          accessMode: "fulltext_open",
          fulltextFormat: "pdf",
          license: null,
          tdmAllowed: true,
          contentStatus: {
            abstractAvailable: true,
            fulltextAvailable: true,
            fulltextFetched: false,
            fulltextExtracted: false
          },
          screeningHistory: [{
            stage: "title",
            decision: "uncertain",
            rationale: "Retained after title screening for deeper review."
          }, {
            stage: "abstract",
            decision: "include",
            rationale: "Abstract-level screening supported deeper review."
          }, {
            stage: "fulltext",
            decision: "include",
            rationale: "Highly relevant."
          }],
          screeningStage: "fulltext",
          screeningDecision: "include",
          screeningRationale: "Highly relevant.",
          accessErrors: [],
          tags: ["quality:high", "quality-signal:journal-like-venue"],
          runIds: [],
          linkedThemeIds: [],
          linkedClaimIds: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      paperExtractions: [extractionForPaper("paper-pv8536")],
      evidenceMatrix: matrixForPaper("paper-pv8536")
    });

    assert.deepEqual(synthesis.themes[0]?.sourceIds, ["paper-pv8536"]);
    assert.deepEqual(synthesis.claims[0]?.sourceIds, ["paper-pv8536"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
