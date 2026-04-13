import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtimeDirectoryName = ".clawresearch";
export const sessionFileName = "session.json";
const schemaVersion = 3;
const placeholderValuePattern = /^(?:string(?:\s+or\s+null)?|null|n\/a|tbd|unknown)$/i;

export type ResearchBriefField =
  | "topic"
  | "researchQuestion"
  | "researchDirection"
  | "successCriterion";

export type SessionStatus = "startup_chat" | "ready";
export type ConversationRole = "assistant" | "user";
export type ConversationKind = "chat" | "command" | "system";

export type ResearchBrief = {
  topic: string | null;
  researchQuestion: string | null;
  researchDirection: string | null;
  successCriterion: string | null;
};

export type ConversationEntry = {
  id: string;
  kind: ConversationKind;
  role: ConversationRole;
  text: string;
  timestamp: string;
};

export type IntakeState = {
  backendLabel: string | null;
  readiness: "needs_clarification" | "ready";
  rationale: string | null;
  openQuestions: string[];
  summary: string | null;
  lastError: string | null;
};

export type SessionState = {
  schemaVersion: number;
  appVersion: string;
  projectRoot: string;
  runtimeDirectory: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  goCount: number;
  lastGoRequestedAt: string | null;
  activeRunId: string | null;
  lastRunId: string | null;
  brief: ResearchBrief;
  intake: IntakeState;
  conversation: ConversationEntry[];
};

function sessionFilePath(projectRoot: string): string {
  return path.join(projectRoot, runtimeDirectoryName, sessionFileName);
}

export function runtimeDirectoryPath(projectRoot: string): string {
  return path.join(projectRoot, runtimeDirectoryName);
}

