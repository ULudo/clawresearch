import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectMemoryContext } from "./memory-store.js";
import type { ResearchBrief } from "./session-store.js";
import type { ResearchPlan } from "./research-backend.js";
import {
  assessLiteratureSource,
  buildLiteratureReviewProfile,
  shouldUseLiteratureReviewSubsystem,
  type LiteratureReviewProfile,
  type LiteratureSourceAssessment
} from "./literature-review.js";

const ignoredDirectories = new Set([
  ".git",
  ".clawresearch",
  "node_modules",
  "dist"
]);

const textExtensions = new Set([
  ".md",
  ".txt",
  ".rst",
  ".yaml",
  ".yml"
]);

const openAlexBaseUrl = process.env.CLAWRESEARCH_OPENALEX_BASE_URL ?? "https://api.openalex.org";
const wikipediaBaseUrl = process.env.CLAWRESEARCH_WIKIPEDIA_BASE_URL ?? "https://en.wikipedia.org";

export type ResearchSourceKind =
  | "project_brief"
  | "local_file"
  | "openalex_work"
  | "wikipedia_article";

export type ResearchSource = {
  id: string;
  kind: ResearchSourceKind;
  title: string;
  locator: string | null;
  citation: string;
  excerpt: string;
  assessment?: LiteratureSourceAssessment;
};

export type ResearchSourceGatherResult = {
  sources: ResearchSource[];
  notes: string[];
  literatureReview?: {
    active: boolean;
    profile: LiteratureReviewProfile;
    selectedAssessments: Array<{
      sourceId: string;
      title: string;
      assessment: LiteratureSourceAssessment;
    }>;
  } | null;
};

export type ResearchSourceGatherRequest = {
  projectRoot: string;
  brief: ResearchBrief;
  plan: ResearchPlan;
  memoryContext: ProjectMemoryContext;
};

export interface ResearchSourceGatherer {
  gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult>;
}

type OpenAlexWork = {
  id?: string;
  display_name?: string;
  publication_year?: number;
  authorships?: Array<{
    author?: {
      display_name?: string;
    };
  }>;
  primary_location?: {
    source?: {
      display_name?: string;
    };
    landing_page_url?: string;
  };
  doi?: string;
  abstract_inverted_index?: Record<string, number[]>;
};

type OpenAlexResponse = {
  results?: OpenAlexWork[];
};

type WikipediaSearchResponse = {
  query?: {
    search?: Array<{
      title?: string;
    }>;
  };
};

type WikipediaSummaryResponse = {
  title?: string;
  extract?: string;
  content_urls?: {
    desktop?: {
      page?: string;
    };
  };
};

const stopTokens = new Set([
  "about",
  "after",
  "alternative",
  "analysis",
  "approaches",
  "approach",
  "current",
  "evaluation",
  "existing",
  "flaws",
  "focus",
  "hypothesis",
  "identify",
  "identifying",
  "literature",
  "method",
  "methodologies",
  "methods",
  "potential",
  "proof",
  "proofs",
  "question",
  "research",
  "strategies",
  "strategy",
  "study",
  "technique",
  "techniques",
  "theory",
  "through"
]);

const preservedShortTokens = new Set([
  "ai",
  "agi",
  "api",
  "cpu",
  "cv",
  "dna",
  "gpu",
  "llm",
  "ml",
  "nlp",
  "rna",
  "rl",
  "ui",
  "ux"
]);

const shortTokenAliases: Record<string, string[]> = {
  ai: ["artificial intelligence"],
  agi: ["artificial general intelligence"],
  cv: ["computer vision"],
  llm: ["large language model", "large language models"],
  ml: ["machine learning"],
  nlp: ["natural language processing"],
  rl: ["reinforcement learning"]
};

type AnchorPhrase = {
  scope: "primary" | "secondary";
  text: string;
  tokens: string[];
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function excerptText(text: string, limit = 1200): string {
  const normalized = normalizeWhitespace(text);
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 3)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter((token) => token.length >= 4 || preservedShortTokens.has(token));
}

function normalizePhraseToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }

  if (token.endsWith("s") && token.length > 4) {
    return token.slice(0, -1);
  }

  return token;
}

function phraseTokens(text: string): string[] {
  return tokenize(text).map((token) => normalizePhraseToken(token));
}

