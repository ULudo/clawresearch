import test from "node:test";
import assert from "node:assert/strict";
import {
  OllamaResearchBackend,
  OpenAIResponsesResearchBackend,
  ResearchBackendError
} from "../src/runtime/research-backend.js";
import { RuntimeModelClient, type ModelCredentialState } from "../src/runtime/model-runtime.js";
import type { WorkspacePromptContext } from "../src/runtime/research-work-store.js";
import type { EvidenceMatrix, PaperExtraction } from "../src/runtime/research-evidence.js";

type CapturedJsonSchema = {
  type?: unknown;
  enum?: string[];
  description?: string;
  properties?: Record<string, CapturedJsonSchema>;
  required?: string[];
  items?: CapturedJsonSchema;
};

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

function emptyWorkspaceContext(): WorkspacePromptContext {
  return {
    available: true,
    counts: {
      providerRuns: 0,
      sources: 0,
      canonicalSources: 0,
      screeningDecisions: 0,
      fullTextRecords: 0,
      extractions: 0,
      evidenceCells: 1,
      claims: 0,
      citations: 0,
      protocols: 0,
      workItems: 1,
      openWorkItems: 1,
      manuscriptSections: 0,
      releaseChecks: 0
    },
    corpus_view: {
      diagnosticOnly: true,
      note: "Fixture diagnostic corpus view.",
      canonicalSourceCount: 0,
      selectedSourceCount: 0,
      extractedSourceCount: 0,
      evidenceSourceCount: 0,
      citationSourceCount: 0,
      renderedReferenceSourceCount: 0,
      accessModeCounts: {},
      screeningDecisionCounts: {},
      providerRunCount: 0,
      sourceCandidateCount: 0,
      missingSelectedExtractionSourceIds: [],
      duplicateExtractionSourceIds: [],
      extractedNotEvidenceSourceIds: [],
      evidenceNotCitedSourceIds: [],
      selectedToRenderedCollapseSourceIds: []
    },
    synthesis_view: {
      diagnosticOnly: true,
      note: "Fixture diagnostic synthesis view.",
      activeExtractionCount: 0,
      activeEvidenceCellCount: 1,
      activeCitationCount: 0,
      claimCount: 0,
      claimsWithCitationSupportCount: 0,
      claimsWithoutCitationSupportIds: [],
      manuscriptSectionCount: 0,
      sectionsWithClaimLinksCount: 0,
      sectionsWithoutClaimLinksIds: [],
      sectionsWithoutCitationLinksIds: [],
      evidenceCellIdsWithoutCitationLinks: ["evidence-mollifier"],
      selectedSourceIdsNotCited: []
    },
	    notebook: {
	      missionTarget: "professional_paper",
	      paperMode: "literature_review",
	      objective: "Follow the mollifier thread.",
	      definitionOfDone: ["Explain which obstacles limit mollifier methods."],
	      currentFocus: "Mollifier limitations remain central.",
	      readiness: "Not ready; prior workspace evidence says the mollifier limitations thread still needs synthesis.",
      activeTasks: [{
        id: "task-mollifier",
        title: "Synthesize obstacles that limit mollifier methods",
        status: "todo",
        linkedSourceIds: [],
        linkedEvidenceCellIds: ["evidence-mollifier"],
        linkedClaimIds: [],
        linkedSectionIds: [],
        linkedArtifactPaths: []
	      }],
	      artifactLinks: [],
	      recentCriticReviews: [],
	      diagnostics: {
	        warningCount: 0,
	        warnings: [],
	        taskCount: 1,
	        activeTaskCount: 1,
	        readinessRecorded: true,
	        currentFocusSet: true,
	        definitionOfDoneAddressed: true,
	        unlinkedSelectedSourceIds: [],
	        unlinkedEvidenceCellIds: [],
	        unlinkedClaimIds: [],
	        unlinkedSectionIds: [],
	        staleAfterWorkspaceChange: false,
	        latestWorkspaceChangeAt: null,
	        disposition: {
	          selectedSourceIds: [],
	          extractedSourceIds: [],
	          evidenceCellSourceIds: [],
	          claimSourceIds: [],
	          citationSourceIds: [],
	          renderedReferenceSourceIds: [],
	          missingSelectedExtractionSourceIds: [],
	          duplicateExtractionSourceIds: [],
	          extractedNotEvidenceSourceIds: [],
	          evidenceNotCitedSourceIds: [],
	          selectedToRenderedCollapseSourceIds: [],
	          selectedToRenderedCollapse: false
	        }
	      }
	    },
    recentSources: [],
    recentExtractions: [],
    recentEvidenceCells: [{
      id: "evidence-mollifier",
      sourceId: "source-mollifier",
      extractionId: "extraction-mollifier",
      status: "active",
      supersededBy: null,
      field: "limitations",
      value: "Prior workspace evidence suggests mollifier limitations are the clearest bounded follow-up.",
      confidence: "medium"
    }],
    recentClaims: [],
    recentSections: [],
    openWorkItems: [{
      id: "workitem-mollifier",
      type: "open_question",
      title: "Which obstacles limit mollifier methods for the Riemann Hypothesis?",
      severity: "major",
      suggestedActions: [],
      targetId: "evidence-mollifier",
      affectedSourceIds: [],
      affectedClaimIds: []
    }],
    recentReleaseChecks: [],
    worker: {
      status: "working",
      statusReason: "Prior workspace context exists.",
      nextInternalActions: [],
      completion: null,
      lastRunId: "run-prior"
    }
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

test("planning backend includes derived SQLite workspace context in the prompt it sends to Ollama", async () => {
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
	            rationale: "The SQLite workspace already identified the next bounded question.",
	            searchQueries: ["mollifier methods Riemann Hypothesis limitations"],
	            localFocus: ["mollifier methods"],
	            notebookPatch: {
	              missionTarget: "professional_paper",
	              paperMode: "literature_review",
	              objective: "Follow prior mollifier limitations work.",
	              definitionOfDone: ["Explain which obstacles limit mollifier methods."],
	              currentFocus: "Synthesize mollifier limitations.",
	              readiness: "Not sufficient yet; planning initialized the notebook.",
	              tasks: [{
	                id: "task-mollifier-limitations",
	                title: "Synthesize mollifier limitations",
	                status: "todo",
	                notes: "Use prior workspace evidence before new claims.",
	                linkedEvidenceCellIds: ["evidence-mollifier"]
	              }]
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
      workspaceContext: emptyWorkspaceContext()
    });

	    assert.equal(plan.researchMode, "literature_synthesis");
	    assert.equal(plan.notebookPatch?.missionTarget, "professional_paper");
	    assert.equal(plan.notebookPatch?.paperMode, "literature_review");
	    assert.equal(plan.notebookPatch?.tasks?.[0]?.id, "task-mollifier-limitations");
	    assert.equal(plan.notebookPatch?.currentFocus, "Synthesize mollifier limitations.");
	    assert.match(capturedPrompt, /Workspace context:/);
	    assert.match(capturedPrompt, /notebookPatch/);
    assert.doesNotMatch(capturedPrompt, /Project memory context:/);
    assert.doesNotMatch(capturedPrompt, /"queryHints"|"methodPlans"|"hypotheses"|"directions"|"findings"|"countsByType"/i);
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
      workspaceContext: emptyWorkspaceContext()
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
    tools?: Array<{ function?: { name?: string; strict?: boolean; parameters?: CapturedJsonSchema } }>;
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
                  criticScope: null,
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
      phase: "research",
      attempt: 1,
      maxAttempts: 2,
      allowedActions: ["source.search", "claim.create", "workspace.status"],
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
        sourceCandidates: 7,
        canonicalSources: 5,
        screenedInSources: 4,
        explicitlySelectedEvidenceSources: 4,
        resolvedAccessSources: 4,
        canonicalPapers: 5,
        selectedPapers: 4,
        extractedPapers: 4,
        evidenceRows: 4,
        evidenceInsights: 2,
        manuscriptReadiness: null,
        sessionStepsUsed: 0
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
      "workspace.status"
    ]);
    const workStoreSchema = capturedBody.tools?.[0]?.function?.parameters?.properties?.inputs?.properties?.workStore?.properties;
    const entitySchema = workStoreSchema?.entity;
    const typedEntityFields = [
      "sourceId",
      "paperId",
      "extractionId",
      "field",
      "value",
      "text",
      "claimId",
      "evidenceCellId",
      "citationId",
      "supportLinkId",
      "mode",
      "oldEvidenceCellId",
      "oldSourceId",
      "supersededBy",
      "supportSnippet",
      "sectionIds",
      "markdown",
      "operation",
	      "blockIndex",
	      "status",
	      "statusReason",
	      "orderIndex",
	      "sectionOrder",
	      "nextInternalActions"
	    ];
    for (const field of typedEntityFields) {
      assert.ok(entitySchema?.properties?.[field], `workStore.entity.${field} should be model-facing`);
    }
    assert.deepEqual(entitySchema?.required, typedEntityFields);
    assert.match(entitySchema?.description ?? "", /evidence\.create_cell/i);
    assert.match(entitySchema?.description ?? "", /claim\.link_support/i);
    assert.match(workStoreSchema?.payloadJson?.description ?? "", /workspace\.status/i);
    assert.match(workStoreSchema?.payloadJson?.description ?? "", /Fallback JSON object string/i);
    assert.match(workStoreSchema?.patchJson?.description ?? "", /patch fields/i);
    assert.match(workStoreSchema?.filterJson?.description ?? "", /exact-match filters/i);
    assert.match(capturedBody.messages?.[0]?.content ?? "", /Call choose_research_action exactly once/);
    assert.match(capturedBody.messages?.[0]?.content ?? "", /workspace dashboard is an index/i);
    assert.match(capturedBody.messages?.[0]?.content ?? "", /lab manual/i);
    assert.match(capturedBody.messages?.[0]?.content ?? "", /Action recipes:/);
    assert.match(capturedBody.messages?.[0]?.content ?? "", /extraction\.create: set workStore\.entity\.sourceId or paperId/i);
    assert.match(capturedBody.messages?.[0]?.content ?? "", /evidence\.create_cell: set workStore\.entity\.sourceId or paperId/i);
	    assert.match(capturedBody.messages?.[0]?.content ?? "", /claim\.link_support: set workStore\.entity\.mode to append\|replace\|remove/i);
	    assert.match(capturedBody.messages?.[0]?.content ?? "", /section\.patch: use operation replace_all/i);
	    assert.match(capturedBody.messages?.[0]?.content ?? "", /set_order/i);
    assert.doesNotMatch(capturedBody.messages?.[0]?.content ?? "", /bounded first-pass/i);
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
              criticScope: null,
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
      phase: "research",
      attempt: 1,
      maxAttempts: 2,
      allowedActions: ["source.search", "claim.create", "workspace.status"],
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
        sourceCandidates: 7,
        canonicalSources: 5,
        screenedInSources: 4,
        explicitlySelectedEvidenceSources: 4,
        resolvedAccessSources: 4,
        canonicalPapers: 5,
        selectedPapers: 4,
        extractedPapers: 4,
        evidenceRows: 4,
        evidenceInsights: 2,
        manuscriptReadiness: null,
        sessionStepsUsed: 0
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
    assert.match(capturedBodies[1]?.messages?.[0]?.content ?? "", /Action recipes:/);
    assert.match(capturedBodies[1]?.messages?.[0]?.content ?? "", /claim\.link_support: set workStore\.entity\.mode to append\|replace\|remove/i);
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
              criticScope: null,
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
      phase: "research",
      attempt: 1,
      maxAttempts: 2,
      allowedActions: ["source.search", "claim.create", "workspace.status"],
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
        sourceCandidates: 7,
        canonicalSources: 5,
        screenedInSources: 4,
        explicitlySelectedEvidenceSources: 4,
        resolvedAccessSources: 4,
        canonicalPapers: 5,
        selectedPapers: 4,
        extractedPapers: 4,
        evidenceRows: 4,
        evidenceInsights: 2,
        manuscriptReadiness: null,
        sessionStepsUsed: 0
      },
      criticReports: []
    });

    assert.equal(decision.action, "claim.create");
    assert.equal(decision.transport, "native_tool_call");
    assert.equal(capturedUrl, "https://api.openai.test/v1/responses");
    assert.equal(capturedAuth, "Bearer test-openai-key");
    assert.equal(capturedBody.model, "gpt-test");
    assert.equal(capturedBody.tools?.[0]?.name, "choose_research_action");
    assert.equal(capturedBody.tools?.[0]?.strict, true);
    assert.equal(capturedBody.tool_choice?.name, "choose_research_action");
    assert.match(capturedBody.instructions ?? "", /Call choose_research_action exactly once/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI Codex backend uses the same OAuth transport for critic review", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: {
    model?: string;
    stream?: boolean;
    instructions?: string;
  } = {};

  try {
    globalThis.fetch = async (input, init): Promise<Response> => {
      capturedUrl = String(input);
      capturedAuth = new Headers(init?.headers as Record<string, string>).get("authorization") ?? "";
      capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          readiness: "revise",
          confidence: 0.82,
          summary: "The manuscript is repairable but needs a stronger synthesis section.",
          objections: [{
            code: "thin-synthesis",
            severity: "major",
            targetType: "manuscript",
            targetId: null,
            message: "The current manuscript does not yet synthesize the workspace claims.",
            affectedSourceIds: [],
            affectedEvidenceCellIds: [],
            affectedClaimIds: ["claim-1"],
            affectedSectionIds: ["section-1"],
            suggestedRevision: "Revise the manuscript section around the supported claims."
          }],
          positiveFindings: [],
          revisionAdvice: {
            searchQueries: [],
            evidenceTargets: [],
            papersToExclude: [],
            papersToPromote: [],
            claimsToSoften: []
          },
          recommendedNextActions: ["Revise section-1."]
        })
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const backend = new OpenAIResponsesResearchBackend(new RuntimeModelClient({
      provider: "openai-codex",
      model: "gpt-test",
      host: null,
      baseUrl: "https://chatgpt.example.test/backend-api/codex",
      configured: true,
      label: "openai-codex:gpt-test"
    }, {
      ...modelCredentials(),
      openai: {
        apiKey: null
      },
      openaiCodex: {
        access: "codex-access-token",
        refresh: "codex-refresh-token",
        expires: Date.UTC(2099, 0, 1),
        email: null,
        profileName: null
      }
    }));
    const review = await backend.reviewResearchArtifact?.({
      projectRoot: "/tmp/project",
      runId: "run-critic",
      stage: "release",
      brief: {
        topic: "research agents",
        researchQuestion: "Is the manuscript ready?",
        researchDirection: "Review release readiness.",
        successCriterion: "Return concrete critic objections."
      },
	      workspace: {
        notebook: {
          missionTarget: "professional_paper",
          paperMode: "literature_review",
          objective: "Write a serious research note.",
          definitionOfDone: ["Synthesize claims."],
          readiness: "Ready with caveats."
        },
        workspaceSummary: {
          claims: 1,
          manuscriptSections: 1
        },
        corpus_view: {
          diagnosticOnly: true,
          note: "Fixture critic corpus view."
        },
        synthesis_view: {
          diagnosticOnly: true,
          note: "Fixture critic synthesis view."
        },
        selectedSources: [],
        citedSources: [],
        protocols: [],
        extractions: [],
        evidenceCells: [],
        claims: [{
          id: "claim-1",
          text: "Supported claim."
        }],
        citations: [],
        manuscriptSections: [{
          id: "section-1",
          title: "Synthesis",
          markdown: "Draft."
        }],
	        releaseChecks: []
	      },
	      draftManuscriptPreview: {
	        schemaVersion: 1,
	        runId: "run-critic",
	        briefFingerprint: "brief",
	        title: "Draft",
	        abstract: "",
	        reviewType: "narrative_review",
	        structureRationale: "Preview only.",
	        scientificRoles: [],
	        sections: [],
	        claims: [],
	        citationLinks: [],
	        referencedPaperIds: [],
	        evidenceTableIds: [],
	        limitations: [],
	        readinessStatus: "ready_for_revision"
	      },
	      paperExportExists: false,
	      finalizedArtifactPaths: [],
	      manuscriptFinalized: false
	    }, {
	      operation: "critic",
	      timeoutMs: 300_000
    });

    assert.equal(review?.readiness, "revise");
    assert.equal(review?.objections[0]?.targetId, null);
    assert.deepEqual(review?.objections[0]?.affectedClaimIds, ["claim-1"]);
    assert.equal(capturedUrl, "https://chatgpt.example.test/backend-api/codex/responses");
    assert.equal(capturedAuth, "Bearer codex-access-token");
    assert.equal(capturedBody.model, "gpt-test");
    assert.equal(capturedBody.stream, true);
	    assert.match(capturedBody.instructions ?? "", /independent scientific reviewer/i);
	    assert.match(capturedBody.instructions ?? "", /Use IDs only if they appear in the packet/i);
	    assert.match(capturedBody.instructions ?? "", /pre-finalization is normal/i);
	    assert.match(capturedBody.instructions ?? "", /not objections by themselves/i);
	    assert.match(capturedBody.instructions ?? "", /release\.verify often runs after critic\.review/i);
	    assert.match(capturedBody.instructions ?? "", /do not treat missing release checks as an objection/i);
	    assert.match(capturedBody.instructions ?? "", /empty unless the researcher created a model-authored abstract section/i);
    assert.match(capturedBody.instructions ?? "", /"corpus_view"/);
    assert.match(capturedBody.instructions ?? "", /Fixture critic corpus view/);
    assert.match(capturedBody.instructions ?? "", /"synthesis_view"/);
    assert.match(capturedBody.instructions ?? "", /Fixture critic synthesis view/);
	  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI Responses backend classifies overloaded response failures as provider failures", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (): Promise<Response> => new Response([
      "event: response.failed",
      'data: {"type":"response.failed","response":{"error":{"message":"Our servers are currently overloaded. Please try again later."}}}',
      "",
      ""
    ].join("\n"), {
      status: 200,
      headers: {
        "content-type": "text/event-stream"
      }
    });

    const backend = new OpenAIResponsesResearchBackend(new RuntimeModelClient({
      provider: "openai-codex",
      model: "gpt-test",
      host: null,
      baseUrl: "https://chatgpt.example.test/backend-api/codex",
      configured: true,
      label: "openai-codex:gpt-test"
    }, {
      ...modelCredentials(),
      openai: {
        apiKey: null
      },
      openaiCodex: {
        access: "codex-access-token",
        refresh: "codex-refresh-token",
        expires: Date.UTC(2099, 0, 1),
        email: null,
        profileName: null
      }
    }));

    await assert.rejects(
      backend.planResearch({
        projectRoot: "/tmp/project",
        brief: {
          topic: "research agents",
          researchQuestion: "How should provider overload be handled?",
          researchDirection: "Classify provider overload as an external provider problem.",
          successCriterion: "Do not report provider overload as malformed JSON."
        },
        localFiles: [],
        workspaceContext: emptyWorkspaceContext(),
        workerState: null
      }),
      (error: unknown) => {
        assert.ok(error instanceof ResearchBackendError);
        assert.equal(error.kind, "http");
        assert.equal(error.operation, "planning");
        assert.match(error.message, /provider unavailable/i);
        assert.match(error.message, /overloaded/i);
        return true;
      }
    );
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
              criticScope: null,
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
      phase: "research",
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
        sourceCandidates: 6,
        canonicalSources: 4,
        screenedInSources: 3,
        explicitlySelectedEvidenceSources: 3,
        resolvedAccessSources: 3,
        canonicalPapers: 4,
        selectedPapers: 3,
        extractedPapers: 3,
        evidenceRows: 3,
        evidenceInsights: 2,
        manuscriptReadiness: "needs_human_review",
        sessionStepsUsed: 0
      },
      workStore: {
        path: "/tmp/project/.clawresearch/workspace.sqlite",
        summary: {
          providerRuns: 0,
          sources: 0,
          protocols: 0,
          canonicalSources: 3,
          extractions: 3,
          evidenceCells: 6,
          claims: 0,
          openWorkItems: 1,
          releaseChecks: 0
        },
        worker: {
          status: "working",
          completion: null,
          statusReason: "Testing the agent tool loop.",
          paperReadiness: "needs_human_review",
          nextInternalActions: ["Create claim-led synthesis objects."],
          userBlockers: []
        },
        notebook: {
          missionTarget: "professional_paper",
          paperMode: "literature_review",
          objective: "Test the model-driven research loop.",
          definitionOfDone: ["Create supported claims."],
          currentFocus: "Create claim-led synthesis objects.",
          readiness: "Not sufficient yet.",
          tasks: [],
          notes: [],
          artifactLinks: []
        },
        openWorkItems: [],
        recentProtocols: [],
        recentSourceCandidates: [],
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
    assert.doesNotMatch(capturedPrompt, /critic\.review/i);
    assert.doesNotMatch(capturedPrompt, /synthesize_clustered|finalize_status_report|write_final_report/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
