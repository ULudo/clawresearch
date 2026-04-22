import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResearchBrief } from "./session-store.js";
import { runtimeDirectoryPath } from "./session-store.js";

const memorySchemaVersion = 2;
const memoryFileName = "memory.json";

export type MemoryRecordType =
  | "claim"
  | "finding"
  | "question"
  | "idea"
  | "summary"
  | "artifact"
  | "direction"
  | "hypothesis"
  | "method_plan";

export type MemoryLinkType =
  | "supported_by"
  | "derived_from"
  | "raises"
  | "refines"
  | "summarizes"
  | "contains"
  | "related_to"
  | "depends_on";

export type MemoryLinkTargetKind =
  | "memory"
  | "paper"
  | "theme"
  | "notebook";

export type MemoryLink = {
  type: MemoryLinkType;
  targetKind: MemoryLinkTargetKind;
  targetId: string;
};

export type MemoryDataValue = string | string[] | null;
export type MemoryData = Record<string, MemoryDataValue>;

export type MemoryRecord = {
  id: string;
  type: MemoryRecordType;
  key: string;
  title: string;
  text: string;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  links: MemoryLink[];
  data: MemoryData;
};

export type MemoryRecordInput = {
  type: MemoryRecordType;
  key: string;
  title: string;
  text: string;
  runId: string | null;
  links?: MemoryLink[];
  data?: MemoryData;
};

export type MemoryState = {
  schemaVersion: number;
  projectRoot: string;
  runtimeDirectory: string;
  createdAt: string;
  updatedAt: string;
  recordCount: number;
  records: MemoryRecord[];
};

export type MemoryUpsertResult = {
  inserted: number;
  updated: number;
  memory: MemoryState;
  records: MemoryRecord[];
};

export type ProjectMemoryContextEntry = {
  id: string;
  title: string;
  text: string;
  runId: string | null;
  links: MemoryLink[];
  data: MemoryData;
};

export type ProjectMemoryContext = {
  available: boolean;
  recordCount: number;
  countsByType: Record<MemoryRecordType, number>;
  claims: ProjectMemoryContextEntry[];
  findings: ProjectMemoryContextEntry[];
  questions: ProjectMemoryContextEntry[];
  ideas: ProjectMemoryContextEntry[];
  summaries: ProjectMemoryContextEntry[];
  artifacts: ProjectMemoryContextEntry[];
  directions: ProjectMemoryContextEntry[];
  hypotheses: ProjectMemoryContextEntry[];
  methodPlans: ProjectMemoryContextEntry[];
  queryHints: string[];
  localFileHints: string[];
};

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => readString(entry) ?? []);
}

function normalizeDataValue(value: unknown): MemoryDataValue {
  if (value === null) {
    return null;
  }

  const stringValue = readString(value);

  if (stringValue !== null) {
    return stringValue;
  }

  const stringArray = readStringArray(value);
  return stringArray.length > 0 ? stringArray : null;
}

function normalizeData(value: unknown): MemoryData {
  const data = asObject(value);
  const normalized: MemoryData = {};

  for (const [key, entry] of Object.entries(data)) {
    const normalizedValue = normalizeDataValue(entry);

    if (normalizedValue !== null) {
      normalized[key] = normalizedValue;
    }
  }

  return normalized;
}

function normalizeLink(raw: unknown): MemoryLink | null {
  const link = asObject(raw);
  const type = readString(link.type);
  const targetKind = readString(link.targetKind);
  const targetId = readString(link.targetId);

  if (type === null || targetKind === null || targetId === null) {
    return null;
  }

  switch (type) {
    case "supported_by":
    case "derived_from":
    case "raises":
    case "refines":
    case "summarizes":
    case "contains":
    case "related_to":
    case "depends_on":
      switch (targetKind) {
        case "memory":
        case "paper":
        case "theme":
        case "notebook":
          return {
            type,
            targetKind,
            targetId
          };
        default:
          return null;
      }
    default:
      return null;
  }
}

function normalizeLinks(value: unknown): MemoryLink[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeLinks(
    value.flatMap((entry) => {
      const link = normalizeLink(entry);
      return link === null ? [] : [link];
    })
  );
}

function normalizeInputLinks(links: MemoryLink[]): MemoryLink[] {
  return dedupeLinks(
    links.flatMap((link) => {
      const normalized = normalizeLink(link);
      return normalized === null ? [] : [normalized];
    })
  );
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter((token) => token.length >= 4);
}

