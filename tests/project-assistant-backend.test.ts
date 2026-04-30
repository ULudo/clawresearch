import test from "node:test";
import assert from "node:assert/strict";
import { OllamaProjectAssistantBackend } from "../src/runtime/project-assistant-backend.js";

test("project assistant backend includes current run and agenda context in its prompt", async () => {
  const originalFetch = globalThis.fetch;
  let capturedPrompt = "";
  let capturedUserMessage = "";

  try {
    globalThis.fetch = async (_input, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: string }>;
      };
      capturedPrompt = body.messages?.[0]?.content ?? "";
      capturedUserMessage = body.messages?.[1]?.content ?? "";

      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            assistantMessage: "The latest research segment is blocked by missing local inputs.",
            brief: {
              topic: "Riemann Hypothesis",
              researchQuestion: "How can we optimize existing algorithms for verifying zeros of the zeta function?",
              researchDirection: "Computational approaches for verifying zeros of the zeta function",
              successCriterion: "Produce a grounded next-step algorithm plan."
            },
            readiness: "ready",
            readinessRationale: "The project brief remains usable.",
            openQuestions: [],
            summary: "The project is currently blocked at the local-input stage."
          })
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const backend = new OllamaProjectAssistantBackend("127.0.0.1:11434", "stub-model");
    const response = await backend.respond({
      mode: "continue",
      projectRoot: "/tmp/project",
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: "How can we optimize existing algorithms for verifying zeros of the zeta function?",
        researchDirection: "Computational approaches for verifying zeros of the zeta function",
        successCriterion: "Produce a grounded next-step algorithm plan."
      },
      openQuestions: [],
      conversation: [
        {
          role: "user",
          content: "What was the result of the research?"
        }
      ],
      currentRun: {
        id: "run-1",
        stage: "literature_review",
        status: "completed",
        statusMessage: "Provider-aware literature run completed successfully.",
        briefMatchesCurrent: true,
        recentEvents: [
          "summary: Literature review completed.",
          "run: Provider-aware literature run completed successfully."
        ],
        summaryMarkdown: "# Research Summary\n\nThe agenda selected a next research focus."
      },
      latestAgenda: {
        executiveSummary: "The best next direction is to optimize fast algorithms.",
        gaps: [],
        candidateDirections: [],
        selectedDirectionId: "direction-1",
        selectedWorkPackage: null,
        holdReasons: [],
        recommendedHumanDecision: "Resolve the missing local inputs before continuing."
      }
    });

    assert.equal(response.readiness, "ready");
    assert.match(capturedPrompt, /ongoing research assistant/i);
    assert.match(capturedPrompt, /Current run:/);
    assert.match(capturedPrompt, /run-1/);
    assert.match(capturedPrompt, /direction-1/);
    assert.match(capturedPrompt, /Resolve the missing local inputs before continuing/);
    assert.match(capturedUserMessage, /What was the result of the research\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