function shortSignalTokens(text: string | null): string[] {
  if (text === null) {
    return [];
  }

  return tokenize(text).filter((token) => preservedShortTokens.has(token));
}

function overlapScore(text: string, referenceTokens: Set<string>): number {
  const tokens = new Set(tokenize(text));
  let score = 0;

  for (const token of tokens) {
    if (referenceTokens.has(token)) {
      score += 1;
    }
  }

  return score;
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

function salientQueryTail(text: string | null): string {
  if (text === null) {
    return "";
  }

  return tokenize(text)
    .filter((token) => !stopTokens.has(token))
    .slice(0, 5)
    .join(" ");
}

function extractAnchorPhrases(text: string | null): string[] {
  if (text === null) {
    return [];
  }

  const filteredTokens = tokenize(text)
    .filter((token) => !stopTokens.has(token));

  if (filteredTokens.length === 0) {
    return [];
  }

  const anchors = new Set<string>();

  if (filteredTokens.length <= 3) {
    anchors.add(filteredTokens.join(" "));
  }

  if (filteredTokens.length >= 2) {
    anchors.add(filteredTokens.slice(0, 2).join(" "));
    anchors.add(filteredTokens.slice(-2).join(" "));
  } else {
    anchors.add(filteredTokens[0]!);
  }

  if (filteredTokens.length >= 3) {
    anchors.add(filteredTokens.slice(-3).join(" "));
  }

  const segmentMatch = normalizeWhitespace(text.toLowerCase())
    .replace(/[^a-z0-9\s-]/g, " ")
    .match(/\b(?:in|for|of|on|about|around|within|across|between|toward|towards|into|via|using)\s+([a-z0-9\s-]{4,})$/i);

  if (segmentMatch?.[1] !== undefined) {
    const segmentTokens = tokenize(segmentMatch[1])
      .filter((token) => !stopTokens.has(token));

    if (segmentTokens.length > 0) {
      anchors.add(segmentTokens.slice(-3).join(" "));

      if (segmentTokens.length >= 2) {
        anchors.add(segmentTokens.slice(-2).join(" "));
      }
    }
  }

  return [...anchors]
    .map((anchor) => normalizeWhitespace(anchor))
    .filter((anchor) => anchor.length > 0);
}

function extractPrimaryTopicAnchors(text: string | null): string[] {
  if (text === null) {
    return [];
  }

  const normalized = normalizeWhitespace(text.toLowerCase())
    .replace(/[^a-z0-9\s-]/g, " ");
  const fullTokens = normalized
    .split(/\s+/)
    .filter((token) => token.length >= 3 || preservedShortTokens.has(token));

  if (fullTokens.length === 0) {
    return [];
  }

  const anchors = new Set<string>();

  if (fullTokens.length <= 4) {
    anchors.add(fullTokens.join(" "));
  }

  if (fullTokens.length >= 2) {
    anchors.add(fullTokens.slice(0, 2).join(" "));
    anchors.add(fullTokens.slice(-2).join(" "));
  } else {
    anchors.add(fullTokens[0]!);
  }

  if (fullTokens.length >= 3) {
    anchors.add(fullTokens.slice(0, 3).join(" "));
    anchors.add(fullTokens.slice(-3).join(" "));
  }

  return [...anchors]
    .map((anchor) => normalizeWhitespace(anchor))
    .filter((anchor) => anchor.length > 0);
}

function scopedAnchorPhrases(
  scope: AnchorPhrase["scope"],
  texts: Array<string | null | undefined>,
  limit: number
): AnchorPhrase[] {
  return uniqueStrings(texts.flatMap((text) => extractAnchorPhrases(text ?? null)))
    .flatMap((text) => {
      const tokens = phraseTokens(text);

      if (tokens.length === 0) {
        return [];
      }

      return [{
        scope,
        text,
        tokens
      }];
    })
    .slice(0, limit);
}

function buildAnchorPhrases(request: ResearchSourceGatherRequest): AnchorPhrase[] {
  return [
    ...uniqueStrings([
      ...extractPrimaryTopicAnchors(request.brief.topic),
      ...extractAnchorPhrases(request.brief.topic)
    ]).flatMap((text) => {
      const tokens = phraseTokens(text);

      if (tokens.length === 0) {
        return [];
      }

      return [{
        scope: "primary" as const,
        text,
        tokens
      }];
    }).slice(0, 5),
    ...scopedAnchorPhrases("secondary", [
      request.brief.researchQuestion,
      request.brief.researchDirection,
      ...request.plan.localFocus
    ], 5)
  ].slice(0, 8);
}

function containsOrderedAnchor(textTokens: string[], anchorTokens: string[], maxGap = 2): boolean {
  if (anchorTokens.length === 0) {
    return false;
  }

  if (anchorTokens.length === 1) {
    return textTokens.includes(anchorTokens[0]!);
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
        if (candidateIndex - textIndex - 1 > maxGap) {
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

function countAnchorMatches(
  textTokens: string[],
  anchors: AnchorPhrase[]
): {
  primaryStrong: number;
  primaryWeak: number;
  secondaryStrong: number;
  secondaryWeak: number;
} {
  let primaryStrong = 0;
  let primaryWeak = 0;
  let secondaryStrong = 0;
  let secondaryWeak = 0;

  for (const anchor of anchors) {
    const matches = containsOrderedAnchor(textTokens, anchor.tokens);

    if (!matches) {
      continue;
    }

    if (anchor.tokens.length >= 2) {
      if (anchor.scope === "primary") {
        primaryStrong += 1;
      } else {
        secondaryStrong += 1;
      }
    } else {
      if (anchor.scope === "primary") {
        primaryWeak += 1;
      } else {
        secondaryWeak += 1;
      }
    }
  }

  return {
    primaryStrong,
    primaryWeak,
    secondaryStrong,
    secondaryWeak
  };
}

function matchesRequiredShortToken(text: string, tokens: string[]): boolean {
  const normalized = normalizeWhitespace(text.toLowerCase());
  const textTokenSet = new Set(tokenize(text));

  return tokens.some((token) => (
    textTokenSet.has(token)
    || (shortTokenAliases[token] ?? []).some((alias) => normalized.includes(alias))
  ));
}

function buildOpenAlexQueries(
  request: ResearchSourceGatherRequest,
  literatureProfile: LiteratureReviewProfile | null
): string[] {
  const topic = request.brief.topic;
  const questionTail = salientQueryTail(request.brief.researchQuestion);
  const anchorQueries = buildAnchorPhrases(request)
    .map((anchor) => anchor.text);

  return uniqueStrings([
    ...request.memoryContext.queryHints,
    ...request.memoryContext.queryHints.map((hint) => {
      if (topic === null) {
        return hint;
      }

      return `${topic} ${hint}`;
    }),
    ...anchorQueries,
    ...anchorQueries.map((anchor) => (
      questionTail.length > 0
        ? `${anchor} ${questionTail}`
        : null
    )),
    ...(literatureProfile?.searchQueries ?? []),
    ...(request.plan.searchQueries ?? []),
    topic,
    topic !== null && questionTail.length > 0
      ? `${topic} ${questionTail}`
      : null,
    request.brief.researchQuestion,
    request.brief.researchDirection
  ]).slice(0, 8);
}

async function collectCandidateTextFiles(
  projectRoot: string,
  currentDirectory = projectRoot,
  relativeDirectory = "",
  output: string[] = []
): Promise<string[]> {
  if (output.length >= 200) {
    return output;
  }

  const entries = await readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (output.length >= 200) {
      break;
    }

    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      await collectCandidateTextFiles(projectRoot, absolutePath, relativePath, output);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    output.push(path.join(projectRoot, relativePath));
  }

  return output;
}

async function gatherLocalFileSources(
  request: ResearchSourceGatherRequest
): Promise<ResearchSource[]> {
  const candidateFiles = await collectCandidateTextFiles(request.projectRoot);
  const referenceTokens = new Set([
    ...tokenize(request.brief.topic ?? ""),
    ...tokenize(request.brief.researchQuestion ?? ""),
    ...tokenize(request.brief.researchDirection ?? ""),
    ...request.plan.searchQueries.flatMap(tokenize),
    ...request.plan.localFocus.flatMap(tokenize),
    ...request.memoryContext.queryHints.flatMap(tokenize),
    ...request.memoryContext.localFileHints.flatMap(tokenize)
  ]);

  const scored = await Promise.all(candidateFiles.map(async (filePath) => {
    try {
      const contents = await readFile(filePath, "utf8");
      const score = overlapScore(filePath, referenceTokens) + overlapScore(contents.slice(0, 3000), referenceTokens);
      return {
        filePath,
        score,
        contents
      };
    } catch {
      return null;
    }
  }));

  return scored
    .filter((entry): entry is { filePath: string; score: number; contents: string } => entry !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((entry, index) => ({
      id: `local-${index + 1}`,
      kind: "local_file" as const,
      title: path.relative(request.projectRoot, entry.filePath),
      locator: entry.filePath,
      citation: path.relative(request.projectRoot, entry.filePath),
      excerpt: excerptText(entry.contents)
    }));
}

export async function collectResearchLocalFileHints(
  projectRoot: string,
  brief: ResearchBrief
): Promise<string[]> {
  const candidateFiles = await collectCandidateTextFiles(projectRoot);
  const referenceTokens = new Set([
    ...tokenize(brief.topic ?? ""),
    ...tokenize(brief.researchQuestion ?? ""),
    ...tokenize(brief.researchDirection ?? "")
  ]);

  const scored = await Promise.all(candidateFiles.map(async (filePath) => {
    try {
      const contents = await readFile(filePath, "utf8");
      return {
        filePath,
        score: overlapScore(filePath, referenceTokens) + overlapScore(contents.slice(0, 2500), referenceTokens)
      };
    } catch {
      return null;
    }
  }));

  return scored
    .filter((entry): entry is { filePath: string; score: number } => entry !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((entry) => path.relative(projectRoot, entry.filePath));
}

function invertAbstract(index: Record<string, number[]> | undefined): string | null {
  if (index === undefined || index === null || typeof index !== "object") {
    return null;
  }

  const tokens: string[] = [];

  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) {
      continue;
    }

    for (const position of positions) {
      if (typeof position === "number" && Number.isInteger(position) && position >= 0) {
        tokens[position] = word;
      }
    }
  }

  const abstract = tokens.filter((token) => typeof token === "string" && token.length > 0).join(" ");
  return abstract.length > 0 ? abstract : null;
}

function openAlexAuthors(work: OpenAlexWork): string {
  const names = (work.authorships ?? [])
    .map((authorship) => authorship.author?.display_name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .slice(0, 3);

  if (names.length === 0) {
    return "Unknown authors";
  }

  return names.join(", ");
}

async function searchOpenAlex(query: string): Promise<OpenAlexWork[]> {
  const url = new URL("/works", openAlexBaseUrl);
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", "4");

  const response = await fetch(url, {
    headers: {
      "accept": "application/json"
    },
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    throw new Error(`OpenAlex request failed with ${response.status} ${response.statusText}`);
  }

  const payload = asRecord(await response.json());

  if (payload === null) {
    throw new Error("OpenAlex returned a malformed JSON payload.");
  }

  const results = payload.results;
  return Array.isArray(results)
    ? results.filter((entry): entry is OpenAlexWork => typeof entry === "object" && entry !== null)
    : [];
}

async function searchWikipediaTitles(query: string): Promise<string[]> {
  const url = new URL("/w/api.php", wikipediaBaseUrl);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("utf8", "1");
  url.searchParams.set("srlimit", "5");
  url.searchParams.set("origin", "*");

  const response = await fetch(url, {
    headers: {
      "accept": "application/json"
    },
    signal: AbortSignal.timeout(15_000)
  });

  if (!response.ok) {
    throw new Error(`Wikipedia request failed with ${response.status} ${response.statusText}`);
  }

  const payload = asRecord(await response.json());
  const queryRecord = payload === null ? null : asRecord(payload.query);
  const searchResults = queryRecord === null ? [] : queryRecord.search;

  return (Array.isArray(searchResults) ? searchResults : [])
    .map((result) => normalizeWhitespace(result.title ?? ""))
    .filter((title) => title.length > 0);
}

async function fetchWikipediaSummary(title: string): Promise<ResearchSource | null> {
  const url = new URL(`/api/rest_v1/page/summary/${encodeURIComponent(title)}`, wikipediaBaseUrl);

  const response = await fetch(url, {
    headers: {
      "accept": "application/json"
    },
    signal: AbortSignal.timeout(15_000)
  });

  if (!response.ok) {
    throw new Error(`Wikipedia summary request failed with ${response.status} ${response.statusText}`);
  }

  const payload = asRecord(await response.json());

  if (payload === null) {
    throw new Error("Wikipedia summary returned a malformed JSON payload.");
  }

  const summaryTitle = stringOrNull(payload.title) ?? title;
  const extract = stringOrNull(payload.extract);
  const contentUrls = asRecord(payload.content_urls);
  const desktopUrls = contentUrls === null ? null : asRecord(contentUrls.desktop);
  const pageUrl = desktopUrls === null ? null : stringOrNull(desktopUrls.page);

  if (extract === null) {
    return null;
  }

  return {
    id: "",
    kind: "wikipedia_article",
    title: summaryTitle,
    locator: pageUrl,
    citation: `${summaryTitle}. Wikipedia.`,
    excerpt: excerptText(extract)
  };
}

async function rescueQueriesFromWikipedia(
  request: ResearchSourceGatherRequest
): Promise<{ queries: string[]; notes: string[] }> {
  const notes: string[] = [];
  const suggestions = new Set<string>();

  for (const seedQuery of uniqueStrings([
    request.brief.topic,
    request.plan.searchQueries[0]
  ])) {
    try {
      const titles = await searchWikipediaTitles(seedQuery);

      for (const title of titles.slice(0, 3)) {
        if (title.toLowerCase() !== seedQuery.toLowerCase()) {
          suggestions.add(title);
        }
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Unknown Wikipedia failure.";
      notes.push(`Wikipedia rescue query failed for "${seedQuery}": ${message}`);
    }
  }

  const rescuedQueries = [...suggestions].flatMap((title) => {
    const questionTail = salientQueryTail(request.brief.researchQuestion);

    return uniqueStrings([
      title,
      questionTail.length > 0 ? `${title} ${questionTail}` : null
    ]);
  });

  if (rescuedQueries.length > 0) {
    notes.push(`Added ${rescuedQueries.length} rescue queries from Wikipedia title suggestions.`);
  }

  return {
    queries: rescuedQueries,
    notes
  };
}

async function gatherOpenAlexSources(
  request: ResearchSourceGatherRequest,
  literatureProfile: LiteratureReviewProfile | null
): Promise<ResearchSourceGatherResult> {
  const notes: string[] = [];
  const candidates: Array<ResearchSource & { score: number }> = [];
  const seenTitles = new Set<string>();
  const attemptedQueries = new Set<string>();
  let filteredLowRelevanceCount = 0;
  let titleOnlyCandidateCount = 0;
  const referenceTokens = new Set([
    ...tokenize(request.brief.topic ?? ""),
    ...tokenize(request.brief.researchQuestion ?? ""),
    ...tokenize(request.brief.researchDirection ?? ""),
    ...request.plan.searchQueries.flatMap(tokenize),
    ...request.plan.localFocus.flatMap(tokenize),
    ...request.memoryContext.queryHints.flatMap(tokenize),
    ...request.memoryContext.localFileHints.flatMap(tokenize)
  ]);
  const anchorPhrases = buildAnchorPhrases(request);
  const primaryStrongAnchorCount = anchorPhrases.filter((anchor) => anchor.scope === "primary" && anchor.tokens.length >= 2).length;
  const hasPrimaryStrongAnchors = anchorPhrases.some((anchor) => anchor.scope === "primary" && anchor.tokens.length >= 2);
  const hasStrongAnchors = anchorPhrases.some((anchor) => anchor.tokens.length >= 2);
  const requiredShortTokens = uniqueStrings([
    ...shortSignalTokens(request.brief.topic),
    ...shortSignalTokens(request.brief.researchQuestion)
  ]);
  const normalizedTopic = normalizeWhitespace((request.brief.topic ?? "").toLowerCase());
  const searchQueries = buildOpenAlexQueries(request, literatureProfile);

  async function collectFromQuery(query: string): Promise<void> {
    if (attemptedQueries.has(query.toLowerCase())) {
      return;
    }

    attemptedQueries.add(query.toLowerCase());

    try {
      const works = await searchOpenAlex(query);

      for (const work of works) {
        const title = normalizeWhitespace(work.display_name ?? "");

        if (title.length === 0) {
          continue;
        }

        const normalizedTitle = title.toLowerCase();

        if (seenTitles.has(normalizedTitle)) {
          continue;
        }

        const abstract = invertAbstract(work.abstract_inverted_index);
        const excerpt = abstract ?? `OpenAlex did not provide an abstract for this work. Title-only evidence: ${title}.`;

        seenTitles.add(normalizedTitle);

        const sourceName = work.primary_location?.source?.display_name ?? "OpenAlex";
        const year = work.publication_year ?? "n.d.";
        const locator = work.doi ?? work.primary_location?.landing_page_url ?? work.id ?? null;
        const combinedTokens = phraseTokens(`${title} ${abstract ?? ""}`);
        const anchorMatches = countAnchorMatches(combinedTokens, anchorPhrases);
        const referenceOverlap = overlapScore(title, referenceTokens) * 3
          + overlapScore(abstract ?? "", referenceTokens);
        const shortTokenMatch = requiredShortTokens.length === 0
          || matchesRequiredShortToken(`${title} ${abstract ?? ""}`, requiredShortTokens);
        const score = referenceOverlap
          + anchorMatches.primaryStrong * 10
          + anchorMatches.primaryWeak * 3
          + anchorMatches.secondaryStrong * 5
          + anchorMatches.secondaryWeak
          + (normalizedTopic.length > 0 && normalizedTitle.includes(normalizedTopic) ? 5 : 0)
          - (abstract === null ? 4 : 0);
        const relevantEnough = hasPrimaryStrongAnchors
          ? primaryStrongAnchorCount >= 2
            ? anchorMatches.primaryStrong >= 2
            : anchorMatches.primaryStrong >= 1 || referenceOverlap >= 14
          : hasStrongAnchors
            ? anchorMatches.primaryStrong + anchorMatches.secondaryStrong > 0 || referenceOverlap >= 7
            : referenceOverlap >= 3 || anchorMatches.primaryWeak + anchorMatches.secondaryWeak > 0;
        const titleOnlyRelevantEnough = abstract !== null
          ? relevantEnough
          : (anchorMatches.primaryStrong >= 1 || normalizedTitle.includes(normalizedTopic))
            && referenceOverlap >= 3;

        if (!titleOnlyRelevantEnough || !shortTokenMatch) {
          filteredLowRelevanceCount += 1;
          continue;
        }

        if (abstract === null) {
          titleOnlyCandidateCount += 1;
        }

        const candidate: ResearchSource & { score: number } = {
          id: "",
          kind: "openalex_work",
          title,
          locator,
          citation: `${openAlexAuthors(work)} (${year}). ${title}. ${sourceName}.`,
          excerpt: excerptText(excerpt),
          score
        };

        if (literatureProfile !== null) {
          const assessment = assessLiteratureSource(literatureProfile, candidate);

          if (!assessment.accepted) {
            filteredLowRelevanceCount += 1;
            continue;
          }

          candidate.assessment = assessment;
          candidate.score = Math.max(candidate.score, assessment.totalScore);
        }

        candidates.push(candidate);
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Unknown OpenAlex failure.";
      notes.push(`OpenAlex query failed for "${query}": ${message}`);
    }
  }

  for (const query of searchQueries.slice(0, 5)) {
    await collectFromQuery(query);
  }

  if (candidates.length === 0) {
    const rescue = await rescueQueriesFromWikipedia(request);
    notes.push(...rescue.notes);

    for (const query of rescue.queries.slice(0, 5)) {
      await collectFromQuery(query);
    }
  }

  if (filteredLowRelevanceCount > 0) {
    notes.push(`Filtered ${filteredLowRelevanceCount} low-relevance OpenAlex candidates that did not match the project anchors closely enough.`);
  }

  if (titleOnlyCandidateCount > 0) {
    notes.push(`Retained ${titleOnlyCandidateCount} strongly matched OpenAlex works even though OpenAlex did not provide abstracts for them.`);
  }

  return {
    sources: candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, 6)
      .map((candidate, index) => ({
        id: `web-${index + 1}`,
        kind: candidate.kind,
        title: candidate.title,
        locator: candidate.locator,
        citation: candidate.citation,
        excerpt: candidate.excerpt,
        assessment: candidate.assessment
      })),
    notes
  };
}

function sourceReferenceOverlap(
  source: Pick<ResearchSource, "title" | "excerpt">,
  referenceTokens: Set<string>
): number {
  return overlapScore(source.title, referenceTokens) * 3
    + overlapScore(source.excerpt, referenceTokens);
}

function sourceAnchorMatches(
  source: Pick<ResearchSource, "title" | "excerpt">,
  anchorPhrases: AnchorPhrase[]
): ReturnType<typeof countAnchorMatches> {
  return countAnchorMatches(
    phraseTokens(`${source.title} ${source.excerpt}`),
    anchorPhrases
  );
}

function sourceMatchesProjectAnchors(
  source: Pick<ResearchSource, "title" | "excerpt">,
  anchorPhrases: AnchorPhrase[],
  referenceTokens: Set<string>,
  requiredShortTokens: string[],
  normalizedTopic: string,
  primaryStrongAnchorCount: number,
  hasPrimaryStrongAnchors: boolean,
  hasStrongAnchors: boolean
): { relevantEnough: boolean; score: number; shortTokenMatch: boolean } {
  const anchorMatches = sourceAnchorMatches(source, anchorPhrases);
  const referenceOverlap = sourceReferenceOverlap(source, referenceTokens);
  const shortTokenMatch = requiredShortTokens.length === 0
    || matchesRequiredShortToken(`${source.title} ${source.excerpt}`, requiredShortTokens);
  const score = referenceOverlap
    + anchorMatches.primaryStrong * 10
    + anchorMatches.primaryWeak * 3
    + anchorMatches.secondaryStrong * 5
    + anchorMatches.secondaryWeak
    + (normalizedTopic.length > 0 && source.title.toLowerCase().includes(normalizedTopic) ? 5 : 0);
  const relevantEnough = hasPrimaryStrongAnchors
    ? primaryStrongAnchorCount >= 2
      ? anchorMatches.primaryStrong >= 2
      : anchorMatches.primaryStrong >= 1 || referenceOverlap >= 14
    : hasStrongAnchors
      ? anchorMatches.primaryStrong + anchorMatches.secondaryStrong > 0 || referenceOverlap >= 7
      : referenceOverlap >= 3 || anchorMatches.primaryWeak + anchorMatches.secondaryWeak > 0;

  return {
    relevantEnough,
    score,
    shortTokenMatch
  };
}

async function gatherWikipediaFallbackSources(
  request: ResearchSourceGatherRequest,
  existingTitles: Set<string>,
  literatureProfile: LiteratureReviewProfile | null
): Promise<ResearchSourceGatherResult> {
  const notes: string[] = [];
  const candidates: Array<ResearchSource & { score: number }> = [];
  const attemptedTitles = new Set<string>();
  let filteredLowRelevanceCount = 0;
  const referenceTokens = new Set([
    ...tokenize(request.brief.topic ?? ""),
    ...tokenize(request.brief.researchQuestion ?? ""),
    ...tokenize(request.brief.researchDirection ?? ""),
    ...request.plan.searchQueries.flatMap(tokenize),
    ...request.plan.localFocus.flatMap(tokenize),
    ...request.memoryContext.queryHints.flatMap(tokenize),
    ...request.memoryContext.localFileHints.flatMap(tokenize)
  ]);
  const anchorPhrases = buildAnchorPhrases(request);
  const primaryStrongAnchorCount = anchorPhrases.filter((anchor) => anchor.scope === "primary" && anchor.tokens.length >= 2).length;
  const hasPrimaryStrongAnchors = anchorPhrases.some((anchor) => anchor.scope === "primary" && anchor.tokens.length >= 2);
  const hasStrongAnchors = anchorPhrases.some((anchor) => anchor.tokens.length >= 2);
  const requiredShortTokens = uniqueStrings([
    ...shortSignalTokens(request.brief.topic),
    ...shortSignalTokens(request.brief.researchQuestion)
  ]);
  const normalizedTopic = normalizeWhitespace((request.brief.topic ?? "").toLowerCase());
  const seedQueries = uniqueStrings([
    request.brief.topic,
    ...request.plan.searchQueries,
    ...request.memoryContext.queryHints
  ]).slice(0, 4);

  for (const query of seedQueries) {
    try {
      const titles = await searchWikipediaTitles(query);

      for (const title of titles.slice(0, 3)) {
        const normalizedTitle = title.toLowerCase();

        if (attemptedTitles.has(normalizedTitle) || existingTitles.has(normalizedTitle)) {
          continue;
        }

        attemptedTitles.add(normalizedTitle);

        try {
          const source = await fetchWikipediaSummary(title);

          if (source === null) {
            continue;
          }

          if (literatureProfile !== null) {
            const assessment = assessLiteratureSource(literatureProfile, source);

            if (!assessment.accepted) {
              filteredLowRelevanceCount += 1;
              continue;
            }

            source.assessment = assessment;
          }

          const profile = sourceMatchesProjectAnchors(
            source,
            anchorPhrases,
            referenceTokens,
            requiredShortTokens,
            normalizedTopic,
            primaryStrongAnchorCount,
            hasPrimaryStrongAnchors,
            hasStrongAnchors
          );

          if (!profile.relevantEnough || !profile.shortTokenMatch) {
            filteredLowRelevanceCount += 1;
            continue;
          }

          candidates.push({
            ...source,
            score: profile.score
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : "Unknown Wikipedia summary failure.";
          notes.push(`Wikipedia summary failed for "${title}": ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Unknown Wikipedia search failure.";
      notes.push(`Wikipedia fallback search failed for "${query}": ${message}`);
    }
  }

  if (filteredLowRelevanceCount > 0) {
    notes.push(`Filtered ${filteredLowRelevanceCount} low-relevance Wikipedia fallback candidates.`);
  }

  const sources = candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((candidate, index) => ({
      ...candidate,
      id: `wiki-${index + 1}`
    }));

  if (sources.length > 0) {
    notes.push(`Collected ${sources.length} Wikipedia fallback background sources.`);
  }

  return {
    sources,
    notes
  };
}

export class DefaultResearchSourceGatherer implements ResearchSourceGatherer {
  async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
    const briefSource: ResearchSource = {
      id: "brief-1",
      kind: "project_brief",
      title: request.brief.topic ?? "Project brief",
      locator: null,
      citation: "User-provided project brief.",
      excerpt: excerptText([
        `Topic: ${request.brief.topic ?? "<missing>"}`,
        `Research question: ${request.brief.researchQuestion ?? "<missing>"}`,
        `Research direction: ${request.brief.researchDirection ?? "<missing>"}`,
        `Success criterion: ${request.brief.successCriterion ?? "<missing>"}`
      ].join(" "))
    };

    const localSources = await gatherLocalFileSources(request);
    const literatureProfile = shouldUseLiteratureReviewSubsystem(request.plan, request.brief)
      ? buildLiteratureReviewProfile({
        brief: request.brief,
        plan: request.plan,
        memoryContext: request.memoryContext
      })
      : null;
    const webSources = await gatherOpenAlexSources(request, literatureProfile);
    const wikipediaSources = webSources.sources.length === 0
      ? await gatherWikipediaFallbackSources(
        request,
        new Set(webSources.sources.map((source) => source.title.toLowerCase())),
        literatureProfile
      )
      : { sources: [], notes: [] };
    const sources = [
      briefSource,
      ...localSources,
      ...webSources.sources,
      ...wikipediaSources.sources
    ];

    return {
      sources,
      notes: [
        ...(literatureProfile === null
          ? []
          : [
            `Literature review subsystem active. Domain anchors: ${literatureProfile.domainAnchors.join(", ") || "none"}.`,
            literatureProfile.taskAttributes.length > 0
              ? `Task-aware paper ranking attributes: ${literatureProfile.taskAttributes.join(", ")}.`
              : "Task-aware paper ranking is active, but no explicit literature attributes were detected beyond the topic."
          ]),
        localSources.length > 0
          ? `Collected ${localSources.length} relevant local project files.`
          : "No relevant local project files were selected.",
        webSources.sources.length > 0
          ? `Collected ${webSources.sources.length} OpenAlex literature sources.`
          : "No OpenAlex literature sources were collected.",
        ...wikipediaSources.notes,
        request.memoryContext.available
          ? `Used ${request.memoryContext.recordCount} prior memory records to shape retrieval and focus areas.`
          : "No prior project memory was available for retrieval guidance.",
        ...webSources.notes
      ],
      literatureReview: literatureProfile === null
        ? null
        : {
          active: true,
          profile: literatureProfile,
          selectedAssessments: sources.flatMap((source) => (
            source.assessment === undefined
              ? []
              : [{
                sourceId: source.id,
                title: source.title,
                assessment: source.assessment
              }]
          ))
        }
    };
  }
}

export function createDefaultResearchSourceGatherer(): ResearchSourceGatherer {
  return new DefaultResearchSourceGatherer();
}
