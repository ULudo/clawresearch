import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  assessLiteratureSource,
  buildLiteratureReviewProfile,
  shouldUseLiteratureReviewSubsystem,
  type LiteratureReviewProfile,
  type LiteratureSourceAssessment
} from "./literature-review.js";
import type {
  CanonicalPaper,
  PaperAccessMode,
  PaperAccessRecord,
  PaperDiscoveryRecord,
  PaperFulltextFormat,
  PaperIdentifiers,
  LiteratureContext
} from "./literature-store.js";
import { createLiteratureEntityId } from "./literature-store.js";
import type { ProjectMemoryContext } from "./memory-store.js";
import {
  defaultBackgroundProviderIds,
  defaultScholarlyProviderIds,
  getSourceProviderDefinition,
  normalizeProviderId,
  providerAuthStatus,
  type ProviderAuthStatus,
  type SourceProviderCategory,
  type SourceProviderDomain,
  type SourceProviderId
} from "./provider-registry.js";
import type { ResearchPlan } from "./research-backend.js";
import type { ResearchBrief } from "./session-store.js";

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
  ".yml",
  ".json"
]);

const openAlexBaseUrl = process.env.CLAWRESEARCH_OPENALEX_BASE_URL ?? "https://api.openalex.org";
const crossrefBaseUrl = process.env.CLAWRESEARCH_CROSSREF_BASE_URL ?? "https://api.crossref.org";
const arxivBaseUrl = process.env.CLAWRESEARCH_ARXIV_BASE_URL ?? "http://export.arxiv.org";
const dblpBaseUrl = process.env.CLAWRESEARCH_DBLP_BASE_URL ?? "https://dblp.org";
const pubmedBaseUrl = process.env.CLAWRESEARCH_PUBMED_BASE_URL ?? "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const europePmcBaseUrl = process.env.CLAWRESEARCH_EUROPE_PMC_BASE_URL ?? "https://www.ebi.ac.uk/europepmc/webservices/rest";
const coreBaseUrl = process.env.CLAWRESEARCH_CORE_BASE_URL ?? "https://api.core.ac.uk/v3";
const unpaywallBaseUrl = process.env.CLAWRESEARCH_UNPAYWALL_BASE_URL ?? "https://api.unpaywall.org/v2";
const wikipediaBaseUrl = process.env.CLAWRESEARCH_WIKIPEDIA_BASE_URL ?? "https://en.wikipedia.org";

const stopTokens = new Set([
  "about",
  "after",
  "approach",
  "approaches",
  "background",
  "current",
  "design",
  "implementation",
  "investigate",
  "literature",
  "problem",
  "project",
  "question",
  "research",
  "review",
  "study",
  "successful",
  "topic",
  "what",
  "which"
]);

const preservedShortTokens = new Set([
  "ai",
  "ml",
  "nlp",
  "rl",
  "llm",
  "dna",
  "rna"
]);

const csAiCuePattern = /\b(ai|ml|machine learning|deep learning|language model|llm|nlp|computer vision|autonomous|agent|algorithm|algorithms|software|systems|robot|robotics)\b/i;
const biomedicalCuePattern = /\b(biomedical|medicine|medical|clinical|patient|patients|drug|therapy|disease|genome|protein|cell|hospital|nursing home|nursing homes|healthcare|caregiver|pubmed)\b/i;
const socialCareCuePattern = /\b(nursing home|nursing homes|elderly care|aged care|long[- ]term care|care home|care homes|caregiver|caregivers)\b/i;
const coreTopicStopTokens = new Set([
  "about",
  "across",
  "after",
  "analysis",
  "approach",
  "approaches",
  "best",
  "care",
  "current",
  "design",
  "effect",
  "effects",
  "evidence",
  "general",
  "impact",
  "implementation",
  "implementations",
  "implementing",
  "literature",
  "method",
  "methods",
  "problem",
  "problems",
  "project",
  "question",
  "questions",
  "research",
  "review",
  "study",
  "success",
  "successful",
  "system",
  "systems",
  "technique",
  "techniques",
  "topic",
  "work",
  "workforce"
]);

export type ResearchSourceKind =
  | "project_brief"
  | "local_file"
  | "scholarly_hit"
  | "background_article";

export type ResearchSourceCategory =
  | "brief"
  | "local"
  | "scholarly"
  | "background";

export type ResearchSource = {
  id: string;
  providerId: SourceProviderId | null;
  category: ResearchSourceCategory;
  kind: ResearchSourceKind;
  title: string;
  locator: string | null;
  citation: string;
  excerpt: string;
  year: number | null;
  authors: string[];
  venue: string | null;
  identifiers: Partial<PaperIdentifiers>;
  access: Partial<PaperAccessRecord> | null;
  assessment?: LiteratureSourceAssessment;
};

export type ProviderAuthSnapshot = {
  providerId: SourceProviderId;
  authRef: string | null;
  status: ProviderAuthStatus;
};

export type RoutingPlan = {
  domain: SourceProviderDomain | "mixed";
  plannedQueries: string[];
  discoveryProviderIds: SourceProviderId[];
  resolverProviderIds: SourceProviderId[];
  acquisitionProviderIds: SourceProviderId[];
};

export type ReviewWorkflowSummary = {
  titleScreenedPaperIds: string[];
  abstractScreenedPaperIds: string[];
  fulltextScreenedPaperIds: string[];
  includedPaperIds: string[];
  excludedPaperIds: string[];
  uncertainPaperIds: string[];
  blockedPaperIds: string[];
  synthesisPaperIds: string[];
  deferredPaperIds: string[];
  counts: {
    titleScreened: number;
    abstractScreened: number;
    fulltextScreened: number;
    included: number;
    excluded: number;
    uncertain: number;
    blocked: number;
    selectedForSynthesis: number;
    deferred: number;
  };
  notes: string[];
};

export type ResearchSourceGatherResult = {
  sources: ResearchSource[];
  canonicalPapers: CanonicalPaper[];
  reviewedPapers: CanonicalPaper[];
  notes: string[];
  routing: RoutingPlan;
  mergeDiagnostics: string[];
  authStatus: ProviderAuthSnapshot[];
  reviewWorkflow: ReviewWorkflowSummary;
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
  literatureContext?: LiteratureContext;
  providerIds?: SourceProviderId[];
  scholarlyProviderIds?: SourceProviderId[];
  backgroundProviderIds?: SourceProviderId[];
  projectFilesEnabled?: boolean;
  authRefs?: Partial<Record<SourceProviderId, string | null>>;
};

export interface ResearchSourceGatherer {
  gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult>;
}

type RawCandidate = {
  providerId: SourceProviderId;
  title: string;
  locator: string | null;
  citation: string;
  excerpt: string;
  year: number | null;
  authors: string[];
  venue: string | null;
  identifiers: Partial<PaperIdentifiers>;
  access: Partial<PaperAccessRecord> | null;
};

type AccessResolution = {
  best: PaperAccessRecord;
  candidates: PaperAccessRecord[];
  accessErrors: string[];
};

type SourceQualityTier = "high" | "medium" | "low";

type SourceQualityAssessment = {
  score: number;
  tier: SourceQualityTier;
  signals: string[];
  severeConcern: boolean;
  revisionLike: boolean;
  seriesKey: string | null;
};

type RetrievalBudget = {
  maxQueries: number;
  maxQueriesPerProvider: number;
  pageSize: number;
  maxPagesPerQuery: number;
  maxCandidatesPerProvider: number;
  targetAcceptedSources: number;
};

