import type { IntakeConversationMessage, IntakeResponse } from "./intake-backend.js";
import type { WorkPackageDecisionRecord, WorkPackageFinding } from "./research-agenda.js";
import type { ResearchAgenda, WorkPackage } from "./research-backend.js";
import type { RunStage, RunStatus } from "./run-store.js";
import type { ResearchBrief } from "./session-store.js";

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
};

const defaultHost = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const defaultModel = process.env.CLAWRESEARCH_OLLAMA_MODEL ?? "qwen3:14b";
const placeholderValuePattern = /^(?:string(?:\s+or\s+null)?|null|n\/a|tbd|unknown)$/i;

export type ProjectAssistantRunContext = {
  id: string;
  stage: RunStage;
  status: RunStatus;
  statusMessage: string | null;
  briefMatchesCurrent: boolean;
  recentEvents: string[];
  summaryMarkdown: string | null;
};

export type ProjectAssistantRequest = {
  mode: "start" | "resume" | "continue";
  projectRoot: string;
  brief: ResearchBrief;
  openQuestions: string[];
  conversation: IntakeConversationMessage[];
  currentRun: ProjectAssistantRunContext | null;
  latestAgenda: ResearchAgenda | null;
  latestWorkPackage: WorkPackage | null;
  latestDecision: WorkPackageDecisionRecord | null;
  latestFindings: WorkPackageFinding[];
};

export interface ProjectAssistantBackend {
  readonly label: string;
  respond(request: ProjectAssistantRequest): Promise<IntakeResponse>;
}

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, "");
}

function safeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || placeholderValuePattern.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => safeString(entry))
    .filter((entry): entry is string => entry !== null)
    .slice(0, 4);
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model did not return JSON.");
    }

    return JSON.parse(text.slice(start, end + 1));
  }
}

function normalizeResponse(raw: unknown): IntakeResponse {
  const response = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const brief = typeof response.brief === "object" && response.brief !== null
    ? response.brief as Record<string, unknown>
    : {};

  return {
    assistantMessage: safeString(response.assistantMessage)
      ?? "I can walk you through the current run, summarize the latest result, or adjust the research direction if you want to change course.",
    brief: {
      topic: safeString(brief.topic),
      researchQuestion: safeString(brief.researchQuestion),
      researchDirection: safeString(brief.researchDirection),
      successCriterion: safeString(brief.successCriterion)
    },
    readiness: response.readiness === "ready" ? "ready" : "needs_clarification",
    readinessRationale: safeString(response.readinessRationale),
    openQuestions: safeStringArray(response.openQuestions),
    summary: safeString(response.summary)
  };
}

function buildInstruction(request: ProjectAssistantRequest): string {
  const modeInstruction = {
    start: "Briefly orient the user to the current project state and invite the next concrete question or instruction.",
    resume: "Resume naturally from the saved context, grounding your reply in the latest project state rather than re-running intake.",
    continue: "Answer the user's latest message directly and ground it in the current project state."
  }[request.mode];

  return [
    "You are ClawResearch's ongoing research assistant.",
    "You are not the startup intake consultant anymore.",
    "You are helping inside an active local research project after or during runs.",
    "Be aware of the current run, the latest agenda, the selected work package, and any execution decision or blockers.",
    "Answer the user's latest question directly using the supplied project context.",
    "If the user asks what happened, summarize what the latest run did, what the result was, and what the next planned step is.",
    "If the latest work-package decision is blocked, revise, or return-to-agenda, say that plainly.",
    "Do not pretend an implementation or experiment succeeded if the run only reached planning, inspection, or a blocked decision.",
    "If the user asks to modify the topic, research question, research direction, success criterion, or otherwise change the project scope, update the structured brief accordingly.",
    "If the user changes the brief materially, mention that the current saved results may reflect the older brief and that running `/go` again is appropriate.",
    "Preserve still-valid brief fields. Only clear a field if the new user request truly invalidates it.",
    "Keep the answer concise, warm, practical, and terminal-friendly.",
    "Ask at most one follow-up question only when it is genuinely necessary.",
    modeInstruction,
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "assistantMessage": "string",',
    '  "brief": {',
    '    "topic": "string or null",',
    '    "researchQuestion": "string or null",',
    '    "researchDirection": "string or null",',
    '    "successCriterion": "string or null"',
    "  },",
    '  "readiness": "needs_clarification or ready",',
    '  "readinessRationale": "string or null",',
    '  "openQuestions": ["string"],',
    '  "summary": "string or null"',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Current brief: ${JSON.stringify(request.brief)}`,
    `Open questions: ${JSON.stringify(request.openQuestions)}`,
    `Current run: ${JSON.stringify(request.currentRun)}`,
    `Latest agenda: ${JSON.stringify(request.latestAgenda)}`,
    `Latest work package: ${JSON.stringify(request.latestWorkPackage)}`,
    `Latest decision: ${JSON.stringify(request.latestDecision)}`,
    `Latest findings: ${JSON.stringify(request.latestFindings)}`,
    "",
    "Conversation so far follows below in chat-message order."
  ].join("\n");
}

export class OllamaProjectAssistantBackend implements ProjectAssistantBackend {
  readonly label: string;

  constructor(
    private readonly host = defaultHost,
    private readonly model = defaultModel
  ) {
    this.label = `ollama:${this.model}`;
  }

  async respond(request: ProjectAssistantRequest): Promise<IntakeResponse> {
    const response = await fetch(`http://${normalizeHost(this.host)}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        format: "json",
        messages: [
          {
            role: "system",
            content: buildInstruction(request)
          },
          ...request.conversation.map((message) => ({
            role: message.role,
            content: message.content
          }))
        ]
      }),
      signal: AbortSignal.timeout(90_000)
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as OllamaChatResponse;
    const content = payload.message?.content;

    if (typeof content !== "string") {
      throw new Error("Ollama returned an unexpected response.");
    }

    return normalizeResponse(extractJson(content));
  }
}

export function createDefaultProjectAssistantBackend(): ProjectAssistantBackend {
  return new OllamaProjectAssistantBackend();
}
