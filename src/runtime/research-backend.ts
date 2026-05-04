import type { ResearchBrief } from "./session-store.js";
import type { ResearchWorkerState } from "./research-state.js";
import type { ProjectMemoryContext } from "./memory-store.js";
import type {
  LiteratureContext
} from "./literature-store.js";
import {
  normalizeResearchActionDecision,
  type ResearchAgentControlMode,
  type ResearchActionDecision,
  type ResearchActionRequest
} from "./research-agent.js";
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

export type {
  EvidenceMatrix,
  EvidenceMatrixInsight,
  EvidenceMatrixInsightKind,
  EvidenceMatrixRow,
  PaperClaimSupportStrength,
  PaperExtraction
} from "./research-evidence.js";

const defaultHost = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const defaultModel = process.env.CLAWRESEARCH_OLLAMA_MODEL ?? "qwen3:14b";

export type ResearchMode =
  | "literature_synthesis"
  | "replication"
  | "benchmarking"
  | "ablation"
  | "method_improvement"
  | "new_hypothesis";

export type ResearchPlan = {
  researchMode: ResearchMode;
  objective: string;
  rationale: string;
  searchQueries: string[];
  localFocus: string[];
};

export type ResearchTheme = {
  title: string;
  summary: string;
  sourceIds: string[];
};

export type ResearchClaim = {
  claim: string;
  evidence: string;
  sourceIds: string[];
};

export type ResearchGapKind =
  | "missing_baseline"
  | "confounder"
  | "coverage_gap"
  | "method_gap"
  | "evidence_conflict";

export type ResearchGapSeverity =
  | "low"
  | "medium"
  | "high";

export type DirectionScores = {
  evidenceBase: number;
  novelty: number;
  tractability: number;
  expectedCost: number;
  risk: number;
  overall: number;
};

export type ResearchGap = {
  id: string;
  title: string;
  summary: string;
  sourceIds: string[];
  claimIds: string[];
  severity: ResearchGapSeverity;
  gapKind: ResearchGapKind;
};

export type ResearchDirectionCandidate = {
  id: string;
  title: string;
  summary: string;
  mode: ResearchMode;
  whyNow: string;
  sourceIds: string[];
  claimIds: string[];
  gapIds: string[];
  scores: DirectionScores;
};

export type ResearchAgenda = {
  executiveSummary: string;
  gaps: ResearchGap[];
  candidateDirections: ResearchDirectionCandidate[];
  selectedDirectionId: string | null;
  selectedWorkPackage: null;
  holdReasons: string[];
  recommendedHumanDecision: string;
};

export type ResearchSynthesis = {
  executiveSummary: string;
  themes: ResearchTheme[];
  claims: ResearchClaim[];
  nextQuestions: string[];
};

export type ResearchPlanningRequest = {
  projectRoot: string;
  brief: ResearchBrief;
  localFiles: string[];
  memoryContext: ProjectMemoryContext;
  literatureContext?: LiteratureContext;
  workerState?: ResearchWorkerState | null;
};

export type ResearchBackendOperation =
  | "planning"
  | "agent_step"
  | "critic";

export type ResearchBackendCallOptions = {
  operation: ResearchBackendOperation;
  timeoutMs: number;
  agentControlMode?: ResearchAgentControlMode;
};

export type ResearchBackendCapabilities = {
  actionControl: {
    nativeToolCalls: boolean;
    strictJsonFallback: boolean;
  };
};

export type ResearchBackendFailureKind =
  | "timeout"
  | "malformed_json"
  | "http"
  | "unexpected";

export class ResearchBackendError extends Error {
  constructor(
    public readonly kind: ResearchBackendFailureKind,
    public readonly operation: ResearchBackendOperation,
    message: string,
    public readonly timeoutMs: number | null = null
  ) {
    super(message);
    this.name = "ResearchBackendError";
  }
}

function researchBackendErrorFromModelError(error: ModelRuntimeError): ResearchBackendError {
  const kind = error.kind === "auth" ? "http" : error.kind;
  return new ResearchBackendError(
    kind,
    error.operation as ResearchBackendOperation,
    error.message,
    error.timeoutMs
  );
}

async function modelJsonCall<T>(
  client: RuntimeModelClient,
  systemPrompt: string,
  options: ResearchBackendCallOptions
): Promise<T> {
  try {
    return await client.jsonCall(systemPrompt, options) as T;
  } catch (error) {
    if (error instanceof ModelRuntimeError) {
      throw researchBackendErrorFromModelError(error);
    }

    throw error;
  }
}

