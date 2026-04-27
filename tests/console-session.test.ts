import test from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ConsoleIo,
  runPhaseOneConsole
} from "../src/runtime/console-app.js";
import type {
  IntakeBackend,
  IntakeRequest,
  IntakeResponse
} from "../src/runtime/intake-backend.js";
import type { RunController } from "../src/runtime/run-controller.js";
import { appendRunEvent } from "../src/runtime/run-events.js";
import { RunStore } from "../src/runtime/run-store.js";

type CapturedIo = ConsoleIo & {
  output: string;
};

function createScriptedIo(lines: string[]): CapturedIo {
  let output = "";
  const queue = [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ...lines
  ];

  return {
    get output() {
      return output;
    },
    writer: {
      write(chunk: string) {
        output += chunk;
      }
    },
    async prompt(): Promise<string | null> {
      return queue.shift() ?? null;
    },
    close(): void {}
  };
}

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

class FakeRunController implements RunController {
  private nextPid = 4000;
  private readonly alive = new Set<number>();

  launchCommand(run: { id: string; projectRoot: string }): string[] {
    return ["node", "stub-cli.js", "--run-job", run.id, "--project-root", run.projectRoot];
  }

  async launch(): Promise<number> {
    const pid = this.nextPid;
    this.nextPid += 1;
    this.alive.add(pid);
    return pid;
  }

  async pause(workerPid: number): Promise<void> {
    if (!this.alive.has(workerPid)) {
      throw new Error(`process ${workerPid} is not alive`);
    }
  }

  async resume(workerPid: number): Promise<void> {
    if (!this.alive.has(workerPid)) {
      throw new Error(`process ${workerPid} is not alive`);
    }
  }

  isProcessAlive(workerPid: number): boolean {
    return this.alive.has(workerPid);
  }
}

class WatchedFakeRunController implements RunController {
  private nextPid = 5000;
  private readonly alive = new Set<number>();

  constructor(
    private readonly now: () => string,
    private readonly stepDelayMs = 10
  ) {}

  launchCommand(run: { id: string; projectRoot: string }): string[] {
    return ["node", "stub-cli.js", "--run-job", run.id, "--project-root", run.projectRoot];
  }

  async launch(run: { id: string; projectRoot: string; appVersion: string }): Promise<number> {
    const pid = this.nextPid;
    this.nextPid += 1;
    this.alive.add(pid);

    void this.simulateRunLifecycle(run, pid);
    return pid;
  }

  async pause(workerPid: number): Promise<void> {
    if (!this.alive.has(workerPid)) {
      throw new Error(`process ${workerPid} is not alive`);
    }
  }

  async resume(workerPid: number): Promise<void> {
    if (!this.alive.has(workerPid)) {
      throw new Error(`process ${workerPid} is not alive`);
    }
  }

  isProcessAlive(workerPid: number): boolean {
    return this.alive.has(workerPid);
  }

  private async simulateRunLifecycle(
    run: { id: string; projectRoot: string; appVersion: string },
    pid: number
  ): Promise<void> {
    const store = new RunStore(run.projectRoot, run.appVersion, this.now);

    await delay(this.stepDelayMs);
    const running = await store.load(run.id);
    running.status = "running";
    running.startedAt = running.startedAt ?? this.now();
    running.statusMessage = "The detached shell job is running.";
    await store.save(running);
    await appendRunEvent(running.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "run",
      message: "Run worker started."
    });
    await appendRunEvent(running.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "plan",
      message: "Plan the research mode and generate initial search queries."
    });
    await appendRunEvent(running.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "next",
      message: "Gather local and literature sources for the planned first-pass investigation."
    });
    await appendRunEvent(running.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "exec",
      message: "clawresearch research-loop --mode plan-gather-synthesize"
    });
    await appendFile(running.artifacts.stdoutPath, "Research backend: stub\n", "utf8");
    await appendRunEvent(running.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "source",
      message: "brief-1: AI adoption and job displacement in nursing homes (project_brief; no external locator)"
    });

    await delay(this.stepDelayMs);
    const completed = await store.load(run.id);
    completed.status = "completed";
    completed.workerPid = null;
    completed.finishedAt = this.now();
    completed.job.exitCode = 0;
    completed.job.finishedAt = this.now();
    completed.statusMessage = "Minimal explicit research loop completed successfully.";
    await store.save(completed);
    await appendRunEvent(completed.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "summary",
      message: "The initial source-grounded research pass identified a few stable themes and follow-up questions."
    });
    await appendRunEvent(completed.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "claim",
      message: "Current deployment evidence suggests displacement risk is uneven across role categories. [brief-1]"
    });
    await appendRunEvent(completed.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "next",
      message: "Which nursing-home job categories appear most exposed to partial automation in current deployments?"
    });
    await appendRunEvent(completed.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "run",
      message: "Minimal explicit research loop completed successfully."
    });
    this.alive.delete(pid);
  }
}

class RaceyWatchedRunController implements RunController {
  private nextPid = 6000;
  private readonly alive = new Set<number>();

  constructor(
    private readonly now: () => string,
    private readonly stepDelayMs = 10
  ) {}

  launchCommand(run: { id: string; projectRoot: string }): string[] {
    return ["node", "stub-cli.js", "--run-job", run.id, "--project-root", run.projectRoot];
  }

  async launch(run: { id: string; projectRoot: string; appVersion: string }): Promise<number> {
    const pid = this.nextPid;
    this.nextPid += 1;
    this.alive.add(pid);

    void this.simulateRunLifecycle(run, pid);
    return pid;
  }

  async pause(workerPid: number): Promise<void> {
    if (!this.alive.has(workerPid)) {
      throw new Error(`process ${workerPid} is not alive`);
    }
  }

  async resume(workerPid: number): Promise<void> {
    if (!this.alive.has(workerPid)) {
      throw new Error(`process ${workerPid} is not alive`);
    }
  }

  isProcessAlive(workerPid: number): boolean {
    return this.alive.has(workerPid);
  }

  private async simulateRunLifecycle(
    run: { id: string; projectRoot: string; appVersion: string },
    pid: number
  ): Promise<void> {
    const store = new RunStore(run.projectRoot, run.appVersion, this.now);

    await delay(this.stepDelayMs);
    const running = await store.load(run.id);
    running.status = "running";
    running.startedAt = running.startedAt ?? this.now();
    running.statusMessage = "The detached shell job is running.";
    await store.save(running);
    await appendRunEvent(running.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "run",
      message: "Run worker started."
    });

    await delay(this.stepDelayMs);
    this.alive.delete(pid);

