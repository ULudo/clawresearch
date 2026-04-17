import type { ProjectMemoryContext } from "./memory-store.js";
import type { LiteratureContext } from "./literature-store.js";
import type { ResearchPlan } from "./research-backend.js";
import type { ResearchBrief } from "./session-store.js";

const stopTokens = new Set([
  "about",
  "across",
  "after",
  "analysis",
  "approach",
  "approaches",
  "best",
  "current",
  "existing",
  "focus",
  "general",
  "identify",
  "implementation",
  "implementing",
  "interested",
  "into",
  "investigate",
  "literature",
  "main",
  "most",
  "problem",
  "project",
  "question",
  "research",
  "specific",
  "study",
  "successful",
  "success",
  "technique",
  "techniques",
  "their",
  "them",
  "topic",
  "understanding",
  "what",
  "which",
  "work"
]);

const preservedShortTokens = new Set([
  "ai",
  "agi",
  "llm",
  "ml",
  "nlp",
  "rl"
]);

const anchorStopTokens = new Set([
  ...[...stopTokens].filter((token) => token !== "research"),
  "and",
  "for",
  "the",
  "its",
  "with",
  "from",
  "into",
  "using",
  "used",
  "among",
  "across"
]);

export type LiteratureTaskAttribute =
  | "survey"
  | "comparison"
  | "limitations"
  | "implementation"
  | "evaluation"
  | "best_practices"
  | "theory"
  | "historical";

export type LiteratureReviewProfile = {
  subsystem: "literature_review";
  domainAnchors: string[];
  focusConcepts: string[];
  taskAttributes: LiteratureTaskAttribute[];
  searchQueries: string[];
  rationale: string[];
};

export type LiteratureSourceAssessment = {
  matchedDomainAnchors: string[];
  matchedFocusConcepts: string[];
  matchedTaskAttributes: LiteratureTaskAttribute[];
  topicScore: number;
  focusScore: number;
  taskAttributeScore: number;
  totalScore: number;
  accepted: boolean;
  rationale: string;
};

type LiteratureTaskAttributeDefinition = {
  id: LiteratureTaskAttribute;
  cuePattern: RegExp;
  queryTerms: string[];
};

const taskAttributeDefinitions: LiteratureTaskAttributeDefinition[] = [
  {
    id: "survey",
    cuePattern: /\b(literature|review|survey|synthesis|map|mapping|related work|prior work|overview|taxonomy)\b/i,
    queryTerms: ["literature review", "survey", "related work"]
  },
  {
    id: "comparison",
    cuePattern: /\b(compare|comparison|versus|vs\b|trade-?off|taxonomy|categor(?:y|ize|ization))\b/i,
    queryTerms: ["comparison", "taxonomy", "tradeoffs"]
  },
  {
    id: "limitations",
    cuePattern: /\b(limitations?|gaps?|weakness(?:es)?|failure(?:s)?|challenge(?:s)?|constraint(?:s)?)\b/i,
    queryTerms: ["limitations", "research gaps", "challenges"]
  },
  {
    id: "implementation",
    cuePattern: /\b(implement|implementation|design|architecture|workflow|runtime|tooling|system)\b/i,
    queryTerms: ["design", "implementation", "architecture"]
  },
  {
    id: "evaluation",
    cuePattern: /\b(evaluate|evaluation|benchmark|metric|baseline|publishable|evidence)\b/i,
    queryTerms: ["evaluation", "benchmark", "evidence"]
  },
  {
    id: "best_practices",
    cuePattern: /\b(best practices?|guidelines?|design patterns?|recommended|successful)\b/i,
    queryTerms: ["best practices", "design patterns", "guidelines"]
  },
  {
    id: "theory",
    cuePattern: /\b(theory|theoretical|proof|criterion|theorem|lemma|zeta|number theory|mathematical)\b/i,
    queryTerms: ["theory", "proof techniques", "mathematical methods"]
  },
  {
    id: "historical",
    cuePattern: /\b(history|historical|development of|evolution of)\b/i,
    queryTerms: ["history", "historical development"]
  }
];

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeText(text: string): string {
  return normalizeWhitespace(text.toLowerCase())
    .replace(/[^a-z0-9\s-]/g, " ");
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .filter((token) => token.length >= 4 || preservedShortTokens.has(token));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>();

  for (const value of values) {
    const normalized = typeof value === "string"
      ? normalizeWhitespace(value)
      : "";

    if (normalized.length === 0) {
      continue;
    }

    unique.add(normalized);
  }

  return [...unique];
}