export interface ResearchBackend {
  readonly label: string;
  readonly capabilities?: ResearchBackendCapabilities;
  planResearch(request: ResearchPlanningRequest, options?: ResearchBackendCallOptions): Promise<ResearchPlan>;
  chooseResearchAction(request: ResearchActionRequest, options?: ResearchBackendCallOptions): Promise<ResearchActionDecision>;
}

type OllamaToolCall = {
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type OllamaChatResponse = {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
};

type OllamaStreamChunk = {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
};

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, "");
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function hashString(text: string): string {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function safeStringArray(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => safeString(entry))
    .filter((entry): entry is string => entry !== null)
    .slice(0, limit);
}

function safeResearchMode(value: unknown): ResearchMode | null {
  switch (value) {
    case "literature_synthesis":
    case "replication":
    case "benchmarking":
    case "ablation":
    case "method_improvement":
    case "new_hypothesis":
      return value;
    default:
      return null;
  }
}

function parseOllamaContent(rawResponseText: string): string | null {
  try {
    const payload = JSON.parse(rawResponseText) as OllamaChatResponse;
    return typeof payload.message?.content === "string" ? payload.message.content : null;
  } catch {
    // Fall through to Ollama's streaming NDJSON shape.
  }

  let content = "";

  for (const line of rawResponseText.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    try {
      const payload = JSON.parse(trimmed) as OllamaStreamChunk;
      if (typeof payload.message?.content === "string") {
        content += payload.message.content;
      }
    } catch {
      // Ignore incomplete/diagnostic stream lines; malformed final JSON is
      // handled by extractJson after all model content is assembled.
    }
  }

  return content.length > 0 ? content : null;
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

function normalizePlan(raw: unknown, brief: ResearchBrief): ResearchPlan {
  const record = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const fallbackTopic = brief.topic ?? "the requested project";
  const fallbackQuestion = brief.researchQuestion ?? `What is the most useful first-pass research framing for ${fallbackTopic}?`;

  return {
    researchMode: safeResearchMode(record.researchMode) ?? "literature_synthesis",
    objective: safeString(record.objective) ?? fallbackQuestion,
    rationale: safeString(record.rationale) ?? "Begin with a bounded literature-grounded pass before making stronger claims.",
    searchQueries: safeStringArray(record.searchQueries, 5).length > 0
      ? safeStringArray(record.searchQueries, 5)
      : [fallbackTopic, fallbackQuestion],
    localFocus: safeStringArray(record.localFocus, 5)
  };
}

function planningInstruction(request: ResearchPlanningRequest): string {
  const literatureContext = request.literatureContext ?? {
    available: false,
    paperCount: 0,
    themeCount: 0,
    notebookCount: 0,
    papers: [],
    themes: [],
    notebooks: [],
    queryHints: []
  };

  return [
    "You are ClawResearch's planning module for a console-first autonomous research runtime.",
    "Plan a bounded first-pass research mode using the brief and local project context.",
    "Use the project memory when it is relevant so the next pass builds on prior findings, open questions, useful ideas, and existing artifacts instead of starting from scratch.",
    "Ground the plan in the following design principles:",
    "- choose a research mode explicitly",
    "- prefer bounded literature-grounded work over overclaiming",
    "- keep the objective specific and debuggable",
    "- produce search queries that are likely to retrieve useful sources",
    "- use the project directory context when relevant",
    "",
    "Allowed researchMode values:",
    "- literature_synthesis",
    "- replication",
    "- benchmarking",
    "- ablation",
    "- method_improvement",
    "- new_hypothesis",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "researchMode": "string",',
    '  "objective": "string",',
    '  "rationale": "string",',
    '  "searchQueries": ["string"],',
    '  "localFocus": ["string"]',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Local files: ${JSON.stringify(request.localFiles.slice(0, 20))}`,
    `Project memory context: ${JSON.stringify(request.memoryContext)}`,
    `Literature memory context: ${JSON.stringify(literatureContext)}`,
    `Autonomous worker state: ${JSON.stringify(request.workerState ?? null)}`,
    "If autonomous worker state contains nextInternalActions, continue those machine-actionable research actions unless the brief has materially changed or an external blocker prevents progress."
  ].join("\n");
}

function agentStepInstruction(request: ResearchActionRequest): string {
  const criticSummaries = request.criticReports.map((report) => ({
    stage: report.stage,
    readiness: report.readiness,
    confidence: report.confidence,
    objections: report.objections.map((objection) => ({
      code: objection.code,
      severity: objection.severity,
      target: objection.target,
      message: objection.message,
      suggestedRevision: objection.suggestedRevision
    })),
    revisionAdvice: report.revisionAdvice
  }));

  return [
    "You are ClawResearch's research-agent controller.",
    "Choose exactly one next tool operation from the allowed tool list.",
    "Do not invent tool names. Do not execute the action yourself. The runtime will validate and execute the chosen action.",
    "The phase value is only a milestone/progress label. It must not limit your tool choice.",
    "Use workspace.search/read/list/create/patch/link/unlink to inspect or update the durable SQLite research workspace.",
    "Use source.search, source.merge, source.resolve_access, and source.select_evidence for source discovery and evidence-set construction.",
    "Use claim.create/patch/check_support/link_support for claim-led synthesis.",
    "Use section.create/read/patch/link_claim/check_claims for section-level writing.",
    "Use work_item.create/patch when critic or check feedback becomes actionable research debt.",
    "Use guidance.search/read/recommend to inspect advisory research-lab scaffolding. Guidance is not a gate and may be overridden.",
    "Use protocol.create_or_revise when the research protocol itself needs visible revision by the researcher.",
    "Use critic.review for fresh stateless critique, and check.run for release/support checks.",
    "Use release.verify for final computable release invariants; semantic concerns should become diagnostics or work items.",
    "Critic objections and checks are normal work-store work items. Prefer concrete tool steps over stopping.",
    "Recent tool results are authoritative observations from executed tools. Use returned ids, snippets, and previews before repeating the same read action.",
    "Use workspace.status only when the next step is genuinely external to the agent, unsafe, or impossible with the configured tools.",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "action": "one allowed action",',
    '  "rationale": "why this is the best next action",',
    '  "confidence": 0.0,',
    '  "inputs": {',
    '    "providerIds": ["provider ids to query next, e.g. openalex, arxiv"],',
    '    "searchQueries": ["only if revising/searching"],',
    '    "evidenceTargets": ["missing evidence targets"],',
    '    "paperIds": ["known paper ids only"],',
    '    "criticScope": "protocol|sources|evidence|release|null",',
    '    "reason": "short status reason or null",',
    '    "workStore": {',
    '      "collection": "workItems|canonicalSources|extractions|claims|citations|manuscriptSections|releaseChecks|null",',
    '      "entityId": "known entity id or null",',
    '      "filters": {},',
    '      "filterJson": "{\\"field\\":\\"simple exact match value\\"} or null",',
    '      "semanticQuery": "short query or null",',
    '      "limit": 12,',
    '      "cursor": "pagination cursor from a previous tool result or null",',
    '      "changes": {},',
    '      "entity": {},',
    '      "patchJson": "{\\"field\\":\\"patch value\\"} or null",',
    '      "payloadJson": "{\\"kind\\":\\"workItem\\",\\"title\\":\\"optional new work item\\"} or null",',
    '      "link": { "fromCollection": "claims", "fromId": "claim id", "toCollection": "canonicalSources", "toId": "source id", "relation": "supports", "snippet": "optional provenance snippet" }',
    "    }",
    "  },",
    '  "expectedOutcome": "checkpoint/result expected from the action",',
    '  "stopCondition": "when the runtime should stop this action"',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Run id: ${request.runId}`,
    `Phase: ${request.phase}`,
    `Attempt: ${request.attempt}/${request.maxAttempts}`,
    `Allowed actions: ${request.allowedActions.join(", ")}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Plan: ${JSON.stringify(request.plan)}`,
    `Observations: ${JSON.stringify(request.observations)}`,
    `Source state: ${JSON.stringify(request.sourceState ?? null)}`,
    `Work store: ${JSON.stringify(request.workStore ?? null)}`,
    `Guidance: ${JSON.stringify(request.guidance ?? null)}`,
    `Recent tool results: ${JSON.stringify(request.toolResults ?? [])}`,
    `Critic reports: ${JSON.stringify(criticSummaries)}`,
    request.retryInstruction === undefined ? "Retry instruction: null" : `Retry instruction: ${request.retryInstruction}`
  ].join("\n");
}

async function ollamaChatRaw(
  host: string,
  body: Record<string, unknown>,
  options: ResearchBackendCallOptions
): Promise<string> {
  let response: Response;
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const refreshIdleTimer = (): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs);
  };

  const readBody = async (): Promise<string> => {
    if (response.body === null) {
      return response.text();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (true) {
      const result = await reader.read();
      if (result.done) {
        text += decoder.decode();
        break;
      }

      refreshIdleTimer();
      text += decoder.decode(result.value, { stream: true });
    }

    return text;
  };

  try {
    refreshIdleTimer();
    response = await fetch(`http://${normalizeHost(host)}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    clearIdleTimer();
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";

    if (controller.signal.aborted || /timeout/i.test(name) || /timeout|aborted/i.test(message)) {
      throw new ResearchBackendError(
        "timeout",
        options.operation,
        `${options.operation} model call had no provider activity for ${options.timeoutMs} ms`,
        options.timeoutMs
      );
    }

    throw new ResearchBackendError(
      "unexpected",
      options.operation,
      `${options.operation} model call failed: ${message}`,
      options.timeoutMs
    );
  }

  if (!response.ok) {
    clearIdleTimer();
    throw new ResearchBackendError(
      "http",
      options.operation,
      `Ollama ${options.operation} request failed with ${response.status} ${response.statusText}`,
      options.timeoutMs
    );
  }

  let rawResponseText: string;

  try {
    refreshIdleTimer();
    rawResponseText = await readBody();
  } catch (error) {
    clearIdleTimer();
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";

    if (controller.signal.aborted || /timeout/i.test(name) || /timeout|aborted/i.test(message)) {
      throw new ResearchBackendError(
        "timeout",
        options.operation,
        `${options.operation} model call had no provider activity for ${options.timeoutMs} ms`,
        options.timeoutMs
      );
    }

    throw new ResearchBackendError(
      "unexpected",
      options.operation,
      `${options.operation} model response could not be read: ${message}`,
      options.timeoutMs
    );
  } finally {
    clearIdleTimer();
  }

  return rawResponseText;
}

async function ollamaJsonCall<T>(
  host: string,
  model: string,
  systemPrompt: string,
  options: ResearchBackendCallOptions
): Promise<T> {
  const rawResponseText = await ollamaChatRaw(
    host,
    {
      model,
      stream: true,
      think: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: systemPrompt
        }
      ]
    },
    options
  );
  const content = parseOllamaContent(rawResponseText);

  if (typeof content !== "string") {
    throw new ResearchBackendError(
      "unexpected",
      options.operation,
      `Ollama ${options.operation} request returned an unexpected response.`,
      options.timeoutMs
    );
  }

  try {
    return extractJson(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResearchBackendError(
      "malformed_json",
      options.operation,
      `Ollama ${options.operation} response was not valid JSON: ${message}`,
      options.timeoutMs
    );
  }
}

const researchActionToolName = "choose_research_action";

function researchActionToolDefinition(request: ResearchActionRequest): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: researchActionToolName,
      description: "Choose exactly one validated next workspace tool operation for the ClawResearch runtime. The runtime executes the operation after validating it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: request.allowedActions,
            description: "The single next workspace tool operation the runtime should execute."
          },
          rationale: {
            type: "string",
            description: "Brief reason this action is the best next step."
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1
          },
          inputs: {
            type: "object",
            additionalProperties: false,
            properties: {
              searchQueries: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              providerIds: {
                type: "array",
                items: request.sourceState?.availableProviderIds === undefined
                  ? { type: "string" }
                  : {
                    type: "string",
                    enum: request.sourceState.availableProviderIds
                  }
              },
              evidenceTargets: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              paperIds: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              criticScope: {
                type: ["string", "null"],
                enum: ["protocol", "sources", "evidence", "release", null]
              },
              reason: {
                type: ["string", "null"]
              },
              workStore: {
                type: "object",
                additionalProperties: false,
                properties: {
                  collection: {
                    type: ["string", "null"],
                    enum: [
                      "providerRuns",
                      "sources",
                      "canonicalSources",
                      "screeningDecisions",
                      "fullTextRecords",
                      "extractions",
                      "evidenceCells",
                      "claims",
                      "citations",
                      "workItems",
                      "manuscriptSections",
                      "releaseChecks",
                      null
                    ]
                  },
                  entityId: {
                    type: ["string", "null"]
                  },
                  filters: {
                    type: "object",
                    additionalProperties: false,
                    properties: {}
                  },
                  filterJson: {
                    type: ["string", "null"],
                    description: "Optional JSON object string for exact-match filters."
                  },
                  semanticQuery: {
                    type: ["string", "null"]
                  },
                  limit: {
                    type: ["number", "null"]
                  },
                  cursor: {
                    type: ["string", "null"],
                    description: "Optional pagination cursor from a previous workspace list/search result."
                  },
                  changes: {
                    type: "object",
                    additionalProperties: false,
                    properties: {}
                  },
                  entity: {
                    type: "object",
                    additionalProperties: false,
                    properties: {}
                  },
                  patchJson: {
                    type: ["string", "null"],
                    description: "Optional JSON object string for patch fields."
                  },
                  payloadJson: {
                    type: ["string", "null"],
                    description: "Optional JSON object string for create payload fields."
                  },
                  link: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      fromCollection: {
                        type: ["string", "null"]
                      },
                      fromId: {
                        type: ["string", "null"]
                      },
                      toCollection: {
                        type: ["string", "null"]
                      },
                      toId: {
                        type: ["string", "null"]
                      },
                      relation: {
                        type: ["string", "null"]
                      },
                      snippet: {
                        type: ["string", "null"]
                      }
                    },
                    required: ["fromCollection", "fromId", "toCollection", "toId", "relation", "snippet"]
                  }
                },
                required: ["collection", "entityId", "filters", "filterJson", "semanticQuery", "limit", "cursor", "changes", "entity", "patchJson", "payloadJson", "link"]
              }
            },
            required: ["providerIds", "searchQueries", "evidenceTargets", "paperIds", "criticScope", "reason", "workStore"]
          },
          expectedOutcome: {
            type: "string"
          },
          stopCondition: {
            type: "string"
          }
        },
        required: ["action", "rationale", "confidence", "inputs", "expectedOutcome", "stopCondition"]
      }
    }
  };
}

function responseResearchActionToolDefinition(request: ResearchActionRequest): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  const definition = researchActionToolDefinition(request);
  const fn = typeof definition.function === "object" && definition.function !== null
    ? definition.function as Record<string, unknown>
    : {};
  const name = safeString(fn.name) ?? researchActionToolName;
  const description = safeString(fn.description)
    ?? "Choose exactly one validated next action for the ClawResearch runtime.";
  const parameters = typeof fn.parameters === "object" && fn.parameters !== null
    ? fn.parameters as Record<string, unknown>
    : {};

  return {
    name,
    description,
    parameters
  };
}

function nativeAgentStepInstruction(request: ResearchActionRequest): string {
  return [
    "You are ClawResearch's research-agent controller.",
    `Call ${researchActionToolName} exactly once.`,
    "Do not answer in prose. Do not invent tools. The runtime validates and executes the chosen action.",
    "The phase value is only a milestone/progress label. It must not limit your tool choice.",
    "Use workspace.search/read/list/create/patch/link/unlink to inspect or update the durable SQLite research workspace.",
    "Use source.search, source.merge, source.resolve_access, and source.select_evidence for source discovery and evidence-set construction.",
    "Use claim.create/patch/check_support/link_support for claim-led synthesis.",
    "Use section.create/read/patch/link_claim/check_claims for section-level writing.",
    "Use work_item.create/patch when critic or check feedback becomes actionable research debt.",
    "Use guidance.search/read/recommend to inspect advisory research-lab scaffolding. Guidance is not a gate and may be overridden.",
    "Use protocol.create_or_revise when the research protocol itself needs visible revision by the researcher.",
    "Use critic.review for fresh stateless critique, and check.run for release/support checks.",
    "Use release.verify for final computable release invariants; semantic concerns should become diagnostics or work items.",
    "Critic objections and checks are normal work-store work items. Prefer concrete tool steps over stopping.",
    "Recent tool results are authoritative observations from executed tools. Use returned ids, snippets, and previews before repeating the same read action.",
    "Use workspace.status only when the next step is genuinely external to the agent, unsafe, or impossible with the configured tools.",
    "",
    `Project root: ${request.projectRoot}`,
    `Run id: ${request.runId}`,
    `Phase: ${request.phase}`,
    `Attempt: ${request.attempt}/${request.maxAttempts}`,
    `Allowed actions: ${request.allowedActions.join(", ")}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Plan: ${JSON.stringify(request.plan)}`,
    `Observations: ${JSON.stringify(request.observations)}`,
    `Source state: ${JSON.stringify(request.sourceState ?? null)}`,
    `Work store: ${JSON.stringify(request.workStore ?? null)}`,
    `Guidance: ${JSON.stringify(request.guidance ?? null)}`,
    `Recent tool results: ${JSON.stringify(request.toolResults ?? [])}`,
    `Critic reports: ${JSON.stringify(request.criticReports.map((report) => ({
      stage: report.stage,
      readiness: report.readiness,
      confidence: report.confidence,
      objections: report.objections.map((objection) => ({
        code: objection.code,
        severity: objection.severity,
        target: objection.target,
        message: objection.message,
        suggestedRevision: objection.suggestedRevision
      })),
      revisionAdvice: report.revisionAdvice
    })))}`,
    request.retryInstruction === undefined ? "Retry instruction: null" : `Retry instruction: ${request.retryInstruction}`
  ].join("\n");
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value === "string") {
    return extractJson(value);
  }

  return value;
}

function extractNativeToolArguments(rawResponseText: string, toolName: string): unknown | null {
  let payload: OllamaChatResponse | null = null;

  try {
    payload = JSON.parse(rawResponseText) as OllamaChatResponse;
  } catch {
    return null;
  }

  const toolCall = payload.message?.tool_calls?.find((call) => call.function?.name === toolName);
  if (toolCall === undefined) {
    return null;
  }

  return parseToolArguments(toolCall.function?.arguments);
}

async function ollamaResearchActionToolCall(
  host: string,
  model: string,
  request: ResearchActionRequest,
  options: ResearchBackendCallOptions
): Promise<ResearchActionDecision> {
  const rawResponseText = await ollamaChatRaw(
    host,
    {
      model,
      stream: false,
      think: false,
      messages: [
        {
          role: "system",
          content: nativeAgentStepInstruction(request)
        }
      ],
      tools: [researchActionToolDefinition(request)]
    },
    options
  );
  let toolArguments: unknown | null;

  try {
    toolArguments = extractNativeToolArguments(rawResponseText, researchActionToolName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResearchBackendError(
      "malformed_json",
      "agent_step",
      `Ollama agent_step tool-call arguments were not valid JSON: ${message}`,
      options.timeoutMs
    );
  }

  if (toolArguments === null) {
    throw new ResearchBackendError(
      "malformed_json",
      "agent_step",
      `Ollama agent_step response did not include a ${researchActionToolName} tool call.`,
      options.timeoutMs
    );
  }

  try {
    return {
      ...normalizeResearchActionDecision(toolArguments, request),
      transport: "native_tool_call"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResearchBackendError(
      "malformed_json",
      "agent_step",
      `Research agent returned an invalid native tool call: ${message}`,
      options.timeoutMs
    );
  }
}

export class OllamaResearchBackend implements ResearchBackend {
  readonly label: string;
  readonly capabilities: ResearchBackendCapabilities = {
    actionControl: {
      nativeToolCalls: true,
      strictJsonFallback: true
    }
  };

  constructor(
    private readonly host = defaultHost,
    private readonly model = defaultModel
  ) {
    this.label = `ollama:${this.model}`;
  }

  async planResearch(request: ResearchPlanningRequest, options: ResearchBackendCallOptions = {
    operation: "planning",
    timeoutMs: 300_000
  }): Promise<ResearchPlan> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      planningInstruction(request),
      options
    );

    return normalizePlan(raw, request.brief);
  }

  async chooseResearchAction(request: ResearchActionRequest, options: ResearchBackendCallOptions = {
    operation: "agent_step",
    timeoutMs: 300_000
  }): Promise<ResearchActionDecision> {
    const agentControlMode = options.agentControlMode ?? "auto";
    let transportFallback: ResearchActionDecision["transportFallback"];

    if (agentControlMode === "native_tool_calls") {
      return ollamaResearchActionToolCall(this.host, this.model, request, options);
    }

    if (agentControlMode === "auto") {
      try {
        return await ollamaResearchActionToolCall(this.host, this.model, request, options);
      } catch (error) {
        if (!(error instanceof ResearchBackendError)) {
          throw error;
        }

        if (error.kind === "timeout") {
          throw error;
        }

        transportFallback = {
          from: "native_tool_call",
          to: "strict_json",
          kind: error.kind,
          message: error.message
        };
      }
    }

    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      agentStepInstruction(request),
      options
    );

    try {
      return {
        ...normalizeResearchActionDecision(raw, request),
        transport: "strict_json",
        ...(transportFallback === undefined ? {} : { transportFallback })
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ResearchBackendError(
        "malformed_json",
        "agent_step",
        `Research agent returned an invalid structured action: ${message}`,
        options.timeoutMs
      );
    }
  }

}

export class OpenAIResponsesResearchBackend implements ResearchBackend {
  readonly label: string;
  readonly capabilities: ResearchBackendCapabilities = {
    actionControl: {
      nativeToolCalls: true,
      strictJsonFallback: true
    }
  };

  constructor(private readonly client: RuntimeModelClient) {
    this.label = client.label;
  }

  async planResearch(request: ResearchPlanningRequest, options: ResearchBackendCallOptions = {
    operation: "planning",
    timeoutMs: 300_000
  }): Promise<ResearchPlan> {
    const raw = await modelJsonCall<unknown>(
      this.client,
      planningInstruction(request),
      options
    );

    return normalizePlan(raw, request.brief);
  }

  private async chooseResearchActionNative(
    request: ResearchActionRequest,
    options: ResearchBackendCallOptions
  ): Promise<ResearchActionDecision> {
    let toolArguments: unknown | null;

    try {
      toolArguments = await this.client.toolCall(
        nativeAgentStepInstruction(request),
        responseResearchActionToolDefinition(request),
        options
      );
    } catch (error) {
      if (error instanceof ModelRuntimeError) {
        throw researchBackendErrorFromModelError(error);
      }

      throw error;
    }

    if (toolArguments === null) {
      throw new ResearchBackendError(
        "malformed_json",
        "agent_step",
        `${this.client.provider} agent_step response did not include a ${researchActionToolName} tool call.`,
        options.timeoutMs
      );
    }

    try {
      return {
        ...normalizeResearchActionDecision(toolArguments, request),
        transport: "native_tool_call"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ResearchBackendError(
        "malformed_json",
        "agent_step",
        `Research agent returned an invalid native tool call: ${message}`,
        options.timeoutMs
      );
    }
  }

  async chooseResearchAction(request: ResearchActionRequest, options: ResearchBackendCallOptions = {
    operation: "agent_step",
    timeoutMs: 300_000
  }): Promise<ResearchActionDecision> {
    const agentControlMode = options.agentControlMode ?? "auto";
    let transportFallback: ResearchActionDecision["transportFallback"];

    if (agentControlMode === "native_tool_calls") {
      return this.chooseResearchActionNative(request, options);
    }

    if (agentControlMode === "auto") {
      try {
        return await this.chooseResearchActionNative(request, options);
      } catch (error) {
        if (!(error instanceof ResearchBackendError)) {
          throw error;
        }

        if (error.kind === "timeout") {
          throw error;
        }

        transportFallback = {
          from: "native_tool_call",
          to: "strict_json",
          kind: error.kind,
          message: error.message
        };
      }
    }

    const raw = await modelJsonCall<unknown>(
      this.client,
      agentStepInstruction(request),
      options
    );

    try {
      return {
        ...normalizeResearchActionDecision(raw, request),
        transport: "strict_json",
        ...(transportFallback === undefined ? {} : { transportFallback })
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ResearchBackendError(
        "malformed_json",
        "agent_step",
        `Research agent returned an invalid structured action: ${message}`,
        options.timeoutMs
      );
    }
  }

}

export function createDefaultResearchBackend(): ResearchBackend {
  return new OllamaResearchBackend();
}

export async function createProjectResearchBackend(params: {
  projectRoot: string;
  projectConfig: ProjectConfigState;
  timestampFactory?: () => string;
}): Promise<ResearchBackend> {
  const runtimeModel = resolveRuntimeModelConfig(params.projectConfig);

  if (runtimeModel.provider === "ollama") {
    return new OllamaResearchBackend(
      runtimeModel.host ?? defaultHost,
      runtimeModel.model
    );
  }

  const credentialStore = new ModelCredentialStore(params.projectRoot, params.timestampFactory);
  const credentials: ModelCredentialState = await credentialStore.load();
  return new OpenAIResponsesResearchBackend(
    new RuntimeModelClient(runtimeModel, credentials, credentialStore)
  );
}