    await delay(this.stepDelayMs * 6);
    const completed = await store.load(run.id);
    completed.status = "completed";
    completed.workerPid = null;
    completed.finishedAt = this.now();
    completed.job.exitCode = 0;
    completed.job.finishedAt = this.now();
    completed.statusMessage = "Minimal explicit research loop completed successfully.";
    await store.save(completed);
    await appendRunEvent(completed.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "summary",
      message: "The delayed completion write landed after the worker process exited."
    });
    await appendRunEvent(completed.artifacts.eventsPath, {
      timestamp: this.now(),
      kind: "run",
      message: "Minimal explicit research loop completed successfully."
    });
  }
}

class StubIntakeBackend implements IntakeBackend {
  readonly label = "stub:intake";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    const lastUserMessage = [...request.conversation]
      .reverse()
      .find((message) => message.role === "user")
      ?.content;

    if (request.mode === "start") {
      return {
        assistantMessage: "What research problem should I investigate for this project, and what kind of outcome would make the work useful to you?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project brief has not been described yet.",
        openQuestions: [
          "What is the actual research problem?",
          "What would a useful outcome look like?"
        ],
        summary: null
      };
    }

    if (lastUserMessage === "Hi, can you hear me?") {
      return {
        assistantMessage: "Yes. Tell me what research project you want to hand off, and I will help sharpen it into a usable brief.",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "A greeting is not enough to define the project.",
        openQuestions: [
          "What is the actual research topic or problem?",
          "What kind of result would make the work valuable?"
        ],
        summary: null
      };
    }

    if (lastUserMessage?.includes("Riemann hypothesis") ?? false) {
      return {
        assistantMessage: "That is still too broad for an actionable research brief. Do you want a literature survey, a computational exploration, or an attempt at a bounded subproblem around the Riemann hypothesis?",
        brief: {
          topic: "computational work around the Riemann hypothesis",
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The topic is present, but the concrete question and scope are still unclear.",
        openQuestions: [
          "Is this a literature synthesis, computational exploration, or a bounded mathematical subproblem?",
          "What would count as a useful outcome?"
        ],
        summary: "The user wants research work related to the Riemann hypothesis, but the project is still underspecified."
      };
    }

    if (lastUserMessage?.includes("computational exploration") ?? false) {
      return {
        assistantMessage: "Good. I’m treating this as a computational exploration rather than an open-ended attempt to solve the full hypothesis. What evidence would make the project successful for you?",
        brief: {
          topic: "computational exploration related to the Riemann hypothesis",
          researchQuestion: "Which computational experiments around the Riemann zeta function could produce a useful exploratory research note?",
          researchDirection: "Scope the work to computational experiments, prior literature, and bounded exploratory analysis rather than claiming a proof.",
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The direction is now bounded, but the success criterion is still missing.",
        openQuestions: [
          "What concrete deliverable or evidence would make the project successful?"
        ],
        summary: "The project is a bounded computational exploration around the Riemann hypothesis."
      };
    }

    if (lastUserMessage?.includes("deliverable") ?? false) {
      return {
        assistantMessage: "That is specific enough to start. I now have a bounded topic, question, direction, and success criterion for Phase 1.",
        brief: {
          topic: "computational exploration related to the Riemann hypothesis",
          researchQuestion: "Which computational experiments around the Riemann zeta function could produce a useful exploratory research note?",
          researchDirection: "Review prior computational work, select a bounded experiment on zeta zeros or related numerical structure, and produce a reproducible exploratory note without claiming a proof.",
          successCriterion: "Produce a reproducible exploratory note with literature grounding, clearly stated limits, and at least one completed computational experiment that yields interpretable results.",
        },
        readiness: "ready",
        readinessRationale: "The brief is now concrete enough for a first autonomous research pass.",
        openQuestions: [],
        summary: "A bounded computational-exploration project around the Riemann hypothesis with a concrete exploratory deliverable."
      };
    }

    return {
      assistantMessage: "Tell me more about the specific research problem and how you want the work bounded.",
      brief: request.brief,
      readiness: "needs_clarification",
      readinessRationale: "The project still needs clarification.",
      openQuestions: ["What specific research problem should this project tackle?"],
      summary: null
    };
  }
}

class RepeatingQuestionBackend implements IntakeBackend {
  readonly label = "stub:repeating";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    if (request.mode === "start") {
      return {
        assistantMessage: "Hello! I'm ClawResearch's research intake consultant. What research topic do you want to work on?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project has not been described yet.",
        openQuestions: ["What topic should the project address?"],
        summary: null
      };
    }

    if (request.mode === "recover") {
      return {
        assistantMessage: "We have enough to draft a workable first-pass brief. A sensible starting point would be: study existing proof strategies and failure points around the Riemann hypothesis, then identify one bounded mathematical or computational avenue worth deeper follow-up. I can proceed with that framing unless you want a different angle.",
        brief: {
          topic: "Riemann hypothesis",
          researchQuestion: "What existing proof strategies and failure points around the Riemann hypothesis suggest promising bounded directions for further research?",
          researchDirection: "Map prior proof strategies and critiques, then isolate one bounded mathematical or computational avenue for focused follow-up.",
          successCriterion: "Produce a literature-grounded research note that synthesizes prior approaches, explains why they stall, and identifies at least one bounded next-step direction worth investigating."
        },
        readiness: "ready",
        readinessRationale: "The conversation now has enough signal for a workable first-pass brief.",
        openQuestions: [],
        summary: "A first-pass brief centered on surveying prior proof strategies and extracting a bounded next-step direction."
      };
    }

    return {
      assistantMessage: "Could you specify whether you'd like to explore the theoretical challenges in proving the Riemann Hypothesis or investigate existing approaches and their limitations?",
      brief: {
        topic: "Riemann hypothesis",
        researchQuestion: null,
        researchDirection: null,
        successCriterion: null
      },
      readiness: "needs_clarification",
      readinessRationale: "The project still needs a concrete research mode.",
      openQuestions: [
        "Would you like to explore theoretical challenges or existing approaches?"
      ],
      summary: null
    };
  }
}

class GenericRepeatingBackend implements IntakeBackend {
  readonly label = "stub:generic-repeating";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    if (request.mode === "start") {
      return {
        assistantMessage: "Hello! I'm ClawResearch's research intake consultant. What research topic do you want to work on?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project has not been described yet.",
        openQuestions: ["What topic should the project address?"],
        summary: null
      };
    }