function phraseTokens(text: string): string[] {
  return tokenize(text).map((token) => {
    if (token.endsWith("ies") && token.length > 4) {
      return `${token.slice(0, -3)}y`;
    }

    if (token.endsWith("s") && token.length > 4) {
      return token.slice(0, -1);
    }

    return token;
  });
}

function extractTopicAnchors(text: string | null): string[] {
  if (text === null) {
    return [];
  }

  const tokens = normalizeText(text)
    .split(/\s+/)
    .filter((token) => token.length >= 3 || preservedShortTokens.has(token));
  const topicalTokens = tokens.filter((token) => !anchorStopTokens.has(token));
  const anchorTokens = topicalTokens.length > 0 ? topicalTokens : tokens;

  if (anchorTokens.length === 0) {
    return [];
  }

  const anchors = new Set<string>();

  if (anchorTokens.length <= 5) {
    anchors.add(anchorTokens.join(" "));
  }

  if (anchorTokens.length >= 2) {
    anchors.add(anchorTokens.slice(0, 2).join(" "));
    anchors.add(anchorTokens.slice(-2).join(" "));
  } else {
    anchors.add(anchorTokens[0]!);
  }

  if (anchorTokens.length >= 3) {
    anchors.add(anchorTokens.slice(0, 3).join(" "));
    anchors.add(anchorTokens.slice(-3).join(" "));
  }

  return [...anchors]
    .map((anchor) => normalizeWhitespace(anchor))
    .filter((anchor) => anchor.length > 0);
}

function deriveFocusConcepts(brief: ResearchBrief, plan: ResearchPlan): string[] {
  const domainTokens = new Set(
    extractTopicAnchors(brief.topic).flatMap(phraseTokens)
  );

  return uniqueStrings([
    ...(brief.researchQuestion === null ? [] : phraseTokens(brief.researchQuestion)),
    ...(brief.researchDirection === null ? [] : phraseTokens(brief.researchDirection)),
    ...plan.localFocus.flatMap(phraseTokens),
    ...plan.searchQueries.flatMap(phraseTokens)
  ])
    .filter((token) => token.length >= 4)
    .filter((token) => !stopTokens.has(token))
    .filter((token) => !domainTokens.has(token))
    .slice(0, 8);
}

function deriveTaskAttributes(brief: ResearchBrief, plan: ResearchPlan): LiteratureTaskAttribute[] {
  const combined = [
    plan.researchMode,
    plan.objective,
    plan.rationale,
    brief.topic,
    brief.researchQuestion,
    brief.researchDirection,
    brief.successCriterion
  ].filter((value): value is string => typeof value === "string").join(" ");

  return taskAttributeDefinitions
    .filter((definition) => definition.cuePattern.test(combined))
    .map((definition) => definition.id);
}

function anchorMatchesText(anchor: string, textTokens: string[], normalizedText: string): boolean {
  if (anchor.length === 0) {
    return false;
  }

  const anchorTokens = phraseTokens(anchor);

  if (anchorTokens.length === 0) {
    return false;
  }

  if (anchorTokens.length === 1) {
    return textTokens.includes(anchorTokens[0]!)
      || normalizedText.includes(anchorTokens[0]!);
  }

  if (normalizedText.includes(anchor)) {
    return true;
  }

  for (let startIndex = 0; startIndex < textTokens.length; startIndex += 1) {
    if (textTokens[startIndex] !== anchorTokens[0]) {
      continue;
    }

    let textIndex = startIndex;
    let matched = true;

    for (let anchorIndex = 1; anchorIndex < anchorTokens.length; anchorIndex += 1) {
      const nextAnchorToken = anchorTokens[anchorIndex]!;
      let foundIndex = -1;

      for (let candidateIndex = textIndex + 1; candidateIndex < textTokens.length; candidateIndex += 1) {
        if (candidateIndex - textIndex - 1 > 2) {
          break;
        }

        if (textTokens[candidateIndex] === nextAnchorToken) {
          foundIndex = candidateIndex;
          break;
        }
      }

      if (foundIndex === -1) {
        matched = false;
        break;
      }

      textIndex = foundIndex;
    }

    if (matched) {
      return true;
    }
  }

  return false;
}

