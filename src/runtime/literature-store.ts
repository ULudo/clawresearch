import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResearchBrief } from "./session-store.js";
import { runtimeDirectoryPath } from "./session-store.js";
import {
  normalizeProviderId,
  type SourceProviderId
} from "./provider-registry.js";

const literatureSchemaVersion = 2;
const literatureDirectoryName = "literature";
const literatureStoreFileName = "library.json";

export type PaperAccessMode =
  | "metadata_only"
  | "abstract_available"
  | "fulltext_open"
  | "fulltext_licensed"
  | "fulltext_blocked"
  | "needs_credentials";

export type PaperFulltextFormat =
  | "xml"
  | "html"
  | "pdf"
  | "none";

export type PaperScreeningStage =
  | "title"
  | "abstract"
  | "fulltext";

export type PaperScreeningDecision =
  | "include"
  | "background"
  | "exclude"
  | "uncertain";

export type PaperIdentifiers = {
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxivId: string | null;
};

export type PaperDiscoveryRecord = {
  providerId: SourceProviderId;
  sourceId: string;
  title: string;
  locator: string | null;
  citation: string;
  year: number | null;
};

export type PaperAccessRecord = {
  providerId: SourceProviderId;
  url: string | null;
  accessMode: PaperAccessMode;
  fulltextFormat: PaperFulltextFormat;
  license: string | null;
  tdmAllowed: boolean | null;
  note: string | null;
};

export type PaperContentStatus = {
  abstractAvailable: boolean;
  fulltextAvailable: boolean;
  fulltextFetched: boolean;
  fulltextExtracted: boolean;
};

export type PaperScreeningStatus = {
  stage: PaperScreeningStage;
  decision: PaperScreeningDecision;
  rationale: string | null;
};

