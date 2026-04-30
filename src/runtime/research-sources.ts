import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  credentialValue,
  type CredentialStoreState
} from "./credential-store.js";
import {
  assessLiteratureSource,
  assessPaperFacetCoverage,
  buildReviewFacets,
  buildReviewSelectionQuality,
  buildLiteratureReviewProfile,
  isCoreTopicReviewFacet,
  isRetrievalQualityConstraintPhrase,
  isSubstantiveReviewFacet,
  shouldUseLiteratureReviewSubsystem,
  type LiteratureReviewProfile,
  type LiteratureSourceAssessment,
  type PaperFacetCoverage,
  type ReviewFacet,
  type ReviewSelectionQuality
} from "./literature-review.js";
import type {
  CanonicalPaper,
  PaperAccessMode,
  PaperAccessRecord,
  PaperDiscoveryRecord,
  PaperFulltextFormat,
  PaperIdentifiers,
  PaperScreeningStatus,
  LiteratureContext
} from "./literature-store.js";
import { createLiteratureEntityId } from "./literature-store.js";
import type { ProjectMemoryContext } from "./memory-store.js";
import {
  defaultBackgroundProviderIds,
  defaultScholarlyProviderIds,
  getSourceProviderDefinition,
  isGeneralWebProviderCategory,
  isScholarlyProviderCategory,
  normalizeProviderId,
  providerAuthStatus,
  providerCredentialFields,
  type ProviderAuthStatus,
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
const ieeeXploreBaseUrl = process.env.CLAWRESEARCH_IEEE_XPLORE_BASE_URL ?? "https://ieeexploreapi.ieee.org";
const elsevierBaseUrl = process.env.CLAWRESEARCH_ELSEVIER_BASE_URL ?? "https://api.elsevier.com";
const springerNatureBaseUrl = process.env.CLAWRESEARCH_SPRINGER_NATURE_BASE_URL ?? "https://api.springernature.com";
const providerFetchTimeoutMs = 30_000;

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
const mathematicsCuePattern = /\b(riemann hypothesis|riemann zeta|zeta function|number theory|analytic number theory|prime numbers?|prime-number|l-functions?|dedekind zeta|mollifier|zero density|explicit formula|li'?s criterion|tauberian|modular forms?|mathematics|mathematical)\b/i;
const socialScienceCuePattern = /\b(employment|job|jobs|labor|labour|workforce|policy|policies|governance|public sector|public policy|economics|economic|sociology|social services?|social work|organizational|organisational|administration|education)\b/i;
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
  configuredFieldIds: string[];
  missingRequiredFieldIds: string[];
  missingOptionalFieldIds: string[];
  status: ProviderAuthStatus;
};

export type QueryExpansionSource =
  | "plan"
  | "brief_entity"
  | "brief_task"
  | "memory"
  | "literature"
  | "domain_vocabulary"
  | "rejected_candidate"
  | "revision"
  | "recovery";

export type QueryExpansionCandidate = {
  query: string;
  source: QueryExpansionSource;
  reason: string;
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

export type RetrievalDiagnostics = {
  queries: QueryExpansionCandidate[];
  providerAttempts: Array<{
    providerId: SourceProviderId;
    phase: "initial" | "revision" | "recovery";
    providerCalls: number;
    rawCandidateCount: number;
    acceptedSourceCount: number;
    error: string | null;
  }>;
  screeningSummary: {
    accepted: number;
    rejected: number;
    weakMatchSamples: Array<{ title: string; rationale: string }>;
  };
  revisionPasses: number;
  recoveryPasses?: number;
  accessLimitations: string[];
  suggestedNextQueries: string[];
};

export type SourceGatherProgressEvent = {
  phase:
    | "setup"
    | "provider_query"
    | "screening"
    | "canonical_merge"
    | "access_resolution"
    | "review_selection"
    | "completed";
  status: "started" | "progress" | "completed" | "skipped" | "failed";
  message: string;
  providerId?: SourceProviderId;
  query?: string;
  queryIndex?: number;
  queryCount?: number;
  pageIndex?: number;
  providerIndex?: number;
  providerCount?: number;
  paperId?: string;
  paperIndex?: number;
  paperCount?: number;
  counts?: Record<string, number>;
};

export type LiteratureRelevanceStatus =
  | "in_scope"
  | "borderline"
  | "excluded";

export type LiteratureSourceRole =
  | "primary_system"
  | "benchmark"
  | "survey"
  | "method_component"
  | "background"
  | "off_topic";

export type LiteratureSelectionDecision =
  | "selected_primary"
  | "selected_supporting"
  | "deferred"
  | "excluded";

export type LiteratureRelevanceAssessment = {
  paperId: string;
  title: string;
  status: LiteratureRelevanceStatus;
  sourceRole: LiteratureSourceRole;
  selectionDecision: LiteratureSelectionDecision;
  selectionReason: string;
  criticConcerns: string[];
  requiredForManuscript: boolean;
  reviewer: "hybrid_protocol_gate";
  matchedCriteria: string[];
  missingCriteria: string[];
  reason: string;
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
    relevanceAssessments?: LiteratureRelevanceAssessment[];
  } | null;
  retrievalDiagnostics?: RetrievalDiagnostics;
  selectionQuality?: ReviewSelectionQuality | null;
  relevanceAssessments?: LiteratureRelevanceAssessment[];
  agenticSourceState?: AgenticSourceState | null;
};

export type ResearchSourceGatherRequest = {
  projectRoot: string;
  brief: ResearchBrief;
  plan: ResearchPlan;
  memoryContext: ProjectMemoryContext;
  literatureContext?: LiteratureContext;
  revisionQueries?: string[];
  recoveryQueries?: string[];
  criticExcludedPaperIds?: string[];
  criticPromotedPaperIds?: string[];
  providerIds?: SourceProviderId[];
  scholarlyProviderIds?: SourceProviderId[];
  generalWebProviderIds?: SourceProviderId[];
  projectFilesEnabled?: boolean;
  credentials?: CredentialStoreState;
  progress?: (event: SourceGatherProgressEvent) => void | Promise<void>;
};

export interface ResearchSourceGatherer {
  gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult>;
}

export type SourceToolObservation = {
  action: "query_provider" | "merge_sources" | "rank_sources" | "resolve_access" | "select_evidence_set";
  message: string;
  counts: {
    providerCalls?: number;
    rawCandidates?: number;
    newSources?: number;
    scholarlySources?: number;
    canonicalPapers?: number;
    candidatePapers?: number;
    resolvedPapers?: number;
    selectedPapers?: number;
  };
};

export type SourceProviderYield = {
  providerId: SourceProviderId;
  calls: number;
  rawCandidates: number;
  newSources: number;
  errors: number;
  lastError: string | null;
};

export type SourceMergeReadiness = {
  ready: boolean;
  reason: string;
  recommendedActions: Array<"merge_sources" | "rank_sources" | "resolve_access" | "select_evidence_set">;
};

export type SourceActionHistoryEntry = {
  action: SourceToolObservation["action"];
  providerId: SourceProviderId | null;
  queryKey: string | null;
  rawCandidates: number;
  newSources: number;
  error: string | null;
  message: string;
};

export type AgenticSourceState = {
  availableProviderIds: SourceProviderId[];
  attemptedProviderIds: SourceProviderId[];
  candidateQueries: string[];
  rawSources: number;
  screenedSources: number;
  backgroundSources: number;
  sourceStage: string;
  canonicalPapers: number;
  candidatePaperIds: string[];
  resolvedPaperIds: string[];
  selectedPapers: number;
  selectedPaperIds: string[];
  newSourcesLastAction: number;
  consecutiveNoProgressSearches: number;
  providerYields: SourceProviderYield[];
  exhaustedProviderIds: SourceProviderId[];
  repeatedSearchWarnings: string[];
  mergeReadiness: SourceMergeReadiness;
  recentActions: SourceActionHistoryEntry[];
  lastObservation: string | null;
};

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
  maxProviderCallsPerProvider: number;
  pageSize: number;
  maxPagesPerQuery: number;
  maxCandidatesPerProvider: number;
  maxAccessResolutions: number;
  accessResolutionCheckpointSize: number;
  targetAcceptedSources: number;
};

type FilterCandidatesResult = {
  sources: ResearchSource[];
  notes: string[];
  assessments: Array<{ sourceId: string; title: string; assessment: LiteratureSourceAssessment }>;
  rejectedSamples: Array<{ title: string; excerpt: string; rationale: string }>;
  acceptedCount: number;
  rejectedCount: number;
};

type CanonicalReviewState = {
  canonicalPapers: CanonicalPaper[];
  reviewedPapers: CanonicalPaper[];
  reviewWorkflow: ReviewWorkflowSummary;
  selectionQuality: ReviewSelectionQuality | null;
  mergeDiagnostics: string[];
  relevanceAssessments: LiteratureRelevanceAssessment[];
};

type ProviderPageResult = {
  candidates: RawCandidate[];
  hasMore: boolean;
};

type ProviderQueryResult = {
  candidates: RawCandidate[];
  providerCalls: number;
};

type CanonicalReviewBuildOptions = {
  maxAccessResolutions: number;
  accessResolutionCheckpointSize: number;
  targetPaperIds?: string[];
  progress?: ResearchSourceGatherRequest["progress"];
};

async function emitSourceProgress(
  progress: ResearchSourceGatherRequest["progress"],
  event: SourceGatherProgressEvent
): Promise<void> {
  if (progress === undefined) {
    return;
  }

  await progress(event);
}

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

function safeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }

    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }

  return null;
}

function yearFromUnknown(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/\b(19|20)\d{2}\b/);
  return match === null ? null : Number.parseInt(match[0], 10);
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

function normalizeQueryKey(value: string): string {
  return normalizeWhitespace(value.toLowerCase());
}

function uniqueQueryCandidates(candidates: QueryExpansionCandidate[]): QueryExpansionCandidate[] {
  const seen = new Set<string>();
  const result: QueryExpansionCandidate[] = [];

  for (const candidate of candidates) {
    const query = normalizeWhitespace(candidate.query);
    const key = normalizeQueryKey(query);

    if (query.length === 0 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      ...candidate,
      query
    });
  }

  return result;
}

function queryCandidate(
  query: string | null | undefined,
  source: QueryExpansionSource,
  reason: string
): QueryExpansionCandidate[] {
  const normalized = typeof query === "string" ? normalizeWhitespace(query) : "";

  return normalized.length === 0
    ? []
    : [{ query: normalized, source, reason }];
}

function queryTokenSequence(text: string | null | undefined): string[] {
  if (typeof text !== "string") {
    return [];
  }

  return matchTokens(text)
    .filter((token) => !stopTokens.has(token))
    .filter((token) => token.length >= 3 || preservedShortTokens.has(token));
}

function keyPhrasesFromText(text: string | null | undefined, limit: number): string[] {
  const tokens = queryTokenSequence(text);
  const phrases: string[] = [];

  if (tokens.length === 0) {
    return [];
  }

  for (const size of [4, 3, 2]) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      phrases.push(tokens.slice(index, index + size).join(" "));
    }
  }

  phrases.push(tokens.slice(0, Math.min(6, tokens.length)).join(" "));

  return uniqueStrings(phrases).slice(0, limit);
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

function credentialEnvFallbackNames(
  providerId: SourceProviderId,
  fieldId: string
): string[] {
  if (providerId === "elsevier" && fieldId === "api_key") {
    return ["ELSEVIER_API_KEY", "SCOPUS_API_KEY"];
  }

  if (providerId === "elsevier" && fieldId === "institution_token") {
    return ["SCIENCEDIRECT_INSTITUTION_TOKEN", "ELSEVIER_INSTITUTION_TOKEN"];
  }

  const definition = getSourceProviderDefinition(providerId);
  return definition.defaultEnvVarName === null
    ? []
    : [definition.defaultEnvVarName];
}

function readCredentialValue(
  request: ResearchSourceGatherRequest,
  providerId: SourceProviderId,
  fieldId: string
): string | null {
  const fromStore = request.credentials === undefined
    ? null
    : credentialValue(request.credentials, providerId, fieldId);

  if (fromStore !== null) {
    return fromStore;
  }

  return readAmbientEnvVar(...credentialEnvFallbackNames(providerId, fieldId));
}

