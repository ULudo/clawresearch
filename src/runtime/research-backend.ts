import type { ResearchBrief } from "./session-store.js";
import type { ProjectMemoryContext } from "./memory-store.js";
import type {
  CanonicalPaper,
  LiteratureContext
} from "./literature-store.js";
import {
  buildLiteratureSynthesisInstruction,
  shouldUseLiteratureReviewSubsystem
} from "./literature-review.js";

const defaultHost = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const defaultModel = process.env.CLAWRESEARCH_OLLAMA_MODEL ?? "qwen3:14b";

export type ResearchPlan = {
  researchMode: string;
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
};

export type ResearchSynthesisRequest = {
  projectRoot: string;
  brief: ResearchBrief;
  plan: ResearchPlan;
  papers: CanonicalPaper[];
  literatureContext?: LiteratureContext;
};

export interface ResearchBackend {
  readonly label: string;
  planResearch(request: ResearchPlanningRequest): Promise<ResearchPlan>;
  synthesizeResearch(request: ResearchSynthesisRequest): Promise<ResearchSynthesis>;
}

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
};

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, "");
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

function safeSourceIdArray(value: unknown): string[] {
  return safeStringArray(value, 6);
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
    researchMode: safeString(record.researchMode) ?? "literature_synthesis",
    objective: safeString(record.objective) ?? fallbackQuestion,
    rationale: safeString(record.rationale) ?? "Begin with a bounded literature-grounded pass before making stronger claims.",
    searchQueries: safeStringArray(record.searchQueries, 5).length > 0
      ? safeStringArray(record.searchQueries, 5)
      : [fallbackTopic, fallbackQuestion],
    localFocus: safeStringArray(record.localFocus, 5)
  };
}

function normalizeThemes(value: unknown): ResearchTheme[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const title = safeString(record.title);
    const summary = safeString(record.summary);

    if (title === null || summary === null) {
      return [];
    }

    return [{
      title,
      summary,
      sourceIds: safeSourceIdArray(record.sourceIds)
    }];
  }).slice(0, 6);
}

function normalizeClaims(value: unknown): ResearchClaim[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const claim = safeString(record.claim);
    const evidence = safeString(record.evidence);

    if (claim === null || evidence === null) {
      return [];
    }

    return [{
      claim,
      evidence,
      sourceIds: safeSourceIdArray(record.sourceIds)
    }];
  }).slice(0, 8);
}

function normalizeSynthesis(raw: unknown, brief: ResearchBrief): ResearchSynthesis {
  const record = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};

  return {
    executiveSummary: safeString(record.executiveSummary)
      ?? `This first-pass run synthesized the available sources around ${brief.topic ?? "the requested topic"}.`,
    themes: normalizeThemes(record.themes),
    claims: normalizeClaims(record.claims),
    nextQuestions: safeStringArray(record.nextQuestions, 6)
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
    "- replication_scoping",
    "- exploratory_analysis",
    "- implementation_review",
    "- mixed",
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
    `Literature memory context: ${JSON.stringify(literatureContext)}`
  ].join("\n");
}

function synthesisInstruction(request: ResearchSynthesisRequest): string {
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
  const condensedPapers = request.papers.map((paper) => ({
    id: paper.id,
    title: paper.title,
    citation: paper.citation,
    year: paper.year,
    authors: paper.authors,
    venue: paper.venue,
    abstract: paper.abstract,
    bestAccessUrl: paper.bestAccessUrl,
    bestAccessProvider: paper.bestAccessProvider,
    accessMode: paper.accessMode,
    fulltextFormat: paper.fulltextFormat,
    screeningStage: paper.screeningStage,
    screeningDecision: paper.screeningDecision,
    identifiers: paper.identifiers
  }));

  if (shouldUseLiteratureReviewSubsystem(request.plan, request.brief)) {
    return buildLiteratureSynthesisInstruction({
      projectRoot: request.projectRoot,
      brief: request.brief,
      plan: request.plan,
      sources: condensedPapers.map((paper) => ({
        id: paper.id,
        kind: "canonical_paper",
        title: paper.title,
        locator: paper.bestAccessUrl,
        citation: paper.citation,
        excerpt: paper.abstract ?? `${paper.accessMode} via ${paper.bestAccessProvider ?? "unknown"}`
      })),
      literatureContext
    });
  }

  return [
    "You are ClawResearch's synthesis module for a console-first autonomous research runtime.",
    "Work only from the provided sources. Do not invent papers, evidence, or claims.",
    "Produce a bounded first-pass synthesis that remains honest about uncertainty.",
    "Every claim must be explicitly grounded in the cited sourceIds.",
    "Prefer claims about patterns, limitations, methods, and open questions over grand conclusions.",
    "Next questions should be concrete follow-up research questions, not generic brainstorming.",
    "",
    "Return JSON only with this exact shape:",
    "{",
    '  "executiveSummary": "string",',
    '  "themes": [',
    '    { "title": "string", "summary": "string", "sourceIds": ["string"] }',
    "  ],",
    '  "claims": [',
    '    { "claim": "string", "evidence": "string", "sourceIds": ["string"] }',
    "  ],",
    '  "nextQuestions": ["string"]',
    "}",
    "",
    `Project root: ${request.projectRoot}`,
    `Brief: ${JSON.stringify(request.brief)}`,
    `Plan: ${JSON.stringify(request.plan)}`,
    `Canonical papers: ${JSON.stringify(condensedPapers)}`,
    `Literature memory context: ${JSON.stringify(literatureContext)}`
  ].join("\n");
}

async function ollamaJsonCall<T>(
  host: string,
  model: string,
  systemPrompt: string
): Promise<T> {
  const response = await fetch(`http://${normalizeHost(host)}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: systemPrompt
        }
      ]
    }),
    signal: AbortSignal.timeout(120_000)
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as OllamaChatResponse;
  const content = payload.message?.content;

  if (typeof content !== "string") {
    throw new Error("Ollama returned an unexpected response.");
  }

  return extractJson(content) as T;
}

export class OllamaResearchBackend implements ResearchBackend {
  readonly label: string;

  constructor(
    private readonly host = defaultHost,
    private readonly model = defaultModel
  ) {
    this.label = `ollama:${this.model}`;
  }

  async planResearch(request: ResearchPlanningRequest): Promise<ResearchPlan> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      planningInstruction(request)
    );

    return normalizePlan(raw, request.brief);
  }

  async synthesizeResearch(request: ResearchSynthesisRequest): Promise<ResearchSynthesis> {
    const raw = await ollamaJsonCall<unknown>(
      this.host,
      this.model,
      synthesisInstruction(request)
    );

    return normalizeSynthesis(raw, request.brief);
  }
}

export function createDefaultResearchBackend(): ResearchBackend {
  return new OllamaResearchBackend();
}
