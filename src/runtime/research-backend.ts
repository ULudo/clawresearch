import type { ResearchBrief } from "./session-store.js";
import type { ResearchWorkerState } from "./research-state.js";
import type {
  ResearchMissionTarget,
  ResearchPaperMode,
  ResearchNotebookTaskStatus,
  WorkspacePromptContext
} from "./research-work-store.js";
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
import {
  normalizeCriticReview,
  type CriticReviewArtifact,
  type CriticReviewRequest
} from "./research-critic.js";

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
  notebookPatch?: ResearchPlanNotebookPatch | null;
};

export type ResearchPlanNotebookTask = {
  id?: string;
  title: string;
  status: ResearchNotebookTaskStatus;
  notes: string | null;
  linkedSourceIds: string[];
  linkedExtractionIds: string[];
  linkedEvidenceCellIds: string[];
  linkedClaimIds: string[];
  linkedSectionIds: string[];
  linkedArtifactPaths: string[];
};

export type ResearchPlanNotebookPatch = {
  missionTarget?: ResearchMissionTarget;
  paperMode?: ResearchPaperMode;
  objective?: string;
  definitionOfDone?: string[];
  tasks?: ResearchPlanNotebookTask[];
  currentFocus?: string | null;
  readiness?: string;
  notes?: string[];
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
  workspaceContext: WorkspacePromptContext;
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
  criticReview: boolean;
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
  reviewResearchArtifact?(request: CriticReviewRequest, options?: ResearchBackendCallOptions): Promise<CriticReviewArtifact>;
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

function safeObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function safeNotebookTaskStatus(value: unknown): ResearchNotebookTaskStatus {
  switch (value) {
    case "todo":
    case "in_progress":
    case "done":
    case "blocked":
    case "abandoned":
      return value;
    default:
      return "todo";
  }
}

function normalizePlanNotebookTask(value: unknown): ResearchPlanNotebookTask | null {
  const record = safeObject(value);
  if (record === null) {
    return null;
  }
  const title = safeString(record.title ?? record.text);
  if (title === null) {
    return null;
  }

  const id = safeString(record.id);
  return {
    ...(id === null ? {} : { id }),
    title,
    status: safeNotebookTaskStatus(record.status),
    notes: safeString(record.notes ?? record.note),
    linkedSourceIds: safeStringArray(record.linkedSourceIds ?? record.sourceIds, 40),
    linkedExtractionIds: safeStringArray(record.linkedExtractionIds ?? record.extractionIds, 40),
    linkedEvidenceCellIds: safeStringArray(record.linkedEvidenceCellIds ?? record.evidenceCellIds, 40),
    linkedClaimIds: safeStringArray(record.linkedClaimIds ?? record.claimIds, 40),
    linkedSectionIds: safeStringArray(record.linkedSectionIds ?? record.sectionIds, 40),
    linkedArtifactPaths: safeStringArray(record.linkedArtifactPaths ?? record.artifactPaths, 40)
  };
}

function safeMissionTarget(value: unknown): ResearchMissionTarget | null {
  switch (value) {
    case "research_brief":
    case "professional_paper":
    case "status_report":
      return value;
    default:
      return null;
  }
}

function safePaperMode(value: unknown): ResearchPaperMode | null {
  switch (value) {
    case "literature_review":
    case "technical_survey":
    case "method_paper":
    case "experimental_paper":
    case "position_paper":
      return value;
    default:
      return null;
  }
}

function normalizePlanNotebookPatch(raw: Record<string, unknown>): ResearchPlanNotebookPatch | null {
  const notebookRecord = safeObject(raw.notebookPatch)
    ?? safeObject(raw.notebook)
    ?? (
      raw.tasks !== undefined
        || raw.currentFocus !== undefined
        || raw.readiness !== undefined
        || raw.definitionOfDone !== undefined
        ? raw
        : null
    );
  if (notebookRecord === null) {
    return null;
  }

  const objective = safeString(notebookRecord.objective);
  const currentFocus = safeString(notebookRecord.currentFocus);
  const readiness = safeString(notebookRecord.readiness ?? notebookRecord.readinessSelfAssessment);
  const missionTarget = safeMissionTarget(notebookRecord.missionTarget);
  const paperMode = safePaperMode(notebookRecord.paperMode);
  const definitionOfDone = safeStringArray(notebookRecord.definitionOfDone, 40);
  const notes = safeStringArray(notebookRecord.notes, 40);
  const tasks = Array.isArray(notebookRecord.tasks)
    ? notebookRecord.tasks.flatMap((entry) => normalizePlanNotebookTask(entry) ?? [])
    : [];

  const patch: ResearchPlanNotebookPatch = {};
  if (missionTarget !== null) {
    patch.missionTarget = missionTarget;
  }
  if (paperMode !== null) {
    patch.paperMode = paperMode;
  }
  if (objective !== null) {
    patch.objective = objective;
  }
  if (definitionOfDone.length > 0) {
    patch.definitionOfDone = definitionOfDone;
  }
  if (tasks.length > 0) {
    patch.tasks = tasks;
  }
  if (currentFocus !== null) {
    patch.currentFocus = currentFocus;
  }
  if (readiness !== null) {
    patch.readiness = readiness;
  }
  if (notes.length > 0) {
    patch.notes = notes;
  }

  return Object.keys(patch).length > 0 ? patch : null;
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
	    rationale: safeString(record.rationale) ?? "Begin with a literature-grounded operating plan before making stronger claims.",
	    searchQueries: safeStringArray(record.searchQueries, 5).length > 0
	      ? safeStringArray(record.searchQueries, 5)
	      : [fallbackTopic, fallbackQuestion],
	    localFocus: safeStringArray(record.localFocus, 5),
	    notebookPatch: normalizePlanNotebookPatch(record)
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
    notebooks: []
  };
  const literaturePromptContext = {
    available: literatureContext.available,
    paperCount: literatureContext.paperCount,
    themeCount: literatureContext.themeCount,
    notebookCount: literatureContext.notebookCount,
    papers: literatureContext.papers,
    themes: literatureContext.themes,
    notebooks: literatureContext.notebooks
  };

  return [
    "You are ClawResearch's planning module for a console-first autonomous research runtime.",
    "Plan an initial research operating mode using the brief, current SQLite workspace context, and local project context.",
    "Use the workspace context when it is relevant so the next pass builds on existing notebook tasks, sources, evidence, claims, sections, checks, and work items instead of starting from scratch.",
    "Ground the plan in the following design principles:",
    "- choose a research mode explicitly",
    "- prefer bounded literature-grounded work over overclaiming",
    "- keep the objective specific and debuggable",
	    "- produce search queries that are likely to retrieve useful sources",
	    "- initialize the living research notebook as a project-management contract owned by the researcher model",
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
	    '  "localFocus": ["string"],',
	    '  "notebookPatch": {',
	    '    "missionTarget": "research_brief|professional_paper|status_report",',
	    '    "paperMode": "literature_review|technical_survey|method_paper|experimental_paper|position_paper",',
	    '    "objective": "string",',
	    '    "definitionOfDone": ["model-authored criteria for this project"],',
	    '    "tasks": [{ "id": "optional stable task id", "title": "task title", "status": "todo|in_progress|done|blocked|abandoned", "notes": "string or null", "linkedSourceIds": [], "linkedExtractionIds": [], "linkedEvidenceCellIds": [], "linkedClaimIds": [], "linkedSectionIds": [], "linkedArtifactPaths": [] }],',
	    '    "currentFocus": "string",',
	    '    "readiness": "explicit current readiness assessment, usually not sufficient at startup",',
	    '    "notes": ["optional notebook note"]',
	    "  }",
	    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Local files: ${JSON.stringify(request.localFiles.slice(0, 20))}`,
    `Workspace context: ${JSON.stringify(request.workspaceContext)}`,
    `Literature context: ${JSON.stringify(literaturePromptContext)}`,
    `Autonomous worker state: ${JSON.stringify(request.workerState ?? null)}`,
    "If autonomous worker state contains nextInternalActions, continue those machine-actionable research actions unless the brief has materially changed or an external blocker prevents progress."
  ].join("\n");
}

function criticReviewInstruction(request: CriticReviewRequest): string {
  const workspacePacket = request.workspace ?? null;
  const criticPacket = {
    stage: request.stage,
    brief: request.brief,
    notebook: workspacePacket?.notebook ?? null,
    workspaceSummary: workspacePacket?.workspaceSummary ?? {},
    selectedSources: workspacePacket?.selectedSources ?? [],
    citedSources: workspacePacket?.citedSources ?? [],
    protocols: workspacePacket?.protocols ?? [],
    extractions: workspacePacket?.extractions ?? [],
    evidenceCells: workspacePacket?.evidenceCells ?? [],
    claims: workspacePacket?.claims ?? [],
    citations: workspacePacket?.citations ?? [],
    manuscriptSections: workspacePacket?.manuscriptSections ?? [],
    releaseChecks: workspacePacket?.releaseChecks ?? [],
    manuscriptChecks: request.manuscriptChecks ?? null,
    references: request.references ?? null,
    paper: request.paper ?? null
  };

  return [
    "You are an independent scientific reviewer for ClawResearch.",
    "You are a fresh stateless critic. Review only the provided research workspace packet.",
    "Do not perform new research. Do not invent sources, claims, citations, IDs, or facts.",
    "Do not rewrite the manuscript. Do not continue the research process. Do not assume access to anything not included in the packet.",
    "Your job is to identify concrete weaknesses, unsupported claims, missing synthesis, overstatements, citation/provenance problems, and manuscript-readiness issues.",
    "Distinguish mechanical/provenance issues from scientific/research-quality objections.",
    "Be concrete. For every objection, name the affected claim, section, evidence cell, citation, release check, or source when possible.",
    "Use IDs only if they appear in the packet. If the objection is global, use targetId null. Never invent source, claim, section, evidence, extraction, citation, protocol, or check IDs.",
    "If the artifact is weak but repairable, use readiness \"revise\". Use readiness \"block\" only when the material is too incomplete, incoherent, or provenance-broken to responsibly revise without substantial new work. Use readiness \"pass\" only when no major or blocking objection remains.",
    "Positive findings are optional. Include them only when they are directly relevant to readiness. Do not add generic praise.",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "schemaVersion": 1,',
    '  "stage": "protocol|sources|evidence|release",',
    '  "readiness": "pass|revise|block",',
    '  "confidence": 0.0,',
    '  "summary": "short readiness-focused review summary",',
    '  "objections": [{',
    '    "code": "short-stable-code",',
    '    "severity": "blocking|major|minor",',
    '    "targetType": "notebook|protocol|source|extraction|evidence|claim|section|citation|manuscript|release_check",',
    '    "targetId": "known id or null",',
    '    "message": "concrete objection",',
    '    "affectedSourceIds": ["known source ids only"],',
    '    "affectedEvidenceCellIds": ["known evidence cell ids only"],',
    '    "affectedClaimIds": ["known claim ids only"],',
    '    "affectedSectionIds": ["known section ids only"],',
    '    "suggestedRevision": "concrete suggested recovery or revision"',
    "  }],",
    '  "positiveFindings": [{ "targetType": "manuscript", "targetId": null, "message": "optional readiness-relevant strength" }],',
    '  "revisionAdvice": {',
    '    "searchQueries": [],',
    '    "evidenceTargets": [],',
    '    "papersToExclude": [],',
    '    "papersToPromote": [],',
    '    "claimsToSoften": []',
    "  },",
    '  "recommendedNextActions": ["concise model-facing next action suggestion"]',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Run id: ${request.runId}`,
    `Review scope: ${request.stage}`,
    `Critic packet: ${JSON.stringify(criticPacket)}`
  ].join("\n");
}

