import test from "node:test";
import assert from "node:assert/strict";
import { OllamaProjectAssistantBackend } from "../src/runtime/project-assistant-backend.js";

test("project assistant backend includes current run, agenda, and decision context in its prompt", async () => {
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
            assistantMessage: "The latest work package is blocked by missing local inputs.",
            brief: {
              topic: "Riemann Hypothesis",
              researchQuestion: "How can we optimize existing algorithms for verifying zeros of the zeta function?",
              researchDirection: "Computational approaches for verifying zeros of the zeta function",
              successCriterion: "Produce a grounded next-step algorithm plan."
            },
            readiness: "ready",
            readinessRationale: "The project brief remains usable.",
            openQuestions: [],
            summary: "The project is currently blocked at the work-package stage."
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
        stage: "work_package",
        status: "completed",
        statusMessage: "Work-package run completed with decision revise.",
        briefMatchesCurrent: true,
        recentEvents: [
          "exec: Checked local context",
          "run: Work-package run completed with decision revise."
        ],
        summaryMarkdown: "# Work Package Summary\n\nBlocked by missing inputs."
      },
      latestAgenda: {
        executiveSummary: "The best next direction is to optimize fast algorithms.",
        gaps: [],
        candidateDirections: [],
        selectedDirectionId: "direction-1",
        selectedWorkPackage: {
          id: "wp-1",
          title: "Optimizing Fast Algorithms for Zeta Function Evaluation",
          mode: "method_improvement",
          objective: "Improve fast algorithms for zeta function evaluation.",
          hypothesisOrQuestion: "Can we reduce computation further?",
          methodSketch: "Start from Riemann-Siegel and FFT methods.",
          baselines: ["Odlyzko et al. (1988)"],
          controls: ["runtime", "accuracy"],
          decisiveExperiment: "Benchmark the optimized method against the baseline.",
          stopCriterion: "Reach a 20% runtime improvement without accuracy loss.",
          expectedArtifact: "An optimized algorithm and benchmark note.",
          requiredInputs: ["Baseline implementation"],
          blockedBy: ["Missing local implementation"]
        },
        holdReasons: [],
        recommendedHumanDecision: "Resolve the missing local inputs before continuing."
      },
      latestWorkPackage: {
        id: "wp-1",
        title: "Optimizing Fast Algorithms for Zeta Function Evaluation",
        mode: "method_improvement",
        objective: "Improve fast algorithms for zeta function evaluation.",
        hypothesisOrQuestion: "Can we reduce computation further?",
        methodSketch: "Start from Riemann-Siegel and FFT methods.",
        baselines: ["Odlyzko et al. (1988)"],
        controls: ["runtime", "accuracy"],
        decisiveExperiment: "Benchmark the optimized method against the baseline.",
        stopCriterion: "Reach a 20% runtime improvement without accuracy loss.",
        expectedArtifact: "An optimized algorithm and benchmark note.",
        requiredInputs: ["Baseline implementation"],
        blockedBy: ["Missing local implementation"]
      },
      latestDecision: {
        outcome: "revise",
        rationale: "The work package is promising but blocked by missing inputs.",
        nextActions: ["Add or locate the baseline implementation."],
        blockedBy: ["Missing local implementation"],
        status: "blocked"
      },
      latestFindings: [
        {
          id: "finding-1",
          title: "Required input availability",
          summary: "The baseline implementation is missing.",
          evidence: ["No matching local files found."],
          status: "blocked"
        }
      ]
    });

    assert.equal(response.readiness, "ready");
    assert.match(capturedPrompt, /ongoing research assistant/i);
    assert.match(capturedPrompt, /Current run:/);
    assert.match(capturedPrompt, /run-1/);
    assert.match(capturedPrompt, /Optimizing Fast Algorithms for Zeta Function Evaluation/);
    assert.match(capturedPrompt, /Missing local implementation/);
    assert.match(capturedUserMessage, /What was the result of the research\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
