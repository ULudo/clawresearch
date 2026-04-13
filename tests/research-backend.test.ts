import test from "node:test";
import assert from "node:assert/strict";
import { OllamaResearchBackend } from "../src/runtime/research-backend.js";
import type { ProjectMemoryContext } from "../src/runtime/memory-store.js";

function emptyMemoryContext(): ProjectMemoryContext {
  return {
    available: true,
    recordCount: 3,
    countsByType: {
      source: 0,
      claim: 0,
      finding: 1,
      question: 1,
      idea: 1,
      summary: 0,
      artifact: 0
    },
    sources: [],
    claims: [],
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
    ideas: [
      {
        id: "idea-1",
        title: "Follow the mollifier thread",
        text: "Use mollifier limitations as the next bounded literature pass.",
        runId: "run-prior",
        linkedRecordIds: [],
        data: {}
      }
    ],
    summaries: [],
    artifacts: [],
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

test("synthesis backend switches to the specialized literature-review prompt for literature synthesis runs", async () => {
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
      sources: [
        {
          id: "web-1",
          kind: "openalex_work",
          title: "Design Patterns for Autonomous Research Agents",
          locator: "https://example.org/agents",
          citation: "Example Author (2026). Design Patterns for Autonomous Research Agents.",
          excerpt: "This review compares architecture choices and evaluation practices."
        }
      ]
    });

    assert.match(capturedPrompt, /dedicated literature-review synthesis module/i);
    assert.match(capturedPrompt, /Treat this as a literature review subsystem/i);
    assert.match(capturedPrompt, /Literature review profile:/);
    assert.match(capturedPrompt, /Do not treat a loosely related background source as direct evidence/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