function readAmbientEnvVar(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function readElsevierApiKey(request: ResearchSourceGatherRequest): string | null {
  return readCredentialValue(request, "elsevier", "api_key");
}

function readElsevierInstitutionToken(request: ResearchSourceGatherRequest): string | null {
  return readCredentialValue(request, "elsevier", "institution_token");
}

function authSnapshots(
  request: ResearchSourceGatherRequest,
  scholarlyProviderIds: SourceProviderId[],
  generalWebProviderIds: SourceProviderId[],
  projectFilesEnabled: boolean
): ProviderAuthSnapshot[] {
  const providerIds = uniqueProviderIds([
    ...(projectFilesEnabled ? ["project_files" as const] : []),
    ...scholarlyProviderIds,
    ...generalWebProviderIds
  ]);

  return providerIds.map((providerId) => {
    const fields = providerCredentialFields(providerId);
    const configuredFieldIds = fields
      .filter((field) => readCredentialValue(request, providerId, field.id) !== null)
      .map((field) => field.id);
    const configured = new Set(configuredFieldIds);

    return {
      providerId,
      configuredFieldIds,
      missingRequiredFieldIds: fields
        .filter((field) => field.required && !configured.has(field.id))
        .map((field) => field.id),
      missingOptionalFieldIds: fields
        .filter((field) => !field.required && !configured.has(field.id))
        .map((field) => field.id),
      status: providerAuthStatus(providerId, configuredFieldIds)
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
      request.providerIds.filter((providerId) => isScholarlyProviderCategory(getSourceProviderDefinition(providerId).category))
    );
  }

  return defaultScholarlyProviderIds();
}

function selectedGeneralWebProviderIds(request: ResearchSourceGatherRequest): SourceProviderId[] {
  if (request.generalWebProviderIds !== undefined) {
    return uniqueProviderIds(request.generalWebProviderIds);
  }

  if (request.providerIds !== undefined) {
    return uniqueProviderIds(
      request.providerIds.filter((providerId) => isGeneralWebProviderCategory(getSourceProviderDefinition(providerId).category))
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

function cueScore(primary: string, secondary: string, pattern: RegExp): number {
  let score = 0;

  if (pattern.test(primary)) {
    score += 3;
  }

  if (secondary.length > 0 && pattern.test(secondary)) {
    score += 1;
  }

  return score;
}

function classifyDomain(brief: ResearchBrief, plan: ResearchPlan): SourceProviderDomain | "mixed" {
  const primary = [
    brief.topic,
    brief.researchQuestion,
    brief.researchDirection,
    plan.objective,
    plan.rationale,
    ...plan.localFocus
  ].filter((value): value is string => typeof value === "string")
    .join(" ");
  const secondary = plan.searchQueries.join(" ");

  const csAi = cueScore(primary, secondary, csAiCuePattern);
  const biomedical = cueScore(primary, secondary, biomedicalCuePattern);
  const mathematics = cueScore(primary, secondary, mathematicsCuePattern);
  const socialScience = cueScore(primary, secondary, socialScienceCuePattern);
  const socialCare = socialCareCuePattern.test(`${primary} ${secondary}`);

  if (socialCare && (biomedical > 0 || csAi > 0 || socialScience > 0)) {
    return "biomedical";
  }

  if (csAi > 0 && biomedical > 0 && Math.abs(csAi - biomedical) <= 1) {
    return "mixed";
  }

  if (mathematics > 0 && mathematics >= csAi && mathematics >= biomedical && mathematics >= socialScience) {
    return "mathematics";
  }

  if (biomedical > 0 && biomedical >= csAi && biomedical >= socialScience) {
    return "biomedical";
  }

  if (socialScience > 0 && socialScience >= csAi) {
    return "social_science";
  }

  if (csAi > 0) {
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
    ...request.plan.localFocus,
    ...(request.revisionQueries ?? []),
    ...(request.recoveryQueries ?? [])
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
    maxProviderCallsPerProvider: literatureReviewActive ? 24 : 8,
    pageSize: literatureReviewActive ? 25 : 10,
    maxPagesPerQuery: literatureReviewActive ? 6 : 2,
    maxCandidatesPerProvider: literatureReviewActive ? 200 : 40,
    maxAccessResolutions: literatureReviewActive ? 32 : 12,
    accessResolutionCheckpointSize: literatureReviewActive ? 8 : 4,
    targetAcceptedSources: literatureReviewActive ? 120 : 24
  };
}

function primaryQueryAnchor(request: ResearchSourceGatherRequest): string {
  const primaryTopic = request.brief.topic ?? request.plan.objective;
  return compactQueryPhrase(primaryTopic, 8) ?? primaryTopic;
}

function combinedResearchText(request: ResearchSourceGatherRequest): string {
  return [
    request.brief.topic,
    request.brief.researchQuestion,
    request.brief.researchDirection,
    request.brief.successCriterion,
    request.plan.objective,
    request.plan.rationale,
    ...request.plan.searchQueries,
    ...request.plan.localFocus
  ].filter((value): value is string => typeof value === "string").join(" ");
}

function buildBriefEntityQueryCandidates(request: ResearchSourceGatherRequest): QueryExpansionCandidate[] {
  const fields = [
    request.brief.topic,
    request.brief.researchQuestion,
    request.brief.researchDirection,
    request.brief.successCriterion,
    request.plan.objective,
    ...request.plan.localFocus
  ];

  return uniqueStrings(fields.flatMap((field) => keyPhrasesFromText(field, 4)))
    .slice(0, 18)
    .flatMap((phrase) => queryCandidate(phrase, "brief_entity", "Extracted from the research brief or local focus."));
}

function buildBriefTaskQueryCandidates(request: ResearchSourceGatherRequest): QueryExpansionCandidate[] {
  const text = combinedResearchText(request);
  const anchor = primaryQueryAnchor(request);
  const candidates: QueryExpansionCandidate[] = [];

  if (/\b(literature|review|survey|synthesis|mapping|taxonomy|related work|prior work)\b/i.test(text)) {
    candidates.push(...queryCandidate(`${anchor} literature review`, "brief_task", "The brief asks for literature synthesis or prior-work mapping."));
    candidates.push(...queryCandidate(`${anchor} survey`, "brief_task", "The brief asks for a review-style evidence base."));
  }

  if (/\b(compare|comparison|taxonomy|trade-?off|versus|vs\b)\b/i.test(text)) {
    candidates.push(...queryCandidate(`${anchor} comparison`, "brief_task", "The brief asks for comparison across approaches or evidence."));
  }

  if (/\b(evaluation|evaluate|benchmark|metric|baseline|evidence|success criteria?)\b/i.test(text)) {
    candidates.push(...queryCandidate(`${anchor} evaluation`, "brief_task", "The brief asks for evaluation evidence or success criteria."));
    candidates.push(...queryCandidate(`${anchor} benchmark`, "brief_task", "The brief asks for evaluable or benchmarkable evidence."));
  }

  if (/\b(implementation|architecture|system|workflow|tooling|runtime)\b/i.test(text)) {
    candidates.push(...queryCandidate(`${anchor} architecture`, "brief_task", "The brief asks about systems, implementation, or architecture."));
  }

  if (/\b(workforce|staffing|employment|jobs?|labor|labour|displacement|worker|workers)\b/i.test(text)) {
    candidates.push(...queryCandidate(`${anchor} workforce`, "brief_task", "The brief asks about workforce or labor effects."));
    candidates.push(...queryCandidate(`${anchor} staffing`, "brief_task", "The brief asks about staffing patterns."));
  }

  return uniqueQueryCandidates(candidates);
}

function buildDomainVocabularyQueryCandidates(
  request: ResearchSourceGatherRequest,
  domain: SourceProviderDomain | "mixed"
): QueryExpansionCandidate[] {
  const text = combinedResearchText(request);
  const anchor = primaryQueryAnchor(request);
  const candidates: QueryExpansionCandidate[] = [];
  const mathematicalVerification = domain === "mathematics"
    && /\b(rigorous|numerical|verification|verified|compute|computed|computation|error|bound|bounds|zeros?)\b/i.test(text);

  if (mathematicalVerification) {
    for (const term of ["rigorous computation", "error bounds", "interval arithmetic", "ball arithmetic", "numerical verification"]) {
      candidates.push(...queryCandidate(`${anchor} ${term}`, "domain_vocabulary", "Mathematical verification tasks often use this search vocabulary."));
    }
  }

  if (domain === "biomedical" && /\b(nursing homes?|long[- ]term care|care homes?|residential care|aged care)\b/i.test(text)) {
    for (const term of ["long-term care", "residential care", "care quality", "staffing", "workforce"]) {
      candidates.push(...queryCandidate(`${anchor} ${term}`, "domain_vocabulary", "Care-delivery and workforce questions often use this search vocabulary."));
    }
  }

  if ((domain === "cs_ai" || domain === "mixed") && /\b(agent|agents|autonomous|ai scientist|scientific discovery|research automation)\b/i.test(text)) {
    for (const term of ["agent evaluation", "scientific discovery agents", "literature synthesis agents", "tool-using agents"]) {
      candidates.push(...queryCandidate(`${anchor} ${term}`, "domain_vocabulary", "Research-agent questions often use this search vocabulary."));
    }
  }

  if ((domain === "cs_ai" || domain === "mixed") && /\b(experiment|experimentation|exploration|evaluation|paper writing|publication|scientific progress|scientific discovery)\b/i.test(text)) {
    for (const term of ["AI scientist experimentation", "autonomous scientific discovery", "agent benchmark evaluation", "research agent paper writing"]) {
      candidates.push(...queryCandidate(`${anchor} ${term}`, "domain_vocabulary", "End-to-end research-agent questions often need lifecycle-specific vocabulary."));
    }
  }

  if (domain === "social_science" && /\b(policy|governance|workforce|employment|organization|organisation)\b/i.test(text)) {
    for (const term of ["policy evidence", "organizational impact", "workforce impact"]) {
      candidates.push(...queryCandidate(`${anchor} ${term}`, "domain_vocabulary", "Social-science impact questions often use this search vocabulary."));
    }
  }

  return uniqueQueryCandidates(candidates);
}

function buildRecoveryQueryCandidates(
  request: ResearchSourceGatherRequest,
  rejectedSamples: Array<{ title: string; excerpt: string; rationale: string }>,
  selectionQuality: ReviewSelectionQuality | null = null
): QueryExpansionCandidate[] {
  const anchor = primaryQueryAnchor(request);
  const missingFacetQueries = selectionQuality?.missingRequiredFacets
    .filter((facet) => isSubstantiveReviewFacet(facet))
    .slice(0, 6)
    .flatMap((facet) => uniqueStrings([
      facet.label,
      facet.terms.slice(0, 4).join(" ")
    ])
      .filter((query) => !isRetrievalQualityConstraintPhrase(query))
      .flatMap((query) => queryCandidate(
        `${anchor} ${query}`,
        "revision",
        "Revision query for missing required review-facet coverage."
      ))) ?? [];
  const sampleQueries = rejectedSamples
    .slice(0, 8)
    .flatMap((sample) => keyPhrasesFromText(`${sample.title} ${sample.excerpt}`, 2))
    .slice(0, 8)
    .flatMap((phrase) => queryCandidate(`${anchor} ${phrase}`, "rejected_candidate", "Revision query from weakly matched candidate metadata."));
  const broadTaskQueries = [
    `${anchor} review`,
    `${anchor} survey`,
    `${anchor} evaluation`,
    `${anchor} limitations`
  ].flatMap((query) => queryCandidate(query, "revision", "Broad revision query for a thin evidence base."));

  return uniqueQueryCandidates([
    ...missingFacetQueries,
    ...sampleQueries,
    ...broadTaskQueries
  ]);
}

function buildQueryExpansionCandidates(
  request: ResearchSourceGatherRequest,
  domain: SourceProviderDomain | "mixed",
  recoveryCandidates: QueryExpansionCandidate[] = []
): QueryExpansionCandidate[] {
  const explicitQueries = uniqueStrings(request.plan.searchQueries);
  const topicPhrase = primaryQueryAnchor(request);
  const focusQueries = uniqueStrings([
    compactQueryPhrase(request.brief.researchQuestion, 7),
    compactQueryPhrase(request.brief.researchDirection, 7),
    compactQueryPhrase(request.brief.successCriterion, 7),
    ...request.plan.localFocus.map((focus) => compactQueryPhrase(focus, 5)),
    ...explicitQueries.map((query) => compactQueryPhrase(query, 8))
  ]);
  const literatureHints = request.literatureContext?.queryHints ?? [];
  const memoryHints = request.memoryContext.queryHints ?? [];
  const planCandidates = explicitQueries.flatMap((query) => queryCandidate(query, "plan", "Model-planned retrieval query."));
  const explicitRevisionQueries = uniqueStrings([
    ...(request.revisionQueries ?? []),
    ...(request.recoveryQueries ?? [])
  ]);
  const explicitRecoveryCandidates = explicitRevisionQueries
    .flatMap((query) => queryCandidate(query, "revision", "Requested by the autonomous evidence-revision loop."));
  const briefTaskCandidates = [
    ...focusQueries.map((query) => `${topicPhrase} ${query}`),
    topicPhrase
  ].flatMap((query) => queryCandidate(query, "brief_task", "Derived from the scoped brief and research plan."));
  const memoryCandidates = memoryHints.flatMap((hint) => queryCandidate(
    `${topicPhrase} ${compactQueryPhrase(hint, 6) ?? hint}`,
    "memory",
    "Project research journal query hint."
  ));
  const literatureCandidates = literatureHints.flatMap((hint) => queryCandidate(
    `${topicPhrase} ${compactQueryPhrase(hint, 6) ?? hint}`,
    "literature",
    "Canonical paper library query hint."
  ));

  return uniqueQueryCandidates([
    ...planCandidates,
    ...buildBriefEntityQueryCandidates(request),
    ...briefTaskCandidates,
    ...memoryCandidates,
    ...literatureCandidates,
    ...buildDomainVocabularyQueryCandidates(request, domain),
    ...explicitRecoveryCandidates,
    ...recoveryCandidates
  ]);
}

function interleaveQueryCandidates(candidates: QueryExpansionCandidate[], limit: number): QueryExpansionCandidate[] {
  const sourceOrder: QueryExpansionSource[] = [
    "plan",
    "brief_entity",
    "brief_task",
    "memory",
    "literature",
    "domain_vocabulary",
    "rejected_candidate",
    "revision",
    "recovery"
  ];
  const buckets = sourceOrder.map((source) => candidates.filter((candidate) => candidate.source === source));
  const seen = new Set<string>();
  const result: QueryExpansionCandidate[] = [];
  const maxBucketLength = Math.max(0, ...buckets.map((bucket) => bucket.length));

  for (let index = 0; index < maxBucketLength && result.length < limit; index += 1) {
    for (const bucket of buckets) {
      const candidate = bucket[index];
      const key = candidate === undefined ? null : normalizeQueryKey(candidate.query);

      if (candidate === undefined || key === null || seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(candidate);

      if (result.length >= limit) {
        break;
      }
    }
  }

  return result;
}

function buildQueryPlan(
  request: ResearchSourceGatherRequest,
  domain: SourceProviderDomain | "mixed",
  budget: RetrievalBudget,
  recoveryCandidates: QueryExpansionCandidate[] = []
): { candidates: QueryExpansionCandidate[]; selected: QueryExpansionCandidate[]; queries: string[] } {
  const candidates = buildQueryExpansionCandidates(request, domain, recoveryCandidates);
  const selected = interleaveQueryCandidates(candidates, budget.maxQueries);

  return {
    candidates,
    selected,
    queries: selected.map((candidate) => candidate.query)
  };
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
    ? ["elsevier", "ieee_xplore", "openalex", "arxiv", "dblp", "crossref", "springer_nature", "core", "unpaywall"]
    : domain === "biomedical"
      ? ["pubmed", "europe_pmc", "elsevier", "openalex", "crossref", "springer_nature", "core", "unpaywall"]
      : domain === "mathematics"
        ? ["openalex", "arxiv", "crossref", "springer_nature", "elsevier", "core", "unpaywall", "dblp", "ieee_xplore"]
        : domain === "social_science"
          ? ["openalex", "crossref", "elsevier", "springer_nature", "core", "unpaywall", "arxiv", "dblp", "ieee_xplore"]
      : domain === "general"
        ? ["openalex", "crossref", "elsevier", "springer_nature", "arxiv", "ieee_xplore", "core", "unpaywall", "dblp"]
        : ["openalex", "crossref", "elsevier", "arxiv", "dblp", "pubmed", "europe_pmc", "springer_nature", "ieee_xplore", "core", "unpaywall"];
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

function retryAfterDelayMs(value: string | null): number | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }

  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.min(5_000, Math.round(seconds * 1_000)));
  }

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, Math.min(5_000, timestamp - Date.now()));
  }

  return null;
}

function retryDelayMs(attempt: number, status: number | null = null, retryAfter: string | null = null): number {
  const retryAfterMs = retryAfterDelayMs(retryAfter);

  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  return status === 429
    ? 250 * attempt
    : 100 * attempt;
}

async function fetchWithRetry(
  url: URL,
  responseType: "json" | "text",
  init?: RequestInit
): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), providerFetchTimeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      const bodyText = await response.text();

      if (!response.ok) {
        const error = new Error(`${url.origin} responded with ${response.status} ${response.statusText}`);
        lastError = error;

        if (attempt < 3 && isRetriableStatus(response.status)) {
          await waitFor(retryDelayMs(attempt, response.status, response.headers.get("retry-after")));
          continue;
        }

        throw error;
      }

      return responseType === "json"
        ? JSON.parse(bodyText) as unknown
        : bodyText;
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
    } finally {
      clearTimeout(timer);
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
    category: getSourceProviderDefinition(candidate.providerId).category === "generalWeb"
      ? "background"
      : "scholarly",
    kind: getSourceProviderDefinition(candidate.providerId).category === "generalWeb"
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

function relaxedLiteratureAssessment(assessment: LiteratureSourceAssessment): LiteratureSourceAssessment {
  const strongDomainEvidence = assessment.matchedDomainAnchors.length > 0
    && (assessment.focusScore >= 2 || assessment.taskAttributeScore >= 4 || assessment.topicScore >= 6);
  const strongTaskFocusEvidence = assessment.focusScore >= 4 && assessment.taskAttributeScore >= 4;
  const highAggregateEvidence = assessment.totalScore >= 10;
  const accepted = assessment.accepted
    || strongDomainEvidence
    || strongTaskFocusEvidence
    || highAggregateEvidence;

  if (!accepted || assessment.accepted) {
    return assessment;
  }

  return {
    ...assessment,
    accepted: true,
    rationale: `${assessment.rationale} Retained because the combined topic, task, and focus evidence was strong enough for a first-pass literature review.`
  };
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
  const relaxedAssessment = relaxedLiteratureAssessment(assessment);

  return {
    assessment: relaxedAssessment,
    accepted: relaxedAssessment.accepted
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

function maybeArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) {
    return value;
  }

  return value === null || value === undefined ? [] : [value];
}

function urlFromRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = safeString(record[key]);

    if (value !== null) {
      return value;
    }
  }

  return null;
}

function parseElsevierAuthors(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === "string") {
        const name = safeString(entry);
        return name === null ? [] : [name];
      }

      const record = typeof entry === "object" && entry !== null
        ? entry as Record<string, unknown>
        : {};
      const explicit = safeString(record.full_name) ?? safeString(record.name);
      if (explicit !== null) {
        return [explicit];
      }

      const given = safeString(record["given-name"]) ?? safeString(record.given) ?? safeString(record.initials);
      const family = safeString(record.surname) ?? safeString(record.family);
      const combined = normalizeWhitespace([given, family].filter((part): part is string => part !== null).join(" "));
      return combined.length === 0 ? [] : [combined];
    });
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return parseElsevierAuthors(record.author ?? record.authors);
  }

  const text = safeString(value);
  return text === null ? [] : [text];
}

function normalizeIeeeAccessType(value: string | null): string | null {
  return value === null ? null : normalizeWhitespace(value).toLowerCase();
}

function parseIeeeArticleRecord(record: Record<string, unknown>): RawCandidate[] {
  const title = safeString(record.title);

  if (title === null) {
    return [];
  }

  const authors = parseElsevierAuthors(
    typeof record.authors === "object" && record.authors !== null
      ? (record.authors as Record<string, unknown>).authors ?? (record.authors as Record<string, unknown>).author
      : record.authors
  );
  const doi = normalizeDoi(safeString(record.doi));
  const htmlUrl = safeString(record.html_url);
  const pdfUrl = safeString(record.pdf_url);
  const abstractUrl = safeString(record.abstract_url);
  const accessType = normalizeIeeeAccessType(safeString(record.accessType));
  const note = accessType === "open access" || accessType === "ephemera"
    ? "IEEE Xplore marked this paper as open access."
    : accessType === "locked"
      ? "IEEE Xplore returned metadata, but full text remains locked behind a separate entitlement route."
      : "IEEE Xplore returned metadata.";
  const access = accessType === "open access" || accessType === "ephemera"
    ? accessRecord("ieee_xplore", pdfUrl ?? htmlUrl ?? abstractUrl, pdfUrl !== null ? "fulltext_open" : "abstract_available", pdfUrl !== null ? "pdf" : "html", note)
    : safeString(record.abstract) !== null
      ? accessRecord("ieee_xplore", abstractUrl ?? htmlUrl ?? pdfUrl, "abstract_available", "html", note)
      : accessRecord("ieee_xplore", abstractUrl ?? htmlUrl ?? pdfUrl, "metadata_only", "none", note);

  return [{
    providerId: "ieee_xplore" as const,
    title,
    locator: htmlUrl ?? abstractUrl ?? pdfUrl,
    citation: authorsToCitation(authors, yearFromUnknown(record.publication_year ?? record.publication_date), title, safeString(record.publication_title)),
    excerpt: safeString(record.abstract) ?? "",
    year: yearFromUnknown(record.publication_year ?? record.publication_date),
    authors,
    venue: safeString(record.publication_title),
    identifiers: {
      doi
    },
    access
  }];
}

