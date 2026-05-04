import { access, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { CanonicalPaper, LiteratureContext } from "./literature-store.js";
import type { ProjectMemoryContext, MemoryRecordType } from "./memory-store.js";
import type { ReviewProtocol } from "./research-manuscript.js";
import type { ResearchPlan } from "./research-backend.js";
import type { CriticReviewArtifact, CriticReviewScope } from "./research-critic.js";
import type { EvidenceMatrixRow, PaperExtraction } from "./research-evidence.js";
import type { ResearchSource, ResearchSourceSnapshot } from "./research-sources.js";
import type { ResearchBrief } from "./session-store.js";
import { runtimeDirectoryPath as runtimeDir } from "./session-store.js";
import type { RunRecord } from "./run-store.js";

const require = createRequire(import.meta.url);

const workStoreSchemaVersion = 2;
const workspaceDatabaseFileName = "workspace.sqlite";
const legacyWorkStoreFileName = "research-work-store.json";

export type WorkStoreEntityKind =
  | "providerRun"
  | "source"
  | "canonicalSource"
  | "screeningDecision"
  | "fullTextRecord"
  | "extraction"
  | "evidenceCell"
  | "claim"
  | "citation"
  | "protocol"
  | "workItem"
  | "manuscriptSection"
  | "releaseCheck";

export type WorkStoreCollectionName =
  | "providerRuns"
  | "sources"
  | "canonicalSources"
  | "screeningDecisions"
  | "fullTextRecords"
  | "extractions"
  | "evidenceCells"
  | "claims"
  | "citations"
  | "protocols"
  | "workItems"
  | "manuscriptSections"
  | "releaseChecks";

export type WorkItemType =
  | "critic_objection"
  | "evidence_gap"
  | "unsupported_claim"
  | "source_access"
  | "manuscript_revision"
  | "external_blocker"
  | "open_question"
  | "agent_next_action"
  | "user_decision";

export type WorkItemStatus =
  | "open"
  | "in_progress"
  | "resolved"
  | "abandoned";

export type WorkItemSeverity =
  | "blocking"
  | "major"
  | "minor";

export type ResearchWorkerStatus =
  | "not_started"
  | "working"
  | "checkpointed_budget_exhausted"
  | "paused"
  | "release_ready"
  | "needs_user_decision"
  | "externally_blocked";

export type WorkStoreBaseEntity = {
  id: string;
  kind: WorkStoreEntityKind;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkStoreProviderRun = WorkStoreBaseEntity & {
  kind: "providerRun";
  providerId: string;
  phase: string;
  query: string | null;
  providerCalls: number;
  rawCandidateCount: number;
  acceptedSourceCount: number;
  error: string | null;
};

export type WorkStoreSource = WorkStoreBaseEntity & {
  kind: "source";
  providerId: string | null;
  category: string;
  sourceKind: string;
  title: string;
  locator: string | null;
  citation: string;
  excerpt: string;
};

export type WorkStoreCanonicalSource = WorkStoreBaseEntity & {
  kind: "canonicalSource";
  key: string;
  title: string;
  citation: string;
  abstract: string | null;
  year: number | null;
  authors: string[];
  venue: string | null;
  providerIds: string[];
  identifiers: Record<string, string | null>;
  accessMode: string;
  bestAccessUrl: string | null;
  screeningDecision: string;
  screeningRationale: string | null;
  tags: string[];
};

export type WorkStoreScreeningDecision = WorkStoreBaseEntity & {
  kind: "screeningDecision";
  sourceId: string;
  stage: string;
  decision: string;
  rationale: string | null;
};

export type WorkStoreFullTextRecord = WorkStoreBaseEntity & {
  kind: "fullTextRecord";
  sourceId: string;
  accessMode: string;
  format: string;
  url: string | null;
  providerId: string | null;
  fulltextAvailable: boolean;
  fulltextFetched: boolean;
  fulltextExtracted: boolean;
  errors: string[];
};

export type WorkStoreExtraction = WorkStoreBaseEntity & {
  kind: "extraction";
  sourceId: string;
  extraction: PaperExtraction;
};

export type WorkStoreEvidenceCell = WorkStoreBaseEntity & {
  kind: "evidenceCell";
  sourceId: string;
  extractionId: string;
  field: keyof Pick<
    EvidenceMatrixRow,
    | "problemSetting"
    | "systemType"
    | "architecture"
    | "toolsAndMemory"
    | "planningStyle"
    | "evaluationSetup"
    | "successSignals"
    | "failureModes"
    | "limitations"
    | "confidence"
  >;
  value: string | string[];
  confidence: string;
};

export type WorkStoreClaim = WorkStoreBaseEntity & {
  kind: "claim";
  text: string;
  evidence: string;
  sourceIds: string[];
  supportStatus: string;
  confidence: string;
  usedInSections: string[];
  risk: string | null;
};

export type WorkStoreCitation = WorkStoreBaseEntity & {
  kind: "citation";
  sourceId: string;
  sourceTitle: string;
  evidenceCellId: string | null;
  supportSnippet: string;
  confidence: string | null;
  relevance: string | null;
  claimIds: string[];
  sectionIds: string[];
};

export type WorkStoreProtocol = WorkStoreBaseEntity & {
  kind: "protocol";
  protocolId: string;
  title: string;
  objective: string;
  researchQuestion: string | null;
  scope: string[];
  inclusionCriteria: string[];
  exclusionCriteria: string[];
  evidenceTargets: string[];
  manuscriptConstraints: string[];
  notes: string[];
  protocol: ReviewProtocol | Record<string, unknown> | null;
  author: "researcher" | "runtime";
};

export type WorkStoreWorkItem = WorkStoreBaseEntity & {
  kind: "workItem";
  type: WorkItemType;
  status: WorkItemStatus;
  severity: WorkItemSeverity;
  title: string;
  description: string;
  targetKind: WorkStoreEntityKind | "protocol" | "brief" | "release" | "agenda" | "unknown";
  targetId: string | null;
  affectedSourceIds: string[];
  affectedClaimIds: string[];
  suggestedActions: string[];
  source: "critic" | "checks" | "runtime";
};

export type WorkStoreManuscriptSection = WorkStoreBaseEntity & {
  kind: "manuscriptSection";
  sectionId: string;
  role: string;
  title: string;
  markdown: string;
  sourceIds: string[];
  claimIds: string[];
  status: "draft" | "needs_revision" | "checked";
};

export type WorkStoreReleaseCheck = WorkStoreBaseEntity & {
  kind: "releaseCheck";
  checkId: string;
  title: string;
  status: string;
  severity: string;
  message: string;
};

export type WorkStoreEntity =
  | WorkStoreProviderRun
  | WorkStoreSource
  | WorkStoreCanonicalSource
  | WorkStoreScreeningDecision
  | WorkStoreFullTextRecord
  | WorkStoreExtraction
  | WorkStoreEvidenceCell
  | WorkStoreClaim
  | WorkStoreCitation
  | WorkStoreProtocol
  | WorkStoreWorkItem
  | WorkStoreManuscriptSection
  | WorkStoreReleaseCheck;

export type ResearchWorkStoreWorker = {
  status: ResearchWorkerStatus;
  activeRunId: string | null;
  lastRunId: string | null;
  segmentCount: number;
  updatedAt: string;
  statusReason: string;
  paperReadiness: string | null;
  nextInternalActions: string[];
  userBlockers: string[];
  evidence: {
    canonicalPapers: number;
    includedPapers: number;
    explicitlySelectedEvidencePapers: number;
    selectedPapers: number;
    extractedPapers: number;
    evidenceRows: number;
    referencedPapers: number;
  } | null;
};

export type ResearchWorkStoreObjects = {
  providerRuns: WorkStoreProviderRun[];
  sources: WorkStoreSource[];
  canonicalSources: WorkStoreCanonicalSource[];
  screeningDecisions: WorkStoreScreeningDecision[];
  fullTextRecords: WorkStoreFullTextRecord[];
  extractions: WorkStoreExtraction[];
  evidenceCells: WorkStoreEvidenceCell[];
  claims: WorkStoreClaim[];
  citations: WorkStoreCitation[];
  protocols: WorkStoreProtocol[];
  workItems: WorkStoreWorkItem[];
  manuscriptSections: WorkStoreManuscriptSection[];
  releaseChecks: WorkStoreReleaseCheck[];
};

export type ResearchWorkStore = {
  schemaVersion: 2;
  projectRoot: string;
  runtimeDirectory: string;
  createdAt: string;
  updatedAt: string;
  brief: ResearchBrief;
  worker: ResearchWorkStoreWorker;
  objects: ResearchWorkStoreObjects;
};

export type WorkStoreFilter = Record<string, string | number | boolean | null>;

export type WorkStoreQuery = {
  collection: WorkStoreCollectionName;
  filters?: WorkStoreFilter;
  semanticQuery?: string | null;
  limit?: number;
  cursor?: string | null;
};

export type WorkStoreQueryResult<T extends WorkStoreEntity = WorkStoreEntity> = {
  collection: WorkStoreCollectionName;
  count: number;
  totalCount: number;
  cursor: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  items: T[];
};

export type WorkStoreCreateInput<T extends WorkStoreEntity = WorkStoreEntity> = Omit<T, "createdAt" | "updatedAt"> & {
  createdAt?: string;
  updatedAt?: string;
};

export type WorkStorePatch = {
  collection: WorkStoreCollectionName;
  id: string;
  changes: Record<string, unknown>;
};

type SqliteStatement = {
  run: (...values: unknown[]) => unknown;
  all: (...values: unknown[]) => Array<Record<string, unknown>>;
  get: (...values: unknown[]) => Record<string, unknown> | undefined;
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

function databaseConstructor(): new (filename: string) => SqliteDatabase {
  return (require("node:sqlite") as {
    DatabaseSync: new (filename: string) => SqliteDatabase;
  }).DatabaseSync;
}

function openWorkspaceDatabase(projectRoot: string): SqliteDatabase {
  const DatabaseSync = databaseConstructor();
  const database = new DatabaseSync(researchWorkStoreFilePath(projectRoot));
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }

  try {
    return asObject(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function ensureWorkspaceSchema(database: SqliteDatabase): void {
  database.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_state (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  title TEXT NOT NULL,
  citation TEXT NOT NULL,
  abstract TEXT,
  year INTEGER,
  venue TEXT,
  screening_decision TEXT,
  access_mode TEXT,
  best_access_url TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  run_id TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_cells (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  extraction_id TEXT NOT NULL,
  run_id TEXT,
  field TEXT NOT NULL,
  confidence TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  text TEXT NOT NULL,
  evidence TEXT NOT NULL,
  support_status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  risk TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_links (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  source_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS protocols (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  protocol_id TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manuscript_sections (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  section_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS section_claims (
  section_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (section_id, claim_id)
);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  check_id TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  event_type TEXT NOT NULL,
  entity_kind TEXT,
  entity_id TEXT,
  message TEXT NOT NULL,
  json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_search ON sources(title, citation, venue, screening_decision);
CREATE INDEX IF NOT EXISTS idx_extractions_source ON extractions(source_id);
CREATE INDEX IF NOT EXISTS idx_evidence_cells_source ON evidence_cells(source_id, extraction_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(support_status);
CREATE INDEX IF NOT EXISTS idx_protocols_protocol_id ON protocols(protocol_id);
CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status, severity);
CREATE INDEX IF NOT EXISTS idx_section_claims_claim ON section_claims(claim_id);
`);
}

function createEmptyBrief(): ResearchBrief {
  return {
    topic: null,
    researchQuestion: null,
    researchDirection: null,
    successCriterion: null
  };
}

function createEmptyObjects(): ResearchWorkStoreObjects {
  return {
    providerRuns: [],
    sources: [],
    canonicalSources: [],
    screeningDecisions: [],
    fullTextRecords: [],
    extractions: [],
    evidenceCells: [],
    claims: [],
    citations: [],
    protocols: [],
    workItems: [],
    manuscriptSections: [],
    releaseChecks: []
  };
}

function createEmptyWorker(now: string): ResearchWorkStoreWorker {
  return {
    status: "not_started",
    activeRunId: null,
    lastRunId: null,
    segmentCount: 0,
    updatedAt: now,
    statusReason: "No autonomous research worker segment has started yet.",
    paperReadiness: null,
    nextInternalActions: [],
    userBlockers: [],
    evidence: null
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringArray(value: unknown, limit = 100): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => readString(entry) ?? []).slice(0, limit)
    : [];
}

function readBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  return readString(value) ?? fallback;
}

function normalizeBrief(value: unknown): ResearchBrief {
  const record = asObject(value);
  return {
    topic: readString(record.topic),
    researchQuestion: readString(record.researchQuestion),
    researchDirection: readString(record.researchDirection),
    successCriterion: readString(record.successCriterion)
  };
}

function normalizeWorker(value: unknown, now: string): ResearchWorkStoreWorker {
  const base = createEmptyWorker(now);
  const record = asObject(value);
  const status = readString(record.status);
  return {
    status: isResearchWorkerStatus(status) ? status : base.status,
    activeRunId: readString(record.activeRunId),
    lastRunId: readString(record.lastRunId),
    segmentCount: readNumber(record.segmentCount),
    updatedAt: normalizeTimestamp(record.updatedAt, now),
    statusReason: readString(record.statusReason) ?? base.statusReason,
    paperReadiness: readString(record.paperReadiness),
    nextInternalActions: readStringArray(record.nextInternalActions, 40),
    userBlockers: readStringArray(record.userBlockers, 40),
    evidence: normalizeWorkerEvidence(record.evidence)
  };
}

function normalizeWorkerEvidence(value: unknown): ResearchWorkStoreWorker["evidence"] {
  const record = asObject(value);
  if (Object.keys(record).length === 0) {
    return null;
  }

  const explicitlySelectedEvidencePapers = readNumber(record.explicitlySelectedEvidencePapers);
  return {
    canonicalPapers: readNumber(record.canonicalPapers),
    includedPapers: readNumber(record.includedPapers),
    explicitlySelectedEvidencePapers,
    selectedPapers: readNumber(record.selectedPapers) || explicitlySelectedEvidencePapers,
    extractedPapers: readNumber(record.extractedPapers),
    evidenceRows: readNumber(record.evidenceRows),
    referencedPapers: readNumber(record.referencedPapers)
  };
}

function isResearchWorkerStatus(value: string | null): value is ResearchWorkerStatus {
  switch (value) {
    case "not_started":
    case "working":
    case "checkpointed_budget_exhausted":
    case "paused":
    case "release_ready":
    case "needs_user_decision":
    case "externally_blocked":
      return true;
    default:
      return false;
  }
}

function normalizeEntityArray<T extends WorkStoreEntity>(
  value: unknown,
  kind: WorkStoreEntityKind
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = asObject(entry);
    return record.kind === kind && readString(record.id) !== null ? [record as T] : [];
  });
}

function normalizeObjects(value: unknown): ResearchWorkStoreObjects {
  const record = asObject(value);
  return {
    providerRuns: normalizeEntityArray(record.providerRuns, "providerRun"),
    sources: normalizeEntityArray(record.sources, "source"),
    canonicalSources: normalizeEntityArray(record.canonicalSources, "canonicalSource"),
    screeningDecisions: normalizeEntityArray(record.screeningDecisions, "screeningDecision"),
    fullTextRecords: normalizeEntityArray(record.fullTextRecords, "fullTextRecord"),
    extractions: normalizeEntityArray(record.extractions, "extraction"),
    evidenceCells: normalizeEntityArray(record.evidenceCells, "evidenceCell"),
    claims: normalizeEntityArray(record.claims, "claim"),
    citations: normalizeEntityArray(record.citations, "citation"),
    protocols: normalizeEntityArray(record.protocols, "protocol"),
    workItems: normalizeEntityArray(record.workItems, "workItem"),
    manuscriptSections: normalizeEntityArray(record.manuscriptSections, "manuscriptSection"),
    releaseChecks: normalizeEntityArray(record.releaseChecks, "releaseCheck")
  };
}

function hashString(text: string): string {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[], limit = 100): string[] {
  return [...new Set(values.map(compactText).filter((value) => value.length > 0))].slice(0, limit);
}

function stableId(prefix: string, parts: Array<string | number | null | undefined>): string {
  return `${prefix}-${hashString(parts.map((part) => String(part ?? "")).join(":"))}`;
}

function collectionFor(store: ResearchWorkStore, collection: WorkStoreCollectionName): WorkStoreEntity[] {
  return store.objects[collection] as WorkStoreEntity[];
}

function setCollection(
  store: ResearchWorkStore,
  collection: WorkStoreCollectionName,
  items: WorkStoreEntity[]
): ResearchWorkStore {
  return {
    ...store,
    objects: {
      ...store.objects,
      [collection]: items
    } as ResearchWorkStoreObjects
  };
}

function collectionNameForKind(kind: WorkStoreEntityKind): WorkStoreCollectionName {
  switch (kind) {
    case "providerRun":
      return "providerRuns";
    case "source":
      return "sources";
    case "canonicalSource":
      return "canonicalSources";
    case "screeningDecision":
      return "screeningDecisions";
    case "fullTextRecord":
      return "fullTextRecords";
    case "extraction":
      return "extractions";
    case "evidenceCell":
      return "evidenceCells";
    case "claim":
      return "claims";
    case "citation":
      return "citations";
    case "protocol":
      return "protocols";
    case "workItem":
      return "workItems";
    case "manuscriptSection":
      return "manuscriptSections";
    case "releaseCheck":
      return "releaseChecks";
  }
}

function entityText(entity: WorkStoreEntity): string {
  return JSON.stringify(entity).toLowerCase();
}

const semanticStopWords = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "because",
  "before",
  "between",
  "could",
  "evidence",
  "from",
  "have",
  "into",
  "more",
  "paper",
  "papers",
  "research",
  "source",
  "sources",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "with",
  "work"
]);

function semanticTerms(semanticQuery: string | null | undefined): string[] {
  const query = compactText(semanticQuery ?? "").toLowerCase();
  if (query.length === 0) {
    return [];
  }

  return uniqueStrings(
    query.split(/[^a-z0-9]+/i)
      .map((term) => term.toLowerCase())
      .filter((term) => term.length >= 3 && !semanticStopWords.has(term)),
    30
  );
}

function semanticScore(entity: WorkStoreEntity, terms: string[]): number {
  if (terms.length === 0) {
    return 1;
  }

  const haystack = entityText(entity);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function valueAtPath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((current, part) => (
    typeof current === "object" && current !== null
      ? (current as Record<string, unknown>)[part]
      : undefined
  ), value);
}

function matchesFilters(entity: WorkStoreEntity, filters: WorkStoreFilter | undefined): boolean {
  if (filters === undefined) {
    return true;
  }

  return Object.entries(filters).every(([field, expected]) => {
    const actual = valueAtPath(entity, field);
    if (Array.isArray(actual)) {
      return actual.includes(expected);
    }

    return actual === expected;
  });
}

export function researchWorkStoreFilePath(projectRoot: string): string {
  return path.join(runtimeDir(projectRoot), workspaceDatabaseFileName);
}

function legacyResearchWorkStoreFilePath(projectRoot: string): string {
  return path.join(runtimeDir(projectRoot), legacyWorkStoreFileName);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createResearchWorkStore(input: {
  projectRoot: string;
  brief?: ResearchBrief | null;
  now: string;
}): ResearchWorkStore {
  return {
    schemaVersion: workStoreSchemaVersion,
    projectRoot: input.projectRoot,
    runtimeDirectory: runtimeDir(input.projectRoot),
    createdAt: input.now,
    updatedAt: input.now,
    brief: input.brief ?? createEmptyBrief(),
    worker: createEmptyWorker(input.now),
    objects: createEmptyObjects()
  };
}

function statementRows<T>(database: SqliteDatabase, sql: string, ...values: unknown[]): T[] {
  return database.prepare(sql).all(...values) as T[];
}

function rowJsonEntity<T extends WorkStoreEntity>(row: Record<string, unknown>, fallbackKind: WorkStoreEntityKind): T | null {
  const entity = parseJsonValue<WorkStoreEntity | null>(row.json, null);
  if (entity === null || entity.kind !== fallbackKind || readString(entity.id) === null) {
    return null;
  }

  return entity as T;
}

function generatedScreeningDecision(source: WorkStoreCanonicalSource): WorkStoreScreeningDecision | null {
  if (source.screeningDecision.length === 0 && source.screeningRationale === null) {
    return null;
  }

  return {
    id: stableId("screening", [source.id, "current"]),
    kind: "screeningDecision",
    runId: source.runId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    sourceId: source.id,
    stage: "current",
    decision: source.screeningDecision,
    rationale: source.screeningRationale
  };
}

function generatedFullTextRecord(source: WorkStoreCanonicalSource): WorkStoreFullTextRecord {
  return {
    id: stableId("fulltext", [source.id]),
    kind: "fullTextRecord",
    runId: source.runId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    sourceId: source.id,
    accessMode: source.accessMode,
    format: "unknown",
    url: source.bestAccessUrl,
    providerId: source.providerIds[0] ?? null,
    fulltextAvailable: source.accessMode === "fulltext" || source.bestAccessUrl !== null,
    fulltextFetched: false,
    fulltextExtracted: false,
    errors: []
  };
}

function loadWorkspaceDatabase(input: {
  projectRoot: string;
  brief?: ResearchBrief | null;
  now: string;
}): ResearchWorkStore {
  const database = openWorkspaceDatabase(input.projectRoot);
  try {
    ensureWorkspaceSchema(database);
    const metaRows = statementRows<{ key: string; value: string }>(database, "SELECT key, value FROM meta");
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    const workerRow = database.prepare("SELECT json FROM worker_state WHERE id = 'current'").get();
    const sources = statementRows<Record<string, unknown>>(database, "SELECT json FROM sources ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreCanonicalSource>(row, "canonicalSource") ?? []);
    const extractions = statementRows<Record<string, unknown>>(database, "SELECT json FROM extractions ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreExtraction>(row, "extraction") ?? []);
    const evidenceCells = statementRows<Record<string, unknown>>(database, "SELECT json FROM evidence_cells ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreEvidenceCell>(row, "evidenceCell") ?? []);
    const claims = statementRows<Record<string, unknown>>(database, "SELECT json FROM claims ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreClaim>(row, "claim") ?? []);
    const citations = statementRows<Record<string, unknown>>(database, "SELECT json FROM support_links ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreCitation>(row, "citation") ?? []);
    const protocols = statementRows<Record<string, unknown>>(database, "SELECT json FROM protocols ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreProtocol>(row, "protocol") ?? []);
    const manuscriptSections = statementRows<Record<string, unknown>>(database, "SELECT json FROM manuscript_sections ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreManuscriptSection>(row, "manuscriptSection") ?? []);
    const workItems = statementRows<Record<string, unknown>>(database, "SELECT json FROM work_items ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreWorkItem>(row, "workItem") ?? []);
    const releaseChecks = statementRows<Record<string, unknown>>(database, "SELECT json FROM checks ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreReleaseCheck>(row, "releaseCheck") ?? []);
    const providerRunRows = statementRows<Record<string, unknown>>(database, "SELECT json FROM events WHERE entity_kind = 'providerRun' ORDER BY id");
    const providerRuns = providerRunRows.flatMap((row) => rowJsonEntity<WorkStoreProviderRun>(row, "providerRun") ?? []);
    const sourceRows = statementRows<Record<string, unknown>>(database, "SELECT json FROM events WHERE entity_kind = 'source' ORDER BY id");
    const rawSources = sourceRows.flatMap((row) => rowJsonEntity<WorkStoreSource>(row, "source") ?? []);

    return {
      schemaVersion: workStoreSchemaVersion,
      projectRoot: input.projectRoot,
      runtimeDirectory: runtimeDir(input.projectRoot),
      createdAt: normalizeTimestamp(meta.get("createdAt"), input.now),
      updatedAt: normalizeTimestamp(meta.get("updatedAt"), input.now),
      brief: input.brief ?? normalizeBrief(parseJsonRecord(meta.get("brief"))),
      worker: normalizeWorker(workerRow?.json === undefined ? null : parseJsonValue(workerRow.json, null), input.now),
      objects: {
        providerRuns,
        sources: rawSources,
        canonicalSources: sources,
        screeningDecisions: sources.flatMap((source) => generatedScreeningDecision(source) ?? []),
        fullTextRecords: sources.map((source) => generatedFullTextRecord(source)),
        extractions,
        evidenceCells,
        claims,
        citations,
        protocols,
        workItems,
        manuscriptSections,
        releaseChecks
      }
    };
  } finally {
    database.close();
  }
}

function writeWorkspaceDatabase(store: ResearchWorkStore): void {
  const database = openWorkspaceDatabase(store.projectRoot);
  try {
    ensureWorkspaceSchema(database);
    database.exec("BEGIN");
    try {
      database.exec(`
DELETE FROM meta;
DELETE FROM worker_state;
DELETE FROM sources;
DELETE FROM extractions;
DELETE FROM evidence_cells;
DELETE FROM claims;
DELETE FROM support_links;
DELETE FROM protocols;
DELETE FROM manuscript_sections;
DELETE FROM section_claims;
DELETE FROM work_items;
DELETE FROM checks;
DELETE FROM events;
`);
      const insertMeta = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      insertMeta.run("schemaVersion", String(workStoreSchemaVersion));
      insertMeta.run("createdAt", store.createdAt);
      insertMeta.run("updatedAt", store.updatedAt);
      insertMeta.run("brief", jsonText(store.brief));
      database.prepare("INSERT INTO worker_state (id, json, updated_at) VALUES ('current', ?, ?)")
        .run(jsonText(store.worker), store.worker.updatedAt);

      const insertSource = database.prepare(`
INSERT INTO sources (
  id, run_id, title, citation, abstract, year, venue, screening_decision,
  access_mode, best_access_url, json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
      for (const source of store.objects.canonicalSources) {
        insertSource.run(
          source.id,
          source.runId,
          source.title,
          source.citation,
          source.abstract,
          source.year,
          source.venue,
          source.screeningDecision,
          source.accessMode,
          source.bestAccessUrl,
          jsonText(source),
          source.createdAt,
          source.updatedAt
        );
      }

      const insertExtraction = database.prepare("INSERT INTO extractions (id, source_id, run_id, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const extraction of store.objects.extractions) {
        insertExtraction.run(extraction.id, extraction.sourceId, extraction.runId, jsonText(extraction), extraction.createdAt, extraction.updatedAt);
      }

      const insertEvidenceCell = database.prepare("INSERT INTO evidence_cells (id, source_id, extraction_id, run_id, field, confidence, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const cell of store.objects.evidenceCells) {
        insertEvidenceCell.run(
          cell.id,
          cell.sourceId,
          cell.extractionId,
          cell.runId,
          cell.field,
          cell.confidence,
          jsonText(cell),
          cell.createdAt,
          cell.updatedAt
        );
      }

      const insertClaim = database.prepare("INSERT INTO claims (id, run_id, text, evidence, support_status, confidence, risk, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const claim of store.objects.claims) {
        insertClaim.run(
          claim.id,
          claim.runId,
          claim.text,
          claim.evidence,
          claim.supportStatus,
          claim.confidence,
          claim.risk,
          jsonText(claim),
          claim.createdAt,
          claim.updatedAt
        );
      }

      const insertSupportLink = database.prepare("INSERT INTO support_links (id, run_id, source_id, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const citation of store.objects.citations) {
        insertSupportLink.run(citation.id, citation.runId, citation.sourceId, jsonText(citation), citation.createdAt, citation.updatedAt);
      }

      const insertProtocol = database.prepare("INSERT INTO protocols (id, run_id, protocol_id, title, objective, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const protocol of store.objects.protocols) {
        insertProtocol.run(protocol.id, protocol.runId, protocol.protocolId, protocol.title, protocol.objective, jsonText(protocol), protocol.createdAt, protocol.updatedAt);
      }

      const insertSection = database.prepare("INSERT INTO manuscript_sections (id, run_id, section_id, title, status, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      const insertSectionClaim = database.prepare("INSERT OR IGNORE INTO section_claims (section_id, claim_id, created_at) VALUES (?, ?, ?)");
      for (const section of store.objects.manuscriptSections) {
        insertSection.run(section.id, section.runId, section.sectionId, section.title, section.status, jsonText(section), section.createdAt, section.updatedAt);
        for (const claimId of section.claimIds) {
          insertSectionClaim.run(section.id, claimId, section.updatedAt);
        }
      }

      const insertWorkItem = database.prepare("INSERT INTO work_items (id, run_id, type, status, severity, title, target_kind, target_id, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const item of store.objects.workItems) {
        insertWorkItem.run(
          item.id,
          item.runId,
          item.type,
          item.status,
          item.severity,
          item.title,
          item.targetKind,
          item.targetId,
          jsonText(item),
          item.createdAt,
          item.updatedAt
        );
      }

      const insertCheck = database.prepare("INSERT INTO checks (id, run_id, check_id, status, severity, title, message, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const check of store.objects.releaseChecks) {
        insertCheck.run(check.id, check.runId, check.checkId, check.status, check.severity, check.title, check.message, jsonText(check), check.createdAt, check.updatedAt);
      }

      const insertEvent = database.prepare("INSERT INTO events (run_id, event_type, entity_kind, entity_id, message, json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const providerRun of store.objects.providerRuns) {
        insertEvent.run(
          providerRun.runId,
          "provider_run",
          "providerRun",
          providerRun.id,
          `${providerRun.providerId} ${providerRun.phase}`,
          jsonText(providerRun),
          providerRun.updatedAt
        );
      }
      for (const rawSource of store.objects.sources) {
        insertEvent.run(
          rawSource.runId,
          "raw_source_hit",
          "source",
          rawSource.id,
          rawSource.title,
          jsonText(rawSource),
          rawSource.updatedAt
        );
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function loadResearchWorkStore(input: {
  projectRoot: string;
  brief?: ResearchBrief | null;
  now: string;
}): Promise<ResearchWorkStore> {
  if (await fileExists(researchWorkStoreFilePath(input.projectRoot))) {
    return loadWorkspaceDatabase(input);
  }

  try {
    const raw = JSON.parse(await readFile(legacyResearchWorkStoreFilePath(input.projectRoot), "utf8")) as unknown;
    const record = asObject(raw);
    const migrated: ResearchWorkStore = {
      schemaVersion: workStoreSchemaVersion,
      projectRoot: input.projectRoot,
      runtimeDirectory: runtimeDir(input.projectRoot),
      createdAt: normalizeTimestamp(record.createdAt, input.now),
      updatedAt: normalizeTimestamp(record.updatedAt, input.now),
      brief: input.brief ?? normalizeBrief(record.brief),
      worker: normalizeWorker(record.worker, input.now),
      objects: normalizeObjects(record.objects)
    };
    await writeResearchWorkStore(migrated);
    return migrated;
  } catch {
    return createResearchWorkStore(input);
  }
}

export async function writeResearchWorkStore(store: ResearchWorkStore): Promise<void> {
  await mkdir(runtimeDir(store.projectRoot), { recursive: true });
  writeWorkspaceDatabase(store);
}

export function queryResearchWorkStore<T extends WorkStoreEntity = WorkStoreEntity>(
  store: ResearchWorkStore,
  query: WorkStoreQuery
): WorkStoreQueryResult<T> {
  const limit = Math.max(1, Math.min(500, query.limit ?? 50));
  const cursorPrefix = `${query.collection}:`;
  const offset = typeof query.cursor === "string" && query.cursor.startsWith(cursorPrefix)
    ? Math.max(0, Number.parseInt(query.cursor.slice(cursorPrefix.length), 10) || 0)
    : 0;
  const filtered = collectionFor(store, query.collection)
    .filter((entity) => matchesFilters(entity, query.filters));
  const terms = semanticTerms(query.semanticQuery);
  const scored = filtered
    .map((entity) => ({
      entity,
      score: semanticScore(entity, terms)
    }))
    .filter((entry) => terms.length === 0 || entry.score > 0)
    .sort((left, right) => right.score - left.score);
  const matches = scored.map((entry) => entry.entity);
  const items = matches.slice(offset, offset + limit) as T[];
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < matches.length;

  return {
    collection: query.collection,
    count: items.length,
    totalCount: matches.length,
    cursor: query.cursor ?? null,
    hasMore,
    nextCursor: hasMore ? `${query.collection}:${nextOffset}` : null,
    items
  };
}

export function readResearchWorkStoreEntity<T extends WorkStoreEntity = WorkStoreEntity>(
  store: ResearchWorkStore,
  collection: WorkStoreCollectionName,
  id: string
): T | null {
  return (collectionFor(store, collection).find((entity) => entity.id === id) as T | undefined) ?? null;
}

export function createResearchWorkStoreEntity<T extends WorkStoreEntity = WorkStoreEntity>(
  store: ResearchWorkStore,
  entity: WorkStoreCreateInput<T>,
  now: string
): ResearchWorkStore {
  const created = {
    ...entity,
    createdAt: entity.createdAt ?? now,
    updatedAt: entity.updatedAt ?? now
  } as T;
  const collection = collectionNameForKind(created.kind);
  return upsertResearchWorkStoreEntities(store, [created], now);
}

export function patchResearchWorkStoreEntity(
  store: ResearchWorkStore,
  patch: WorkStorePatch,
  now: string
): ResearchWorkStore {
  const items = collectionFor(store, patch.collection);
  const nextItems = items.map((entity) => (
    entity.id === patch.id
      ? {
        ...entity,
        ...patch.changes,
        id: entity.id,
        kind: entity.kind,
        updatedAt: now
      } as WorkStoreEntity
      : entity
  ));

  return {
    ...setCollection(store, patch.collection, nextItems),
    updatedAt: now
  };
}

export function upsertResearchWorkStoreEntities(
  store: ResearchWorkStore,
  entities: WorkStoreEntity[],
  now: string
): ResearchWorkStore {
  let next = store;

  for (const entity of entities) {
    const collection = collectionNameForKind(entity.kind);
    const items = collectionFor(next, collection);
    const existingIndex = items.findIndex((item) => item.id === entity.id);
    const nextEntity = {
      ...entity,
      createdAt: entity.createdAt || now,
      updatedAt: now
    } as WorkStoreEntity;
    const nextItems = existingIndex === -1
      ? [...items, nextEntity]
      : items.map((item, index) => index === existingIndex
        ? { ...item, ...nextEntity, createdAt: item.createdAt, updatedAt: now } as WorkStoreEntity
        : item);
    next = setCollection(next, collection, nextItems);
  }

  return {
    ...next,
    updatedAt: now
  };
}

export function updateResearchWorkStoreWorker(
  store: ResearchWorkStore,
  worker: ResearchWorkStoreWorker,
  now: string
): ResearchWorkStore {
  return {
    ...store,
    updatedAt: now,
    worker: {
      ...worker,
      updatedAt: now
    }
  };
}

function providerRunsFromGathered(run: RunRecord, gathered: ResearchSourceSnapshot | null, now: string): WorkStoreProviderRun[] {
  return (gathered?.retrievalDiagnostics?.providerAttempts ?? []).map((attempt, index) => ({
    id: stableId("provider-run", [run.id, index, attempt.providerId, attempt.phase, attempt.rawCandidateCount]),
    kind: "providerRun",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    providerId: attempt.providerId,
    phase: attempt.phase,
    query: null,
    providerCalls: attempt.providerCalls,
    rawCandidateCount: attempt.rawCandidateCount,
    acceptedSourceCount: attempt.acceptedSourceCount,
    error: attempt.error
  }));
}

function sourceFromResearchSource(run: RunRecord, source: ResearchSource, now: string): WorkStoreSource {
  return {
    id: source.id,
    kind: "source",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    providerId: source.providerId,
    category: source.category,
    sourceKind: source.kind,
    title: source.title,
    locator: source.locator,
    citation: source.citation,
    excerpt: source.excerpt
  };
}

function canonicalSourceFromPaper(run: RunRecord, paper: CanonicalPaper, now: string): WorkStoreCanonicalSource {
  return {
    id: paper.id,
    kind: "canonicalSource",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    key: paper.key,
    title: paper.title,
    citation: paper.citation,
    abstract: paper.abstract,
    year: paper.year,
    authors: paper.authors,
    venue: paper.venue,
    providerIds: paper.discoveredVia,
    identifiers: paper.identifiers,
    accessMode: paper.accessMode,
    bestAccessUrl: paper.bestAccessUrl,
    screeningDecision: paper.screeningDecision,
    screeningRationale: paper.screeningRationale,
    tags: paper.tags
  };
}

function screeningDecisionsFromPaper(run: RunRecord, paper: CanonicalPaper, now: string): WorkStoreScreeningDecision[] {
  return paper.screeningHistory.map((decision, index) => ({
    id: stableId("screening", [paper.id, decision.stage, index]),
    kind: "screeningDecision",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    sourceId: paper.id,
    stage: decision.stage,
    decision: decision.decision,
    rationale: decision.rationale
  }));
}

function fullTextRecordFromPaper(run: RunRecord, paper: CanonicalPaper, now: string): WorkStoreFullTextRecord {
  return {
    id: stableId("fulltext", [paper.id]),
    kind: "fullTextRecord",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    sourceId: paper.id,
    accessMode: paper.accessMode,
    format: paper.fulltextFormat,
    url: paper.bestAccessUrl,
    providerId: paper.bestAccessProvider,
    fulltextAvailable: paper.contentStatus.fulltextAvailable,
    fulltextFetched: paper.contentStatus.fulltextFetched,
    fulltextExtracted: paper.contentStatus.fulltextExtracted,
    errors: paper.accessErrors
  };
}

function extractionEntity(run: RunRecord, extraction: PaperExtraction, now: string): WorkStoreExtraction {
  return {
    id: extraction.id,
    kind: "extraction",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    sourceId: extraction.paperId,
    extraction
  };
}

function targetKindFromCriticTarget(target: string): WorkStoreWorkItem["targetKind"] {
  switch (target) {
    case "sources":
      return "canonicalSource";
    case "extraction":
      return "extraction";
    case "evidence":
      return "evidenceCell";
    case "synthesis":
    case "verification":
      return "claim";
    case "manuscript":
      return "manuscriptSection";
    case "release":
      return "release";
    case "protocol":
      return "protocol";
    default:
      return "unknown";
  }
}

export function workItemsFromCriticReports(run: RunRecord, reports: CriticReviewArtifact[], now: string): WorkStoreWorkItem[] {
  return reports.flatMap((report) => report.objections.map((objection, index) => ({
    id: stableId("work-item", [run.id, "critic", report.stage, objection.code, index]),
    kind: "workItem",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    type: "critic_objection",
    status: report.readiness === "pass" ? "resolved" : "open",
    severity: objection.severity,
    title: `${criticScopeLabel(report.stage)} critic: ${objection.code}`,
    description: objection.message,
    targetKind: targetKindFromCriticTarget(objection.target),
    targetId: objection.affectedPaperIds[0] ?? objection.affectedClaimIds[0] ?? null,
    affectedSourceIds: objection.affectedPaperIds,
    affectedClaimIds: objection.affectedClaimIds,
    suggestedActions: uniqueStrings([
      objection.suggestedRevision ?? "",
      ...report.revisionAdvice.searchQueries.map((query) => `search: ${query}`),
      ...report.revisionAdvice.evidenceTargets.map((target) => `cover evidence target: ${target}`),
      ...report.revisionAdvice.papersToExclude.map((paperId) => `exclude source: ${paperId}`),
      ...report.revisionAdvice.papersToPromote.map((paperId) => `promote source: ${paperId}`),
      ...report.revisionAdvice.claimsToSoften.map((claimId) => `soften claim: ${claimId}`)
    ], 12),
    source: "critic"
  })));
}

function criticScopeLabel(stage: CriticReviewScope): string {
  return stage.replace(/_/g, " ");
}

export function mergeRunSegmentIntoResearchWorkStore(
  store: ResearchWorkStore,
  input: {
    run: RunRecord;
    plan: ResearchPlan;
    gathered: ResearchSourceSnapshot | null;
    paperExtractions: PaperExtraction[];
    criticReports: CriticReviewArtifact[];
    now: string;
  }
): ResearchWorkStore {
  const { run, gathered, paperExtractions, criticReports, now } = input;
  const canonicalPapers = gathered?.canonicalPapers ?? [];
  const entities: WorkStoreEntity[] = [
    ...providerRunsFromGathered(run, gathered, now),
    ...(gathered?.sources ?? []).map((source) => sourceFromResearchSource(run, source, now)),
    ...canonicalPapers.map((paper) => canonicalSourceFromPaper(run, paper, now)),
    ...canonicalPapers.flatMap((paper) => screeningDecisionsFromPaper(run, paper, now)),
    ...canonicalPapers.map((paper) => fullTextRecordFromPaper(run, paper, now)),
    ...paperExtractions.map((extraction) => extractionEntity(run, extraction, now)),
    ...workItemsFromCriticReports(run, criticReports, now)
  ];

  return {
    ...upsertResearchWorkStoreEntities(store, entities, now),
    brief: run.brief,
    updatedAt: now
  };
}

function contextEntry(id: string, title: string, text: string, runId: string | null, data: Record<string, string | string[] | null> = {}) {
  return {
    id,
    title,
    text,
    runId,
    links: [],
    data
  };
}

function countsByMemoryType(store: ResearchWorkStore): Record<MemoryRecordType, number> {
  return {
    claim: store.objects.claims.length,
    finding: store.objects.evidenceCells.length,
    question: store.objects.workItems.filter((item) => item.type === "open_question").length,
    idea: store.objects.workItems.filter((item) => item.type === "agent_next_action").length,
    summary: store.worker.lastRunId === null ? 0 : 1,
    artifact: store.objects.releaseChecks.length + store.objects.manuscriptSections.length,
    direction: store.objects.workItems.filter((item) => item.type === "agent_next_action").length,
    hypothesis: 0,
    method_plan: 0
  };
}

export function buildProjectMemoryContextFromWorkStore(store: ResearchWorkStore): ProjectMemoryContext {
  const claims = store.objects.claims.slice(-12).map((claim) => contextEntry(
    claim.id,
    claim.text,
    claim.evidence,
    claim.runId,
    {
      sourceIds: claim.sourceIds,
      supportStatus: claim.supportStatus,
      confidence: claim.confidence
    }
  ));
  const findings = store.objects.evidenceCells.slice(-20).map((cell) => contextEntry(
    cell.id,
    `${cell.field} for ${cell.sourceId}`,
    Array.isArray(cell.value) ? cell.value.join("; ") : cell.value,
    cell.runId,
    {
      sourceId: cell.sourceId,
      confidence: cell.confidence
    }
  ));
  const questions = store.objects.workItems
    .filter((item) => item.status === "open" && (item.type === "open_question" || item.type === "evidence_gap"))
    .slice(-12)
    .map((item) => contextEntry(item.id, item.title, item.description, item.runId, {
      type: item.type,
      severity: item.severity,
      suggestedActions: item.suggestedActions
    }));
  const summaries = store.worker.lastRunId === null
    ? []
    : [contextEntry(
      `worker-${store.worker.lastRunId}`,
      `Autonomous worker ${store.worker.status}`,
      store.worker.statusReason,
      store.worker.lastRunId,
      {
        paperReadiness: store.worker.paperReadiness,
        nextInternalActions: store.worker.nextInternalActions
      }
    )];

  return {
    available: store.objects.canonicalSources.length > 0
      || store.objects.claims.length > 0
      || store.objects.workItems.length > 0,
    recordCount: store.objects.claims.length + store.objects.evidenceCells.length + store.objects.workItems.length,
    countsByType: countsByMemoryType(store),
    claims,
    findings,
    questions,
    ideas: [],
    summaries,
    artifacts: store.objects.releaseChecks.slice(-8).map((check) => contextEntry(check.id, check.title, check.message, check.runId)),
    directions: store.objects.workItems
      .filter((item) => item.type === "agent_next_action")
      .slice(-8)
      .map((item) => contextEntry(item.id, item.title, item.description, item.runId)),
    hypotheses: [],
    methodPlans: [],
    queryHints: uniqueStrings([
      ...store.objects.workItems.flatMap((item) => item.suggestedActions),
      ...store.worker.nextInternalActions
    ], 12),
    localFileHints: []
  };
}

export function buildLiteratureContextFromWorkStore(store: ResearchWorkStore): LiteratureContext {
  const papers = store.objects.canonicalSources.slice(-20).map((source) => ({
    id: source.id,
    title: source.title,
    citation: source.citation,
    abstract: source.abstract,
    bestAccessUrl: source.bestAccessUrl,
    accessMode: source.accessMode as LiteratureContext["papers"][number]["accessMode"],
    screeningDecision: source.screeningDecision as LiteratureContext["papers"][number]["screeningDecision"],
    screeningStage: "fulltext" as LiteratureContext["papers"][number]["screeningStage"],
    linkedThemeIds: []
  }));
  const themes = store.objects.evidenceCells
    .filter((cell) => ["successSignals", "failureModes", "limitations"].includes(cell.field))
    .slice(-12)
    .map((cell) => ({
      id: cell.id,
      title: `${cell.field} evidence`,
      summary: Array.isArray(cell.value) ? cell.value.join("; ") : cell.value,
      paperIds: [cell.sourceId]
    }));
  const notebooks = store.worker.lastRunId === null
    ? []
    : [{
      id: `worker-${store.worker.lastRunId}`,
      title: `Worker state for ${store.worker.lastRunId}`,
      summary: store.worker.statusReason,
      nextQuestions: store.worker.nextInternalActions
    }];

  return {
    available: papers.length > 0 || themes.length > 0,
    paperCount: store.objects.canonicalSources.length,
    themeCount: themes.length,
    notebookCount: notebooks.length,
    papers,
    themes,
    notebooks,
    queryHints: uniqueStrings(store.objects.workItems.flatMap((item) => item.suggestedActions), 12)
  };
}

export type ResearchWorkStoreSummary = {
  providerRuns: number;
  sources: number;
  protocols: number;
  canonicalSources: number;
  extractions: number;
  evidenceCells: number;
  claims: number;
  openWorkItems: number;
  releaseChecks: number;
};

export function summarizeResearchWorkStore(store: ResearchWorkStore): ResearchWorkStoreSummary {
  return {
    providerRuns: store.objects.providerRuns.length,
    sources: store.objects.sources.length,
    protocols: store.objects.protocols.length,
    canonicalSources: store.objects.canonicalSources.length,
    extractions: store.objects.extractions.length,
    evidenceCells: store.objects.evidenceCells.length,
    claims: store.objects.claims.length,
    openWorkItems: store.objects.workItems.filter((item) => item.status === "open").length,
    releaseChecks: store.objects.releaseChecks.length
  };
}