type ProviderPageResult = {
  candidates: RawCandidate[];
  hasMore: boolean;
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function excerptText(text: string, limit = 1600): string {
  const normalized = normalizeWhitespace(text);
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 3)}...`;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const text = safeString(entry);
    return text === null ? [] : [text];
  });
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter((token) => token.length >= 4 || preservedShortTokens.has(token));
}

function normalizeMatchToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }

  if (token.endsWith("s") && token.length > 4 && !token.endsWith("ss") && !token.endsWith("is")) {
    return token.slice(0, -1);
  }

  return token;
}

function matchTokens(text: string): string[] {
  return tokenize(text).map(normalizeMatchToken);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const text = typeof value === "string"
      ? normalizeWhitespace(value)
      : "";

    if (text.length === 0 || seen.has(text)) {
      continue;
    }

    seen.add(text);
    normalized.push(text);
  }

  return normalized;
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

function slug(text: string): string {
  return normalizeWhitespace(text.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleHeuristicKey(title: string, year: number | null, authors: string[]): string {
  const authorKey = authors[0] === undefined
    ? "anon"
    : slug(authors[0].split(/\s+/).slice(-1)[0] ?? authors[0]);

  return `${slug(title)}:${year ?? "na"}:${authorKey}`;
}

function normalizeDoi(doi: string | null): string | null {
  if (doi === null) {
    return null;
  }

  return doi
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .trim()
    .toLowerCase();
}

function normalizeArxivId(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  return value
    .replace(/^https?:\/\/arxiv\.org\/abs\//i, "")
    .replace(/^arxiv:/i, "")
    .trim();
}

function sourceHost(locator: string | null): string | null {
  if (locator === null) {
    return null;
  }

  try {
    return new URL(locator).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function uppercaseRatio(text: string): number {
  const letters = [...text].filter((character) => /[A-Za-z]/.test(character));

  if (letters.length === 0) {
    return 0;
  }

  const uppercaseLetters = letters.filter((character) => /[A-Z]/.test(character));
  return uppercaseLetters.length / letters.length;
}

function titleSeriesStem(title: string): string {
  return normalizeWhitespace(title.toLowerCase())
    .replace(/\b(v(?:ersion)?\s*\d+(?:\.\d+)?|update|updated|correction|corrigendum|supplement|appendix|draft|revised?|revision|part\s+\d+)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !stopTokens.has(token))
    .slice(0, 8)
    .join(" ");
}

function paperSeriesGroupKey(paper: CanonicalPaper): string | null {
  const firstAuthorKey = slug((paper.authors[0] ?? "anon").split(/\s+/).slice(-1)[0] ?? "anon");
  const stem = titleSeriesStem(paper.title);
  return stem.length > 0 ? `${firstAuthorKey}:${stem}` : null;
}

function sourceQualityAssessmentForPaper(paper: CanonicalPaper): SourceQualityAssessment {
  const signals: string[] = [];
  let score = 0;
  const venue = paper.venue ?? "";
  const title = paper.title;
  const locatorHost = sourceHost(paper.bestAccessUrl);
  const normalizedTitle = normalizeWhitespace(title.toLowerCase().replace(/[^a-z0-9]+/g, " "));
  const venueLower = venue.toLowerCase();

  if (paper.identifiers.doi !== null) {
    score += 2;
    signals.push("has-doi");
  }

  if (paper.identifiers.arxivId !== null) {
    score += 1;
    signals.push("arxiv-id");
  }

  if (/(journal|annals|transactions|proceedings|bulletin|review|letters|analysis|mathematica|mathematics|foundations|inventiones|discrete analysis|notices)/i.test(venue)) {
    score += 3;
    signals.push("journal-like-venue");
  }

  if (/(zenodo|preprints\.org|figshare|osf|ssrn|vixra|qspace|repository|archive and repository|institutional repository)/i.test(venueLower)) {
    score -= 4;
    signals.push("repository-venue");
  }

  if (locatorHost !== null && /(zenodo\.org|preprints\.org|figshare\.com|osf\.io|ssrn\.com|vixra\.org)/i.test(locatorHost)) {
    score -= 4;
    signals.push("repository-host");
  }

  if (locatorHost !== null && /arxiv\.org$/i.test(locatorHost)) {
    score += 1;
    signals.push("arxiv-host");
  }

  if (paper.bestAccessProvider === "openalex" && paper.bestAccessUrl !== null && /\.pdf$/i.test(paper.bestAccessUrl)) {
    score += 1;
    signals.push("direct-pdf");
  }

  const uppercase = uppercaseRatio(title);
  if (uppercase >= 0.45 && title.length >= 24) {
    score -= 2;
    signals.push("excessive-uppercase");
  }

  if (/[|]{2,}|[+]{2,}/.test(title)) {
    score -= 3;
    signals.push("decorative-separators");
  }

  const revisionLike = /\b(v(?:ersion)?\s*\d+(?:\.\d+)?|update|updated|correction|corrigendum|supplement|draft|revised?|revision|lemma)\b/i.test(title);
  if (revisionLike) {
    score -= 1;
    signals.push("revision-like-title");
  }

  if (/\b(proof of|complete proof|complete structural formalization|solution to|solves?|establish(?:ing|ment)|unified geometric theory|fundamental open problems|millennium)\b/i.test(normalizedTitle)) {
    score -= 3;
    signals.push("grand-claim-title");
  }

  if ((normalizedTitle.match(/\b(conjecture|hypothesis|yang mills|poincare|hodge|p vs np|bsd)\b/gi)?.length ?? 0) >= 3) {
    score -= 2;
    signals.push("multi-open-problem-title");
  }

  if ((paper.authors.length === 0 || paper.authors.every((author) => author.trim().length === 0)) && paper.identifiers.doi === null) {
    score -= 1;
    signals.push("weak-metadata");
  }

  const tier: SourceQualityTier = score >= 4
    ? "high"
    : score >= 1
      ? "medium"
      : "low";

  const severeConcern = score <= -3;
  const groupKey = paperSeriesGroupKey(paper);
  const seriesKey = (revisionLike || severeConcern || signals.includes("repository-venue") || signals.includes("repository-host"))
    && groupKey !== null
    ? groupKey
    : null;

  return {
    score,
    tier,
    signals,
    severeConcern,
    revisionLike,
    seriesKey
  };
}

function readAuthRef(
  request: ResearchSourceGatherRequest,
  providerId: SourceProviderId
): string | null {
  const configured = request.authRefs !== undefined
    && Object.prototype.hasOwnProperty.call(request.authRefs, providerId)
    ? request.authRefs[providerId]
    : getSourceProviderDefinition(providerId).defaultEnvVarName;

  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : null;
}

function authSnapshots(
  request: ResearchSourceGatherRequest,
  scholarlyProviderIds: SourceProviderId[],
  backgroundProviderIds: SourceProviderId[],
  projectFilesEnabled: boolean
): ProviderAuthSnapshot[] {
  const providerIds = uniqueProviderIds([
    ...(projectFilesEnabled ? ["project_files" as const] : []),
    ...scholarlyProviderIds,
    ...backgroundProviderIds
  ]);

  return providerIds.map((providerId) => {
    const authRef = readAuthRef(request, providerId);
    const definition = getSourceProviderDefinition(providerId);
    const envName = authRef;
    const availableRef = envName !== null
      && typeof process.env[envName] === "string"
      && process.env[envName]!.trim().length > 0
      ? envName
      : null;

    return {
      providerId,
      authRef: envName,
      status: providerAuthStatus(providerId, availableRef)
    };
  });
}

function uniqueProviderIds(providerIds: SourceProviderId[]): SourceProviderId[] {
  const seen = new Set<SourceProviderId>();
  const normalized: SourceProviderId[] = [];

  for (const providerId of providerIds) {
    if (seen.has(providerId)) {
      continue;
    }

    seen.add(providerId);
    normalized.push(providerId);
  }

  return normalized;
}

function selectedScholarlyProviderIds(request: ResearchSourceGatherRequest): SourceProviderId[] {
  if (request.scholarlyProviderIds !== undefined) {
    return uniqueProviderIds(request.scholarlyProviderIds);
  }

  if (request.providerIds !== undefined) {
    return uniqueProviderIds(
      request.providerIds.filter((providerId) => getSourceProviderDefinition(providerId).category === "scholarly")
    );
  }

  return defaultScholarlyProviderIds();
}

function selectedBackgroundProviderIds(request: ResearchSourceGatherRequest): SourceProviderId[] {
  if (request.backgroundProviderIds !== undefined) {
    return uniqueProviderIds(request.backgroundProviderIds);
  }

  if (request.providerIds !== undefined) {
    return uniqueProviderIds(
      request.providerIds.filter((providerId) => getSourceProviderDefinition(providerId).category === "background")
    );
  }

  return defaultBackgroundProviderIds();
}

function projectFilesEnabled(request: ResearchSourceGatherRequest): boolean {
  if (typeof request.projectFilesEnabled === "boolean") {
    return request.projectFilesEnabled;
  }

  if (request.providerIds !== undefined) {
    return request.providerIds.includes("project_files");
  }

  return true;
}

function classifyDomain(brief: ResearchBrief, plan: ResearchPlan): SourceProviderDomain | "mixed" {
  const combined = [
    brief.topic,
    brief.researchQuestion,
    brief.researchDirection,
    plan.objective,
    ...plan.searchQueries
  ].filter((value): value is string => typeof value === "string")
    .join(" ");

  const csAi = csAiCuePattern.test(combined);
  const biomedical = biomedicalCuePattern.test(combined);
  const socialCare = socialCareCuePattern.test(combined);

  if (csAi && biomedical) {
    if (socialCare) {
      return "biomedical";
    }

    return "mixed";
  }

  if (biomedical) {
    return "biomedical";
  }

  if (csAi) {
    return "cs_ai";
  }

  return "general";
}

function buildRetrievalBudget(
  request: ResearchSourceGatherRequest,
  literatureReviewActive: boolean
): RetrievalBudget {
  const explicitQueries = uniqueStrings(request.plan.searchQueries);
  const hintCount = (request.memoryContext.queryHints.length + (request.literatureContext?.queryHints.length ?? 0));
  const focusCount = [
    request.brief.researchQuestion,
    request.brief.researchDirection,
    request.brief.successCriterion,
    ...request.plan.localFocus
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).length;
  const broadTopic = tokenize(request.brief.topic ?? request.plan.objective).length <= 4;
  const maxQueries = Math.min(
    24,
    Math.max(
      literatureReviewActive ? 12 : 8,
      explicitQueries.length + focusCount + Math.min(4, hintCount) + (broadTopic ? 4 : 2)
    )
  );

  return {
    maxQueries,
    maxQueriesPerProvider: Math.min(16, Math.max(8, maxQueries)),
    pageSize: literatureReviewActive ? 25 : 10,
    maxPagesPerQuery: literatureReviewActive ? 6 : 2,
    maxCandidatesPerProvider: literatureReviewActive ? 200 : 40,
    targetAcceptedSources: literatureReviewActive ? 120 : 24
  };
}

function buildQueryPlan(request: ResearchSourceGatherRequest, budget: RetrievalBudget): string[] {
  const primaryTopic = request.brief.topic ?? request.plan.objective;
  const topicPhrase = compactQueryPhrase(primaryTopic, 8) ?? primaryTopic;
  const explicitQueries = uniqueStrings(request.plan.searchQueries);
  const focusQueries = uniqueStrings([
    compactQueryPhrase(request.brief.researchQuestion, 7),
    compactQueryPhrase(request.brief.researchDirection, 7),
    compactQueryPhrase(request.brief.successCriterion, 7),
    ...request.plan.localFocus.map((focus) => compactQueryPhrase(focus, 5)),
    ...explicitQueries.map((query) => compactQueryPhrase(query, 8))
  ]);
  const literatureHints = request.literatureContext?.queryHints ?? [];
  const memoryHints = request.memoryContext.queryHints ?? [];
  const buckets = [
    explicitQueries,
    focusQueries.map((query) => `${topicPhrase} ${query}`),
    memoryHints.map((hint) => `${topicPhrase} ${compactQueryPhrase(hint, 6) ?? hint}`),
    literatureHints.map((hint) => `${topicPhrase} ${compactQueryPhrase(hint, 6) ?? hint}`),
    [topicPhrase]
  ];

  return interleaveUniqueQueries(buckets, budget.maxQueries);
}

function interleaveUniqueQueries(buckets: string[][], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const maxBucketLength = Math.max(0, ...buckets.map((bucket) => bucket.length));

  for (let index = 0; index < maxBucketLength && result.length < limit; index += 1) {
    for (const bucket of buckets) {
      const candidate = bucket[index];

      if (candidate === undefined || seen.has(candidate)) {
        continue;
      }

      seen.add(candidate);
      result.push(candidate);

      if (result.length >= limit) {
        break;
      }
    }
  }

  return result;
}

function compactQueryPhrase(text: string | null | undefined, limit = 6): string | null {
  if (typeof text !== "string") {
    return null;
  }

  const tokens = tokenize(text)
    .filter((token) => !stopTokens.has(token))
    .slice(0, limit);

  return tokens.length > 0 ? tokens.join(" ") : null;
}

function coreTopicTokens(request: ResearchSourceGatherRequest): Set<string> {
  const rawTokens = matchTokens(request.brief.topic ?? request.plan.objective)
    .filter((token) => !stopTokens.has(token))
    .filter((token) => !coreTopicStopTokens.has(token));
  const narrowedTokens = rawTokens.length > 3
    ? rawTokens.filter((token) => !preservedShortTokens.has(token))
    : rawTokens;
  const finalTokens = narrowedTokens.length > 0 ? narrowedTokens : rawTokens;
  return new Set(finalTokens);
}

function minimumCoreTopicMatches(tokens: Set<string>): number {
  const size = tokens.size;

  if (size <= 1) {
    return size;
  }

  if (size === 2) {
    return 2;
  }

  return 2;
}

function coreTopicScore(text: string, tokens: Set<string>): number {
  if (tokens.size === 0) {
    return 0;
  }

  const matchedTokens = new Set(matchTokens(text));
  let score = 0;

  for (const token of matchedTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }

  return score;
}

function topicAnchorTokens(request: ResearchSourceGatherRequest): Set<string> {
  return new Set([
    ...(compactQueryPhrase(request.brief.topic ?? request.plan.objective, 8)?.split(" ") ?? []),
    ...(compactQueryPhrase(request.brief.researchQuestion, 7)?.split(" ") ?? []),
    ...request.plan.localFocus.flatMap((focus) => compactQueryPhrase(focus, 5)?.split(" ") ?? [])
  ].filter((token) => token.length > 0));
}

function containsTopicPhrase(source: ResearchSource, request: ResearchSourceGatherRequest): boolean {
  const topicPhrase = compactQueryPhrase(request.brief.topic ?? request.plan.objective, 8);

  if (topicPhrase === null) {
    return false;
  }

  const haystack = normalizeWhitespace(`${source.title} ${source.excerpt}`.toLowerCase());
  return haystack.includes(topicPhrase.toLowerCase());
}

function routeProviders(
  domain: SourceProviderDomain | "mixed",
  scholarlyProviderIds: SourceProviderId[]
): RoutingPlan {
  const selected = new Set(scholarlyProviderIds);
  const preferredDiscovery = domain === "cs_ai"
    ? ["openalex", "arxiv", "dblp", "crossref", "core", "unpaywall"]
    : domain === "biomedical"
      ? ["pubmed", "europe_pmc", "openalex", "crossref", "core", "unpaywall"]
      : domain === "general"
        ? ["openalex", "crossref", "arxiv", "core", "unpaywall", "dblp"]
        : ["openalex", "crossref", "arxiv", "dblp", "pubmed", "europe_pmc", "core", "unpaywall"];
  const discoveryProviderIds = preferredDiscovery
    .filter((providerId) => selected.has(providerId as SourceProviderId))
    .map((providerId) => providerId as SourceProviderId)
    .filter((providerId) => getSourceProviderDefinition(providerId).roles.includes("discovery"));
  const resolverProviderIds = preferredDiscovery
    .filter((providerId) => selected.has(providerId as SourceProviderId))
    .map((providerId) => providerId as SourceProviderId)
    .filter((providerId) => getSourceProviderDefinition(providerId).roles.includes("resolver"));
  const acquisitionProviderIds = preferredDiscovery
    .filter((providerId) => selected.has(providerId as SourceProviderId))
    .map((providerId) => providerId as SourceProviderId)
    .filter((providerId) => getSourceProviderDefinition(providerId).roles.includes("acquisition"));

  return {
    domain,
    plannedQueries: [],
    discoveryProviderIds,
    resolverProviderIds,
    acquisitionProviderIds
  };
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown> {
  return fetchWithRetry(url, "json", init);
}

async function fetchText(url: URL, init?: RequestInit): Promise<string> {
  return fetchWithRetry(url, "text", init) as Promise<string>;
}

async function waitFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetriableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError"
    || error.name === "TimeoutError"
    || error instanceof TypeError;
}

function retryDelayMs(attempt: number): number {
  return 100 * attempt;
}

async function fetchWithRetry(
  url: URL,
  responseType: "json" | "text",
  init?: RequestInit
): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000)
      });

      if (!response.ok) {
        const error = new Error(`${url.origin} responded with ${response.status} ${response.statusText}`);
        lastError = error;

        if (attempt < 3 && isRetriableStatus(response.status)) {
          await waitFor(retryDelayMs(attempt));
          continue;
        }

        throw error;
      }

      return responseType === "json"
        ? response.json()
        : response.text();
    } catch (error) {
      if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error(String(error));
      }

      if (attempt < 3 && isRetriableFetchError(error)) {
        await waitFor(retryDelayMs(attempt));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url.toString()}`);
}