function hashString(text: string): string {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

export function createMemoryRecordId(type: MemoryRecordType, key: string): string {
  return `${type}-${hashString(`${type}:${normalizeText(key)}`)}`;
}

function dedupeLinks(links: MemoryLink[]): MemoryLink[] {
  const seen = new Set<string>();
  const normalized: MemoryLink[] = [];

  for (const link of links) {
    const identity = `${link.type}:${link.targetId}`;

    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    normalized.push(link);
  }

  return normalized;
}

function memoryStatePath(projectRoot: string): string {
  return path.join(runtimeDirectoryPath(projectRoot), memoryFileName);
}

export function memoryFilePath(projectRoot: string): string {
  return memoryStatePath(projectRoot);
}

function createEmptyMemoryState(projectRoot: string, timestamp: string): MemoryState {
  return {
    schemaVersion: memorySchemaVersion,
    projectRoot,
    runtimeDirectory: runtimeDirectoryPath(projectRoot),
    createdAt: timestamp,
    updatedAt: timestamp,
    recordCount: 0,
    records: []
  };
}

function normalizeRecord(raw: unknown): MemoryRecord | null {
  const record = asObject(raw);
  const type = readString(record.type);
  const key = readString(record.key);
  const title = readString(record.title);
  const text = readString(record.text);

  if (
    type === null
    || key === null
    || title === null
    || text === null
  ) {
    return null;
  }

  switch (type) {
    case "claim":
    case "finding":
    case "question":
    case "idea":
    case "summary":
    case "artifact":
    case "direction":
    case "hypothesis":
    case "method_plan":
      return {
        id: readString(record.id) ?? createMemoryRecordId(type, key),
        type,
        key: normalizeText(key),
        title: normalizeText(title),
        text: normalizeText(text),
        runId: readString(record.runId),
        createdAt: readString(record.createdAt) ?? new Date().toISOString(),
        updatedAt: readString(record.updatedAt) ?? new Date().toISOString(),
        links: normalizeLinks(record.links),
        data: normalizeData(record.data)
      };
    default:
      return null;
  }
}

function mergeMemoryState(raw: unknown, projectRoot: string, timestamp: string): MemoryState {
  const record = asObject(raw);
  const base = createEmptyMemoryState(projectRoot, timestamp);
  const rawRecords = Array.isArray(record.records) ? record.records : [];
  const records = rawRecords.flatMap((entry) => {
    const normalized = normalizeRecord(entry);
    return normalized === null ? [] : [normalized];
  });

  return {
    schemaVersion: memorySchemaVersion,
    projectRoot,
    runtimeDirectory: runtimeDirectoryPath(projectRoot),
    createdAt: readString(record.createdAt) ?? base.createdAt,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    recordCount: records.length,
    records
  };
}

function normalizeRecordInput(record: MemoryRecordInput): MemoryRecordInput | null {
  const key = normalizeText(record.key);
  const title = normalizeText(record.title);
  const text = normalizeText(record.text);

  if (key.length === 0 || title.length === 0 || text.length === 0) {
    return null;
  }

  return {
    type: record.type,
    key,
    title,
    text,
    runId: record.runId,
    links: normalizeInputLinks(record.links ?? []),
    data: normalizeData(record.data ?? {})
  };
}

function mergeData(existing: MemoryData, incoming: MemoryData): MemoryData {
  const merged: MemoryData = {
    ...existing
  };

  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = value;
  }

  return merged;
}