export type CanonicalPaper = {
  id: string;
  key: string;
  title: string;
  citation: string;
  abstract: string | null;
  year: number | null;
  authors: string[];
  venue: string | null;
  discoveredVia: SourceProviderId[];
  identifiers: PaperIdentifiers;
  discoveryRecords: PaperDiscoveryRecord[];
  accessCandidates: PaperAccessRecord[];
  bestAccessUrl: string | null;
  bestAccessProvider: SourceProviderId | null;
  accessMode: PaperAccessMode;
  fulltextFormat: PaperFulltextFormat;
  license: string | null;
  tdmAllowed: boolean | null;
  contentStatus: PaperContentStatus;
  screeningStage: PaperScreeningStage;
  screeningDecision: PaperScreeningDecision;
  screeningRationale: string | null;
  accessErrors: string[];
  tags: string[];
  runIds: string[];
  linkedThemeIds: string[];
  linkedClaimIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type LiteratureThemeBoard = {
  id: string;
  key: string;
  title: string;
  summary: string;
  paperIds: string[];
  claimIds: string[];
  questionTexts: string[];
  runIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type LiteratureReviewNotebook = {
  id: string;
  key: string;
  title: string;
  runId: string;
  objective: string;
  summary: string;
  paperIds: string[];
  themeIds: string[];
  claimIds: string[];
  nextQuestions: string[];
  providerIds: SourceProviderId[];
  createdAt: string;
  updatedAt: string;
};

export type LiteratureState = {
  schemaVersion: number;
  projectRoot: string;
  runtimeDirectory: string;
  literatureDirectory: string;
  createdAt: string;
  updatedAt: string;
  paperCount: number;
  themeCount: number;
  notebookCount: number;
  papers: CanonicalPaper[];
  themes: LiteratureThemeBoard[];
  notebooks: LiteratureReviewNotebook[];
};

export type CanonicalPaperInput = {
  key: string;
  title: string;
  citation: string;
  abstract?: string | null;
  year?: number | null;
  authors?: string[];
  venue?: string | null;
  discoveredVia?: SourceProviderId[];
  identifiers?: Partial<PaperIdentifiers>;
  discoveryRecords?: PaperDiscoveryRecord[];
  accessCandidates?: PaperAccessRecord[];
  bestAccessUrl?: string | null;
  bestAccessProvider?: SourceProviderId | null;
  accessMode?: PaperAccessMode;
  fulltextFormat?: PaperFulltextFormat;
  license?: string | null;
  tdmAllowed?: boolean | null;
  contentStatus?: Partial<PaperContentStatus>;
  screeningStage?: PaperScreeningStage;
  screeningDecision?: PaperScreeningDecision;
  screeningRationale?: string | null;
  accessErrors?: string[];
  tags?: string[];
  runId: string;
  linkedThemeIds?: string[];
  linkedClaimIds?: string[];
};

export type LiteratureThemeInput = {
  key: string;
  title: string;
  summary: string;
  runId: string;
  paperIds: string[];
  claimIds?: string[];
  questionTexts?: string[];
};

export type LiteratureNotebookInput = {
  key: string;
  title: string;
  runId: string;
  objective: string;
  summary: string;
  paperIds: string[];
  themeIds: string[];
  claimIds: string[];
  nextQuestions: string[];
  providerIds: SourceProviderId[];
};

export type LiteratureUpsertBatch = {
  papers?: CanonicalPaperInput[];
  themes?: LiteratureThemeInput[];
  notebooks?: LiteratureNotebookInput[];
};

export type LiteratureUpsertResult = {
  inserted: {
    papers: number;
    themes: number;
    notebooks: number;
  };
  updated: {
    papers: number;
    themes: number;
    notebooks: number;
  };
  state: LiteratureState;
  papers: CanonicalPaper[];
  themes: LiteratureThemeBoard[];
  notebooks: LiteratureReviewNotebook[];
};

export type LiteratureContextPaperCard = {
  id: string;
  title: string;
  citation: string;
  abstract: string | null;
  bestAccessUrl: string | null;
  accessMode: PaperAccessMode;
  screeningDecision: PaperScreeningDecision;
  screeningStage: PaperScreeningStage;
  linkedThemeIds: string[];
};

export type LiteratureContextThemeCard = {
  id: string;
  title: string;
  summary: string;
  paperIds: string[];
};

export type LiteratureContextNotebookCard = {
  id: string;
  title: string;
  summary: string;
  nextQuestions: string[];
};

export type LiteratureContext = {
  available: boolean;
  paperCount: number;
  themeCount: number;
  notebookCount: number;
  papers: LiteratureContextPaperCard[];
  themes: LiteratureContextThemeCard[];
  notebooks: LiteratureContextNotebookCard[];
  queryHints: string[];
};

type LegacyPaperCard = {
  key?: string;
  title?: string;
  citation?: string;
  locator?: string | null;
  providerId?: unknown;
  excerpt?: string;
  stage?: string;
  relevance?: string;
  screeningRationale?: string | null;
  linkedThemeIds?: string[];
  linkedClaimIds?: string[];
  runIds?: string[];
  createdAt?: string;
  updatedAt?: string;
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    const text = readString(entry);

    if (text === null || seen.has(text)) {
      continue;
    }

    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function hashString(text: string): string {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter((token) => token.length >= 4);
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

export function createLiteratureEntityId(
  kind: "paper" | "theme" | "notebook",
  key: string
): string {
  return `${kind}-${hashString(`${kind}:${normalizeWhitespace(key)}`)}`;
}

function literatureDirectoryPath(projectRoot: string): string {
  return path.join(runtimeDirectoryPath(projectRoot), literatureDirectoryName);
}

export function literatureStoreFilePath(projectRoot: string): string {
  return path.join(literatureDirectoryPath(projectRoot), literatureStoreFileName);
}

function normalizeIdentifiers(value: unknown): PaperIdentifiers {
  const record = asObject(value);

  return {
    doi: readString(record.doi),
    pmid: readString(record.pmid),
    pmcid: readString(record.pmcid),
    arxivId: readString(record.arxivId)
  };
}

function normalizeDiscoveryRecord(value: unknown): PaperDiscoveryRecord | null {
  const record = asObject(value);
  const providerId = normalizeProviderId(record.providerId);
  const sourceId = readString(record.sourceId);
  const title = readString(record.title);
  const citation = readString(record.citation);

  if (providerId === null || sourceId === null || title === null || citation === null) {
    return null;
  }

  return {
    providerId,
    sourceId,
    title,
    locator: readString(record.locator),
    citation,
    year: readInteger(record.year)
  };
}

function normalizeAccessMode(value: unknown): PaperAccessMode {
  switch (value) {
    case "metadata_only":
    case "abstract_available":
    case "fulltext_open":
    case "fulltext_licensed":
    case "fulltext_blocked":
    case "needs_credentials":
      return value;
    default:
      return "metadata_only";
  }
}

function normalizeFulltextFormat(value: unknown): PaperFulltextFormat {
  switch (value) {
    case "xml":
    case "html":
    case "pdf":
    case "none":
      return value;
    default:
      return "none";
  }
}

function normalizeScreeningStage(value: unknown): PaperScreeningStage {
  switch (value) {
    case "title":
    case "abstract":
    case "fulltext":
      return value;
    default:
      return "title";
  }
}

function normalizeScreeningDecision(value: unknown): PaperScreeningDecision {
  switch (value) {
    case "include":
    case "background":
    case "exclude":
    case "uncertain":
      return value;
    default:
      return "uncertain";
  }
}

function normalizeAccessRecord(value: unknown): PaperAccessRecord | null {
  const record = asObject(value);
  const providerId = normalizeProviderId(record.providerId);

  if (providerId === null) {
    return null;
  }

  return {
    providerId,
    url: readString(record.url),
    accessMode: normalizeAccessMode(record.accessMode),
    fulltextFormat: normalizeFulltextFormat(record.fulltextFormat),
    license: readString(record.license),
    tdmAllowed: readBoolean(record.tdmAllowed),
    note: readString(record.note)
  };
}

function normalizeContentStatus(value: unknown, accessMode: PaperAccessMode): PaperContentStatus {
  const record = asObject(value);
  const abstractAvailable = readBoolean(record.abstractAvailable)
    ?? (accessMode !== "metadata_only");
  const fulltextAvailable = readBoolean(record.fulltextAvailable)
    ?? (accessMode === "fulltext_open" || accessMode === "fulltext_licensed");

  return {
    abstractAvailable,
    fulltextAvailable,
    fulltextFetched: readBoolean(record.fulltextFetched) ?? false,
    fulltextExtracted: readBoolean(record.fulltextExtracted) ?? false
  };
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
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

function dedupeDiscoveryRecords(records: PaperDiscoveryRecord[]): PaperDiscoveryRecord[] {
  const seen = new Set<string>();
  const normalized: PaperDiscoveryRecord[] = [];

  for (const record of records) {
    const key = `${record.providerId}:${record.sourceId}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(record);
  }

  return normalized;
}

function dedupeAccessRecords(records: PaperAccessRecord[]): PaperAccessRecord[] {
  const seen = new Set<string>();
  const normalized: PaperAccessRecord[] = [];

  for (const record of records) {
    const key = `${record.providerId}:${record.url ?? "none"}:${record.accessMode}:${record.fulltextFormat}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(record);
  }

  return normalized;
}

function emptyLiteratureState(projectRoot: string, timestamp: string): LiteratureState {
  return {
    schemaVersion: literatureSchemaVersion,
    projectRoot,
    runtimeDirectory: runtimeDirectoryPath(projectRoot),
    literatureDirectory: literatureDirectoryPath(projectRoot),
    createdAt: timestamp,
    updatedAt: timestamp,
    paperCount: 0,
    themeCount: 0,
    notebookCount: 0,
    papers: [],
    themes: [],
    notebooks: []
  };
}

function normalizeCanonicalPaper(raw: unknown): CanonicalPaper | null {
  const record = asObject(raw);
  const key = readString(record.key);
  const title = readString(record.title);
  const citation = readString(record.citation);

  if (key === null || title === null || citation === null) {
    return null;
  }

  const accessMode = normalizeAccessMode(record.accessMode);

  return {
    id: readString(record.id) ?? createLiteratureEntityId("paper", key),
    key,
    title,
    citation,
    abstract: readString(record.abstract),
    year: readInteger(record.year),
    authors: readStringArray(record.authors),
    venue: readString(record.venue),
    discoveredVia: readStringArray(record.discoveredVia)
      .map((providerId) => normalizeProviderId(providerId))
      .flatMap((providerId) => providerId === null ? [] : [providerId]),
    identifiers: normalizeIdentifiers(record.identifiers),
    discoveryRecords: dedupeDiscoveryRecords(
      Array.isArray(record.discoveryRecords)
        ? record.discoveryRecords.flatMap((entry) => {
          const normalized = normalizeDiscoveryRecord(entry);
          return normalized === null ? [] : [normalized];
        })
        : []
    ),
    accessCandidates: dedupeAccessRecords(
      Array.isArray(record.accessCandidates)
        ? record.accessCandidates.flatMap((entry) => {
          const normalized = normalizeAccessRecord(entry);
          return normalized === null ? [] : [normalized];
        })
        : []
    ),
    bestAccessUrl: readString(record.bestAccessUrl),
    bestAccessProvider: normalizeProviderId(record.bestAccessProvider),
    accessMode,
    fulltextFormat: normalizeFulltextFormat(record.fulltextFormat),
    license: readString(record.license),
    tdmAllowed: readBoolean(record.tdmAllowed),
    contentStatus: normalizeContentStatus(record.contentStatus, accessMode),
    screeningStage: normalizeScreeningStage(record.screeningStage),
    screeningDecision: normalizeScreeningDecision(record.screeningDecision),
    screeningRationale: readString(record.screeningRationale),
    accessErrors: readStringArray(record.accessErrors),
    tags: readStringArray(record.tags),
    runIds: readStringArray(record.runIds),
    linkedThemeIds: readStringArray(record.linkedThemeIds),
    linkedClaimIds: readStringArray(record.linkedClaimIds),
    createdAt: readString(record.createdAt) ?? new Date().toISOString(),
    updatedAt: readString(record.updatedAt) ?? new Date().toISOString()
  };
}

function normalizeTheme(raw: unknown): LiteratureThemeBoard | null {
  const record = asObject(raw);
  const key = readString(record.key);
  const title = readString(record.title);
  const summary = readString(record.summary);

  if (key === null || title === null || summary === null) {
    return null;
  }

  return {
    id: readString(record.id) ?? createLiteratureEntityId("theme", key),
    key,
    title,
    summary,
    paperIds: readStringArray(record.paperIds),
    claimIds: readStringArray(record.claimIds),
    questionTexts: readStringArray(record.questionTexts),
    runIds: readStringArray(record.runIds),
    createdAt: readString(record.createdAt) ?? new Date().toISOString(),
    updatedAt: readString(record.updatedAt) ?? new Date().toISOString()
  };
}

function normalizeNotebook(raw: unknown): LiteratureReviewNotebook | null {
  const record = asObject(raw);
  const key = readString(record.key);
  const title = readString(record.title);
  const runId = readString(record.runId);
  const objective = readString(record.objective);
  const summary = readString(record.summary);

  if (
    key === null
    || title === null
    || runId === null
    || objective === null
    || summary === null
  ) {
    return null;
  }

  return {
    id: readString(record.id) ?? createLiteratureEntityId("notebook", key),
    key,
    title,
    runId,
    objective,
    summary,
    paperIds: readStringArray(record.paperIds),
    themeIds: readStringArray(record.themeIds),
    claimIds: readStringArray(record.claimIds),
    nextQuestions: readStringArray(record.nextQuestions),
    providerIds: readStringArray(record.providerIds)
      .map((providerId) => normalizeProviderId(providerId))
      .flatMap((providerId) => providerId === null ? [] : [providerId]),
    createdAt: readString(record.createdAt) ?? new Date().toISOString(),
    updatedAt: readString(record.updatedAt) ?? new Date().toISOString()
  };
}

function migrateLegacyPaper(raw: LegacyPaperCard): CanonicalPaper | null {
  const key = readString(raw.key);
  const title = readString(raw.title);
  const citation = readString(raw.citation);

  if (key === null || title === null || citation === null) {
    return null;
  }

  const providerId = normalizeProviderId(raw.providerId);
  const screeningDecision = raw.relevance === "rejected"
    ? "exclude"
    : raw.relevance === "background"
      ? "background"
      : "include";
  const screeningStage = raw.stage === "selected"
    ? "abstract"
    : raw.stage === "rejected"
      ? "title"
      : "title";
  const abstract = readString(raw.excerpt);
  const locator = readString(raw.locator);

  return {
    id: createLiteratureEntityId("paper", key),
    key,
    title,
    citation,
    abstract,
    year: null,
    authors: [],
    venue: null,
    discoveredVia: providerId === null ? [] : [providerId],
    identifiers: {
      doi: null,
      pmid: null,
      pmcid: null,
      arxivId: null
    },
    discoveryRecords: providerId === null ? [] : [{
      providerId,
      sourceId: key,
      title,
      locator,
      citation,
      year: null
    }],
    accessCandidates: providerId === null ? [] : [{
      providerId,
      url: locator,
      accessMode: "metadata_only",
      fulltextFormat: "none",
      license: null,
      tdmAllowed: null,
      note: "Migrated from a pre-canonical literature card."
    }],
    bestAccessUrl: locator,
    bestAccessProvider: providerId,
    accessMode: "metadata_only",
    fulltextFormat: "none",
    license: null,
    tdmAllowed: null,
    contentStatus: {
      abstractAvailable: abstract !== null,
      fulltextAvailable: false,
      fulltextFetched: false,
      fulltextExtracted: false
    },
    screeningStage,
    screeningDecision,
    screeningRationale: readString(raw.screeningRationale),
    accessErrors: [],
    tags: [],
    runIds: readStringArray(raw.runIds),
    linkedThemeIds: readStringArray(raw.linkedThemeIds),
    linkedClaimIds: readStringArray(raw.linkedClaimIds),
    createdAt: readString(raw.createdAt) ?? new Date().toISOString(),
    updatedAt: readString(raw.updatedAt) ?? new Date().toISOString()
  };
}

function mergeLiteratureState(raw: unknown, projectRoot: string, timestamp: string): LiteratureState {
  const record = asObject(raw);
  const base = emptyLiteratureState(projectRoot, timestamp);
  const legacySchema = (readInteger(record.schemaVersion) ?? 0) > 0
    && (readInteger(record.schemaVersion) ?? 0) < literatureSchemaVersion;
  const hasCanonicalPapers = !legacySchema;
  const papers = Array.isArray(record.papers)
    ? record.papers.flatMap((entry) => {
      const normalized = hasCanonicalPapers
        ? normalizeCanonicalPaper(entry)
        : migrateLegacyPaper(entry as LegacyPaperCard);
      return normalized === null ? [] : [normalized];
    })
    : [];
  const themes = Array.isArray(record.themes)
    ? record.themes.flatMap((entry) => {
      const normalized = normalizeTheme(entry);
      return normalized === null ? [] : [normalized];
    })
    : [];
  const notebooks = Array.isArray(record.notebooks)
    ? record.notebooks.flatMap((entry) => {
      const normalized = normalizeNotebook(entry);
      return normalized === null ? [] : [normalized];
    })
    : [];

  return {
    ...base,
    createdAt: readString(record.createdAt) ?? base.createdAt,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    paperCount: papers.length,
    themeCount: themes.length,
    notebookCount: notebooks.length,
    papers,
    themes,
    notebooks
  };
}

function normalizePaperInput(input: CanonicalPaperInput): CanonicalPaperInput {
  return {
    ...input,
    key: normalizeWhitespace(input.key),
    title: normalizeWhitespace(input.title),
    citation: normalizeWhitespace(input.citation),
    abstract: readString(input.abstract),
    authors: dedupeStrings(input.authors ?? []),
    venue: readString(input.venue),
    discoveredVia: dedupeStrings(input.discoveredVia ?? [])
      .map((providerId) => normalizeProviderId(providerId))
      .flatMap((providerId) => providerId === null ? [] : [providerId]),
    identifiers: input.identifiers ?? {},
    discoveryRecords: dedupeDiscoveryRecords(input.discoveryRecords ?? []),
    accessCandidates: dedupeAccessRecords(input.accessCandidates ?? []),
    bestAccessUrl: readString(input.bestAccessUrl),
    bestAccessProvider: input.bestAccessProvider ?? null,
    license: readString(input.license),
    accessErrors: readStringArray(input.accessErrors ?? []),
    tags: readStringArray(input.tags ?? []),
    linkedThemeIds: readStringArray(input.linkedThemeIds ?? []),
    linkedClaimIds: readStringArray(input.linkedClaimIds ?? [])
  };
}

function mergeIdentifiers(
  existing: PaperIdentifiers,
  incoming: Partial<PaperIdentifiers> | undefined
): PaperIdentifiers {
  return {
    doi: readString(incoming?.doi) ?? existing.doi,
    pmid: readString(incoming?.pmid) ?? existing.pmid,
    pmcid: readString(incoming?.pmcid) ?? existing.pmcid,
    arxivId: readString(incoming?.arxivId) ?? existing.arxivId
  };
}

function mergeContentStatus(
  existing: PaperContentStatus,
  incoming: Partial<PaperContentStatus> | undefined,
  accessMode: PaperAccessMode
): PaperContentStatus {
  return {
    abstractAvailable: incoming?.abstractAvailable ?? existing.abstractAvailable ?? (accessMode !== "metadata_only"),
    fulltextAvailable: incoming?.fulltextAvailable ?? existing.fulltextAvailable ?? (accessMode === "fulltext_open" || accessMode === "fulltext_licensed"),
    fulltextFetched: incoming?.fulltextFetched ?? existing.fulltextFetched,
    fulltextExtracted: incoming?.fulltextExtracted ?? existing.fulltextExtracted
  };
}

function mergePaper(
  existing: CanonicalPaper | undefined,
  input: CanonicalPaperInput,
  timestamp: string
): CanonicalPaper {
  const normalized = normalizePaperInput(input);
  const id = createLiteratureEntityId("paper", normalized.key);
  const accessMode = normalized.accessMode ?? existing?.accessMode ?? "metadata_only";
  const screeningStage = normalized.screeningStage ?? existing?.screeningStage ?? "title";
  const screeningDecision = normalized.screeningDecision ?? existing?.screeningDecision ?? "uncertain";

  return {
    id,
    key: normalized.key,
    title: normalized.title,
    citation: normalized.citation,
    abstract: normalized.abstract ?? existing?.abstract ?? null,
    year: normalized.year ?? existing?.year ?? null,
    authors: dedupeStrings([...(existing?.authors ?? []), ...(normalized.authors ?? [])]),
    venue: normalized.venue ?? existing?.venue ?? null,
    discoveredVia: dedupeStrings([
      ...(existing?.discoveredVia ?? []),
      ...(normalized.discoveredVia ?? []),
      ...(normalized.discoveryRecords ?? []).map((record) => record.providerId)
    ]).map((providerId) => normalizeProviderId(providerId)).flatMap((providerId) => providerId === null ? [] : [providerId]),
    identifiers: mergeIdentifiers(existing?.identifiers ?? {
      doi: null,
      pmid: null,
      pmcid: null,
      arxivId: null
    }, normalized.identifiers),
    discoveryRecords: dedupeDiscoveryRecords([
      ...(existing?.discoveryRecords ?? []),
      ...(normalized.discoveryRecords ?? [])
    ]),
    accessCandidates: dedupeAccessRecords([
      ...(existing?.accessCandidates ?? []),
      ...(normalized.accessCandidates ?? [])
    ]),
    bestAccessUrl: normalized.bestAccessUrl ?? existing?.bestAccessUrl ?? null,
    bestAccessProvider: normalized.bestAccessProvider ?? existing?.bestAccessProvider ?? null,
    accessMode,
    fulltextFormat: normalized.fulltextFormat ?? existing?.fulltextFormat ?? "none",
    license: normalized.license ?? existing?.license ?? null,
    tdmAllowed: normalized.tdmAllowed ?? existing?.tdmAllowed ?? null,
    contentStatus: mergeContentStatus(existing?.contentStatus ?? {
      abstractAvailable: normalized.abstract !== null,
      fulltextAvailable: accessMode === "fulltext_open" || accessMode === "fulltext_licensed",
      fulltextFetched: false,
      fulltextExtracted: false
    }, normalized.contentStatus, accessMode),
    screeningStage,
    screeningDecision,
    screeningRationale: normalized.screeningRationale ?? existing?.screeningRationale ?? null,
    accessErrors: dedupeStrings([...(existing?.accessErrors ?? []), ...(normalized.accessErrors ?? [])]),
    tags: dedupeStrings([...(existing?.tags ?? []), ...(normalized.tags ?? [])]),
    runIds: dedupeStrings([...(existing?.runIds ?? []), normalized.runId]),
    linkedThemeIds: dedupeStrings([...(existing?.linkedThemeIds ?? []), ...(normalized.linkedThemeIds ?? [])]),
    linkedClaimIds: dedupeStrings([...(existing?.linkedClaimIds ?? []), ...(normalized.linkedClaimIds ?? [])]),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function mergeTheme(
  existing: LiteratureThemeBoard | undefined,
  input: LiteratureThemeInput,
  timestamp: string
): LiteratureThemeBoard {
  const key = normalizeWhitespace(input.key);

  return {
    id: createLiteratureEntityId("theme", key),
    key,
    title: normalizeWhitespace(input.title),
    summary: normalizeWhitespace(input.summary),
    paperIds: dedupeStrings([...(existing?.paperIds ?? []), ...input.paperIds]),
    claimIds: dedupeStrings([...(existing?.claimIds ?? []), ...(input.claimIds ?? [])]),
    questionTexts: dedupeStrings([...(existing?.questionTexts ?? []), ...(input.questionTexts ?? [])]),
    runIds: dedupeStrings([...(existing?.runIds ?? []), input.runId]),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function mergeNotebook(
  existing: LiteratureReviewNotebook | undefined,
  input: LiteratureNotebookInput,
  timestamp: string
): LiteratureReviewNotebook {
  const key = normalizeWhitespace(input.key);

  return {
    id: createLiteratureEntityId("notebook", key),
    key,
    title: normalizeWhitespace(input.title),
    runId: input.runId,
    objective: normalizeWhitespace(input.objective),
    summary: normalizeWhitespace(input.summary),
    paperIds: dedupeStrings([...(existing?.paperIds ?? []), ...input.paperIds]),
    themeIds: dedupeStrings([...(existing?.themeIds ?? []), ...input.themeIds]),
    claimIds: dedupeStrings([...(existing?.claimIds ?? []), ...input.claimIds]),
    nextQuestions: dedupeStrings([...(existing?.nextQuestions ?? []), ...input.nextQuestions]),
    providerIds: dedupeStrings([...(existing?.providerIds ?? []), ...input.providerIds])
      .map((providerId) => normalizeProviderId(providerId))
      .flatMap((providerId) => providerId === null ? [] : [providerId]),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

export function buildLiteratureContext(
  state: LiteratureState,
  brief: ResearchBrief
): LiteratureContext {
  const referenceTokens = new Set([
    ...(brief.topic === null ? [] : tokenize(brief.topic)),
    ...(brief.researchQuestion === null ? [] : tokenize(brief.researchQuestion)),
    ...(brief.researchDirection === null ? [] : tokenize(brief.researchDirection))
  ]);
  const rankedPapers = [...state.papers]
    .sort((left, right) => {
      const leftScore = overlapScore(`${left.title} ${left.abstract ?? ""}`, referenceTokens);
      const rightScore = overlapScore(`${right.title} ${right.abstract ?? ""}`, referenceTokens);
      return rightScore - leftScore || right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, 8);
  const rankedThemes = [...state.themes]
    .sort((left, right) => {
      const leftScore = overlapScore(`${left.title} ${left.summary}`, referenceTokens);
      const rightScore = overlapScore(`${right.title} ${right.summary}`, referenceTokens);
      return rightScore - leftScore || right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, 6);
  const rankedNotebooks = [...state.notebooks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 4);
  const queryHints = dedupeStrings([
    ...rankedThemes.flatMap((theme) => [theme.title, ...theme.questionTexts]),
    ...rankedNotebooks.flatMap((notebook) => notebook.nextQuestions),
    ...rankedPapers.map((paper) => paper.title)
  ]).slice(0, 12);

  return {
    available: state.paperCount > 0 || state.themeCount > 0 || state.notebookCount > 0,
    paperCount: state.paperCount,
    themeCount: state.themeCount,
    notebookCount: state.notebookCount,
    papers: rankedPapers.map((paper) => ({
      id: paper.id,
      title: paper.title,
      citation: paper.citation,
      abstract: paper.abstract,
      bestAccessUrl: paper.bestAccessUrl,
      accessMode: paper.accessMode,
      screeningDecision: paper.screeningDecision,
      screeningStage: paper.screeningStage,
      linkedThemeIds: paper.linkedThemeIds
    })),
    themes: rankedThemes.map((theme) => ({
      id: theme.id,
      title: theme.title,
      summary: theme.summary,
      paperIds: theme.paperIds
    })),
    notebooks: rankedNotebooks.map((notebook) => ({
      id: notebook.id,
      title: notebook.title,
      summary: notebook.summary,
      nextQuestions: notebook.nextQuestions
    })),
    queryHints
  };
}

export class LiteratureStore {
  constructor(
    public readonly projectRoot: string,
    private readonly timestampFactory: () => string = () => new Date().toISOString()
  ) {}

  get filePath(): string {
    return literatureStoreFilePath(this.projectRoot);
  }

  async load(): Promise<LiteratureState> {
    const timestamp = this.timestampFactory();

    try {
      const contents = await readFile(this.filePath, "utf8");
      return mergeLiteratureState(JSON.parse(contents) as unknown, this.projectRoot, timestamp);
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

      if (!missing) {
        throw error;
      }

      return emptyLiteratureState(this.projectRoot, timestamp);
    }
  }

  async save(state: LiteratureState): Promise<LiteratureState> {
    const timestamp = this.timestampFactory();
    const normalized = mergeLiteratureState(state, this.projectRoot, timestamp);
    const output: LiteratureState = {
      ...normalized,
      schemaVersion: literatureSchemaVersion,
      projectRoot: this.projectRoot,
      runtimeDirectory: runtimeDirectoryPath(this.projectRoot),
      literatureDirectory: literatureDirectoryPath(this.projectRoot),
      updatedAt: timestamp,
      paperCount: normalized.papers.length,
      themeCount: normalized.themes.length,
      notebookCount: normalized.notebooks.length
    };

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    return output;
  }

  async upsert(batch: LiteratureUpsertBatch): Promise<LiteratureUpsertResult> {
    const timestamp = this.timestampFactory();
    const state = await this.load();
    const paperMap = new Map(state.papers.map((paper) => [paper.id, paper]));
    const themeMap = new Map(state.themes.map((theme) => [theme.id, theme]));
    const notebookMap = new Map(state.notebooks.map((notebook) => [notebook.id, notebook]));
    let insertedPapers = 0;
    let updatedPapers = 0;
    let insertedThemes = 0;
    let updatedThemes = 0;
    let insertedNotebooks = 0;
    let updatedNotebooks = 0;
    const resultPapers: CanonicalPaper[] = [];
    const resultThemes: LiteratureThemeBoard[] = [];
    const resultNotebooks: LiteratureReviewNotebook[] = [];

    for (const input of batch.papers ?? []) {
      const id = createLiteratureEntityId("paper", input.key);
      const existing = paperMap.get(id);
      const merged = mergePaper(existing, input, timestamp);
      paperMap.set(id, merged);
      resultPapers.push(merged);
      if (existing === undefined) {
        insertedPapers += 1;
      } else {
        updatedPapers += 1;
      }
    }

    for (const input of batch.themes ?? []) {
      const id = createLiteratureEntityId("theme", input.key);
      const existing = themeMap.get(id);
      const merged = mergeTheme(existing, input, timestamp);
      themeMap.set(id, merged);
      resultThemes.push(merged);
      if (existing === undefined) {
        insertedThemes += 1;
      } else {
        updatedThemes += 1;
      }
    }

    for (const input of batch.notebooks ?? []) {
      const id = createLiteratureEntityId("notebook", input.key);
      const existing = notebookMap.get(id);
      const merged = mergeNotebook(existing, input, timestamp);
      notebookMap.set(id, merged);
      resultNotebooks.push(merged);
      if (existing === undefined) {
        insertedNotebooks += 1;
      } else {
        updatedNotebooks += 1;
      }
    }

    const nextState = await this.save({
      ...state,
      schemaVersion: literatureSchemaVersion,
      projectRoot: this.projectRoot,
      runtimeDirectory: runtimeDirectoryPath(this.projectRoot),
      literatureDirectory: literatureDirectoryPath(this.projectRoot),
      updatedAt: timestamp,
      paperCount: paperMap.size,
      themeCount: themeMap.size,
      notebookCount: notebookMap.size,
      papers: [...paperMap.values()],
      themes: [...themeMap.values()],
      notebooks: [...notebookMap.values()]
    });

    return {
      inserted: {
        papers: insertedPapers,
        themes: insertedThemes,
        notebooks: insertedNotebooks
      },
      updated: {
        papers: updatedPapers,
        themes: updatedThemes,
        notebooks: updatedNotebooks
      },
      state: nextState,
      papers: resultPapers,
      themes: resultThemes,
      notebooks: resultNotebooks
    };
  }
}