function agentStepInstruction(request: ResearchActionRequest): string {
  const criticInstruction = request.allowedActions.includes("critic.review")
    ? "Use critic.review for fresh stateless critique, and check.run for release/support checks."
    : "Use check.run for release/support checks.";
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
    "You are the researcher. ClawResearch is the lab runtime.",
    "Inspect the current workspace/source/tool observations, then choose exactly one useful next tool operation from the allowed tool list.",
    "Do not invent tool names. Do not execute the action yourself. The runtime will validate and execute the chosen action.",
    "The phase value is only a milestone/progress label. It must not limit your tool choice.",
    "The workspace dashboard is an index, not full memory; use workspace.list/search/read to inspect older or complete state.",
	    "If a custom tool family is unclear, use guidance.search/read/recommend to inspect the ClawResearch lab manual.",
	    "The notebook is your living project-management contract: objective, definition of done, task list, current focus, readiness assessment, and artifact links.",
    "The notebook missionTarget and paperMode state what kind of artifact you are trying to finish; do not downgrade a professional_paper mission to a brief just to stop.",
    "Use notebook.read/patch to keep that contract current as research state changes; the runtime will not infer research sufficiency for you.",
    "Use workspace.search/read/list/create/patch/link/unlink to inspect or update the durable SQLite research workspace.",
    "Use source.search, source.merge, source.resolve_access, and source.select_evidence for source discovery and evidence-set construction.",
    "For source.select_evidence, always set workStore.payloadJson or entity to {\"mode\":\"append\"|\"replace\"|\"remove\"}; append adds to the current set, replace overwrites it, remove subtracts ids.",
    "For create/patch tools, put durable research content only in explicit content fields. Never rely on rationale, reason, expectedOutcome, or stopCondition as manuscript, claim, evidence, or extraction content.",
    "section.create/patch require explicit markdown/content/paragraphs. claim.create requires explicit text. evidence.create_cell requires explicit value/text. extraction.create requires explicit source-derived fields.",
    ...researchActionRecipeLines,
    "Use claim.create/patch/check_support/link_support for claim-led synthesis.",
    "Use section.create/read/patch/link_claim/check_claims for section-level writing.",
    "Use work_item.create/patch when critic or check feedback becomes actionable research debt.",
    "Use guidance.search/read/recommend to inspect advisory research-lab scaffolding. Guidance is not a gate and may be overridden.",
    "Use protocol.create_or_revise when the research protocol itself needs visible revision by the researcher.",
    criticInstruction,
	    "Use release.verify for final computable release invariants, artifact-contract diagnostics, and notebook/project-management diagnostics; it does not decide research completeness or scientific quality.",
	    "Use manuscript.finalize only when you intentionally want the runtime to write paper.md from workspace sections after hard invariant checks pass, the notebook readiness is explicit, and the notebook missionTarget artifact contract is satisfied.",
    "Critic objections, failed release checks, and not-ready tool results are repair signals. Prefer concrete tool steps over stopping.",
    "Recent tool results are authoritative observations from executed tools. Use returned ids, snippets, and previews before repeating the same read action.",
    "Use workspace.status only for a validated external blocker or real user decision; do not stop merely because machine-actionable work remains.",
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
    '      "collection": "providerRuns|sources|canonicalSources|screeningDecisions|fullTextRecords|extractions|evidenceCells|claims|citations|protocols|workItems|manuscriptSections|releaseChecks|null",',
    '      "entityId": "known entity id or null",',
    '      "filters": {},',
    '      "filterJson": "{\\"field\\":\\"simple exact match value\\"} or null",',
    '      "semanticQuery": "short query or null",',
    '      "limit": 12,',
    '      "cursor": "pagination cursor from a previous tool result or null",',
    '      "changes": {},',
    '      "entity": { "sourceId": "known source id or null", "paperId": "known paper id or null", "extractionId": "known extraction id or null", "field": "evidence field or null", "value": "evidence value string or string[] or null", "text": "claim/text content or null", "claimId": "known claim id or null", "evidenceCellId": "known evidence cell id or null", "supportSnippet": "support snippet or null", "sectionIds": ["known section ids"], "markdown": "section markdown or null", "status": "status or null", "statusReason": "status reason or null", "nextInternalActions": ["machine-actionable follow-up"] },',
    '      "patchJson": "{\\"field\\":\\"patch value\\"} or null",',
    '      "payloadJson": "{\\"kind\\":\\"workItem\\",\\"title\\":\\"optional new work item\\"} or null; for source.select_evidence use {\\"mode\\":\\"append|replace|remove\\"}; for section.create/patch include {\\"markdown\\":\\"...\\"}",',
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

const commonWorkStoreEntityProperties: Record<string, Record<string, unknown>> = {
  sourceId: {
    type: ["string", "null"],
    description: "Known canonical source id for extraction/evidence/support operations."
  },
  paperId: {
    type: ["string", "null"],
    description: "Known paper/source id alias when the tool accepts a paper id."
  },
  extractionId: {
    type: ["string", "null"],
    description: "Known extraction id, especially for evidence.create_cell."
  },
  field: {
    type: ["string", "null"],
    description: "Evidence matrix field name such as limitations, architecture, evaluationSetup, or successSignals."
  },
  value: {
    type: ["string", "array", "null"],
    items: {
      type: "string"
    },
    description: "Evidence value for evidence.create_cell; use an array for list-valued evidence fields."
  },
  text: {
    type: ["string", "null"],
    description: "Primary text for claim.create or another simple text-bearing entity."
  },
  claimId: {
    type: ["string", "null"],
    description: "Known claim id for claim.link_support or section link operations."
  },
  evidenceCellId: {
    type: ["string", "null"],
    description: "Known evidence cell id for claim.link_support."
  },
  supportSnippet: {
    type: ["string", "null"],
    description: "Concise source-grounded snippet explaining why evidence supports a claim."
  },
  sectionIds: {
    type: ["array", "null"],
    items: {
      type: "string"
    },
    description: "Known manuscript section ids connected to a support link or claim."
  },
  markdown: {
    type: ["string", "null"],
    description: "Markdown content for section.create or section.patch."
  },
  status: {
    type: ["string", "null"],
    description: "Status value for workspace.status, work_item.patch, section.patch, or similar updates."
  },
  statusReason: {
    type: ["string", "null"],
    description: "Short reason explaining a status value."
  },
  nextInternalActions: {
    type: ["array", "null"],
    items: {
      type: "string"
    },
    description: "Machine-actionable follow-up actions for workspace.status."
  }
};

const commonWorkStoreEntityRequired = Object.keys(commonWorkStoreEntityProperties);

const researchActionRecipeLines = [
  "Action recipes:",
  "- extraction.create: set workStore.entity.sourceId or paperId to a known canonical source; include source-derived extraction fields such as problemSetting, architecture, evaluationSetup, successSignals, limitations, and evidenceNotes via payloadJson when they are not typed entity fields.",
  "- evidence.create_cell: set workStore.entity.sourceId or paperId, extractionId when known, field, and value or text; keep the value grounded in the source/extraction.",
  "- claim.link_support: set workStore.entity.claimId plus evidenceCellId or sourceId, add supportSnippet, and include sectionIds only when the claim is used there."
];

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
                      "protocols",
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
                    properties: {},
                    description: "Reserved closed object for native schemas; use filterJson for dynamic exact-match filters."
                  },
                  filterJson: {
                    type: ["string", "null"],
                    description: "Optional JSON object string for exact-match filters, for example {\"status\":\"open\"}."
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
                    properties: {},
                    description: "Reserved closed object for native schemas; use patchJson for dynamic patch fields."
                  },
                  entity: {
                    type: "object",
                    additionalProperties: false,
                    properties: commonWorkStoreEntityProperties,
                    required: commonWorkStoreEntityRequired,
                    description: "Typed common create/status/link payload fields. Recipes: extraction.create sets sourceId or paperId here and uses payloadJson for richer source-derived extraction fields; evidence.create_cell sets sourceId or paperId, extractionId, field, and value/text; claim.link_support sets claimId, evidenceCellId or sourceId, supportSnippet, and sectionIds. Use payloadJson as the fallback for fields not listed here."
                  },
                  patchJson: {
                    type: ["string", "null"],
                    description: "Optional JSON object string for patch fields, for example {\"status\":\"resolved\"}."
                  },
                  payloadJson: {
                    type: ["string", "null"],
                    description: "Fallback JSON object string for create/status/notebook payload fields not covered by typed workStore.entity fields. source.select_evidence must include {\"mode\":\"append|replace|remove\"}. extraction.create may include source-derived fields such as {\"problemSetting\":\"...\",\"architecture\":\"...\",\"successSignals\":[\"...\"],\"limitations\":[\"...\"]}. section.create/patch should include {\"markdown\":\"...\"}. notebook.patch may include {\"missionTarget\":\"professional_paper|research_brief|status_report\",\"paperMode\":\"literature_review|technical_survey|method_paper|experimental_paper|position_paper\",\"objective\":\"...\",\"definitionOfDone\":[\"...\"],\"tasks\":[{\"id\":\"task-1\",\"title\":\"...\",\"status\":\"todo\",\"linkedEvidenceCellIds\":[\"...\"]}]}. section.link_claim may include {\"sectionId\":\"...\",\"claimId\":\"...\"}. workspace.status may include {\"status\":\"externally_blocked|needs_user_decision\",\"statusReason\":\"...\",\"nextInternalActions\":[\"...\"]}; non-terminal status notes are returned as observations and do not stop the worker."
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
  const criticInstruction = request.allowedActions.includes("critic.review")
    ? "Use critic.review for fresh stateless critique, and check.run for release/support checks."
    : "Use check.run for release/support checks.";
  return [
    "You are the researcher. ClawResearch is the lab runtime.",
    `Call ${researchActionToolName} exactly once.`,
    "Do not answer in prose. Do not invent tools. The runtime validates and executes the chosen action.",
    "The phase value is only a milestone/progress label. It must not limit your tool choice.",
    "The workspace dashboard is an index, not full memory; use workspace.list/search/read to inspect older or complete state.",
	    "If a custom tool family is unclear, use guidance.search/read/recommend to inspect the ClawResearch lab manual.",
	    "The notebook is your living project-management contract: objective, definition of done, task list, current focus, readiness assessment, and artifact links.",
    "The notebook missionTarget and paperMode state what kind of artifact you are trying to finish; do not downgrade a professional_paper mission to a brief just to stop.",
    "Use notebook.read/patch to keep that contract current as research state changes; the runtime will not infer research sufficiency for you.",
    "Use workspace.search/read/list/create/patch/link/unlink to inspect or update the durable SQLite research workspace.",
    "Use source.search, source.merge, source.resolve_access, and source.select_evidence for source discovery and evidence-set construction.",
    "For source.select_evidence, always set workStore.payloadJson or entity to {\"mode\":\"append\"|\"replace\"|\"remove\"}; append adds to the current set, replace overwrites it, remove subtracts ids.",
    "For create/patch tools, put durable research content only in explicit content fields. Never rely on rationale, reason, expectedOutcome, or stopCondition as manuscript, claim, evidence, or extraction content.",
    "section.create/patch require explicit markdown/content/paragraphs. claim.create requires explicit text. evidence.create_cell requires explicit value/text. extraction.create requires explicit source-derived fields.",
    ...researchActionRecipeLines,
    "Use claim.create/patch/check_support/link_support for claim-led synthesis.",
    "Use section.create/read/patch/link_claim/check_claims for section-level writing.",
    "Use work_item.create/patch when critic or check feedback becomes actionable research debt.",
    "Use guidance.search/read/recommend to inspect advisory research-lab scaffolding. Guidance is not a gate and may be overridden.",
    "Use protocol.create_or_revise when the research protocol itself needs visible revision by the researcher.",
    criticInstruction,
	    "Use release.verify for final computable release invariants, artifact-contract diagnostics, and notebook/project-management diagnostics; it does not decide research completeness or scientific quality.",
	    "Use manuscript.finalize only when you intentionally want the runtime to write paper.md from workspace sections after hard invariant checks pass, the notebook readiness is explicit, and the notebook missionTarget artifact contract is satisfied.",
    "Critic objections, failed release checks, and not-ready tool results are repair signals. Prefer concrete tool steps over stopping.",
    "Recent tool results are authoritative observations from executed tools. Use returned ids, snippets, and previews before repeating the same read action.",
    "Use workspace.status only for a validated external blocker or real user decision; do not stop merely because machine-actionable work remains.",
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
    },
    criticReview: true
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

  async reviewResearchArtifact(request: CriticReviewRequest, options: ResearchBackendCallOptions = {
    operation: "critic",
    timeoutMs: 300_000
  }): Promise<CriticReviewArtifact> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      criticReviewInstruction(request),
      options
    );

    return normalizeCriticReview(raw, request);
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
    },
    criticReview: true
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

  async reviewResearchArtifact(request: CriticReviewRequest, options: ResearchBackendCallOptions = {
    operation: "critic",
    timeoutMs: 300_000
  }): Promise<CriticReviewArtifact> {
    const raw = await modelJsonCall<unknown>(
      this.client,
      criticReviewInstruction(request),
      options
    );

    return normalizeCriticReview(raw, request);
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
