import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CanonicalPaper, LiteratureContext } from "./literature-store.js";
import type { ProjectMemoryContext, MemoryRecordType } from "./memory-store.js";
import type {
  ManuscriptBundle,
  ManuscriptCheck
} from "./research-manuscript.js";
import type { ResearchAgenda, ResearchPlan, ResearchSynthesis } from "./research-backend.js";
import type { CriticReviewArtifact, CriticReviewStage } from "./research-critic.js";
import type { EvidenceMatrix, EvidenceMatrixRow, PaperExtraction } from "./research-evidence.js";
import type { ResearchSource, ResearchSourceGatherResult } from "./research-sources.js";
import type { ResearchBrief } from "./session-store.js";
import { runtimeDirectoryPath as runtimeDir } from "./session-store.js";
import type { RunRecord } from "./run-store.js";
import type { VerificationReport } from "./verifier.js";

const workStoreSchemaVersion = 1;
const workStoreFileName = "research-work-store.json";

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
  claimIds: string[];
  sectionIds: string[];
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
  source: "critic" | "checks" | "agenda" | "synthesis" | "runtime";
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
  workItems: WorkStoreWorkItem[];
  manuscriptSections: WorkStoreManuscriptSection[];
  releaseChecks: WorkStoreReleaseCheck[];
};

export type ResearchWorkStore = {
  schemaVersion: 1;
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
};

export type WorkStoreQueryResult<T extends WorkStoreEntity = WorkStoreEntity> = {
  collection: WorkStoreCollectionName;
  count: number;
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
    userBlockers: []
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
    userBlockers: readStringArray(record.userBlockers, 40)
  };
}

