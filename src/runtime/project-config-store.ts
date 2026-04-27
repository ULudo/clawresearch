import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  authStateForProvider as authStateFromCredentials,
  type CredentialStoreState,
  type ProviderCredentialAuthState
} from "./credential-store.js";
import {
  dedupeProviderIds,
  defaultGeneralWebProviderIds,
  defaultOaRetrievalHelperProviderIds,
  defaultPublisherFullTextProviderIds,
  defaultScholarlyDiscoveryProviderIds,
  getSourceProviderDefinition,
  listSourceProvidersByCategory,
  parseProviderSelection,
  type SourceProviderId
} from "./provider-registry.js";
import { runtimeDirectoryPath } from "./session-store.js";
import type { ResearchAgentControlMode } from "./research-agent.js";

const projectConfigSchemaVersion = 7;
const projectConfigFileName = "project-config.json";
const selectableProviderCategories = [
  "scholarlyDiscovery",
  "publisherFullText",
  "oaRetrievalHelpers",
  "generalWeb"
] as const;

export type LiteratureProviderId = SourceProviderId;
export type ConfigurableProviderCategory = typeof selectableProviderCategories[number];

export type ProjectConfigSourcesState = {
  scholarlyDiscovery: {
    selectedProviderIds: SourceProviderId[];
  };
  publisherFullText: {
    selectedProviderIds: SourceProviderId[];
  };
  oaRetrievalHelpers: {
    selectedProviderIds: SourceProviderId[];
  };
  generalWeb: {
    selectedProviderIds: SourceProviderId[];
  };
  localContext: {
    projectFilesEnabled: boolean;
  };
  explicitlyConfigured: boolean;
};

export type RuntimeLlmConfig = {
  planningTimeoutMs: number;
  extractionTimeoutMs: number;
  synthesisTimeoutMs: number;
  agendaTimeoutMs: number;
  criticTimeoutMs: number;
  agentStepTimeoutMs: number;
  extractionInitialBatchSize: number;
  extractionMinBatchSize: number;
  extractionRetryBudget: number;
  synthesisInitialClusterSize: number;
  synthesisMinClusterSize: number;
  synthesisRetryBudget: number;
  agentControlMode: ResearchAgentControlMode;
  agentInvalidActionBudget: number;
  totalRecoveryBudgetMs: number;
  evidenceRecoveryMaxPasses: number;
};

export type ProjectConfigState = {
  schemaVersion: number;
  projectRoot: string;
  runtimeDirectory: string;
  createdAt: string;
  updatedAt: string;
  sources: ProjectConfigSourcesState;
  runtime: {
    postReviewBehavior: "confirm" | "auto_continue";
    llm: RuntimeLlmConfig;
  };
};

export type ProjectConfigProviderAuthState = ProviderCredentialAuthState;

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