async function queryIeeeXplore(
  query: string,
  apiKey: string,
  pageIndex: number,
  pageSize: number
): Promise<ProviderPageResult> {
  const url = new URL("/api/v1/search/articles", ieeeXploreBaseUrl);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("querytext", query);
  url.searchParams.set("start_record", String(pageIndex * Math.min(pageSize, 200) + 1));
  url.searchParams.set("max_records", String(Math.min(pageSize, 200)));
  const payload = await fetchJson(url) as { articles?: unknown[] | { article?: unknown[] | unknown } };
  const articleValue = Array.isArray(payload.articles)
    ? payload.articles
    : payload.articles !== undefined
      ? maybeArray((payload.articles as { article?: unknown[] | unknown }).article)
      : [];

  const candidates = articleValue.flatMap((entry) => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    return parseIeeeArticleRecord(record);
  });

  return {
    candidates,
    hasMore: candidates.length >= Math.min(pageSize, 200)
  };
}

function elsevierHeaders(
  apiKey: string,
  institutionToken: string | null = null
): Record<string, string> {
  return institutionToken === null
    ? {
      "X-ELS-APIKey": apiKey,
      Accept: "application/json"
    }
    : {
      "X-ELS-APIKey": apiKey,
      "X-ELS-Insttoken": institutionToken,
      Accept: "application/json"
    };
}

function parseElsevierSearchEntry(
  route: "scopus" | "sciencedirect",
  entry: Record<string, unknown>,
  options: {
    institutionToken?: string | null;
    defaultVenue?: string | null;
  } = {}
): RawCandidate[] {
  const title = safeString(entry["dc:title"]);

  if (title === null) {
    return [];
  }

  const authors = Array.isArray(entry.authors)
    ? parseElsevierAuthors(entry.authors)
    : parseElsevierAuthors((entry.authors as Record<string, unknown> | undefined)?.author ?? entry["dc:creator"]);
  const locator = urlFromRecord(entry, ["prism:url", "link", "url"])
    ?? maybeArray(entry.link)
      .flatMap((linkEntry) => {
        const linkRecord = typeof linkEntry === "object" && linkEntry !== null
          ? linkEntry as Record<string, unknown>
          : {};
        const href = safeString(linkRecord["@href"]) ?? safeString(linkRecord.href);
        return href === null ? [] : [href];
      })[0]
    ?? null;
  const abstractUrl = maybeArray(entry.link)
    .flatMap((linkEntry) => {
      const linkRecord = typeof linkEntry === "object" && linkEntry !== null
        ? linkEntry as Record<string, unknown>
        : {};
      const ref = safeString(linkRecord["@ref"]) ?? safeString(linkRecord.ref);
      const href = safeString(linkRecord["@href"]) ?? safeString(linkRecord.href);
      return ref === "abstract" && href !== null ? [href] : [];
    })[0] ?? null;
  const venue = safeString(entry["prism:publicationName"]) ?? options.defaultVenue ?? null;
  const year = yearFromUnknown(entry["prism:coverDate"] ?? entry["prism:coverDisplayDate"] ?? entry.coverDate);
  const doi = normalizeDoi(safeString(entry["prism:doi"]) ?? safeString(entry["dc:identifier"]));
  const pmid = safeString(entry["pubmed-id"]);
  const openAccess = safeBoolean(entry.openaccessArticle) ?? safeBoolean(entry.openaccess) ?? false;
  const openLicense = safeString(entry.openaccessUserLicense);
  const abstract = safeString(entry["dc:description"]) ?? safeString(entry["prism:teaser"]) ?? "";
  const note = route === "sciencedirect"
    ? openAccess
      ? "ScienceDirect reported an open-access route."
      : options.institutionToken !== null
        ? "ScienceDirect matched this paper under a credentialed publisher route."
        : "ScienceDirect returned metadata, but full-text access still depends on entitlement."
    : openAccess
      ? "Scopus indicated the paper is open access."
      : abstract.length > 0
        ? "Scopus returned discovery metadata with abstract text."
        : "Scopus returned discovery metadata.";
  const access = route === "sciencedirect"
    ? openAccess
      ? accessRecord("elsevier", locator ?? abstractUrl, "fulltext_open", "html", note, {
        license: openLicense,
        tdmAllowed: true
      })
      : options.institutionToken !== null && locator !== null
        ? accessRecord("elsevier", locator, "fulltext_licensed", "html", note, {
          license: openLicense,
          tdmAllowed: null
        })
        : abstract.length > 0
          ? accessRecord("elsevier", abstractUrl ?? locator, "abstract_available", "html", note)
          : accessRecord("elsevier", locator, "metadata_only", "none", note)
    : openAccess && locator !== null
      ? accessRecord("elsevier", locator, "abstract_available", "html", note, {
        license: openLicense,
        tdmAllowed: null
      })
      : abstract.length > 0
        ? accessRecord("elsevier", abstractUrl ?? locator, "abstract_available", "html", note)
        : accessRecord("elsevier", locator, "metadata_only", "none", note);

  return [{
    providerId: "elsevier",
    title,
    locator,
    citation: authorsToCitation(authors, year, title, venue),
    excerpt: abstract,
    year,
    authors,
    venue,
    identifiers: {
      doi,
      pmid
    },
    access
  }];
}

async function queryScopus(
  query: string,
  apiKey: string,
  pageIndex: number,
  pageSize: number
): Promise<ProviderPageResult> {
  const url = new URL("/content/search/scopus", elsevierBaseUrl);
  url.searchParams.set("query", query);
  url.searchParams.set("count", String(Math.min(pageSize, 100)));
  url.searchParams.set("start", String(pageIndex * Math.min(pageSize, 100)));
  url.searchParams.set("view", "STANDARD");
  const payload = await fetchJson(url, {
    headers: elsevierHeaders(apiKey)
  }) as { "search-results"?: { entry?: Array<Record<string, unknown>> } };
  const entries = maybeArray(payload["search-results"]?.entry)
    .flatMap((entry) => typeof entry === "object" && entry !== null ? [entry as Record<string, unknown>] : []);

  const candidates = entries.flatMap((entry) => parseElsevierSearchEntry("scopus", entry));
  return {
    candidates,
    hasMore: candidates.length >= Math.min(pageSize, 100)
  };
}

async function queryScienceDirect(
  query: string,
  apiKey: string,
  institutionToken: string | null,
  pageIndex: number,
  pageSize: number
): Promise<ProviderPageResult> {
  const url = new URL("/content/search/sciencedirect", elsevierBaseUrl);
  url.searchParams.set("query", query);
  url.searchParams.set("count", String(Math.min(pageSize, 100)));
  url.searchParams.set("start", String(pageIndex * Math.min(pageSize, 100)));
  url.searchParams.set("field", "dc:title,dc:creator,prism:publicationName,prism:coverDate,dc:description,prism:doi,prism:url,openaccess,openaccessArticle,openaccessUserLicense,pubmed-id,authors,link");
  const payload = await fetchJson(url, {
    headers: elsevierHeaders(apiKey, institutionToken)
  }) as { "search-results"?: { entry?: Array<Record<string, unknown>> } };
  const entries = maybeArray(payload["search-results"]?.entry)
    .flatMap((entry) => typeof entry === "object" && entry !== null ? [entry as Record<string, unknown>] : []);

  const candidates = entries.flatMap((entry) => parseElsevierSearchEntry("sciencedirect", entry, {
    institutionToken
  }));
  return {
    candidates,
    hasMore: candidates.length >= Math.min(pageSize, 100)
  };
}

async function queryElsevier(
  query: string,
  apiKey: string,
  institutionToken: string | null,
  pageIndex: number,
  pageSize: number
): Promise<ProviderPageResult> {
  const scopus = await queryScopus(query, apiKey, pageIndex, pageSize);

  if (institutionToken === null) {
    return scopus;
  }

  let sciencedirect: ProviderPageResult;

  try {
    sciencedirect = await queryScienceDirect(query, apiKey, institutionToken, pageIndex, pageSize);
  } catch {
    return scopus;
  }

  return {
    candidates: [...scopus.candidates, ...sciencedirect.candidates],
    hasMore: scopus.hasMore || sciencedirect.hasMore
  };
}

function parseSpringerLinks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => typeof entry === "object" && entry !== null ? [entry as Record<string, unknown>] : []);
}

function springerLocatorFromRecord(record: Record<string, unknown>): {
  locator: string | null;
  pdfUrl: string | null;
} {
  const links = parseSpringerLinks(record.url);
  let locator: string | null = null;
  let pdfUrl: string | null = null;

  for (const link of links) {
    const href = safeString(link.value) ?? safeString(link.href) ?? safeString(link.url);
    const format = safeString(link.format)?.toLowerCase();

    if (href === null) {
      continue;
    }

    if (format === "pdf" || href.toLowerCase().endsWith(".pdf")) {
      pdfUrl = pdfUrl ?? href;
      continue;
    }

    locator = locator ?? href;
  }

  return {
    locator: locator ?? pdfUrl,
    pdfUrl
  };
}

function parseSpringerCreators(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const record = typeof entry === "object" && entry !== null
        ? entry as Record<string, unknown>
        : {};
      const name = safeString(record.creator) ?? safeString(record.name) ?? safeString(entry);
      return name === null ? [] : [name];
    });
  }

  const name = safeString(value);
  return name === null ? [] : [name];
}

function parseSpringerRecord(
  providerId: "springer_nature",
  record: Record<string, unknown>,
  accessPreference: "meta" | "openaccess"
): RawCandidate[] {
  const title = safeString(record.title);

  if (title === null) {
    return [];
  }

  const { locator, pdfUrl } = springerLocatorFromRecord(record);
  const openAccess = accessPreference === "openaccess"
    || safeBoolean(record.openaccess) === true
    || safeBoolean(record.openAccess) === true;
  const access = openAccess
    ? accessRecord("springer_nature", pdfUrl ?? locator, pdfUrl !== null ? "fulltext_open" : "abstract_available", pdfUrl !== null ? "pdf" : "html", "Springer Nature reported an open-access route.", {
      license: safeString(record.license),
      tdmAllowed: true
    })
    : safeString(record.abstract) !== null
      ? accessRecord("springer_nature", locator, "abstract_available", "html", "Springer Nature returned metadata with abstract text.")
      : accessRecord("springer_nature", locator, "metadata_only", "none", "Springer Nature returned metadata only.");

  return [{
    providerId,
    title,
    locator,
    citation: authorsToCitation(
      parseSpringerCreators(record.creators ?? record.authors),
      yearFromUnknown(record.publicationDate ?? record.publicationYear),
      title,
      safeString(record.publicationName) ?? safeString(record.publisher)
    ),
    excerpt: safeString(record.abstract) ?? "",
    year: yearFromUnknown(record.publicationDate ?? record.publicationYear),
    authors: parseSpringerCreators(record.creators ?? record.authors),
    venue: safeString(record.publicationName) ?? safeString(record.publisher),
    identifiers: {
      doi: normalizeDoi(safeString(record.doi)),
      pmcid: safeString(record.pmcid),
      pmid: safeString(record.pmid)
    },
    access
  }];
}

