import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ResearchBackend,
  ResearchPlanningRequest,
  ResearchPlan,
  ResearchSynthesis
} from "../src/runtime/research-backend.js";
import type {
  ResearchSourceGatherRequest,
  ResearchSourceGatherResult,
  ResearchSourceGatherer
} from "../src/runtime/research-sources.js";
import { MemoryStore, memoryFilePath } from "../src/runtime/memory-store.js";
import { RunStore } from "../src/runtime/run-store.js";
import { runDetachedJobWorker } from "../src/runtime/run-worker.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

class StubResearchBackend implements ResearchBackend {
  readonly label = "stub:research";

  async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Map the main proof-technique families and their limitations.",
      rationale: "A first-pass literature synthesis is the most credible bounded mode for this brief.",
      searchQueries: [
        "Riemann Hypothesis proof techniques",
        "Riemann zeta function proof strategy survey"
      ],
      localFocus: [
        "proof techniques",
        "limitations"
      ]
    };
  }

  async synthesizeResearch(): Promise<ResearchSynthesis> {
    return {
      executiveSummary: "The initial source pass suggests a small number of recurring technique families, each with clear limitations.",
      themes: [
        {
          title: "Analytic number theory dominates",
          summary: "Most approaches cluster around analytic number theory and the zeta function.",
          sourceIds: ["brief-1", "web-1"]
        }
      ],
      claims: [
        {
          claim: "Current proof attempts repeatedly return to analytic techniques around the zeta function.",
          evidence: "The gathered sources emphasize analytic methods and frame them as central to the problem.",
          sourceIds: ["brief-1", "web-1"]
        }
      ],
      nextQuestions: [
        "Which proof-technique family has the clearest bounded open subproblem for a first computational or expository follow-up?"
      ]
    };
  }
}

class StubSourceGatherer implements ResearchSourceGatherer {
  async gather(): Promise<ResearchSourceGatherResult> {
    return {
      notes: [
        "Collected 1 OpenAlex literature source."
      ],
      sources: [
        {
          id: "brief-1",
          kind: "project_brief",
          title: "Riemann Hypothesis",
          locator: null,
          citation: "User-provided project brief.",
          excerpt: "Topic: Riemann Hypothesis. Research question: What proof-technique families are most prominent?"
        },
        {
          id: "web-1",
          kind: "openalex_work",
          title: "A survey of proof strategies for the Riemann Hypothesis",
          locator: "https://example.org/rh-survey",
          citation: "Example Author (2024). A survey of proof strategies for the Riemann Hypothesis.",
          excerpt: "Survey-style source describing analytic approaches, common obstacles, and recurring proof motifs."
        }
      ]
    };
  }
}

class NoEvidenceSourceGatherer implements ResearchSourceGatherer {
  async gather(): Promise<ResearchSourceGatherResult> {
    return {
      notes: [
        "No relevant local project files were selected.",
        "No OpenAlex literature sources were collected."
      ],
      sources: [
        {
          id: "brief-1",
          kind: "project_brief",
          title: "Riemonn hypothesis",
          locator: null,
          citation: "User-provided project brief.",
          excerpt: "Topic: Riemonn hypothesis."
        }
      ]
    };
  }
}

class MemoryAwareResearchBackend implements ResearchBackend {
  readonly label = "stub:memory-aware-research";

  async planResearch(request: ResearchPlanningRequest): Promise<ResearchPlan> {
    assert.equal(request.memoryContext.available, true);
    assert.match(
      request.memoryContext.questions[0]?.title ?? "",
      /mollifier methods/i
    );
    assert.equal(
      request.memoryContext.artifacts[0]?.data.path,
      "notes/mollifier-note.md"
    );

    return {
      researchMode: "literature_synthesis",
      objective: "Follow up prior mollifier-based questions for the Riemann Hypothesis.",
      rationale: "The project memory already identifies mollifier limitations as the most useful next step.",
      searchQueries: [
        "mollifier methods Riemann Hypothesis limitations",
        "zero-free region mollifier survey"
      ],
      localFocus: [
        "notes/mollifier-note.md",
        "mollifier methods"
      ]
    };
  }

  async synthesizeResearch(): Promise<ResearchSynthesis> {
    return {
      executiveSummary: "The run followed a prior memory hint on mollifier methods and turned it into a bounded follow-up synthesis.",
      themes: [
        {
          title: "Mollifier limitations remain central",
          summary: "The prior project memory correctly identified mollifier limitations as a productive next step.",
          sourceIds: ["web-1"]
        }
      ],
      claims: [
        {
          claim: "Prior memory helped narrow the current run toward mollifier limitations.",
          evidence: "The run plan and gathered source set were explicitly centered on the prior memory question.",
          sourceIds: ["web-1"]
        }
      ],
      nextQuestions: [
        "Which mollifier-based results point to the clearest bounded follow-up experiment or expository note?"
      ]
    };
  }
}

