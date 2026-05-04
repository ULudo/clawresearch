import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handleGoCommand,
  handleUserInput,
  latestAgendaSnapshot,
  renderAgenda,
  summarizeCompletedRunIfNeeded,
  type ConsoleIo
} from "../src/runtime/console-app.js";
import { ConsoleTranscript } from "../src/runtime/console-transcript.js";
import type { IntakeBackend, IntakeResponse } from "../src/runtime/intake-backend.js";
import type { ProjectAssistantBackend } from "../src/runtime/project-assistant-backend.js";
import type { ResearchAgenda } from "../src/runtime/research-backend.js";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import { CredentialStore } from "../src/runtime/credential-store.js";
import { researchDirectionPath, RunStore } from "../src/runtime/run-store.js";
import { SessionStore } from "../src/runtime/session-store.js";
import type { RunController } from "../src/runtime/run-controller.js";
import { createResearchWorkerState, writeResearchWorkerState } from "../src/runtime/research-state.js";

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

class FakeRunController implements RunController {
  launchCommand(run: { id: string; projectRoot: string }): string[] {
    return ["node", "stub-cli.js", "--run-job", run.id, "--project-root", run.projectRoot];
  }

  async launch(): Promise<number> {
    return 9876;
  }

  isProcessAlive(): boolean {
    return true;
  }

  async pause(): Promise<void> {}

  async resume(): Promise<void> {}
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
    selectedWorkPackage: null,
    holdReasons: [],
    recommendedHumanDecision: "Continue the autonomous worker toward release readiness.",
    ...overrides
  };
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
    run.statusMessage = "Provider-aware literature run completed successfully.";
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
        return readyResponse("The latest research run completed, but the next internal research action still needs local inputs before it can proceed.");
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

