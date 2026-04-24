import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handleContinueCommand,
  handleUserInput,
  latestAgendaSnapshot,
  renderAgenda,
  summarizeCompletedRunIfNeeded,
  type ConsoleIo
} from "../src/runtime/console-app.js";
import { createDefaultRunController, type RunController } from "../src/runtime/run-controller.js";
import { ConsoleTranscript } from "../src/runtime/console-transcript.js";
import type { IntakeBackend, IntakeResponse } from "../src/runtime/intake-backend.js";
import type { ProjectAssistantBackend } from "../src/runtime/project-assistant-backend.js";
import type { ResearchAgenda } from "../src/runtime/research-backend.js";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import { CredentialStore } from "../src/runtime/credential-store.js";
import { researchDirectionPath, RunStore, type RunRecord } from "../src/runtime/run-store.js";
import { SessionStore } from "../src/runtime/session-store.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 3, 20, 10, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

function captureWriter(): {
  writer: { write: (chunk: string) => void };
  readText: () => string;
} {
  let text = "";

  return {
    writer: {
      write(chunk: string): void {
        text += chunk;
      }
    },
    readText(): string {
      return text;
    }
  };
}

function readyResponse(message: string): IntakeResponse {
  return {
    assistantMessage: message,
    brief: {
      topic: "Riemann Hypothesis",
      researchQuestion: "How can we optimize existing algorithms for verifying zeros of the zeta function?",
      researchDirection: "Computational approaches for verifying zeros of the zeta function",
      successCriterion: "Produce a grounded next-step algorithm plan."
    },
    readiness: "ready",
    readinessRationale: "The brief remains usable.",
    openQuestions: [],
    summary: "A grounded computational research brief."
  };
}

function actionableAgenda(overrides: Partial<ResearchAgenda> = {}): ResearchAgenda {
  return {
    executiveSummary: "The literature review identified a bounded follow-up.",
    gaps: [],
    candidateDirections: [
      {
        id: "direction-1",
        title: "Benchmark technique-family framing",
        summary: "Compare technique families with explicit limits.",
        mode: "method_improvement",
        whyNow: "The reviewed literature supports a bounded follow-up.",
        sourceIds: [],
        claimIds: [],
        gapIds: [],
        scores: {
          evidenceBase: 4,
          novelty: 3,
          tractability: 4,
          expectedCost: 2,
          risk: 2,
          overall: 4
        }
      }
    ],
    selectedDirectionId: "direction-1",
    selectedWorkPackage: {
      id: "wp-1",
      title: "Benchmark technique-family framing",
      mode: "method_improvement",
      objective: "Produce a bounded benchmark note.",
      hypothesisOrQuestion: "Can technique-family framing improve follow-up selection?",
      methodSketch: "Hold the reviewed literature fixed and compare two concrete approaches.",
      baselines: ["Current agenda"],
      controls: ["Same reviewed literature"],
      decisiveExperiment: "Write a comparison with explicit limits.",
      stopCriterion: "The comparison supports or rejects the follow-up.",
      expectedArtifact: "A bounded benchmark note.",
      requiredInputs: [],
      blockedBy: []
    },
    holdReasons: [],
    recommendedHumanDecision: "Continue with the selected work package.",
    ...overrides
  };
}

class CapturingContinueRunController implements RunController {
  launchedRunIds: string[] = [];

  launchCommand(run: RunRecord): string[] {
    return ["node", "dist/src/cli.js", "--run-job", run.id, "--project-root", run.projectRoot];
  }

  async launch(run: RunRecord): Promise<number> {
    this.launchedRunIds.push(run.id);
    return 7700;
  }

  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  isProcessAlive(): boolean {
    return false;
  }
}