class MemoryAwareSourceGatherer implements ResearchSourceGatherer {
  async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
    assert.equal(request.memoryContext.available, true);
    assert.match(request.plan.searchQueries[0] ?? "", /mollifier methods/i);
    assert.ok(
      request.memoryContext.localFileHints.includes("notes/mollifier-note.md")
    );

    return {
      notes: [
        "Used project memory to focus retrieval on mollifier methods."
      ],
      sources: [
        {
          id: "brief-1",
          kind: "project_brief",
          title: "Riemann Hypothesis",
          locator: null,
          citation: "User-provided project brief.",
          excerpt: "Follow the prior mollifier question."
        },
        {
          id: "web-1",
          kind: "openalex_work",
          title: "Mollifier methods for the Riemann Hypothesis",
          locator: "https://example.org/mollifier",
          citation: "Example Author (2025). Mollifier methods for the Riemann Hypothesis.",
          excerpt: "Survey of mollifier methods and known limitations."
        }
      ]
    };
  }
}

test("detached run worker completes the minimal explicit research loop and writes research artifacts", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-"));
  const now = createNow();

  try {
    const store = new RunStore(projectRoot, "0.6.0", now);
    const run = await store.create(
      {
        topic: "Riemann Hypothesis",
        researchQuestion: "What proof-technique families are most prominent?",
        researchDirection: "Review and compare prior proof-technique families.",
        successCriterion: "Produce a concise technique map with limitations."
      },
      ["clawresearch", "research-loop", "--mode", "plan-gather-synthesize"]
    );

    const code = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.6.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceGatherer: new StubSourceGatherer()
    });

    assert.equal(code, 0);

    const completedRun = await store.load(run.id);
    assert.equal(completedRun.status, "completed");
    assert.equal(completedRun.workerPid, null);
    assert.equal(completedRun.job.exitCode, 0);
    assert.equal(completedRun.job.signal, null);

    const trace = await readFile(completedRun.artifacts.tracePath, "utf8");
    const events = await readFile(completedRun.artifacts.eventsPath, "utf8");
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const stderr = await readFile(completedRun.artifacts.stderrPath, "utf8");
    const plan = await readFile(completedRun.artifacts.planPath, "utf8");
    const sources = await readFile(completedRun.artifacts.sourcesPath, "utf8");
    const claims = await readFile(completedRun.artifacts.claimsPath, "utf8");
    const nextQuestions = await readFile(completedRun.artifacts.nextQuestionsPath, "utf8");
    const synthesis = await readFile(completedRun.artifacts.synthesisPath, "utf8");
    const summary = await readFile(completedRun.artifacts.summaryPath, "utf8");
    const verification = await readFile(completedRun.artifacts.verificationPath, "utf8");
    const memorySnapshot = await readFile(completedRun.artifacts.memoryPath, "utf8");
    const projectMemory = await readFile(memoryFilePath(projectRoot), "utf8");

    assert.match(trace, /Run worker started\./);
    assert.match(trace, /Selected research mode: literature_synthesis/);
    assert.match(trace, /Synthesis completed\./);
    assert.match(events, /"kind":"plan"/);
    assert.match(events, /"kind":"source"/);
    assert.match(events, /"kind":"claim"/);
    assert.match(events, /"kind":"verify"/);
    assert.match(events, /"kind":"memory"/);
    assert.match(events, /"kind":"summary"/);
    assert.match(stdout, /Research backend: stub:research/);
    assert.match(stdout, /Verification: Verified 1 claims against 2 sources\./);
    assert.match(stdout, /Structured memory updated:/);
    assert.equal(stderr, "");
    assert.match(plan, /"researchMode": "literature_synthesis"/);
    assert.match(sources, /"id": "web-1"/);
    assert.match(claims, /analytic techniques around the zeta function/);
    assert.match(verification, /"supportStatus": "supported"/);
    assert.match(verification, /"confidence": "medium"/);
    assert.match(verification, /"sourceProvenance"/);
    assert.match(nextQuestions, /Which proof-technique family has the clearest bounded open subproblem/);
    assert.match(synthesis, /# Research Synthesis/);
    assert.match(synthesis, /## Verification/);
    assert.match(summary, /# Run Summary/);
    assert.match(summary, /Research mode: literature_synthesis/);
    assert.match(summary, /Verified 1 claims against 2 sources\./);
    assert.match(memorySnapshot, /"type": "source"/);
    assert.match(memorySnapshot, /"type": "claim"/);
    assert.match(memorySnapshot, /"type": "finding"/);
    assert.match(memorySnapshot, /"type": "question"/);
    assert.match(memorySnapshot, /"type": "idea"/);
    assert.match(memorySnapshot, /"type": "summary"/);
    assert.match(memorySnapshot, /"type": "artifact"/);
    assert.match(projectMemory, /"recordCount":/);
    assert.match(projectMemory, /"type": "artifact"/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("detached run worker fails honestly when no evidence beyond the project brief is gathered", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-no-evidence-"));
  const now = createNow();

  try {
    const store = new RunStore(projectRoot, "0.6.0", now);
    const run = await store.create(
      {
        topic: "Riemonn hypothesis",
        researchQuestion: "What are the potential flaws in current proof techniques?",
        researchDirection: "Search for critical literature and alternative proof strategies.",
        successCriterion: "Find evidence-backed weaknesses or alternatives in the literature."
      },
      ["clawresearch", "research-loop", "--mode", "plan-gather-synthesize"]
    );

    const code = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.6.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceGatherer: new NoEvidenceSourceGatherer()
    });

    assert.equal(code, 1);

    const failedRun = await store.load(run.id);
    assert.equal(failedRun.status, "failed");
    assert.match(failedRun.statusMessage ?? "", /did not find evidence beyond the user brief/i);

    const synthesis = await readFile(failedRun.artifacts.synthesisPath, "utf8");
    const claims = await readFile(failedRun.artifacts.claimsPath, "utf8");
    const nextQuestions = await readFile(failedRun.artifacts.nextQuestionsPath, "utf8");
    const stderr = await readFile(failedRun.artifacts.stderrPath, "utf8");
    const verification = await readFile(failedRun.artifacts.verificationPath, "utf8");
    const memorySnapshot = await readFile(failedRun.artifacts.memoryPath, "utf8");
    const projectMemory = await readFile(memoryFilePath(projectRoot), "utf8");

    assert.match(synthesis, /did not gather any evidence-bearing sources beyond the user brief/i);
    assert.doesNotMatch(synthesis, /## Claims and Evidence/);
    assert.equal(claims.trim(), "[]");
    assert.match(nextQuestions, /Which terminology, canonical entity names, or spelling corrections should be used/);
    assert.match(stderr, /stopped before unsupported synthesis/i);
    assert.match(verification, /"overallStatus": "insufficient_evidence"/);
    assert.match(verification, /No evidence-bearing sources beyond the project brief were available for verification/);
    assert.match(memorySnapshot, /Evidence gap/);
    assert.match(memorySnapshot, /Broaden evidence collection/);
    assert.match(memorySnapshot, /"type": "question"/);
    assert.match(projectMemory, /"type": "summary"/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("detached run worker actively loads prior memory into planning and retrieval", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-memory-aware-"));
  const now = createNow();

  try {
    const memoryStore = new MemoryStore(projectRoot, now);
    await memoryStore.upsert([
      {
        type: "question",
        key: "Which obstacles limit mollifier methods for the Riemann Hypothesis?",
        title: "Which obstacles limit mollifier methods for the Riemann Hypothesis?",
        text: "Which obstacles limit mollifier methods for the Riemann Hypothesis?",
        runId: "run-prior"
      },
      {
        type: "artifact",
        key: "notes/mollifier-note.md",
        title: "Previous mollifier note",
        text: "Prior local note on mollifier limitations.",
        runId: "run-prior",
        data: {
          path: "notes/mollifier-note.md"
        }
      }
    ]);

    const store = new RunStore(projectRoot, "0.7.0", now);
    const run = await store.create(
      {
        topic: "Riemann Hypothesis",
        researchQuestion: "What bounded follow-up should we pursue next?",
        researchDirection: "Build on the strongest prior lead rather than restarting the literature search.",
        successCriterion: "Produce a focused follow-up synthesis grounded in the strongest prior lead."
      },
      ["clawresearch", "research-loop", "--mode", "plan-gather-synthesize"]
    );

    const code = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new MemoryAwareResearchBackend(),
      sourceGatherer: new MemoryAwareSourceGatherer()
    });

    assert.equal(code, 0);

    const completedRun = await store.load(run.id);
    const plan = await readFile(completedRun.artifacts.planPath, "utf8");
    const sources = await readFile(completedRun.artifacts.sourcesPath, "utf8");
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const events = await readFile(completedRun.artifacts.eventsPath, "utf8");
    const verification = await readFile(completedRun.artifacts.verificationPath, "utf8");

    assert.match(plan, /mollifier methods Riemann Hypothesis limitations/);
    assert.match(sources, /Used project memory to focus retrieval on mollifier methods/);
    assert.match(stdout, /Loaded 2 prior memory records into the current run context\./);
    assert.match(stdout, /Verification: Verified 1 claims against 2 sources\./);
    assert.match(events, /Loaded 2 prior memory records to inform planning and retrieval\./);
    assert.match(verification, /"supportStatus": "supported"/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