function matchFocusConcepts(concepts: string[], textTokens: string[], normalizedText: string): string[] {
  return concepts.filter((concept) => {
    const conceptTokens = phraseTokens(concept);

    if (conceptTokens.length === 0) {
      return false;
    }

    if (conceptTokens.length === 1) {
      return textTokens.includes(conceptTokens[0]!)
        || normalizedText.includes(conceptTokens[0]!);
    }

    return anchorMatchesText(concept, textTokens, normalizedText);
  });
}

function taskAttributeQueryTerms(attributes: LiteratureTaskAttribute[]): string[] {
  return attributes.flatMap((attribute) => (
    taskAttributeDefinitions.find((definition) => definition.id === attribute)?.queryTerms ?? []
  ));
}

export function shouldUseLiteratureReviewSubsystem(plan: ResearchPlan, brief: ResearchBrief): boolean {
  if (plan.researchMode === "literature_synthesis") {
    return true;
  }

  const combined = [
    brief.researchQuestion,
    brief.researchDirection,
    brief.successCriterion,
    plan.objective,
    plan.rationale
  ].filter((value): value is string => typeof value === "string").join(" ");

  return /\b(literature|review|survey|synthesis|related work|prior work|compare approaches|proof techniques|research gap)\b/i.test(combined);
}

export function buildLiteratureReviewProfile(input: {
  brief: ResearchBrief;
  plan: ResearchPlan;
  memoryContext: ProjectMemoryContext;
}): LiteratureReviewProfile {
  const topicTokens = new Set(phraseTokens(input.brief.topic ?? input.plan.objective));
  const queryAnchors = input.plan.searchQueries
    .flatMap((query) => extractTopicAnchors(query))
    .filter((anchor) => {
      const anchorTokens = phraseTokens(anchor);
      return anchorTokens.some((token) => topicTokens.has(token));
    });
  const domainAnchors = uniqueStrings([
    ...extractTopicAnchors(input.brief.topic),
    ...(input.brief.researchQuestion === null ? [] : extractTopicAnchors(input.brief.researchQuestion)),
    ...queryAnchors
  ]).slice(0, 6);
  const focusConcepts = deriveFocusConcepts(input.brief, input.plan);
  const taskAttributes = deriveTaskAttributes(input.brief, input.plan);
  const taskQueries = taskAttributeQueryTerms(taskAttributes);
  const primaryAnchor = domainAnchors[0] ?? input.brief.topic ?? input.plan.objective;
  const searchQueries = uniqueStrings([
    ...input.plan.searchQueries,
    ...domainAnchors.flatMap((anchor) => taskQueries.map((taskQuery) => `${anchor} ${taskQuery}`)),
    ...domainAnchors.flatMap((anchor) => focusConcepts.slice(0, 3).map((focus) => `${anchor} ${focus}`)),
    ...input.memoryContext.queryHints.map((hint) => `${primaryAnchor} ${hint}`),
    primaryAnchor
  ]).slice(0, 24);
  const rationale = [
    domainAnchors.length > 0
      ? `Literature review will prioritize the domain anchors: ${domainAnchors.join(", ")}.`
      : "Literature review will fall back to the broad project topic because no stronger domain anchors were available.",
    taskAttributes.length > 0
      ? `Task-aware ranking will emphasize: ${taskAttributes.join(", ")}.`
      : "Task-aware ranking will stay conservative because no explicit literature-review attributes were detected.",
    focusConcepts.length > 0
      ? `Focus concepts for ranking and synthesis: ${focusConcepts.join(", ")}.`
      : "No extra focus concepts were available beyond the core topic."
  ];

  return {
    subsystem: "literature_review",
    domainAnchors,
    focusConcepts,
    taskAttributes,
    searchQueries,
    rationale
  };
}