function isResearchWorkerStatus(value: string | null): value is ResearchWorkerStatus {
  switch (value) {
    case "not_started":
    case "working":
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

function matchesSemanticQuery(entity: WorkStoreEntity, semanticQuery: string | null | undefined): boolean {
  const query = compactText(semanticQuery ?? "").toLowerCase();
  if (query.length === 0) {
    return true;
  }

  const terms = query.split(/\s+/).filter((term) => term.length >= 3);
  if (terms.length === 0) {
    return true;
  }

  const haystack = entityText(entity);
  return terms.every((term) => haystack.includes(term));
}

export function researchWorkStoreFilePath(projectRoot: string): string {
  return path.join(runtimeDir(projectRoot), workStoreFileName);
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

export async function loadResearchWorkStore(input: {
  projectRoot: string;
  brief?: ResearchBrief | null;
  now: string;
}): Promise<ResearchWorkStore> {
  try {
    const raw = JSON.parse(await readFile(researchWorkStoreFilePath(input.projectRoot), "utf8")) as unknown;
    const record = asObject(raw);
    return {
      schemaVersion: workStoreSchemaVersion,
      projectRoot: input.projectRoot,
      runtimeDirectory: runtimeDir(input.projectRoot),
      createdAt: normalizeTimestamp(record.createdAt, input.now),
      updatedAt: normalizeTimestamp(record.updatedAt, input.now),
      brief: input.brief ?? normalizeBrief(record.brief),
      worker: normalizeWorker(record.worker, input.now),
      objects: normalizeObjects(record.objects)
    };
  } catch {
    return createResearchWorkStore(input);
  }
}

export async function writeResearchWorkStore(store: ResearchWorkStore): Promise<void> {
  await mkdir(runtimeDir(store.projectRoot), { recursive: true });
  await writeFile(researchWorkStoreFilePath(store.projectRoot), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function queryResearchWorkStore<T extends WorkStoreEntity = WorkStoreEntity>(
  store: ResearchWorkStore,
  query: WorkStoreQuery
): WorkStoreQueryResult<T> {
  const limit = Math.max(1, Math.min(500, query.limit ?? 50));
  const items = collectionFor(store, query.collection)
    .filter((entity) => matchesFilters(entity, query.filters))
    .filter((entity) => matchesSemanticQuery(entity, query.semanticQuery))
    .slice(0, limit) as T[];

  return {
    collection: query.collection,
    count: items.length,
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

function providerRunsFromGathered(run: RunRecord, gathered: ResearchSourceGatherResult | null, now: string): WorkStoreProviderRun[] {
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

function evidenceCellsFromMatrix(run: RunRecord, matrix: EvidenceMatrix, now: string): WorkStoreEvidenceCell[] {
  const fields: WorkStoreEvidenceCell["field"][] = [
    "problemSetting",
    "systemType",
    "architecture",
    "toolsAndMemory",
    "planningStyle",
    "evaluationSetup",
    "successSignals",
    "failureModes",
    "limitations",
    "confidence"
  ];

  return matrix.rows.flatMap((row) => fields.map((field) => ({
    id: stableId("evidence-cell", [run.id, row.paperId, row.extractionId, field]),
    kind: "evidenceCell" as const,
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    sourceId: row.paperId,
    extractionId: row.extractionId,
    field,
    value: row[field],
    confidence: row.confidence
  })));
}

function targetKindFromCriticTarget(target: string): WorkStoreWorkItem["targetKind"] {
  switch (target) {
    case "source_selection":
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

function workItemsFromCriticReports(run: RunRecord, reports: CriticReviewArtifact[], now: string): WorkStoreWorkItem[] {
  return reports.flatMap((report) => report.objections.map((objection, index) => ({
    id: stableId("work-item", [run.id, "critic", report.stage, objection.code, index]),
    kind: "workItem",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    type: "critic_objection",
    status: report.readiness === "pass" ? "resolved" : "open",
    severity: objection.severity,
    title: `${criticStageLabel(report.stage)} critic: ${objection.code}`,
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

function criticStageLabel(stage: CriticReviewStage): string {
  return stage.replace(/_/g, " ");
}

function workItemSeverityFromCheck(check: ManuscriptCheck): WorkItemSeverity {
  return check.severity === "blocker" ? "blocking" : check.severity === "warning" ? "minor" : "minor";
}

function workItemTypeFromCheck(check: ManuscriptCheck): WorkItemType {
  if (/citation|claim|support/i.test(`${check.id} ${check.title}`)) {
    return "unsupported_claim";
  }

  if (/evidence|source|paper|facet|matrix/i.test(`${check.id} ${check.title}`)) {
    return "evidence_gap";
  }

  return "manuscript_revision";
}

function workItemsFromChecks(run: RunRecord, bundle: ManuscriptBundle | null, now: string): WorkStoreWorkItem[] {
  return (bundle?.checks.checks ?? [])
    .filter((check) => check.status !== "pass")
    .map((check) => ({
      id: stableId("work-item", [run.id, "check", check.id]),
      kind: "workItem",
      runId: run.id,
      createdAt: now,
      updatedAt: now,
      type: workItemTypeFromCheck(check),
      status: "open",
      severity: workItemSeverityFromCheck(check),
      title: check.title,
      description: check.message,
      targetKind: "release",
      targetId: check.id,
      affectedSourceIds: [],
      affectedClaimIds: [],
      suggestedActions: [check.message],
      source: "checks"
    }));
}

function workItemsFromAgendaAndSynthesis(
  run: RunRecord,
  agenda: ResearchAgenda | null,
  synthesis: ResearchSynthesis | null,
  now: string
): WorkStoreWorkItem[] {
  const holdItems = (agenda?.holdReasons ?? []).map((reason, index) => ({
    id: stableId("work-item", [run.id, "agenda", index, reason]),
    kind: "workItem" as const,
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    type: externalBlockerText(reason) ? "external_blocker" as const : "evidence_gap" as const,
    status: "open" as const,
    severity: externalBlockerText(reason) ? "blocking" as const : "major" as const,
    title: externalBlockerText(reason) ? "External research blocker" : "Evidence work item",
    description: reason,
    targetKind: "agenda" as const,
    targetId: null,
    affectedSourceIds: [],
    affectedClaimIds: [],
    suggestedActions: [agenda?.recommendedHumanDecision ?? reason],
    source: "agenda" as const
  }));
  const questionItems = (synthesis?.nextQuestions ?? []).map((question, index) => ({
    id: stableId("work-item", [run.id, "question", index, question]),
    kind: "workItem" as const,
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    type: "open_question" as const,
    status: "open" as const,
    severity: "minor" as const,
    title: "Open research question",
    description: question,
    targetKind: "unknown" as const,
    targetId: null,
    affectedSourceIds: [],
    affectedClaimIds: [],
    suggestedActions: [question],
    source: "synthesis" as const
  }));

  return [...holdItems, ...questionItems];
}

function externalBlockerText(text: string): boolean {
  return /\b(credential|api key|quota|rate limit|paywall|permission|access denied|forbidden|unauthori[sz]ed|license|tdm|missing required)\b/i.test(text);
}

function releaseCheckEntities(run: RunRecord, bundle: ManuscriptBundle | null, now: string): WorkStoreReleaseCheck[] {
  return (bundle?.checks.checks ?? []).map((check) => ({
    id: stableId("release-check", [run.id, check.id]),
    kind: "releaseCheck",
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    checkId: check.id,
    title: check.title,
    status: check.status,
    severity: check.severity,
    message: check.message
  }));
}

export function mergeRunSegmentIntoResearchWorkStore(
  store: ResearchWorkStore,
  input: {
    run: RunRecord;
    plan: ResearchPlan;
    gathered: ResearchSourceGatherResult | null;
    paperExtractions: PaperExtraction[];
    evidenceMatrix: EvidenceMatrix | null;
    synthesis: ResearchSynthesis | null;
    verification: VerificationReport | null;
    agenda: ResearchAgenda | null;
    manuscriptBundle: ManuscriptBundle | null;
    criticReports: CriticReviewArtifact[];
    now: string;
  }
): ResearchWorkStore {
  const { run, gathered, paperExtractions, evidenceMatrix, synthesis, agenda, manuscriptBundle, criticReports, now } = input;
  const canonicalPapers = gathered?.canonicalPapers ?? [];
  const entities: WorkStoreEntity[] = [
    ...providerRunsFromGathered(run, gathered, now),
    ...(gathered?.sources ?? []).map((source) => sourceFromResearchSource(run, source, now)),
    ...canonicalPapers.map((paper) => canonicalSourceFromPaper(run, paper, now)),
    ...canonicalPapers.flatMap((paper) => screeningDecisionsFromPaper(run, paper, now)),
    ...canonicalPapers.map((paper) => fullTextRecordFromPaper(run, paper, now)),
    ...paperExtractions.map((extraction) => extractionEntity(run, extraction, now)),
    ...(evidenceMatrix === null ? [] : evidenceCellsFromMatrix(run, evidenceMatrix, now)),
    ...workItemsFromCriticReports(run, criticReports, now),
    ...workItemsFromChecks(run, manuscriptBundle, now),
    ...workItemsFromAgendaAndSynthesis(run, agenda, synthesis, now),
    ...releaseCheckEntities(run, manuscriptBundle, now)
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
    direction: store.objects.workItems.filter((item) => item.source === "agenda").length,
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
      .filter((item) => item.source === "agenda")
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
  canonicalSources: number;
  extractions: number;
  evidenceCells: number;
  claims: number;
  openWorkItems: number;
  releaseChecks: number;
};

export function summarizeResearchWorkStore(store: ResearchWorkStore): ResearchWorkStoreSummary {
  return {
    canonicalSources: store.objects.canonicalSources.length,
    extractions: store.objects.extractions.length,
    evidenceCells: store.objects.evidenceCells.length,
    claims: store.objects.claims.length,
    openWorkItems: store.objects.workItems.filter((item) => item.status === "open").length,
    releaseChecks: store.objects.releaseChecks.length
  };
}