    if (request.mode === "recover") {
      return {
        assistantMessage: "We already have enough to draft a practical starting brief. A good first pass would be: study how AI adoption may affect workforce displacement across nursing-home jobs in general, using existing evidence and case reporting rather than trying to answer every sub-segment immediately. I can use that framing unless you want to narrow by country or role type.",
        brief: {
          topic: "AI adoption and workforce displacement in nursing homes",
          researchQuestion: "How might AI adoption affect workforce displacement across nursing-home jobs in general?",
          researchDirection: "Review existing evidence, policy discussion, and case reporting on AI adoption in nursing homes, with a focus on displacement risks across job categories.",
          successCriterion: "Produce a research note that summarizes current evidence, distinguishes likely displacement mechanisms from speculation, and identifies the strongest open questions for follow-up."
        },
        readiness: "ready",
        readinessRationale: "The conversation now contains enough signal for a useful first-pass brief.",
        openQuestions: [],
        summary: "A first-pass brief on AI-driven workforce displacement risks across nursing-home jobs."
      };
    }

    return {
      assistantMessage: "Could you clarify whether you want to focus on employment rates, workforce displacement, or another labor-market effect?",
      brief: {
        topic: "AI models and jobs in nursing homes",
        researchQuestion: null,
        researchDirection: null,
        successCriterion: null
      },
      readiness: "needs_clarification",
      readinessRationale: "The project still needs a concrete research mode.",
      openQuestions: [
        "Do you want to focus on employment rates, workforce displacement, or another labor-market effect?"
      ],
      summary: null
    };
  }
}

class DeepClarificationBackend implements IntakeBackend {
  readonly label = "stub:deep-clarification";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    if (request.mode === "start") {
      return {
        assistantMessage: "Hello! I'm ClawResearch's research intake consultant. Could you tell me a bit about the general topic or problem you're interested in exploring?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project has not been described yet.",
        openQuestions: ["What topic should the project address?"],
        summary: null
      };
    }

    if (request.mode === "recover") {
      return {
        assistantMessage: "We have enough context to propose a workable research suggestion. A strong first-pass project would be: study how prime-number distribution and the prime-counting function connect to the Riemann Hypothesis, with emphasis on what current number-theoretic tools can and cannot say. I can proceed with that framing unless you want to redirect it.",
        brief: {
          topic: "Riemann Hypothesis and prime-number distribution",
          researchQuestion: "How does the behavior of the prime-counting function illuminate what number-theoretic progress is realistic around the Riemann Hypothesis?",
          researchDirection: "Review the link between prime-number distribution, the prime-counting function, and the Riemann zeta function, then identify a bounded number-theoretic angle worth deeper analysis.",
          successCriterion: "Produce a research note that explains the current mathematical landscape, clarifies what is realistic to investigate, and proposes one bounded next-step direction."
        },
        readiness: "ready",
        readinessRationale: "The conversation contains enough narrowing detail for a strong first-pass brief.",
        openQuestions: [],
        summary: "A first-pass brief focused on prime-number distribution, the prime-counting function, and realistic number-theoretic progress around the Riemann Hypothesis."
      };
    }

    return {
      assistantMessage: "Could you clarify what specific aspect you'd like to investigate next?",
      brief: {
        topic: "Riemann Hypothesis",
        researchQuestion: null,
        researchDirection: null,
        successCriterion: null
      },
      readiness: "needs_clarification",
      readinessRationale: "The project still needs a more specific focal point.",
      openQuestions: ["What exact aspect should the project investigate next?"],
      summary: null
    };
  }
}

class GoCompletionBackend implements IntakeBackend {
  readonly label = "stub:go-completion";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    const lastUserMessage = [...request.conversation]
      .reverse()
      .find((message) => message.role === "user")
      ?.content;

    if (request.mode === "start") {
      return {
        assistantMessage: "Hello! I'm ClawResearch's research intake consultant. Could you please tell me more about the topic you're interested in and what specific research question you'd like to explore?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project has not been described yet.",
        openQuestions: ["What topic should the project address?"],
        summary: null
      };
    }

    if (request.mode === "recover") {
      return {
        assistantMessage: "I can complete the missing brief details from our discussion and proceed with this first-pass project framing.",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: "Which algorithmic and computational methods could meaningfully advance numerical study or verification work related to the Riemann Hypothesis?",
          researchDirection: "Study existing computational approaches to the Riemann Hypothesis, identify where algorithm development could improve numerical verification or exploratory analysis, and propose one concrete algorithmic direction for follow-up.",
          successCriterion: "Produce a literature-grounded research note that reviews current computational methods, identifies a credible algorithmic improvement opportunity, and defines a bounded next-step investigation."
        },
        readiness: "ready",
        readinessRationale: "The conversation contains enough signal for a complete first-pass brief.",
        openQuestions: [],
        summary: "A first-pass brief focused on algorithm development for computational work related to the Riemann Hypothesis."
      };
    }

    if (lastUserMessage === "I want to do research on the riemann hypothesis") {
      return {
        assistantMessage: "That's an interesting topic! Could you clarify what specific research question you'd like to explore regarding the Riemann Hypothesis? For example, are you interested in its implications, historical context, computational approaches, or something else?",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The topic is clear, but the project focus is still broad.",
        openQuestions: ["Which aspect of the Riemann Hypothesis should the project explore?"],
        summary: null
      };
    }

    if (lastUserMessage === "I want to have it solved") {
      return {
        assistantMessage: "Solving the Riemann Hypothesis is a monumental challenge in mathematics. Could you clarify what specific aspect of the hypothesis you'd like to investigate? For example, are you interested in exploring computational methods, historical approaches, or theoretical frameworks that might lead to a solution?",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project still needs a realistic first-pass angle.",
        openQuestions: ["Which angle should the project investigate?"],
        summary: null
      };
    }

    if (lastUserMessage === "computational methods") {
      return {
        assistantMessage: "Great! Focusing on computational methods for the Riemann Hypothesis is a solid direction. Could you clarify what specific computational aspect you're interested in? For example, numerical verification of zeros, algorithm development, or parallel computing techniques?",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: "Computational methods related to the Riemann Hypothesis",
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The computational direction is clearer, but the project still needs a sharper question.",
        openQuestions: ["Which computational aspect should the project emphasize?"],
        summary: null
      };
    }

    if (lastUserMessage === "algorithm development") {
      return {
        assistantMessage: "Thank you for the clarification. Based on our conversation, here is a working research brief: The topic is the Riemann Hypothesis, the research direction is algorithm development for computational methods, and the goal is to explore new algorithms that could advance the understanding or verification of the hypothesis. Does this align with your vision for the project, or would you like to refine any of these aspects further?",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: "Algorithm development for computational methods related to the Riemann Hypothesis",
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The brief still needs a structured research question and success criterion.",
        openQuestions: [
          "What specific research question should guide the algorithm-development work?",
          "What would count as a successful outcome?"
        ],
        summary: "A working brief centered on algorithm development for computational work on the Riemann Hypothesis."
      };
    }

    if (lastUserMessage === "that sounds good") {
      return {
        assistantMessage: "Wonderful! With your confirmation, I'll proceed with the brief as outlined. If you have any additional thoughts or need further adjustments, feel free to share them at any time.",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: "Algorithm development for computational methods related to the Riemann Hypothesis",
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The user confirmed the direction, but the structured brief still needs the missing fields formalized.",
        openQuestions: [
          "What specific research question should guide the algorithm-development work?",
          "What would count as a successful outcome?"
        ],
        summary: "A confirmed working brief centered on algorithm development for computational work on the Riemann Hypothesis."
      };
    }

    return {
      assistantMessage: "Tell me a bit more about how you want to shape the project.",
      brief: request.brief,
      readiness: "needs_clarification",
      readinessRationale: "The project still needs clarification.",
      openQuestions: ["What additional detail should shape this project?"],
      summary: null
    };
  }
}

