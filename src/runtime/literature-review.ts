import type { ProjectMemoryContext } from "./memory-store.js";
import type { LiteratureContext } from "./literature-store.js";
import type { ResearchPlan } from "./research-backend.js";
import type { ResearchBrief } from "./session-store.js";

type ReviewFacetSource =
  | "topic"
  | "research_question"
  | "research_direction"
  | "success_criterion"
  | "plan_objective"
  | "plan_query"
  | "plan_focus"
  | "task_vocabulary";

export type ReviewFacetKind =
  | "domain"
  | "population"
  | "intervention"
  | "method"
  | "outcome"
  | "evaluation"
  | "task"
  | "constraint";

export type ReviewFacet = {
  id: string;
  label: string;
  kind: ReviewFacetKind;
  required: boolean;
  terms: string[];
  source: ReviewFacetSource;
  rationale: string;
};

export type PaperFacetCoverage = {
  paperId: string;
  coveredFacetIds: string[];
  missingRequiredFacetIds: string[];
  coverageScore: number;
  matchedTerms: string[];
  rationale: string;
};

export type ReviewSelectionAdequacy =
  | "strong"
  | "partial"
  | "thin";

export type ReviewSelectionQuality = {
  schemaVersion: 1;
  requiredFacets: ReviewFacet[];
  optionalFacets: ReviewFacet[];
  paperFacetCoverage: PaperFacetCoverage[];
  selectedSetCoverage: Array<{
    facetId: string;
    label: string;
    required: boolean;
    coveredByPaperIds: string[];
    count: number;
  }>;
  missingRequiredFacets: ReviewFacet[];
  backgroundOnlyFacets: ReviewFacet[];
  adequacy: ReviewSelectionAdequacy;
  selectionRationale: string[];
};

