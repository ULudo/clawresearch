import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultBackgroundProviderIds,
  defaultScholarlyProviderIds,
  dedupeProviderIds,
  getSourceProviderDefinition,
  listSourceProvidersByCategory,
  normalizeProviderId,
  parseProviderSelection,
  providerAuthStatus,
  type ProviderAuthStatus,
  type SourceProviderCategory,
  type SourceProviderDefinition,
  type SourceProviderId
} from "./provider-registry.js";
import { runtimeDirectoryPath } from "./session-store.js";

const projectConfigSchemaVersion = 2;
const projectConfigFileName = "project-config.json";

export type LiteratureProviderId = SourceProviderId;

export type SourceProviderAuthRefs = Partial<Record<SourceProviderId, string | null>>;

export type ProjectConfigSourcesState = {
  scholarly: {
    selectedProviderIds: SourceProviderId[];
  };
  background: {
    selectedProviderIds: SourceProviderId[];
  };
  local: {
    projectFilesEnabled: boolean;
  };
  authRefs: SourceProviderAuthRefs;
  explicitlyConfigured: boolean;
};

export type ProjectConfigState = {
  schemaVersion: number;
  projectRoot: string;
  runtimeDirectory: string;
  createdAt: string;
  updatedAt: string;
  sources: ProjectConfigSourcesState;
};

export type ProjectConfigProviderAuthState = {
  providerId: SourceProviderId;
  definition: SourceProviderDefinition;
  authRef: string | null;
  envValuePresent: boolean;
  status: ProviderAuthStatus;
};

type LegacyProjectConfig = {
  literature?: {
    selectedProviderIds?: string[];
    explicitlyConfigured?: boolean;
  };
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

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const text = readString(entry);
    return text === null ? [] : [text];
  });
}

function normalizeProviderIds(
  rawProviderIds: string[],
  category: SourceProviderCategory
): SourceProviderId[] {
  return (parseProviderSelection(rawProviderIds.join(", "), category) ?? [])
    .filter((providerId) => getSourceProviderDefinition(providerId).implemented);
}

function normalizeAuthRefs(value: unknown): SourceProviderAuthRefs {
  const record = asObject(value);
  const authRefs: SourceProviderAuthRefs = {};

  for (const [rawProviderId, rawEnvVarName] of Object.entries(record)) {
    const providerId = normalizeProviderId(rawProviderId);
    const envVarName = readString(rawEnvVarName);

    if (providerId === null) {
      continue;
    }

    if (rawEnvVarName === null) {
      authRefs[providerId] = null;
      continue;
    }

    if (envVarName !== null) {
      authRefs[providerId] = envVarName;
    }
  }

  return authRefs;
}

function hasExplicitAuthRef(
  config: ProjectConfigState,
  providerId: SourceProviderId
): boolean {
  return Object.prototype.hasOwnProperty.call(config.sources.authRefs, providerId);
}

function emptyConfig(projectRoot: string, timestamp: string): ProjectConfigState {
  return {
    schemaVersion: projectConfigSchemaVersion,
    projectRoot,
    runtimeDirectory: runtimeDirectoryPath(projectRoot),
    createdAt: timestamp,
    updatedAt: timestamp,
    sources: {
      scholarly: {
        selectedProviderIds: defaultScholarlyProviderIds()
      },
      background: {
        selectedProviderIds: defaultBackgroundProviderIds()
      },
      local: {
        projectFilesEnabled: true
      },
      authRefs: {},
      explicitlyConfigured: false
    }
  };
}