class CompletionFallbackBackend implements IntakeBackend {
  readonly label = "stub:completion-fallback";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    const lastUserMessage = [...request.conversation]
      .reverse()
      .find((message) => message.role === "user")
      ?.content;

    if (request.mode === "start") {
      return {
        assistantMessage: "Hello! I'm ClawResearch's research intake consultant. What topic are you interested in?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project has not been described yet.",
        openQuestions: ["What topic should the project address?"],
        summary: null
      };
    }

    if (lastUserMessage === "Riemann hypothesis") {
      return {
        assistantMessage: "What computational aspect are you most interested in?",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The topic is set, but the project mode is still unclear.",
        openQuestions: ["Which computational aspect matters most?"],
        summary: null
      };
    }

    if (lastUserMessage === "computational approaches") {
      return {
        assistantMessage: "Are you looking at algorithmic improvements, numerical verification, or something else?",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The topic is still broad.",
        openQuestions: ["Which computational approach should the project focus on?"],
        summary: null
      };
    }

    if (lastUserMessage === "algorithmic improvements") {
      return {
        assistantMessage: "What kind of algorithmic improvement do you want to investigate?",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The improvement target is still underspecified.",
        openQuestions: ["Which kind of improvement should the project target?"],
        summary: null
      };
    }

    if (lastUserMessage === "optimizing existing algorithms") {
      return {
        assistantMessage: "Based on our conversation, I've drafted a preliminary research brief. The topic is the Riemann Hypothesis, the direction is optimizing existing algorithms in computational approaches, and success means identifying optimizations that improve computational efficiency in verifying zeros or related problems. Does this align with your goals?",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: "Optimize existing algorithms used in computational approaches to the Riemann Hypothesis.",
          successCriterion: "Identify effective optimizations that improve computational efficiency in verifying zeros or related problems."
        },
        readiness: "needs_clarification",
        readinessRationale: "The research question is still missing.",
        openQuestions: ["What specific research question should guide the optimization work?"],
        summary: null
      };
    }

    if (lastUserMessage === "yes") {
      return {
        assistantMessage: "Great! Since you've confirmed the brief aligns with your goals, we can proceed with this as the initial research focus.",
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: "Optimize existing algorithms used in computational approaches to the Riemann Hypothesis.",
          successCriterion: "Identify effective optimizations that improve computational efficiency in verifying zeros or related problems."
        },
        readiness: "needs_clarification",
        readinessRationale: "The research question is still missing.",
        openQuestions: ["What specific research question should guide the optimization work?"],
        summary: null
      };
    }

    return {
      assistantMessage: "Tell me a bit more about the project.",
      brief: request.brief,
      readiness: "needs_clarification",
      readinessRationale: "The project still needs clarification.",
      openQuestions: ["What additional detail should shape this project?"],
      summary: null
    };
  }

  async completeBrief(): Promise<{
    topic: string;
    researchQuestion: string;
    researchDirection: string;
    successCriterion: string;
  }> {
    return {
      topic: "Riemann Hypothesis",
      researchQuestion: "How can existing algorithms used in computational work on the Riemann Hypothesis be optimized to reduce computational complexity?",
      researchDirection: "Optimize existing algorithms used in computational approaches to the Riemann Hypothesis.",
      successCriterion: "Identify effective optimizations that improve computational efficiency in verifying zeros or related problems."
    };
  }
}

class FailingResumeBackend implements IntakeBackend {
  readonly label = "stub:failing-resume";

  async respond(): Promise<IntakeResponse> {
    throw new Error("resume backend should not have been called");
  }
}

class CompleteProposalBackend implements IntakeBackend {
  readonly label = "stub:complete-proposal";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    const lastUserMessage = [...request.conversation]
      .reverse()
      .find((message) => message.role === "user")
      ?.content;

    if (request.mode === "start") {
      return {
        assistantMessage: "Hello! I'm ClawResearch's research intake consultant. What project would you like to hand off?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project has not been described yet.",
        openQuestions: ["What should the project investigate?"],
        summary: null
      };
    }

    if (request.mode === "recover") {
      throw new Error("recover should not be called when a complete proposed brief already exists");
    }

    if (lastUserMessage === "I want to study AI job displacement in nursing homes") {
      return {
        assistantMessage: "Based on what you've said, here is a working research brief: Topic: AI adoption and job displacement in nursing homes. Research question: How might AI adoption change displacement risks across nursing-home jobs? Research direction: Review current evidence, compare reported deployment patterns, and identify the clearest displacement mechanisms and gaps for follow-up. Success criterion: Produce a literature-grounded research note that maps current evidence, distinguishes observed effects from speculation, and identifies the strongest next questions for follow-up. Let me know if you want to adjust the framing, or use /go if this is the right first-pass project.",
        brief: {
          topic: "AI adoption and job displacement in nursing homes",
          researchQuestion: "How might AI adoption change displacement risks across nursing-home jobs?",
          researchDirection: "Review current evidence, compare reported deployment patterns, and identify the clearest displacement mechanisms and gaps for follow-up.",
          successCriterion: "Produce a literature-grounded research note that maps current evidence, distinguishes observed effects from speculation, and identifies the strongest next questions for follow-up."
        },
        readiness: "needs_clarification",
        readinessRationale: "The user may still want to adjust the framing, but the brief is already usable.",
        openQuestions: ["Does this framing match the project you want to run?"],
        summary: "A complete first-pass brief on AI-related displacement risks in nursing-home work."
      };
    }

