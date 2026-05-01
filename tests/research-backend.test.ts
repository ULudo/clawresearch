import test from "node:test";
import assert from "node:assert/strict";
import {
  OllamaResearchBackend,
  OpenAIResponsesResearchBackend
} from "../src/runtime/research-backend.js";
import { RuntimeModelClient, type ModelCredentialState } from "../src/runtime/model-runtime.js";
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

function modelCredentials(apiKey = "test-openai-key"): ModelCredentialState {
  return {
    schemaVersion: 1,
    projectRoot: "/tmp/project",
    runtimeDirectory: "/tmp/project/.clawresearch",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    openai: {
      apiKey
    },
    openaiCodex: null
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

test("research-agent backend uses native tool calls by default", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: {
    tools?: Array<{ function?: { name?: string; parameters?: { properties?: { action?: { enum?: string[] } } } } }>;
    messages?: Array<{ content?: string }>;
  } = {};

  try {
    globalThis.fetch = async (_input, init): Promise<Response> => {
      capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;

      return new Response(JSON.stringify({
        message: {
          tool_calls: [{
            function: {
              name: "choose_research_action",
              arguments: {
                action: "claim.create",
                rationale: "The selected evidence is ready for a claim-led synthesis step.",
                confidence: 0.88,
                inputs: {
                  searchQueries: [],
                  evidenceTargets: [],
                  paperIds: ["paper-1"],
                  criticStage: null,
                  reason: null
                },
                expectedOutcome: "A claim object is written to the work store.",
                stopCondition: "Stop after the claim tool persists the object."
              }
            }
          }]
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
      allowedActions: ["source.search", "claim.create", "manuscript.status"],
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

    assert.equal(decision.action, "claim.create");
    assert.equal(decision.transport, "native_tool_call");
    assert.equal(decision.inputs.paperIds[0], "paper-1");
    assert.equal(capturedBody.tools?.[0]?.function?.name, "choose_research_action");
    assert.deepEqual(capturedBody.tools?.[0]?.function?.parameters?.properties?.action?.enum, [
      "source.search",
      "claim.create",
      "manuscript.status"
    ]);
    assert.match(capturedBody.messages?.[0]?.content ?? "", /Call choose_research_action exactly once/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("research-agent backend falls back to strict JSON when native tool calls are unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const capturedBodies: Array<{
    tools?: unknown[];
    format?: string;
    messages?: Array<{ content?: string }>;
  }> = [];

  try {
    globalThis.fetch = async (_input, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as typeof capturedBodies[number];
      capturedBodies.push(body);

      if (capturedBodies.length === 1) {
        return new Response(JSON.stringify({
          message: {
            content: "I cannot call tools from this model."
          }
        }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            action: "claim.create",
            rationale: "The strict JSON fallback selected claim creation.",
            confidence: 0.72,
            inputs: {
              searchQueries: [],
              evidenceTargets: [],
              paperIds: [],
              criticStage: null,
              reason: null
            },
            expectedOutcome: "A claim object is written to the work store.",
            stopCondition: "Stop after the claim tool persists the object."
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
      allowedActions: ["source.search", "claim.create", "manuscript.status"],
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

    assert.equal(decision.action, "claim.create");
    assert.equal(decision.transport, "strict_json");
    assert.equal(decision.transportFallback?.from, "native_tool_call");
    assert.equal(decision.transportFallback?.to, "strict_json");
    assert.equal(decision.transportFallback?.kind, "malformed_json");
    assert.equal(capturedBodies.length, 2);
    assert.ok(Array.isArray(capturedBodies[0]?.tools));
    assert.equal(capturedBodies[1]?.format, "json");
    assert.equal(capturedBodies[1]?.tools, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI Responses backend uses native function tools for research actions", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: {
    model?: string;
    tools?: Array<Record<string, unknown>>;
    tool_choice?: Record<string, unknown>;
    instructions?: string;
  } = {};

  try {
    globalThis.fetch = async (input, init): Promise<Response> => {
      capturedUrl = String(input);
      capturedAuth = new Headers(init?.headers as Record<string, string>).get("authorization") ?? "";
      capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
      return new Response(JSON.stringify({
        output: [{
          type: "function_call",
          name: "choose_research_action",
          arguments: JSON.stringify({
            action: "claim.create",
            rationale: "The selected evidence is ready for claim creation.",
            confidence: 0.86,
            inputs: {
              searchQueries: [],
              evidenceTargets: [],
              paperIds: ["paper-1"],
              criticStage: null,
              reason: null
            },
            expectedOutcome: "A claim object is written to the work store.",
            stopCondition: "Stop after the claim tool persists the object."
          })
        }]
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const backend = new OpenAIResponsesResearchBackend(new RuntimeModelClient({
      provider: "openai",
      model: "gpt-test",
      host: null,
      baseUrl: "https://api.openai.test/v1",
      configured: true,
      label: "openai:gpt-test"
    }, modelCredentials()));
    const decision = await backend.chooseResearchAction({
      projectRoot: "/tmp/project",
      runId: "run-agent-step",
      phase: "synthesis",
      attempt: 1,
      maxAttempts: 2,
      allowedActions: ["source.search", "claim.create", "manuscript.status"],
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

    assert.equal(decision.action, "claim.create");
    assert.equal(decision.transport, "native_tool_call");
    assert.equal(capturedUrl, "https://api.openai.test/v1/responses");
    assert.equal(capturedAuth, "Bearer test-openai-key");
    assert.equal(capturedBody.model, "gpt-test");
    assert.equal(capturedBody.tools?.[0]?.name, "choose_research_action");
    assert.equal(capturedBody.tool_choice?.name, "choose_research_action");
    assert.match(capturedBody.instructions ?? "", /Call choose_research_action exactly once/);
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
              papersToPromote: [],
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
    assert.doesNotMatch(prompt, /trace\.log|events\.jsonl|revision history/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent-step backend exposes first-class claim and manuscript-section tools", async () => {
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
            action: "claim.create",
            rationale: "Create the next evidence-backed claim from the work store.",
            confidence: 0.83,
            inputs: {
              searchQueries: [],
              evidenceTargets: [],
              paperIds: ["paper-1"],
              criticStage: null,
              reason: null,
              workStore: {
                collection: "claims",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                changes: {},
                entity: {
                  text: "The reviewed papers support a bounded claim.",
                  evidence: "The evidence cell and source screening support this claim.",
                  sourceIds: ["paper-1"]
                }
              }
            },
            expectedOutcome: "A claim object is persisted.",
            stopCondition: "The claim exists in the work store."
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
      allowedActions: ["workspace.search", "claim.create", "section.create", "section.check_claims", "workspace.status"],
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
      observations: {
        canonicalPapers: 4,
        selectedPapers: 3,
        extractedPapers: 3,
        evidenceRows: 3,
        evidenceInsights: 2,
        manuscriptReadiness: "needs_human_review",
        revisionPassesUsed: 0,
        revisionPassesRemaining: 2
      },
      workStore: {
        path: "/tmp/project/.clawresearch/workspace.sqlite",
        summary: {
          canonicalSources: 3,
          extractions: 3,
          evidenceCells: 6,
          claims: 0,
          openWorkItems: 1,
          releaseChecks: 0
        },
        worker: {
          status: "working",
          statusReason: "Testing the agent tool loop.",
          paperReadiness: "needs_human_review",
          nextInternalActions: ["Create claim-led synthesis objects."],
          userBlockers: []
        },
        openWorkItems: [],
        recentSources: [{
          id: "paper-1",
          title: "Design Patterns for Autonomous Research Agents",
          screeningDecision: "include",
          accessMode: "fulltext_open"
        }],
        recentClaims: [],
        recentSections: [],
        recentCitations: []
      },
      criticReports: []
    });

    assert.equal(decision.action, "claim.create");
    assert.match(capturedPrompt, /workspace\.search/i);
    assert.match(capturedPrompt, /claim\.create/i);
    assert.match(capturedPrompt, /section\.create/i);
    assert.match(capturedPrompt, /section\.check_claims/i);
    assert.doesNotMatch(capturedPrompt, /synthesize_clustered|finalize_status_report|write_final_report/i);
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
