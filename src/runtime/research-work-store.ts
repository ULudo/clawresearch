import { access, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { CanonicalPaper, LiteratureContext } from "./literature-store.js";
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
  | "document"
  | "documentChunk"
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
  | "documents"
  | "documentChunks"
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
  | "paused"
  | "needs_user_decision"
  | "externally_blocked";

export type ResearchWorkerCompletion = null | {
  kind: "manuscript_finalized";
  artifactPaths: string[];
  finalizedAt: string;
};

export type ResearchNotebookTaskStatus =
  | "todo"
  | "in_progress"
  | "done"
  | "blocked"
  | "abandoned";

export type ResearchArtifactType =
  | "research_report"
  | "technical_report"
  | "review_paper"
  | "survey_paper"
  | "method_paper"
  | "experimental_paper"
  | "position_paper";

export type ResearchNotebookTask = {
  id: string;
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

export type ResearchNotebookArtifactLink = {
  label: string;
  path: string;
  kind: "paper" | "references" | "checks" | "source_checkpoint" | "trace" | "other";
  createdAt: string;
  createdBy?: "runtime";
};

export type ResearchContract = {
  researchObjectives: string[];
  coveragePlan: string[];
  adequacyRationale: string[];
  knownUncertainties: string[];
};

export type ResearchNotebook = {
  schemaVersion: 1;
  artifactType: ResearchArtifactType;
  objective: string;
  researchContract: ResearchContract;
  researchContractUpdatedAt: string;
  definitionOfDone: string[];
  tasks: ResearchNotebookTask[];
  currentFocus: string | null;
  readiness: string;
  notes: string[];
  artifactLinks: ResearchNotebookArtifactLink[];
  updatedAt: string;
};

export const defaultNotebookReadiness = "No research readiness assessment has been written yet.";

export type ResearchNotebookDiagnosticWarning = {
  code: string;
  message: string;
  count: number;
  suggestedActions: string[];
};

export type ResearchWorkspaceDispositionDiagnostics = {
  selectedSourceIds: string[];
  extractedSourceIds: string[];
  evidenceCellSourceIds: string[];
  claimSourceIds: string[];
  citationSourceIds: string[];
  renderedReferenceSourceIds: string[];
  missingSelectedExtractionSourceIds: string[];
  duplicateExtractionSourceIds: string[];
  extractedNotEvidenceSourceIds: string[];
  evidenceNotCitedSourceIds: string[];
  selectedToRenderedCollapseSourceIds: string[];
  selectedToRenderedCollapse: boolean;
};

export type ResearchCorpusDiagnosticView = {
  diagnosticOnly: true;
  note: string;
  canonicalSourceCount: number;
  selectedSourceCount: number;
  extractedSourceCount: number;
  evidenceSourceCount: number;
  citationSourceCount: number;
  renderedReferenceSourceCount: number;
  accessModeCounts: Record<string, number>;
  screeningDecisionCounts: Record<string, number>;
  providerRunCount: number;
  sourceCandidateCount: number;
  documentCount: number;
  parsedDocumentCount: number;
  documentChunkCount: number;
  selectedFullTextNotFetchedSourceIds: string[];
  selectedFullTextNotParsedSourceIds: string[];
  selectedSourcesWithoutChunkGroundedExtractionIds: string[];
  evidenceCellsWithoutChunkGroundingIds: string[];
  missingSelectedExtractionSourceIds: string[];
  duplicateExtractionSourceIds: string[];
  extractedNotEvidenceSourceIds: string[];
  evidenceNotCitedSourceIds: string[];
  selectedToRenderedCollapseSourceIds: string[];
};

export type ResearchSynthesisDiagnosticView = {
  diagnosticOnly: true;
  note: string;
  activeExtractionCount: number;
  activeEvidenceCellCount: number;
  activeCitationCount: number;
  claimCount: number;
  claimsWithCitationSupportCount: number;
  claimsWithoutCitationSupportIds: string[];
  manuscriptSectionCount: number;
  sectionsWithClaimLinksCount: number;
  sectionsWithoutClaimLinksIds: string[];
  sectionsWithoutCitationLinksIds: string[];
  evidenceCellIdsWithoutCitationLinks: string[];
  selectedSourceIdsNotCited: string[];
};

export type ResearchNotebookDiagnostics = {
  warningCount: number;
  warnings: ResearchNotebookDiagnosticWarning[];
  taskCount: number;
  activeTaskCount: number;
  readinessRecorded: boolean;
  currentFocusSet: boolean;
  researchContractComplete: boolean;
  researchContractCriticReviewed: boolean;
  researchContractCriticFresh: boolean;
  definitionOfDoneAddressed: boolean;
  unlinkedSelectedSourceIds: string[];
  unlinkedEvidenceCellIds: string[];
  unlinkedClaimIds: string[];
  unlinkedSectionIds: string[];
  staleAfterWorkspaceChange: boolean;
  latestWorkspaceChangeAt: string | null;
  disposition: ResearchWorkspaceDispositionDiagnostics;
};

export type ResearchCriticReviewSummary = {
  stage: string;
  readiness: string;
  artifactPath: string;
  createdAt: string;
};

export type WorkStoreBaseEntity = {
  id: string;
  kind: WorkStoreEntityKind;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchObjectLifecycleStatus =
  | "active"
  | "superseded"
  | "retired";

export type ResearchObjectLifecycle = {
  status?: ResearchObjectLifecycleStatus;
  supersededBy?: string | null;
  statusReason?: string | null;
};

export function researchObjectLifecycleStatus(entity: { status?: unknown }): ResearchObjectLifecycleStatus {
  return entity.status === "superseded" || entity.status === "retired"
    ? entity.status
    : "active";
}

export function researchObjectIsActive(entity: { status?: unknown }): boolean {
  return researchObjectLifecycleStatus(entity) === "active";
}

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

export type WorkStoreDocument = WorkStoreBaseEntity & {
  kind: "document";
  sourceId: string;
  url: string | null;
  format: "pdf" | "html" | "xml" | "latex" | "text" | "unknown";
  status: "fetched" | "parsed" | "failed";
  fetchedAt: string | null;
  parsedAt: string | null;
  parser: string | null;
  contentPath: string | null;
  textPath: string | null;
  textHash: string | null;
  error: string | null;
};

export type WorkStoreDocumentChunk = WorkStoreBaseEntity & {
  kind: "documentChunk";
  documentId: string;
  sourceId: string;
  chunkIndex: number;
  sectionTitle: string | null;
  sectionType: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  tokenCount: number;
};

export type WorkStoreExtraction = WorkStoreBaseEntity & ResearchObjectLifecycle & {
  kind: "extraction";
  sourceId: string;
  readLevel?: "metadata" | "abstract" | "partial_full_text" | "full_text";
  documentId?: string | null;
  documentChunkIds?: string[];
  sourceSnippets?: string[];
  extraction: PaperExtraction;
};

export type WorkStoreEvidenceCell = WorkStoreBaseEntity & ResearchObjectLifecycle & {
  kind: "evidenceCell";
  sourceId: string;
  extractionId: string;
  readLevel?: "metadata" | "abstract" | "partial_full_text" | "full_text";
  documentId?: string | null;
  documentChunkIds?: string[];
  sourceSnippets?: string[];
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

export type WorkStoreCitation = WorkStoreBaseEntity & ResearchObjectLifecycle & {
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
  targetKind: WorkStoreEntityKind | "protocol" | "brief" | "release" | "unknown";
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
  orderIndex?: number | null;
  title: string;
  markdown: string;
  sourceIds: string[];
  claimIds: string[];
  status: "draft" | "needs_revision" | "ready_for_review" | "checked";
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
  | WorkStoreDocument
  | WorkStoreDocumentChunk
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
  completion: ResearchWorkerCompletion;
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
    selectedSourceIds: string[];
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
  documents: WorkStoreDocument[];
  documentChunks: WorkStoreDocumentChunk[];
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
  notebook: ResearchNotebook;
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
CREATE TABLE IF NOT EXISTS notebook_state (
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
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  run_id TEXT,
  url TEXT,
  format TEXT NOT NULL,
  status TEXT NOT NULL,
  content_path TEXT,
  text_path TEXT,
  text_hash TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  section_title TEXT,
  token_count INTEGER NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id, status);
CREATE INDEX IF NOT EXISTS idx_document_chunks_source ON document_chunks(source_id, document_id, chunk_index);
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
    documents: [],
    documentChunks: [],
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
    completion: null,
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

function createEmptyResearchContract(): ResearchContract {
  return {
    researchObjectives: [],
    coveragePlan: [],
    adequacyRationale: [],
    knownUncertainties: []
  };
}

function createEmptyNotebook(now: string, brief: ResearchBrief = createEmptyBrief()): ResearchNotebook {
  const objective = [
    brief.topic,
    brief.researchQuestion,
    brief.researchDirection,
    brief.successCriterion
  ].flatMap((part) => readString(part) ?? []).join(" ");

  return {
    schemaVersion: 1,
    artifactType: "review_paper",
    objective: objective.length > 0 ? objective : "Unscoped research objective",
    researchContract: createEmptyResearchContract(),
    researchContractUpdatedAt: now,
    definitionOfDone: [],
    tasks: [],
    currentFocus: null,
    readiness: defaultNotebookReadiness,
    notes: [],
    artifactLinks: [],
    updatedAt: now
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

export function normalizeResearchArtifactType(
  value: unknown,
  fallback: ResearchArtifactType = "review_paper"
): ResearchArtifactType {
  switch (value) {
    case "research_report":
    case "technical_report":
    case "review_paper":
    case "survey_paper":
    case "method_paper":
    case "experimental_paper":
    case "position_paper":
      return value;
    default:
      return fallback;
  }
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
    completion: normalizeWorkerCompletion(record.completion),
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

function normalizeWorkerCompletion(value: unknown): ResearchWorkerCompletion {
  const record = asObject(value);
  if (record.kind !== "manuscript_finalized") {
    return null;
  }
  const finalizedAt = readString(record.finalizedAt);
  const artifactPaths = readStringArray(record.artifactPaths, 40);
  if (finalizedAt === null || artifactPaths.length === 0) {
    return null;
  }

  return {
    kind: "manuscript_finalized",
    artifactPaths,
    finalizedAt
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
    selectedSourceIds: readStringArray(record.selectedSourceIds, 500),
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
    case "paused":
    case "needs_user_decision":
    case "externally_blocked":
      return true;
    default:
      return false;
  }
}

function normalizeNotebookTaskStatus(value: unknown): ResearchNotebookTaskStatus {
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

function normalizeNotebookTask(value: unknown): ResearchNotebookTask | null {
  const record = asObject(value);
  const id = readString(record.id);
  const title = readString(record.title);
  if (id === null || title === null) {
    return null;
  }

  return {
    id,
    title,
    status: normalizeNotebookTaskStatus(record.status),
    notes: readString(record.notes),
    linkedSourceIds: readStringArray(record.linkedSourceIds, 80),
    linkedExtractionIds: readStringArray(record.linkedExtractionIds, 80),
    linkedEvidenceCellIds: readStringArray(record.linkedEvidenceCellIds, 80),
    linkedClaimIds: readStringArray(record.linkedClaimIds, 80),
    linkedSectionIds: readStringArray(record.linkedSectionIds, 80),
    linkedArtifactPaths: readStringArray(record.linkedArtifactPaths, 80)
  };
}

function normalizeNotebookArtifactLink(value: unknown): ResearchNotebookArtifactLink | null {
  const record = asObject(value);
  const label = readString(record.label);
  const linkPath = readString(record.path);
  const createdAt = readString(record.createdAt);
  if (label === null || linkPath === null || createdAt === null) {
    return null;
  }
  const kind = typeof record.kind === "string" && ["paper", "references", "checks", "source_checkpoint", "trace", "other"].includes(record.kind)
    ? record.kind as ResearchNotebookArtifactLink["kind"]
    : "other";

  return {
    label,
    path: linkPath,
    kind,
    createdAt,
    ...(record.createdBy === "runtime" ? { createdBy: "runtime" as const } : {})
  };
}

function normalizeResearchContract(value: unknown): ResearchContract {
  const record = asObject(value);
  return {
    researchObjectives: readStringArray(record.researchObjectives ?? record.objectives, 80),
    coveragePlan: readStringArray(record.coveragePlan ?? record.coverage, 80),
    adequacyRationale: readStringArray(record.adequacyRationale ?? record.adequacyCriteria ?? record.rationale, 80),
    knownUncertainties: readStringArray(record.knownUncertainties ?? record.uncertainties, 80)
  };
}

function normalizeNotebook(value: unknown, now: string, brief: ResearchBrief): ResearchNotebook {
  const base = createEmptyNotebook(now, brief);
  const record = asObject(value);
  const researchContract = normalizeResearchContract(record.researchContract);

  return {
    schemaVersion: 1,
    artifactType: normalizeResearchArtifactType(record.artifactType, base.artifactType),
    objective: readString(record.objective) ?? base.objective,
    researchContract,
    researchContractUpdatedAt: normalizeTimestamp(record.researchContractUpdatedAt, normalizeTimestamp(record.updatedAt, now)),
    definitionOfDone: readStringArray(record.definitionOfDone, 80),
    tasks: Array.isArray(record.tasks)
      ? record.tasks.flatMap((entry) => normalizeNotebookTask(entry) ?? [])
      : [],
    currentFocus: readString(record.currentFocus),
    readiness: readString(record.readiness) ?? base.readiness,
    notes: readStringArray(record.notes, 200),
    artifactLinks: Array.isArray(record.artifactLinks)
      ? record.artifactLinks.flatMap((entry) => normalizeNotebookArtifactLink(entry) ?? [])
      : [],
    updatedAt: normalizeTimestamp(record.updatedAt, now)
  };
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
    documents: normalizeEntityArray(record.documents, "document"),
    documentChunks: normalizeEntityArray(record.documentChunks, "documentChunk"),
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
    case "document":
      return "documents";
    case "documentChunk":
      return "documentChunks";
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
  const brief = input.brief ?? createEmptyBrief();
  return {
    schemaVersion: workStoreSchemaVersion,
    projectRoot: input.projectRoot,
    runtimeDirectory: runtimeDir(input.projectRoot),
    createdAt: input.now,
    updatedAt: input.now,
    brief,
    worker: createEmptyWorker(input.now),
    notebook: createEmptyNotebook(input.now, brief),
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
    const notebookRow = database.prepare("SELECT json FROM notebook_state WHERE id = 'current'").get();
    const brief = input.brief ?? normalizeBrief(parseJsonRecord(meta.get("brief")));
    const sources = statementRows<Record<string, unknown>>(database, "SELECT json FROM sources ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreCanonicalSource>(row, "canonicalSource") ?? []);
    const extractions = statementRows<Record<string, unknown>>(database, "SELECT json FROM extractions ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreExtraction>(row, "extraction") ?? []);
    const evidenceCells = statementRows<Record<string, unknown>>(database, "SELECT json FROM evidence_cells ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreEvidenceCell>(row, "evidenceCell") ?? []);
    const documents = statementRows<Record<string, unknown>>(database, "SELECT json FROM documents ORDER BY updated_at, id")
      .flatMap((row) => rowJsonEntity<WorkStoreDocument>(row, "document") ?? []);
    const documentChunks = statementRows<Record<string, unknown>>(database, "SELECT json FROM document_chunks ORDER BY source_id, document_id, chunk_index, id")
      .flatMap((row) => rowJsonEntity<WorkStoreDocumentChunk>(row, "documentChunk") ?? []);
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
      brief,
      worker: normalizeWorker(workerRow?.json === undefined ? null : parseJsonValue(workerRow.json, null), input.now),
      notebook: normalizeNotebook(notebookRow?.json === undefined ? null : parseJsonValue(notebookRow.json, null), input.now, brief),
      objects: {
        providerRuns,
        sources: rawSources,
        canonicalSources: sources,
        screeningDecisions: sources.flatMap((source) => generatedScreeningDecision(source) ?? []),
        fullTextRecords: sources.map((source) => generatedFullTextRecord(source)),
        documents,
        documentChunks,
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
DELETE FROM notebook_state;
DELETE FROM sources;
DELETE FROM extractions;
DELETE FROM evidence_cells;
DELETE FROM documents;
DELETE FROM document_chunks;
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
      database.prepare("INSERT INTO notebook_state (id, json, updated_at) VALUES ('current', ?, ?)")
        .run(jsonText(store.notebook), store.notebook.updatedAt);

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

      const insertDocument = database.prepare("INSERT INTO documents (id, source_id, run_id, url, format, status, content_path, text_path, text_hash, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const document of store.objects.documents) {
        insertDocument.run(
          document.id,
          document.sourceId,
          document.runId,
          document.url,
          document.format,
          document.status,
          document.contentPath,
          document.textPath,
          document.textHash,
          jsonText(document),
          document.createdAt,
          document.updatedAt
        );
      }

      const insertDocumentChunk = database.prepare("INSERT INTO document_chunks (id, document_id, source_id, chunk_index, section_title, token_count, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const chunk of store.objects.documentChunks) {
        insertDocumentChunk.run(
          chunk.id,
          chunk.documentId,
          chunk.sourceId,
          chunk.chunkIndex,
          chunk.sectionTitle,
          chunk.tokenCount,
          jsonText(chunk),
          chunk.createdAt,
          chunk.updatedAt
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
    const brief = input.brief ?? normalizeBrief(record.brief);
    const migrated: ResearchWorkStore = {
      schemaVersion: workStoreSchemaVersion,
      projectRoot: input.projectRoot,
      runtimeDirectory: runtimeDir(input.projectRoot),
      createdAt: normalizeTimestamp(record.createdAt, input.now),
      updatedAt: normalizeTimestamp(record.updatedAt, input.now),
      brief,
      worker: normalizeWorker(record.worker, input.now),
      notebook: normalizeNotebook(record.notebook, input.now, brief),
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
    case "source":
    case "sources":
      return "canonicalSource";
    case "extraction":
      return "extraction";
    case "evidence":
      return "evidenceCell";
    case "claim":
      return "claim";
    case "section":
    case "manuscript":
      return "manuscriptSection";
    case "citation":
      return "citation";
    case "release":
    case "release_check":
      return "release";
    case "protocol":
      return "protocol";
    case "notebook":
      return "unknown";
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
    targetId: objection.targetId ?? objection.affectedPaperIds[0] ?? objection.affectedClaimIds[0] ?? null,
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

export type WorkspacePromptContext = {
  available: boolean;
  counts: {
    providerRuns: number;
    sources: number;
    canonicalSources: number;
    screeningDecisions: number;
    fullTextRecords: number;
    documents: number;
    documentChunks: number;
    extractions: number;
    evidenceCells: number;
    claims: number;
    citations: number;
    protocols: number;
    workItems: number;
    openWorkItems: number;
    manuscriptSections: number;
    releaseChecks: number;
  };
  corpus_view: ResearchCorpusDiagnosticView;
  synthesis_view: ResearchSynthesisDiagnosticView;
  notebook: {
    artifactType: ResearchArtifactType;
    objective: string;
    researchContract: ResearchContract;
    legacyDefinitionOfDone: string[];
    currentFocus: string | null;
    readiness: string;
	    activeTasks: Array<{
      id: string;
      title: string;
      status: ResearchNotebookTaskStatus;
      linkedSourceIds: string[];
      linkedEvidenceCellIds: string[];
      linkedClaimIds: string[];
      linkedSectionIds: string[];
      linkedArtifactPaths: string[];
	    }>;
	    artifactLinks: ResearchNotebookArtifactLink[];
	    recentCriticReviews: ResearchCriticReviewSummary[];
	    diagnostics: ResearchNotebookDiagnostics;
	  };
  recentSources: Array<{
    id: string;
    title: string;
    citation: string;
    year: number | null;
    venue: string | null;
    providerIds: string[];
    accessMode: string;
    screeningDecision: string;
  }>;
  recentExtractions: Array<{
    id: string;
    sourceId: string;
    status: ResearchObjectLifecycleStatus;
    supersededBy: string | null;
    problemSetting: string;
    systemType: string;
    confidence: string;
  }>;
  recentEvidenceCells: Array<{
    id: string;
    sourceId: string;
    extractionId: string;
    status: ResearchObjectLifecycleStatus;
    supersededBy: string | null;
    field: string;
    value: string | string[];
    confidence: string;
  }>;
  recentClaims: Array<{
    id: string;
    text: string;
    supportStatus: string;
    confidence: string;
    sourceIds: string[];
    citationIds: string[];
  }>;
  recentSections: Array<{
    id: string;
    title: string;
    status: string;
    claimIds: string[];
    citationIds: string[];
  }>;
  openWorkItems: Array<{
    id: string;
    type: WorkItemType;
    title: string;
    severity: WorkItemSeverity;
    suggestedActions: string[];
    targetId: string | null;
    affectedSourceIds: string[];
    affectedClaimIds: string[];
  }>;
  recentReleaseChecks: Array<{
    id: string;
    title: string;
    status: string;
    message: string;
    updatedAt: string;
  }>;
  worker: {
    status: ResearchWorkerStatus;
    statusReason: string;
    nextInternalActions: string[];
    completion: ResearchWorkerCompletion;
    lastRunId: string | null;
  };
};

function parseTimestampMs(value: string | null | undefined): number {
  if (typeof value !== "string") {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function taskLinkedIds(store: ResearchWorkStore): {
  sourceIds: Set<string>;
  evidenceCellIds: Set<string>;
  claimIds: Set<string>;
  sectionIds: Set<string>;
} {
  return {
    sourceIds: new Set(store.notebook.tasks.flatMap((task) => task.linkedSourceIds)),
    evidenceCellIds: new Set(store.notebook.tasks.flatMap((task) => task.linkedEvidenceCellIds)),
    claimIds: new Set(store.notebook.tasks.flatMap((task) => task.linkedClaimIds)),
    sectionIds: new Set(store.notebook.tasks.flatMap((task) => task.linkedSectionIds))
  };
}

function duplicateSourceIdsForExtractions(extractions: WorkStoreExtraction[]): string[] {
  const counts = new Map<string, number>();
  for (const extraction of extractions) {
    const sourceId = compactText(extraction.sourceId);
    if (sourceId.length > 0) {
      counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([sourceId]) => sourceId)
    .slice(0, 100);
}

function explicitSelectedSourceIds(store: ResearchWorkStore): string[] {
  return uniqueStrings(store.worker.evidence?.selectedSourceIds ?? [], 500);
}

function diagnosticSelectedSourceIds(store: ResearchWorkStore): string[] {
  return explicitSelectedSourceIds(store);
}

export function buildWorkspaceDispositionDiagnostics(
  store: ResearchWorkStore,
  options: { renderedReferenceSourceIds?: string[] } = {}
): ResearchWorkspaceDispositionDiagnostics {
  const selectedSourceIds = diagnosticSelectedSourceIds(store);
  const activeExtractions = store.objects.extractions.filter(researchObjectIsActive);
  const activeEvidenceCells = store.objects.evidenceCells.filter(researchObjectIsActive);
  const activeCitations = store.objects.citations.filter(researchObjectIsActive);
  const extractedSourceIds = uniqueStrings(activeExtractions.map((extraction) => extraction.sourceId), 500);
  const evidenceCellSourceIds = uniqueStrings(activeEvidenceCells.map((cell) => cell.sourceId), 500);
  const claimSourceIds = uniqueStrings(store.objects.claims.flatMap((claim) => claim.sourceIds), 500);
  const citationSourceIds = uniqueStrings(activeCitations.map((citation) => citation.sourceId), 500);
  const renderedReferenceSourceIds = uniqueStrings(options.renderedReferenceSourceIds ?? citationSourceIds, 500);
  const extractedSourceIdSet = new Set(extractedSourceIds);
  const evidenceCellSourceIdSet = new Set(evidenceCellSourceIds);
  const citationSourceIdSet = new Set(citationSourceIds);
  const renderedReferenceSourceIdSet = new Set(renderedReferenceSourceIds);
  const missingSelectedExtractionSourceIds = selectedSourceIds
    .filter((sourceId) => !extractedSourceIdSet.has(sourceId))
    .slice(0, 100);
  const extractedNotEvidenceSourceIds = extractedSourceIds
    .filter((sourceId) => !evidenceCellSourceIdSet.has(sourceId))
    .slice(0, 100);
  const evidenceNotCitedSourceIds = evidenceCellSourceIds
    .filter((sourceId) => !citationSourceIdSet.has(sourceId))
    .slice(0, 100);
  const selectedToRenderedCollapseSourceIds = selectedSourceIds
    .filter((sourceId) => !renderedReferenceSourceIdSet.has(sourceId))
    .slice(0, 100);

  return {
    selectedSourceIds,
    extractedSourceIds,
    evidenceCellSourceIds,
    claimSourceIds,
    citationSourceIds,
    renderedReferenceSourceIds,
    missingSelectedExtractionSourceIds,
    duplicateExtractionSourceIds: duplicateSourceIdsForExtractions(activeExtractions),
    extractedNotEvidenceSourceIds,
    evidenceNotCitedSourceIds,
    selectedToRenderedCollapseSourceIds,
    selectedToRenderedCollapse: selectedSourceIds.length >= 4
      && renderedReferenceSourceIds.length * 2 < selectedSourceIds.length
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = compactText(value) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function buildResearchCorpusDiagnosticView(
  store: ResearchWorkStore,
  options: { renderedReferenceSourceIds?: string[] } = {}
): ResearchCorpusDiagnosticView {
  const disposition = buildWorkspaceDispositionDiagnostics(store, options);
  const selectedSourceIdSet = new Set(disposition.selectedSourceIds);
  const documentSourceIds = new Set(store.objects.documents.map((document) => document.sourceId));
  const parsedDocumentSourceIds = new Set(store.objects.documents
    .filter((document) => document.status === "parsed")
    .map((document) => document.sourceId));
  const chunkGroundedExtractionSourceIds = new Set(store.objects.extractions
    .filter((extraction) => researchObjectIsActive(extraction) && (extraction.documentChunkIds?.length ?? 0) > 0)
    .map((extraction) => extraction.sourceId));
  const fullTextSelectedSourceIds = store.objects.fullTextRecords
    .filter((record) => selectedSourceIdSet.has(record.sourceId) && record.fulltextAvailable)
    .map((record) => record.sourceId);

  return {
    diagnosticOnly: true,
    note: "Derived corpus bookkeeping only. The researcher and critic interpret what these counts mean for the research objective.",
    canonicalSourceCount: store.objects.canonicalSources.length,
    selectedSourceCount: disposition.selectedSourceIds.length,
    extractedSourceCount: disposition.extractedSourceIds.length,
    evidenceSourceCount: disposition.evidenceCellSourceIds.length,
    citationSourceCount: disposition.citationSourceIds.length,
    renderedReferenceSourceCount: disposition.renderedReferenceSourceIds.length,
    accessModeCounts: countBy(store.objects.canonicalSources.map((source) => source.accessMode)),
    screeningDecisionCounts: countBy(store.objects.canonicalSources.map((source) => source.screeningDecision)),
    providerRunCount: store.objects.providerRuns.length,
    sourceCandidateCount: store.objects.sources.length,
    documentCount: store.objects.documents.length,
    parsedDocumentCount: store.objects.documents.filter((document) => document.status === "parsed").length,
    documentChunkCount: store.objects.documentChunks.length,
    selectedFullTextNotFetchedSourceIds: fullTextSelectedSourceIds
      .filter((sourceId) => !documentSourceIds.has(sourceId))
      .slice(0, 40),
    selectedFullTextNotParsedSourceIds: fullTextSelectedSourceIds
      .filter((sourceId) => documentSourceIds.has(sourceId) && !parsedDocumentSourceIds.has(sourceId))
      .slice(0, 40),
    selectedSourcesWithoutChunkGroundedExtractionIds: disposition.selectedSourceIds
      .filter((sourceId) => !chunkGroundedExtractionSourceIds.has(sourceId))
      .slice(0, 40),
    evidenceCellsWithoutChunkGroundingIds: store.objects.evidenceCells
      .filter((cell) => researchObjectIsActive(cell) && (cell.documentChunkIds?.length ?? 0) === 0)
      .map((cell) => cell.id)
      .slice(0, 40),
    missingSelectedExtractionSourceIds: disposition.missingSelectedExtractionSourceIds.slice(0, 40),
    duplicateExtractionSourceIds: disposition.duplicateExtractionSourceIds.slice(0, 40),
    extractedNotEvidenceSourceIds: disposition.extractedNotEvidenceSourceIds.slice(0, 40),
    evidenceNotCitedSourceIds: disposition.evidenceNotCitedSourceIds.slice(0, 40),
    selectedToRenderedCollapseSourceIds: disposition.selectedToRenderedCollapseSourceIds.slice(0, 40)
  };
}

export function buildResearchSynthesisDiagnosticView(
  store: ResearchWorkStore,
  options: { renderedReferenceSourceIds?: string[] } = {}
): ResearchSynthesisDiagnosticView {
  const activeExtractions = store.objects.extractions.filter(researchObjectIsActive);
  const activeEvidenceCells = store.objects.evidenceCells.filter(researchObjectIsActive);
  const activeCitations = store.objects.citations.filter(researchObjectIsActive);
  const citationClaimIds = new Set(activeCitations.flatMap((citation) => citation.claimIds));
  const citationEvidenceCellIds = new Set(activeCitations.flatMap((citation) => citation.evidenceCellId === null ? [] : [citation.evidenceCellId]));
  const citationSectionIds = new Set(activeCitations.flatMap((citation) => citation.sectionIds));
  const disposition = buildWorkspaceDispositionDiagnostics(store, options);

  return {
    diagnosticOnly: true,
    note: "Derived synthesis/provenance bookkeeping only. This is not a scientific-quality verdict or hidden workflow gate.",
    activeExtractionCount: activeExtractions.length,
    activeEvidenceCellCount: activeEvidenceCells.length,
    activeCitationCount: activeCitations.length,
    claimCount: store.objects.claims.length,
    claimsWithCitationSupportCount: store.objects.claims.filter((claim) => citationClaimIds.has(claim.id)).length,
    claimsWithoutCitationSupportIds: store.objects.claims
      .filter((claim) => !citationClaimIds.has(claim.id))
      .map((claim) => claim.id)
      .slice(0, 40),
    manuscriptSectionCount: store.objects.manuscriptSections.length,
    sectionsWithClaimLinksCount: store.objects.manuscriptSections.filter((section) => section.claimIds.length > 0).length,
    sectionsWithoutClaimLinksIds: store.objects.manuscriptSections
      .filter((section) => section.claimIds.length === 0)
      .map((section) => section.id)
      .slice(0, 40),
    sectionsWithoutCitationLinksIds: store.objects.manuscriptSections
      .filter((section) => !citationSectionIds.has(section.id))
      .map((section) => section.id)
      .slice(0, 40),
    evidenceCellIdsWithoutCitationLinks: activeEvidenceCells
      .filter((cell) => !citationEvidenceCellIds.has(cell.id))
      .map((cell) => cell.id)
      .slice(0, 40),
    selectedSourceIdsNotCited: disposition.selectedToRenderedCollapseSourceIds.slice(0, 40)
  };
}

function notebookReadinessIsRecorded(readiness: string | null | undefined): boolean {
  const trimmed = typeof readiness === "string" ? readiness.trim() : "";
  return trimmed.length > 0 && trimmed !== defaultNotebookReadiness;
}

function researchContractMissingFields(contract: ResearchContract): string[] {
  return [
    contract.researchObjectives.length === 0 ? "researchObjectives" : null,
    contract.coveragePlan.length === 0 ? "coveragePlan" : null,
    contract.adequacyRationale.length === 0 ? "adequacyRationale" : null,
    contract.knownUncertainties.length === 0 ? "knownUncertainties" : null
  ].filter((field): field is string => field !== null);
}

function textUsesCountDominantCompletion(value: string): boolean {
  return /\b(?:at\s+least|minimum|no\s+fewer\s+than|>=)?\s*\d+\s+(?:papers?|sources?|citations?|references?|studies?|systems?|claims?|sections?)\b/i.test(value)
    || /\b(?:papers?|sources?|citations?|references?|studies?|systems?|claims?|sections?)\s*(?:>=|>|=)\s*\d+\b/i.test(value);
}

function researchContractIsCountDominant(contract: ResearchContract, legacyDefinitionOfDone: string[]): boolean {
  const texts = [
    ...contract.researchObjectives,
    ...contract.coveragePlan,
    ...contract.adequacyRationale,
    ...contract.knownUncertainties,
    ...legacyDefinitionOfDone
  ];
  const countBased = texts.filter(textUsesCountDominantCompletion).length;
  return countBased > 0
    && contract.adequacyRationale.length === 0
    && contract.knownUncertainties.length === 0;
}

function latestContractCriticReviewSummary(store: ResearchWorkStore): ResearchCriticReviewSummary | null {
  const summaries = criticReviewSummariesFromNotebook(store)
    .filter((summary) => summary.stage === "research_contract")
    .sort((left, right) => parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt));
  return summaries[0] ?? null;
}

export function buildNotebookDiagnostics(store: ResearchWorkStore): ResearchNotebookDiagnostics {
  const warnings: ResearchNotebookDiagnosticWarning[] = [];
  const activeTaskCount = store.notebook.tasks
    .filter((task) => task.status === "todo" || task.status === "in_progress" || task.status === "blocked")
    .length;
  const linkedIds = taskLinkedIds(store);
  const selectedSourceIds = diagnosticSelectedSourceIds(store);
  const unlinkedSelectedSourceIds = selectedSourceIds
    .filter((sourceId) => !linkedIds.sourceIds.has(sourceId))
    .slice(0, 20);
  const unlinkedEvidenceCellIds = store.objects.evidenceCells
    .map((cell) => cell.id)
    .filter((cellId) => !linkedIds.evidenceCellIds.has(cellId))
    .slice(0, 20);
  const unlinkedClaimIds = store.objects.claims
    .map((claim) => claim.id)
    .filter((claimId) => !linkedIds.claimIds.has(claimId))
    .slice(0, 20);
  const unlinkedSectionIds = store.objects.manuscriptSections
    .map((section) => section.id)
    .filter((sectionId) => !linkedIds.sectionIds.has(sectionId))
    .slice(0, 20);
  const disposition = buildWorkspaceDispositionDiagnostics(store);
  const missingResearchContractFields = researchContractMissingFields(store.notebook.researchContract);
  const researchContractComplete = missingResearchContractFields.length === 0;
  const contractReview = latestContractCriticReviewSummary(store);
  const researchContractCriticReviewed = contractReview !== null;
  const researchContractCriticFresh = contractReview !== null
    && parseTimestampMs(contractReview.createdAt) >= parseTimestampMs(store.notebook.researchContractUpdatedAt);
  const taskText = store.notebook.tasks
    .map((task) => `${task.title} ${task.notes ?? ""}`)
    .join(" ")
    .toLowerCase();
  const readinessText = store.notebook.readiness.toLowerCase();
  const definitionOfDoneMatches = store.notebook.definitionOfDone.map((criterion, index) => {
    const criterionNumber = index + 1;
    const explicitMarkerPattern = new RegExp(`\\b(?:dod|definition(?:\\s+of\\s+done)?(?:\\s+item)?)[\\s#:_-]*${criterionNumber}\\b`, "i");
    const mentioned = explicitMarkerPattern.test(taskText)
      || explicitMarkerPattern.test(readinessText)
      || (() => {
        const lower = criterion.toLowerCase();
        const prefix = lower.slice(0, Math.min(lower.length, 48));
        return prefix.length > 0 && (taskText.includes(prefix) || readinessText.includes(prefix));
      })();
    return {
      criterionNumber,
      mentioned
    };
  });
  const unmatchedDefinitionOfDoneNumbers = definitionOfDoneMatches
    .filter((entry) => !entry.mentioned)
    .map((entry) => entry.criterionNumber);
  const definitionOfDoneAddressed = store.notebook.definitionOfDone.length === 0
    || unmatchedDefinitionOfDoneNumbers.length === 0;
  const workspaceUpdatedAts = [
    ...store.objects.canonicalSources.map((entity) => entity.updatedAt),
    ...store.objects.extractions.map((entity) => entity.updatedAt),
    ...store.objects.evidenceCells.map((entity) => entity.updatedAt),
    ...store.objects.claims.map((entity) => entity.updatedAt),
    ...store.objects.citations.map((entity) => entity.updatedAt),
    ...store.objects.protocols.map((entity) => entity.updatedAt),
    ...store.objects.workItems.map((entity) => entity.updatedAt),
    ...store.objects.manuscriptSections.map((entity) => entity.updatedAt)
  ];
  const latestWorkspaceChangeAt = workspaceUpdatedAts
    .slice()
    .sort((left, right) => parseTimestampMs(right) - parseTimestampMs(left))[0] ?? null;
  const staleAfterWorkspaceChange = latestWorkspaceChangeAt !== null
    && parseTimestampMs(latestWorkspaceChangeAt) > parseTimestampMs(store.notebook.updatedAt);

  const addWarning = (code: string, message: string, count: number, suggestedActions: string[]): void => {
    warnings.push({ code, message, count, suggestedActions });
  };

  if (store.notebook.tasks.length === 0) {
    addWarning("notebook-empty-task-list", "Notebook has no model-authored task list.", 1, ["notebook.patch"]);
  }
  if (store.notebook.currentFocus === null) {
    addWarning("notebook-missing-current-focus", "Notebook currentFocus is not set.", 1, ["notebook.patch"]);
  }
  if (!notebookReadinessIsRecorded(store.notebook.readiness)) {
    addWarning("notebook-readiness-unwritten", "Research readiness has not been recorded by the model.", 1, ["notebook.patch"]);
  }
  if (!researchContractComplete) {
    addWarning(
      "notebook-research-contract-incomplete",
      `Model-authored research contract is missing: ${missingResearchContractFields.join(", ")}.`,
      missingResearchContractFields.length,
      ["notebook.read", "notebook.patch"]
    );
  }
  if (researchContractIsCountDominant(store.notebook.researchContract, store.notebook.definitionOfDone)) {
    addWarning(
      "notebook-research-contract-count-dominant",
      "Research contract appears count-dominant without adequacy rationale or uncertainty notes. Counts can be bookkeeping, but the researcher should record why the plan is substantively adequate.",
      1,
      ["notebook.patch", "critic.review"]
    );
  }
  if (!researchContractCriticReviewed) {
    addWarning(
      "notebook-research-contract-not-critic-reviewed",
      "No runtime-owned research_contract critic review is recorded for the model-authored research contract.",
      1,
      ["critic.review"]
    );
  } else if (!researchContractCriticFresh) {
    addWarning(
      "notebook-research-contract-review-stale",
      "Research contract was changed after the latest research_contract critic review.",
      1,
      ["critic.review"]
    );
  }
  if (store.notebook.definitionOfDone.length > 0 && !definitionOfDoneAddressed) {
    addWarning(
      "notebook-definition-of-done-unaddressed",
      store.notebook.definitionOfDone.length === 0
        ? "Notebook has no definition of done."
        : `Notebook readiness/tasks do not explicitly address definition-of-done item(s): ${unmatchedDefinitionOfDoneNumbers.join(", ")}. Reference each item with DoD-1, DoD-2, etc. or include the criterion text in task notes/readiness.`,
      unmatchedDefinitionOfDoneNumbers.length || store.notebook.definitionOfDone.length,
      ["notebook.read", "notebook.patch"]
    );
  }
  if (unlinkedSelectedSourceIds.length > 0) {
    addWarning("notebook-selected-sources-unlinked", `${unlinkedSelectedSourceIds.length} selected source(s) are not linked to notebook tasks.`, unlinkedSelectedSourceIds.length, ["notebook.patch", "workspace.list"]);
  }
  if (unlinkedEvidenceCellIds.length > 0) {
    addWarning("notebook-evidence-unlinked", `${unlinkedEvidenceCellIds.length} evidence cell(s) are not linked to notebook tasks.`, unlinkedEvidenceCellIds.length, ["notebook.patch", "workspace.list"]);
  }
  if (unlinkedClaimIds.length > 0) {
    addWarning("notebook-claims-unlinked", `${unlinkedClaimIds.length} claim(s) are not linked to notebook tasks.`, unlinkedClaimIds.length, ["notebook.patch", "workspace.list"]);
  }
  if (unlinkedSectionIds.length > 0) {
    addWarning("notebook-sections-unlinked", `${unlinkedSectionIds.length} manuscript section(s) are not linked to notebook tasks.`, unlinkedSectionIds.length, ["notebook.patch", "workspace.list"]);
  }
  if (staleAfterWorkspaceChange) {
    addWarning("notebook-stale-after-workspace-change", "Notebook was not updated after the latest state-changing workspace action.", 1, ["notebook.read", "notebook.patch"]);
  }
  if (disposition.missingSelectedExtractionSourceIds.length > 0) {
    addWarning("workspace-selected-extractions-missing", `${disposition.missingSelectedExtractionSourceIds.length} selected source(s) do not have structured extractions.`, disposition.missingSelectedExtractionSourceIds.length, ["workspace.list", "extraction.create"]);
  }
  if (disposition.duplicateExtractionSourceIds.length > 0) {
    addWarning("workspace-duplicate-extractions", `${disposition.duplicateExtractionSourceIds.length} source(s) have duplicate extraction records.`, disposition.duplicateExtractionSourceIds.length, ["workspace.list", "workspace.read"]);
  }
  if (disposition.extractedNotEvidenceSourceIds.length > 0) {
    addWarning("workspace-extracted-not-evidence", `${disposition.extractedNotEvidenceSourceIds.length} extracted source(s) do not have evidence cells.`, disposition.extractedNotEvidenceSourceIds.length, ["workspace.list", "evidence.create_cell"]);
  }
  if (disposition.evidenceNotCitedSourceIds.length > 0) {
    addWarning("workspace-evidence-not-cited", `${disposition.evidenceNotCitedSourceIds.length} evidence-cell source(s) are not cited by support links.`, disposition.evidenceNotCitedSourceIds.length, ["workspace.list", "claim.link_support"]);
  }
  if (disposition.selectedToRenderedCollapse) {
    addWarning("workspace-selected-to-rendered-collapse", `${disposition.selectedSourceIds.length} selected source(s) collapse to ${disposition.renderedReferenceSourceIds.length} rendered reference source(s).`, disposition.selectedToRenderedCollapseSourceIds.length, ["workspace.list", "claim.link_support", "section.patch"]);
  }

  return {
    warningCount: warnings.length,
    warnings,
    taskCount: store.notebook.tasks.length,
    activeTaskCount,
    readinessRecorded: notebookReadinessIsRecorded(store.notebook.readiness),
    currentFocusSet: store.notebook.currentFocus !== null,
    researchContractComplete,
    researchContractCriticReviewed,
    researchContractCriticFresh,
    definitionOfDoneAddressed,
    unlinkedSelectedSourceIds,
    unlinkedEvidenceCellIds,
    unlinkedClaimIds,
    unlinkedSectionIds,
    staleAfterWorkspaceChange,
    latestWorkspaceChangeAt,
    disposition
  };
}

function criticReviewSummaryFromArtifactLink(artifact: ResearchNotebookArtifactLink): ResearchCriticReviewSummary | null {
  const match = /^Critic review: ([a-z_]+) \((pass|revise|block)\)$/i.exec(artifact.label);
  if (match === null) {
    return null;
  }

  return {
    stage: match[1]?.toLowerCase() ?? "release",
    readiness: match[2]?.toLowerCase() ?? "revise",
    artifactPath: artifact.path,
    createdAt: artifact.createdAt
  };
}

function criticReviewSummariesFromNotebook(store: ResearchWorkStore): ResearchCriticReviewSummary[] {
  return store.notebook.artifactLinks
    .flatMap((artifact) => {
      const summary = criticReviewSummaryFromArtifactLink(artifact);
      return summary === null ? [] : [summary];
    })
    .slice(-8);
}

export function buildWorkspacePromptContextFromWorkStore(store: ResearchWorkStore): WorkspacePromptContext {
  const openWorkItems = store.objects.workItems.filter((item) => item.status === "open");
  const notebookDiagnostics = buildNotebookDiagnostics(store);
  const activeTasks = store.notebook.tasks
    .filter((task) => task.status === "todo" || task.status === "in_progress" || task.status === "blocked")
    .slice(0, 20)
    .map((task) => ({
	      id: task.id,
	      title: task.title,
	      status: task.status,
	      linkedSourceIds: task.linkedSourceIds.slice(),
	      linkedEvidenceCellIds: task.linkedEvidenceCellIds.slice(),
	      linkedClaimIds: task.linkedClaimIds.slice(),
	      linkedSectionIds: task.linkedSectionIds.slice(),
	      linkedArtifactPaths: task.linkedArtifactPaths.slice()
	    }));

  return {
    available: store.objects.canonicalSources.length > 0
      || store.objects.claims.length > 0
      || store.objects.evidenceCells.length > 0
      || store.objects.workItems.length > 0
      || store.notebook.tasks.length > 0,
    counts: {
      providerRuns: store.objects.providerRuns.length,
      sources: store.objects.sources.length,
      canonicalSources: store.objects.canonicalSources.length,
      screeningDecisions: store.objects.screeningDecisions.length,
      fullTextRecords: store.objects.fullTextRecords.length,
      documents: store.objects.documents.length,
      documentChunks: store.objects.documentChunks.length,
      extractions: store.objects.extractions.length,
      evidenceCells: store.objects.evidenceCells.length,
      claims: store.objects.claims.length,
      citations: store.objects.citations.length,
      protocols: store.objects.protocols.length,
      workItems: store.objects.workItems.length,
      openWorkItems: openWorkItems.length,
      manuscriptSections: store.objects.manuscriptSections.length,
      releaseChecks: store.objects.releaseChecks.length
    },
    corpus_view: buildResearchCorpusDiagnosticView(store),
    synthesis_view: buildResearchSynthesisDiagnosticView(store),
	    notebook: {
	      artifactType: store.notebook.artifactType,
	      objective: store.notebook.objective,
	      researchContract: {
	        researchObjectives: store.notebook.researchContract.researchObjectives.slice(0, 12),
	        coveragePlan: store.notebook.researchContract.coveragePlan.slice(0, 12),
	        adequacyRationale: store.notebook.researchContract.adequacyRationale.slice(0, 12),
	        knownUncertainties: store.notebook.researchContract.knownUncertainties.slice(0, 12)
	      },
	      legacyDefinitionOfDone: store.notebook.definitionOfDone.slice(0, 12),
	      currentFocus: store.notebook.currentFocus,
	      readiness: store.notebook.readiness,
	      activeTasks,
	      artifactLinks: store.notebook.artifactLinks.slice(-12).map((artifact) => ({ ...artifact })),
	      recentCriticReviews: criticReviewSummariesFromNotebook(store),
	      diagnostics: notebookDiagnostics
	    },
    recentSources: store.objects.canonicalSources.slice(-12).map((source) => ({
      id: source.id,
      title: source.title,
      citation: source.citation,
      year: source.year,
      venue: source.venue,
      providerIds: source.providerIds,
      accessMode: source.accessMode,
      screeningDecision: source.screeningDecision
    })),
    recentExtractions: store.objects.extractions.slice(-12).map((extraction) => ({
      id: extraction.id,
      sourceId: extraction.sourceId,
      status: researchObjectLifecycleStatus(extraction),
      supersededBy: extraction.supersededBy ?? null,
      problemSetting: extraction.extraction.problemSetting,
      systemType: extraction.extraction.systemType,
      confidence: extraction.extraction.confidence
    })),
    recentEvidenceCells: store.objects.evidenceCells.slice(-16).map((cell) => ({
      id: cell.id,
      sourceId: cell.sourceId,
      extractionId: cell.extractionId,
      status: researchObjectLifecycleStatus(cell),
      supersededBy: cell.supersededBy ?? null,
      field: cell.field,
      value: cell.value,
      confidence: cell.confidence
    })),
    recentClaims: store.objects.claims.slice(-16).map((claim) => {
      const citationIds = store.objects.citations
        .filter((citation) => researchObjectIsActive(citation) && citation.claimIds.includes(claim.id))
        .map((citation) => citation.id);
      return {
        id: claim.id,
        text: claim.text,
        supportStatus: claim.supportStatus,
        confidence: claim.confidence,
        sourceIds: claim.sourceIds,
        citationIds
      };
    }),
    recentSections: store.objects.manuscriptSections.slice(-10).map((section) => {
      const citationIds = store.objects.citations
        .filter((citation) => researchObjectIsActive(citation) && citation.sectionIds.includes(section.id))
        .map((citation) => citation.id);
      return {
        id: section.id,
        title: section.title,
        status: section.status,
        orderIndex: section.orderIndex ?? null,
        claimIds: section.claimIds,
        citationIds
      };
    }),
    openWorkItems: openWorkItems.slice(-16).map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      severity: item.severity,
      suggestedActions: item.suggestedActions,
      targetId: item.targetId,
      affectedSourceIds: item.affectedSourceIds,
      affectedClaimIds: item.affectedClaimIds
    })),
    recentReleaseChecks: store.objects.releaseChecks.slice(-8).map((check) => ({
      id: check.id,
      title: check.title,
      status: check.status,
      message: check.message,
      updatedAt: check.updatedAt
    })),
    worker: {
      status: store.worker.status,
      statusReason: store.worker.statusReason,
      nextInternalActions: store.worker.nextInternalActions,
      completion: store.worker.completion,
      lastRunId: store.worker.lastRunId
    }
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
  const notebookHasPriorContent = store.notebook.tasks.length > 0
    || store.notebook.notes.length > 0
    || store.notebook.artifactLinks.length > 0
    || store.notebook.readiness !== defaultNotebookReadiness;
  const notebooks = notebookHasPriorContent ? [{
    id: "research-notebook",
    title: store.notebook.objective,
    summary: store.notebook.readiness,
    nextQuestions: store.notebook.tasks
      .filter((task) => task.status === "todo" || task.status === "in_progress" || task.status === "blocked")
      .map((task) => task.title)
      .slice(0, 8)
  }] : [];

  return {
    available: papers.length > 0 || themes.length > 0 || notebooks.length > 0,
    paperCount: store.objects.canonicalSources.length,
    themeCount: themes.length,
    notebookCount: notebooks.length,
    papers,
    themes,
    notebooks
  };
}

export type ResearchWorkStoreSummary = {
  providerRuns: number;
  sources: number;
  protocols: number;
  canonicalSources: number;
  documents: number;
  documentChunks: number;
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
    documents: store.objects.documents.length,
    documentChunks: store.objects.documentChunks.length,
    extractions: store.objects.extractions.length,
    evidenceCells: store.objects.evidenceCells.length,
    claims: store.objects.claims.length,
    openWorkItems: store.objects.workItems.filter((item) => item.status === "open").length,
    releaseChecks: store.objects.releaseChecks.length
  };
}