export function assessLiteratureSource(
  profile: LiteratureReviewProfile,
  source: {
    title: string;
    excerpt: string;
    citation: string;
  }
): LiteratureSourceAssessment {
  const normalizedText = normalizeText(`${source.title} ${source.excerpt} ${source.citation}`);
  const textTokens = phraseTokens(normalizedText);
  const matchedDomainAnchors = profile.domainAnchors.filter((anchor) => anchorMatchesText(anchor, textTokens, normalizedText));
  const matchedFocusConcepts = matchFocusConcepts(profile.focusConcepts, textTokens, normalizedText);
  const matchedTaskAttributes = profile.taskAttributes.filter((attribute) => {
    const definition = taskAttributeDefinitions.find((entry) => entry.id === attribute);
    return definition?.cuePattern.test(`${source.title} ${source.excerpt}`) ?? false;
  });
  const topicScore = matchedDomainAnchors.reduce((score, anchor) => score + Math.max(3, phraseTokens(anchor).length * 3), 0);
  const focusScore = matchedFocusConcepts.length * 2;
  const taskAttributeScore = matchedTaskAttributes.length * 4;
  const accepted = matchedDomainAnchors.length > 0
    && (taskAttributeScore > 0 || focusScore >= 2 || topicScore >= 6);
  const rationale = accepted
    ? `Accepted for literature review because it matched ${matchedDomainAnchors.length} domain anchors and ${matchedTaskAttributes.length} task attributes.`
    : matchedDomainAnchors.length === 0
      ? "Rejected because it did not match the core domain anchors for the literature review."
      : "Rejected because it matched the topic loosely but did not match the requested literature-review task attributes or focus concepts strongly enough.";

  return {
    matchedDomainAnchors,
    matchedFocusConcepts,
    matchedTaskAttributes,
    topicScore,
    focusScore,
    taskAttributeScore,
    totalScore: topicScore + focusScore + taskAttributeScore,
    accepted,
    rationale
  };
}

export function buildLiteratureSynthesisInstruction(input: {
  projectRoot: string;
  brief: ResearchBrief;
  plan: ResearchPlan;
  literatureContext?: LiteratureContext;
  sources: Array<{
    id: string;
    kind: string;
    title: string;
    locator: string | null;
    citation: string;
    excerpt: string;
    screeningDecision?: string;
    screeningRationale?: string | null;
    tags?: string[];
  }>;
}): string {
  const profile = buildLiteratureReviewProfile({
    brief: input.brief,
    plan: input.plan,
    memoryContext: {
      available: false,
      recordCount: 0,
      countsByType: {
        source: 0,
        claim: 0,
        finding: 0,
        question: 0,
        idea: 0,
        summary: 0,
        artifact: 0
      },
      sources: [],
      claims: [],
      findings: [],
      questions: [],
      ideas: [],
      summaries: [],
      artifacts: [],
      queryHints: [],
      localFileHints: []
    }
  });

  return [
    "You are ClawResearch's dedicated literature-review synthesis module.",
    "Treat this as a literature review subsystem, not generic web browsing and not a free-form brainstorm.",
    "Synthesize prior work by theme and approach family, not as an unstructured list of papers.",
    "Be strict about citation grounding: every claim must be explicitly tied to sourceIds.",
    "Use only exact sourceIds from the provided reviewed paper set.",
    "Prefer claims about approach families, comparisons, methodological limitations, coverage gaps, and research opportunities.",
    "Prefer sources with stronger screening and quality signals when there is tension across the reviewed set.",
    "Treat quality:low and quality-signal:repository-*, quality-signal:grand-claim-title, or quality-signal:revision-like-title as caution flags rather than strong evidence.",
    "Do not let repository-style uploads, self-asserted proofs, or repeated revision-series papers dominate the synthesis if stronger sources exist.",
    "Do not treat a loosely related background source as direct evidence for the target research problem.",
    "If the source set is thin, say so clearly and keep the claims narrow.",
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
    `Project root: ${input.projectRoot}`,
    `Brief: ${JSON.stringify(input.brief)}`,
    `Plan: ${JSON.stringify(input.plan)}`,
    `Literature review profile: ${JSON.stringify(profile)}`,
    `Prior literature memory context: ${JSON.stringify(input.literatureContext ?? {
      available: false,
      paperCount: 0,
      themeCount: 0,
      notebookCount: 0,
      papers: [],
      themes: [],
      notebooks: [],
      queryHints: []
    })}`,
    `Sources: ${JSON.stringify(input.sources)}`
  ].join("\n");
}