type FacetPaper = {
  id: string;
  title: string;
  citation: string;
  abstract: string | null;
  venue: string | null;
  tags?: string[];
};

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

    if ((token.endsWith("ches") || token.endsWith("shes") || token.endsWith("xes")) && token.length > 5) {
      return token.slice(0, -2);
    }

    if (/(ous|ics|ss|is)$/.test(token)) {
      return token;
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

function slug(text: string): string {
  return normalizeWhitespace(text.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const facetStopTokens = new Set([
  ...stopTokens,
  "also",
  "affect",
  "affects",
  "available",
  "bounded",
  "clarify",
  "concrete",
  "distinguish",
  "exists",
  "explain",
  "first",
  "follow",
  "grounded",
  "likely",
  "next",
  "note",
  "open",
  "produce",
  "proposes",
  "realistic",
  "reliable",
  "speculation",
  "summarizes",
  "there"
]);

const singleTermFacetKinds: Array<{ pattern: RegExp; kind: ReviewFacetKind }> = [
  { pattern: /^(staffing|workforce|displacement|employment|labor|labour|quality|safety|costs?|outcomes?|impact|impacts?)$/, kind: "outcome" },
  { pattern: /^(verification|bounds?|control|computation|arithmetic|proof|implementation|architecture|runtime|memory|provenance)$/, kind: "method" },
  { pattern: /^(evaluation|benchmark|benchmarks|metrics?|baselines?)$/, kind: "evaluation" },
  { pattern: /^(patients?|residents?|caregivers?|workers?|nurses?)$/, kind: "population" },
  { pattern: /^(ai|automation|agents?|models?|algorithms?|tools?)$/, kind: "intervention" }
];

const protectedFacetPhrases: Array<{ pattern: RegExp; label: string; kind: ReviewFacetKind; aliases?: string[] }> = [
  {
    pattern: /\bnursing homes?\b/i,
    label: "nursing homes",
    kind: "population",
    aliases: ["nursing home", "nursing homes", "long-term care", "care homes"]
  },
  {
    pattern: /\blong[- ]term care\b/i,
    label: "long-term care",
    kind: "population",
    aliases: ["long-term care", "nursing home", "care home"]
  },
  {
    pattern: /\bcare quality\b/i,
    label: "care quality",
    kind: "outcome",
    aliases: ["care quality", "quality of care", "care outcomes"]
  },
  {
    pattern: /\bworkforce displacement\b/i,
    label: "workforce displacement",
    kind: "outcome",
    aliases: ["workforce displacement", "job displacement", "labor displacement", "labour displacement"]
  },
  {
    pattern: /\bstaffing patterns?\b/i,
    label: "staffing patterns",
    kind: "outcome",
    aliases: ["staffing", "staffing patterns", "workforce"]
  },
  {
    pattern: /\briemann zeta(?: zeros?| function)?\b/i,
    label: "Riemann zeta zeros",
    kind: "domain",
    aliases: ["Riemann zeta", "zeta zeros", "zeta function", "Riemann zeros"]
  },
  {
    pattern: /\brigorous numerical verification\b/i,
    label: "rigorous numerical verification",
    kind: "method",
    aliases: ["rigorous numerical verification", "numerical verification", "rigorous computation", "verified computation"]
  },
  {
    pattern: /\berror (?:bounds?|control)\b/i,
    label: "error bounds",
    kind: "method",
    aliases: ["error bounds", "error control", "error estimates", "rigorous error"]
  },
  {
    pattern: /\binterval arithmetic\b/i,
    label: "interval arithmetic",
    kind: "method",
    aliases: ["interval arithmetic", "ball arithmetic", "interval methods"]
  },
  {
    pattern: /\bautonomous research agents?\b/i,
    label: "autonomous research agents",
    kind: "domain",
    aliases: ["autonomous research agents", "research agents", "AI research agents"]
  },
  {
    pattern: /\bagent evaluation\b/i,
    label: "agent evaluation",
    kind: "evaluation",
    aliases: ["agent evaluation", "agent benchmarks", "research agent evaluation"]
  },
  {
    pattern: /\bliterature synthesis\b/i,
    label: "literature synthesis",
    kind: "task",
    aliases: ["literature synthesis", "literature review", "related work"]
  }
];

function classifyFacetKind(label: string): ReviewFacetKind {
  const normalized = normalizeText(label);

  if (/\b(nursing home|long term care|patients?|residents?|caregivers?|workforce|workers?|nurses?)\b/.test(normalized)) {
    return /\b(workforce|staffing|displacement)\b/.test(normalized) ? "outcome" : "population";
  }

  if (/\b(ai|automation|agent|model|algorithm|tool|intervention|adoption)\b/.test(normalized)) {
    return "intervention";
  }

  if (/\b(verification|bounds?|control|computation|arithmetic|method|proof|implementation|architecture|runtime|memory|provenance)\b/.test(normalized)) {
    return "method";
  }

  if (/\b(evaluation|benchmark|metric|baseline)\b/.test(normalized)) {
    return "evaluation";
  }

  if (/\b(staffing|workforce|displacement|quality|cost|safety|outcome|impact)\b/.test(normalized)) {
    return "outcome";
  }

  return "domain";
}

function facetAliases(label: string, kind: ReviewFacetKind): string[] {
  const normalized = normalizeWhitespace(label);
  const lower = normalized.toLowerCase();
  const aliases = new Set<string>([normalized]);

  for (const protectedPhrase of protectedFacetPhrases) {
    if (protectedPhrase.label.toLowerCase() === lower || protectedPhrase.aliases?.some((alias) => alias.toLowerCase() === lower)) {
      for (const alias of protectedPhrase.aliases ?? []) {
        aliases.add(alias);
      }
    }
  }

  if (kind === "evaluation") {
    aliases.add(`${normalized} evaluation`);
    aliases.add(`${normalized} benchmark`);
  }

  if (lower === "ai") {
    aliases.add("artificial intelligence");
    aliases.add("AI");
  }

  if (lower === "workforce") {
    aliases.add("staffing");
    aliases.add("labor");
    aliases.add("labour");
  }

  if (lower === "verification") {
    aliases.add("verified computation");
    aliases.add("rigorous computation");
  }

  return [...aliases];
}

function addFacet(
  facets: ReviewFacet[],
  label: string,
  kind: ReviewFacetKind,
  required: boolean,
  source: ReviewFacetSource,
  rationale: string,
  extraTerms: string[] = []
): void {
  const normalizedLabel = normalizeWhitespace(label)
    .replace(/\bai\b/i, "AI");

  if (normalizedLabel.length < 2) {
    return;
  }

  const key = slug(normalizedLabel);
  const existing = facets.find((facet) => slug(facet.label) === key || facet.id === `facet-${key}`);
  const terms = uniqueStrings([...facetAliases(normalizedLabel, kind), ...extraTerms]);

  if (existing !== undefined) {
    existing.required = existing.required || required;
    existing.terms = uniqueStrings([...existing.terms, ...terms]);
    if (source === "success_criterion" || source === "research_question") {
      existing.source = source;
    }
    return;
  }

  facets.push({
    id: `facet-${key}`,
    label: normalizedLabel,
    kind,
    required,
    terms,
    source,
    rationale
  });
}

function sourcePriority(source: ReviewFacetSource): number {
  switch (source) {
    case "topic":
      return 0;
    case "research_question":
      return 1;
    case "success_criterion":
      return 2;
    case "research_direction":
      return 3;
    case "plan_objective":
      return 4;
    case "plan_focus":
      return 5;
    case "plan_query":
      return 6;
    case "task_vocabulary":
      return 7;
  }
}

function facetTokens(text: string): string[] {
  return phraseTokens(text)
    .filter((token) => !facetStopTokens.has(token))
    .filter((token) => token.length >= 3 || preservedShortTokens.has(token));
}

function fieldFacetPhrases(text: string, limit: number): string[] {
  const tokens = facetTokens(text);
  const phrases: string[] = [];

  if (tokens.length === 0) {
    return [];
  }

  for (const size of [3, 2]) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phrase = tokens.slice(index, index + size).join(" ");
      if (!phrase.split(" ").every((token) => facetStopTokens.has(token))) {
        phrases.push(phrase);
      }
    }
  }

  for (const token of tokens) {
    if (singleTermFacetKinds.some((entry) => entry.pattern.test(token))) {
      phrases.push(token);
    }
  }

  return uniqueStrings(phrases)
    .filter((phrase) => phrase.length >= 3)
    .slice(0, limit);
}

function addFacetsFromField(
  facets: ReviewFacet[],
  text: string | null,
  source: ReviewFacetSource,
  requiredByDefault: boolean,
  phraseLimit: number
): void {
  if (text === null || normalizeWhitespace(text).length === 0) {
    return;
  }

  for (const protectedPhrase of protectedFacetPhrases) {
    if (protectedPhrase.pattern.test(text)) {
      addFacet(
        facets,
        protectedPhrase.label,
        protectedPhrase.kind,
        requiredByDefault || source === "success_criterion" || source === "research_question",
        source,
        `Extracted from ${source.replace(/_/g, " ")}.`,
        protectedPhrase.aliases ?? []
      );
    }
  }

  for (const phrase of fieldFacetPhrases(text, phraseLimit)) {
    const kind = classifyFacetKind(phrase);
    const singleKind = singleTermFacetKinds.find((entry) => entry.pattern.test(phrase))?.kind;
    addFacet(
      facets,
      phrase,
      singleKind ?? kind,
      requiredByDefault && kind !== "task",
      source,
      `Extracted from ${source.replace(/_/g, " ")}.`
    );
  }
}

export function buildReviewFacets(input: {
  brief: ResearchBrief;
  plan: ResearchPlan;
  profile?: LiteratureReviewProfile | null;
}): ReviewFacet[] {
  const facets: ReviewFacet[] = [];

  addFacetsFromField(facets, input.brief.topic, "topic", true, 3);
  addFacetsFromField(facets, input.brief.researchQuestion, "research_question", true, 6);
  addFacetsFromField(facets, input.brief.researchDirection, "research_direction", false, 4);
  addFacetsFromField(facets, input.brief.successCriterion, "success_criterion", true, 6);
  addFacetsFromField(facets, input.plan.objective, "plan_objective", false, 4);

  for (const focus of input.plan.localFocus.slice(0, 6)) {
    addFacetsFromField(facets, focus, "plan_focus", false, 2);
  }

  for (const query of input.plan.searchQueries.slice(0, 6)) {
    addFacetsFromField(facets, query, "plan_query", false, 2);
  }

  for (const anchor of input.profile?.domainAnchors ?? []) {
    addFacet(facets, anchor, classifyFacetKind(anchor), false, "task_vocabulary", "Retained from the literature-review profile domain anchors.");
  }

  const sorted = facets
    .sort((left, right) => {
      return Number(right.required) - Number(left.required)
        || sourcePriority(left.source) - sourcePriority(right.source)
        || right.terms.length - left.terms.length
        || left.label.localeCompare(right.label);
    });

  const required = sorted.filter((facet) => facet.required).slice(0, 8);
  const optional = sorted.filter((facet) => !facet.required).slice(0, Math.max(0, 14 - required.length));
  const selected = [...required, ...optional];

  if (selected.length === 0 && input.brief.topic !== null) {
    addFacet(selected, input.brief.topic, "domain", true, "topic", "Fallback topic facet.");
  }

  return selected.map((facet, index) => ({
    ...facet,
    id: `facet-${index + 1}-${slug(facet.label)}`
  }));
}

function termMatchesText(term: string, normalizedText: string, tokens: Set<string>): boolean {
  const termTokens = phraseTokens(term);

  if (termTokens.length === 0) {
    return false;
  }

  if (termTokens.length === 1) {
    return tokens.has(termTokens[0]!);
  }

  const normalizedTerm = normalizeText(term);
  return normalizedText.includes(normalizedTerm)
    || termTokens.every((token) => tokens.has(token));
}

export function assessPaperFacetCoverage(
  facets: ReviewFacet[],
  paper: FacetPaper
): PaperFacetCoverage {
  const normalizedText = normalizeText([
    paper.title,
    paper.abstract,
    paper.citation,
    paper.venue,
    ...(paper.tags ?? [])
  ].filter((value): value is string => typeof value === "string").join(" "));
  const tokens = new Set(phraseTokens(normalizedText));
  const coveredFacetIds: string[] = [];
  const matchedTerms: string[] = [];

  for (const facet of facets) {
    const matches = facet.terms.filter((term) => termMatchesText(term, normalizedText, tokens));

    if (matches.length === 0) {
      continue;
    }

    coveredFacetIds.push(facet.id);
    matchedTerms.push(...matches.map((term) => `${facet.label}: ${term}`));
  }

  const missingRequiredFacetIds = facets
    .filter((facet) => facet.required && !coveredFacetIds.includes(facet.id))
    .map((facet) => facet.id);
  const coverageScore = facets.reduce((score, facet) => (
    coveredFacetIds.includes(facet.id)
      ? score + (facet.required ? 4 : 2)
      : score
  ), 0);

  return {
    paperId: paper.id,
    coveredFacetIds,
    missingRequiredFacetIds,
    coverageScore,
    matchedTerms: uniqueStrings(matchedTerms).slice(0, 16),
    rationale: coveredFacetIds.length === 0
      ? "No required or optional review facets were visible in the paper metadata available for screening."
      : `Covered ${coveredFacetIds.length} review facets from the available metadata.`
  };
}

export function buildReviewSelectionQuality(input: {
  facets: ReviewFacet[];
  papers: FacetPaper[];
  selectedPaperIds: string[];
}): ReviewSelectionQuality {
  const selectedPaperIds = new Set(input.selectedPaperIds);
  const paperFacetCoverage = input.papers.map((paper) => assessPaperFacetCoverage(input.facets, paper));
  const coverageByPaperId = new Map(paperFacetCoverage.map((coverage) => [coverage.paperId, coverage]));
  const selectedSetCoverage = input.facets.map((facet) => {
    const coveredByPaperIds = input.selectedPaperIds.filter((paperId) => (
      coverageByPaperId.get(paperId)?.coveredFacetIds.includes(facet.id) ?? false
    ));

    return {
      facetId: facet.id,
      label: facet.label,
      required: facet.required,
      coveredByPaperIds,
      count: coveredByPaperIds.length
    };
  });
  const missingRequiredFacets = input.facets.filter((facet) => (
    facet.required
    && (selectedSetCoverage.find((entry) => entry.facetId === facet.id)?.count ?? 0) === 0
  ));
  const backgroundOnlyFacets = missingRequiredFacets.filter((facet) => (
    paperFacetCoverage.some((coverage) => coverage.coveredFacetIds.includes(facet.id) && !selectedPaperIds.has(coverage.paperId))
  ));
  const coveredRequiredCount = input.facets.filter((facet) => (
    facet.required
    && (selectedSetCoverage.find((entry) => entry.facetId === facet.id)?.count ?? 0) > 0
  )).length;
  const requiredCount = input.facets.filter((facet) => facet.required).length;
  const adequacy: ReviewSelectionAdequacy = input.selectedPaperIds.length === 0 || coveredRequiredCount === 0
    ? "thin"
    : missingRequiredFacets.length === 0 && input.selectedPaperIds.length >= 3
      ? "strong"
      : "partial";
  const selectionRationale = [
    `Selected ${input.selectedPaperIds.length} reviewed papers against ${requiredCount} required facets and ${input.facets.length - requiredCount} optional facets.`,
    missingRequiredFacets.length === 0
      ? "All required review facets are represented in the selected reviewed set."
      : `Missing required facets in the selected reviewed set: ${missingRequiredFacets.map((facet) => facet.label).join(", ")}.`,
    backgroundOnlyFacets.length > 0
      ? `Some missing facets appear only in unselected/background candidates: ${backgroundOnlyFacets.map((facet) => facet.label).join(", ")}.`
      : null
  ].filter((line): line is string => line !== null);

  return {
    schemaVersion: 1,
    requiredFacets: input.facets.filter((facet) => facet.required),
    optionalFacets: input.facets.filter((facet) => !facet.required),
    paperFacetCoverage,
    selectedSetCoverage,
    missingRequiredFacets,
    backgroundOnlyFacets,
    adequacy,
    selectionRationale
  };
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
  selectionQuality?: ReviewSelectionQuality | null;
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
        claim: 0,
        finding: 0,
        question: 0,
        idea: 0,
        summary: 0,
        artifact: 0,
        direction: 0,
        hypothesis: 0,
        method_plan: 0
      },
      claims: [],
      findings: [],
      questions: [],
      ideas: [],
      summaries: [],
      artifacts: [],
      directions: [],
      hypotheses: [],
      methodPlans: [],
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
    "Use review selection quality as an evidence-boundary report: if required facets are missing or only partially covered, say so and keep direct claims inside the covered facets.",
    "Do not turn adjacent literature into direct evidence for a success-criterion facet that is missing from the selected reviewed set.",
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
    `Review selection quality: ${JSON.stringify(input.selectionQuality ?? null)}`,
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