async function writeMemoryFile(projectRoot: string, memory: MemoryState): Promise<void> {
  await mkdir(runtimeDirectoryPath(projectRoot), { recursive: true });
  await writeFile(memoryStatePath(projectRoot), `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

export function countMemoryRecordsByType(memory: MemoryState): Record<MemoryRecordType, number> {
  const counts: Record<MemoryRecordType, number> = {
    claim: 0,
    finding: 0,
    question: 0,
    idea: 0,
    summary: 0,
    artifact: 0,
    direction: 0,
    hypothesis: 0,
    method_plan: 0
  };

  for (const record of memory.records) {
    counts[record.type] += 1;
  }

  return counts;
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
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = typeof value === "string"
      ? normalizeText(value)
      : "";

    if (normalized.length === 0) {
      continue;
    }

    seen.add(normalized);
  }

  return [...seen];
}

function contextEntry(record: MemoryRecord): ProjectMemoryContextEntry {
  return {
    id: record.id,
    title: record.title,
    text: record.text,
    runId: record.runId,
    links: record.links,
    data: record.data
  };
}

function selectRelevantEntries(
  records: MemoryRecord[],
  type: MemoryRecordType,
  briefTokens: Set<string>,
  limit: number
): ProjectMemoryContextEntry[] {
  return records
    .filter((record) => record.type === type)
    .sort((left, right) => {
      const leftScore = overlapScore(`${left.title} ${left.text}`, briefTokens);
      const rightScore = overlapScore(`${right.title} ${right.text}`, briefTokens);

      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit)
    .map(contextEntry);
}

export function buildProjectMemoryContext(
  memory: MemoryState,
  brief: ResearchBrief,
  perTypeLimit = 4
): ProjectMemoryContext {
  const briefTokens = new Set([
    ...tokenize(brief.topic ?? ""),
    ...tokenize(brief.researchQuestion ?? ""),
    ...tokenize(brief.researchDirection ?? ""),
    ...tokenize(brief.successCriterion ?? "")
  ]);
  const countsByType = countMemoryRecordsByType(memory);
  const claims = selectRelevantEntries(memory.records, "claim", briefTokens, perTypeLimit);
  const findings = selectRelevantEntries(memory.records, "finding", briefTokens, perTypeLimit);
  const questions = selectRelevantEntries(memory.records, "question", briefTokens, perTypeLimit);
  const ideas = selectRelevantEntries(memory.records, "idea", briefTokens, perTypeLimit);
  const summaries = selectRelevantEntries(memory.records, "summary", briefTokens, Math.max(2, perTypeLimit - 1));
  const artifacts = selectRelevantEntries(memory.records, "artifact", briefTokens, perTypeLimit + 2);
  const directions = selectRelevantEntries(memory.records, "direction", briefTokens, perTypeLimit);
  const hypotheses = selectRelevantEntries(memory.records, "hypothesis", briefTokens, perTypeLimit);
  const methodPlans = selectRelevantEntries(memory.records, "method_plan", briefTokens, perTypeLimit);
  const queryHints = uniqueStrings([
    ...questions.map((entry) => entry.title),
    ...ideas.map((entry) => entry.title),
    ...directions.map((entry) => entry.title),
    ...hypotheses.map((entry) => entry.title),
    ...methodPlans.map((entry) => entry.title),
    ...findings.map((entry) => entry.title),
    ...claims.map((entry) => entry.title),
    ...summaries.map((entry) => entry.text)
  ]).slice(0, 8);
  const localFileHints = uniqueStrings([
    ...artifacts.flatMap((entry) => {
      const dataPath = entry.data.path;

      if (typeof dataPath === "string" && !dataPath.startsWith(".clawresearch/")) {
        return [dataPath];
      }

      return [];
    })
  ]).slice(0, 8);

  return {
    available: memory.recordCount > 0,
    recordCount: memory.recordCount,
    countsByType,
    claims,
    findings,
    questions,
    ideas,
    summaries,
    artifacts,
    directions,
    hypotheses,
    methodPlans,
    queryHints,
    localFileHints
  };
}

export class MemoryStore {
  constructor(
    public readonly projectRoot: string,
    private readonly timestampFactory: () => string = () => new Date().toISOString()
  ) {}

  get filePath(): string {
    return memoryFilePath(this.projectRoot);
  }

  async load(): Promise<MemoryState> {
    await mkdir(runtimeDirectoryPath(this.projectRoot), { recursive: true });

    try {
      const contents = await readFile(this.filePath, "utf8");
      return mergeMemoryState(JSON.parse(contents), this.projectRoot, this.timestampFactory());
    } catch (error) {
      const missingFile = error instanceof Error && "code" in error && error.code === "ENOENT";

      if (!missingFile) {
        throw error;
      }

      const memory = createEmptyMemoryState(this.projectRoot, this.timestampFactory());
      await writeMemoryFile(this.projectRoot, memory);
      return memory;
    }
  }

  async save(memory: MemoryState): Promise<void> {
    memory.schemaVersion = memorySchemaVersion;
    memory.projectRoot = this.projectRoot;
    memory.runtimeDirectory = runtimeDirectoryPath(this.projectRoot);
    memory.updatedAt = this.timestampFactory();
    memory.recordCount = memory.records.length;
    await writeMemoryFile(this.projectRoot, memory);
  }

  async upsert(records: MemoryRecordInput[]): Promise<MemoryUpsertResult> {
    const memory = await this.load();
    const timestamp = this.timestampFactory();
    const indexedRecords = new Map(memory.records.map((record) => [record.id, record]));
    const upsertedRecords: MemoryRecord[] = [];
    let inserted = 0;
    let updated = 0;

    for (const record of records) {
      const normalized = normalizeRecordInput(record);

      if (normalized === null) {
        continue;
      }

      const id = createMemoryRecordId(normalized.type, normalized.key);
      const existing = indexedRecords.get(id);

      if (existing === undefined) {
        const nextRecord: MemoryRecord = {
          id,
          type: normalized.type,
          key: normalized.key,
          title: normalized.title,
          text: normalized.text,
          runId: normalized.runId,
          createdAt: timestamp,
          updatedAt: timestamp,
          links: normalized.links ?? [],
          data: normalized.data ?? {}
        };

        memory.records.push(nextRecord);
        indexedRecords.set(id, nextRecord);
        upsertedRecords.push(nextRecord);
        inserted += 1;
        continue;
      }

      existing.title = normalized.title;
      existing.text = normalized.text;
      existing.runId = normalized.runId ?? existing.runId;
      existing.updatedAt = timestamp;
      existing.links = dedupeLinks([
        ...existing.links,
        ...(normalized.links ?? [])
      ]);
      existing.data = mergeData(existing.data, normalized.data ?? {});
      upsertedRecords.push(existing);
      updated += 1;
    }

    memory.updatedAt = timestamp;
    memory.recordCount = memory.records.length;
    await writeMemoryFile(this.projectRoot, memory);

    return {
      inserted,
      updated,
      memory,
      records: upsertedRecords
    };
  }
}