    return {
      assistantMessage: "Tell me more about the project you want to run.",
      brief: request.brief,
      readiness: "needs_clarification",
      readinessRationale: "The project still needs clarification.",
      openQuestions: ["What should the project investigate?"],
      summary: null
    };
  }
}

class MessageOnlyProposalBackend implements IntakeBackend {
  readonly label = "stub:message-only-proposal";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    const lastUserMessage = [...request.conversation]
      .reverse()
      .find((message) => message.role === "user")
      ?.content;

    if (request.mode === "start") {
      return {
        assistantMessage: "Hello! I'm ClawResearch's research intake consultant. What project would you like to hand off?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project has not been described yet.",
        openQuestions: ["What should the project investigate?"],
        summary: null
      };
    }

    if (request.mode === "recover") {
      throw new Error("recover should not be called when the visible draft already contains a complete brief");
    }

    if (lastUserMessage === "I want to study autonomous research agents") {
      return {
        assistantMessage: [
          "Based on what you've said, here is a working research brief:",
          "",
          "**Topic**: Autonomous research agents",
          "**Research Question**: What design and implementation practices make autonomous research agents more likely to produce successful and publishable research outputs?",
          "**Research Direction**: Review current agent architectures, workflow patterns, and evaluation practices, then identify the most credible design patterns and implementation tradeoffs for a first-pass synthesis.",
          "**Success Criterion**: Produce a source-grounded research note that maps the strongest design patterns, highlights major implementation tradeoffs, and identifies the clearest next questions for follow-up.",
          "",
          "If that framing looks right, you can use /go immediately."
        ].join("\n"),
        brief: {
          topic: "Autonomous research agents",
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The visible draft is ready for confirmation even though the structured fields were only partially filled.",
        openQuestions: ["Does this framing match the project you want to run?"],
        summary: "A complete first-pass brief on autonomous research agents is visible in the proposed draft."
      };
    }

    return {
      assistantMessage: "Tell me more about the project you want to run.",
      brief: request.brief,
      readiness: "needs_clarification",
      readinessRationale: "The project still needs clarification.",
      openQuestions: ["What should the project investigate?"],
      summary: null
    };
  }
}

class OverambitiousProposalBackend implements IntakeBackend {
  readonly label = "stub:overambitious-proposal";

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
    const lastUserMessage = [...request.conversation]
      .reverse()
      .find((message) => message.role === "user")
      ?.content;

    if (request.mode === "start") {
      return {
        assistantMessage: "Hello! I'm ClawResearch's research intake consultant. What research project are you trying to define?",
        brief: {
          topic: null,
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        readiness: "needs_clarification",
        readinessRationale: "The project has not been described yet.",
        openQuestions: ["What are you trying to achieve?"],
        summary: null
      };
    }

    if (request.mode === "recover") {
      return {
        assistantMessage: "A better first-pass framing would be: map existing AI protein-design approaches for Alzheimer's-related targets, then identify one tractable evaluation setup for focused follow-up rather than claiming a cure directly.",
        brief: {
          topic: "AI protein design for Alzheimer's-related targets",
          researchQuestion: "What Alzheimer's-related targets and evaluation setups are most tractable for a first-pass study of AI protein-design methods?",
          researchDirection: "Review current Alzheimer's-targeted protein-design work, identify one tractable target or assay, and define a bounded evaluation plan for follow-up.",
          successCriterion: "Produce a literature-grounded research note that maps current approaches, identifies one tractable target and evaluation setup, and defines a bounded next-step plan."
        },
        readiness: "ready",
        readinessRationale: "The reframed brief is concrete enough for a first-pass run.",
        openQuestions: [],
        summary: "A bounded first-pass brief focused on tractable targets and evaluation setups for AI protein design related to Alzheimer's."
      };
    }

    if (lastUserMessage === "I want to cure Alzheimer's with AI protein design") {
      return {
        assistantMessage: "Here is a working brief: use AI protein-design methods to cure Alzheimer's disease by generating new candidates and pushing toward a direct therapeutic solution.",
        brief: {
          topic: "AI protein design for Alzheimer's",
          researchQuestion: "How can AI protein-design methods be used to cure Alzheimer's disease?",
          researchDirection: "Design new protein candidates aimed at curing Alzheimer's disease.",
          successCriterion: "Discover a cure for Alzheimer's disease through AI-designed protein candidates."
        },
        readiness: "ready",
        readinessRationale: "The brief is complete.",
        openQuestions: [],
        summary: "A direct cure-oriented brief for Alzheimer's."
      };
    }

    return {
      assistantMessage: "Tell me more about the project you want to define.",
      brief: request.brief,
      readiness: "needs_clarification",
      readinessRationale: "The project still needs clarification.",
      openQuestions: ["What are you trying to achieve?"],
      summary: null
    };
  }
}