function migrateLegacySelectedProviders(
  selectedProviderIds: string[] | undefined,
  base: ProjectConfigState
): ProjectConfigSourcesState {
  if (selectedProviderIds === undefined) {
    return base.sources;
  }

  const scholarly = new Set<SourceProviderId>();
  const background = new Set<SourceProviderId>();
  let projectFilesEnabled = base.sources.local.projectFilesEnabled;

  for (const providerId of selectedProviderIds) {
    switch (providerId) {
      case "local_files":
      case "project_files":
      case "project-files":
        projectFilesEnabled = true;
        break;
      case "wikipedia":
        background.add("wikipedia");
        break;
      default: {
        const scholarlyIds = parseProviderSelection(providerId, "scholarly");

        if (scholarlyIds !== null && scholarlyIds.length > 0) {
          scholarly.add(scholarlyIds[0]!);
        }
        break;
      }
    }
  }

  return {
    scholarly: {
      selectedProviderIds: scholarly.size > 0
        ? [...scholarly]
        : base.sources.scholarly.selectedProviderIds
    },
    background: {
      selectedProviderIds: [...background]
    },
    local: {
      projectFilesEnabled
    },
    authRefs: {},
    explicitlyConfigured: true
  };
}

function mergeProjectConfig(
  raw: unknown,
  projectRoot: string,
  timestamp: string
): ProjectConfigState {
  const record = asObject(raw);
  const sources = asObject(record.sources);
  const scholarly = asObject(sources.scholarly);
  const background = asObject(sources.background);
  const local = asObject(sources.local);
  const base = emptyConfig(projectRoot, timestamp);
  const legacy = record as LegacyProjectConfig;
  const hasGroupedSources = Object.keys(sources).length > 0;

  if (!hasGroupedSources && legacy.literature !== undefined) {
    const migratedSources = migrateLegacySelectedProviders(
      legacy.literature.selectedProviderIds,
      base
    );

    return {
      ...base,
      createdAt: readString(record.createdAt) ?? base.createdAt,
      updatedAt: readString(record.updatedAt) ?? base.updatedAt,
      sources: {
        ...migratedSources,
        explicitlyConfigured: legacy.literature.explicitlyConfigured ?? true
      }
    };
  }

  return {
    ...base,
    createdAt: readString(record.createdAt) ?? base.createdAt,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    sources: {
      scholarly: {
        selectedProviderIds: Array.isArray(scholarly.selectedProviderIds)
          ? normalizeProviderIds(readStringArray(scholarly.selectedProviderIds), "scholarly")
          : base.sources.scholarly.selectedProviderIds
      },
      background: {
        selectedProviderIds: Array.isArray(background.selectedProviderIds)
          ? normalizeProviderIds(readStringArray(background.selectedProviderIds), "background")
          : base.sources.background.selectedProviderIds
      },
      local: {
        projectFilesEnabled: readBoolean(local.projectFilesEnabled)
          ?? base.sources.local.projectFilesEnabled
      },
      authRefs: normalizeAuthRefs(sources.authRefs),
      explicitlyConfigured: readBoolean(sources.explicitlyConfigured)
        ?? base.sources.explicitlyConfigured
    }
  };
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(runtimeDirectoryPath(projectRoot), projectConfigFileName);
}

export function selectedSourceProviders(config: ProjectConfigState): SourceProviderId[] {
  return dedupeProviderIds([
    ...(config.sources.local.projectFilesEnabled ? ["project_files" as const] : []),
    ...config.sources.scholarly.selectedProviderIds,
    ...config.sources.background.selectedProviderIds
  ]);
}

export function defaultAuthRefForProvider(
  config: ProjectConfigState,
  providerId: SourceProviderId
): string | null {
  if (hasExplicitAuthRef(config, providerId)) {
    return config.sources.authRefs[providerId] ?? null;
  }

  return getSourceProviderDefinition(providerId).defaultEnvVarName
    ?? null;
}

export function suggestedAuthRefForProvider(
  config: ProjectConfigState,
  providerId: SourceProviderId
): string | null {
  const explicit = config.sources.authRefs[providerId];

  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }

  return getSourceProviderDefinition(providerId).defaultEnvVarName ?? null;
}

