import type { ConversationRole, ResearchBrief } from "./session-store.js";

export type IntakeConversationMessage = {
  role: ConversationRole;
  content: string;
};

export type IntakeResponse = {
  assistantMessage: string;
  brief: ResearchBrief;
  readiness: "needs_clarification" | "ready";
  readinessRationale: string | null;
  openQuestions: string[];
  summary: string | null;
};

export type IntakeRequest = {
  mode: "start" | "resume" | "continue" | "recover";
  projectRoot: string;
  brief: ResearchBrief;
  openQuestions: string[];
  conversation: IntakeConversationMessage[];
  recoveryReason?: string;
};

export interface IntakeBackend {
  readonly label: string;
  respond(request: IntakeRequest): Promise<IntakeResponse>;
  completeBrief?(request: IntakeRequest): Promise<ResearchBrief>;
}

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
};

const defaultHost = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const defaultModel = process.env.CLAWRESEARCH_OLLAMA_MODEL ?? "qwen3:14b";
const placeholderValuePattern = /^(?:string(?:\s+or\s+null)?|null|n\/a|tbd|unknown)$/i;

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, "");
}

function buildInstruction(request: IntakeRequest): string {
  const modeInstruction = {
    start: "Introduce yourself briefly as ClawResearch's research intake consultant, then ask the most useful first question.",
    resume: "Resume the intake chat naturally from the saved context, briefly re-orient the user if helpful, and ask the next best clarifying question.",
    continue: "Respond to the user and keep driving toward a strong research brief.",
    recover: "The conversation is getting stuck. Stop repeating clarifications. If there is enough signal, draft the best working brief you can from the existing context, state reasonable assumptions implicitly in the brief, and ask the user to confirm or correct it. If a strong full draft already exists, preserve that wording unless you are making it more concrete or more realistically bounded. If there is still not enough signal, ask exactly one high-leverage next question tailored to the topic."
  }[request.mode];

  return [
    "You are ClawResearch's startup intake assistant.",
    "Act like a thoughtful research consultant receiving a project brief from a stakeholder or client in a terminal chat.",
    "Your job is to clarify the research goal until the brief is usable.",
    "Keep the assistant message concise, warm, and practical.",
    "Ask at most two questions at a time.",
    "The structured brief extraction is internal. Do not say things like 'captured topic', 'next up', or otherwise expose hidden form fields.",
    "The user experience should feel like one fluent consultant conversation, not like a questionnaire or slot-filling form.",
    "Do not treat greetings, chit-chat, or checks like 'can you hear me?' as a topic.",
    "Do not fill fields just because the user said something vague.",
    "Only set a field when the conversation gives enough signal.",
    "For every turn, return the best current value for each field, or null if it is still unclear.",
    "Never replace a specific field with a vaguer version.",
    "If you present a draft or proposed brief, the `brief` object must match that proposal closely. Do not show a richer brief in `assistantMessage` than you store in `brief`.",
    "Do not repeat the same clarification question if the user has already answered or objected to it.",
    "If the user says you already asked that, acknowledge it and move to a different narrowing strategy.",
    "A success criterion should be concrete and testable whenever possible.",
    "A research direction should describe the intended investigation strategy, not filler.",
    "Use the whole conversation and current brief, not just the last line.",
    "If the user is broad or uncertain, help them narrow the project by suggesting a small number of concrete directions or scopes.",
    "If the user frames the goal as a major breakthrough, final solution, or other end-state achievement, do not stay in that framing. Translate it into a bounded and realistic first-pass research program such as literature mapping, evaluation of existing approaches, exploratory experimentation, replication, or a narrower subproblem.",
    "Do not use direct end-state achievements like solving the full problem, proving the hypothesis, curing the disease, or fully automating the domain as the success criterion unless the conversation truly provides a realistic bounded path.",
    "If you can state a complete, usable first-pass brief, mark `readiness` as `ready` even if you also invite the user to refine or adjust it.",
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
    `Current open questions: ${JSON.stringify(request.openQuestions)}`,
    request.recoveryReason !== undefined ? `Completion hint: ${request.recoveryReason}` : null,
    "",
    "Conversation so far follows below in chat-message order."
  ].filter((line): line is string => line !== null).join("\n");
}

function buildBriefCompletionInstruction(request: IntakeRequest): string {
  return [
    "You are ClawResearch's structured brief completion helper.",
    "Your only job is to infer any missing brief fields from the existing conversation.",
    "Use the whole conversation, not just the last turn.",
    "If the user has already confirmed a drafted brief or direction, convert that confirmed intent into concrete brief fields.",
    "Do not ask follow-up questions.",
    "Do not add ambitious claims that are not supported by the conversation.",
    "Keep existing specific wording when possible, but make missing fields concrete enough for a bounded first-pass research run.",
    "Only leave a field null if the conversation truly does not provide enough signal.",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "topic": "string or null",',
    '  "researchQuestion": "string or null",',
    '  "researchDirection": "string or null",',
    '  "successCriterion": "string or null"',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Current brief: ${JSON.stringify(request.brief)}`,
    `Current open questions: ${JSON.stringify(request.openQuestions)}`,
    request.recoveryReason !== undefined ? `Completion hint: ${request.recoveryReason}` : null,
    "",
    "Conversation so far follows below in chat-message order."
  ].filter((line): line is string => line !== null).join("\n");
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

function normalizeResponse(raw: unknown): IntakeResponse {
  const response = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const brief = typeof response.brief === "object" && response.brief !== null
    ? response.brief as Record<string, unknown>
    : {};

  return {
    assistantMessage: safeString(response.assistantMessage)
      ?? "Tell me a bit more about the research project and what a successful outcome should look like.",
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

function normalizeBrief(raw: unknown): ResearchBrief {
  const brief = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};

  return {
    topic: safeString(brief.topic),
    researchQuestion: safeString(brief.researchQuestion),
    researchDirection: safeString(brief.researchDirection),
    successCriterion: safeString(brief.successCriterion)
  };
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

export class OllamaIntakeBackend implements IntakeBackend {
  readonly label: string;

  constructor(
    private readonly host = defaultHost,
    private readonly model = defaultModel
  ) {
    this.label = `ollama:${this.model}`;
  }

  async respond(request: IntakeRequest): Promise<IntakeResponse> {
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

  async completeBrief(request: IntakeRequest): Promise<ResearchBrief> {
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
            content: buildBriefCompletionInstruction(request)
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

    return normalizeBrief(extractJson(content));
  }
}

export function createDefaultIntakeBackend(): IntakeBackend {
  return new OllamaIntakeBackend();
}