test("startup chat treats greetings as greetings instead of brief fields", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-greeting-"));

  try {
    const io = createScriptedIo([
      "Hi, can you hear me?",
      "/status",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.5.0",
      now: createNow(),
      intakeBackend: new StubIntakeBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /What research problem should I investigate/);
    assert.match(io.output, /Yes\. Tell me what research project you want to hand off/);
    assert.match(io.output, /topic: <missing>/);
    assert.match(io.output, /A greeting is not enough to define the project\./);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console uses the intake backend to refine a stakeholder-style brief before /go", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-session-"));

  try {
    const io = createScriptedIo([
      "Do research on the Riemann hypothesis",
      "/go",
      "I want a bounded computational exploration, not a claim to solve the whole thing.",
      "The deliverable should be a reproducible exploratory note with at least one completed computational experiment.",
      "/status",
      "/go",
      "/exit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.5.0",
      now: createNow(),
      intakeBackend: new StubIntakeBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /still too broad for an actionable research brief/i);
    assert.match(io.output, /I'm not ready to start the run yet\./);
    assert.match(io.output, /I still need: research question, research direction, success criterion\./);
    assert.match(io.output, /Best next question: Is this a literature synthesis, computational exploration, or a bounded mathematical subproblem\?/);
    assert.doesNotMatch(io.output, /structured brief/i);
    assert.match(io.output, /Summary: A bounded computational-exploration project around the Riemann hypothesis/);
    assert.match(io.output, /Research run started\./);
    assert.match(io.output, /Status: queued/);
    assert.match(io.output, /\.clawresearch\/runs\/run-/);
    assert.match(io.output, /Session saved\. Closing ClawResearch\./);

    const sessionPath = path.join(projectRoot, ".clawresearch", "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
      status: string;
      goCount: number;
      activeRunId: string | null;
      lastRunId: string | null;
      intake: {
        readiness: string;
        backendLabel: string;
      };
      brief: {
        topic: string;
        researchQuestion: string;
        researchDirection: string;
        successCriterion: string;
      };
    };

    assert.equal(session.status, "ready");
    assert.equal(session.goCount, 1);
    assert.equal(session.activeRunId, session.lastRunId);
    assert.notEqual(session.activeRunId, null);
    assert.equal(session.intake.readiness, "ready");
    assert.equal(session.intake.backendLabel, "stub:intake");
    assert.match(session.brief.topic, /Riemann hypothesis/);
    assert.match(session.brief.successCriterion, /reproducible exploratory note/);

    const runStore = new RunStore(projectRoot, "0.5.0", createNow());
    const run = await runStore.load(session.activeRunId!);
    assert.equal(run.status, "queued");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console breaks out of repeated clarification loops by drafting a workable brief", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-loop-"));

  try {
    const io = createScriptedIo([
      "I want to do research about the Riemann hypothesis",
      "proving the hypothesis",
      "We should come up with a proof for the hypothesis",
      "You asked me that already",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.5.0",
      now: createNow(),
      intakeBackend: new RepeatingQuestionBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /We have enough to draft a workable first-pass brief/i);
    assert.match(io.output, /study existing proof strategies and failure points around the Riemann hypothesis/i);
    assert.match(io.output, /I can proceed with that framing unless you want a different angle/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console uses the same recovery pattern outside the open-problem example", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-generic-loop-"));

  try {
    const io = createScriptedIo([
      "I want to do research about the implication of AI models for jobs in the social area",
      "employment rates",
      "in the workforce of nursing homes",
      "workforce displacement",
      "You asked me that already",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.5.0",
      now: createNow(),
      intakeBackend: new GenericRepeatingBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /We already have enough to draft a practical starting brief/i);
    assert.match(io.output, /AI adoption may affect workforce displacement across nursing-home jobs in general/i);
    assert.match(io.output, /I can use that framing unless you want to narrow by country or role type/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console drafts a research suggestion once the user has provided enough narrowing detail", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-enough-signal-"));

  try {
    const io = createScriptedIo([
      "I want to conduct research on the Riemann hypothesis",
      "I want to solve it",
      "mathematical foundations",
      "number theory",
      "the distribution of prime numbers",
      "behaviour of the prime-counting function",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.5.0",
      now: createNow(),
      intakeBackend: new DeepClarificationBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /We have enough context to propose a workable research suggestion/i);
    assert.match(io.output, /prime-number distribution and the prime-counting function connect to the Riemann Hypothesis/i);
    assert.match(io.output, /I can proceed with that framing unless you want to redirect it/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console preserves the exact wording of a complete proposed brief when the user invokes /go", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-complete-proposal-"));

  try {
    const io = createScriptedIo([
      "I want to study AI job displacement in nursing homes",
      "/go",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.5.0",
      now: createNow(),
      intakeBackend: new CompleteProposalBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /here is a working research brief/i);
    assert.match(io.output, /Research run started\./);
    assert.match(io.output, /Status: queued/);

    const sessionPath = path.join(projectRoot, ".clawresearch", "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
      status: string;
      goCount: number;
      activeRunId: string | null;
      brief: {
        researchDirection: string;
        successCriterion: string;
      };
      intake: {
        readiness: string;
      };
    };

    assert.equal(session.status, "ready");
    assert.equal(session.goCount, 1);
    assert.notEqual(session.activeRunId, null);
    assert.equal(session.intake.readiness, "ready");
    assert.equal(
      session.brief.researchDirection,
      "Review current evidence, compare reported deployment patterns, and identify the clearest displacement mechanisms and gaps for follow-up."
    );
    assert.equal(
      session.brief.successCriterion,
      "Produce a literature-grounded research note that maps current evidence, distinguishes observed effects from speculation, and identifies the strongest next questions for follow-up."
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console can start from a visible drafted brief even when the backend left structured fields incomplete", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-visible-draft-go-"));

  try {
    const io = createScriptedIo([
      "I want to study autonomous research agents",
      "/go",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.5.0",
      now: createNow(),
      intakeBackend: new MessageOnlyProposalBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /working research brief/i);
    assert.match(io.output, /Research run started\./);
    assert.doesNotMatch(io.output, /I'm not ready to start the run yet\./);

    const sessionPath = path.join(projectRoot, ".clawresearch", "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
      status: string;
      goCount: number;
      activeRunId: string | null;
      brief: {
        topic: string;
        researchQuestion: string;
        researchDirection: string;
        successCriterion: string;
      };
      intake: {
        readiness: string;
      };
    };

    assert.equal(session.status, "ready");
    assert.equal(session.goCount, 1);
    assert.notEqual(session.activeRunId, null);
    assert.equal(session.intake.readiness, "ready");
    assert.match(session.brief.researchQuestion, /design and implementation practices/i);
    assert.match(session.brief.researchDirection, /workflow patterns/i);
    assert.match(session.brief.successCriterion, /source-grounded research note/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console saves a local debug transcript of the interaction", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-transcript-"));

  try {
    const io = createScriptedIo([
      "Hi, can you hear me?",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.7.0",
      now: createNow(),
      intakeBackend: new StubIntakeBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);

    const transcript = await readFile(
      path.join(projectRoot, ".clawresearch", "console-transcript.log"),
      "utf8"
    );

    assert.match(transcript, /Debug log: \.clawresearch\/console-transcript\.log/);
    assert.match(transcript, /consultant\s+What research problem should I investigate/);
    assert.match(transcript, /clawresearch> Hi, can you hear me\?/);
    assert.match(transcript, /clawresearch> \/quit/);
    assert.match(transcript, /system\s+Session saved\. Closing ClawResearch\./);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console does not inject a new assistant turn when resuming a session that already ends on an assistant chat message", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-resume-awaiting-user-"));
  const runtimeDirectory = path.join(projectRoot, ".clawresearch");

  try {
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(
      path.join(runtimeDirectory, "session.json"),
      JSON.stringify({
        schemaVersion: 3,
        appVersion: "0.7.0",
        projectRoot,
        runtimeDirectory,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
        status: "startup_chat",
        goCount: 0,
        lastGoRequestedAt: null,
        activeRunId: null,
        lastRunId: null,
        brief: {
          topic: "Riemann Hypothesis",
          researchQuestion: null,
          researchDirection: null,
          successCriterion: null
        },
        intake: {
          backendLabel: "stub:prior",
          readiness: "needs_clarification",
          rationale: "The project still needs clarification.",
          openQuestions: [
            "Which specific angle should the project investigate?"
          ],
          summary: null,
          lastError: null
        },
        conversation: [
          {
            id: "1",
            kind: "chat",
            role: "user",
            text: "I want to study the Riemann Hypothesis.",
            timestamp: "2026-01-01T00:00:00.000Z"
          },
          {
            id: "2",
            kind: "chat",
            role: "assistant",
            text: "Which specific angle should the project investigate?",
            timestamp: "2026-01-01T00:00:01.000Z"
          }
        ]
      }, null, 2),
      "utf8"
    );

    const io = createScriptedIo([
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.7.0",
      now: createNow(),
      intakeBackend: new FailingResumeBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /Resuming the saved startup chat for this project\./);
    assert.doesNotMatch(io.output, /resume backend should not have been called/i);
    assert.doesNotMatch(io.output, /consultant\s+Which specific angle should the project investigate\?/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase two console can pause and resume the active detached run", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-pause-resume-"));

  try {
    const io = createScriptedIo([
      "I want to study AI job displacement in nursing homes",
      "/go",
      "/pause",
      "/status",
      "/resume",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.6.0",
      now: createNow(),
      intakeBackend: new CompleteProposalBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /Research run started\./);
    assert.match(io.output, /Paused run run-/);
    assert.match(io.output, /status: paused/);
    assert.match(io.output, /Resumed run run-/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase two console treats continue as resume for a paused active run", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-continue-resumes-paused-"));

  try {
    const io = createScriptedIo([
      "I want to study AI job displacement in nursing homes",
      "/go",
      "/pause",
      "/continue",
      "/quit"
    ]);
    const now = createNow();

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.6.0",
      now,
      intakeBackend: new CompleteProposalBackend(),
      runController: new FakeRunController()
    });
    const runStore = new RunStore(projectRoot, "0.6.0", now);
    const latestRun = await runStore.latest();

    assert.equal(code, 0);
    assert.match(io.output, /Paused run run-/);
    assert.match(io.output, /Resumed paused run run-/);
    assert.doesNotMatch(io.output, /Wait for it to finish or pause it before launching another work-package run/);
    assert.equal(latestRun?.status, "running");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console exposes review-paper status, checks, and draft text", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-paper-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Autonomous research agents",
      researchQuestion: "How should autonomous research agents be evaluated?",
      researchDirection: "Review evaluation and literature-agent practices.",
      successCriterion: "Produce a review-paper draft with explicit checks."
    }, ["clawresearch", "research-loop"]);
    run.status = "completed";
    run.stage = "literature_review";
    await runStore.save(run);
    await writeFile(run.artifacts.paperPath, "# Autonomous Research Agents\n\n## Abstract\n\nA draft review paper.\n", "utf8");
    await writeFile(run.artifacts.paperJsonPath, `${JSON.stringify({
      schemaVersion: 1,
      runId: run.id,
      briefFingerprint: "fingerprint",
      title: "Autonomous Research Agents: A technical survey",
      abstract: "A draft review paper.",
      reviewType: "technical_survey",
      structureRationale: "The structure follows the research question.",
      scientificRoles: ["title_and_abstract", "review_method", "limitations", "references"],
      sections: [],
      claims: [
        {
          claimId: "claim-1",
          claim: "Evaluation remains a central open issue.",
          evidence: "The reviewed literature emphasizes evaluation.",
          sourceIds: ["paper-1"]
        }
      ],
      citationLinks: [],
      referencedPaperIds: ["paper-1"],
      evidenceTableIds: [],
      limitations: ["The reviewed set is small."],
      readinessStatus: "needs_more_evidence"
    }, null, 2)}\n`, "utf8");
    await writeFile(run.artifacts.manuscriptChecksPath, `${JSON.stringify({
      schemaVersion: 1,
      runId: run.id,
      paperPath: run.artifacts.paperPath,
      readinessStatus: "needs_more_evidence",
      blockerCount: 0,
      warningCount: 1,
      checks: [
        {
          id: "references-complete",
          title: "References cover cited papers",
          status: "pass",
          severity: "info",
          message: "references.json covers the cited canonical paper IDs."
        }
      ],
      blockers: []
    }, null, 2)}\n`, "utf8");

    const io = createScriptedIo(["/paper", "/paper checks", "/paper open", "/quit"]);
    const backend: IntakeBackend = {
      label: "intake:test",
      async respond(): Promise<IntakeResponse> {
        return {
          assistantMessage: "The saved run already has a paper draft.",
          brief: run.brief,
          readiness: "ready",
          readinessRationale: "The brief is complete.",
          openQuestions: [],
          summary: "Paper command test."
        };
      }
    };

    const exitCode = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.7.0",
      now,
      intakeBackend: backend,
      runController: new FakeRunController(),
      watchRuns: false
    });

    assert.equal(exitCode, 0);
    assert.match(io.output, /Paper:/);
    assert.match(io.output, /readiness: needs_more_evidence/);
    assert.match(io.output, /Paper checks:/);
    assert.match(io.output, /References cover cited papers/);
    assert.match(io.output, /# Autonomous Research Agents/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console explains failed runs before manuscript generation", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-console-paper-failed-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Autonomous research agents",
      researchQuestion: "Why did the run fail before paper generation?",
      researchDirection: "Inspect failure diagnostics.",
      successCriterion: "Paper commands explain the failed stage."
    }, ["clawresearch", "research-loop"]);
    run.status = "failed";
    run.statusMessage = "Run worker failed: extraction recovery budget exhausted";
    run.finishedAt = "2026-01-01T00:00:10.000Z";
    await runStore.save(run);
    await mkdir(run.artifacts.runDirectory, { recursive: true });
    await writeFile(run.artifacts.eventsPath, `${JSON.stringify({
      timestamp: "2026-01-01T00:00:08.000Z",
      kind: "stderr",
      message: "Extraction batch failed (timeout): oversized extraction batch"
    })}\n`, "utf8");
    const failedStatus = {
      schemaVersion: 1,
      runId: run.id,
      artifactKind: "paper",
      status: "failed",
      stage: "literature_review",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
      counts: {},
      error: {
        message: "extraction recovery budget exhausted",
        kind: "stage_blocked",
        operation: "extraction"
      }
    };
    await writeFile(run.artifacts.paperJsonPath, `${JSON.stringify(failedStatus, null, 2)}\n`, "utf8");
    await writeFile(run.artifacts.manuscriptChecksPath, `${JSON.stringify({
      ...failedStatus,
      artifactKind: "manuscript-checks"
    }, null, 2)}\n`, "utf8");

    const io = createScriptedIo(["/paper", "/paper checks", "/quit"]);
    const exitCode = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.7.0",
      now,
      intakeBackend: new StubIntakeBackend(),
      runController: new FakeRunController(),
      watchRuns: false
    });

    assert.equal(exitCode, 0);
    assert.match(io.output, /Paper:/);
    assert.match(io.output, /run status: failed/);
    assert.match(io.output, /readiness: not_started/);
    assert.match(io.output, /no draft reason: Run worker failed: extraction recovery budget exhausted/);
    assert.match(io.output, /Paper checks:/);
    assert.match(io.output, /diagnostic: stage_blocked during extraction/);
    assert.match(io.output, /recent events:/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase two console streams live run progress and reports completion", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-watch-run-"));
  const now = createNow();

  try {
    const io = createScriptedIo([
      "I want to study AI job displacement in nursing homes",
      "/go",
      "/status",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.7.0",
      now,
      intakeBackend: new CompleteProposalBackend(),
      runController: new WatchedFakeRunController(now),
      watchRuns: true,
      watchPollMs: 5
    });

    assert.equal(code, 0);
    assert.match(io.output, /run\s+Research run started\./);
    assert.match(io.output, /watch\s+Streaming live run activity/);
    assert.match(io.output, /plan\s+Plan the research mode and generate initial search queries\./);
    assert.match(io.output, /exec\s+clawresearch research-loop --mode plan-gather-synthesize/);
    assert.match(io.output, /source\s+brief-1: AI adoption and job displacement in nursing homes/);
    assert.match(io.output, /claim\s+Current deployment evidence suggests displacement risk is uneven across role categories/);
    assert.match(io.output, /done\s+Run run-/);
    assert.match(io.output, /status: completed/);
    assert.match(io.output, /events: \.clawresearch\/runs\/run-.*\/events\.jsonl/);

    const sessionPath = path.join(projectRoot, ".clawresearch", "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
      activeRunId: string | null;
      lastRunId: string | null;
    };

    assert.equal(session.activeRunId, null);
    assert.notEqual(session.lastRunId, null);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase two console watcher does not misreport failure when the worker exits just before the final completed state is saved", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-watch-race-"));
  const now = createNow();

  try {
    const io = createScriptedIo([
      "I want to study AI job displacement in nursing homes",
      "/go",
      "/status",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.7.0",
      now,
      intakeBackend: new CompleteProposalBackend(),
      runController: new RaceyWatchedRunController(now),
      watchRuns: true,
      watchPollMs: 5
    });

    assert.equal(code, 0);
    assert.doesNotMatch(io.output, /error\s+Run run-.* failed\./);
    assert.match(io.output, /done\s+Run run-/);
    assert.match(io.output, /status: completed/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console formalizes missing structured fields after the user confirms a drafted brief, even before /go", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-confirmed-draft-"));

  try {
    const io = createScriptedIo([
      "Riemann hypothesis",
      "computational approaches",
      "algorithmic improvements",
      "optimizing existing algorithms",
      "yes",
      "/status",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.7.0",
      now: createNow(),
      intakeBackend: new CompletionFallbackBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /Great! Since you've confirmed the brief aligns with your goals/i);
    assert.match(io.output, /Readiness: ready/);
    assert.match(io.output, /research question: How can existing algorithms used in computational work on the Riemann Hypothesis be optimized to reduce computational complexity\?/);

    const sessionPath = path.join(projectRoot, ".clawresearch", "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
      intake: {
        readiness: string;
      };
      brief: {
        researchQuestion: string | null;
      };
    };

    assert.equal(session.intake.readiness, "ready");
    assert.match(session.brief.researchQuestion ?? "", /reduce computational complexity/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console can complete missing structured fields when the user invokes /go after confirming a draft", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-go-complete-"));

  try {
    const io = createScriptedIo([
      "I want to do research on the riemann hypothesis",
      "I want to have it solved",
      "computational methods",
      "algorithm development",
      "that sounds good",
      "/go",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.5.0",
      now: createNow(),
      intakeBackend: new GoCompletionBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /I can complete the missing brief details from our discussion/i);
    assert.match(io.output, /Research run started\./);
    assert.match(io.output, /Status: queued/);

    const sessionPath = path.join(projectRoot, ".clawresearch", "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
      status: string;
      goCount: number;
      activeRunId: string | null;
      brief: {
        researchQuestion: string;
        successCriterion: string;
      };
    };

    assert.equal(session.status, "ready");
    assert.equal(session.goCount, 1);
    assert.notEqual(session.activeRunId, null);
    assert.match(session.brief.researchQuestion, /algorithmic and computational methods/);
    assert.match(session.brief.successCriterion, /literature-grounded research note/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console can recover a missing structured field from a confirmed draft during /go", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-completion-fallback-"));

  try {
    const io = createScriptedIo([
      "Riemann hypothesis",
      "computational approaches",
      "algorithmic improvements",
      "optimizing existing algorithms",
      "yes",
      "/go",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.6.0",
      now: createNow(),
      intakeBackend: new CompletionFallbackBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /Research run started\./);
    assert.match(io.output, /Status: queued/);

    const sessionPath = path.join(projectRoot, ".clawresearch", "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
      intake: {
        readiness: string;
      };
      brief: {
        researchQuestion: string | null;
      };
      activeRunId: string | null;
    };

    assert.equal(session.intake.readiness, "ready");
    assert.notEqual(session.activeRunId, null);
    assert.match(
      session.brief.researchQuestion ?? "",
      /optimized to reduce computational complexity/i
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("phase one console reframes an over-ambitious complete brief into a bounded first-pass research program", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-reframe-"));

  try {
    const io = createScriptedIo([
      "I want to cure Alzheimer's with AI protein design",
      "/status",
      "/quit"
    ]);

    const code = await runPhaseOneConsole(io, {
      projectRoot,
      version: "0.5.0",
      now: createNow(),
      intakeBackend: new OverambitiousProposalBackend(),
      runController: new FakeRunController()
    });

    assert.equal(code, 0);
    assert.match(io.output, /A better first-pass framing would be/i);
    assert.match(io.output, /identify one tractable evaluation setup/i);
    assert.match(io.output, /research question: What Alzheimer's-related targets and evaluation setups are most tractable for a first-pass study of AI protein-design methods\?/i);
    assert.doesNotMatch(io.output, /Discover a cure for Alzheimer's disease/i);

    const sessionPath = path.join(projectRoot, ".clawresearch", "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
      brief: {
        researchQuestion: string;
        successCriterion: string;
      };
      intake: {
        readiness: string;
      };
    };

    assert.equal(session.intake.readiness, "ready");
    assert.match(session.brief.researchQuestion, /evaluation setups are most tractable/);
    assert.match(session.brief.successCriterion, /bounded next-step plan/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