export function authStateForProvider(
  config: ProjectConfigState,
  providerId: SourceProviderId
): ProjectConfigProviderAuthState {
  const definition = getSourceProviderDefinition(providerId);
  const explicitAuthRef = hasExplicitAuthRef(config, providerId)
    ? (config.sources.authRefs[providerId] ?? null)
    : undefined;
  const authRef = explicitAuthRef === undefined
    ? (definition.defaultEnvVarName ?? null)
    : explicitAuthRef;
  const envValuePresent = authRef !== null
    && typeof process.env[authRef] === "string"
    && process.env[authRef]!.trim().length > 0;
  const status = providerAuthStatus(
    providerId,
    envValuePresent
      ? authRef
      : (explicitAuthRef === undefined ? undefined : explicitAuthRef)
  );

  return {
    providerId,
    definition,
    authRef,
    envValuePresent,
    status
  };
}

export function authStatesForSelectedProviders(config: ProjectConfigState): ProjectConfigProviderAuthState[] {
  return selectedSourceProviders(config)
    .map((providerId) => authStateForProvider(config, providerId))
    .filter((state) => state.definition.authMode !== "none");
}

export function setProviderAuthRef(
  config: ProjectConfigState,
  providerId: SourceProviderId,
  authRef: string | null
): void {
  if (authRef === null || authRef.trim().length === 0) {
    config.sources.authRefs[providerId] = null;
    return;
  }

  config.sources.authRefs[providerId] = authRef.trim();
}

export function formatSelectedLiteratureProviders(providerIds: SourceProviderId[]): string {
  if (providerIds.length === 0) {
    return "none";
  }

  return providerIds
    .map((providerId) => getSourceProviderDefinition(providerId).label)
    .join(", ");
}

export function createLiteratureProviderLines(providerIds: SourceProviderId[]): string[] {
  const selected = new Set(providerIds);

  return listSourceProvidersByCategory("scholarly")
    .filter((provider) => provider.implemented)
    .map((provider, index) => `[${selected.has(provider.id) ? "x" : " "}] ${index + 1}. ${provider.label} - ${provider.description}`);
}

export function parseLiteratureProviderSelection(input: string): SourceProviderId[] | null {
  return parseProviderSelection(input, "scholarly");
}

export function providerSelectionLines(category: SourceProviderCategory): string[] {
  return listSourceProvidersByCategory(category)
    .filter((provider) => provider.implemented)
    .map((provider) => `${provider.label} - ${provider.description}`);
}

export class ProjectConfigStore {
  constructor(
    public readonly projectRoot: string,
    private readonly timestampFactory: () => string = () => new Date().toISOString()
  ) {}

  get filePath(): string {
    return projectConfigPath(this.projectRoot);
  }

  async load(): Promise<ProjectConfigState> {
    const timestamp = this.timestampFactory();

    try {
      const rawContents = await readFile(this.filePath, "utf8");
      return mergeProjectConfig(JSON.parse(rawContents) as unknown, this.projectRoot, timestamp);
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

      if (!missing) {
        throw error;
      }

      return emptyConfig(this.projectRoot, timestamp);
    }
  }

  async save(config: ProjectConfigState): Promise<ProjectConfigState> {
    const timestamp = this.timestampFactory();
    const normalized: ProjectConfigState = {
      ...mergeProjectConfig(config, this.projectRoot, timestamp),
      schemaVersion: projectConfigSchemaVersion,
      projectRoot: this.projectRoot,
      runtimeDirectory: runtimeDirectoryPath(this.projectRoot),
      createdAt: config.createdAt,
      updatedAt: timestamp,
      sources: {
        ...config.sources,
        scholarly: {
          selectedProviderIds: dedupeProviderIds(config.sources.scholarly.selectedProviderIds)
            .filter((providerId) => getSourceProviderDefinition(providerId).category === "scholarly")
        },
        background: {
          selectedProviderIds: dedupeProviderIds(config.sources.background.selectedProviderIds)
            .filter((providerId) => getSourceProviderDefinition(providerId).category === "background")
        },
        local: {
          projectFilesEnabled: config.sources.local.projectFilesEnabled
        },
        authRefs: normalizeAuthRefs(config.sources.authRefs),
        explicitlyConfigured: config.sources.explicitlyConfigured
      }
    };

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }
}
