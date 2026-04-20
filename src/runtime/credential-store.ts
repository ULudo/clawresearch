import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getSourceProviderDefinition,
  providerAuthStatus,
  providerCredentialFields,
  type ProviderAuthStatus,
  type SourceProviderDefinition,
  type SourceProviderId
} from "./provider-registry.js";
import { runtimeDirectoryPath } from "./session-store.js";

const credentialStoreSchemaVersion = 1;
const credentialStoreFileName = "credentials.json";

export type ProviderCredentialValues = Partial<Record<string, string>>;
export type ProjectCredentialValues = Partial<Record<SourceProviderId, ProviderCredentialValues>>;

export type CredentialStoreState = {
  schemaVersion: number;
  projectRoot: string;
  runtimeDirectory: string;
  createdAt: string;
  updatedAt: string;
  providers: ProjectCredentialValues;
};

export type ProviderCredentialAuthState = {
  providerId: SourceProviderId;
  definition: SourceProviderDefinition;
  configuredFieldIds: string[];
  missingRequiredFieldIds: string[];
  missingOptionalFieldIds: string[];
  status: ProviderAuthStatus;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeProviderCredentials(value: unknown): ProjectCredentialValues {
  const providers = asObject(value);
  const normalized: ProjectCredentialValues = {};

  for (const [rawProviderId, rawCredentials] of Object.entries(providers)) {
    try {
      const definition = getSourceProviderDefinition(rawProviderId as SourceProviderId);
      const fields = providerCredentialFields(definition.id);
      const allowedFieldIds = new Set(fields.map((field) => field.id));
      const credentialRecord = asObject(rawCredentials);
      const providerValues: ProviderCredentialValues = {};

      for (const [fieldId, rawSecret] of Object.entries(credentialRecord)) {
        if (!allowedFieldIds.has(fieldId)) {
          continue;
        }

        const secret = readString(rawSecret);

        if (secret !== null) {
          providerValues[fieldId] = secret;
        }
      }

      if (Object.keys(providerValues).length > 0) {
        normalized[definition.id] = providerValues;
      }
    } catch {
      continue;
    }
  }

  return normalized;
}

function emptyCredentialState(projectRoot: string, timestamp: string): CredentialStoreState {
  return {
    schemaVersion: credentialStoreSchemaVersion,
    projectRoot,
    runtimeDirectory: runtimeDirectoryPath(projectRoot),
    createdAt: timestamp,
    updatedAt: timestamp,
    providers: {}
  };
}

function mergeCredentialState(raw: unknown, projectRoot: string, timestamp: string): CredentialStoreState {
  const record = asObject(raw);
  const base = emptyCredentialState(projectRoot, timestamp);

  return {
    ...base,
    createdAt: readString(record.createdAt) ?? base.createdAt,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    providers: normalizeProviderCredentials(record.providers)
  };
}

function credentialEnvVarNames(
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

export function credentialStorePath(projectRoot: string): string {
  return path.join(runtimeDirectoryPath(projectRoot), credentialStoreFileName);
}

export function credentialValue(
  state: CredentialStoreState,
  providerId: SourceProviderId,
  fieldId: string
): string | null {
  const value = state.providers[providerId]?.[fieldId];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function setCredentialValue(
  state: CredentialStoreState,
  providerId: SourceProviderId,
  fieldId: string,
  value: string | null
): void {
  if (value === null || value.trim().length === 0) {
    const nextFields = { ...(state.providers[providerId] ?? {}) };
    delete nextFields[fieldId];

    if (Object.keys(nextFields).length === 0) {
      delete state.providers[providerId];
      return;
    }

    state.providers[providerId] = nextFields;
    return;
  }

  state.providers[providerId] = {
    ...(state.providers[providerId] ?? {}),
    [fieldId]: value.trim()
  };
}

export function authStateForProvider(
  credentials: CredentialStoreState,
  providerId: SourceProviderId
): ProviderCredentialAuthState {
  const definition = getSourceProviderDefinition(providerId);
  const fields = providerCredentialFields(providerId);
  const configuredFieldIds = fields
    .filter((field) => credentialValue(credentials, providerId, field.id) !== null)
    .map((field) => field.id);
  const configured = new Set(configuredFieldIds);
  const missingRequiredFieldIds = fields
    .filter((field) => field.required && !configured.has(field.id))
    .map((field) => field.id);
  const missingOptionalFieldIds = fields
    .filter((field) => !field.required && !configured.has(field.id))
    .map((field) => field.id);

  return {
    providerId,
    definition,
    configuredFieldIds,
    missingRequiredFieldIds,
    missingOptionalFieldIds,
    status: providerAuthStatus(providerId, configuredFieldIds)
  };
}

export function applyCredentialsToEnvironment(credentials: CredentialStoreState): void {
  for (const [rawProviderId, values] of Object.entries(credentials.providers)) {
    const providerId = rawProviderId as SourceProviderId;

    for (const [fieldId, secret] of Object.entries(values ?? {})) {
      const trimmed = readString(secret);

      if (trimmed === null) {
        continue;
      }

      for (const envVarName of credentialEnvVarNames(providerId, fieldId)) {
        if (typeof process.env[envVarName] !== "string" || process.env[envVarName]?.trim().length === 0) {
          process.env[envVarName] = trimmed;
        }
      }
    }
  }
}

export class CredentialStore {
  constructor(
    public readonly projectRoot: string,
    private readonly timestampFactory: () => string = () => new Date().toISOString()
  ) {}

  get filePath(): string {
    return credentialStorePath(this.projectRoot);
  }

  async load(): Promise<CredentialStoreState> {
    const timestamp = this.timestampFactory();

    try {
      const rawContents = await readFile(this.filePath, "utf8");
      return mergeCredentialState(JSON.parse(rawContents) as unknown, this.projectRoot, timestamp);
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

      if (!missing) {
        throw error;
      }

      return emptyCredentialState(this.projectRoot, timestamp);
    }
  }

  async save(state: CredentialStoreState): Promise<CredentialStoreState> {
    const timestamp = this.timestampFactory();
    const normalized = mergeCredentialState(state, this.projectRoot, timestamp);
    normalized.updatedAt = timestamp;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    return normalized;
  }
}