function readAgentControlMode(value: unknown): ResearchAgentControlMode | null {
  switch (value) {
    case "auto":
    case "native_tool_calls":
    case "strict_json":
      return value;
    default:
      return null;
  }
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

function readEnvPositiveInteger(env: NodeJS.ProcessEnv, name: string): number | null {
  const value = env[name];

  if (value === undefined || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

export const defaultRuntimeLlmConfig: RuntimeLlmConfig = {
  planningTimeoutMs: 300_000,
  extractionTimeoutMs: 300_000,
  synthesisTimeoutMs: 300_000,
  agendaTimeoutMs: 300_000,
  criticTimeoutMs: 300_000,
  agentStepTimeoutMs: 300_000,
  extractionInitialBatchSize: 6,
  extractionMinBatchSize: 1,
  extractionRetryBudget: 24,
  synthesisInitialClusterSize: 6,
  synthesisMinClusterSize: 1,
  synthesisRetryBudget: 12,
  agentControlMode: "auto",
  agentInvalidActionBudget: 2,
  totalRecoveryBudgetMs: 1_800_000,
  evidenceRecoveryMaxPasses: 3
};

function normalizeRuntimeLlmConfig(raw: unknown): RuntimeLlmConfig {
  const record = asObject(raw);
  const base = defaultRuntimeLlmConfig;
  const extractionMinBatchSize = readPositiveInteger(record.extractionMinBatchSize)
    ?? base.extractionMinBatchSize;
  const extractionInitialBatchSize = Math.max(
    extractionMinBatchSize,
    readPositiveInteger(record.extractionInitialBatchSize)
      ?? base.extractionInitialBatchSize
  );
  const synthesisMinClusterSize = readPositiveInteger(record.synthesisMinClusterSize)
    ?? base.synthesisMinClusterSize;
  const synthesisInitialClusterSize = Math.max(
    synthesisMinClusterSize,
    readPositiveInteger(record.synthesisInitialClusterSize)
      ?? base.synthesisInitialClusterSize
  );

  return {
    planningTimeoutMs: readPositiveInteger(record.planningTimeoutMs) ?? base.planningTimeoutMs,
    extractionTimeoutMs: readPositiveInteger(record.extractionTimeoutMs) ?? base.extractionTimeoutMs,
    synthesisTimeoutMs: readPositiveInteger(record.synthesisTimeoutMs) ?? base.synthesisTimeoutMs,
    agendaTimeoutMs: readPositiveInteger(record.agendaTimeoutMs) ?? base.agendaTimeoutMs,
    criticTimeoutMs: readPositiveInteger(record.criticTimeoutMs) ?? base.criticTimeoutMs,
    agentStepTimeoutMs: readPositiveInteger(record.agentStepTimeoutMs) ?? base.agentStepTimeoutMs,
    extractionInitialBatchSize,
    extractionMinBatchSize,
    extractionRetryBudget: readPositiveInteger(record.extractionRetryBudget) ?? base.extractionRetryBudget,
    synthesisInitialClusterSize,
    synthesisMinClusterSize,
    synthesisRetryBudget: readPositiveInteger(record.synthesisRetryBudget) ?? base.synthesisRetryBudget,
    agentControlMode: readAgentControlMode(record.agentControlMode) ?? base.agentControlMode,
    agentInvalidActionBudget: readPositiveInteger(record.agentInvalidActionBudget) ?? base.agentInvalidActionBudget,
    totalRecoveryBudgetMs: readPositiveInteger(record.totalRecoveryBudgetMs) ?? base.totalRecoveryBudgetMs,
    evidenceRecoveryMaxPasses: readPositiveInteger(record.evidenceRecoveryMaxPasses) ?? base.evidenceRecoveryMaxPasses
  };
}

export function resolveRuntimeLlmConfig(
  config: ProjectConfigState,
  env: NodeJS.ProcessEnv = process.env
): RuntimeLlmConfig {
  const baseTimeout = readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_TIMEOUT_MS");
  const configured = normalizeRuntimeLlmConfig(config.runtime.llm);
  const extractionMinBatchSize = readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_EXTRACTION_MIN_BATCH_SIZE")
    ?? configured.extractionMinBatchSize;
  const extractionInitialBatchSize = Math.max(
    extractionMinBatchSize,
    readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_EXTRACTION_BATCH_SIZE")
      ?? configured.extractionInitialBatchSize
  );
  const synthesisMinClusterSize = readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_SYNTHESIS_MIN_CLUSTER_SIZE")
    ?? configured.synthesisMinClusterSize;
  const synthesisInitialClusterSize = Math.max(
    synthesisMinClusterSize,
    readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_SYNTHESIS_CLUSTER_SIZE")
      ?? configured.synthesisInitialClusterSize
  );

  return {
    planningTimeoutMs: readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_PLANNING_TIMEOUT_MS")
      ?? baseTimeout
      ?? configured.planningTimeoutMs,
    extractionTimeoutMs: readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_EXTRACTION_TIMEOUT_MS")
      ?? baseTimeout
      ?? configured.extractionTimeoutMs,
    synthesisTimeoutMs: readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_SYNTHESIS_TIMEOUT_MS")
      ?? baseTimeout
      ?? configured.synthesisTimeoutMs,
    agendaTimeoutMs: readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_AGENDA_TIMEOUT_MS")
      ?? baseTimeout
      ?? configured.agendaTimeoutMs,
    criticTimeoutMs: readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_CRITIC_TIMEOUT_MS")
      ?? baseTimeout
      ?? configured.criticTimeoutMs,
    agentStepTimeoutMs: readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_AGENT_STEP_TIMEOUT_MS")
      ?? baseTimeout
      ?? configured.agentStepTimeoutMs,
    extractionInitialBatchSize,
    extractionMinBatchSize,
    extractionRetryBudget: readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_EXTRACTION_RETRY_BUDGET")
      ?? configured.extractionRetryBudget,
    synthesisInitialClusterSize,
    synthesisMinClusterSize,
    synthesisRetryBudget: readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_SYNTHESIS_RETRY_BUDGET")
      ?? configured.synthesisRetryBudget,
    agentControlMode: readAgentControlMode(env.CLAWRESEARCH_AGENT_CONTROL_MODE)
      ?? configured.agentControlMode,
    agentInvalidActionBudget: readEnvPositiveInteger(env, "CLAWRESEARCH_AGENT_INVALID_ACTION_BUDGET")
      ?? configured.agentInvalidActionBudget,
    totalRecoveryBudgetMs: readEnvPositiveInteger(env, "CLAWRESEARCH_LLM_RECOVERY_BUDGET_MS")
      ?? configured.totalRecoveryBudgetMs,
    evidenceRecoveryMaxPasses: readEnvPositiveInteger(env, "CLAWRESEARCH_EVIDENCE_RECOVERY_MAX_PASSES")
      ?? configured.evidenceRecoveryMaxPasses
  };
}

function normalizeProviderIds(
  rawProviderIds: unknown,
  category: ConfigurableProviderCategory,
  fallback: SourceProviderId[]
): SourceProviderId[] {
  if (!Array.isArray(rawProviderIds)) {
    return [...fallback];
  }

  return (parseProviderSelection(readStringArray(rawProviderIds).join(", "), category) ?? [])
    .filter((providerId) => getSourceProviderDefinition(providerId).implemented);
}

function emptyConfig(projectRoot: string, timestamp: string): ProjectConfigState {
  return {
    schemaVersion: projectConfigSchemaVersion,
    projectRoot,
    runtimeDirectory: runtimeDirectoryPath(projectRoot),
    createdAt: timestamp,
    updatedAt: timestamp,
    sources: {
      scholarlyDiscovery: {
        selectedProviderIds: defaultScholarlyDiscoveryProviderIds()
      },
      publisherFullText: {
        selectedProviderIds: defaultPublisherFullTextProviderIds()
      },
      oaRetrievalHelpers: {
        selectedProviderIds: defaultOaRetrievalHelperProviderIds()
      },
      generalWeb: {
        selectedProviderIds: defaultGeneralWebProviderIds()
      },
      localContext: {
        projectFilesEnabled: true
      },
      explicitlyConfigured: false
    },
    runtime: {
      postReviewBehavior: "confirm",
      llm: { ...defaultRuntimeLlmConfig }
    }
  };
}

function mergeProjectConfig(
  raw: unknown,
  projectRoot: string,
  timestamp: string
): ProjectConfigState {
  const record = asObject(raw);
  const sources = asObject(record.sources);
  const base = emptyConfig(projectRoot, timestamp);

  return {
    ...base,
    createdAt: readString(record.createdAt) ?? base.createdAt,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    sources: {
      scholarlyDiscovery: {
        selectedProviderIds: normalizeProviderIds(
          asObject(sources.scholarlyDiscovery).selectedProviderIds,
          "scholarlyDiscovery",
          base.sources.scholarlyDiscovery.selectedProviderIds
        )
      },
      publisherFullText: {
        selectedProviderIds: normalizeProviderIds(
          asObject(sources.publisherFullText).selectedProviderIds,
          "publisherFullText",
          base.sources.publisherFullText.selectedProviderIds
        )
      },
      oaRetrievalHelpers: {
        selectedProviderIds: normalizeProviderIds(
          asObject(sources.oaRetrievalHelpers).selectedProviderIds,
          "oaRetrievalHelpers",
          base.sources.oaRetrievalHelpers.selectedProviderIds
        )
      },
      generalWeb: {
        selectedProviderIds: normalizeProviderIds(
          asObject(sources.generalWeb).selectedProviderIds,
          "generalWeb",
          base.sources.generalWeb.selectedProviderIds
        )
      },
      localContext: {
        projectFilesEnabled: readBoolean(asObject(sources.localContext).projectFilesEnabled)
          ?? base.sources.localContext.projectFilesEnabled
      },
      explicitlyConfigured: readBoolean(sources.explicitlyConfigured)
        ?? base.sources.explicitlyConfigured
    },
    runtime: {
      postReviewBehavior: readString(asObject(record.runtime).postReviewBehavior) === "auto_continue"
        ? "auto_continue"
        : "confirm",
      llm: normalizeRuntimeLlmConfig(asObject(record.runtime).llm)
    }
  };
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(runtimeDirectoryPath(projectRoot), projectConfigFileName);
}

export function selectedProviderIdsForCategory(
  config: ProjectConfigState,
  category: ConfigurableProviderCategory
): SourceProviderId[] {
  return [...config.sources[category].selectedProviderIds];
}

export function selectedScholarlySourceProviders(config: ProjectConfigState): SourceProviderId[] {
  return dedupeProviderIds([
    ...config.sources.scholarlyDiscovery.selectedProviderIds,
    ...config.sources.publisherFullText.selectedProviderIds,
    ...config.sources.oaRetrievalHelpers.selectedProviderIds
  ]);
}

export function selectedGeneralWebProviders(config: ProjectConfigState): SourceProviderId[] {
  return [...config.sources.generalWeb.selectedProviderIds];
}

export function selectedSourceProviders(config: ProjectConfigState): SourceProviderId[] {
  return dedupeProviderIds([
    ...(config.sources.localContext.projectFilesEnabled ? ["project_files" as const] : []),
    ...selectedScholarlySourceProviders(config),
    ...selectedGeneralWebProviders(config)
  ]);
}

export function authStateForProvider(
  config: ProjectConfigState,
  credentials: CredentialStoreState,
  providerId: SourceProviderId
): ProjectConfigProviderAuthState {
  void config;
  return authStateFromCredentials(credentials, providerId);
}

export function authStatesForSelectedProviders(
  config: ProjectConfigState,
  credentials: CredentialStoreState
): ProjectConfigProviderAuthState[] {
  return selectedSourceProviders(config)
    .map((providerId) => authStateForProvider(config, credentials, providerId))
    .filter((state) => state.definition.authMode !== "none");
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

  return listSourceProvidersByCategory("scholarlyDiscovery")
    .filter((provider) => provider.implemented)
    .map((provider, index) => `[${selected.has(provider.id) ? "x" : " "}] ${index + 1}. ${provider.label} - ${provider.description}`);
}

export function parseLiteratureProviderSelection(input: string): SourceProviderId[] | null {
  return parseProviderSelection(input, "scholarlyDiscovery");
}

export function providerSelectionLines(category: ConfigurableProviderCategory): string[] {
  return listSourceProvidersByCategory(category)
    .filter((provider) => provider.implemented)
    .map((provider) => `${provider.label} - ${provider.description}`);
}

function normalizeCategorySelectionForSave(
  providerIds: SourceProviderId[],
  category: ConfigurableProviderCategory
): SourceProviderId[] {
  return dedupeProviderIds(providerIds)
    .filter((providerId) => getSourceProviderDefinition(providerId).category === category);
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
        scholarlyDiscovery: {
          selectedProviderIds: normalizeCategorySelectionForSave(
            config.sources.scholarlyDiscovery.selectedProviderIds,
            "scholarlyDiscovery"
          )
        },
        publisherFullText: {
          selectedProviderIds: normalizeCategorySelectionForSave(
            config.sources.publisherFullText.selectedProviderIds,
            "publisherFullText"
          )
        },
        oaRetrievalHelpers: {
          selectedProviderIds: normalizeCategorySelectionForSave(
            config.sources.oaRetrievalHelpers.selectedProviderIds,
            "oaRetrievalHelpers"
          )
        },
        generalWeb: {
          selectedProviderIds: normalizeCategorySelectionForSave(
            config.sources.generalWeb.selectedProviderIds,
            "generalWeb"
          )
        },
        localContext: {
          projectFilesEnabled: config.sources.localContext.projectFilesEnabled
        },
        explicitlyConfigured: config.sources.explicitlyConfigured
      },
      runtime: {
        postReviewBehavior: config.runtime.postReviewBehavior === "auto_continue"
          ? "auto_continue"
          : "confirm",
        llm: normalizeRuntimeLlmConfig(config.runtime.llm)
      }
    };

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }
}