test("handleUserInput lets the project assistant write normal project files", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-project-file-write-"));
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    session.brief.topic = "Autonomous research agents";
    session.brief.researchQuestion = "How should the run feedback be preserved?";
    session.brief.researchDirection = "Discuss the completed run and save a design note.";
    session.brief.successCriterion = "Create a persistent Markdown note.";
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
      async respond() {
        return {
          assistantMessage: "I saved the feedback as a Markdown note.",
          brief: {
            topic: null,
            researchQuestion: null,
            researchDirection: null,
            successCriterion: null
          },
          readiness: "ready",
          readinessRationale: null,
          openQuestions: [],
          summary: null,
          fileActions: [{
            action: "write_project_file" as const,
            path: "docs/run-feedback.md",
            content: "# Run Feedback\n\nThe app should preserve discussed feedback as project files.\n",
            overwrite: false
          }]
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
      "Please save this feedback in docs/run-feedback.md.",
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

    const written = await readFile(path.join(projectRoot, "docs", "run-feedback.md"), "utf8");

    assert.match(written, /Run Feedback/);
    assert.match(sink.readText(), /Wrote docs\/run-feedback\.md/);
    assert.match(session.conversation.at(-1)?.text ?? "", /Wrote docs\/run-feedback\.md/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("handleUserInput blocks sensitive project file writes while applying safe file actions", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-project-file-guard-"));
  const outsidePath = path.resolve(projectRoot, `../${path.basename(projectRoot)}-outside.md`);
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    session.brief.topic = "Autonomous research agents";
    session.brief.researchQuestion = "How should the run feedback be preserved?";
    session.brief.researchDirection = "Discuss the completed run and save a design note.";
    session.brief.successCriterion = "Create a persistent Markdown note.";
    session.intake.readiness = "ready";
    await sessionStore.save(session);
    await mkdir(path.join(projectRoot, "docs"), { recursive: true });
    await writeFile(path.join(projectRoot, "docs", "notes.md"), "# Notes\n", "utf8");

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
      async respond() {
        return {
          assistantMessage: "I updated the safe project note and skipped unsafe writes.",
          brief: {
            topic: null,
            researchQuestion: null,
            researchDirection: null,
            successCriterion: null
          },
          readiness: "ready",
          readinessRationale: null,
          openQuestions: [],
          summary: null,
          fileActions: [
            {
              action: "append_project_file" as const,
              path: "docs/notes.md",
              content: "\nThe latest run needs clearer source-role notes.",
              overwrite: false
            },
            {
              action: "write_project_file" as const,
              path: ".env",
              content: "SECRET=should-not-write\n",
              overwrite: true
            },
            {
              action: "write_project_file" as const,
              path: `../${path.basename(projectRoot)}-outside.md`,
              content: "outside\n",
              overwrite: true
            }
          ]
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
      "Append this note but do not touch sensitive files.",
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

    const written = await readFile(path.join(projectRoot, "docs", "notes.md"), "utf8");
    const output = sink.readText();

    assert.match(written, /clearer source-role notes/);
    assert.match(output, /Appended docs\/notes\.md/);
    assert.match(output, /Blocked write to a sensitive project\/runtime file/);
    assert.match(output, /Blocked file write outside the project root/);
    await assert.rejects(() => readFile(path.join(projectRoot, ".env"), "utf8"));
    await assert.rejects(() => readFile(outsidePath, "utf8"));
  } finally {
    await rm(outsidePath, { force: true });
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
      selectedWorkPackage: null,
      holdReasons: [],
      recommendedHumanDecision: "Continue the autonomous worker toward release readiness."
    }, null, 2)}\n`, "utf8");
    const first = await summarizeCompletedRunIfNeeded(session, sessionStore, run, now);
    const second = await summarizeCompletedRunIfNeeded(session, sessionStore, run, now);

    assert.match(first ?? "", /Research segment complete/i);
    assert.doesNotMatch(first ?? "", /Selected next research focus recorded/i);
    assert.doesNotMatch(first ?? "", /\/continue/i);
    assert.equal(second, null);
    assert.equal(session.lastSummarizedRunId, run.id);
    assert.match(session.conversation.at(-1)?.text ?? "", /Research segment complete/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("summarizeCompletedRunIfNeeded prefers an on-hold summary over a blocked internal-action suggestion", async () => {
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
      selectedWorkPackage: null,
      holdReasons: ["Missing datasets make the selected package non-actionable."],
      recommendedHumanDecision: "Do not continue yet."
    }, null, 2)}\n`, "utf8");
    const summary = await summarizeCompletedRunIfNeeded(session, sessionStore, run, now);

    assert.match(summary ?? "", /agenda is on hold/i);
    assert.doesNotMatch(summary ?? "", /Selected next work package/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("handleGoCommand blocks unresolved user decisions but resumes after the brief changes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-worker-state-"));
  const now = createNow();

  try {
    const sessionStore = new SessionStore(projectRoot, "0.6.0", now);
    const session = await sessionStore.load();
    session.brief.topic = "Autonomous research agents";
    session.brief.researchQuestion = "What makes autonomous research-agent literature reviews reliable?";
    session.brief.researchDirection = "Evaluate source selection, evidence synthesis, and critique loops.";
    session.brief.successCriterion = "Produce a release-ready review paper or explain external blockers.";
    session.intake.readiness = "ready";
    await sessionStore.save(session);

    await writeResearchWorkerState({
      ...createResearchWorkerState({
        projectRoot,
        brief: session.brief,
        now: now()
      }),
      status: "needs_user_decision",
      activeRunId: null,
      lastRunId: "run-old",
      segmentCount: 1,
      statusReason: "Choose between two explicit research-continuation options before another segment can help.",
      paperReadiness: "needs_more_evidence",
      nextInternalActions: [
        "Option A: refine the objective toward a narrower evidence target.",
        "Option B: add source access credentials and keep the current objective."
      ],
      userBlockers: [
        "Option A: refine the objective toward a narrower evidence target.",
        "Option B: add source access credentials and keep the current objective."
      ]
    });

    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const sink = captureWriter();
    const backend: IntakeBackend = {
      label: "intake:test",
      async respond(): Promise<IntakeResponse> {
        return readyResponse("The brief is ready.");
      }
    };

    await handleGoCommand(
      sink.writer,
      session,
      sessionStore,
      runStore,
      backend,
      new FakeRunController(),
      now,
      false,
      5
    );

    assert.match(sink.readText(), /needs a user research decision/);
    assert.equal(await runStore.latest(), null);

    session.brief.researchQuestion = "Which source-selection and critic-loop practices make autonomous research-agent literature reviews reliable?";
    await sessionStore.save(session);

    await handleGoCommand(
      sink.writer,
      session,
      sessionStore,
      runStore,
      backend,
      new FakeRunController(),
      now,
      false,
      5
    );

    assert.match(sink.readText(), /segment started for the updated objective/);
    assert.notEqual(await runStore.latest(), null);
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
    assert.equal(snapshot?.agenda.selectedDirectionId, "direction-1");
    assert.match(sink.readText(), /source: global\/unknown/);
    assert.doesNotMatch(sink.readText(), /run agenda:/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