async function querySpringerNature(
  query: string,
  apiKey: string,
  pageIndex: number,
  pageSize: number
): Promise<ProviderPageResult> {
  const url = new URL("/meta/v2/json", springerNatureBaseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("p", String(Math.min(pageSize, 100)));
  url.searchParams.set("s", String(pageIndex * Math.min(pageSize, 100) + 1));
  url.searchParams.set("api_key", apiKey);
  const payload = await fetchJson(url) as { records?: Array<Record<string, unknown>> };
  const records = Array.isArray(payload.records) ? payload.records : [];
  const candidates = records.flatMap((record) => parseSpringerRecord("springer_nature", record, "meta"));

  return {
    candidates,
    hasMore: candidates.length >= Math.min(pageSize, 100)
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
  request: ResearchSourceGatherRequest,
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
      return queryPubmed(query, readCredentialValue(request, "pubmed", "api_key"), pageIndex, budget.pageSize);
    case "europe_pmc":
      return queryEuropePmc(query, pageIndex + 1, budget.pageSize);
    case "core":
      return queryCore(query, readCredentialValue(request, "core", "api_key"), pageIndex, budget.pageSize);
    case "ieee_xplore": {
      const apiKey = readCredentialValue(request, "ieee_xplore", "api_key");
      return apiKey === null
        ? { candidates: [], hasMore: false }
        : queryIeeeXplore(query, apiKey, pageIndex, budget.pageSize);
    }
    case "elsevier": {
      const apiKey = readElsevierApiKey(request);
      const institutionToken = readElsevierInstitutionToken(request);
      return apiKey === null
        ? { candidates: [], hasMore: false }
        : queryElsevier(query, apiKey, institutionToken, pageIndex, budget.pageSize);
    }
    case "springer_nature": {
      const apiKey = readCredentialValue(request, "springer_nature", "api_key");
      return apiKey === null
        ? { candidates: [], hasMore: false }
        : querySpringerNature(query, apiKey, pageIndex, budget.pageSize);
    }
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

function elsevierQueryForPaper(paper: CanonicalPaper): string {
  if (paper.identifiers.doi !== null) {
    return `DOI(${paper.identifiers.doi})`;
  }

  if (paper.identifiers.pmid !== null) {
    return `PMID(${paper.identifiers.pmid})`;
  }

  return `TITLE(${paper.title})`;
}

function springerQueryForPaper(paper: CanonicalPaper): string {
  if (paper.identifiers.doi !== null) {
    return `doi:${paper.identifiers.doi}`;
  }

  return `"${paper.title}"`;
}

async function resolveWithIeeeXplore(
  paper: CanonicalPaper,
  apiKey: string | null
): Promise<PaperAccessRecord[]> {
  if (apiKey === null) {
    return [];
  }

  const url = new URL("/api/v1/search/articles", ieeeXploreBaseUrl);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("start_record", "1");
  url.searchParams.set("max_records", "3");

  if (paper.identifiers.doi !== null) {
    url.searchParams.set("doi", paper.identifiers.doi);
  } else {
    url.searchParams.set("querytext", paper.title);
  }

  const payload = await fetchJson(url) as { articles?: unknown[] | { article?: unknown[] | unknown } };
  const articleValue = Array.isArray(payload.articles)
    ? payload.articles
    : payload.articles !== undefined
      ? maybeArray((payload.articles as { article?: unknown[] | unknown }).article)
      : [];

  return articleValue.flatMap((entry) => {
    const record = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    return parseIeeeArticleRecord(record);
  }).flatMap((candidate) => candidate.access === null ? [] : [candidate.access as PaperAccessRecord]);
}

async function resolveWithScopus(
  paper: CanonicalPaper,
  apiKey: string | null
): Promise<PaperAccessRecord[]> {
  if (apiKey === null) {
    return [];
  }

  const page = await queryScopus(elsevierQueryForPaper(paper), apiKey, 0, 3);
  return page.candidates
    .flatMap((candidate) => candidate.access === null ? [] : [candidate.access as PaperAccessRecord]);
}

async function resolveWithScienceDirect(
  paper: CanonicalPaper,
  apiKey: string | null,
  institutionToken: string | null
): Promise<PaperAccessRecord[]> {
  if (apiKey === null || institutionToken === null) {
    return [];
  }

  const page = await queryScienceDirect(elsevierQueryForPaper(paper), apiKey, institutionToken, 0, 3);
  return page.candidates
    .flatMap((candidate) => candidate.access === null ? [] : [candidate.access as PaperAccessRecord]);
}

async function resolveWithSpringerNature(
  paper: CanonicalPaper,
  apiKey: string | null
): Promise<PaperAccessRecord[]> {
  if (apiKey === null) {
    return [];
  }

  const query = springerQueryForPaper(paper);
  const openAccessUrl = new URL("/openaccess/json", springerNatureBaseUrl);
  openAccessUrl.searchParams.set("q", query);
  openAccessUrl.searchParams.set("p", "3");
  openAccessUrl.searchParams.set("api_key", apiKey);

  try {
    const payload = await fetchJson(openAccessUrl) as { records?: Array<Record<string, unknown>> };
    const records = Array.isArray(payload.records) ? payload.records : [];
    const candidates = records
      .flatMap((record) => parseSpringerRecord("springer_nature", record, "openaccess"))
      .flatMap((candidate) => candidate.access === null ? [] : [candidate.access as PaperAccessRecord]);

    if (candidates.length > 0) {
      return candidates;
    }
  } catch {
    // Fall back to metadata-only resolution below when OA lookup is unavailable.
  }

  const page = await querySpringerNature(query, apiKey, 0, 3);
  return page.candidates
    .flatMap((candidate) => candidate.access === null ? [] : [candidate.access as PaperAccessRecord]);
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

  const relaxedRetained = assessment?.rationale.includes("Retained because the combined topic, task, and focus evidence") ?? false;

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

    if (relaxedRetained) {
      return {
        decision: "uncertain",
        rationale: `${assessment?.rationale ?? "Directly readable at full text."} Retained as a cautious candidate because it did not satisfy the stricter domain-anchor gate.`
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

    if (relaxedRetained) {
      return {
        decision: "uncertain",
        rationale: `${assessment?.rationale ?? "The paper can be screened at the abstract level."} Retained as a cautious candidate because it did not satisfy the stricter domain-anchor gate.`
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

function screeningHistoryForPaper(
  stage: "title" | "abstract" | "fulltext",
  decision: "include" | "background" | "exclude" | "uncertain",
  rationale: string | null
): PaperScreeningStatus[] {
  const history: PaperScreeningStatus[] = [{
    stage: "title",
    decision: stage === "title" ? decision : "uncertain",
    rationale: stage === "title"
      ? rationale
      : "Retained after title screening for deeper review."
  }];

  if (stage === "abstract" || stage === "fulltext") {
    history.push({
      stage: "abstract",
      decision: stage === "abstract" ? decision : "include",
      rationale: stage === "abstract"
        ? rationale
        : "Abstract-level screening supported deeper full-text review."
    });
  }

  if (stage === "fulltext") {
    history.push({
      stage: "fulltext",
      decision,
      rationale
    });
  }

  return history;
}

function paperScreeningPriority(paper: CanonicalPaper, coverage: PaperFacetCoverage | null = null): number {
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
  switch (sourceRoleForPaper(paper, paper.screeningDecision === "exclude" ? "excluded" : "in_scope")) {
    case "primary_system":
      score += 24;
      break;
    case "benchmark":
      score += 8;
      break;
    case "method_component":
      score += 4;
      break;
    case "survey":
      score -= 18;
      break;
    case "background":
      score -= 8;
      break;
    case "off_topic":
      score -= 80;
      break;
  }
  score += topicAnchorTagCount * 8;
  score += focusTagCount * 10;
  score += taskTagCount * 4;
  score += (coverage?.coverageScore ?? 0) * 12;
  score -= (coverage?.missingRequiredFacetIds.length ?? 0) * 3;
  score += Math.min(5, paper.discoveredVia.length) * 3;
  score += Math.max(0, Math.min(10, (paper.year ?? 0) - 2015));
  return score;
}

function sortPapersForReview(
  papers: CanonicalPaper[],
  coverageByPaperId: Map<string, PaperFacetCoverage> = new Map()
): CanonicalPaper[] {
  return [...papers].sort((left, right) => {
    return paperScreeningPriority(right, coverageByPaperId.get(right.id) ?? null)
      - paperScreeningPriority(left, coverageByPaperId.get(left.id) ?? null)
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

function paperReviewText(paper: CanonicalPaper): string {
  return [
    paper.title,
    paper.abstract,
    paper.citation,
    paper.venue,
    ...paper.tags
  ].filter((value): value is string => typeof value === "string").join(" ");
}

function roleTextForPaper(paper: CanonicalPaper): string {
  return normalizeWhitespace([
    paper.title,
    paper.abstract,
    paper.citation,
    paper.venue
  ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase());
}

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function sourceRoleForPaper(paper: CanonicalPaper, status: LiteratureRelevanceStatus): LiteratureSourceRole {
  if (status === "excluded" || paper.screeningDecision === "exclude") {
    return "off_topic";
  }

  const text = roleTextForPaper(paper);
  const surveyLike = hasAnyPattern(text, [
    /\bsurvey\b/,
    /\bsystematic review\b/,
    /\bscoping review\b/,
    /\bmeta-analysis\b/,
    /\btaxonomy\b/,
    /\boverview\b/,
    /\bconceptualization\b/,
    /\bresearch agenda\b/
  ]);
  const benchmarkLike = hasAnyPattern(text, [
    /\bbenchmark\b/,
    /\bbenchmarking\b/,
    /\bleaderboard\b/,
    /\bevaluation suite\b/,
    /\bevaluation dataset\b/,
    /\barena\b/
  ]);
  const systemLike = hasAnyPattern(text, [
    /\bagent\b/,
    /\bagents\b/,
    /\bassistant\b/,
    /\bassistants\b/,
    /\bsystem\b/,
    /\bsystems\b/,
    /\bframework\b/,
    /\bplatform\b/,
    /\bharness\b/,
    /\blaboratory\b/,
    /\blab\b/,
    /\bsdk\b/,
    /\btool\b/,
    /\bworkflow\b/
  ]);
  const researchWorkflowLike = hasAnyPattern(text, [
    /\bresearch\b/,
    /\bscientific\b/,
    /\bscience\b/,
    /\bliterature\b/,
    /\bpaper\b/,
    /\bexperiment\b/,
    /\bexperimental\b/,
    /\bdiscovery\b/,
    /\bhypothesis\b/,
    /\blaboratory\b/,
    /\blab\b/
  ]);
  const componentLike = hasAnyPattern(text, [
    /\bmemory\b/,
    /\bretrieval\b/,
    /\bplanner\b/,
    /\bplanning\b/,
    /\borchestration\b/,
    /\bworkflow automation\b/,
    /\bcomponent\b/,
    /\bmodule\b/,
    /\bmodular\b/,
    /\bprocedural\b/,
    /\btool-use\b/,
    /\btool use\b/,
    /\breasoning\b/,
    /\bverification\b/,
    /\bcritique\b/,
    /\breflection\b/
  ]);
  const primaryWorkflowLike = hasAnyPattern(text, [
    /\bresearch assistant\b/,
    /\bresearch assistants\b/,
    /\bresearch workflow\b/,
    /\bresearch workflows\b/,
    /\bscientific workflow\b/,
    /\bscientific workflows\b/,
    /\bexperiment execution\b/,
    /\bliterature-aware\b/,
    /\bliterature review\b/,
    /\bpaper writing\b/
  ]);

  if (surveyLike) {
    return "survey";
  }

  if (benchmarkLike) {
    return "benchmark";
  }

  if (componentLike && !primaryWorkflowLike) {
    return "method_component";
  }

  if (systemLike && researchWorkflowLike) {
    return "primary_system";
  }

  if (systemLike) {
    return "method_component";
  }

  return status === "borderline" ? "background" : "primary_system";
}

function selectedDecisionForRole(
  role: LiteratureSourceRole,
  selected: boolean,
  status: LiteratureRelevanceStatus
): LiteratureSelectionDecision {
  if (status === "excluded" || role === "off_topic") {
    return "excluded";
  }

  if (!selected) {
    return "deferred";
  }

  return role === "primary_system"
    ? "selected_primary"
    : "selected_supporting";
}

function selectionReasonForAssessment(
  status: LiteratureRelevanceStatus,
  role: LiteratureSourceRole,
  decision: LiteratureSelectionDecision
): string {
  switch (decision) {
    case "selected_primary":
      return "Selected as a primary system/framework source for manuscript evidence.";
    case "selected_supporting":
      return `Selected as supporting ${role.replace(/_/g, " ")} evidence, not as a primary system comparison source.`;
    case "excluded":
      return status === "excluded"
        ? "Excluded because the protocol relevance gate marked it outside scope."
        : "Excluded because its source role is not suitable for the current synthesis.";
    case "deferred":
      return `Deferred from the current synthesis set after role-aware selection (${role.replace(/_/g, " ")}).`;
  }
}

function finalizeRelevanceAssessments(
  assessments: LiteratureRelevanceAssessment[],
  selectedPaperIds: Set<string>,
  criticExcludedPaperIds: Set<string>
): LiteratureRelevanceAssessment[] {
  return assessments.map((assessment) => {
    const selected = selectedPaperIds.has(assessment.paperId);
    const criticExcluded = criticExcludedPaperIds.has(assessment.paperId);
    const selectionDecision = criticExcluded
      ? "excluded"
      : selectedDecisionForRole(assessment.sourceRole, selected, assessment.status);

    return {
      ...assessment,
      selectionDecision,
      selectionReason: criticExcluded
        ? "Excluded from the revised synthesis set because the critic explicitly requested removal."
        : selectionReasonForAssessment(assessment.status, assessment.sourceRole, selectionDecision),
      criticConcerns: criticExcluded
        ? uniqueStrings([...assessment.criticConcerns, "Critic requested exclusion from the selected evidence set."])
        : assessment.criticConcerns,
      requiredForManuscript: selectionDecision === "selected_primary" || selectionDecision === "selected_supporting"
    };
  });
}

function roleAwareSelectionQuality(
  selectionQuality: ReviewSelectionQuality,
  assessments: LiteratureRelevanceAssessment[],
  requiredPrimarySystemCount: number
): ReviewSelectionQuality {
  if (requiredPrimarySystemCount <= 0) {
    return selectionQuality;
  }

  const selectedPrimaryCount = assessments.filter((assessment) => assessment.selectionDecision === "selected_primary").length;
  const availablePrimaryCount = assessments.filter((assessment) => (
    assessment.status === "in_scope" && assessment.sourceRole === "primary_system"
  )).length;

  if (selectedPrimaryCount >= requiredPrimarySystemCount) {
    return {
      ...selectionQuality,
      selectionRationale: [
        ...selectionQuality.selectionRationale,
        `Role-aware source gate passed with ${selectedPrimaryCount} selected primary system/framework sources.`
      ]
    };
  }

  const adequacy: ReviewSelectionQuality["adequacy"] = selectedPrimaryCount === 0 ? "thin" : "partial";

  return {
    ...selectionQuality,
    adequacy,
    selectionRationale: [
      ...selectionQuality.selectionRationale,
      `Role-aware source gate requires ${requiredPrimarySystemCount} primary system/framework sources but found only ${selectedPrimaryCount} selected; ${availablePrimaryCount} primary candidates were available in the current source pool. Supporting benchmarks, surveys, and component papers do not satisfy primary system-comparison slots.`
    ]
  };
}

function wordNumber(value: string): number | null {
  const normalized = value.toLowerCase();
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  };

  return /^\d+$/.test(normalized)
    ? Number(normalized)
    : words[normalized] ?? null;
}

function requiredPrimarySystemCount(request: ResearchSourceGatherRequest): number {
  const text = normalizeWhitespace([
    request.brief.successCriterion,
    request.brief.researchDirection,
    request.brief.researchQuestion,
    request.plan.objective,
    request.plan.rationale
  ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase());
  const match = text.match(/\b(?:at least|minimum of|compare)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b.{0,80}\b(?:systems?|frameworks?|agents?|architectures?|harnesses?)\b/);

  if (match === null) {
    return 0;
  }

  return Math.max(0, wordNumber(match[1]!) ?? 0);
}

function tokenSetForPaper(paper: CanonicalPaper): Set<string> {
  return new Set(matchTokens(paperReviewText(paper)));
}

function termMatchesPaper(term: string, normalizedText: string, tokens: Set<string>): boolean {
  const normalizedTerm = normalizeWhitespace(term.toLowerCase());
  const termTokens = matchTokens(normalizedTerm);

  if (termTokens.length === 0) {
    return false;
  }

  return normalizedText.includes(normalizedTerm)
    || termTokens.every((token) => tokens.has(token));
}

function matchedFacetLabels(
  paper: CanonicalPaper,
  facets: ReviewFacet[],
  predicate: (facet: ReviewFacet) => boolean
): string[] {
  const normalizedText = normalizeWhitespace(paperReviewText(paper).toLowerCase());
  const tokens = tokenSetForPaper(paper);

  return facets
    .filter(predicate)
    .filter((facet) => facet.terms.some((term) => termMatchesPaper(term, normalizedText, tokens)))
    .map((facet) => facet.label);
}

function reviewRelevanceAssessmentForPaper(
  paper: CanonicalPaper,
  facets: ReviewFacet[],
  coverage: PaperFacetCoverage | null = null
): LiteratureRelevanceAssessment {
  if (facets.length === 0) {
    const status: LiteratureRelevanceStatus = "in_scope";
    const sourceRole = sourceRoleForPaper(paper, status);
    const selectionDecision = selectedDecisionForRole(sourceRole, false, status);

    return {
      paperId: paper.id,
      title: paper.title,
      status,
      sourceRole,
      selectionDecision,
      selectionReason: selectionReasonForAssessment(status, sourceRole, selectionDecision),
      criticConcerns: [],
      requiredForManuscript: false,
      reviewer: "hybrid_protocol_gate",
      matchedCriteria: ["No protocol criteria were available; source was retained by the ordinary screening workflow."],
      missingCriteria: [],
      reason: "No protocol criteria were available, so the relevance gate deferred to screening state."
    };
  }

  const requiredCoreFacets = facets.filter((facet) => facet.required && isCoreTopicReviewFacet(facet));
  const requiredSubstantiveFacets = facets.filter((facet) => facet.required && isSubstantiveReviewFacet(facet));
  const coreMatched = matchedFacetLabels(paper, requiredCoreFacets, () => true);
  const substantiveMatched = matchedFacetLabels(paper, requiredSubstantiveFacets, () => true);
  const coveredFacetIds = new Set(coverage?.coveredFacetIds ?? []);
  const optionalMatched = facets
    .filter((facet) => !facet.required && coveredFacetIds.has(facet.id))
    .map((facet) => facet.label);
  const coreSatisfied = requiredCoreFacets.length === 0 || coreMatched.length > 0;
  const substantiveSatisfied = requiredSubstantiveFacets.length === 0 || substantiveMatched.length > 0;
  const matchedCriteria = uniqueStrings([
    ...coreMatched.map((label) => `core:${label}`),
    ...substantiveMatched.map((label) => `evidence:${label}`),
    ...optionalMatched.map((label) => `hint:${label}`)
  ]);
  const missingCriteria = uniqueStrings([
    ...(coreSatisfied ? [] : requiredCoreFacets.map((facet) => `core:${facet.label}`)),
    ...(substantiveSatisfied ? [] : requiredSubstantiveFacets.map((facet) => `evidence:${facet.label}`))
  ]);
  const status: LiteratureRelevanceStatus = coreSatisfied && substantiveSatisfied
    ? "in_scope"
    : coreSatisfied || substantiveSatisfied
      ? "borderline"
      : "excluded";
  const sourceRole = sourceRoleForPaper(paper, status);
  const selectionDecision = selectedDecisionForRole(sourceRole, false, status);

  return {
    paperId: paper.id,
    title: paper.title,
    status,
    sourceRole,
    selectionDecision,
    selectionReason: selectionReasonForAssessment(status, sourceRole, selectionDecision),
    criticConcerns: [],
    requiredForManuscript: false,
    reviewer: "hybrid_protocol_gate",
    matchedCriteria,
    missingCriteria,
    reason: status === "in_scope"
      ? "The paper matched the protocol core scope and at least one required evidence target."
      : status === "borderline"
        ? "The paper matched only part of the protocol scope/evidence gate and was kept out of final synthesis."
        : "The paper did not match the protocol core scope or required evidence targets closely enough for synthesis."
  };
}

function buildLiteratureRelevanceAssessments(
  papers: CanonicalPaper[],
  facets: ReviewFacet[],
  coverageByPaperId: Map<string, PaperFacetCoverage>
): LiteratureRelevanceAssessment[] {
  return papers.map((paper) => reviewRelevanceAssessmentForPaper(paper, facets, coverageByPaperId.get(paper.id) ?? null));
}

function paperPassesSynthesisRelevanceGate(
  paper: CanonicalPaper,
  facets: ReviewFacet[],
  coverage: PaperFacetCoverage | null = null,
  relevanceAssessment: LiteratureRelevanceAssessment | null = null
): boolean {
  if (relevanceAssessment !== null) {
    return relevanceAssessment.status === "in_scope";
  }

  if (facets.length === 0) {
    return true;
  }

  const coveredFacetIds = new Set(coverage?.coveredFacetIds ?? []);
  const coreFacetIds = new Set(facets.filter(isCoreTopicReviewFacet).map((facet) => facet.id));
  const substantiveFacetIds = new Set(facets.filter(isSubstantiveReviewFacet).map((facet) => facet.id));
  const topicAnchorTagCount = paper.tags.filter((tag) => tag.startsWith("topic-anchor:")).length;
  const focusTagCount = paper.tags.filter((tag) => tag.startsWith("focus:")).length;
  const taskTagCount = paper.tags.filter((tag) => tag.startsWith("task:")).length;
  const coreMatched = coreFacetIds.size === 0
    || topicAnchorTagCount > 0
    || [...coreFacetIds].some((facetId) => coveredFacetIds.has(facetId));
  const substantiveMatched = substantiveFacetIds.size === 0
    || focusTagCount > 0
    || taskTagCount > 0
    || [...substantiveFacetIds].some((facetId) => coveredFacetIds.has(facetId));

  return coreMatched && substantiveMatched;
}

function selectPapersForFacetCoverage(input: {
  orderedCandidates: CanonicalPaper[];
  facets: ReviewFacet[];
  coverageByPaperId: Map<string, PaperFacetCoverage>;
  limit: number;
}): CanonicalPaper[] {
  const selected: CanonicalPaper[] = [];
  const selectedIds = new Set<string>();
  const requiredFacets = input.facets.filter((facet) => facet.required);

  for (const facet of requiredFacets) {
    const best = input.orderedCandidates
      .filter((paper) => !selectedIds.has(paper.id))
      .filter((paper) => input.coverageByPaperId.get(paper.id)?.coveredFacetIds.includes(facet.id) ?? false)
      .sort((left, right) => {
        return paperScreeningPriority(right, input.coverageByPaperId.get(right.id) ?? null)
          - paperScreeningPriority(left, input.coverageByPaperId.get(left.id) ?? null);
      })[0];

    if (best === undefined) {
      continue;
    }

    selected.push(best);
    selectedIds.add(best.id);

    if (selected.length >= input.limit) {
      return selected;
    }
  }

  for (const paper of input.orderedCandidates) {
    if (selectedIds.has(paper.id)) {
      continue;
    }

    selected.push(paper);
    selectedIds.add(paper.id);

    if (selected.length >= input.limit) {
      break;
    }
  }

  return selected;
}

function buildReviewWorkflow(
  canonicalPapers: CanonicalPaper[],
  facets: ReviewFacet[],
  requiredPrimarySources = 0,
  criticExcludedPaperIds: string[] = [],
  criticPromotedPaperIds: string[] = []
): {
  reviewedPapers: CanonicalPaper[];
  reviewWorkflow: ReviewWorkflowSummary;
  selectionQuality: ReviewSelectionQuality | null;
  relevanceAssessments: LiteratureRelevanceAssessment[];
} {
  const coverageByPaperId = new Map(
    canonicalPapers.map((paper) => [paper.id, assessPaperFacetCoverage(facets, paper)])
  );
  const relevanceAssessments = buildLiteratureRelevanceAssessments(canonicalPapers, facets, coverageByPaperId);
  const relevanceByPaperId = new Map(relevanceAssessments.map((assessment) => [assessment.paperId, assessment]));
  const criticExcludedIds = new Set(criticExcludedPaperIds);
  const criticPromotedIds = new Set(criticPromotedPaperIds.filter((paperId) => !criticExcludedIds.has(paperId)));
  const ordered = sortPapersForReview(canonicalPapers, coverageByPaperId);
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
  const screeningExcludedPaperIds = ordered
    .filter((paper) => paper.screeningDecision === "exclude" || paper.screeningDecision === "background")
    .map((paper) => paper.id);
  const excludedPaperIds = uniqueStrings([
    ...screeningExcludedPaperIds,
    ...ordered.filter((paper) => criticExcludedIds.has(paper.id)).map((paper) => paper.id)
  ]);
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
  const synthesisEligiblePapers = ordered.filter((paper) => (
    paper.screeningDecision !== "exclude"
    && paper.screeningDecision !== "background"
    && !criticExcludedIds.has(paper.id)
    && paperPassesSynthesisRelevanceGate(
      paper,
      facets,
      coverageByPaperId.get(paper.id) ?? null,
      relevanceByPaperId.get(paper.id) ?? null
    )
  ));
  const synthesisEligiblePaperIds = new Set(synthesisEligiblePapers.map((paper) => paper.id));
  const heldBackForRelevancePapers = ordered.filter((paper) => (
    paper.screeningDecision !== "exclude"
    && paper.screeningDecision !== "background"
    && !criticExcludedIds.has(paper.id)
    && !synthesisEligiblePaperIds.has(paper.id)
  ));
  const qualityEligibleIncludedPapers = includedPapers.filter((paper) => (
    sourceQualityAssessmentForPaper(paper).tier !== "low"
    && synthesisEligiblePaperIds.has(paper.id)
  ));
  const eligibleUncertainPapers = ordered.filter((paper) => {
    const quality = sourceQualityAssessmentForPaper(paper);
    return paper.screeningDecision === "uncertain"
    && (paper.screeningStage === "abstract" || paper.screeningStage === "fulltext")
    && quality.tier !== "low"
    && !quality.severeConcern
    && paper.accessMode !== "needs_credentials"
    && paper.accessMode !== "fulltext_blocked"
    && !criticExcludedIds.has(paper.id)
    && synthesisEligiblePaperIds.has(paper.id);
  });
  const promotedUncertainPapers = qualityEligibleIncludedPapers.length >= 3
    ? []
    : eligibleUncertainPapers.slice(0, Math.max(0, 3 - qualityEligibleIncludedPapers.length));
  const selectedCandidateIds = new Set([
    ...qualityEligibleIncludedPapers.map((paper) => paper.id),
    ...promotedUncertainPapers.map((paper) => paper.id),
    ...ordered
      .filter((paper) => criticPromotedIds.has(paper.id))
      .filter((paper) => synthesisEligiblePaperIds.has(paper.id))
      .map((paper) => paper.id)
  ]);
  const uncoveredRequiredFacetIds = facets
    .filter((facet) => facet.required)
    .filter((facet) => ![...selectedCandidateIds].some((paperId) => (
      coverageByPaperId.get(paperId)?.coveredFacetIds.includes(facet.id) ?? false
    )))
    .map((facet) => facet.id);
  const facetRescuePapers = eligibleUncertainPapers.filter((paper) => {
    if (selectedCandidateIds.has(paper.id)) {
      return false;
    }

    const coverage = coverageByPaperId.get(paper.id);
    return coverage !== undefined && uncoveredRequiredFacetIds.some((facetId) => coverage.coveredFacetIds.includes(facetId));
  }).slice(0, Math.max(0, 24 - selectedCandidateIds.size));
  const collapsed = collapseReviewSeries([
    ...qualityEligibleIncludedPapers,
    ...promotedUncertainPapers,
    ...facetRescuePapers,
    ...ordered
      .filter((paper) => criticPromotedIds.has(paper.id))
      .filter((paper) => synthesisEligiblePaperIds.has(paper.id))
  ]);
  const selectedForSynthesis = facets.length === 0
    ? collapsed.selected.slice(0, 24)
    : selectPapersForFacetCoverage({
      orderedCandidates: sortPapersForReview(collapsed.selected, coverageByPaperId),
      facets,
      coverageByPaperId,
      limit: 24
    });
  const synthesisPaperIds = selectedForSynthesis.map((paper) => paper.id);
  const selectedPaperIds = new Set(synthesisPaperIds);
  const finalizedRelevanceAssessments = finalizeRelevanceAssessments(relevanceAssessments, selectedPaperIds, criticExcludedIds);
  const deferredPaperIds = includedPaperIds.filter((paperId) => !synthesisPaperIds.includes(paperId));
  const reviewedPapers = ordered.filter((paper) => synthesisPaperIds.includes(paper.id));
  const selectedPrimaryCount = finalizedRelevanceAssessments.filter((assessment) => assessment.selectionDecision === "selected_primary").length;
  const selectedSupportingCount = finalizedRelevanceAssessments.filter((assessment) => assessment.selectionDecision === "selected_supporting").length;
  const sourceRoleSummary = [
    "primary_system",
    "benchmark",
    "survey",
    "method_component",
    "background",
    "off_topic"
  ].map((role) => {
    const count = finalizedRelevanceAssessments.filter((assessment) => assessment.sourceRole === role).length;
    return `${role.replace(/_/g, " ")}: ${count}`;
  }).join(", ");
  let selectionQuality = facets.length === 0
    ? null
    : buildReviewSelectionQuality({
      facets,
      papers: canonicalPapers,
      selectedPaperIds: synthesisPaperIds
    });
  selectionQuality = selectionQuality === null
    ? null
    : roleAwareSelectionQuality(selectionQuality, finalizedRelevanceAssessments, requiredPrimarySources);
  const notes = [
    `Title screened ${titleScreenedPaperIds.length} canonical papers.`,
    `Abstract screened ${abstractScreenedPaperIds.length} papers and full-text screened ${fulltextScreenedPaperIds.length}.`,
    `Included ${includedPaperIds.length} papers after screening, with ${blockedPaperIds.length} still blocked or credential-limited.`,
    `Source-quality tiers: ${qualityCounts.high} high, ${qualityCounts.medium} medium, ${qualityCounts.low} low.`,
    heldBackForRelevancePapers.length > 0
      ? `Held back ${heldBackForRelevancePapers.length} otherwise retained papers because the hybrid protocol relevance gate did not mark them in scope.`
      : null,
    relevanceAssessments.some((assessment) => assessment.status !== "in_scope")
      ? `Hybrid relevance gate: ${relevanceAssessments.filter((assessment) => assessment.status === "in_scope").length} in scope, ${relevanceAssessments.filter((assessment) => assessment.status === "borderline").length} borderline, ${relevanceAssessments.filter((assessment) => assessment.status === "excluded").length} excluded.`
      : null,
    `Source-role gate: ${sourceRoleSummary}. Selected ${selectedPrimaryCount} primary system sources and ${selectedSupportingCount} supporting sources.`,
    criticPromotedIds.size > 0
      ? `Critic promotion applied to ${criticPromotedIds.size} candidate paper(s) already present in the source pool before searching for more.`
      : "",
    promotedUncertainPapers.length > 0
      ? `Promoted ${promotedUncertainPapers.length} high/medium-quality uncertain papers into the reviewed set because fewer than 3 included papers were available.`
      : null,
    facetRescuePapers.length > 0
      ? `Added ${facetRescuePapers.length} high/medium-quality uncertain papers because they covered required review facets missing from the included set.`
      : null,
    selectionQuality !== null
      ? `Review facet adequacy is ${selectionQuality.adequacy}; missing required facets: ${selectionQuality.missingRequiredFacets.map((facet) => facet.label).join(", ") || "<none>"}.`
      : null,
    ...collapsed.notes,
    promotedUncertainPapers.length === 0 && synthesisPaperIds.length === includedPaperIds.length
      ? `Selected all ${synthesisPaperIds.length} included papers for synthesis.`
      : `Selected ${synthesisPaperIds.length} papers for synthesis and deferred ${deferredPaperIds.length} additional included papers for later passes.`
  ].filter((note): note is string => note !== null);

  return {
    reviewedPapers,
    selectionQuality,
    relevanceAssessments: finalizedRelevanceAssessments,
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
    screeningHistory: [],
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
    screeningHistory: [],
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
    screeningHistory: screeningHistoryForPaper(stage, screening.decision, screening.rationale),
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
): FilterCandidatesResult {
  const notes: string[] = [];
  const assessments: Array<{ sourceId: string; title: string; assessment: LiteratureSourceAssessment }> = [];
  const rejectedSamples: Array<{ title: string; excerpt: string; rationale: string }> = [];
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
    const assessment = screening.assessment;
    const strongTopicAccepted = topicTokens.size === 0
      || strongTopicScore >= minimumTopicMatches
      || topicPhraseMatch
      || (assessment !== undefined && assessment.focusScore >= 4 && assessment.taskAttributeScore >= 4)
      || (assessment !== undefined && assessment.totalScore >= 10);
    const profileAccepted = profile === null
      ? screening.accepted || heuristicScore >= 3
      : (
        screening.accepted
        || (assessment !== undefined && assessment.focusScore >= 4 && assessment.taskAttributeScore >= 4)
        || (assessment !== undefined && assessment.totalScore >= 10)
        || (
          assessment !== undefined
          && assessment.topicScore >= 6
          && (assessment.focusScore >= 2 || assessment.taskAttributeScore >= 4)
        )
        || (topicPhraseMatch && heuristicScore >= 3)
      );
    const accepted = strongTopicAccepted && profileAccepted;

    if (!accepted) {
      filtered += 1;
      if (rejectedSamples.length < 12) {
        rejectedSamples.push({
          title: source.title,
          excerpt: source.excerpt,
          rationale: assessment?.rationale
            ?? `Weak overlap with the scoped brief (anchor score ${anchorScore}, heuristic score ${heuristicScore}).`
        });
      }
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
    assessments,
    rejectedSamples,
    acceptedCount: acceptedSources.length,
    rejectedCount: filtered
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

function sourceQueryKey(queries: string[]): string {
  return uniqueStrings(queries
    .map((query) => normalizeWhitespace(query).toLowerCase())
    .filter((query) => query.length > 0))
    .sort()
    .join(" | ");
}

function providerQueryKey(providerId: SourceProviderId, queries: string[]): string {
  return `${providerId}:${sourceQueryKey(queries)}`;
}

async function queryProvider(
  providerId: SourceProviderId,
  queries: string[],
  request: ResearchSourceGatherRequest,
  budget: RetrievalBudget
): Promise<ProviderQueryResult> {
  const definition = getSourceProviderDefinition(providerId);
  const credentialFields = providerCredentialFields(providerId);
  const authValue = credentialFields.find((field) => field.required)?.id === undefined
    ? null
    : readCredentialValue(request, providerId, credentialFields.find((field) => field.required)!.id);

  if (
    credentialFields.some((field) => field.required)
    && (authValue === null || authValue.trim().length === 0)
  ) {
    return {
      candidates: [],
      providerCalls: 0
    };
  }

  const results: RawCandidate[] = [];
  const seen = new Set<string>();
  let providerCalls = 0;

  const selectedQueries = queries.slice(0, budget.maxQueriesPerProvider);
  for (const [queryIndex, query] of selectedQueries.entries()) {
    for (let pageIndex = 0; pageIndex < budget.maxPagesPerQuery; pageIndex += 1) {
      if (providerCalls >= budget.maxProviderCallsPerProvider) {
        await emitSourceProgress(request.progress, {
          phase: "provider_query",
          status: "skipped",
          providerId,
          query,
          queryIndex: queryIndex + 1,
          queryCount: selectedQueries.length,
          pageIndex: pageIndex + 1,
          message: `${definition.label} reached its per-pass provider-call budget.`,
          counts: {
            providerCalls,
            rawCandidates: results.length
          }
        });
        return {
          candidates: results,
          providerCalls
        };
      }

      await emitSourceProgress(request.progress, {
        phase: "provider_query",
        status: "progress",
        providerId,
        query,
        queryIndex: queryIndex + 1,
        queryCount: selectedQueries.length,
        pageIndex: pageIndex + 1,
        message: `Querying ${definition.label} (${queryIndex + 1}/${selectedQueries.length}, page ${pageIndex + 1}).`,
        counts: {
          providerCalls,
          rawCandidates: results.length
        }
      });

      providerCalls += 1;
      const page = await queryProviderPage(providerId, query, pageIndex, request, budget);

      for (const candidate of page.candidates) {
        const key = `${candidate.providerId}:${candidate.locator ?? candidate.title}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        results.push(candidate);

        if (results.length >= budget.maxCandidatesPerProvider) {
          return {
            candidates: results,
            providerCalls
          };
        }
      }

      if (!page.hasMore || page.candidates.length === 0) {
        break;
      }
    }
  }

  return {
    candidates: results,
    providerCalls
  };
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
      switch (providerId) {
        case "unpaywall": {
          const emailValue = readCredentialValue(request, "unpaywall", "email");

          if (emailValue === null || emailValue.trim().length === 0) {
            missingCredentials = true;
          }

          extraCandidates.push(...await resolveWithUnpaywall(paper, emailValue));
          break;
        }
        case "elsevier": {
          const apiKey = readElsevierApiKey(request);
          if (apiKey === null) {
            missingCredentials = true;
            break;
          }

          extraCandidates.push(...await resolveWithScopus(paper, apiKey));
          break;
        }
        case "springer_nature": {
          const apiKey = readCredentialValue(request, "springer_nature", "api_key");
          if (apiKey === null) {
            missingCredentials = true;
            break;
          }

          extraCandidates.push(...await resolveWithSpringerNature(paper, apiKey));
          break;
        }
      }
    } catch (error) {
      errors.push(`${providerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const providerId of routing.acquisitionProviderIds) {
    try {
      switch (providerId) {
        case "ieee_xplore": {
          const apiKey = readCredentialValue(request, "ieee_xplore", "api_key");
          if (apiKey === null) {
            missingCredentials = true;
            break;
          }

          extraCandidates.push(...await resolveWithIeeeXplore(paper, apiKey));
          break;
        }
        case "elsevier": {
          const apiKey = readElsevierApiKey(request);
          const institutionToken = readElsevierInstitutionToken(request);
          if (apiKey === null || institutionToken === null) {
            missingCredentials = true;
            break;
          }

          extraCandidates.push(...await resolveWithScienceDirect(paper, apiKey, institutionToken));
          break;
        }
        case "springer_nature": {
          const apiKey = readCredentialValue(request, "springer_nature", "api_key");
          if (apiKey === null) {
            missingCredentials = true;
            break;
          }

          extraCandidates.push(...await resolveWithSpringerNature(paper, apiKey));
          break;
        }
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

function groupedScholarlySources(
  scholarlySources: ResearchSource[]
): {
  groupedSources: Map<string, ResearchSource[]>;
  mergeDiagnostics: string[];
} {
  const groupedSources = new Map<string, ResearchSource[]>();
  const heuristicIndex = new Map<string, string>();
  const mergeDiagnostics: string[] = [];

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

  for (const [key, group] of groupedSources.entries()) {
    if (group.length > 1) {
      mergeDiagnostics.push(`Merged ${group.length} provider hits into canonical paper ${createLiteratureEntityId("paper", key)}.`);
    }
  }

  return {
    groupedSources,
    mergeDiagnostics
  };
}

function buildReviewStateFromPapers(
  canonicalPapers: CanonicalPaper[],
  reviewFacets: ReviewFacet[],
  mergeDiagnostics: string[],
  requiredPrimarySources: number,
  criticExcludedPaperIds: string[],
  criticPromotedPaperIds: string[]
): CanonicalReviewState {
  const { reviewedPapers, reviewWorkflow, selectionQuality, relevanceAssessments } = buildReviewWorkflow(
    canonicalPapers,
    reviewFacets,
    requiredPrimarySources,
    criticExcludedPaperIds,
    criticPromotedPaperIds
  );

  return {
    canonicalPapers,
    reviewedPapers,
    reviewWorkflow,
    selectionQuality,
    mergeDiagnostics,
    relevanceAssessments
  };
}

function accessResolutionTargets(
  state: CanonicalReviewState,
  maxAccessResolutions: number,
  targetPaperIds: string[] = []
): CanonicalPaper[] {
  if (maxAccessResolutions <= 0) {
    return [];
  }

  const coverageByPaperId = new Map((state.selectionQuality?.paperFacetCoverage ?? [])
    .map((coverage) => [coverage.paperId, coverage]));
  const explicitTargetIds = new Set(targetPaperIds);

  if (explicitTargetIds.size > 0) {
    return sortPapersForReview(state.canonicalPapers, coverageByPaperId)
      .filter((paper) => explicitTargetIds.has(paper.id))
      .filter((paper) => paper.identifiers.doi !== null || paper.identifiers.arxivId !== null || paper.bestAccessUrl !== null)
      .slice(0, maxAccessResolutions);
  }

  const selectedIds = new Set([
    ...state.reviewWorkflow.synthesisPaperIds,
    ...state.reviewWorkflow.includedPaperIds,
    ...state.relevanceAssessments
      .filter((assessment) => assessment.status === "in_scope")
      .map((assessment) => assessment.paperId),
    ...state.reviewWorkflow.uncertainPaperIds.slice(0, 8)
  ]);
  const candidates = sortPapersForReview(state.canonicalPapers, coverageByPaperId)
    .filter((paper) => selectedIds.has(paper.id))
    .filter((paper) => paper.identifiers.doi !== null || paper.identifiers.arxivId !== null || paper.bestAccessUrl !== null);

  return candidates.slice(0, maxAccessResolutions);
}

async function buildCanonicalReviewState(
  scholarlySources: ResearchSource[],
  routing: RoutingPlan,
  request: ResearchSourceGatherRequest,
  reviewFacets: ReviewFacet[],
  options: CanonicalReviewBuildOptions
): Promise<CanonicalReviewState> {
  const { groupedSources, mergeDiagnostics } = groupedScholarlySources(scholarlySources);
  const requiredPrimarySources = requiredPrimarySystemCount(request);
  const criticExcludedPaperIds = request.criticExcludedPaperIds ?? [];
  const criticPromotedPaperIds = request.criticPromotedPaperIds ?? [];
  const provisionalPapers = [...groupedSources.entries()]
    .map(([key, group]) => canonicalPaperFromSources(key, group, []));
  const initialState = buildReviewStateFromPapers(provisionalPapers, reviewFacets, mergeDiagnostics, requiredPrimarySources, criticExcludedPaperIds, criticPromotedPaperIds);
  const targets = accessResolutionTargets(initialState, options.maxAccessResolutions, uniqueStrings([
    ...(options.targetPaperIds ?? []),
    ...criticPromotedPaperIds
  ]));

  if (targets.length === 0) {
    await emitSourceProgress(options.progress, {
      phase: "access_resolution",
      status: "skipped",
      message: options.maxAccessResolutions <= 0
        ? "Access resolution was not requested for this source-tool step."
        : "No promising papers required publisher/OA access resolution before source selection.",
      counts: {
        canonicalPapers: provisionalPapers.length
      }
    });
    return initialState;
  }

  await emitSourceProgress(options.progress, {
    phase: "access_resolution",
    status: "started",
    message: `Resolving access for ${targets.length} promising papers before final source selection.`,
    counts: {
      canonicalPapers: provisionalPapers.length,
      accessResolutionTargets: targets.length
    }
  });

  const targetIds = new Set(targets.map((paper) => paper.id));
  const resolvedByKey = new Map<string, AccessResolution>();
  let resolvedCount = 0;

  for (const [key, group] of groupedSources.entries()) {
    const provisional = canonicalPaperFromSources(key, group, []);

    if (!targetIds.has(provisional.id)) {
      continue;
    }

    await emitSourceProgress(options.progress, {
      phase: "access_resolution",
      status: "progress",
      paperId: provisional.id,
      paperIndex: resolvedCount + 1,
      paperCount: targets.length,
      message: `Resolving access for promising paper ${resolvedCount + 1}/${targets.length}: ${provisional.title}`,
      counts: {
        resolvedPapers: resolvedCount,
        accessResolutionTargets: targets.length
      }
    });

    resolvedByKey.set(key, await resolveCanonicalAccess(provisional, routing, request));
    resolvedCount += 1;

    if (resolvedCount % options.accessResolutionCheckpointSize === 0 || resolvedCount === targets.length) {
      await emitSourceProgress(options.progress, {
        phase: "access_resolution",
        status: "progress",
        message: `Resolved access for ${resolvedCount}/${targets.length} promising papers.`,
        counts: {
          resolvedPapers: resolvedCount,
          accessResolutionTargets: targets.length
        }
      });
    }
  }

  const canonicalPapers = [...groupedSources.entries()].map(([key, group]) => {
    const provisional = canonicalPaperFromSources(key, group, []);
    const resolved = resolvedByKey.get(key);

    if (resolved === undefined) {
      return provisional;
    }

    const resolvedPaper = canonicalPaperFromSources(key, group, resolved.candidates);

    return resolvedPaper.id === provisional.id
      ? {
        ...resolvedPaper,
        bestAccessUrl: resolved.best.url,
        bestAccessProvider: resolved.best.providerId,
        accessMode: resolved.best.accessMode,
        fulltextFormat: resolved.best.fulltextFormat,
        license: resolved.best.license,
        tdmAllowed: resolved.best.tdmAllowed,
        accessErrors: resolved.accessErrors
      }
      : provisional;
  });

  await emitSourceProgress(options.progress, {
    phase: "access_resolution",
    status: "completed",
    message: `Finished targeted access resolution for ${resolvedCount} papers.`,
    counts: {
      resolvedPapers: resolvedCount,
      canonicalPapers: canonicalPapers.length
    }
  });

  return buildReviewStateFromPapers(canonicalPapers, reviewFacets, mergeDiagnostics, requiredPrimarySources, criticExcludedPaperIds, criticPromotedPaperIds);
}

function accessLimitationsFromAuth(authStatus: ProviderAuthSnapshot[]): string[] {
  return authStatus.flatMap((state) => {
    if (state.providerId === "unpaywall" && state.missingRequiredFieldIds.includes("email")) {
      return ["Unpaywall resolver unavailable until an email is configured."];
    }

    if (state.missingRequiredFieldIds.length > 0) {
      return [`${getSourceProviderDefinition(state.providerId).label} missing required credentials: ${state.missingRequiredFieldIds.join(", ")}.`];
    }

    if (state.missingOptionalFieldIds.length > 0 && state.status === "missing_optional") {
      return [`${getSourceProviderDefinition(state.providerId).label} optional credentials unset: ${state.missingOptionalFieldIds.join(", ")}.`];
    }

    return [];
  });
}

function selectionQualityNeedsRecovery(selectionQuality: ReviewSelectionQuality | null): boolean {
  if (selectionQuality === null || selectionQuality.adequacy === "strong") {
    return false;
  }

  return true;
}

function canonicalReviewQualityScore(state: CanonicalReviewState): number {
  const inScope = state.relevanceAssessments.filter((assessment) => assessment.status === "in_scope").length;
  const borderline = state.relevanceAssessments.filter((assessment) => assessment.status === "borderline").length;
  const excluded = state.relevanceAssessments.filter((assessment) => assessment.status === "excluded").length;
  const missing = state.selectionQuality?.missingRequiredFacets.length ?? 0;

  return inScope * 20
    + state.reviewedPapers.length * 5
    + state.reviewWorkflow.counts.included
    - missing * 12
    - borderline * 3
    - excluded;
}

function canonicalReviewImproved(previous: CanonicalReviewState, next: CanonicalReviewState): boolean {
  const previousInScopeIds = new Set(previous.relevanceAssessments
    .filter((assessment) => assessment.status === "in_scope")
    .map((assessment) => assessment.paperId));
  const nextInScopeIds = next.relevanceAssessments
    .filter((assessment) => assessment.status === "in_scope")
    .map((assessment) => assessment.paperId);
  const gainedInScopePaper = nextInScopeIds.some((paperId) => !previousInScopeIds.has(paperId));
  const previousMissing = previous.selectionQuality?.missingRequiredFacets.length ?? 0;
  const nextMissing = next.selectionQuality?.missingRequiredFacets.length ?? 0;

  return gainedInScopePaper
    || nextMissing < previousMissing
    || canonicalReviewQualityScore(next) > canonicalReviewQualityScore(previous);
}

function shouldRunRecoveryPass(
  state: CanonicalReviewState,
  literatureReviewActive: boolean,
  recoveryPasses: number
): boolean {
  return literatureReviewActive
    && recoveryPasses < 2
    && (
      state.canonicalPapers.length === 0
      || state.reviewedPapers.length < 3
      || selectionQualityNeedsRecovery(state.selectionQuality)
    );
}

function recoveryReason(state: CanonicalReviewState): string {
  if (state.canonicalPapers.length === 0 || state.reviewedPapers.length < 3) {
    return "Evidence remained thin after the first pass";
  }

  const missing = state.selectionQuality?.missingRequiredFacets.map((facet) => facet.label).slice(0, 4) ?? [];

  return missing.length > 0
    ? `Review facet coverage remained incomplete (${missing.join(", ")})`
    : "Review selection quality remained below the confidence target";
}

export class AgenticSourceGatherSession {
  private readonly scholarlyProviderIds: SourceProviderId[];
  private readonly generalWebProviderIds: SourceProviderId[];
  private readonly localEnabled: boolean;
  private readonly authStatus: ProviderAuthSnapshot[];
  private readonly domain: SourceProviderDomain | "mixed";
  private readonly routing: RoutingPlan;
  private readonly literatureReviewActive: boolean;
  private readonly budget: RetrievalBudget;
  private readonly literatureProfile: LiteratureReviewProfile | null;
  private readonly reviewFacets: ReviewFacet[];
  private readonly selectedAssessments: Array<{ sourceId: string; title: string; assessment: LiteratureSourceAssessment }> = [];
  private readonly providerAttempts: RetrievalDiagnostics["providerAttempts"] = [];
  private readonly rejectedSamples: Array<{ title: string; excerpt: string; rationale: string }> = [];
  private readonly scholarlySources: ResearchSource[] = [];
  private readonly seenScholarlySourceIds = new Set<string>();
  private readonly backgroundSources: ResearchSource[] = [];
  private readonly attemptedProviderIds = new Set<SourceProviderId>();
  private readonly exhaustedProviderQueryKeys = new Set<string>();
  private readonly actionHistory: SourceActionHistoryEntry[] = [];
  private newSourcesLastAction = 0;
  private consecutiveNoProgressSearches = 0;
  private localSources: ResearchSource[] = [];
  private queryPlan: { queries: string[]; candidates: QueryExpansionCandidate[] };
  private queries: string[];
  private canonicalReview: CanonicalReviewState | null = null;
  private sourceStage: "querying" | "merged" | "ranked" | "access_resolved" | "selected" = "querying";
  private readonly resolvedPaperIds = new Set<string>();
  private acceptedScreeningCount = 0;
  private rejectedScreeningCount = 0;
  private lastObservation: string | null = null;

  private constructor(private readonly request: ResearchSourceGatherRequest) {
    this.scholarlyProviderIds = selectedScholarlyProviderIds(request);
    this.generalWebProviderIds = selectedGeneralWebProviderIds(request);
    this.localEnabled = projectFilesEnabled(request);
    this.authStatus = authSnapshots(request, this.scholarlyProviderIds, this.generalWebProviderIds, this.localEnabled);
    this.domain = classifyDomain(request.brief, request.plan);
    this.routing = routeProviders(this.domain, this.scholarlyProviderIds);
    this.literatureReviewActive = shouldUseLiteratureReviewSubsystem(request.plan, request.brief);
    this.budget = buildRetrievalBudget(request, this.literatureReviewActive);
    this.queryPlan = buildQueryPlan(request, this.domain, this.budget);
    this.queries = this.queryPlan.queries;
    this.routing.plannedQueries = this.queries;
    this.literatureProfile = this.literatureReviewActive
      ? buildLiteratureReviewProfile({
        brief: request.brief,
        plan: request.plan,
        memoryContext: request.memoryContext
      })
      : null;
    this.reviewFacets = this.literatureReviewActive
      ? buildReviewFacets({
        brief: request.brief,
        plan: request.plan,
        profile: this.literatureProfile
      })
      : [];
  }

  static async create(request: ResearchSourceGatherRequest): Promise<AgenticSourceGatherSession> {
    const session = new AgenticSourceGatherSession(request);
    session.localSources = await gatherLocalProjectFiles(request);
    await emitSourceProgress(request.progress, {
      phase: "setup",
      status: "completed",
      message: `Prepared agentic source tools with ${session.queries.length} candidate queries across ${session.availableProviderIds().length} available providers.`,
      counts: {
        queries: session.queries.length,
        discoveryProviders: session.routing.discoveryProviderIds.length,
        maxAccessResolutions: session.budget.maxAccessResolutions
      }
    });
    return session;
  }

  availableProviderIds(): SourceProviderId[] {
    return uniqueProviderIds([
      ...this.routing.discoveryProviderIds,
      ...this.generalWebProviderIds
    ]);
  }

  state(): AgenticSourceState {
    const providerYields = this.providerYields();
    const exhaustedProviderIds = providerYields
      .filter((item) => (
        item.calls >= 2
        && item.newSources === 0
        && (item.rawCandidates > 0 || item.errors > 0)
      ) || item.errors >= 2)
      .map((item) => item.providerId);
    const repeatedSearchWarnings = this.repeatedSearchWarnings(providerYields, exhaustedProviderIds);

    return {
      availableProviderIds: this.availableProviderIds(),
      attemptedProviderIds: [...this.attemptedProviderIds],
      candidateQueries: this.queries.slice(0, 16),
      rawSources: this.localSources.length + this.scholarlySources.length + this.backgroundSources.length,
      screenedSources: this.scholarlySources.length,
      backgroundSources: this.backgroundSources.length,
      sourceStage: this.sourceStage,
      canonicalPapers: this.canonicalReview?.canonicalPapers.length ?? 0,
      candidatePaperIds: this.candidatePaperIds(12),
      resolvedPaperIds: [...this.resolvedPaperIds].slice(0, 24),
      selectedPapers: this.canonicalReview?.reviewedPapers.length ?? 0,
      selectedPaperIds: this.canonicalReview?.reviewedPapers.map((paper) => paper.id).slice(0, 24) ?? [],
      newSourcesLastAction: this.newSourcesLastAction,
      consecutiveNoProgressSearches: this.consecutiveNoProgressSearches,
      providerYields,
      exhaustedProviderIds,
      repeatedSearchWarnings,
      mergeReadiness: this.mergeReadiness(repeatedSearchWarnings),
      recentActions: this.actionHistory.slice(-8),
      lastObservation: this.lastObservation
    };
  }

  private providerYields(): SourceProviderYield[] {
    const byProvider = new Map<SourceProviderId, SourceProviderYield>();

    for (const attempt of this.providerAttempts) {
      const previous = byProvider.get(attempt.providerId) ?? {
        providerId: attempt.providerId,
        calls: 0,
        rawCandidates: 0,
        newSources: 0,
        errors: 0,
        lastError: null
      };

      previous.calls += attempt.providerCalls > 0 ? attempt.providerCalls : 1;
      previous.rawCandidates += attempt.rawCandidateCount;
      previous.newSources += attempt.acceptedSourceCount;
      if (attempt.error !== null) {
        previous.errors += 1;
        previous.lastError = attempt.error;
      }
      byProvider.set(attempt.providerId, previous);
    }

    return [...byProvider.values()];
  }

  private repeatedSearchWarnings(providerYields: SourceProviderYield[], exhaustedProviderIds: SourceProviderId[]): string[] {
    const warnings: string[] = [];

    if (this.consecutiveNoProgressSearches >= 2) {
      warnings.push(`${this.consecutiveNoProgressSearches} consecutive source searches added no new screened scholarly sources.`);
    }

    if (exhaustedProviderIds.length > 0) {
      warnings.push(`Low-yield or failing providers: ${exhaustedProviderIds.join(", ")}.`);
    }

    const productive = providerYields
      .filter((item) => item.newSources > 0)
      .sort((left, right) => right.newSources - left.newSources)
      .slice(0, 3);
    if (productive.length > 0) {
      warnings.push(`Productive providers so far: ${productive.map((item) => `${item.providerId} (${item.newSources})`).join(", ")}.`);
    }

    return warnings;
  }

  private mergeReadiness(warnings: string[]): SourceMergeReadiness {
    if (this.sourceStage !== "querying") {
      return {
        ready: false,
        reason: `Source stage is already ${this.sourceStage}; continue with the next source tool instead of restarting search unless a specific gap justifies it.`,
        recommendedActions: this.sourceStage === "merged"
          ? ["rank_sources", "resolve_access", "select_evidence_set"]
          : this.sourceStage === "ranked"
            ? ["resolve_access", "select_evidence_set"]
            : ["select_evidence_set"]
      };
    }

    if (this.scholarlySources.length === 0) {
      return {
        ready: false,
        reason: "No screened scholarly sources are available yet.",
        recommendedActions: []
      };
    }

    if (this.scholarlySources.length >= 8 || this.consecutiveNoProgressSearches >= 2) {
      return {
        ready: true,
        reason: warnings.length > 0
          ? `${this.scholarlySources.length} screened scholarly sources are available. ${warnings.join(" ")}`
          : `${this.scholarlySources.length} screened scholarly sources are available for canonical merge.`,
        recommendedActions: ["merge_sources", "rank_sources", "select_evidence_set"]
      };
    }

    return {
      ready: false,
      reason: `${this.scholarlySources.length} screened scholarly sources are available; more targeted search may still help if it addresses a missing evidence target.`,
      recommendedActions: ["merge_sources"]
    };
  }

  private candidatePaperIds(limit: number): string[] {
    if (this.canonicalReview === null) {
      return [];
    }

    const preferredIds = uniqueStrings([
      ...this.canonicalReview.reviewWorkflow.synthesisPaperIds,
      ...this.canonicalReview.reviewWorkflow.includedPaperIds,
      ...this.canonicalReview.relevanceAssessments
        .filter((assessment) => assessment.status === "in_scope")
        .map((assessment) => assessment.paperId),
      ...this.canonicalReview.reviewWorkflow.uncertainPaperIds
    ]);

    if (preferredIds.length > 0) {
      return preferredIds.slice(0, limit);
    }

    const coverageByPaperId = new Map((this.canonicalReview.selectionQuality?.paperFacetCoverage ?? [])
      .map((coverage) => [coverage.paperId, coverage]));
    return sortPapersForReview(this.canonicalReview.canonicalPapers, coverageByPaperId)
      .map((paper) => paper.id)
      .slice(0, limit);
  }

  private sourceBudget(queryCount: number): RetrievalBudget {
    return {
      ...this.budget,
      maxQueries: Math.max(1, queryCount),
      maxQueriesPerProvider: Math.max(1, Math.min(4, queryCount)),
      maxProviderCallsPerProvider: Math.min(8, this.budget.maxProviderCallsPerProvider),
      maxPagesPerQuery: Math.min(2, this.budget.maxPagesPerQuery),
      maxCandidatesPerProvider: Math.min(80, this.budget.maxCandidatesPerProvider)
    };
  }

  isSearchExhausted(providerId: SourceProviderId, queries: string[]): boolean {
    return this.exhaustedProviderQueryKeys.has(providerQueryKey(providerId, queries))
      || this.state().exhaustedProviderIds.includes(providerId);
  }

  private recordAction(entry: SourceActionHistoryEntry): void {
    this.actionHistory.push(entry);
    if (this.actionHistory.length > 20) {
      this.actionHistory.splice(0, this.actionHistory.length - 20);
    }
    this.newSourcesLastAction = entry.newSources;
  }

  private recordSearchOutcome(input: {
    providerId: SourceProviderId;
    querySet: string[];
    rawCandidates: number;
    newSources: number;
    error: string | null;
    message: string;
  }): void {
    const queryKey = providerQueryKey(input.providerId, input.querySet);

    if (input.newSources === 0 || input.error !== null) {
      this.consecutiveNoProgressSearches += 1;
    } else {
      this.consecutiveNoProgressSearches = 0;
    }

    const matchingAttempts = this.actionHistory
      .filter((entry) => entry.action === "query_provider" && entry.queryKey === queryKey);
    const previousNoProgressAttempts = matchingAttempts.filter((entry) => entry.newSources === 0 || entry.error !== null).length;

    if ((input.newSources === 0 || input.error !== null) && previousNoProgressAttempts >= 1) {
      this.exhaustedProviderQueryKeys.add(queryKey);
    }

    this.recordAction({
      action: "query_provider",
      providerId: input.providerId,
      queryKey,
      rawCandidates: input.rawCandidates,
      newSources: input.newSources,
      error: input.error,
      message: input.message
    });
  }

  private recordNonSearchAction(observation: SourceToolObservation): void {
    this.recordAction({
      action: observation.action,
      providerId: null,
      queryKey: null,
      rawCandidates: observation.counts.rawCandidates ?? 0,
      newSources: 0,
      error: null,
      message: observation.message
    });
  }

  async queryProvider(providerId: SourceProviderId, queries: string[]): Promise<SourceToolObservation> {
    const available = this.availableProviderIds();
    if (!available.includes(providerId)) {
      this.lastObservation = `${providerId} is not available for this run.`;
      this.recordSearchOutcome({
        providerId,
        querySet: queries,
        rawCandidates: 0,
        newSources: 0,
        error: this.lastObservation,
        message: this.lastObservation
      });
      return {
        action: "query_provider",
        message: this.lastObservation,
        counts: {}
      };
    }

    const querySet = uniqueStrings(queries.length > 0 ? queries : this.queries.slice(0, 4)).slice(0, 6);
    const queryKey = providerQueryKey(providerId, querySet);
    if (this.exhaustedProviderQueryKeys.has(queryKey)) {
      this.lastObservation = `${getSourceProviderDefinition(providerId).label} search skipped because this provider/query set already produced no new screened sources twice.`;
      this.recordSearchOutcome({
        providerId,
        querySet,
        rawCandidates: 0,
        newSources: 0,
        error: this.lastObservation,
        message: this.lastObservation
      });
      return {
        action: "query_provider",
        message: this.lastObservation,
        counts: {
          newSources: 0,
          scholarlySources: this.scholarlySources.length
        }
      };
    }
    this.queries = uniqueStrings([...this.queries, ...querySet]);
    this.routing.plannedQueries = this.queries;
    this.attemptedProviderIds.add(providerId);
    if (this.sourceStage !== "querying") {
      this.canonicalReview = null;
      this.resolvedPaperIds.clear();
      this.sourceStage = "querying";
    }
    await emitSourceProgress(this.request.progress, {
      phase: "provider_query",
      status: "started",
      providerId,
      message: `Research agent chose ${getSourceProviderDefinition(providerId).label} with ${querySet.length} queries.`,
      counts: {
        scholarlySources: this.scholarlySources.length
      }
    });

    try {
      const providerResult = await queryProvider(providerId, querySet, this.request, this.sourceBudget(querySet.length));
      const isBackgroundProvider = isGeneralWebProviderCategory(getSourceProviderDefinition(providerId).category);

      if (isBackgroundProvider) {
        const filtered = backgroundFilter(providerResult.candidates, this.request);
        this.backgroundSources.push(...filtered);
        this.lastObservation = `${getSourceProviderDefinition(providerId).label} returned ${providerResult.candidates.length} raw background candidates and ${filtered.length} retained background sources.`;
        this.providerAttempts.push({
          providerId,
          phase: "initial",
          providerCalls: providerResult.providerCalls,
          rawCandidateCount: providerResult.candidates.length,
          acceptedSourceCount: filtered.length,
          error: null
        });
        this.recordSearchOutcome({
          providerId,
          querySet,
          rawCandidates: providerResult.candidates.length,
          newSources: filtered.length,
          error: null,
          message: this.lastObservation
        });
        return {
          action: "query_provider",
          message: this.lastObservation,
          counts: {
            providerCalls: providerResult.providerCalls,
            rawCandidates: providerResult.candidates.length,
            newSources: filtered.length,
            scholarlySources: this.scholarlySources.length
          }
        };
      }

      const filtered = filterCandidates(providerResult.candidates, this.request, this.literatureProfile);
      const newSources = filtered.sources.filter((source) => {
        if (this.seenScholarlySourceIds.has(source.id)) {
          return false;
        }

        this.seenScholarlySourceIds.add(source.id);
        return true;
      });
      this.scholarlySources.push(...newSources);
      this.selectedAssessments.push(...filtered.assessments);
      this.rejectedSamples.push(...filtered.rejectedSamples);
      this.acceptedScreeningCount += filtered.acceptedCount;
      this.rejectedScreeningCount += filtered.rejectedCount;
      this.providerAttempts.push({
        providerId,
        phase: "initial",
        providerCalls: providerResult.providerCalls,
        rawCandidateCount: providerResult.candidates.length,
        acceptedSourceCount: newSources.length,
        error: null
      });
      this.lastObservation = `${getSourceProviderDefinition(providerId).label} returned ${providerResult.candidates.length} raw candidates and ${newSources.length} new screened scholarly sources.`;
      await emitSourceProgress(this.request.progress, {
        phase: "screening",
        status: "completed",
        providerId,
        message: this.lastObservation,
        counts: {
          providerCalls: providerResult.providerCalls,
          rawCandidates: providerResult.candidates.length,
          newSources: newSources.length,
          scholarlySources: this.scholarlySources.length
        }
      });
      this.recordSearchOutcome({
        providerId,
        querySet,
        rawCandidates: providerResult.candidates.length,
        newSources: newSources.length,
        error: null,
        message: this.lastObservation
      });
      return {
        action: "query_provider",
        message: this.lastObservation,
        counts: {
          providerCalls: providerResult.providerCalls,
          rawCandidates: providerResult.candidates.length,
          newSources: newSources.length,
          scholarlySources: this.scholarlySources.length
        }
      };
    } catch (error) {
      const message = `${getSourceProviderDefinition(providerId).label} query failed: ${error instanceof Error ? error.message : String(error)}`;
      this.lastObservation = message;
      this.providerAttempts.push({
        providerId,
        phase: "initial",
        providerCalls: 0,
        rawCandidateCount: 0,
        acceptedSourceCount: 0,
        error: message
      });
      await emitSourceProgress(this.request.progress, {
        phase: "provider_query",
        status: "failed",
        providerId,
        message
      });
      this.recordSearchOutcome({
        providerId,
        querySet,
        rawCandidates: 0,
        newSources: 0,
        error: message,
        message
      });
      return {
        action: "query_provider",
        message,
        counts: {}
      };
    }
  }

  async mergeSources(): Promise<SourceToolObservation> {
    await emitSourceProgress(this.request.progress, {
      phase: "canonical_merge",
      status: "started",
      message: `Research agent requested canonical merge from ${this.scholarlySources.length} screened scholarly sources.`,
      counts: {
        scholarlySources: this.scholarlySources.length
      }
    });
    this.canonicalReview = await buildCanonicalReviewState(this.scholarlySources, this.routing, this.request, this.reviewFacets, {
      maxAccessResolutions: 0,
      accessResolutionCheckpointSize: this.budget.accessResolutionCheckpointSize,
      progress: this.request.progress
    });
    this.sourceStage = "merged";
    this.lastObservation = `Merged ${this.scholarlySources.length} screened scholarly sources into ${this.canonicalReview.canonicalPapers.length} canonical papers.`;
    const observation: SourceToolObservation = {
      action: "merge_sources",
      message: this.lastObservation,
      counts: {
        scholarlySources: this.scholarlySources.length,
        canonicalPapers: this.canonicalReview.canonicalPapers.length
      }
    };
    this.recordNonSearchAction(observation);
    return observation;
  }

  async rankSources(): Promise<SourceToolObservation> {
    if (this.canonicalReview === null) {
      await this.mergeSources();
    }

    const canonicalReview = this.canonicalReview!;
    const candidatePaperIds = this.candidatePaperIds(12);
    this.sourceStage = "ranked";
    this.lastObservation = `Ranked ${canonicalReview.canonicalPapers.length} canonical papers; ${candidatePaperIds.length} candidate paper ids are available for access resolution or evidence selection.`;
    await emitSourceProgress(this.request.progress, {
      phase: "review_selection",
      status: "progress",
      message: this.lastObservation,
      counts: {
        canonicalPapers: canonicalReview.canonicalPapers.length,
        candidatePapers: candidatePaperIds.length,
        includedPapers: canonicalReview.reviewWorkflow.counts.included
      }
    });
    const observation: SourceToolObservation = {
      action: "rank_sources",
      message: this.lastObservation,
      counts: {
        canonicalPapers: canonicalReview.canonicalPapers.length,
        candidatePapers: candidatePaperIds.length
      }
    };
    this.recordNonSearchAction(observation);
    return observation;
  }

  async resolveAccess(paperIds: string[]): Promise<SourceToolObservation> {
    if (this.canonicalReview === null) {
      await this.mergeSources();
    }

    const knownPaperIds = new Set(this.canonicalReview!.canonicalPapers.map((paper) => paper.id));
    const targetPaperIds = uniqueStrings(paperIds.length > 0 ? paperIds : this.candidatePaperIds(this.budget.maxAccessResolutions))
      .filter((paperId) => knownPaperIds.has(paperId))
      .slice(0, this.budget.maxAccessResolutions);
    this.canonicalReview = await buildCanonicalReviewState(this.scholarlySources, this.routing, this.request, this.reviewFacets, {
      maxAccessResolutions: Math.min(this.budget.maxAccessResolutions, Math.max(0, targetPaperIds.length)),
      accessResolutionCheckpointSize: this.budget.accessResolutionCheckpointSize,
      targetPaperIds,
      progress: this.request.progress
    });
    for (const paperId of targetPaperIds) {
      this.resolvedPaperIds.add(paperId);
    }

    this.sourceStage = "access_resolved";
    this.lastObservation = `Resolved access for ${targetPaperIds.length} agent-selected candidate papers; ${this.canonicalReview.canonicalPapers.length} canonical papers remain available.`;
    const observation: SourceToolObservation = {
      action: "resolve_access",
      message: this.lastObservation,
      counts: {
        canonicalPapers: this.canonicalReview.canonicalPapers.length,
        resolvedPapers: targetPaperIds.length
      }
    };
    this.recordNonSearchAction(observation);
    return observation;
  }

  async selectEvidenceSet(): Promise<SourceToolObservation> {
    if (this.canonicalReview === null) {
      await this.mergeSources();
    }

    const canonicalReview = this.canonicalReview!;
    this.sourceStage = "selected";
    this.lastObservation = `Selected ${canonicalReview.reviewedPapers.length} papers for synthesis from ${canonicalReview.canonicalPapers.length} canonical papers.`;
    await emitSourceProgress(this.request.progress, {
      phase: "review_selection",
      status: "completed",
      message: this.lastObservation,
      counts: {
        canonicalPapers: canonicalReview.canonicalPapers.length,
        selectedPapers: canonicalReview.reviewedPapers.length,
        includedPapers: canonicalReview.reviewWorkflow.counts.included
      }
    });
    const observation: SourceToolObservation = {
      action: "select_evidence_set",
      message: this.lastObservation,
      counts: {
        canonicalPapers: canonicalReview.canonicalPapers.length,
        selectedPapers: canonicalReview.reviewedPapers.length
      }
    };
    this.recordNonSearchAction(observation);
    return observation;
  }

  async result(): Promise<ResearchSourceGatherResult> {
    if (this.canonicalReview === null || this.sourceStage !== "selected") {
      await this.selectEvidenceSet();
    }

    const canonicalReview = this.canonicalReview!;
    const { canonicalPapers, reviewedPapers, reviewWorkflow, selectionQuality, relevanceAssessments } = canonicalReview;
    const allSources: ResearchSource[] = [
      {
        id: "brief:project",
        providerId: null,
        category: "brief",
        kind: "project_brief",
        title: this.request.brief.topic ?? this.request.plan.objective,
        locator: null,
        citation: "User-provided project brief.",
        excerpt: excerptText([
          this.request.brief.topic,
          this.request.brief.researchQuestion,
          this.request.brief.researchDirection,
          this.request.brief.successCriterion
        ].filter((value): value is string => typeof value === "string").join(" | ")),
        year: null,
        authors: [],
        venue: null,
        identifiers: {},
        access: null
      },
      ...this.localSources,
      ...this.scholarlySources,
      ...this.backgroundSources
    ];
    const retrievalDiagnostics: RetrievalDiagnostics = {
      queries: this.queryPlan.candidates.slice(0, 80),
      providerAttempts: this.providerAttempts,
      screeningSummary: {
        accepted: this.acceptedScreeningCount,
        rejected: this.rejectedScreeningCount,
        weakMatchSamples: this.rejectedSamples.slice(0, 12).map((sample) => ({
          title: sample.title,
          rationale: sample.rationale
        }))
      },
      revisionPasses: 0,
      accessLimitations: accessLimitationsFromAuth(this.authStatus),
      suggestedNextQueries: buildRecoveryQueryCandidates(this.request, this.rejectedSamples, selectionQuality)
        .map((candidate) => candidate.query)
        .filter((query) => !this.queries.map(normalizeQueryKey).includes(normalizeQueryKey(query)))
        .slice(0, 8)
    };

    await emitSourceProgress(this.request.progress, {
      phase: "completed",
      status: "completed",
      message: `Agentic source loop completed with ${canonicalPapers.length} canonical papers and ${reviewedPapers.length} selected papers.`,
      counts: {
        rawSources: allSources.length,
        canonicalPapers: canonicalPapers.length,
        reviewedPapers: reviewedPapers.length,
        providerAttempts: this.providerAttempts.length
      }
    });

    return {
      sources: allSources,
      canonicalPapers,
      reviewedPapers,
      notes: [
        "Agentic source-gathering loop active.",
        `Model-selected providers attempted: ${[...this.attemptedProviderIds].join(", ") || "none"}.`,
        `Canonical merge produced ${canonicalPapers.length} scholarly papers from ${this.scholarlySources.length} discovery hits.`,
        ...reviewWorkflow.notes
      ],
      routing: this.routing,
      mergeDiagnostics: canonicalReview.mergeDiagnostics,
      authStatus: this.authStatus,
      reviewWorkflow,
      literatureReview: this.literatureProfile === null
        ? null
        : {
          active: true,
          profile: this.literatureProfile,
          selectedAssessments: this.selectedAssessments,
          relevanceAssessments
        },
      retrievalDiagnostics,
      selectionQuality,
      relevanceAssessments,
      agenticSourceState: this.state()
    };
  }
}

export class DefaultResearchSourceGatherer implements ResearchSourceGatherer {
  async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
    const scholarlyProviderIds = selectedScholarlyProviderIds(request);
    const generalWebProviderIds = selectedGeneralWebProviderIds(request);
    const localEnabled = projectFilesEnabled(request);
    const authStatus = authSnapshots(request, scholarlyProviderIds, generalWebProviderIds, localEnabled);
    const notes: string[] = [];
    const mergeDiagnostics: string[] = [];
    const domain = classifyDomain(request.brief, request.plan);
    const routing = routeProviders(domain, scholarlyProviderIds);
    const literatureReviewActive = shouldUseLiteratureReviewSubsystem(request.plan, request.brief);
    const budget = buildRetrievalBudget(request, literatureReviewActive);
    let queryPlan = buildQueryPlan(request, domain, budget);
    let queries = queryPlan.queries;
    routing.plannedQueries = queries;
    const literatureProfile = literatureReviewActive
      ? buildLiteratureReviewProfile({
        brief: request.brief,
        plan: request.plan,
        memoryContext: request.memoryContext
      })
      : null;
    const reviewFacets = literatureReviewActive
      ? buildReviewFacets({
        brief: request.brief,
        plan: request.plan,
        profile: literatureProfile
      })
      : [];
    const selectedAssessments: Array<{ sourceId: string; title: string; assessment: LiteratureSourceAssessment }> = [];
    const providerAttempts: RetrievalDiagnostics["providerAttempts"] = [];
    const rejectedSamples: Array<{ title: string; excerpt: string; rationale: string }> = [];
    const localSources = await gatherLocalProjectFiles(request);
    const scholarlySources: ResearchSource[] = [];
    const seenScholarlySourceIds = new Set<string>();
    const backgroundSources: ResearchSource[] = [];
    let acceptedScreeningCount = 0;
    let rejectedScreeningCount = 0;
    let revisionPasses = 0;

    if (literatureProfile !== null) {
      notes.push("Literature review subsystem active.");
      if (literatureProfile.taskAttributes.length > 0) {
        notes.push(`Task-aware paper ranking attributes: ${literatureProfile.taskAttributes.join(", ")}.`);
      }
      if (reviewFacets.length > 0) {
        notes.push(`Review facet selection will track: ${reviewFacets.map((facet) => `${facet.label}${facet.required ? " (required)" : ""}`).join(", ")}.`);
      }
    }

    notes.push(`Query planning produced ${queries.length} retrieval queries.`);
    notes.push(
      `Retrieval budget: up to ${budget.maxQueriesPerProvider} queries per provider, ${budget.maxPagesPerQuery} pages per query, ${budget.maxProviderCallsPerProvider} provider calls per provider, ${budget.maxCandidatesPerProvider} raw candidates per provider, and ${budget.maxAccessResolutions} targeted access resolutions.`
    );
    notes.push(`Domain-aware routing selected ${routing.discoveryProviderIds.join(", ") || "no scholarly discovery providers"}.`);
    await emitSourceProgress(request.progress, {
      phase: "setup",
      status: "completed",
      message: `Prepared ${queries.length} retrieval queries across ${routing.discoveryProviderIds.length} routed scholarly providers.`,
      counts: {
        queries: queries.length,
        discoveryProviders: routing.discoveryProviderIds.length,
        maxAccessResolutions: budget.maxAccessResolutions
      }
    });

    const minimumProviderPassesBeforeStop = literatureReviewActive
      ? Math.min(domain === "biomedical" ? 4 : 3, routing.discoveryProviderIds.length)
      : 1;
    const runScholarlyDiscoveryPass = async (
      passQueries: string[],
      passBudget: RetrievalBudget,
      phase: "initial" | "revision"
    ): Promise<void> => {
      let consecutiveNoProgressProviders = 0;

      for (const [providerIndex, providerId] of routing.discoveryProviderIds.entries()) {
        await emitSourceProgress(request.progress, {
          phase: "provider_query",
          status: "started",
          providerId,
          providerIndex: providerIndex + 1,
          providerCount: routing.discoveryProviderIds.length,
          message: `Starting ${phase} discovery with ${getSourceProviderDefinition(providerId).label}.`,
          counts: {
            scholarlySources: scholarlySources.length,
            acceptedScreening: acceptedScreeningCount,
            rejectedScreening: rejectedScreeningCount
          }
        });

        try {
          const providerResult = await queryProvider(providerId, passQueries, request, passBudget);
          const rawCandidates = providerResult.candidates;
          const filtered = filterCandidates(rawCandidates, request, literatureProfile);
          const newSources = filtered.sources.filter((source) => {
            if (seenScholarlySourceIds.has(source.id)) {
              return false;
            }

            seenScholarlySourceIds.add(source.id);
            return true;
          });
          scholarlySources.push(...newSources);
          notes.push(...filtered.notes);
          selectedAssessments.push(...filtered.assessments);
          rejectedSamples.push(...filtered.rejectedSamples);
          acceptedScreeningCount += filtered.acceptedCount;
          rejectedScreeningCount += filtered.rejectedCount;
          providerAttempts.push({
            providerId,
            phase,
            providerCalls: providerResult.providerCalls,
            rawCandidateCount: rawCandidates.length,
            acceptedSourceCount: newSources.length,
            error: null
          });
          notes.push(
            `Collected ${newSources.length} new screened scholarly hits from ${getSourceProviderDefinition(providerId).label} after reviewing ${rawCandidates.length} raw candidates${phase === "revision" ? " during revision" : ""}.`
          );
          await emitSourceProgress(request.progress, {
            phase: "screening",
            status: "completed",
            providerId,
            providerIndex: providerIndex + 1,
            providerCount: routing.discoveryProviderIds.length,
            message: `${getSourceProviderDefinition(providerId).label} returned ${rawCandidates.length} raw candidates and ${newSources.length} new screened sources.`,
            counts: {
              providerCalls: providerResult.providerCalls,
              rawCandidates: rawCandidates.length,
              newSources: newSources.length,
              scholarlySources: scholarlySources.length
            }
          });
          consecutiveNoProgressProviders = newSources.length === 0
            ? consecutiveNoProgressProviders + 1
            : 0;

          if (
            scholarlySources.length >= passBudget.targetAcceptedSources
            && providerIndex + 1 >= minimumProviderPassesBeforeStop
          ) {
            notes.push(
              `Reached the current screened-source target (${passBudget.targetAcceptedSources}) after querying ${providerIndex + 1} providers and stopped discovery early.`
            );
            break;
          }

          if (
            phase === "revision"
            && providerIndex + 1 >= minimumProviderPassesBeforeStop
            && consecutiveNoProgressProviders >= 3
          ) {
            notes.push("Stopped this revision discovery pass after three consecutive providers produced no new screened sources.");
            await emitSourceProgress(request.progress, {
              phase: "provider_query",
              status: "skipped",
              message: "Stopped this revision pass after repeated provider calls produced no new screened sources.",
              counts: {
                consecutiveNoProgressProviders,
                scholarlySources: scholarlySources.length
              }
            });
            break;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          providerAttempts.push({
            providerId,
            phase,
            providerCalls: 0,
            rawCandidateCount: 0,
            acceptedSourceCount: 0,
            error: message
          });
          notes.push(`${getSourceProviderDefinition(providerId).label} query failed: ${message}`);
          await emitSourceProgress(request.progress, {
            phase: "provider_query",
            status: "failed",
            providerId,
            providerIndex: providerIndex + 1,
            providerCount: routing.discoveryProviderIds.length,
            message: `${getSourceProviderDefinition(providerId).label} query failed: ${message}`,
            counts: {
              scholarlySources: scholarlySources.length
            }
          });
        }
      }
    };

    await runScholarlyDiscoveryPass(queries, budget, "initial");

    for (const providerId of generalWebProviderIds) {
      try {
        const providerResult = await queryProvider(providerId, queries, request, {
          ...budget,
          maxQueriesPerProvider: Math.min(6, budget.maxQueriesPerProvider),
          maxProviderCallsPerProvider: Math.min(6, budget.maxProviderCallsPerProvider),
          maxPagesPerQuery: 1,
          maxCandidatesPerProvider: 12,
          pageSize: 5
        });
        const rawCandidates = providerResult.candidates;
        const filtered = backgroundFilter(rawCandidates, request);
        backgroundSources.push(...filtered);
        notes.push(`Collected ${filtered.length} general-web sources from ${getSourceProviderDefinition(providerId).label}.`);
      } catch (error) {
        notes.push(`${getSourceProviderDefinition(providerId).label} general-web query failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await emitSourceProgress(request.progress, {
      phase: "canonical_merge",
      status: "started",
      message: `Merging ${scholarlySources.length} screened scholarly sources into canonical papers.`,
      counts: {
        scholarlySources: scholarlySources.length
      }
    });
    let canonicalReview = await buildCanonicalReviewState(scholarlySources, routing, request, reviewFacets, {
      maxAccessResolutions: budget.maxAccessResolutions,
      accessResolutionCheckpointSize: budget.accessResolutionCheckpointSize,
      progress: request.progress
    });
    await emitSourceProgress(request.progress, {
      phase: "review_selection",
      status: "completed",
      message: `Selected ${canonicalReview.reviewedPapers.length} papers for synthesis from ${canonicalReview.canonicalPapers.length} canonical papers.`,
      counts: {
        canonicalPapers: canonicalReview.canonicalPapers.length,
        selectedPapers: canonicalReview.reviewedPapers.length,
        includedPapers: canonicalReview.reviewWorkflow.counts.included
      }
    });
    let nonImprovingRecoveryPasses = 0;

    while (shouldRunRecoveryPass(canonicalReview, literatureReviewActive, revisionPasses)) {
      const previousReview = canonicalReview;
      const initialQueryKeys = new Set(queries.map(normalizeQueryKey));
      const recoveryCandidates = buildRecoveryQueryCandidates(request, rejectedSamples, canonicalReview.selectionQuality);
      queryPlan = buildQueryPlan(request, domain, {
        ...budget,
        maxQueries: Math.min(12, budget.maxQueries)
      }, recoveryCandidates);
      const recoveryQueries = interleaveQueryCandidates(queryPlan.candidates, 24)
        .filter((candidate) => !initialQueryKeys.has(normalizeQueryKey(candidate.query)))
        .slice(0, 12)
        .map((candidate) => candidate.query);

      if (recoveryQueries.length > 0) {
        revisionPasses += 1;
        queries = uniqueStrings([...queries, ...recoveryQueries]);
        routing.plannedQueries = queries;
        notes.push(`${recoveryReason(canonicalReview)}; running revision pass ${revisionPasses} with ${recoveryQueries.length} additional queries.`);
        await runScholarlyDiscoveryPass(recoveryQueries, {
          ...budget,
          maxQueries: recoveryQueries.length,
          maxQueriesPerProvider: Math.min(8, recoveryQueries.length),
          maxProviderCallsPerProvider: Math.min(12, budget.maxProviderCallsPerProvider),
          maxPagesPerQuery: Math.min(2, budget.maxPagesPerQuery),
          maxCandidatesPerProvider: Math.min(80, budget.maxCandidatesPerProvider),
          maxAccessResolutions: Math.min(16, budget.maxAccessResolutions),
          targetAcceptedSources: Math.max(24, Math.floor(budget.targetAcceptedSources / 2))
        }, "revision");
        canonicalReview = await buildCanonicalReviewState(scholarlySources, routing, request, reviewFacets, {
          maxAccessResolutions: Math.min(16, budget.maxAccessResolutions),
          accessResolutionCheckpointSize: budget.accessResolutionCheckpointSize,
          progress: request.progress
        });
        if (canonicalReviewImproved(previousReview, canonicalReview)) {
          nonImprovingRecoveryPasses = 0;
          notes.push("Revision improved the in-scope evidence set or reduced missing evidence targets.");
        } else {
          nonImprovingRecoveryPasses += 1;
          notes.push("Revision did not improve the in-scope evidence set; the next revision pass must pivot strategy or stop.");
          if (nonImprovingRecoveryPasses >= 2) {
            notes.push("Revision stopped because repeated passes did not improve protocol relevance or coverage.");
            break;
          }
        }
      } else {
        notes.push(`${recoveryReason(canonicalReview)}; no unused revision queries remained, so retrieval stopped.`);
        break;
      }
    }

    const { canonicalPapers, reviewedPapers, reviewWorkflow, selectionQuality, relevanceAssessments } = canonicalReview;
    mergeDiagnostics.push(...canonicalReview.mergeDiagnostics);
    notes.push(`Canonical merge produced ${canonicalPapers.length} scholarly papers from ${scholarlySources.length} discovery hits.`);
    notes.push(...reviewWorkflow.notes);
    const retrievalDiagnostics: RetrievalDiagnostics = {
      queries: queryPlan.candidates.slice(0, 80),
      providerAttempts,
      screeningSummary: {
        accepted: acceptedScreeningCount,
        rejected: rejectedScreeningCount,
        weakMatchSamples: rejectedSamples.slice(0, 12).map((sample) => ({
          title: sample.title,
          rationale: sample.rationale
        }))
      },
      revisionPasses,
      accessLimitations: accessLimitationsFromAuth(authStatus),
      suggestedNextQueries: buildRecoveryQueryCandidates(request, rejectedSamples, selectionQuality)
        .map((candidate) => candidate.query)
        .filter((query) => !queries.map(normalizeQueryKey).includes(normalizeQueryKey(query)))
        .slice(0, 8)
    };

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

    await emitSourceProgress(request.progress, {
      phase: "completed",
      status: "completed",
      message: `Source gathering completed with ${canonicalPapers.length} canonical papers and ${reviewedPapers.length} selected papers.`,
      counts: {
        rawSources: allSources.length,
        canonicalPapers: canonicalPapers.length,
        reviewedPapers: reviewedPapers.length,
        providerAttempts: providerAttempts.length,
        revisionPasses
      }
    });

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
          selectedAssessments,
          relevanceAssessments
        },
      retrievalDiagnostics,
      selectionQuality,
      relevanceAssessments
    };
  }
}

export function createDefaultResearchSourceGatherer(): ResearchSourceGatherer {
  return new DefaultResearchSourceGatherer();
}