function createEmptyBrief(): ResearchBrief {
  return {
    topic: null,
    researchQuestion: null,
    researchDirection: null,
    successCriterion: null
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function createSessionState(projectRoot: string, version: string, timestamp: string): SessionState {
  return {
    schemaVersion,
    appVersion: version,
    projectRoot,
    runtimeDirectory: runtimeDirectoryPath(projectRoot),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "startup_chat",
    goCount: 0,
    lastGoRequestedAt: null,
    activeRunId: null,
    lastRunId: null,
    brief: createEmptyBrief(),
    intake: {
      backendLabel: null,
      readiness: "needs_clarification",
      rationale: "The research brief still needs clarification.",
      openQuestions: [],
      summary: null,
      lastError: null
    },
    conversation: []
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && !placeholderValuePattern.test(trimmed)
    ? trimmed
    : null;
}

function mergeSession(raw: unknown, projectRoot: string, version: string, timestamp: string): SessionState {
  const base = createSessionState(projectRoot, version, timestamp);
  const session = asObject(raw);
  const brief = asObject(session.brief);
  const intake = asObject(session.intake);
  const conversation = Array.isArray(session.conversation) ? session.conversation : [];
  const rawSchemaVersion = typeof session.schemaVersion === "number" && Number.isFinite(session.schemaVersion)
    ? session.schemaVersion
    : 0;
  const shouldResetLegacyBrief = rawSchemaVersion < 2;

  return {
    schemaVersion,
    appVersion: version,
    projectRoot,
    runtimeDirectory: runtimeDirectoryPath(projectRoot),
    createdAt: readString(session.createdAt) ?? base.createdAt,
    updatedAt: readString(session.updatedAt) ?? base.updatedAt,
    status: session.status === "ready" ? "ready" : "startup_chat",
    goCount: typeof session.goCount === "number" && Number.isFinite(session.goCount) ? session.goCount : 0,
    lastGoRequestedAt: readString(session.lastGoRequestedAt),
    activeRunId: readString(session.activeRunId),
    lastRunId: readString(session.lastRunId),
    brief: shouldResetLegacyBrief
      ? { ...base.brief }
      : {
        topic: readString(brief.topic),
        researchQuestion: readString(brief.researchQuestion),
        researchDirection: readString(brief.researchDirection),
        successCriterion: readString(brief.successCriterion)
      },
    intake: {
      backendLabel: readString(intake.backendLabel),
      readiness: intake.readiness === "ready" ? "ready" : "needs_clarification",
      rationale: readString(intake.rationale) ?? base.intake.rationale,
      openQuestions: Array.isArray(intake.openQuestions)
        ? intake.openQuestions.flatMap((entry) => readString(entry) ?? [])
        : [],
      summary: readString(intake.summary),
      lastError: readString(intake.lastError)
    },
    conversation: conversation.flatMap((entry, index) => {
      const item = asObject(entry);
      const role = item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : null;
      const text = readString(item.text);
      const itemTimestamp = readString(item.timestamp);
      const kind = item.kind === "command" || item.kind === "system" ? item.kind : "chat";

      if (role === null || text === null || itemTimestamp === null) {
        return [];
      }

      if (shouldResetLegacyBrief) {
        if (role !== "user") {
          return [];
        }

        if (text.startsWith("/")) {
          return [];
        }
      }

      return [{
        id: readString(item.id) ?? `${itemTimestamp}-${index}`,
        kind,
        role,
        text,
        timestamp: itemTimestamp
      }];
    })
  };
}

async function writeSessionFile(projectRoot: string, session: SessionState): Promise<void> {
  await mkdir(runtimeDirectoryPath(projectRoot), { recursive: true });
  await writeFile(sessionFilePath(projectRoot), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export class SessionStore {
  constructor(
    public readonly projectRoot: string,
    private readonly version: string,
    private readonly timestampFactory: () => string = () => new Date().toISOString()
  ) {}

  get runtimeDirectory(): string {
    return runtimeDirectoryPath(this.projectRoot);
  }

  get sessionPath(): string {
    return sessionFilePath(this.projectRoot);
  }

  async load(): Promise<SessionState> {
    await mkdir(this.runtimeDirectory, { recursive: true });

    try {
      const contents = await readFile(this.sessionPath, "utf8");
      return mergeSession(JSON.parse(contents), this.projectRoot, this.version, this.timestampFactory());
    } catch (error) {
      const missingFile = error instanceof Error && "code" in error && error.code === "ENOENT";

      if (!missingFile) {
        throw error;
      }

      const session = createSessionState(this.projectRoot, this.version, this.timestampFactory());
      await writeSessionFile(this.projectRoot, session);
      return session;
    }
  }

  async save(session: SessionState): Promise<void> {
    session.updatedAt = this.timestampFactory();
    session.appVersion = this.version;
    session.projectRoot = this.projectRoot;
    session.runtimeDirectory = this.runtimeDirectory;
    await writeSessionFile(this.projectRoot, session);
  }
}

export function appendConversationEntry(
  session: SessionState,
  role: ConversationRole,
  text: string,
  timestamp: string,
  kind: ConversationKind = "chat"
): void {
  const normalizedText = normalizeText(text);

  if (normalizedText.length === 0) {
    return;
  }

  session.conversation.push({
    id: `${timestamp}-${session.conversation.length + 1}`,
    kind,
    role,
    text: normalizedText,
    timestamp
  });
}

export function setBriefField(
  session: SessionState,
  field: ResearchBriefField,
  value: string
): void {
  session.brief[field] = normalizeText(value);
  session.status = hasCompleteBrief(session) && session.intake.readiness === "ready"
    ? session.status
    : "startup_chat";
}

export function hasCompleteBrief(session: SessionState): boolean {
  return Object.values(session.brief).every((value) => value !== null && value.length > 0);
}

export function missingBriefFields(session: SessionState): ResearchBriefField[] {
  const fields: ResearchBriefField[] = [
    "topic",
    "researchQuestion",
    "researchDirection",
    "successCriterion"
  ];

  return fields.filter((field) => session.brief[field] === null);
}
