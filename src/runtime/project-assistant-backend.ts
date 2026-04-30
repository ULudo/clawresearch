import type { IntakeConversationMessage, IntakeResponse } from "./intake-backend.js";
import {
  ModelCredentialStore,
  type ModelCredentialState,
  ModelRuntimeError,
  RuntimeModelClient
} from "./model-runtime.js";
import {
  resolveRuntimeModelConfig,
  type ProjectConfigState
} from "./project-config-store.js";
import type { ResearchAgenda } from "./research-backend.js";
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
};

export type ProjectFileAction = {
  action: "write_project_file" | "update_project_file" | "append_project_file";
  path: string;
  content: string;
  overwrite?: boolean;
};

export type ProjectAssistantResponse = IntakeResponse & {
  fileActions?: ProjectFileAction[];
};

export interface ProjectAssistantBackend {
  readonly label: string;
  respond(request: ProjectAssistantRequest): Promise<ProjectAssistantResponse>;
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

function safeFileActions(value: unknown): ProjectFileAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): ProjectFileAction[] => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const action = record.action === "write_project_file"
      || record.action === "update_project_file"
      || record.action === "append_project_file"
      ? record.action
      : null;
    const targetPath = safeString(record.path);
    const content = typeof record.content === "string" ? record.content : null;

    if (action === null || targetPath === null || content === null) {
      return [];
    }

    return [{
      action,
      path: targetPath,
      content,
      overwrite: record.overwrite === true
    }];
  }).slice(0, 3);
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

function normalizeResponse(raw: unknown): ProjectAssistantResponse {
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
    summary: safeString(response.summary),
    fileActions: safeFileActions(response.fileActions)
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
    "Be aware of the current run, the latest agenda, and the persistent autonomous research-worker state.",
    "Answer the user's latest question directly using the supplied project context.",
    "If the user asks what happened, summarize what the latest run segment did, what the result was, and whether remaining work is internal, release-ready, or externally blocked.",
    "Do not pretend an implementation or experiment succeeded if the run only produced a literature review, agenda, or status report.",
    "If the user asks to modify the topic, research question, research direction, success criterion, or otherwise change the project scope, update the structured brief accordingly.",
    "If the user changes the brief materially, mention that the current saved results may reflect the older brief and that running `/go` again is appropriate.",
    "If the user clearly asks you to create, write, append, or update a normal project Markdown/text file, include a fileActions entry. Do not merely give pasteable text.",
    "Only write ordinary project notes, docs, reports, or Markdown summaries. Do not write credentials, secrets, .env files, model credential stores, lock files, or internal runtime state.",
    "For file creation, use write_project_file. For replacing an existing user-facing note/report, use update_project_file with overwrite true. For adding to an existing note, use append_project_file.",
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
    '  "summary": "string or null",',
    '  "fileActions": [',
    '    { "action": "write_project_file|update_project_file|append_project_file", "path": "relative/project/path.md", "content": "complete file or appended text", "overwrite": false }',
    "  ]",
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Current brief: ${JSON.stringify(request.brief)}`,
    `Open questions: ${JSON.stringify(request.openQuestions)}`,
    `Current run: ${JSON.stringify(request.currentRun)}`,
    `Latest agenda: ${JSON.stringify(request.latestAgenda)}`,
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

export class OpenAIResponsesProjectAssistantBackend implements ProjectAssistantBackend {
  readonly label: string;

  constructor(private readonly client: RuntimeModelClient) {
    this.label = client.label;
  }

  async respond(request: ProjectAssistantRequest): Promise<IntakeResponse> {
    try {
      const raw = await this.client.jsonCall(
        [
          buildInstruction(request),
          "",
          ...request.conversation.map((message) => `${message.role}: ${message.content}`)
        ].join("\n"),
        {
          operation: "project_assistant",
          timeoutMs: 90_000
        }
      );

      return normalizeResponse(raw);
    } catch (error) {
      if (error instanceof ModelRuntimeError) {
        throw new Error(error.message);
      }

      throw error;
    }
  }
}

export function createDefaultProjectAssistantBackend(): ProjectAssistantBackend {
  return new OllamaProjectAssistantBackend();
}

export async function createProjectAssistantBackend(params: {
  projectRoot: string;
  projectConfig: ProjectConfigState;
  timestampFactory?: () => string;
}): Promise<ProjectAssistantBackend> {
  const runtimeModel = resolveRuntimeModelConfig(params.projectConfig);

  if (runtimeModel.provider === "ollama") {
    return new OllamaProjectAssistantBackend(runtimeModel.host ?? defaultHost, runtimeModel.model);
  }

  const credentialStore = new ModelCredentialStore(params.projectRoot, params.timestampFactory);
  const credentials: ModelCredentialState = await credentialStore.load();
  return new OpenAIResponsesProjectAssistantBackend(
    new RuntimeModelClient(runtimeModel, credentials, credentialStore)
  );
}
