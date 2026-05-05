import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handleGoCommand,
  handleUserInput,
  summarizeCompletedRunIfNeeded,
  type ConsoleIo
} from "../src/runtime/console-app.js";
import { ConsoleTranscript } from "../src/runtime/console-transcript.js";
import type { IntakeBackend, IntakeResponse } from "../src/runtime/intake-backend.js";
import type { ProjectAssistantBackend } from "../src/runtime/project-assistant-backend.js";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import { CredentialStore } from "../src/runtime/credential-store.js";
import { RunStore } from "../src/runtime/run-store.js";
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

    await writeFile(run.artifacts.summaryPath, "# Research Summary\n\nThe worker identified fast algorithm optimization as the best bounded next step.\n", "utf8");
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