test("handleUserInput uses the project assistant backend once a run exists", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-project-assistant-"));
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    session.brief.topic = "Riemann Hypothesis";
    session.brief.researchQuestion = "How can we optimize existing algorithms for verifying zeros of the zeta function?";
    session.brief.researchDirection = "Computational approaches for verifying zeros of the zeta function";
    session.brief.successCriterion = "Produce a grounded next-step algorithm plan.";
    session.intake.readiness = "ready";
    session.intake.rationale = "The brief is concrete enough to start a first-pass research run.";
    await sessionStore.save(session);

    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const run = await runStore.create(session.brief, ["clawresearch", "research-loop", "--mode", "plan-gather-synthesize"]);
    run.status = "completed";
    run.stage = "literature_review";
    run.statusMessage = "Provider-aware literature run completed and is waiting for `/continue` on the selected work package.";
    await runStore.save(run);

    let intakeCalls = 0;
    let projectCalls = 0;

    const intakeBackend: IntakeBackend = {
      label: "intake:test",
      async respond(): Promise<IntakeResponse> {
        intakeCalls += 1;
        return readyResponse("This should not be used once a run exists.");
      }
    };
    const projectAssistantBackend: ProjectAssistantBackend = {
      label: "assistant:test",
      async respond(): Promise<IntakeResponse> {
        projectCalls += 1;
        return readyResponse("The latest research run completed, but the next work package still needs local inputs before it can proceed.");
      }
    };

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const credentialStore = new CredentialStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    const credentials = await credentialStore.load();
    const transcript = new ConsoleTranscript(projectRoot);
    const sink = captureWriter();
    const io: ConsoleIo = {
      writer: sink.writer,
      async prompt(): Promise<string | null> {
        return null;
      }
    };

    await handleUserInput(
      "What was the result of the research?",
      io,
      transcript,
      sink.writer,
      session,
      sessionStore,
      runStore,
      projectConfig,
      projectConfigStore,
      credentials,
      credentialStore,
      intakeBackend,
      projectAssistantBackend,
      now
    );

    assert.equal(intakeCalls, 0);
    assert.equal(projectCalls, 1);
    assert.match(sink.readText(), /latest research run completed/i);
    assert.match(session.conversation.at(-1)?.text ?? "", /latest research run completed/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("handleUserInput nudges the user to rerun when the project assistant changes the brief after a saved run", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-brief-change-"));
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    session.brief.topic = "Riemann Hypothesis";
    session.brief.researchQuestion = "How can we optimize existing algorithms for verifying zeros of the zeta function?";
    session.brief.researchDirection = "Computational approaches for verifying zeros of the zeta function";
    session.brief.successCriterion = "Produce a grounded next-step algorithm plan.";
    session.intake.readiness = "ready";
    await sessionStore.save(session);

    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const run = await runStore.create(session.brief, ["clawresearch", "research-loop", "--mode", "plan-gather-synthesize"]);
    run.status = "completed";
    run.stage = "literature_review";
    await runStore.save(run);

    const intakeBackend: IntakeBackend = {
      label: "intake:test",
      async respond(): Promise<IntakeResponse> {
        return readyResponse("This should not be used once a run exists.");
      }
    };
    const projectAssistantBackend: ProjectAssistantBackend = {
      label: "assistant:test",
      async respond(): Promise<IntakeResponse> {
        return {
          assistantMessage: "The research direction has been updated to a literature review of proof techniques instead.",
          brief: {
            topic: "Riemann Hypothesis",
            researchQuestion: "What are the key proof-technique families used in work on the Riemann Hypothesis?",
            researchDirection: "Literature review of proof techniques for the Riemann Hypothesis",
            successCriterion: "Produce a grounded literature synthesis of the main proof-technique families."
          },
          readiness: "ready",
          readinessRationale: "The updated brief is still concrete enough to run.",
          openQuestions: [],
          summary: "The project has been reframed as a literature review."
        };
      }
    };

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const credentialStore = new CredentialStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    const credentials = await credentialStore.load();
    const transcript = new ConsoleTranscript(projectRoot);
    const sink = captureWriter();
    const io: ConsoleIo = {
      writer: sink.writer,
      async prompt(): Promise<string | null> {
        return null;
      }
    };

    await handleUserInput(
      "Change the research direction to a literature review of proof techniques instead.",
      io,
      transcript,
      sink.writer,
      session,
      sessionStore,
      runStore,
      projectConfig,
      projectConfigStore,
      credentials,
      credentialStore,
      intakeBackend,
      projectAssistantBackend,
      now
    );

    assert.match(sink.readText(), /Use `\/go` when you're ready to refresh the research/i);
    assert.match(session.conversation.at(-1)?.text ?? "", /Use `\/go` when you're ready to refresh the research/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("summarizeCompletedRunIfNeeded records a short literature-run summary once", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-summary-"));
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const run = await runStore.create(session.brief, ["clawresearch", "research-loop", "--mode", "plan-gather-synthesize"]);
    run.status = "completed";
    run.stage = "literature_review";
    await runStore.save(run);

    await writeFile(run.artifacts.agendaPath, `${JSON.stringify({
      executiveSummary: "The literature review identified fast algorithm optimization as the best bounded next step.",
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
        baselines: [],
        controls: [],
        decisiveExperiment: "Benchmark the optimized method.",
        stopCriterion: "Show a runtime improvement.",
        expectedArtifact: "An optimized algorithm and benchmark note.",
        requiredInputs: [],
        blockedBy: []
      },
      holdReasons: [],
      recommendedHumanDecision: "Proceed with the selected work package."
    }, null, 2)}\n`, "utf8");
    await writeFile(run.artifacts.workPackagePath, `${JSON.stringify({
      id: "wp-1",
      title: "Optimizing Fast Algorithms for Zeta Function Evaluation",
      mode: "method_improvement",
      objective: "Improve fast algorithms for zeta function evaluation.",
      hypothesisOrQuestion: "Can we reduce computation further?",
      methodSketch: "Start from Riemann-Siegel and FFT methods.",
      baselines: [],
      controls: [],
      decisiveExperiment: "Benchmark the optimized method.",
      stopCriterion: "Show a runtime improvement.",
      expectedArtifact: "An optimized algorithm and benchmark note.",
      requiredInputs: [],
      blockedBy: []
    }, null, 2)}\n`, "utf8");

    const first = await summarizeCompletedRunIfNeeded(session, sessionStore, run, now);
    const second = await summarizeCompletedRunIfNeeded(session, sessionStore, run, now);

    assert.match(first ?? "", /Literature review complete/i);
    assert.match(first ?? "", /Selected next work package/i);
    assert.equal(second, null);
    assert.equal(session.lastSummarizedRunId, run.id);
    assert.match(session.conversation.at(-1)?.text ?? "", /Optimizing Fast Algorithms for Zeta Function Evaluation/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("summarizeCompletedRunIfNeeded prefers an on-hold summary over a blocked work-package suggestion", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-hold-summary-"));
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const run = await runStore.create(session.brief, ["clawresearch", "research-loop", "--mode", "plan-gather-synthesize"]);
    run.status = "completed";
    run.stage = "literature_review";
    await runStore.save(run);

    await writeFile(run.artifacts.agendaPath, `${JSON.stringify({
      executiveSummary: "The literature review identified a promising but currently blocked next step.",
      gaps: [],
      candidateDirections: [],
      selectedDirectionId: "direction-1",
      selectedWorkPackage: {
        id: "wp-1",
        title: "Blocked package",
        mode: "method_improvement",
        objective: "Try a blocked next step.",
        hypothesisOrQuestion: "Can we proceed despite blockers?",
        methodSketch: "Not yet.",
        baselines: [],
        controls: [],
        decisiveExperiment: "Not yet.",
        stopCriterion: "Not yet.",
        expectedArtifact: "A blocked artifact.",
        requiredInputs: [],
        blockedBy: ["Missing datasets"]
      },
      holdReasons: ["Missing datasets make the selected package non-actionable."],
      recommendedHumanDecision: "Do not continue yet."
    }, null, 2)}\n`, "utf8");
    await writeFile(run.artifacts.workPackagePath, `${JSON.stringify({
      id: "wp-1",
      title: "Blocked package",
      mode: "method_improvement",
      objective: "Try a blocked next step.",
      hypothesisOrQuestion: "Can we proceed despite blockers?",
      methodSketch: "Not yet.",
      baselines: [],
      controls: [],
      decisiveExperiment: "Not yet.",
      stopCriterion: "Not yet.",
      expectedArtifact: "A blocked artifact.",
      requiredInputs: [],
      blockedBy: ["Missing datasets"]
    }, null, 2)}\n`, "utf8");

    const summary = await summarizeCompletedRunIfNeeded(session, sessionStore, run, now);

    assert.match(summary ?? "", /agenda is on hold/i);
    assert.doesNotMatch(summary ?? "", /Selected next work package/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("summarizeCompletedRunIfNeeded records a blocked work-package summary", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-work-summary-"));
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const run = await runStore.createWithOptions(
      session.brief,
      ["clawresearch", "research-loop", "--mode", "work-package", "--work-package-id", "wp-1"],
      {
        stage: "work_package",
        parentRunId: "run-parent",
        derivedFromWorkPackageId: "wp-1"
      }
    );
    run.status = "completed";
    await runStore.save(run);

    await writeFile(run.artifacts.workPackagePath, `${JSON.stringify({
      id: "wp-1",
      title: "Optimizing Fast Algorithms for Zeta Function Evaluation",
      mode: "method_improvement",
      objective: "Improve fast algorithms for zeta function evaluation.",
      hypothesisOrQuestion: "Can we reduce computation further?",
      methodSketch: "Start from Riemann-Siegel and FFT methods.",
      baselines: [],
      controls: [],
      decisiveExperiment: "Benchmark the optimized method.",
      stopCriterion: "Show a runtime improvement.",
      expectedArtifact: "An optimized algorithm and benchmark note.",
      requiredInputs: [],
      blockedBy: ["Missing local baseline implementation"]
    }, null, 2)}\n`, "utf8");
    await writeFile(run.artifacts.decisionPath, `${JSON.stringify({
      outcome: "revise",
      rationale: "The work package is promising but still blocked by missing inputs.",
      nextActions: ["Add or locate the baseline implementation."],
      blockedBy: ["Missing local baseline implementation"],
      status: "blocked"
    }, null, 2)}\n`, "utf8");
    await writeFile(run.artifacts.findingsPath, `${JSON.stringify([
      {
        id: "finding-1",
        title: "Required input availability",
        summary: "The baseline implementation is still missing locally.",
        evidence: ["No matching local files found."],
        status: "blocked"
      }
    ], null, 2)}\n`, "utf8");

    const summary = await summarizeCompletedRunIfNeeded(session, sessionStore, run, now);

    assert.match(summary ?? "", /Work package complete/i);
    assert.match(summary ?? "", /Outcome: revise/i);
    assert.match(summary ?? "", /baseline implementation/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("latestAgendaSnapshot uses global direction provenance instead of the newest run", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-agenda-source-run-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const agenda = actionableAgenda();
    const olderRun = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "What bounded follow-up should we pursue next?",
      researchDirection: "Literature synthesis.",
      successCriterion: "Grounded summary."
    }, ["clawresearch", "research-loop"]);
    olderRun.status = "completed";
    olderRun.stage = "literature_review";
    await runStore.save(olderRun);
    await writeFile(olderRun.artifacts.agendaPath, `${JSON.stringify(agenda, null, 2)}\n`, "utf8");
    await writeFile(olderRun.artifacts.workPackagePath, `${JSON.stringify(agenda.selectedWorkPackage, null, 2)}\n`, "utf8");

    const newerRun = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "What newer run exists without an agenda?",
      researchDirection: "A newer but unrelated run.",
      successCriterion: "Do not use this run for agenda provenance."
    }, ["clawresearch", "research-loop"]);
    newerRun.status = "completed";
    newerRun.stage = "literature_review";
    await runStore.save(newerRun);

    await writeFile(researchDirectionPath(projectRoot), `${JSON.stringify({
      ...agenda,
      schemaVersion: 1,
      sourceRunId: olderRun.id,
      sourceRunStage: "literature_review",
      sourceRunAgendaPath: path.relative(projectRoot, olderRun.artifacts.agendaPath),
      acceptedAt: "2026-04-20T10:00:00.000Z"
    }, null, 2)}\n`, "utf8");

    const snapshot = await latestAgendaSnapshot(runStore);
    const sink = captureWriter();

    renderAgenda(sink.writer, snapshot, projectRoot);

    assert.equal(snapshot?.run?.id, olderRun.id);
    assert.equal(snapshot?.sourceRunId, olderRun.id);
    assert.equal(snapshot?.provenanceKnown, true);
    assert.match(sink.readText(), new RegExp(`source: run ${olderRun.id}`));
    assert.match(sink.readText(), new RegExp(`run agenda: .*${olderRun.id}`));
    assert.doesNotMatch(sink.readText(), new RegExp(`run agenda: .*${newerRun.id}`));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("latestAgendaSnapshot treats bare global direction as unknown provenance", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-agenda-global-unknown-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const run = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "What newer run exists without an agenda?",
      researchDirection: "A newer but unrelated run.",
      successCriterion: "Do not use this run for agenda provenance."
    }, ["clawresearch", "research-loop"]);
    run.status = "completed";
    await runStore.save(run);
    await writeFile(researchDirectionPath(projectRoot), `${JSON.stringify(actionableAgenda(), null, 2)}\n`, "utf8");

    const snapshot = await latestAgendaSnapshot(runStore);
    const sink = captureWriter();

    renderAgenda(sink.writer, snapshot, projectRoot);

    assert.equal(snapshot?.run, null);
    assert.equal(snapshot?.sourceRunId, null);
    assert.equal(snapshot?.provenanceKnown, false);
    assert.equal(snapshot?.workPackage?.id, "wp-1");
    assert.match(sink.readText(), /source: global\/unknown/);
    assert.doesNotMatch(sink.readText(), /run agenda:/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("handleContinueCommand launches from unknown global provenance with a null parent run", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-continue-global-unknown-"));
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    session.brief.topic = "Riemann Hypothesis";
    session.brief.researchQuestion = "How does it influence prime distribution?";
    session.brief.researchDirection = "Literature synthesis.";
    session.brief.successCriterion = "Grounded summary.";
    session.intake.readiness = "ready";
    await sessionStore.save(session);

    const runStore = new RunStore(projectRoot, "0.6.0", now);
    await writeFile(researchDirectionPath(projectRoot), `${JSON.stringify(actionableAgenda(), null, 2)}\n`, "utf8");

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    const runController = new CapturingContinueRunController();
    const sink = captureWriter();

    await handleContinueCommand(
      sink.writer,
      session,
      sessionStore,
      runStore,
      runController,
      projectConfig,
      now,
      false,
      50
    );

    const runs = await runStore.list();
    const childRun = runs.find((candidate) => candidate.stage === "work_package") ?? null;

    assert.ok(childRun);
    assert.equal(childRun.parentRunId, null);
    assert.equal(childRun.derivedFromWorkPackageId, "wp-1");
    assert.deepEqual(runController.launchedRunIds, [childRun.id]);
    assert.ok(childRun.job.launchCommand?.includes("--run-job"));
    assert.ok(childRun.job.launchCommand?.includes(childRun.id));
    assert.ok(childRun.job.launchCommand?.includes("--project-root"));
    assert.ok(childRun.job.launchCommand?.includes(projectRoot));
    assert.match(sink.readText(), /Parent run id: <unknown>/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("handleContinueCommand refuses blocked on-hold agendas", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-continue-blocked-"));
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    session.brief.topic = "Riemann Hypothesis";
    session.brief.researchQuestion = "How does it influence prime distribution?";
    session.brief.researchDirection = "Literature synthesis.";
    session.brief.successCriterion = "Grounded summary.";
    session.intake.readiness = "ready";
    await sessionStore.save(session);

    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const run = await runStore.create(session.brief, ["clawresearch", "research-loop", "--mode", "plan-gather-synthesize"]);
    run.status = "completed";
    run.stage = "literature_review";
    await runStore.save(run);

    await writeFile(run.artifacts.agendaPath, `${JSON.stringify({
      executiveSummary: "A blocked direction was identified.",
      gaps: [],
      candidateDirections: [
        {
          id: "direction-1",
          title: "Blocked direction",
          summary: "Needs unavailable data.",
          mode: "method_improvement",
          whyNow: "Only as a placeholder.",
          sourceIds: [],
          claimIds: [],
          gapIds: [],
          scores: {
            evidenceBase: 4,
            novelty: 3,
            tractability: 3,
            expectedCost: 3,
            risk: 2,
            overall: 4
          }
        }
      ],
      selectedDirectionId: "direction-1",
      selectedWorkPackage: {
        id: "wp-1",
        title: "Blocked package",
        mode: "method_improvement",
        objective: "Try a blocked next step.",
        hypothesisOrQuestion: "Can we proceed despite blockers?",
        methodSketch: "Not yet.",
        baselines: [],
        controls: [],
        decisiveExperiment: "Not yet.",
        stopCriterion: "Not yet.",
        expectedArtifact: "A blocked artifact.",
        requiredInputs: ["Dataset"],
        blockedBy: ["Missing datasets"]
      },
      holdReasons: ["Missing datasets make the selected package non-actionable."],
      recommendedHumanDecision: "Do not continue yet."
    }, null, 2)}\n`, "utf8");
    await writeFile(run.artifacts.workPackagePath, `${JSON.stringify({
      id: "wp-1",
      title: "Blocked package",
      mode: "method_improvement",
      objective: "Try a blocked next step.",
      hypothesisOrQuestion: "Can we proceed despite blockers?",
      methodSketch: "Not yet.",
      baselines: [],
      controls: [],
      decisiveExperiment: "Not yet.",
      stopCriterion: "Not yet.",
      expectedArtifact: "A blocked artifact.",
      requiredInputs: ["Dataset"],
      blockedBy: ["Missing datasets"]
    }, null, 2)}\n`, "utf8");

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    const sink = captureWriter();

    await handleContinueCommand(
      sink.writer,
      session,
      sessionStore,
      runStore,
      createDefaultRunController(),
      projectConfig,
      now,
      false,
      50
    );

    assert.match(sink.readText(), /not ready for \/continue yet/i);
    assert.match(sink.readText(), /Missing datasets/i);
    const savedSession = await sessionStore.load();
    assert.equal(savedSession.activeRunId, null);
    assert.equal(savedSession.lastRunId, run.id);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