function authorsToCitation(authors: string[], year: number | null, title: string, venue: string | null): string {
  const authorText = authors.length === 0
    ? "Unknown author"
    : authors.length === 1
      ? authors[0]!
      : `${authors[0]} et al.`;

  return `${authorText} (${year ?? "n.d."}). ${title}.${venue === null ? "" : ` ${venue}.`}`;
}

function decodeOpenAlexAbstract(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }

  const index = value as Record<string, number[]>;
  const positioned: Array<{ position: number; word: string }> = [];

  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (Number.isInteger(position)) {
        positioned.push({ position, word });
      }
    }
  }

  return positioned
    .sort((left, right) => left.position - right.position)
    .map((entry) => entry.word)
    .join(" ");
}

function accessRecord(
  providerId: SourceProviderId,
  url: string | null,
  accessMode: PaperAccessMode,
  fulltextFormat: PaperFulltextFormat,
  note: string | null,
  options: {
    license?: string | null;
    tdmAllowed?: boolean | null;
  } = {}
): PaperAccessRecord {
  return {
    providerId,
    url,
    accessMode,
    fulltextFormat,
    license: options.license ?? null,
    tdmAllowed: options.tdmAllowed ?? null,
    note
  };
}

function makeSourceId(providerId: SourceProviderId, title: string, locator: string | null): string {
  return `${providerId}:${locator ?? slug(title)}`;
}

function toResearchSource(candidate: RawCandidate): ResearchSource {
  return {
    id: makeSourceId(candidate.providerId, candidate.title, candidate.locator),
    providerId: candidate.providerId,
    category: getSourceProviderDefinition(candidate.providerId).category === "background"
      ? "background"
      : "scholarly",
    kind: getSourceProviderDefinition(candidate.providerId).category === "background"
      ? "background_article"
      : "scholarly_hit",
    title: candidate.title,
    locator: candidate.locator,
    citation: candidate.citation,
    excerpt: excerptText(candidate.excerpt),
    year: candidate.year,
    authors: candidate.authors,
    venue: candidate.venue,
    identifiers: candidate.identifiers,
    access: candidate.access
  };
}

function selectBestAccess(candidates: PaperAccessRecord[]): PaperAccessRecord {
  const ranked = [...candidates].sort((left, right) => accessRank(right) - accessRank(left));
  return ranked[0] ?? accessRecord("crossref", null, "metadata_only", "none", "No access candidates were available.");
}

function accessRank(record: PaperAccessRecord): number {
  switch (record.accessMode) {
    case "fulltext_open":
      return 6;
    case "fulltext_licensed":
      return 5;
    case "abstract_available":
      return 4;
    case "metadata_only":
      return 3;
    case "needs_credentials":
      return 2;
    case "fulltext_blocked":
      return 1;
  }
}

function screeningForSource(
  source: ResearchSource,
  profile: LiteratureReviewProfile | null
): { assessment: LiteratureSourceAssessment | undefined; accepted: boolean } {
  if (profile === null) {
    const referenceTokens = new Set(tokenize(`${source.title} ${source.citation}`));
    const score = overlapScore(`${source.title} ${source.excerpt}`, referenceTokens);
    return {
      assessment: undefined,
      accepted: score >= 2 || tokenize(source.title).length >= 2
    };
  }

  const assessment = assessLiteratureSource(profile, {
    title: source.title,
    excerpt: source.excerpt,
    citation: source.citation
  });

  return {
    assessment,
    accepted: assessment.accepted
  };
}

async function walkTextFiles(projectRoot: string, currentDirectory = projectRoot): Promise<string[]> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDirectory, entry.name);

    if (entry.isDirectory()) {
      results.push(...await walkTextFiles(projectRoot, absolutePath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    results.push(path.relative(projectRoot, absolutePath));
  }

  return results;
}

export async function collectResearchLocalFileHints(
  projectRoot: string,
  brief: ResearchBrief
): Promise<string[]> {
  const files = await walkTextFiles(projectRoot);
  const referenceTokens = new Set([
    ...(brief.topic === null ? [] : tokenize(brief.topic)),
    ...(brief.researchQuestion === null ? [] : tokenize(brief.researchQuestion)),
    ...(brief.researchDirection === null ? [] : tokenize(brief.researchDirection))
  ]);

  return files
    .sort((left, right) => overlapScore(right, referenceTokens) - overlapScore(left, referenceTokens))
    .slice(0, 12);
}

async function gatherLocalProjectFiles(
  request: ResearchSourceGatherRequest
): Promise<ResearchSource[]> {
  if (!projectFilesEnabled(request)) {
    return [];
  }

  const referenceTokens = new Set([
    ...(request.brief.topic === null ? [] : tokenize(request.brief.topic)),
    ...(request.brief.researchQuestion === null ? [] : tokenize(request.brief.researchQuestion)),
    ...(request.brief.researchDirection === null ? [] : tokenize(request.brief.researchDirection)),
    ...request.plan.localFocus.flatMap(tokenize)
  ]);
  const files = await walkTextFiles(request.projectRoot);
  const ranked = files
    .map((relativePath) => ({
      relativePath,
      score: overlapScore(relativePath, referenceTokens)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
  const sources: ResearchSource[] = [];

  for (const file of ranked) {
    const contents = await readFile(path.join(request.projectRoot, file.relativePath), "utf8");

    sources.push({
      id: `local:${file.relativePath}`,
      providerId: "project_files",
      category: "local",
      kind: "local_file",
      title: file.relativePath,
      locator: file.relativePath,
      citation: `Local project file: ${file.relativePath}`,
      excerpt: excerptText(contents),
      year: null,
      authors: [],
      venue: null,
      identifiers: {},
      access: {
        providerId: "project_files",
        url: file.relativePath,
        accessMode: "fulltext_open",
        fulltextFormat: "none",
        note: "Project file available locally."
      }
    });
  }

  return sources;
}

async function queryOpenAlex(query: string, page: number, perPage: number): Promise<ProviderPageResult> {
  const url = new URL("/works", openAlexBaseUrl);
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(perPage));
  url.searchParams.set("page", String(page));
  const payload = await fetchJson(url);
  const record = typeof payload === "object" && payload !== null
    ? payload as { results?: unknown[] }
    : {};
  const results = Array.isArray(record.results) ? record.results : [];

  const candidates = results.flatMap((entry) => {
    const raw = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const title = safeString(raw.display_name);

    if (title === null) {
      return [];
    }

    const authorships = Array.isArray(raw.authorships) ? raw.authorships : [];
    const authors = authorships.flatMap((authorship) => {
      const author = typeof authorship === "object" && authorship !== null
        ? authorship as Record<string, unknown>
        : {};
      const authorRecord = typeof author.author === "object" && author.author !== null
        ? author.author as Record<string, unknown>
        : {};
      const name = safeString(authorRecord.display_name);
      return name === null ? [] : [name];
    });
    const primaryLocation = typeof raw.primary_location === "object" && raw.primary_location !== null
      ? raw.primary_location as Record<string, unknown>
      : {};
    const sourceRecord = typeof primaryLocation.source === "object" && primaryLocation.source !== null
      ? primaryLocation.source as Record<string, unknown>
      : {};
    const locator = safeString(primaryLocation.landing_page_url) ?? safeString(raw.id);
    const excerpt = decodeOpenAlexAbstract(raw.abstract_inverted_index);
    const doi = normalizeDoi(safeString(raw.doi));
    const bestOaLocation = typeof raw.best_oa_location === "object" && raw.best_oa_location !== null
      ? raw.best_oa_location as Record<string, unknown>
      : {};
    const pdfUrl = safeString(bestOaLocation.pdf_url) ?? safeString(bestOaLocation.landing_page_url);
    const access = pdfUrl !== null
      ? accessRecord("openalex", pdfUrl, "fulltext_open", pdfUrl.endsWith(".pdf") ? "pdf" : "html", "OpenAlex reported an open access location.")
      : excerpt.length > 0
        ? accessRecord("openalex", locator, "abstract_available", "none", "OpenAlex metadata included an abstract.")
        : accessRecord("openalex", locator, "metadata_only", "none", "OpenAlex returned metadata only.");

    return [{
      providerId: "openalex" as const,
      title,
      locator,
      citation: authorsToCitation(authors, safeInteger(raw.publication_year), title, safeString(sourceRecord.display_name)),
      excerpt,
      year: safeInteger(raw.publication_year),
      authors,
      venue: safeString(sourceRecord.display_name),
      identifiers: {
        doi
      },
      access
    }];
  });

  return {
    candidates,
    hasMore: candidates.length >= perPage
  };
}

async function queryCrossref(query: string, pageIndex: number, rows: number): Promise<ProviderPageResult> {
  const url = new URL("/works", crossrefBaseUrl);
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("offset", String(pageIndex * rows));
  const payload = await fetchJson(url);
  const record = typeof payload === "object" && payload !== null
    ? payload as { message?: { items?: unknown[] } }
    : {};
  const items = Array.isArray(record.message?.items) ? record.message?.items ?? [] : [];

  const candidates = items.flatMap((entry) => {
    const item = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const title = Array.isArray(item.title)
      ? safeString(item.title[0])
      : safeString(item.title);

    if (title === null) {
      return [];
    }

    const authors = Array.isArray(item.author)
      ? item.author.flatMap((author) => {
        const record = typeof author === "object" && author !== null
          ? author as Record<string, unknown>
          : {};
        const given = safeString(record.given);
        const family = safeString(record.family);
        return normalizeWhitespace([given, family].filter((value): value is string => value !== null).join(" ")).length === 0
          ? []
          : [normalizeWhitespace([given, family].filter((value): value is string => value !== null).join(" "))];
      })
      : [];
    const issued = typeof item.issued === "object" && item.issued !== null
      ? item.issued as { "date-parts"?: number[][] }
      : undefined;
    const year = Array.isArray(issued?.["date-parts"])
      ? safeInteger(issued?.["date-parts"]?.[0]?.[0])
      : null;
    const venue = Array.isArray(item["container-title"])
      ? safeString(item["container-title"][0])
      : null;
    const doi = normalizeDoi(safeString(item.DOI));
    const locator = safeString(item.URL) ?? (doi === null ? null : `https://doi.org/${doi}`);

    return [{
      providerId: "crossref" as const,
      title,
      locator,
      citation: authorsToCitation(authors, year, title, venue),
      excerpt: safeString(item.abstract) ?? "",
      year,
      authors,
      venue,
      identifiers: {
        doi
      },
      access: accessRecord("crossref", locator, "metadata_only", "none", "Crossref returned metadata resolution.")
    }];
  });

  return {
    candidates,
    hasMore: candidates.length >= rows
  };
}

function parseArxivEntries(xml: string): RawCandidate[] {
  const entries = xml.split(/<entry>/g).slice(1);

  return entries.flatMap((entry) => {
    const title = entry.match(/<title>\s*([\s\S]*?)\s*<\/title>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ?? null;

    if (title === null) {
      return [];
    }

    const summary = entry.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ?? "";
    const id = entry.match(/<id>\s*([\s\S]*?)\s*<\/id>/i)?.[1]?.trim() ?? null;
    const published = entry.match(/<published>\s*(\d{4})/i)?.[1] ?? null;
    const authors = [...entry.matchAll(/<name>\s*([\s\S]*?)\s*<\/name>/gi)]
      .map((match) => match[1]?.replace(/\s+/g, " ").trim())
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const arxivId = normalizeArxivId(id);
    const locator = id;
    const pdfUrl = arxivId === null ? null : `https://arxiv.org/pdf/${arxivId}.pdf`;

    return [{
      providerId: "arxiv" as const,
      title,
      locator,
      citation: authorsToCitation(authors, published === null ? null : Number(published), title, "arXiv"),
      excerpt: summary,
      year: published === null ? null : Number(published),
      authors,
      venue: "arXiv",
      identifiers: {
        arxivId
      },
      access: accessRecord("arxiv", pdfUrl, "fulltext_open", "pdf", "arXiv provides direct PDF access.")
    }];
  });
}

async function queryArxiv(query: string, pageIndex: number, maxResults: number): Promise<ProviderPageResult> {
  const url = new URL("/api/query", arxivBaseUrl);
  url.searchParams.set("search_query", `all:${query}`);
  url.searchParams.set("start", String(pageIndex * maxResults));
  url.searchParams.set("max_results", String(maxResults));
  const xml = await fetchText(url);
  const candidates = parseArxivEntries(xml);

  return {
    candidates,
    hasMore: candidates.length >= maxResults
  };
}

async function queryDblp(query: string, pageIndex: number, pageSize: number): Promise<ProviderPageResult> {
  const url = new URL("/search/publ/api", dblpBaseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("h", String(pageSize));
  url.searchParams.set("f", String(pageIndex * pageSize));
  const payload = await fetchJson(url);
  const record = typeof payload === "object" && payload !== null
    ? payload as { result?: { hits?: { hit?: unknown[] | unknown } } }
    : {};
  const hitValue = record.result?.hits?.hit;
  const hits = Array.isArray(hitValue)
    ? hitValue
    : hitValue === undefined
      ? []
      : [hitValue];

  const candidates = hits.flatMap((entry) => {
    const info = typeof entry === "object" && entry !== null
      ? (entry as { info?: Record<string, unknown> }).info ?? {}
      : {};
    const title = safeString(info.title);

    if (title === null) {
      return [];
    }

    const authors = Array.isArray((info.authors as { author?: unknown[] | unknown } | undefined)?.author)
      ? ((info.authors as { author?: unknown[] }).author ?? []).flatMap((author) => safeString(author) ?? [])
      : safeString((info.authors as { author?: unknown } | undefined)?.author) === null
        ? []
        : [safeString((info.authors as { author?: unknown }).author)!];

    return [{
      providerId: "dblp" as const,
      title,
      locator: safeString(info.url),
      citation: authorsToCitation(authors, safeInteger(Number(info.year)), title, safeString(info.venue)),
      excerpt: "",
      year: safeInteger(Number(info.year)),
      authors,
      venue: safeString(info.venue),
      identifiers: {
        doi: normalizeDoi(safeString(info.doi))
      },
      access: accessRecord("dblp", safeString(info.url), "metadata_only", "none", "DBLP returned bibliographic metadata.")
    }];
  });

  return {
    candidates,
    hasMore: candidates.length >= pageSize
  };
}

async function queryPubmed(
  query: string,
  apiKey: string | null,
  pageIndex: number,
  pageSize: number
): Promise<ProviderPageResult> {
  const searchUrl = new URL("esearch.fcgi", pubmedBaseUrl.endsWith("/") ? pubmedBaseUrl : `${pubmedBaseUrl}/`);
  searchUrl.searchParams.set("db", "pubmed");
  searchUrl.searchParams.set("retmode", "json");
  searchUrl.searchParams.set("retmax", String(pageSize));
  searchUrl.searchParams.set("retstart", String(pageIndex * pageSize));
  searchUrl.searchParams.set("term", query);
  if (apiKey !== null) {
    searchUrl.searchParams.set("api_key", apiKey);
  }

  const searchPayload = await fetchJson(searchUrl) as {
    esearchresult?: { idlist?: string[] };
  };
  const ids = Array.isArray(searchPayload.esearchresult?.idlist)
    ? searchPayload.esearchresult?.idlist ?? []
    : [];

  if (ids.length === 0) {
    return {
      candidates: [],
      hasMore: false
    };
  }

  const summaryUrl = new URL("esummary.fcgi", pubmedBaseUrl.endsWith("/") ? pubmedBaseUrl : `${pubmedBaseUrl}/`);
  summaryUrl.searchParams.set("db", "pubmed");
  summaryUrl.searchParams.set("retmode", "json");
  summaryUrl.searchParams.set("id", ids.join(","));
  if (apiKey !== null) {
    summaryUrl.searchParams.set("api_key", apiKey);
  }

  const summaryPayload = await fetchJson(summaryUrl) as {
    result?: Record<string, Record<string, unknown>>;
  };

  const candidates = ids.flatMap((id) => {
    const item = summaryPayload.result?.[id] ?? {};
    const title = safeString(item.title);

    if (title === null) {
      return [];
    }

    const authors = Array.isArray(item.authors)
      ? item.authors.flatMap((author) => {
        const record = typeof author === "object" && author !== null
          ? author as Record<string, unknown>
          : {};
        const name = safeString(record.name);
        return name === null ? [] : [name];
      })
      : [];

    return [{
      providerId: "pubmed" as const,
      title,
      locator: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      citation: authorsToCitation(authors, Number.parseInt((safeString(item.pubdate) ?? "").slice(0, 4), 10) || null, title, safeString(item.fulljournalname)),
      excerpt: "",
      year: Number.parseInt((safeString(item.pubdate) ?? "").slice(0, 4), 10) || null,
      authors,
      venue: safeString(item.fulljournalname),
      identifiers: {
        pmid: id,
        doi: normalizeDoi(
          Array.isArray(item.articleids)
            ? safeString((item.articleids.find((articleId) => {
              const record = typeof articleId === "object" && articleId !== null
                ? articleId as Record<string, unknown>
                : {};
              return safeString(record.idtype) === "doi";
            }) as Record<string, unknown> | undefined)?.value)
            : null
        )
      },
      access: accessRecord("pubmed", `https://pubmed.ncbi.nlm.nih.gov/${id}/`, "metadata_only", "none", "PubMed returned biomedical metadata.")
    }];
  });

  return {
    candidates,
    hasMore: ids.length >= pageSize
  };
}

async function queryEuropePmc(query: string, page: number, pageSize: number): Promise<ProviderPageResult> {
  const url = new URL("search", europePmcBaseUrl.endsWith("/") ? europePmcBaseUrl : `${europePmcBaseUrl}/`);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("page", String(page));
  const payload = await fetchJson(url) as {
    resultList?: { result?: Array<Record<string, unknown>> };
  };
  const results = Array.isArray(payload.resultList?.result)
    ? payload.resultList?.result ?? []
    : [];

  const candidates = results.flatMap((entry) => {
    const title = safeString(entry.title);

    if (title === null) {
      return [];
    }

    const pmcid = safeString(entry.pmcid);
    const locator = safeString(entry.fullTextUrl) ?? safeString(entry.journalUrl) ?? (pmcid === null ? null : `https://europepmc.org/article/PMC/${pmcid}`);
    const excerpt = safeString(entry.abstractText) ?? "";
    const access = pmcid !== null
      ? accessRecord("europe_pmc", locator, "fulltext_open", "html", "Europe PMC exposed an OA full-text route.")
      : excerpt.length > 0
        ? accessRecord("europe_pmc", locator, "abstract_available", "none", "Europe PMC returned an abstract.")
        : accessRecord("europe_pmc", locator, "metadata_only", "none", "Europe PMC returned metadata only.");

    return [{
      providerId: "europe_pmc" as const,
      title,
      locator,
      citation: authorsToCitation(uniqueStrings([safeString(entry.authorString)]), safeInteger(Number(entry.pubYear)), title, safeString(entry.journalTitle)),
      excerpt,
      year: safeInteger(Number(entry.pubYear)),
      authors: uniqueStrings([safeString(entry.authorString)]),
      venue: safeString(entry.journalTitle),
      identifiers: {
        doi: normalizeDoi(safeString(entry.doi)),
        pmid: safeString(entry.pmid),
        pmcid
      },
      access
    }];
  });

  return {
    candidates,
    hasMore: candidates.length >= pageSize
  };
}

async function queryCore(
  query: string,
  apiKey: string | null,
  pageIndex: number,
  pageSize: number
): Promise<ProviderPageResult> {
  if (apiKey === null) {
    return {
      candidates: [],
      hasMore: false
    };
  }

  const url = new URL("/search/works", coreBaseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String(pageIndex * pageSize));
  const payload = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  }) as {
    results?: Array<Record<string, unknown>>;
  };
  const results = Array.isArray(payload.results) ? payload.results : [];

  const candidates = results.flatMap((entry) => {
    const title = safeString(entry.title);

    if (title === null) {
      return [];
    }

    return [{
      providerId: "core" as const,
      title,
      locator: safeString(entry.downloadUrl) ?? safeString(entry.id),
      citation: authorsToCitation(readStringArray(entry.authors), safeInteger(Number(entry.yearPublished)), title, safeString(entry.publisher)),
      excerpt: safeString(entry.abstract) ?? "",
      year: safeInteger(Number(entry.yearPublished)),
      authors: readStringArray(entry.authors),
      venue: safeString(entry.publisher),
      identifiers: {
        doi: normalizeDoi(safeString(entry.doi))
      },
      access: accessRecord("core", safeString(entry.downloadUrl) ?? safeString(entry.id), "fulltext_open", "pdf", "CORE returned an open full-text route.")
    }];
  });

  return {
    candidates,
    hasMore: candidates.length >= pageSize
  };
}

async function queryWikipedia(query: string): Promise<RawCandidate[]> {
  const searchUrl = new URL("/w/api.php", wikipediaBaseUrl);
  searchUrl.searchParams.set("action", "query");
  searchUrl.searchParams.set("list", "search");
  searchUrl.searchParams.set("srsearch", query);
  searchUrl.searchParams.set("format", "json");
  searchUrl.searchParams.set("srlimit", "3");
  const searchPayload = await fetchJson(searchUrl) as {
    query?: { search?: Array<{ title?: string }> };
  };
  const titles = Array.isArray(searchPayload.query?.search)
    ? searchPayload.query?.search?.flatMap((result) => safeString(result.title) ?? []) ?? []
    : [];
  const candidates: RawCandidate[] = [];

  for (const title of titles.slice(0, 3)) {
    const summaryUrl = new URL(`/api/rest_v1/page/summary/${encodeURIComponent(title)}`, wikipediaBaseUrl);
    const summaryPayload = await fetchJson(summaryUrl) as {
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    const resolvedTitle = safeString(summaryPayload.title) ?? title;
    const extract = safeString(summaryPayload.extract) ?? "";
    const locator = safeString(summaryPayload.content_urls?.desktop?.page);

    candidates.push({
      providerId: "wikipedia",
      title: resolvedTitle,
      locator,
      citation: `Wikipedia: ${resolvedTitle}`,
      excerpt: extract,
      year: null,
      authors: [],
      venue: "Wikipedia",
      identifiers: {},
      access: accessRecord("wikipedia", locator, "fulltext_open", "html", "Wikipedia background fallback.")
    });
  }

  return candidates;
}

async function queryProviderPage(
  providerId: SourceProviderId,
  query: string,
  pageIndex: number,
  authValue: string | null,
  budget: RetrievalBudget
): Promise<ProviderPageResult> {
  switch (providerId) {
    case "openalex":
      return queryOpenAlex(query, pageIndex + 1, budget.pageSize);
    case "crossref":
      return queryCrossref(query, pageIndex, budget.pageSize);
    case "arxiv":
      return queryArxiv(query, pageIndex, budget.pageSize);
    case "dblp":
      return queryDblp(query, pageIndex, budget.pageSize);
    case "pubmed":
      return queryPubmed(query, authValue, pageIndex, budget.pageSize);
    case "europe_pmc":
      return queryEuropePmc(query, pageIndex + 1, budget.pageSize);
    case "core":
      return queryCore(query, authValue, pageIndex, budget.pageSize);
    case "wikipedia":
      if (pageIndex > 0) {
        return {
          candidates: [],
          hasMore: false
        };
      }

      return {
        candidates: await queryWikipedia(query),
        hasMore: false
      };
    default:
      return {
        candidates: [],
        hasMore: false
      };
  }
}

function mergeKeyForSource(source: ResearchSource): string {
  const doi = normalizeDoi(source.identifiers.doi ?? null);

  if (doi !== null) {
    return `doi:${doi}`;
  }

  if (source.identifiers.pmid !== undefined && source.identifiers.pmid !== null) {
    return `pmid:${source.identifiers.pmid}`;
  }

  if (source.identifiers.pmcid !== undefined && source.identifiers.pmcid !== null) {
    return `pmcid:${source.identifiers.pmcid}`;
  }

  if (source.identifiers.arxivId !== undefined && source.identifiers.arxivId !== null) {
    return `arxiv:${normalizeArxivId(source.identifiers.arxivId)}`;
  }

  return `heuristic:${titleHeuristicKey(source.title, source.year, source.authors)}`;
}

async function resolveWithUnpaywall(
  paper: CanonicalPaper,
  email: string | null
): Promise<PaperAccessRecord[]> {
  const doi = paper.identifiers.doi;

  if (doi === null || email === null) {
    return [];
  }

  const url = new URL(`/${encodeURIComponent(doi)}`, unpaywallBaseUrl);
  url.searchParams.set("email", email);
  const payload = await fetchJson(url) as Record<string, unknown>;
  const bestLocation = typeof payload.best_oa_location === "object" && payload.best_oa_location !== null
    ? payload.best_oa_location as Record<string, unknown>
    : {};
  const pdfUrl = safeString(bestLocation.url_for_pdf);
  const landingPageUrl = safeString(bestLocation.url);
  const chosenUrl = pdfUrl ?? landingPageUrl;

  if (chosenUrl === null) {
    return [];
  }

  return [
    accessRecord(
      "unpaywall",
      chosenUrl,
      "fulltext_open",
      pdfUrl !== null ? "pdf" : "html",
      "Unpaywall resolved a legal OA route."
    )
  ];
}

function resolveFromExistingCandidates(paper: CanonicalPaper): AccessResolution {
  const candidates = paper.accessCandidates.length > 0
    ? paper.accessCandidates
    : [accessRecord("crossref", paper.bestAccessUrl, "metadata_only", "none", "No explicit access candidate was recorded.")];

  return {
    best: selectBestAccess(candidates),
    candidates,
    accessErrors: []
  };
}

function screeningStageFromAccess(accessMode: PaperAccessMode): "title" | "abstract" | "fulltext" {
  if (accessMode === "fulltext_open" || accessMode === "fulltext_licensed") {
    return "fulltext";
  }

  if (accessMode === "abstract_available") {
    return "abstract";
  }

  return "title";
}

function screeningDecision(
  sourceIds: string[],
  sources: ResearchSource[],
  stage: "title" | "abstract" | "fulltext",
  assessment: LiteratureSourceAssessment | null,
  quality: SourceQualityAssessment
): { decision: "include" | "background" | "exclude" | "uncertain"; rationale: string | null } {
  if (assessment !== null && !assessment.accepted) {
    return {
      decision: "exclude",
      rationale: assessment.rationale
    };
  }

  if (stage === "fulltext") {
    if (quality.severeConcern) {
      return {
        decision: "uncertain",
        rationale: `${assessment?.rationale ?? "Directly readable at full text."} Source-quality concerns (${quality.signals.join(", ")}) keep this paper out of the reviewed synthesis subset for now.`
      };
    }

    if (quality.tier === "low") {
      return {
        decision: "uncertain",
        rationale: `${assessment?.rationale ?? "Directly readable at full text."} The paper remains reviewable, but its venue/title quality is too weak for automatic inclusion.`
      };
    }

    return {
      decision: "include",
      rationale: `${assessment?.rationale ?? "The paper is directly readable at full text."} Source quality tier: ${quality.tier}.`
    };
  }

  if (stage === "abstract") {
    if (quality.severeConcern) {
      return {
        decision: "exclude",
        rationale: `${assessment?.rationale ?? "The paper can be screened at the abstract level."} Source-quality concerns (${quality.signals.join(", ")}) outweighed the current evidence.`
      };
    }

    if (quality.tier === "low") {
      return {
        decision: "uncertain",
        rationale: `${assessment?.rationale ?? "The paper can be screened at the abstract level."} The abstract is accessible, but the publication quality is too weak for automatic inclusion.`
      };
    }

    return {
      decision: "include",
      rationale: `${assessment?.rationale ?? "The paper can be screened at the abstract level."} Source quality tier: ${quality.tier}.`
    };
  }

  const scholarlySources = sources.filter((source) => sourceIds.includes(source.id) && source.category === "scholarly");

  return scholarlySources.length > 0
    ? {
      decision: "uncertain",
      rationale: assessment?.rationale ?? "Only metadata/title-level screening was possible."
    }
    : {
      decision: "background",
      rationale: "This item is background-only and was not treated as a core scholarly paper."
    };
}

function paperScreeningPriority(paper: CanonicalPaper): number {
  const quality = sourceQualityAssessmentForPaper(paper);
  const topicAnchorTagCount = paper.tags.filter((tag) => tag.startsWith("topic-anchor:")).length;
  const focusTagCount = paper.tags.filter((tag) => tag.startsWith("focus:")).length;
  const taskTagCount = paper.tags.filter((tag) => tag.startsWith("task:")).length;
  let score = 0;

  switch (paper.accessMode) {
    case "fulltext_open":
      score += 100;
      break;
    case "fulltext_licensed":
      score += 90;
      break;
    case "abstract_available":
      score += 70;
      break;
    case "metadata_only":
      score += 40;
      break;
    case "needs_credentials":
      score += 25;
      break;
    case "fulltext_blocked":
      score += 15;
      break;
  }

  switch (paper.screeningStage) {
    case "fulltext":
      score += 20;
      break;
    case "abstract":
      score += 10;
      break;
    case "title":
      break;
  }

  switch (paper.screeningDecision) {
    case "include":
      score += 30;
      break;
    case "uncertain":
      score += 5;
      break;
    case "background":
      score -= 10;
      break;
    case "exclude":
      score -= 100;
      break;
  }

  score += quality.score * 8;
  score += topicAnchorTagCount * 8;
  score += focusTagCount * 10;
  score += taskTagCount * 4;
  score += Math.min(5, paper.discoveredVia.length) * 3;
  score += Math.max(0, Math.min(10, (paper.year ?? 0) - 2015));
  return score;
}

function sortPapersForReview(papers: CanonicalPaper[]): CanonicalPaper[] {
  return [...papers].sort((left, right) => {
    return paperScreeningPriority(right) - paperScreeningPriority(left)
      || (right.year ?? 0) - (left.year ?? 0)
      || left.title.localeCompare(right.title);
  });
}

function collapseReviewSeries(papers: CanonicalPaper[]): { selected: CanonicalPaper[]; notes: string[] } {
  const selected: CanonicalPaper[] = [];
  const notes: string[] = [];
  const grouped = new Map<string, Array<{ paper: CanonicalPaper; quality: SourceQualityAssessment }>>();

  for (const paper of papers) {
    const quality = sourceQualityAssessmentForPaper(paper);
    const groupKey = paperSeriesGroupKey(paper);

    if (groupKey === null) {
      selected.push(paper);
      continue;
    }

    const group = grouped.get(groupKey) ?? [];
    group.push({ paper, quality });
    grouped.set(groupKey, group);
  }

  for (const [seriesKey, group] of grouped.entries()) {
    const shouldCollapse = group.length > 1 && group.some(({ quality }) => quality.seriesKey !== null);

    if (!shouldCollapse) {
      selected.push(...group.map(({ paper }) => paper));
      continue;
    }

    selected.push(group[0]!.paper);
    notes.push(`Collapsed ${group.length} near-duplicate revision or low-trust papers in review series ${seriesKey}.`);
  }

  return {
    selected,
    notes
  };
}

function buildReviewWorkflow(canonicalPapers: CanonicalPaper[]): {
  reviewedPapers: CanonicalPaper[];
  reviewWorkflow: ReviewWorkflowSummary;
} {
  const ordered = sortPapersForReview(canonicalPapers);
  const qualityCounts = {
    high: ordered.filter((paper) => sourceQualityAssessmentForPaper(paper).tier === "high").length,
    medium: ordered.filter((paper) => sourceQualityAssessmentForPaper(paper).tier === "medium").length,
    low: ordered.filter((paper) => sourceQualityAssessmentForPaper(paper).tier === "low").length
  };
  const titleScreenedPaperIds = ordered.map((paper) => paper.id);
  const abstractScreenedPaperIds = ordered
    .filter((paper) => paper.screeningDecision !== "exclude" && (paper.screeningStage === "abstract" || paper.screeningStage === "fulltext"))
    .map((paper) => paper.id);
  const fulltextScreenedPaperIds = ordered
    .filter((paper) => paper.screeningDecision !== "exclude" && paper.screeningStage === "fulltext")
    .map((paper) => paper.id);
  const includedPaperIds = ordered
    .filter((paper) => paper.screeningDecision === "include")
    .map((paper) => paper.id);
  const excludedPaperIds = ordered
    .filter((paper) => paper.screeningDecision === "exclude" || paper.screeningDecision === "background")
    .map((paper) => paper.id);
  const uncertainPaperIds = ordered
    .filter((paper) => paper.screeningDecision === "uncertain")
    .map((paper) => paper.id);
  const blockedPaperIds = ordered
    .filter((paper) => (
      paper.screeningDecision !== "exclude"
      && (paper.accessMode === "needs_credentials" || paper.accessMode === "fulltext_blocked")
    ))
    .map((paper) => paper.id);
  const includedPapers = ordered.filter((paper) => paper.screeningDecision === "include");
  const qualityEligibleIncludedPapers = includedPapers.filter((paper) => sourceQualityAssessmentForPaper(paper).tier !== "low");
  const collapsed = collapseReviewSeries(qualityEligibleIncludedPapers);
  const synthesisPaperIds = collapsed.selected.slice(0, 24).map((paper) => paper.id);
  const deferredPaperIds = includedPaperIds.filter((paperId) => !synthesisPaperIds.includes(paperId));
  const reviewedPapers = ordered.filter((paper) => synthesisPaperIds.includes(paper.id));
  const notes = [
    `Title screened ${titleScreenedPaperIds.length} canonical papers.`,
    `Abstract screened ${abstractScreenedPaperIds.length} papers and full-text screened ${fulltextScreenedPaperIds.length}.`,
    `Included ${includedPaperIds.length} papers after screening, with ${blockedPaperIds.length} still blocked or credential-limited.`,
    `Source-quality tiers: ${qualityCounts.high} high, ${qualityCounts.medium} medium, ${qualityCounts.low} low.`,
    ...collapsed.notes,
    synthesisPaperIds.length === includedPaperIds.length
      ? `Selected all ${synthesisPaperIds.length} included papers for synthesis.`
      : `Selected ${synthesisPaperIds.length} included papers for synthesis and deferred ${deferredPaperIds.length} additional included papers for later passes.`
  ];

  return {
    reviewedPapers,
    reviewWorkflow: {
      titleScreenedPaperIds,
      abstractScreenedPaperIds,
      fulltextScreenedPaperIds,
      includedPaperIds,
      excludedPaperIds,
      uncertainPaperIds,
      blockedPaperIds,
      synthesisPaperIds,
      deferredPaperIds,
      counts: {
        titleScreened: titleScreenedPaperIds.length,
        abstractScreened: abstractScreenedPaperIds.length,
        fulltextScreened: fulltextScreenedPaperIds.length,
        included: includedPaperIds.length,
        excluded: excludedPaperIds.length,
        uncertain: uncertainPaperIds.length,
        blocked: blockedPaperIds.length,
        selectedForSynthesis: synthesisPaperIds.length,
        deferred: deferredPaperIds.length
      },
      notes
    }
  };
}

function canonicalPaperFromSources(
  key: string,
  sources: ResearchSource[],
  resolverCandidates: PaperAccessRecord[]
): CanonicalPaper {
  const primary = [...sources].sort((left, right) => {
    const leftAccess = left.access === null || left.access.accessMode === undefined ? 0 : accessRank(left.access as PaperAccessRecord);
    const rightAccess = right.access === null || right.access.accessMode === undefined ? 0 : accessRank(right.access as PaperAccessRecord);
    return rightAccess - leftAccess || (right.excerpt.length - left.excerpt.length);
  })[0]!;
  const identifiers: PaperIdentifiers = {
    doi: normalizeDoi(primary.identifiers.doi ?? null),
    pmid: primary.identifiers.pmid ?? null,
    pmcid: primary.identifiers.pmcid ?? null,
    arxivId: normalizeArxivId(primary.identifiers.arxivId ?? null)
  };

  for (const source of sources) {
    identifiers.doi = normalizeDoi(source.identifiers.doi ?? identifiers.doi) ?? identifiers.doi;
    identifiers.pmid = source.identifiers.pmid ?? identifiers.pmid;
    identifiers.pmcid = source.identifiers.pmcid ?? identifiers.pmcid;
    identifiers.arxivId = normalizeArxivId(source.identifiers.arxivId ?? identifiers.arxivId) ?? identifiers.arxivId;
  }

  const accessCandidates = [
    ...sources.flatMap((source) => source.access === null ? [] : [source.access as PaperAccessRecord]),
    ...resolverCandidates
  ];
  const access = resolveFromExistingCandidates({
    id: createLiteratureEntityId("paper", key),
    key,
    title: primary.title,
    citation: primary.citation,
    abstract: primary.excerpt.length > 0 ? primary.excerpt : null,
    year: primary.year,
    authors: primary.authors,
    venue: primary.venue,
    discoveredVia: [],
    identifiers,
    discoveryRecords: [],
    accessCandidates,
    bestAccessUrl: primary.locator,
    bestAccessProvider: primary.providerId,
    accessMode: "metadata_only",
    fulltextFormat: "none",
    license: null,
    tdmAllowed: null,
    contentStatus: {
      abstractAvailable: primary.excerpt.length > 0,
      fulltextAvailable: false,
      fulltextFetched: false,
      fulltextExtracted: false
    },
    screeningStage: "title",
    screeningDecision: "uncertain",
    screeningRationale: null,
    accessErrors: [],
    tags: [],
    runIds: [],
    linkedThemeIds: [],
    linkedClaimIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const assessment = sources
    .map((source) => source.assessment ?? null)
    .find((candidate) => candidate !== null) ?? null;
  const stage = screeningStageFromAccess(access.best.accessMode);
  const provisionalPaper: CanonicalPaper = {
    id: createLiteratureEntityId("paper", key),
    key,
    title: primary.title,
    citation: primary.citation,
    abstract: primary.excerpt.length > 0 ? primary.excerpt : null,
    year: primary.year,
    authors: uniqueStrings(sources.flatMap((source) => source.authors)),
    venue: primary.venue,
    discoveredVia: uniqueStrings(sources.flatMap((source) => source.providerId === null ? [] : [source.providerId]))
      .map((providerId) => normalizeProviderId(providerId))
      .flatMap((providerId) => providerId === null ? [] : [providerId]),
    identifiers,
    discoveryRecords: sources.flatMap((source) => source.providerId === null ? [] : [{
      providerId: source.providerId,
      sourceId: source.id,
      title: source.title,
      locator: source.locator,
      citation: source.citation,
      year: source.year
    } satisfies PaperDiscoveryRecord]),
    accessCandidates: access.candidates,
    bestAccessUrl: access.best.url,
    bestAccessProvider: access.best.providerId,
    accessMode: access.best.accessMode,
    fulltextFormat: access.best.fulltextFormat,
    license: access.best.license,
    tdmAllowed: access.best.tdmAllowed,
    contentStatus: {
      abstractAvailable: primary.excerpt.length > 0 || access.best.accessMode !== "metadata_only",
      fulltextAvailable: access.best.accessMode === "fulltext_open" || access.best.accessMode === "fulltext_licensed",
      fulltextFetched: false,
      fulltextExtracted: false
    },
    screeningStage: stage,
    screeningDecision: "uncertain",
    screeningRationale: null,
    accessErrors: access.accessErrors,
    tags: [],
    runIds: [],
    linkedThemeIds: [],
    linkedClaimIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const quality = sourceQualityAssessmentForPaper(provisionalPaper);
  const screening = screeningDecision(sources.map((source) => source.id), sources, stage, assessment, quality);
  const assessmentTags = assessment === null
    ? []
    : [
      ...assessment.matchedDomainAnchors.map((anchor) => `topic-anchor:${slug(anchor)}`),
      ...assessment.matchedFocusConcepts.map((concept) => `focus:${slug(concept)}`),
      ...assessment.matchedTaskAttributes.map((attribute) => `task:${attribute}`)
    ];
  const qualityTags = [
    `quality:${quality.tier}`,
    ...quality.signals.map((signal) => `quality-signal:${signal}`),
    ...assessmentTags
  ];

  return {
    ...provisionalPaper,
    screeningDecision: screening.decision,
    screeningRationale: screening.rationale,
    tags: qualityTags
  };
}

function sourceTokensForBrief(request: ResearchSourceGatherRequest): Set<string> {
  return new Set([
    ...(request.brief.topic === null ? [] : tokenize(request.brief.topic)),
    ...(request.brief.researchQuestion === null ? [] : tokenize(request.brief.researchQuestion)),
    ...(request.brief.researchDirection === null ? [] : tokenize(request.brief.researchDirection)),
    ...request.plan.localFocus.flatMap(tokenize)
  ]);
}

function filterCandidates(
  rawCandidates: RawCandidate[],
  request: ResearchSourceGatherRequest,
  profile: LiteratureReviewProfile | null
): { sources: ResearchSource[]; notes: string[]; assessments: Array<{ sourceId: string; title: string; assessment: LiteratureSourceAssessment }> } {
  const notes: string[] = [];
  const assessments: Array<{ sourceId: string; title: string; assessment: LiteratureSourceAssessment }> = [];
  const acceptedSources: ResearchSource[] = [];
  const referenceTokens = sourceTokensForBrief(request);
  const anchorTokens = topicAnchorTokens(request);
  const topicTokens = coreTopicTokens(request);
  const minimumTopicMatches = minimumCoreTopicMatches(topicTokens);
  let filtered = 0;

  for (const candidate of rawCandidates) {
    const source = toResearchSource(candidate);
    const screening = screeningForSource(source, profile);
    const heuristicScore = overlapScore(`${source.title} ${source.excerpt}`, referenceTokens);
    const strongTopicScore = coreTopicScore(`${source.title} ${source.excerpt}`, topicTokens);

    if (screening.assessment !== undefined) {
      source.assessment = screening.assessment;
    }

    if (screening.assessment !== undefined) {
      assessments.push({
        sourceId: source.id,
        title: source.title,
        assessment: screening.assessment
      });
    }

    const anchorScore = overlapScore(`${source.title} ${source.excerpt}`, anchorTokens);
    const topicPhraseMatch = containsTopicPhrase(source, request);
    const strongTopicAccepted = topicTokens.size === 0
      || strongTopicScore >= minimumTopicMatches
      || topicPhraseMatch;
    const profileAccepted = profile === null
      ? screening.accepted || heuristicScore >= 3
      : (
        screening.accepted
        || (
          screening.assessment !== undefined
          && screening.assessment.topicScore >= 6
          && (screening.assessment.focusScore >= 2 || screening.assessment.taskAttributeScore >= 4)
        )
        || (topicPhraseMatch && heuristicScore >= 3)
      );
    const accepted = strongTopicAccepted
      && profileAccepted
      && (anchorTokens.size === 0 || anchorScore >= 2 || topicPhraseMatch || strongTopicScore >= minimumTopicMatches);

    if (!accepted) {
      filtered += 1;
      continue;
    }

    acceptedSources.push(source);
  }

  if (filtered > 0) {
    notes.push(`Filtered ${filtered} weakly matched scholarly candidates during screening.`);
  }

  return {
    sources: acceptedSources,
    notes,
    assessments
  };
}

function backgroundFilter(
  candidates: RawCandidate[],
  request: ResearchSourceGatherRequest
): ResearchSource[] {
  const referenceTokens = sourceTokensForBrief(request);

  return candidates
    .map(toResearchSource)
    .filter((source) => overlapScore(`${source.title} ${source.excerpt}`, referenceTokens) >= 2)
    .slice(0, 3);
}

async function queryProvider(
  providerId: SourceProviderId,
  queries: string[],
  request: ResearchSourceGatherRequest,
  budget: RetrievalBudget
): Promise<RawCandidate[]> {
  const authRef = readAuthRef(request, providerId);
  const authValue = authRef === null ? null : process.env[authRef] ?? null;
  const definition = getSourceProviderDefinition(providerId);

  if (
    (definition.authMode === "required_api_key" || definition.authMode === "institution_token")
    && (authValue === null || authValue.trim().length === 0)
  ) {
    return [];
  }

  const results: RawCandidate[] = [];
  const seen = new Set<string>();

  for (const query of queries.slice(0, budget.maxQueriesPerProvider)) {
    for (let pageIndex = 0; pageIndex < budget.maxPagesPerQuery; pageIndex += 1) {
      const page = await queryProviderPage(providerId, query, pageIndex, authValue, budget);

      for (const candidate of page.candidates) {
        const key = `${candidate.providerId}:${candidate.locator ?? candidate.title}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        results.push(candidate);

        if (results.length >= budget.maxCandidatesPerProvider) {
          return results;
        }
      }

      if (!page.hasMore || page.candidates.length === 0) {
        break;
      }
    }
  }

  return results;
}

async function resolveCanonicalAccess(
  paper: CanonicalPaper,
  routing: RoutingPlan,
  request: ResearchSourceGatherRequest
): Promise<AccessResolution> {
  const extraCandidates: PaperAccessRecord[] = [];
  const errors: string[] = [];
  let missingCredentials = false;

  for (const providerId of routing.resolverProviderIds) {
    try {
      if (providerId === "unpaywall") {
        const emailRef = readAuthRef(request, "unpaywall");
        const emailValue = emailRef === null ? null : process.env[emailRef] ?? null;

        if (emailValue === null || emailValue.trim().length === 0) {
          missingCredentials = true;
        }

        extraCandidates.push(...await resolveWithUnpaywall(paper, emailValue));
      }
    } catch (error) {
      errors.push(`${providerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let candidates = uniqueAccessCandidates([
    ...paper.accessCandidates,
    ...extraCandidates
  ]);
  const hasReadableCandidate = candidates.some((candidate) => (
    candidate.accessMode === "abstract_available"
    || candidate.accessMode === "fulltext_open"
    || candidate.accessMode === "fulltext_licensed"
  ));
  let best: PaperAccessRecord;

  if (candidates.length === 0) {
    best = accessRecord(
      paper.bestAccessProvider ?? "crossref",
      paper.bestAccessUrl,
      "metadata_only",
      "none",
      "No better reading route was found."
    );
    candidates = [best];
  } else if (!hasReadableCandidate && missingCredentials) {
    best = accessRecord(
      paper.bestAccessProvider ?? paper.discoveryRecords[0]?.providerId ?? "crossref",
      paper.bestAccessUrl,
      "needs_credentials",
      "none",
      "Selected provider credentials are still required before this paper can be read."
    );
    candidates = uniqueAccessCandidates([...candidates, best]);
  } else if (!hasReadableCandidate && paper.bestAccessUrl !== null) {
    best = accessRecord(
      paper.bestAccessProvider ?? paper.discoveryRecords[0]?.providerId ?? "crossref",
      paper.bestAccessUrl,
      "fulltext_blocked",
      "none",
      "The paper was discovered, but no legal readable route was resolved."
    );
    candidates = uniqueAccessCandidates([...candidates, best]);
  } else {
    best = selectBestAccess(candidates);
  }

  return {
    best,
    candidates,
    accessErrors: errors
  };
}

function uniqueAccessCandidates(candidates: PaperAccessRecord[]): PaperAccessRecord[] {
  const seen = new Set<string>();
  const normalized: PaperAccessRecord[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.providerId}:${candidate.url ?? "none"}:${candidate.accessMode}:${candidate.fulltextFormat}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(candidate);
  }

  return normalized;
}

export class DefaultResearchSourceGatherer implements ResearchSourceGatherer {
  async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
    const scholarlyProviderIds = selectedScholarlyProviderIds(request);
    const backgroundProviderIds = selectedBackgroundProviderIds(request);
    const localEnabled = projectFilesEnabled(request);
    const authStatus = authSnapshots(request, scholarlyProviderIds, backgroundProviderIds, localEnabled);
    const notes: string[] = [];
    const mergeDiagnostics: string[] = [];
    const domain = classifyDomain(request.brief, request.plan);
    const routing = routeProviders(domain, scholarlyProviderIds);
    const literatureReviewActive = shouldUseLiteratureReviewSubsystem(request.plan, request.brief);
    const budget = buildRetrievalBudget(request, literatureReviewActive);
    const queries = buildQueryPlan(request, budget);
    routing.plannedQueries = queries;
    const literatureProfile = literatureReviewActive
      ? buildLiteratureReviewProfile({
        brief: request.brief,
        plan: request.plan,
        memoryContext: request.memoryContext
      })
      : null;
    const selectedAssessments: Array<{ sourceId: string; title: string; assessment: LiteratureSourceAssessment }> = [];
    const localSources = await gatherLocalProjectFiles(request);
    const scholarlySources: ResearchSource[] = [];
    const backgroundSources: ResearchSource[] = [];

    if (literatureProfile !== null) {
      notes.push("Literature review subsystem active.");
      if (literatureProfile.taskAttributes.length > 0) {
        notes.push(`Task-aware paper ranking attributes: ${literatureProfile.taskAttributes.join(", ")}.`);
      }
    }

    notes.push(`Query planning produced ${queries.length} retrieval queries.`);
    notes.push(
      `Retrieval budget: up to ${budget.maxQueriesPerProvider} queries per provider, ${budget.maxPagesPerQuery} pages per query, and ${budget.maxCandidatesPerProvider} raw candidates per provider.`
    );
    notes.push(`Domain-aware routing selected ${routing.discoveryProviderIds.join(", ") || "no scholarly discovery providers"}.`);

    const minimumProviderPassesBeforeStop = literatureReviewActive
      ? Math.min(domain === "biomedical" ? 4 : 3, routing.discoveryProviderIds.length)
      : 1;

    for (const [providerIndex, providerId] of routing.discoveryProviderIds.entries()) {
      try {
        const rawCandidates = await queryProvider(providerId, queries, request, budget);
        const filtered = filterCandidates(rawCandidates, request, literatureProfile);
        scholarlySources.push(...filtered.sources);
        notes.push(...filtered.notes);
        selectedAssessments.push(...filtered.assessments);
        notes.push(
          `Collected ${filtered.sources.length} screened scholarly hits from ${getSourceProviderDefinition(providerId).label} after reviewing ${rawCandidates.length} raw candidates.`
        );

        if (
          scholarlySources.length >= budget.targetAcceptedSources
          && providerIndex + 1 >= minimumProviderPassesBeforeStop
        ) {
          notes.push(
            `Reached the current screened-source target (${budget.targetAcceptedSources}) after querying ${providerIndex + 1} providers and stopped discovery early.`
          );
          break;
        }
      } catch (error) {
        notes.push(`${getSourceProviderDefinition(providerId).label} query failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const providerId of backgroundProviderIds) {
      try {
        const rawCandidates = await queryProvider(providerId, queries, request, {
          ...budget,
          maxQueriesPerProvider: Math.min(6, budget.maxQueriesPerProvider),
          maxPagesPerQuery: 1,
          maxCandidatesPerProvider: 12,
          pageSize: 5
        });
        const filtered = backgroundFilter(rawCandidates, request);
        backgroundSources.push(...filtered);
        notes.push(`Collected ${filtered.length} background sources from ${getSourceProviderDefinition(providerId).label}.`);
      } catch (error) {
        notes.push(`${getSourceProviderDefinition(providerId).label} background query failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const groupedSources = new Map<string, ResearchSource[]>();
    const heuristicIndex = new Map<string, string>();

    for (const source of scholarlySources) {
      const key = mergeKeyForSource(source);
      const heuristicKey = `heuristic:${titleHeuristicKey(source.title, source.year, source.authors)}`;
      const existingKey = groupedSources.has(key)
        ? key
        : heuristicIndex.get(heuristicKey) ?? key;
      const group = groupedSources.get(existingKey) ?? [];
      group.push(source);
      groupedSources.set(existingKey, group);
      heuristicIndex.set(heuristicKey, existingKey);
    }

    const canonicalPapers: CanonicalPaper[] = [];

    for (const [key, group] of groupedSources.entries()) {
      const provisional = canonicalPaperFromSources(key, group, []);
      const resolved = await resolveCanonicalAccess(provisional, routing, request);
      const paper = canonicalPaperFromSources(key, group, resolved.candidates).id === provisional.id
        ? {
          ...canonicalPaperFromSources(key, group, resolved.candidates),
          bestAccessUrl: resolved.best.url,
          bestAccessProvider: resolved.best.providerId,
          accessMode: resolved.best.accessMode,
          fulltextFormat: resolved.best.fulltextFormat,
          license: resolved.best.license,
          tdmAllowed: resolved.best.tdmAllowed,
          accessErrors: resolved.accessErrors
        }
        : provisional;

      canonicalPapers.push(paper);

      if (group.length > 1) {
        mergeDiagnostics.push(`Merged ${group.length} provider hits into canonical paper ${paper.id}.`);
      }
    }

    notes.push(`Canonical merge produced ${canonicalPapers.length} scholarly papers from ${scholarlySources.length} discovery hits.`);
    const { reviewedPapers, reviewWorkflow } = buildReviewWorkflow(canonicalPapers);
    notes.push(...reviewWorkflow.notes);

    const allSources: ResearchSource[] = [
      {
        id: "brief:project",
        providerId: null,
        category: "brief",
        kind: "project_brief",
        title: request.brief.topic ?? request.plan.objective,
        locator: null,
        citation: "User-provided project brief.",
        excerpt: excerptText([
          request.brief.topic,
          request.brief.researchQuestion,
          request.brief.researchDirection,
          request.brief.successCriterion
        ].filter((value): value is string => typeof value === "string").join(" | ")),
        year: null,
        authors: [],
        venue: null,
        identifiers: {},
        access: null
      },
      ...localSources,
      ...scholarlySources,
      ...backgroundSources
    ];

    return {
      sources: allSources,
      canonicalPapers,
      reviewedPapers,
      notes,
      routing,
      mergeDiagnostics,
      authStatus,
      reviewWorkflow,
      literatureReview: literatureProfile === null
        ? null
        : {
          active: true,
          profile: literatureProfile,
          selectedAssessments
        }
    };
  }
}

export function createDefaultResearchSourceGatherer(): ResearchSourceGatherer {
  return new DefaultResearchSourceGatherer();
}
