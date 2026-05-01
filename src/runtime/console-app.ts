import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  appendConversationEntry,
  type ConversationKind,
  type ResearchBrief,
  type ResearchBriefField,
  type SessionState,
  SessionStore,
  setBriefField
} from "./session-store.js";
import {
  createDefaultIntakeBackend,
  createProjectIntakeBackend,
  type IntakeBackend,
  type IntakeRequest,
  type IntakeResponse
} from "./intake-backend.js";
import {
  createDefaultProjectAssistantBackend,
  createProjectAssistantBackend,
  type ProjectAssistantBackend,
  type ProjectAssistantResponse,
  type ProjectFileAction,
  type ProjectAssistantRequest,
  type ProjectAssistantRunContext
} from "./project-assistant-backend.js";
import {
  createDefaultRunController,
  type RunController
} from "./run-controller.js";
import {
  researchDirectionPath,
  RunStore,
  type ResearchDirectionState,
  type RunRecord
} from "./run-store.js";
import {
  ConsoleTranscript
} from "./console-transcript.js";
import {
  applyCredentialsToEnvironment,
  CredentialStore,
  credentialStorePath,
  setCredentialValue,
  type CredentialStoreState
} from "./credential-store.js";
import {
  authStatesForSelectedProviders,
  selectedProviderIdsForCategory,
  selectedScholarlySourceProviders,
  formatSelectedLiteratureProviders,
  resolveRuntimeModelConfig,
  projectConfigPath,
  providerSelectionLines,
  ProjectConfigStore,
  type ConfigurableProviderCategory,
  type RuntimeModelProvider,
  type ProjectConfigState
} from "./project-config-store.js";
import {
  createProviderSelectionLines,
  formatSelectedProviderLabels,
  getSourceProviderDefinition,
  providerCredentialFields,
  parseProviderSelection,
  type SourceProviderId
} from "./provider-registry.js";
import {
  parseRunEventLines,
  readRunEventChunk,
  type RunEventKind,
  type RunEventRecord
} from "./run-events.js";
import type {
  ResearchAgenda
} from "./research-backend.js";
import {
  createResearchWorkerState,
  loadResearchWorkerState,
  researchWorkerStatePath,
  writeResearchWorkerState,
  type ResearchWorkerState
} from "./research-state.js";
import {
  buildLiteratureContextFromWorkStore,
  loadResearchWorkStore,
  researchWorkStoreFilePath,
  summarizeResearchWorkStore,
  type ResearchWorkStore
} from "./research-work-store.js";
import type {
  ManuscriptChecksArtifact,
  ReviewPaperArtifact
} from "./research-manuscript.js";
import {
  loginOpenAiCodexDeviceCode,
  ModelCredentialStore,
  modelCredentialStorePath,
  setOpenAiApiKeyCredential,
  setOpenAiCodexCredential,
  type ModelCredentialState
} from "./model-runtime.js";

export type OutputWriter = {
  write: (chunk: string) => void;
};

export type ConsoleIo = {
  writer: OutputWriter;
  prompt: (promptText: string) => Promise<string | null>;
  close?: () => void;
  interactive?: boolean;
};

export type RunOptions = {
  projectRoot: string;
  version: string;
  now?: () => string;
  intakeBackend?: IntakeBackend;
  projectAssistantBackend?: ProjectAssistantBackend;
  runController?: RunController;
  watchRuns?: boolean;
  watchPollMs?: number;
};

type BriefUpdate = {
  field: ResearchBriefField;
  value: string;
};

const fieldLabels: Record<ResearchBriefField, string> = {
  topic: "topic",
  researchQuestion: "research question",
  researchDirection: "research direction",
  successCriterion: "success criterion"
};

const fieldPrefixMatchers: Array<{ field: ResearchBriefField; pattern: RegExp }> = [
  { field: "topic", pattern: /^(?:topic|research topic)\s*:\s*(.+)$/i },
  { field: "researchQuestion", pattern: /^(?:question|research question)\s*:\s*(.+)$/i },
  { field: "researchDirection", pattern: /^(?:direction|research direction)\s*:\s*(.+)$/i },
  { field: "successCriterion", pattern: /^(?:success|success criterion)\s*:\s*(.+)$/i }
];

const userAmbitionPattern = /\b(prove|proof|solve|solution|solvab|solvability|cure|eradicate|eliminate|breakthrough|invent|discover the answer|fully automate|full solution)\b/i;
const directEndStatePattern = /\b(prove|proof|cure|eradicate|eliminate|breakthrough|resolve|resolution|fully automate|full solution|solve (?:it|this|the problem|the hypothesis|the disease|the crisis))\b/i;
const boundedModePattern = /\b(literature|survey|review|map|mapping|synthesis|synthesize|evaluate|evaluation|compare|comparison|benchmark|benchmarking|replicat|reproduc|exploratory|exploration|pilot|feasibility|bounded|subproblem|case study|research note|note|prototype|ablation|identify|assessment|assess|scope|follow[- ]?up|baseline|artifact|memo|analysis)\b/i;
const deliverablePattern = /\b(note|report|analysis|benchmark|evaluation|survey|mapping|synthesis|prototype|experiment|ablation|dataset|replication|reproduction|review|plan|feasibility|baseline|artifact|memo|paper|manuscript|publication|publications)\b/i;
const genericFieldPattern = /^(?:algorithmic approaches?|computational methods?|literature review|historical context|theoretical frameworks?|number theory|physics|mathematics|applications?)$/i;
const taggedLabelWidth = 10;

function writeLine(writer: OutputWriter, line = ""): void {
  writer.write(`${line}\n`);
}

function authStateDetail(
  authState: ReturnType<typeof authStatesForSelectedProviders>[number]
): string {
  const parts: string[] = [];

  if (authState.configuredFieldIds.length > 0) {
    parts.push(`configured: ${authState.configuredFieldIds.join(", ")}`);
  }

  if (authState.missingRequiredFieldIds.length > 0) {
    parts.push(`missing required: ${authState.missingRequiredFieldIds.join(", ")}`);
  }

  if (authState.missingOptionalFieldIds.length > 0) {
    parts.push(`missing optional: ${authState.missingOptionalFieldIds.join(", ")}`);
  }

  return parts.join("; ");
}

function credentialPromptLabel(providerLabel: string, fieldLabel: string): string {
  const normalizedProvider = providerLabel.trim().toLowerCase();
  const normalizedField = fieldLabel.trim().toLowerCase();

  return normalizedField.startsWith(normalizedProvider)
    ? normalizedField
    : `${normalizedProvider} ${normalizedField}`;
}

function createLoggedWriter(baseWriter: OutputWriter, transcript: ConsoleTranscript): OutputWriter {
  return {
    write(chunk: string): void {
      baseWriter.write(chunk);
      transcript.appendOutput(chunk);
    }
  };
}

function renderTaggedBlock(writer: OutputWriter, tag: string, text: string): void {
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (line.length === 0) {
      writeLine(writer);
      continue;
    }

    writeLine(writer, `${tag.padEnd(taggedLabelWidth)} ${line}`);
  }
}

function renderTaggedLines(writer: OutputWriter, tag: string, lines: string[]): void {
  for (const line of lines) {
    renderTaggedBlock(writer, tag, line);
  }
}

export type AgendaSnapshot = {
  run: RunRecord | null;
  agenda: ResearchAgenda;
  source: "global" | "run";
  sourceRunId: string | null;
  sourceRunAgendaPath: string | null;
  provenanceKnown: boolean;
};

type RuntimeArtifactStatus = {
  schemaVersion: number;
  runId: string;
  artifactKind: string;
  status: "pending" | "in_progress" | "failed";
  stage: string;
  error: {
    message: string;
    kind: string;
    operation: string | null;
  } | null;
};

function isRuntimeArtifactStatus(value: unknown): value is RuntimeArtifactStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.artifactKind === "string"
    && (record.status === "pending" || record.status === "in_progress" || record.status === "failed");
}

async function readJsonFileOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const contents = await readFile(filePath, "utf8");
    const parsed = JSON.parse(contents) as unknown;

    if (isRuntimeArtifactStatus(parsed)) {
      return null;
    }

    return parsed as T;
  } catch {
    return null;
  }
}

async function readArtifactStatusOrNull(filePath: string): Promise<RuntimeArtifactStatus | null> {
  try {
    const contents = await readFile(filePath, "utf8");
    const parsed = JSON.parse(contents) as unknown;
    return isRuntimeArtifactStatus(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadAgendaSnapshotForRun(run: RunRecord): Promise<AgendaSnapshot | null> {
  const agenda = await readJsonFileOrNull<ResearchAgenda>(run.artifacts.agendaPath);

  if (agenda === null) {
    return null;
  }

  return {
    run,
    agenda,
    source: "run",
    sourceRunId: run.id,
    sourceRunAgendaPath: run.artifacts.agendaPath,
    provenanceKnown: true
  };
}

function directionSourceRunId(direction: ResearchDirectionState | ResearchAgenda): string | null {
  const candidate = direction as Partial<ResearchDirectionState>;
  return typeof candidate.sourceRunId === "string" && candidate.sourceRunId.trim().length > 0
    ? candidate.sourceRunId
    : null;
}

function directionSourceAgendaPath(direction: ResearchDirectionState | ResearchAgenda): string | null {
  const candidate = direction as Partial<ResearchDirectionState>;
  return typeof candidate.sourceRunAgendaPath === "string" && candidate.sourceRunAgendaPath.trim().length > 0
    ? candidate.sourceRunAgendaPath
    : null;
}

export async function latestAgendaSnapshot(runStore: RunStore): Promise<AgendaSnapshot | null> {
  const runs = await runStore.list();
  const currentAgenda = await readJsonFileOrNull<ResearchDirectionState | ResearchAgenda>(researchDirectionPath(runStore.projectRoot));

  if (currentAgenda !== null) {
    const sourceRunId = directionSourceRunId(currentAgenda);
    const sourceRun = sourceRunId === null ? null : await loadRunIfPresent(runStore, sourceRunId);
    return {
      run: sourceRun,
      agenda: currentAgenda,
      source: "global",
      sourceRunId,
      sourceRunAgendaPath: directionSourceAgendaPath(currentAgenda),
      provenanceKnown: sourceRun !== null
    };
  }

  for (const run of runs) {
    const snapshot = await loadAgendaSnapshotForRun(run);

    if (snapshot !== null) {
      return snapshot;
    }
  }

  return null;
}

export function relativeProjectPath(projectRoot: string, targetPath: string): string {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath.length === 0 ? "." : relativePath;
}

function renderBanner(writer: OutputWriter, session: SessionState, transcriptPath: string): void {
  writeLine(writer, "ClawResearch");
  writeLine(writer, "============");
  writeLine(writer, `Project root: ${session.projectRoot}`);
  writeLine(writer, `Runtime state: ${relativeProjectPath(session.projectRoot, session.runtimeDirectory)}/${"session.json"}`);
  writeLine(writer, `Debug log: ${relativeProjectPath(session.projectRoot, transcriptPath)}`);
  writeLine(writer);
}

function renderWelcome(writer: OutputWriter, session: SessionState): void {
  if (session.conversation.length === 0) {
    writeLine(writer, "Startup research chat is ready.");
    writeLine(writer, "This chat should feel like a stakeholder handing a research project to a capable research partner.");
  } else {
    writeLine(writer, "Resuming the saved startup chat for this project.");
  }

  writeLine(writer, "The current directory is treated as the project root automatically.");
  writeLine(writer, "Use `/help` for commands, `/status` for the current brief, agenda, and worker state, `/sources` to inspect literature providers, `/go` to start or continue the autonomous research worker, `/agenda` to inspect the latest research agenda, and `/quit` to leave.");
  writeLine(writer);
}

const providerCategoryMetadata: Array<{
  category: ConfigurableProviderCategory;
  title: string;
  summaryLabel: string;
  promptLabel: string;
  commandExample: string;
}> = [
  {
    category: "scholarlyDiscovery",
    title: "Scholarly discovery",
    summaryLabel: "scholarly discovery",
    promptLabel: "scholarly",
    commandExample: "scholarly: openalex, crossref"
  },
  {
    category: "publisherFullText",
    title: "Publisher / full text",
    summaryLabel: "publisher/full text",
    promptLabel: "publishers",
    commandExample: "publishers: arxiv, europe-pmc"
  },
  {
    category: "oaRetrievalHelpers",
    title: "OA / retrieval helpers",
    summaryLabel: "OA/retrieval helpers",
    promptLabel: "helpers",
    commandExample: "helpers: core, unpaywall"
  },
  {
    category: "generalWeb",
    title: "General web",
    summaryLabel: "general web",
    promptLabel: "web",
    commandExample: "web: wikipedia"
  }
];

function categorySummaryLabel(category: ConfigurableProviderCategory): string {
  return providerCategoryMetadata.find((entry) => entry.category === category)?.summaryLabel ?? category;
}

function categoryPromptLabel(category: ConfigurableProviderCategory): string {
  return providerCategoryMetadata.find((entry) => entry.category === category)?.promptLabel ?? category;
}

function configuredSourceSummaryLines(projectConfig: ProjectConfigState): string[] {
  return [
    ...providerCategoryMetadata.map((entry) => `  ${entry.summaryLabel}: ${formatSelectedProviderLabels(selectedProviderIdsForCategory(projectConfig, entry.category))}`),
    `  local context: ${projectConfig.sources.localContext.projectFilesEnabled ? "on" : "off"}`
  ];
}

function writeConfiguredSourceSummary(
  writer: OutputWriter,
  projectConfig: ProjectConfigState
): void {
  for (const line of configuredSourceSummaryLines(projectConfig)) {
    writeLine(writer, line);
  }
}

function renderLiteratureSetup(
  writer: OutputWriter,
  session: SessionState,
  projectConfig: ProjectConfigState
): void {
  if (session.conversation.length > 0) {
    return;
  }

  writeLine(writer, "Provider-aware literature sources are configured for this project:");
  writeConfiguredSourceSummary(writer, projectConfig);
  writeLine(writer, "Use `scholarly: ...`, `publishers: ...`, `helpers: ...`, `web: ...`, `local: on|off`, or `sources: ...` to update them later.");
  writeLine(writer);
}

function modelProviderLabel(provider: RuntimeModelProvider): string {
  switch (provider) {
    case "ollama":
      return "Ollama local";
    case "openai":
      return "OpenAI API key";
    case "openai-codex":
      return "OpenAI Codex sign-in";
  }
}

function parseModelProviderSelection(input: string): RuntimeModelProvider | null {
  const normalized = input.trim().toLowerCase();

  switch (normalized) {
    case "":
    case "1":
    case "ollama":
    case "local":
      return "ollama";
    case "2":
    case "openai":
    case "openai api":
    case "api":
    case "api key":
      return "openai";
    case "3":
    case "codex":
    case "openai codex":
    case "chatgpt":
    case "oauth":
    case "sign in":
      return "openai-codex";
    default:
      return null;
  }
}

function defaultModelForProvider(provider: RuntimeModelProvider): string {
  switch (provider) {
    case "ollama":
      return process.env.CLAWRESEARCH_OLLAMA_MODEL ?? "qwen3:14b";
    case "openai":
      return process.env.CLAWRESEARCH_OPENAI_MODEL ?? process.env.CLAWRESEARCH_MODEL ?? "gpt-5.5";
    case "openai-codex":
      return process.env.CLAWRESEARCH_OPENAI_CODEX_MODEL ?? process.env.CLAWRESEARCH_MODEL ?? "gpt-5.5";
  }
}

function defaultHostForProvider(provider: RuntimeModelProvider): string | null {
  return provider === "ollama"
    ? process.env.OLLAMA_HOST ?? "127.0.0.1:11434"
    : null;
}

function defaultBaseUrlForProvider(provider: RuntimeModelProvider): string | null {
  switch (provider) {
    case "ollama":
      return null;
    case "openai":
      return process.env.OPENAI_BASE_URL ?? process.env.CLAWRESEARCH_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    case "openai-codex":
      return process.env.CLAWRESEARCH_OPENAI_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex";
  }
}

async function promptModelSetupInput(
  io: ConsoleIo,
  transcript: ConsoleTranscript,
  writer: OutputWriter,
  promptText: string,
  options: { secret?: boolean } = {}
): Promise<string | null> {
  while (true) {
    const response = await io.prompt(promptText);

    if (response === null) {
      return null;
    }

    const trimmed = response.trim();
    transcript.appendInput(promptText, options.secret && trimmed.length > 0 ? "[secret redacted]" : response);

    if (!trimmed.startsWith("/")) {
      return response;
    }

    switch (trimmed) {
      case "/help":
        writeLine(writer, "Model setup choices:");
        writeLine(writer, "  1 or ollama        Use a local Ollama model.");
        writeLine(writer, "  2 or openai        Use the OpenAI API with an API key.");
        writeLine(writer, "  3 or codex         Use OpenAI Codex sign-in with your ChatGPT/Codex account.");
        writeLine(writer, "  /quit              Exit before completing model setup.");
        continue;
      case "/quit":
      case "/exit":
        writeLine(writer, "Session saved. Closing ClawResearch.");
        return null;
      default:
        writeLine(writer, "Finish model setup first, or use `/help` or `/quit` here.");
        continue;
    }
  }
}

async function runInitialModelSetup(
  io: ConsoleIo,
  transcript: ConsoleTranscript,
  writer: OutputWriter,
  projectConfig: ProjectConfigState,
  projectConfigStore: ProjectConfigStore,
  modelCredentials: ModelCredentialState,
  modelCredentialStore: ModelCredentialStore
): Promise<{ completed: boolean; pendingInput: string | null }> {
  if (projectConfig.runtime.model.configured) {
    return { completed: true, pendingInput: null };
  }

  if (projectConfig.sources.explicitlyConfigured || io.interactive !== true) {
    projectConfig.runtime.model = {
      provider: "ollama",
      model: defaultModelForProvider("ollama"),
      host: defaultHostForProvider("ollama"),
      baseUrl: null,
      configured: true
    };
    await projectConfigStore.save(projectConfig);
    return { completed: true, pendingInput: null };
  }

  const finishWithDefaults = async (pendingInput: string): Promise<{ completed: boolean; pendingInput: string | null }> => {
    projectConfig.runtime.model = {
      provider: "ollama",
      model: defaultModelForProvider("ollama"),
      host: defaultHostForProvider("ollama"),
      baseUrl: null,
      configured: true
    };
    await projectConfigStore.save(projectConfig);
    await modelCredentialStore.save(modelCredentials);
    writeLine(writer, "Detected a research brief during model setup; kept the default Ollama model and moved the brief into the main chat.");
    writeLine(writer, `Saved model configuration to ${relativeProjectPath(projectConfig.projectRoot, projectConfigPath(projectConfig.projectRoot))}.`);
    writeLine(writer);
    return { completed: true, pendingInput };
  };

  writeLine(writer, "Model setup");
  writeLine(writer, "-----------");
  writeLine(writer, "Choose the model route for this project:");
  writeLine(writer, `  1. Ollama local [default: ${defaultModelForProvider("ollama")}]`);
  writeLine(writer, `  2. OpenAI API key [default model: ${defaultModelForProvider("openai")}]`);
  writeLine(writer, `  3. OpenAI Codex sign-in [default model: ${defaultModelForProvider("openai-codex")}]`);
  writeLine(writer, "Press Enter to keep the local Ollama default.");
  const providerInput = await promptModelSetupInput(io, transcript, writer, "model> ");

  if (providerInput === null) {
    return { completed: false, pendingInput: null };
  }

  if (parseExplicitBriefUpdate(providerInput) !== null) {
    return finishWithDefaults(providerInput);
  }

  const provider = parseModelProviderSelection(providerInput);

  if (provider === null) {
    writeLine(writer, "Could not parse that model route. Keeping the local Ollama default.");
  }

  const selectedProvider = provider ?? "ollama";
  const modelDefault = defaultModelForProvider(selectedProvider);
  const modelInput = await promptModelSetupInput(
    io,
    transcript,
    writer,
    `${modelProviderLabel(selectedProvider)} model [${modelDefault}]: `
  );

  if (modelInput === null) {
    return { completed: false, pendingInput: null };
  }

  if (parseExplicitBriefUpdate(modelInput) !== null) {
    projectConfig.runtime.model = {
      provider: selectedProvider,
      model: modelDefault,
      host: defaultHostForProvider(selectedProvider),
      baseUrl: defaultBaseUrlForProvider(selectedProvider),
      configured: true
    };
    await projectConfigStore.save(projectConfig);
    await modelCredentialStore.save(modelCredentials);
    writeLine(writer, "Detected a research brief during model setup; saved the selected model route and moved the brief into the main chat.");
    writeLine(writer);
    return { completed: true, pendingInput: modelInput };
  }

  projectConfig.runtime.model = {
    provider: selectedProvider,
    model: modelInput.trim().length === 0 ? modelDefault : modelInput.trim(),
    host: defaultHostForProvider(selectedProvider),
    baseUrl: defaultBaseUrlForProvider(selectedProvider),
    configured: true
  };

  if (selectedProvider === "openai" && (process.env.OPENAI_API_KEY === undefined || process.env.OPENAI_API_KEY.trim().length === 0)) {
    const keyInput = await promptModelSetupInput(
      io,
      transcript,
      writer,
      "OpenAI API key [Enter leaves it unset for now]: ",
      { secret: true }
    );

    if (keyInput === null) {
      return { completed: false, pendingInput: null };
    }

    if (parseExplicitBriefUpdate(keyInput) !== null) {
      await projectConfigStore.save(projectConfig);
      await modelCredentialStore.save(modelCredentials);
      writeLine(writer, "Detected a research brief during model credential setup; leaving the OpenAI API key unset for now.");
      writeLine(writer);
      return { completed: true, pendingInput: keyInput };
    }

    setOpenAiApiKeyCredential(modelCredentials, keyInput.trim().length === 0 ? null : keyInput);
  }

  if (selectedProvider === "openai-codex") {
    writeLine(writer, "Starting OpenAI Codex device-code sign-in.");
    try {
      const credential = await loginOpenAiCodexDeviceCode({
        onProgress(message) {
          writeLine(writer, message);
        },
        onVerification({ verificationUrl, userCode, expiresInMs }) {
          const expiresInMinutes = Math.max(1, Math.round(expiresInMs / 60_000));
          writeLine(writer, `Open this URL in your browser: ${verificationUrl}`);
          writeLine(writer, `Code: ${userCode}`);
          writeLine(writer, `Code expires in ${expiresInMinutes} minutes.`);
        }
      });
      setOpenAiCodexCredential(modelCredentials, credential);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLine(writer, `OpenAI Codex sign-in failed: ${message}`);
      writeLine(writer, "Keeping the selected route; run model setup again or edit credentials before starting a run.");
    }
  }

  await projectConfigStore.save(projectConfig);
  await modelCredentialStore.save(modelCredentials);
  const resolvedModel = resolveRuntimeModelConfig(projectConfig);
  writeLine(writer, `Saved model route: ${modelProviderLabel(resolvedModel.provider)} using ${resolvedModel.model}.`);
  writeLine(writer, `Model credentials: ${relativeProjectPath(projectConfig.projectRoot, modelCredentialStorePath(projectConfig.projectRoot))}`);
  writeLine(writer);
  return { completed: true, pendingInput: null };
}

export function renderHelp(writer: OutputWriter, session: SessionState): void {
  writeLine(writer, "Commands:");
  writeLine(writer, "  /help   Show the command list and input hints");
  writeLine(writer, "  /status Show the current research brief, run state, and backend");
  writeLine(writer, "  /sources Show the current literature providers for this project");
  writeLine(writer, "  /go     Start or continue the autonomous research worker");
  writeLine(writer, "  /agenda Show the latest saved research agenda");
  writeLine(writer, "  /paper  Show the latest review-paper draft status");
  writeLine(writer, "  /pause  Pause the active detached run");
  writeLine(writer, "  /resume Resume the active detached run");
  writeLine(writer, "  /quit   Save and exit");
  writeLine(writer, "  /exit   Alias for /quit");
  writeLine(writer);
  writeLine(writer, "Input hints:");
  writeLine(writer, "  Talk naturally about the project as if briefing a researcher.");
  writeLine(writer, "  You can still force a specific field with `topic:`, `question:`, `direction:`, or `success:`.");
  writeLine(writer, "  You can configure providers with `scholarly: openalex, crossref`, `publishers: arxiv, europe-pmc`, `helpers: core, unpaywall`, `web: wikipedia`, `local: off`, or `sources: openalex, crossref`.");
  writeLine(writer, "  Detached runs stream progress in the console and save a debug transcript locally.");
  writeLine(writer, "  Use `/paper open` to print the latest paper draft and `/paper checks` to inspect manuscript readiness checks.");
  writeLine(writer, `  Local intake backend: ${session.intake.backendLabel ?? "not configured"}`);
}

export function renderAgenda(
  writer: OutputWriter,
  snapshot: AgendaSnapshot | null,
  projectRoot: string
): void {
  if (snapshot === null) {
    writeLine(writer, "Agenda:");
    writeLine(writer, "  none yet");
    return;
  }

  writeLine(writer, "Agenda:");
  writeLine(writer, `  source: ${snapshot.provenanceKnown && snapshot.sourceRunId !== null ? `run ${snapshot.sourceRunId}` : "global/unknown"}`);
  writeLine(writer, `  current direction: ${relativeProjectPath(projectRoot, researchDirectionPath(projectRoot))}`);
  if (snapshot.run !== null) {
    writeLine(writer, `  run agenda: ${relativeProjectPath(projectRoot, snapshot.run.artifacts.agendaPath)}`);
  }
  writeLine(writer, `  summary: ${snapshot.agenda.executiveSummary}`);
  writeLine(writer, `  candidate directions: ${snapshot.agenda.candidateDirections.length}`);
  writeLine(writer, `  selected direction: ${snapshot.agenda.selectedDirectionId ?? "<none>"}`);
  writeLine(writer, `  recommended decision: ${snapshot.agenda.recommendedHumanDecision}`);

  if (snapshot.agenda.holdReasons.length > 0) {
    writeLine(writer, "  hold reasons:");

    for (const reason of snapshot.agenda.holdReasons) {
      writeLine(writer, `    - ${reason}`);
    }
  }
}

export function renderStatus(
  writer: OutputWriter,
  session: SessionState,
  run: RunRecord | null,
  transcriptPath: string,
  projectConfig: ProjectConfigState,
  credentials: CredentialStoreState,
  agendaSnapshot: AgendaSnapshot | null = null,
  workerState: ResearchWorkerState | null = null,
  workStore: ResearchWorkStore | null = null
): void {
  writeLine(writer, "Current brief:");
  writeLine(writer, `  topic: ${session.brief.topic ?? "<missing>"}`);
  writeLine(writer, `  research question: ${session.brief.researchQuestion ?? "<missing>"}`);
  writeLine(writer, `  research direction: ${session.brief.researchDirection ?? "<missing>"}`);
  writeLine(writer, `  success criterion: ${session.brief.successCriterion ?? "<missing>"}`);
  writeLine(writer);
  writeLine(writer, `Brief readiness: ${session.intake.readiness}`);
  writeLine(writer, `Readiness: ${session.intake.readiness} (brief)`);

  if (session.intake.summary !== null) {
    writeLine(writer, `Summary: ${session.intake.summary}`);
  }

  if (session.intake.rationale !== null) {
    writeLine(writer, `Rationale: ${session.intake.rationale}`);
  }

  if (session.intake.openQuestions.length > 0) {
    writeLine(writer, "Still unclear:");

    for (const question of session.intake.openQuestions) {
      writeLine(writer, `  - ${question}`);
    }
  }

  if (session.intake.lastError !== null) {
    writeLine(writer, `Last backend issue: ${session.intake.lastError}`);
  }

  writeLine(writer);
  writeLine(writer, "Run:");

  if (run === null) {
    writeLine(writer, "  none yet");
  } else {
    writeLine(writer, `  id: ${run.id}`);
    writeLine(writer, `  stage: ${run.stage}`);
    writeLine(writer, `  status: ${run.status}`);
    writeLine(writer, `  latest run outcome: ${run.status}${run.status === "failed" ? " (paper not generated)" : ""}`);

    if (run.statusMessage !== null) {
      writeLine(writer, `  detail: ${run.statusMessage}`);
    }

    if (run.job.launchCommand !== null) {
      writeLine(writer, `  launch command: ${run.job.launchCommand.join(" ")}`);
    }

    writeLine(writer, `  trace: ${relativeProjectPath(session.projectRoot, run.artifacts.tracePath)}`);
    writeLine(writer, `  events: ${relativeProjectPath(session.projectRoot, run.artifacts.eventsPath)}`);
    writeLine(writer, `  stdout: ${relativeProjectPath(session.projectRoot, run.artifacts.stdoutPath)}`);
    writeLine(writer, `  stderr: ${relativeProjectPath(session.projectRoot, run.artifacts.stderrPath)}`);
    writeLine(writer, `  plan: ${relativeProjectPath(session.projectRoot, run.artifacts.planPath)}`);
    writeLine(writer, `  sources: ${relativeProjectPath(session.projectRoot, run.artifacts.sourcesPath)}`);
    writeLine(writer, `  literature: ${relativeProjectPath(session.projectRoot, run.artifacts.literaturePath)}`);
    writeLine(writer, `  review protocol: ${relativeProjectPath(session.projectRoot, run.artifacts.reviewProtocolPath)}`);
    writeLine(writer, `  verification: ${relativeProjectPath(session.projectRoot, run.artifacts.verificationPath)}`);
    writeLine(writer, `  paper: ${relativeProjectPath(session.projectRoot, run.artifacts.paperPath)}`);
    writeLine(writer, `  paper checks: ${relativeProjectPath(session.projectRoot, run.artifacts.manuscriptChecksPath)}`);
    writeLine(writer, `  next questions: ${relativeProjectPath(session.projectRoot, run.artifacts.nextQuestionsPath)}`);
    writeLine(writer, `  agenda: ${relativeProjectPath(session.projectRoot, run.artifacts.agendaPath)}`);
    writeLine(writer, `  agenda summary: ${relativeProjectPath(session.projectRoot, run.artifacts.agendaMarkdownPath)}`);
    writeLine(writer, `  workspace db: ${relativeProjectPath(session.projectRoot, researchWorkStoreFilePath(session.projectRoot))}`);
  }

  writeLine(writer);
  writeLine(writer, `Status: ${session.status}`);
  writeLine(writer, `Go requests: ${session.goCount}`);
  writeLine(writer, `Messages saved: ${session.conversation.length}`);
  writeLine(writer, `Backend: ${session.intake.backendLabel ?? "<unknown>"}`);
  const runtimeModel = resolveRuntimeModelConfig(projectConfig);
  writeLine(writer, `Model route: ${modelProviderLabel(runtimeModel.provider)} (${runtimeModel.model})`);
  writeLine(writer, `Debug log: ${relativeProjectPath(session.projectRoot, transcriptPath)}`);
  if (agendaSnapshot === null) {
    writeLine(writer, "Agenda available: no");
  } else {
    writeLine(writer, "Agenda available: yes");
    writeLine(writer, `Agenda source: ${agendaSnapshot.provenanceKnown && agendaSnapshot.sourceRunId !== null ? `run ${agendaSnapshot.sourceRunId}` : "global/unknown"}`);
    writeLine(writer, `Selected direction: ${agendaSnapshot.agenda.selectedDirectionId ?? "<none>"}`);
  }
  writeLine(writer);
  writeLine(writer, "Autonomous worker:");
  if (workerState === null) {
    writeLine(writer, "  status: not_started");
    writeLine(writer, `  state: ${relativeProjectPath(session.projectRoot, researchWorkerStatePath(session.projectRoot))}`);
  } else {
    writeLine(writer, `  status: ${workerState.status}`);
    writeLine(writer, `  reason: ${workerState.statusReason}`);
    writeLine(writer, `  segments: ${workerState.segmentCount}`);
    writeLine(writer, `  active run: ${workerState.activeRunId ?? "<none>"}`);
    writeLine(writer, `  last run: ${workerState.lastRunId ?? "<none>"}`);
    writeLine(writer, `  paper readiness: ${workerState.paperReadiness ?? "<none>"}`);
    if (workerState.nextInternalActions.length > 0) {
      writeLine(writer, "  internal actions:");
      for (const action of workerState.nextInternalActions.slice(0, 5)) {
        writeLine(writer, `    - ${action}`);
      }
    }
    if (workerState.userBlockers.length > 0) {
      writeLine(writer, "  user blockers:");
      for (const blocker of workerState.userBlockers.slice(0, 5)) {
        writeLine(writer, `    - ${blocker}`);
      }
    }
  }
  writeLine(writer);
  writeLine(writer, "Research work store:");
  writeLine(writer, `  store: ${relativeProjectPath(session.projectRoot, researchWorkStoreFilePath(session.projectRoot))}`);
  if (workStore === null) {
    writeLine(writer, "  status: not initialized");
  } else {
    const summary = summarizeResearchWorkStore(workStore);
    writeLine(writer, `  canonical sources: ${summary.canonicalSources}`);
    writeLine(writer, `  extractions: ${summary.extractions}`);
    writeLine(writer, `  evidence cells: ${summary.evidenceCells}`);
    writeLine(writer, `  claims: ${summary.claims}`);
    writeLine(writer, `  open work items: ${summary.openWorkItems}`);
    writeLine(writer, `  release checks: ${summary.releaseChecks}`);
  }
  writeLine(writer);
  writeLine(writer, "Sources:");
  writeLine(writer, `  config: ${relativeProjectPath(session.projectRoot, projectConfigPath(session.projectRoot))}`);
  writeConfiguredSourceSummary(writer, projectConfig);

  for (const authState of authStatesForSelectedProviders(projectConfig, credentials)) {
    const statusLabel = authState.status.replace(/_/g, " ");
    const detail = authStateDetail(authState);
    writeLine(writer, `  auth ${authState.definition.label}: ${statusLabel}${detail.length === 0 ? "" : ` (${detail})`}`);
  }

  const literatureContext = workStore === null
    ? null
    : buildLiteratureContextFromWorkStore(workStore);

  if (literatureContext !== null && literatureContext.available && literatureContext.queryHints.length > 0) {
    writeLine(writer, `  current hints: ${literatureContext.queryHints.slice(0, 4).join(" | ")}`);
  }
}

function parseExplicitBriefUpdate(input: string): BriefUpdate | null {
  for (const matcher of fieldPrefixMatchers) {
    const match = input.match(matcher.pattern);

    if (match?.[1] !== undefined) {
      return {
        field: matcher.field,
        value: match[1]
      };
    }
  }

  return null;
}

type SourceSelectionUpdate = {
  category: ConfigurableProviderCategory | "localContext";
  value: string;
};

function parseSourceSelectionUpdate(input: string): SourceSelectionUpdate | null {
  const match = input.match(/^(sources?|scholarly|scholarly discovery|publishers?|publisher(?:\/| )full(?:[- ]|)text|fulltext|oa|oa helpers?|helpers?|general web|web|background|local|literature sources?)\s*:\s*(.+)$/i);
  const rawCategory = match?.[1]?.trim().toLowerCase();
  const value = match?.[2]?.trim();

  if (rawCategory === undefined || value === undefined) {
    return null;
  }

  switch (rawCategory) {
    case "sources":
    case "source":
    case "literature source":
    case "literature sources":
    case "scholarly":
    case "scholarly discovery":
      return {
        category: "scholarlyDiscovery",
        value
      };
    case "publisher":
    case "publishers":
    case "publisher fulltext":
    case "publisher full text":
    case "publisher/fulltext":
    case "publisher/full text":
    case "fulltext":
      return {
        category: "publisherFullText",
        value
      };
    case "oa":
    case "oa helper":
    case "oa helpers":
    case "helper":
    case "helpers":
      return {
        category: "oaRetrievalHelpers",
        value
      };
    case "general web":
    case "web":
    case "background":
      return {
        category: "generalWeb",
        value
      };
    case "local":
      return {
        category: "localContext",
        value
      };
    default:
      return null;
  }
}

function parseLocalToggle(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case "on":
    case "true":
    case "yes":
    case "default":
      return true;
    case "off":
    case "false":
    case "no":
    case "none":
      return false;
    default:
      return null;
  }
}

function invalidProviderSelectionMessage(category: ConfigurableProviderCategory): string {
  switch (category) {
    case "scholarlyDiscovery":
      return "I couldn't parse that scholarly-discovery selection. Use names like `scholarly: openalex, crossref`, `sources: openalex, crossref`, `sources: none`, or `sources: all`.";
    case "publisherFullText":
      return "I couldn't parse that publisher/full-text selection. Use names like `publishers: arxiv, europe-pmc` or `publishers: none`.";
    case "oaRetrievalHelpers":
      return "I couldn't parse that OA/helper selection. Use names like `helpers: core, unpaywall` or `helpers: none`.";
    case "generalWeb":
      return "I couldn't parse that general-web selection. Use names like `web: wikipedia` or `web: none`.";
  }
}

function updatedProviderSelectionMessage(
  category: ConfigurableProviderCategory,
  providerIds: SourceProviderId[]
): string {
  return `Updated ${categorySummaryLabel(category)} providers for this project: ${formatSelectedLiteratureProviders(providerIds)}.`;
}

export function renderSources(
  writer: OutputWriter,
  session: SessionState,
  projectConfig: ProjectConfigState,
  credentials: CredentialStoreState
): void {
  writeLine(writer, "Providers for this project:");
  for (const entry of providerCategoryMetadata) {
    writeLine(writer, `  ${entry.title}:`);
    for (const line of createProviderSelectionLines(entry.category, selectedProviderIdsForCategory(projectConfig, entry.category))) {
      writeLine(writer, `    ${line}`);
    }
  }
  writeLine(writer, `  Local context: ${projectConfig.sources.localContext.projectFilesEnabled ? "on" : "off"}`);
  writeLine(writer, "  Auth:");
  const authStates = authStatesForSelectedProviders(projectConfig, credentials);
  if (authStates.length === 0) {
    writeLine(writer, "    none needed");
  } else {
    for (const authState of authStates) {
      writeLine(
        writer,
        `    ${authState.definition.label}: ${authState.status.replace(/_/g, " ")}${authStateDetail(authState).length === 0 ? "" : ` (${authStateDetail(authState)})`}`
      );
    }
  }
  writeLine(writer, `Config: ${relativeProjectPath(session.projectRoot, projectConfigPath(session.projectRoot))}`);
  writeLine(writer, `Credentials: ${relativeProjectPath(session.projectRoot, credentialStorePath(session.projectRoot))}`);
  writeLine(writer);
  writeLine(writer, "Update with `scholarly: openalex, crossref`, `publishers: arxiv, europe-pmc`, `helpers: core, unpaywall`, `web: wikipedia`, `local: off`, or `sources: openalex, crossref`.");
}

async function promptProviderCredentials(
  io: ConsoleIo,
  transcript: ConsoleTranscript,
  writer: OutputWriter,
  credentials: CredentialStoreState,
  providerIds: SourceProviderId[]
): Promise<{ completed: boolean; pendingInput: string | null }> {
  for (const providerId of providerIds) {
    const definition = getSourceProviderDefinition(providerId);
    for (const field of providerCredentialFields(providerId)) {
      const label = credentialPromptLabel(definition.label, field.label);
      const promptText = `${label} [${field.required ? "required" : "optional"}; Enter leaves it ${field.required ? "unavailable" : "unset"}]: `;
      const response = await io.prompt(promptText);

      if (response === null) {
        return { completed: false, pendingInput: null };
      }

      if (parseExplicitBriefUpdate(response) !== null) {
        transcript.appendInput(promptText, "[moved to main chat]");
        writeLine(writer, "Detected a research brief during credential setup; leaving remaining credentials unset for now.");
        return { completed: true, pendingInput: response };
      }

      transcript.appendInput(promptText, response.trim().length === 0 ? "[blank]" : "[secret redacted]");
      const trimmed = response.trim();

      if (trimmed.length === 0) {
        setCredentialValue(credentials, providerId, field.id, null);
        writeLine(
          writer,
          field.required
            ? `Leaving ${label} unset for now.`
            : `Leaving ${label} empty for now.`
        );
        continue;
      }

      setCredentialValue(credentials, providerId, field.id, trimmed);
      applyCredentialsToEnvironment(credentials);
      writeLine(writer, `Saved ${label}.`);
    }
  }

  return { completed: true, pendingInput: null };
}

async function promptSetupInput(
  io: ConsoleIo,
  transcript: ConsoleTranscript,
  writer: OutputWriter,
  session: SessionState,
  projectConfig: ProjectConfigState,
  credentials: CredentialStoreState,
  promptText: string
): Promise<string | null> {
  while (true) {
    const response = await io.prompt(promptText);

    if (response === null) {
      return null;
    }

    transcript.appendInput(promptText, response);
    const trimmed = response.trim();

    if (!trimmed.startsWith("/")) {
      return response;
    }

    switch (trimmed) {
      case "/sources":
        renderSources(writer, session, projectConfig, credentials);
        continue;
      case "/help":
        writeLine(writer, "Source setup commands:");
        writeLine(writer, "  `/sources` Show the current grouped source configuration.");
        writeLine(writer, "  `/quit` Exit before completing source setup.");
        writeLine(writer, "  Press Enter to keep the displayed defaults for the current prompt.");
        continue;
      case "/quit":
      case "/exit":
        writeLine(writer, "Session saved. Closing ClawResearch.");
        return null;
      default:
        writeLine(writer, "Finish source setup first, or use `/sources`, `/help`, or `/quit` here.");
        continue;
    }
  }
}

async function runInitialSourceSetup(
  io: ConsoleIo,
  transcript: ConsoleTranscript,
  writer: OutputWriter,
  session: SessionState,
  projectConfig: ProjectConfigState,
  projectConfigStore: ProjectConfigStore,
  credentialStore: CredentialStore,
  credentials: CredentialStoreState
): Promise<{ completed: boolean; pendingInput: string | null }> {
  if (projectConfig.sources.explicitlyConfigured) {
    return { completed: true, pendingInput: null };
  }

  const finishWithDefaults = async (pendingInput: string): Promise<{ completed: boolean; pendingInput: string | null }> => {
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);
    await credentialStore.save(credentials);
    writeLine(writer, "Detected a research brief during source setup; kept source defaults and moved the brief into the main chat.");
    writeLine(writer, `Saved source configuration to ${relativeProjectPath(projectConfig.projectRoot, projectConfigPath(projectConfig.projectRoot))}.`);
    writeLine(writer);
    return { completed: true, pendingInput };
  };

  writeLine(writer, "Source setup");
  writeLine(writer, "------------");
  for (const entry of providerCategoryMetadata) {
    writeLine(writer, `${entry.title} providers:`);
    for (const line of providerSelectionLines(entry.category)) {
      writeLine(writer, `  ${line}`);
    }
    writeLine(writer, `Default ${entry.summaryLabel} selection: ${formatSelectedProviderLabels(selectedProviderIdsForCategory(projectConfig, entry.category))}`);
    const prompt = `${categoryPromptLabel(entry.category)}> `;
    const input = await promptSetupInput(io, transcript, writer, session, projectConfig, credentials, prompt);

    if (input === null) {
      return { completed: false, pendingInput: null };
    }

    if (parseExplicitBriefUpdate(input) !== null) {
      return finishWithDefaults(input);
    }

    const selection = input.trim().length === 0
      ? selectedProviderIdsForCategory(projectConfig, entry.category)
      : parseProviderSelection(input, entry.category);

    if (selection === null) {
      writeLine(writer, `Could not parse that ${entry.summaryLabel} provider selection. Keeping defaults.`);
    } else {
      projectConfig.sources[entry.category].selectedProviderIds = selection;
    }
  }

  const localPrompt = "local> ";
  writeLine(writer, `Local project files are currently ${projectConfig.sources.localContext.projectFilesEnabled ? "on" : "off"}. Type \`on\` or \`off\`, or press Enter to keep the default.`);
  const localInput = await promptSetupInput(io, transcript, writer, session, projectConfig, credentials, localPrompt);

  if (localInput === null) {
    return { completed: false, pendingInput: null };
  }

  if (parseExplicitBriefUpdate(localInput) !== null) {
    return finishWithDefaults(localInput);
  }

  if (localInput.trim().length > 0) {
    const localSetting = parseLocalToggle(localInput);

    if (localSetting !== null) {
      projectConfig.sources.localContext.projectFilesEnabled = localSetting;
    } else {
      writeLine(writer, "Could not parse that local-files setting. Keeping the default.");
    }
  }

  const authPrompted = await promptProviderCredentials(
    io,
    transcript,
    writer,
    credentials,
    selectedScholarlySourceProviders(projectConfig)
  );

  if (!authPrompted.completed) {
    return { completed: false, pendingInput: null };
  }

  projectConfig.sources.explicitlyConfigured = true;
  await projectConfigStore.save(projectConfig);
  await credentialStore.save(credentials);
  writeLine(writer, `Saved source configuration to ${relativeProjectPath(projectConfig.projectRoot, projectConfigPath(projectConfig.projectRoot))}.`);
  writeLine(writer);
  return { completed: true, pendingInput: authPrompted.pendingInput };
}

function normalizeDraftLabel(label: string): ResearchBriefField | null {
  const normalized = normalizeComparableText(label);

  switch (normalized) {
    case "topic":
    case "research topic":
      return "topic";
    case "question":
    case "research question":
      return "researchQuestion";
    case "direction":
    case "research direction":
      return "researchDirection";
    case "success":
    case "success criterion":
      return "successCriterion";
    default:
      return null;
  }
}

function stripSimpleMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function trimDraftFieldTail(value: string): string {
  return value.replace(
    /\s+(?:Let me know if|If that framing|If this framing|If that looks right|If this looks right|If you want to adjust|If you'd like to adjust|You can use \/go|I can proceed with that framing|Does this align|Please let me know).*/i,
    ""
  ).trim();
}

function parseDraftBriefFromText(text: string): ResearchBrief {
  const normalized = stripSimpleMarkdown(text);
  const brief: ResearchBrief = {
    topic: null,
    researchQuestion: null,
    researchDirection: null,
    successCriterion: null
  };
  const matches = [...normalized.matchAll(/\b(topic|research topic|research question|question|research direction|direction|success criterion|success)\s*:\s*/gi)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];

    if (match?.index === undefined || match[1] === undefined) {
      continue;
    }

    const field = normalizeDraftLabel(match[1]);

    if (field === null) {
      continue;
    }

    const valueStart = match.index + match[0].length;
    const valueEnd = matches[index + 1]?.index ?? normalized.length;
    const value = normalized
      .slice(valueStart, valueEnd)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[\-*]\s*/, "")
      .replace(/[.]\s*$/, "")
      .trim();
    const trimmedValue = trimDraftFieldTail(value)
      .trim();

    if (trimmedValue.length > 0 && !isPlaceholderFieldValue(trimmedValue)) {
      brief[field] = trimmedValue;
    }
  }

  return brief;
}

function summarizeMissingFields(session: SessionState): string[] {
  return Object.entries(session.brief)
    .filter(([, value]) => value === null)
    .map(([field]) => fieldLabels[field as ResearchBriefField]);
}

function briefValues(brief: ResearchBrief): string[] {
  return Object.values(brief).filter((value): value is string => value !== null);
}

function briefSignalCount(brief: ResearchBrief): number {
  return briefValues(brief).length;
}

function responseHasCompleteBrief(response: IntakeResponse): boolean {
  return briefValues(response.brief).length === Object.keys(response.brief).length;
}

function saveAssistantMessage(
  session: SessionState,
  text: string,
  timestamp: string,
  kind: ConversationKind = "chat"
): void {
  appendConversationEntry(session, "assistant", text, timestamp, kind);
}

function saveUserMessage(
  session: SessionState,
  text: string,
  timestamp: string,
  kind: ConversationKind = "chat"
): void {
  appendConversationEntry(session, "user", text, timestamp, kind);
}

function applyExplicitFieldUpdate(session: SessionState, update: BriefUpdate): void {
  setBriefField(session, update.field, update.value);
}

function comparableRootSet(text: string): Set<string> {
  return new Set(
    normalizeComparableText(text)
      .split(" ")
      .filter((token) => token.length >= 4)
      .map((token) => token.slice(0, 7))
  );
}

function sharedComparableRoots(left: string, right: string): number {
  const leftRoots = comparableRootSet(left);
  const rightRoots = comparableRootSet(right);
  let overlap = 0;

  for (const root of leftRoots) {
    if (rightRoots.has(root)) {
      overlap += 1;
    }
  }

  return overlap;
}

function fieldSpecificityScore(value: string): number {
  const normalized = normalizeComparableText(value);
  const words = normalized.split(" ").filter((word) => word.length > 0);
  let score = words.length;

  if (/[,:;]/.test(value)) {
    score += 1;
  }

  if (/\b(with|through|using|around|focused|focus|rather than|identify|produce|review|compare|evaluate|explor|grounded|deliverable|paper|manuscript|publication|publications)\b/i.test(value)) {
    score += 2;
  }

  if (genericFieldPattern.test(normalized)) {
    score -= 4;
  }

  return score;
}

function isPlaceholderFieldValue(value: string): boolean {
  return /^(?:string(?:\s+or\s+null)?|null|n\/a|tbd|unknown)$/i.test(value.trim());
}

function shouldKeepExistingField(existing: string, incoming: string): boolean {
  const normalizedExisting = normalizeComparableText(existing);
  const normalizedIncoming = normalizeComparableText(incoming);

  if (normalizedExisting === normalizedIncoming) {
    return true;
  }

  const existingContainsIncoming = normalizedIncoming.length >= 8 && normalizedExisting.includes(normalizedIncoming);
  const sharedRoots = sharedComparableRoots(existing, incoming);
  const specificityGap = fieldSpecificityScore(existing) - fieldSpecificityScore(incoming);
  const incomingWordCount = normalizedIncoming.split(" ").filter((word) => word.length > 0).length;
  const existingIsConcreteDeliverable = deliverablePattern.test(existing);
  const incomingIsConcreteDeliverable = deliverablePattern.test(incoming);

  return specificityGap >= 3
    && (sharedRoots > 0 || existingContainsIncoming || incomingWordCount <= 3)
    || (existingIsConcreteDeliverable && !incomingIsConcreteDeliverable && incomingWordCount > 4);
}

function mergeBriefFieldValue(existing: string | null, incoming: string | null): string | null {
  if (incoming === null || isPlaceholderFieldValue(incoming)) {
    return existing;
  }

  if (existing !== null && shouldKeepExistingField(existing, incoming)) {
    return existing;
  }

  return incoming;
}

function textHasBoundedMode(text: string | null): boolean {
  return text !== null && boundedModePattern.test(text);
}

function successCriterionNeedsReframe(text: string | null): boolean {
  if (text === null) {
    return false;
  }

  return directEndStatePattern.test(text) && !deliverablePattern.test(text);
}

function researchQuestionNeedsReframe(text: string | null): boolean {
  if (text === null) {
    return false;
  }

  return directEndStatePattern.test(text) && !textHasBoundedMode(text);
}

function briefNeedsBoundedReframe(brief: ResearchBrief): boolean {
  if (successCriterionNeedsReframe(brief.successCriterion)) {
    return true;
  }

  const boundedSignals = [
    brief.researchQuestion,
    brief.researchDirection,
    brief.successCriterion
  ].filter(textHasBoundedMode).length;

  return researchQuestionNeedsReframe(brief.researchQuestion) && boundedSignals === 0;
}

function briefCanStartFirstPass(brief: ResearchBrief): boolean {
  return briefValues(brief).length === Object.keys(brief).length
    && !briefNeedsBoundedReframe(brief);
}

function stabilizeIntakeResponse(session: SessionState, response: IntakeResponse): IntakeResponse {
  const draftBrief = parseDraftBriefFromText(response.assistantMessage);
  const brief: ResearchBrief = {
    topic: mergeBriefFieldValue(
      mergeBriefFieldValue(session.brief.topic, response.brief.topic),
      draftBrief.topic
    ),
    researchQuestion: mergeBriefFieldValue(
      mergeBriefFieldValue(session.brief.researchQuestion, response.brief.researchQuestion),
      draftBrief.researchQuestion
    ),
    researchDirection: mergeBriefFieldValue(
      mergeBriefFieldValue(session.brief.researchDirection, response.brief.researchDirection),
      draftBrief.researchDirection
    ),
    successCriterion: mergeBriefFieldValue(
      mergeBriefFieldValue(session.brief.successCriterion, response.brief.successCriterion),
      draftBrief.successCriterion
    )
  };
  const normalizedResponse: IntakeResponse = {
    ...response,
    brief
  };

  if (briefCanStartFirstPass(brief)) {
    return {
      ...normalizedResponse,
      readiness: "ready",
      readinessRationale: response.readinessRationale ?? "The brief is concrete enough to start a first-pass research run.",
      openQuestions: response.readiness === "ready" ? response.openQuestions : []
    };
  }

  return normalizedResponse;
}

function applyIntakeResponse(session: SessionState, response: IntakeResponse): void {
  for (const [field, value] of Object.entries(response.brief)) {
    if (value === null || isPlaceholderFieldValue(value)) {
      session.brief[field as ResearchBriefField] = null;
      session.status = "startup_chat";
      continue;
    }

    setBriefField(session, field as ResearchBriefField, value);
  }

  session.intake.readiness = response.readiness;
  session.intake.rationale = response.readinessRationale;
  session.intake.openQuestions = response.openQuestions;
  session.intake.summary = response.summary;
  session.intake.lastError = null;
}

function recentChatMessages(
  session: SessionState,
  role: "assistant" | "user",
  limit = 4
): string[] {
  return session.conversation
    .filter((entry) => entry.kind === "chat" && entry.role === role)
    .slice(-limit)
    .map((entry) => entry.text);
}

function allChatMessages(
  session: SessionState,
  role: "assistant" | "user"
): string[] {
  return session.conversation
    .filter((entry) => entry.kind === "chat" && entry.role === role)
    .map((entry) => entry.text);
}

function normalizeComparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"()[\],.:;!?-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparableTokenSet(text: string): Set<string> {
  return new Set(
    normalizeComparableText(text)
      .split(" ")
      .filter((token) => token.length >= 4)
  );
}

function textSimilarity(left: string, right: string): number {
  const leftTokens = comparableTokenSet(left);
  const rightTokens = comparableTokenSet(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return normalizeComparableText(left) === normalizeComparableText(right) ? 1 : 0;
  }

  let overlap = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function looksLikeSubstantialUserTurn(text: string): boolean {
  const normalized = normalizeComparableText(text);

  if (normalized.length < 6) {
    return false;
  }

  if (/^(hi|hello|hey|yes|no|maybe|sure|okay|ok|thanks)$/.test(normalized)) {
    return false;
  }

  return true;
}

function assistantIsStillClarifying(response: IntakeResponse): boolean {
  return response.readiness === "needs_clarification"
    && (response.assistantMessage.includes("?") || response.openQuestions.length > 0);
}

function extractTopicHint(session: SessionState, response: IntakeResponse): string | null {
  if (response.brief.topic !== null) {
    return response.brief.topic;
  }

  if (session.brief.topic !== null) {
    return session.brief.topic;
  }

  const recentUser = recentChatMessages(session, "user", 4).reverse();

  for (const message of recentUser) {
    const normalized = message.trim();

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
}

function seemsLikeRepeatedAssistantTurn(session: SessionState, response: IntakeResponse): boolean {
  const assistantMessages = recentChatMessages(session, "assistant", 2);
  const previousAssistant = assistantMessages.at(-1);

  if (previousAssistant === undefined) {
    return false;
  }

  return textSimilarity(previousAssistant, response.assistantMessage) >= 0.72;
}

function userSignaledRepeatedQuestion(session: SessionState): boolean {
  const lastUserMessage = recentChatMessages(session, "user", 1).at(-1);

  if (lastUserMessage === undefined) {
    return false;
  }

  return /(already|same question|repeat|repeating|you asked me that)/i.test(lastUserMessage);
}

function enoughSignalToDraft(session: SessionState, response: IntakeResponse): boolean {
  if (!assistantIsStillClarifying(response)) {
    return false;
  }

  const userTurns = allChatMessages(session, "user").filter(looksLikeSubstantialUserTurn);
  const assistantQuestions = recentChatMessages(session, "assistant", 4)
    .filter((message) => message.includes("?"))
    .length;
  const hasTopicSignal = extractTopicHint(session, response) !== null;
  const briefSignal = briefSignalCount({
    topic: mergeBriefFieldValue(session.brief.topic, response.brief.topic),
    researchQuestion: mergeBriefFieldValue(session.brief.researchQuestion, response.brief.researchQuestion),
    researchDirection: mergeBriefFieldValue(session.brief.researchDirection, response.brief.researchDirection),
    successCriterion: mergeBriefFieldValue(session.brief.successCriterion, response.brief.successCriterion)
  });

  return hasTopicSignal && (
    (userTurns.length >= 3 && assistantQuestions >= 2)
    || (userTurns.length >= 3 && briefSignal >= 2)
    || (userTurns.length >= 2 && briefSignal >= 3)
    || userTurns.length >= 5
  );
}

function overambitiousGoalDetected(session: SessionState, response: IntakeResponse): boolean {
  const texts = [
    response.brief.topic,
    response.brief.researchQuestion,
    response.brief.researchDirection,
    session.brief.topic,
    session.brief.researchQuestion,
    ...recentChatMessages(session, "user", 4)
  ].filter((value): value is string => value !== null);

  const combined = texts.join(" ").toLowerCase();
  const mentionsGrandGoal = userAmbitionPattern.test(combined);
  const lacksBoundedPlan = response.brief.researchDirection === null
    && session.brief.researchDirection === null
    && response.brief.successCriterion === null
    && session.brief.successCriterion === null;

  return mentionsGrandGoal && lacksBoundedPlan;
}

function buildRecoveryReason(session: SessionState, response: IntakeResponse): string | null {
  if (responseHasCompleteBrief(response) && briefNeedsBoundedReframe(response.brief)) {
    const topicHint = extractTopicHint(session, response) ?? "the project";
    return `The current brief for ${topicHint} still mirrors an end-state breakthrough goal too literally. Reframe it as a bounded first-pass research program with a realistic deliverable. Keep the topic, but rewrite the research question, direction, and success criterion so they describe credible next-step work rather than directly solving the grand challenge.`;
  }

  const repeatedClarification = userSignaledRepeatedQuestion(session)
    || seemsLikeRepeatedAssistantTurn(session, response);
  const enoughSignal = enoughSignalToDraft(session, response);

  if (!(repeatedClarification || enoughSignal)) {
    return null;
  }

  if (enoughSignal) {
    const topicHint = extractTopicHint(session, response) ?? "the project";
    return `The user has already provided several rounds of narrowing detail about ${topicHint}. Stop asking smaller clarifications. Draft the best working research brief and suggestion you can from the current context, then ask the user to confirm or correct it.`;
  }

  if (overambitiousGoalDetected(session, response)) {
    const topicHint = extractTopicHint(session, response) ?? "the project";
    return `The conversation is stuck in repeated clarification and the user is aiming directly at a broad end goal for ${topicHint}. Propose a realistic first-pass research brief instead of asking another narrow follow-up.`;
  }

  const topicHint = extractTopicHint(session, response) ?? "the project";
  return `The conversation is stuck in repeated clarification around ${topicHint}. Stop drilling into smaller details. Draft the most workable brief you can from the existing context and ask the user to confirm or correct it.`;
}

function userFacingGoRationale(session: SessionState): string | null {
  const rationale = session.intake.rationale;

  if (rationale === null) {
    return null;
  }

  if (/structured brief|field/i.test(rationale)) {
    return null;
  }

  return rationale;
}

function buildGoNotReadyLines(session: SessionState): string[] {
  const missingFields = summarizeMissingFields(session);
  const lines = ["I'm not ready to start the run yet."];

  if (missingFields.length > 0) {
    lines.push(`I still need: ${missingFields.join(", ")}.`);
  }

  const rationale = userFacingGoRationale(session);

  if (rationale !== null) {
    lines.push(rationale);
  }

  if (session.intake.openQuestions.length > 0) {
    lines.push(`Best next question: ${session.intake.openQuestions[0]}`);
  }

  if (lines.length === 1) {
    lines.push("I need one more clarification before I can lock the project brief.");
  }

  return lines;
}

function eventTag(kind: RunEventKind): string {
  switch (kind) {
    case "run":
      return "run";
    case "plan":
      return "plan";
    case "literature":
      return "literature";
    case "summary":
      return "summary";
    case "memory":
      return "memory";
    case "verify":
      return "verify";
    case "next":
      return "next";
    case "source":
      return "source";
    case "claim":
      return "claim";
    case "exec":
      return "exec";
    case "stdout":
      return "stdout";
    case "stderr":
      return "stderr";
  }
}

function renderRunEvent(writer: OutputWriter, event: RunEventRecord): void {
  renderTaggedBlock(writer, eventTag(event.kind), event.message);
}

async function readNewRunEvents(
  run: RunRecord,
  cursor: { offset: number; trailingBuffer: string }
): Promise<RunEventRecord[]> {
  const chunk = await readRunEventChunk(run.artifacts.eventsPath, cursor.offset);
  cursor.offset = chunk.nextOffset;
  const parsed = parseRunEventLines(chunk.content, cursor.trailingBuffer);
  cursor.trailingBuffer = parsed.trailingBuffer;
  return parsed.events;
}

export function isTerminalRun(run: RunRecord): boolean {
  return run.status === "completed" || run.status === "failed";
}

function createInitialRunCommand(): string[] {
  return ["clawresearch", "research-loop", "--mode", "plan-gather-synthesize"];
}

async function loadRunIfPresent(
  runStore: RunStore,
  runId: string | null
): Promise<RunRecord | null> {
  if (runId === null) {
    return null;
  }

  try {
    return await runStore.load(runId);
  } catch {
    return null;
  }
}

export async function reconcileRelevantRun(
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  runController: RunController,
  now: () => string
): Promise<RunRecord | null> {
  let run = await loadRunIfPresent(runStore, session.activeRunId);

  if (run !== null && !isTerminalRun(run) && run.workerPid !== null && !runController.isProcessAlive(run.workerPid)) {
    const previousUpdatedAt = run.updatedAt;
    await delay(250);

    const refreshedRun = await loadRunIfPresent(runStore, run.id);

    if (refreshedRun !== null) {
      run = refreshedRun;
    }

    if (
      run !== null
      && !isTerminalRun(run)
      && run.workerPid !== null
      && !runController.isProcessAlive(run.workerPid)
      && run.updatedAt === previousUpdatedAt
    ) {
      run.status = "failed";
      run.finishedAt = run.finishedAt ?? now();
      run.workerPid = null;
      run.statusMessage = "Detached run worker stopped before the run finished cleanly.";
      await runStore.save(run);
      const workerState = await loadResearchWorkerState(session.projectRoot)
        ?? createResearchWorkerState({
          projectRoot: session.projectRoot,
          brief: run.brief,
          now: now()
        });
      await writeResearchWorkerState({
        ...workerState,
        projectRoot: session.projectRoot,
        brief: run.brief,
        status: "paused",
        activeRunId: null,
        lastRunId: run.id,
        segmentCount: Math.max(1, workerState.segmentCount + (workerState.activeRunId === run.id ? 1 : 0)),
        updatedAt: run.finishedAt,
        statusReason: "The detached worker process stopped before a terminal checkpoint. The current objective can be retried with `/go` after inspecting diagnostics.",
        paperReadiness: workerState.paperReadiness,
        nextInternalActions: [
          "Inspect the failed run diagnostics and retry the autonomous worker segment."
        ],
        userBlockers: [],
        evidence: workerState.evidence,
        critic: workerState.critic
      });
    }
  }

  if (run !== null && isTerminalRun(run) && session.activeRunId === run.id) {
    session.activeRunId = null;
    session.lastRunId = run.id;
    await store.save(session);
  }

  const fallbackRun = run ?? await loadRunIfPresent(runStore, session.lastRunId);
  const latestRun = await runStore.latest();
  const preferredRun = latestRun !== null
    && (fallbackRun === null || latestRun.createdAt >= fallbackRun.createdAt)
    ? latestRun
    : fallbackRun;

  if (preferredRun !== null) {
    if (!isTerminalRun(preferredRun)) {
      session.activeRunId = preferredRun.id;
    } else {
      session.activeRunId = null;
      session.lastRunId = preferredRun.id;
    }

    await store.save(session);
    return preferredRun;
  }

  if (session.activeRunId !== null) {
    session.activeRunId = null;
    await store.save(session);
  }

  return null;
}

function normalizedFieldValue(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function briefsMatch(left: ResearchBrief, right: ResearchBrief): boolean {
  return normalizedFieldValue(left.topic) === normalizedFieldValue(right.topic)
    && normalizedFieldValue(left.researchQuestion) === normalizedFieldValue(right.researchQuestion)
    && normalizedFieldValue(left.researchDirection) === normalizedFieldValue(right.researchDirection)
    && normalizedFieldValue(left.successCriterion) === normalizedFieldValue(right.successCriterion);
}

async function readTextFileOrNull(filePath: string): Promise<string | null> {
  try {
    const contents = await readFile(filePath, "utf8");
    const trimmed = contents.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

type PaperSnapshot = {
  run: RunRecord;
  paper: ReviewPaperArtifact | null;
  checks: ManuscriptChecksArtifact | null;
  markdown: string | null;
  diagnostics: RuntimeArtifactStatus | null;
  recentEvents: string[];
};

async function latestPaperSnapshot(runStore: RunStore): Promise<PaperSnapshot | null> {
  const runs = await runStore.list();
  let latestFailedRun: RunRecord | null = null;

  for (const run of runs) {
    const paper = await readJsonFileOrNull<ReviewPaperArtifact>(run.artifacts.paperJsonPath);
    const checks = await readJsonFileOrNull<ManuscriptChecksArtifact>(run.artifacts.manuscriptChecksPath);
    const markdown = await readTextFileOrNull(run.artifacts.paperPath);
    const meaningfulMarkdown = markdown !== null && !/^# Review Paper\s+Status: /is.test(markdown)
      ? markdown
      : null;

    if (paper !== null || checks !== null || meaningfulMarkdown !== null) {
      return {
        run,
        paper,
        checks,
        markdown: meaningfulMarkdown,
        diagnostics: await readArtifactStatusOrNull(run.artifacts.manuscriptChecksPath)
          ?? await readArtifactStatusOrNull(run.artifacts.paperJsonPath),
        recentEvents: await readRecentRunEvents(run)
      };
    }

    if (latestFailedRun === null && run.status === "failed") {
      latestFailedRun = run;
    }
  }

  if (latestFailedRun !== null) {
    return {
      run: latestFailedRun,
      paper: null,
      checks: null,
      markdown: null,
      diagnostics: await readArtifactStatusOrNull(latestFailedRun.artifacts.manuscriptChecksPath)
        ?? await readArtifactStatusOrNull(latestFailedRun.artifacts.paperJsonPath),
      recentEvents: await readRecentRunEvents(latestFailedRun)
    };
  }

  return null;
}

function paperNextAction(snapshot: PaperSnapshot): string {
  const readiness = snapshot.checks?.readinessStatus ?? snapshot.paper?.readinessStatus ?? "not_started";

  if (snapshot.run.status === "failed" && snapshot.paper === null && snapshot.checks === null) {
    return "Inspect the failed run diagnostics, then rerun after the blocked stage has been fixed.";
  }

  switch (readiness) {
    case "ready_for_revision":
      return "Read the draft, inspect checks, and revise scientifically before publication review.";
    case "needs_more_evidence":
      return "Inspect retrieval diagnostics, missing facets, and access limits before treating the draft as mature.";
    case "needs_human_review":
      return "Resolve manuscript-check blockers before relying on the draft.";
    case "blocked":
      return "Do not treat this as a review paper yet; rerun retrieval or fix access/evidence blockers first.";
    case "drafted":
      return "Inspect `/paper checks` before using the draft.";
    case "not_started":
      return "Run `/go` to produce review-paper artifacts.";
  }
}

function renderPaperStatus(
  writer: OutputWriter,
  snapshot: PaperSnapshot | null,
  projectRoot: string
): void {
  writeLine(writer, "Paper:");

  if (snapshot === null) {
    writeLine(writer, "  none yet");
    return;
  }

  const paper = snapshot.paper;
  const checks = snapshot.checks;

  writeLine(writer, `  run id: ${snapshot.run.id}`);
  writeLine(writer, `  run status: ${snapshot.run.status}`);
  writeLine(writer, `  run stage: ${snapshot.run.stage}`);
  writeLine(writer, `  paper path: ${relativeProjectPath(projectRoot, snapshot.run.artifacts.paperPath)}`);
  writeLine(writer, `  checks path: ${relativeProjectPath(projectRoot, snapshot.run.artifacts.manuscriptChecksPath)}`);
  writeLine(writer, `  title: ${paper?.title ?? "<unknown>"}`);
  writeLine(writer, `  readiness: ${checks?.readinessStatus ?? paper?.readinessStatus ?? "not_started"}`);
  writeLine(writer, `  cited papers: ${paper?.referencedPaperIds.length ?? 0}`);
  writeLine(writer, `  claims: ${paper?.claims.length ?? 0}`);
  writeLine(writer, `  blockers: ${checks?.blockerCount ?? 0}`);

  if (paper === null && checks === null && snapshot.run.status === "failed") {
    writeLine(writer, `  no draft reason: ${snapshot.run.statusMessage ?? "run failed before manuscript generation"}`);
  }

  if (snapshot.diagnostics?.error !== null && snapshot.diagnostics?.error !== undefined) {
    writeLine(writer, `  diagnostic: ${snapshot.diagnostics.error.kind} during ${snapshot.diagnostics.error.operation ?? snapshot.diagnostics.stage} - ${snapshot.diagnostics.error.message}`);
  }

  if (checks !== null && checks.blockers.length > 0) {
    writeLine(writer, "  blocker details:");
    for (const blocker of checks.blockers) {
      writeLine(writer, `    - ${blocker}`);
    }
  }

  writeLine(writer, `  next action: ${paperNextAction(snapshot)}`);
}

function renderPaperChecks(writer: OutputWriter, snapshot: PaperSnapshot | null): void {
  writeLine(writer, "Paper checks:");

  if (snapshot === null || snapshot.checks === null) {
    if (snapshot === null) {
      writeLine(writer, "  none yet");
      return;
    }

    writeLine(writer, "  none yet");
    writeLine(writer, `  run id: ${snapshot.run.id}`);
    writeLine(writer, `  run status: ${snapshot.run.status}`);
    writeLine(writer, `  run stage: ${snapshot.run.stage}`);

    if (snapshot.run.statusMessage !== null) {
      writeLine(writer, `  detail: ${snapshot.run.statusMessage}`);
    }

    if (snapshot.diagnostics?.error !== null && snapshot.diagnostics?.error !== undefined) {
      writeLine(writer, `  diagnostic: ${snapshot.diagnostics.error.kind} during ${snapshot.diagnostics.error.operation ?? snapshot.diagnostics.stage} - ${snapshot.diagnostics.error.message}`);
    }

    if (snapshot.recentEvents.length > 0) {
      writeLine(writer, "  recent events:");
      for (const event of snapshot.recentEvents) {
        writeLine(writer, `    - ${event}`);
      }
    }
    return;
  }

  writeLine(writer, `  readiness: ${snapshot.checks.readinessStatus}`);
  writeLine(writer, `  blockers: ${snapshot.checks.blockerCount}`);
  writeLine(writer, `  warnings: ${snapshot.checks.warningCount}`);

  for (const checkItem of snapshot.checks.checks) {
    writeLine(writer, `  - ${checkItem.status}: ${checkItem.title} - ${checkItem.message}`);
  }
}

async function readRecentRunEvents(run: RunRecord, limit = 8): Promise<string[]> {
  const raw = await readTextFileOrNull(run.artifacts.eventsPath);

  if (raw === null) {
    return [];
  }

  const parsed = parseRunEventLines(`${raw}\n`);
  return parsed.events
    .slice(-limit)
    .map((event) => `${event.kind}: ${event.message}`);
}

type ProjectAssistantContextSnapshot = {
  run: RunRecord;
  currentRun: ProjectAssistantRunContext;
  agenda: ResearchAgenda | null;
};

async function loadProjectAssistantContext(
  session: SessionState,
  runStore: RunStore
): Promise<ProjectAssistantContextSnapshot | null> {
  const preferredRun = await loadRunIfPresent(runStore, session.activeRunId)
    ?? await loadRunIfPresent(runStore, session.lastRunId)
    ?? await runStore.latest();

  if (preferredRun === null) {
    return null;
  }

  const agendaSnapshot = await loadAgendaSnapshotForRun(preferredRun)
    ?? await latestAgendaSnapshot(runStore);
  const summaryMarkdown = await readTextFileOrNull(preferredRun.artifacts.summaryPath);
  const recentEvents = await readRecentRunEvents(preferredRun);

  return {
    run: preferredRun,
    currentRun: {
      id: preferredRun.id,
      stage: preferredRun.stage,
      status: preferredRun.status,
      statusMessage: preferredRun.statusMessage,
      briefMatchesCurrent: briefsMatch(preferredRun.brief, session.brief),
      recentEvents,
      summaryMarkdown
    },
    agenda: agendaSnapshot?.agenda ?? null
  };
}

async function requestProjectAssistantTurn(
  session: SessionState,
  runStore: RunStore,
  backend: ProjectAssistantBackend,
  mode: ProjectAssistantRequest["mode"]
): Promise<ProjectAssistantResponse> {
  const context = await loadProjectAssistantContext(session, runStore);

  if (context === null) {
    throw new Error("No run-aware project context is available yet.");
  }

  return backend.respond({
    mode,
    projectRoot: session.projectRoot,
    brief: session.brief,
    openQuestions: session.intake.openQuestions,
    conversation: session.conversation
      .filter((entry) => entry.kind === "chat")
      .slice(-16)
      .map((entry) => ({
        role: entry.role,
        content: entry.text
    })),
    currentRun: context.currentRun,
    latestAgenda: context.agenda
  });
}

type ProjectFileActionResult = {
  status: "written" | "appended" | "skipped" | "blocked";
  path: string;
  message: string;
};

function resolveProjectWritePath(projectRoot: string, targetPath: string): { absolutePath: string; relativePath: string } | null {
  const absoluteRoot = path.resolve(projectRoot);
  const absolutePath = path.resolve(absoluteRoot, targetPath);
  const relativePath = path.relative(absoluteRoot, absolutePath);

  if (relativePath.length === 0 || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return {
    absolutePath,
    relativePath
  };
}

function isSensitiveProjectWrite(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const basename = path.posix.basename(normalized).toLowerCase();

  if (basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }

  if (/\.(?:pem|key|p12|pfx)$/i.test(basename)) {
    return true;
  }

  if (!normalized.startsWith(".clawresearch/")) {
    return false;
  }

  return [
    "credentials.json",
    "model-credentials.json",
    "project-config.json",
    "session.json",
    "lock",
    "lock.json"
  ].includes(basename);
}

async function projectFileExists(absolutePath: string): Promise<boolean> {
  try {
    await readFile(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteProjectFile(absolutePath: string, contents: string): Promise<void> {
  const tempPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, contents, "utf8");
    await rename(tempPath, absolutePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function applyProjectFileAction(projectRoot: string, action: ProjectFileAction): Promise<ProjectFileActionResult> {
  const resolved = resolveProjectWritePath(projectRoot, action.path);

  if (resolved === null) {
    return {
      status: "blocked",
      path: action.path,
      message: "Blocked file write outside the project root."
    };
  }

  if (isSensitiveProjectWrite(resolved.relativePath)) {
    return {
      status: "blocked",
      path: resolved.relativePath,
      message: "Blocked write to a sensitive project/runtime file."
    };
  }

  const exists = await projectFileExists(resolved.absolutePath);

  if (action.action === "write_project_file" && exists && action.overwrite !== true) {
    return {
      status: "skipped",
      path: resolved.relativePath,
      message: "Skipped write because the file already exists and overwrite was not enabled."
    };
  }

  await mkdir(path.dirname(resolved.absolutePath), { recursive: true });

  if (action.action === "append_project_file") {
    const existing = exists ? await readFile(resolved.absolutePath, "utf8") : "";
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await atomicWriteProjectFile(resolved.absolutePath, `${existing}${separator}${action.content}`);
    return {
      status: "appended",
      path: resolved.relativePath,
      message: `Appended ${relativeProjectPath(projectRoot, resolved.absolutePath)}.`
    };
  }

  if (action.action === "update_project_file" && !exists) {
    return {
      status: "skipped",
      path: resolved.relativePath,
      message: "Skipped update because the target file does not exist."
    };
  }

  await atomicWriteProjectFile(resolved.absolutePath, action.content);
  return {
    status: "written",
    path: resolved.relativePath,
    message: `${action.action === "update_project_file" ? "Updated" : "Wrote"} ${relativeProjectPath(projectRoot, resolved.absolutePath)}.`
  };
}

async function applyProjectFileActions(projectRoot: string, actions: ProjectFileAction[] | undefined): Promise<ProjectFileActionResult[]> {
  if (actions === undefined || actions.length === 0) {
    return [];
  }

  const results: ProjectFileActionResult[] = [];

  for (const action of actions) {
    results.push(await applyProjectFileAction(projectRoot, action));
  }

  return results;
}

function fileActionSummary(results: ProjectFileActionResult[]): string | null {
  if (results.length === 0) {
    return null;
  }

  return results.map((result) => result.message).join(" ");
}

function truncateSentence(text: string, limit = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= limit) {
    return normalized;
  }

  const boundary = normalized.lastIndexOf(".", limit);

  if (boundary >= Math.floor(limit * 0.4)) {
    return normalized.slice(0, boundary + 1);
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

async function buildCompletedRunSummary(run: RunRecord): Promise<string> {
  const workerState = await loadResearchWorkerState(run.projectRoot);

  if (workerState !== null && workerState.lastRunId === run.id) {
    switch (workerState.status) {
      case "release_ready":
        return `Autonomous research worker reached release readiness. ${workerState.statusReason}`;
      case "externally_blocked":
      case "needs_user_decision":
        return `Autonomous research worker paused. ${workerState.statusReason} ${workerState.userBlockers.join(" | ")}`;
      case "working":
        return `Autonomous research worker checkpointed this segment. ${workerState.statusReason}`;
      case "paused":
        return `Autonomous research worker is paused. ${workerState.statusReason}`;
      case "not_started":
        break;
    }
  }

  const agendaSnapshot = await loadAgendaSnapshotForRun(run);

  if (agendaSnapshot !== null) {
    const summary = truncateSentence(agendaSnapshot.agenda.executiveSummary);

    if (agendaSnapshot.agenda.holdReasons.length > 0) {
      return `Literature review complete. ${summary} The agenda is on hold: ${agendaSnapshot.agenda.holdReasons.join(" | ")}`;
    }

    return `Research segment complete. ${summary}`;
  }

  const summaryMarkdown = await readTextFileOrNull(run.artifacts.summaryPath);

  if (summaryMarkdown !== null) {
    const lines = summaryMarkdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("- "));
    const firstLine = lines[0];

    if (firstLine !== undefined) {
      return `Literature review complete. ${truncateSentence(firstLine)}`;
    }
  }

  return run.statusMessage ?? `Research run ${run.id} completed.`;
}

export async function summarizeCompletedRunIfNeeded(
  session: SessionState,
  store: SessionStore,
  run: RunRecord,
  now: () => string
): Promise<string | null> {
  if (!isTerminalRun(run) || session.lastSummarizedRunId === run.id) {
    return null;
  }

  const summary = await buildCompletedRunSummary(run);
  saveAssistantMessage(session, summary, now());
  session.lastSummarizedRunId = run.id;
  await store.save(session);
  return summary;
}

function goReadinessFailures(session: SessionState): string[] {
  const failures: string[] = [];
  const missingFields = summarizeMissingFields(session);

  if (missingFields.length > 0) {
    failures.push(`Missing brief fields: ${missingFields.join(", ")}`);
  }

  if (session.intake.readiness !== "ready") {
    failures.push(session.intake.rationale ?? "The intake chat still needs clarification.");
  }

  return failures;
}

async function requestAssistantTurn(
  session: SessionState,
  backend: IntakeBackend,
  mode: IntakeRequest["mode"],
  recoveryReason?: string
): Promise<IntakeResponse> {
  return backend.respond({
    mode,
    projectRoot: session.projectRoot,
    brief: session.brief,
    openQuestions: session.intake.openQuestions,
    conversation: session.conversation
      .filter((entry) => entry.kind === "chat")
      .map((entry) => ({
        role: entry.role,
        content: entry.text
      })),
    recoveryReason
  });
}

async function requestCompletedBrief(
  session: SessionState,
  backend: IntakeBackend,
  completionHint: string
): Promise<ResearchBrief | null> {
  if (backend.completeBrief === undefined) {
    return null;
  }

  return backend.completeBrief({
    mode: "recover",
    projectRoot: session.projectRoot,
    brief: session.brief,
    openQuestions: session.intake.openQuestions,
    conversation: session.conversation
      .filter((entry) => entry.kind === "chat")
      .map((entry) => ({
        role: entry.role,
        content: entry.text
      })),
    recoveryReason: completionHint
  });
}

function latestChatEntry(session: SessionState): SessionState["conversation"][number] | null {
  for (let index = session.conversation.length - 1; index >= 0; index -= 1) {
    const entry = session.conversation[index];

    if (entry?.kind === "chat") {
      return entry;
    }
  }

  return null;
}

function looksLikeUserConfirmation(text: string | undefined): boolean {
  if (text === undefined) {
    return false;
  }

  const normalized = normalizeComparableText(text);

  return /^(?:yes|yeah|yep|sure|okay|ok|sounds good|that sounds good|looks good|good|great|perfect|aligned|works for me|let's do that|lets do that|go ahead|proceed|that aligns)(?:\b|$)/.test(normalized);
}

function assistantMessageLooksLikeDraft(text: string): boolean {
  return /\b(?:working|research)\s+brief\b/i.test(text)
    || /\bproposal\b/i.test(text)
    || /\bpropose(?:d)?\b/i.test(text)
    || /\bframing\b/i.test(text)
    || /\bdoes this align\b/i.test(text)
    || /\bconfirm or adjust\b/i.test(text)
    || /\bunless you want to\b/i.test(text)
    || /\bI can proceed with that\b/i.test(text)
    || /\bcurrent brief\b/i.test(text)
    || /\bBased on our conversation\b/i.test(text)
    || /\bTopic\s*:/i.test(text)
    || /\bResearch question\s*:/i.test(text);
}

function shouldAttemptPostTurnBriefCompletion(
  session: SessionState,
  response: IntakeResponse
): boolean {
  if (briefCanStartFirstPass(session.brief)) {
    return false;
  }

  if (response.readiness === "ready") {
    return true;
  }

  const lastUserMessage = recentChatMessages(session, "user", 1).at(-1);

  if (!looksLikeUserConfirmation(lastUserMessage)) {
    return false;
  }

  const previousAssistantMessage = recentChatMessages(session, "assistant", 1).at(-1);
  const proposedDraftVisible = assistantMessageLooksLikeDraft(response.assistantMessage)
    || (previousAssistantMessage !== undefined && assistantMessageLooksLikeDraft(previousAssistantMessage))
    || briefSignalCount(session.brief) >= 2;

  return proposedDraftVisible;
}

function applyRecoveredBrief(session: SessionState, recoveredBrief: ResearchBrief): void {
  for (const [field, value] of Object.entries(recoveredBrief)) {
    const merged = mergeBriefFieldValue(
      session.brief[field as ResearchBriefField],
      value
    );

    if (merged !== null) {
      setBriefField(session, field as ResearchBriefField, merged);
    }
  }

  if (briefCanStartFirstPass(session.brief)) {
    session.intake.readiness = "ready";
    session.intake.rationale = "The brief is concrete enough to start a first-pass research run.";
    session.intake.openQuestions = [];
    session.intake.summary = session.intake.summary
      ?? "A concrete first-pass research brief has been reconstructed from the confirmed conversation.";
    session.intake.lastError = null;
  }
}

async function maybeCompleteBriefFromConversation(
  session: SessionState,
  backend: IntakeBackend,
  completionHint: string
): Promise<boolean> {
  const completedBrief = await requestCompletedBrief(session, backend, completionHint);

  if (completedBrief === null) {
    return false;
  }

  applyRecoveredBrief(session, completedBrief);
  return briefCanStartFirstPass(session.brief);
}

export async function emitAssistantTurn(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  backend: IntakeBackend,
  projectAssistantBackend: ProjectAssistantBackend,
  mode: "start" | "resume" | "continue",
  now: () => string
): Promise<void> {
  const projectContext = await loadProjectAssistantContext(session, runStore);

  if (projectContext !== null) {
    try {
      const previousBrief: ResearchBrief = { ...session.brief };
      const response = stabilizeIntakeResponse(
        session,
        await requestProjectAssistantTurn(session, runStore, projectAssistantBackend, mode)
      ) as ProjectAssistantResponse;
      applyIntakeResponse(session, response);
      let assistantMessage = response.assistantMessage;
      const fileResults = await applyProjectFileActions(session.projectRoot, response.fileActions);
      const fileSummary = fileActionSummary(fileResults);
      const briefChangedThisTurn = !briefsMatch(previousBrief, session.brief);
      const divergesFromLatestRun = !briefsMatch(projectContext.run.brief, session.brief);

      if (
        briefChangedThisTurn
        && divergesFromLatestRun
        && !/\/go\b/i.test(assistantMessage)
      ) {
        assistantMessage = `${assistantMessage} The brief now differs from the latest saved run. Use \`/go\` when you're ready to refresh the research for the updated direction.`;
      }

      if (fileSummary !== null) {
        assistantMessage = `${assistantMessage}\n\n${fileSummary}`;
      }

      renderTaggedBlock(writer, "consultant", assistantMessage);
      saveAssistantMessage(session, assistantMessage, now());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown backend failure";
      session.intake.lastError = message;
      const fallback = "The local research assistant is unavailable right now. You can inspect `/status`, `/agenda`, or ask again once Ollama is responding.";
      renderTaggedBlock(writer, "system", fallback);
      saveAssistantMessage(session, fallback, now(), "system");
    }

    await store.save(session);
    return;
  }

  try {
    const initialResponse = stabilizeIntakeResponse(
      session,
      await requestAssistantTurn(session, backend, mode)
    );
    const recoveryReason = buildRecoveryReason(session, initialResponse);
    const response = recoveryReason === null
      ? initialResponse
      : stabilizeIntakeResponse(
        session,
        await requestAssistantTurn(session, backend, "recover", recoveryReason)
      );
    applyIntakeResponse(session, response);

    if (shouldAttemptPostTurnBriefCompletion(session, response)) {
      await maybeCompleteBriefFromConversation(
        session,
        backend,
        "The conversation appears to have converged on a workable brief. Formalize any remaining missing structured fields from the confirmed draft without changing the user-facing message."
      );
    }

    renderTaggedBlock(writer, "consultant", response.assistantMessage);
    saveAssistantMessage(session, response.assistantMessage, now());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown backend failure";
    session.intake.lastError = message;
    const fallback = "The local intake model is unavailable right now. You can keep chatting, use explicit field prefixes, or retry once Ollama is responding again.";
    renderTaggedBlock(writer, "system", fallback);
    saveAssistantMessage(session, fallback, now(), "system");
  }

  await store.save(session);
}

async function attemptBriefCompletionForGo(
  session: SessionState,
  backend: IntakeBackend
): Promise<boolean> {
  const missingFields = summarizeMissingFields(session);
  const reasonParts = [
    "The user invoked /go and wants to proceed with the current conversation.",
    missingFields.length > 0
      ? `The brief still needs: ${missingFields.join(", ")}.`
      : "The brief is still marked as not ready.",
    "Draft the strongest complete first-pass research brief you can from the existing conversation.",
    "If a full draft brief is already present, keep that wording unless you are making it more concrete or more realistically bounded.",
    "Fill in a reasonable research question, research direction, and success criterion when the conversation already provides enough signal.",
    "Only leave fields null if the conversation truly lacks enough information."
  ];

  const response = stabilizeIntakeResponse(
    session,
    await requestAssistantTurn(
      session,
      backend,
      "recover",
      reasonParts.join(" ")
    )
  );
  applyIntakeResponse(session, response);

  if (goReadinessFailures(session).length > 0) {
    await maybeCompleteBriefFromConversation(
      session,
      backend,
      "Fill any remaining missing structured brief fields from the existing conversation so the run can start if enough signal already exists."
    );
  }

  return goReadinessFailures(session).length === 0;
}

async function watchRunProgress(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  runController: RunController,
  run: RunRecord,
  now: () => string,
  watchPollMs: number
): Promise<RunRecord | null> {
  const cursor = {
    runId: run.id,
    offset: 0,
    trailingBuffer: ""
  };

  renderTaggedBlock(
    writer,
    "watch",
    `Streaming live run activity from ${relativeProjectPath(session.projectRoot, run.artifacts.eventsPath)}.`
  );

  while (true) {
    const events = await readNewRunEvents(run, cursor);

    for (const event of events) {
      renderRunEvent(writer, event);
    }

    const currentRun = await reconcileRelevantRun(session, store, runStore, runController, now);

    if (currentRun === null) {
      await delay(Math.max(250, watchPollMs));
      const retriedRun = await reconcileRelevantRun(session, store, runStore, runController, now);

      if (retriedRun === null) {
        renderTaggedBlock(writer, "run", "The detached run record is no longer available.");
        return null;
      }

      run = retriedRun;
    } else {
      run = currentRun;
    }

    if (cursor.runId !== run.id) {
      cursor.runId = run.id;
      cursor.offset = 0;
      cursor.trailingBuffer = "";
      renderTaggedBlock(
        writer,
        "watch",
        `Switching live run activity to ${relativeProjectPath(session.projectRoot, run.artifacts.eventsPath)}.`
      );
    }

    if (isTerminalRun(run)) {
      const trailingEvents = await readNewRunEvents(run, cursor);

      for (const event of trailingEvents) {
        renderRunEvent(writer, event);
      }

      renderTaggedBlock(
        writer,
        run.status === "completed" ? "done" : "error",
        run.status === "completed"
          ? `Run ${run.id} completed.`
          : `Run ${run.id} failed.`
      );

      const completionSummary = await summarizeCompletedRunIfNeeded(
        session,
        store,
        run,
        now
      );

      if (completionSummary !== null) {
        renderTaggedBlock(writer, "consultant", completionSummary);
      }

      return run;
    }

    await delay(watchPollMs);
  }
}

export async function handleGoCommand(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  backend: IntakeBackend,
  runController: RunController,
  now: () => string,
  watchRuns: boolean,
  watchPollMs: number
): Promise<void> {
  const reconciledRun = await reconcileRelevantRun(session, store, runStore, runController, now);

  if (reconciledRun !== null && !isTerminalRun(reconciledRun)) {
    const lines = [
      "A detached research run is already active for this project.",
      `Run id: ${reconciledRun.id}`,
      `Status: ${reconciledRun.status}`,
      `Trace: ${relativeProjectPath(session.projectRoot, reconciledRun.artifacts.tracePath)}`,
      "Use `/status` to inspect it, or `/pause` and `/resume` to control it."
    ];

    renderTaggedLines(writer, "run", lines);

    saveAssistantMessage(session, lines.join(" "), now(), "command");
    await store.save(session);
    return;
  }

  const recentAssistantDraft = recentChatMessages(session, "assistant", 3)
    .reverse()
    .map((message) => parseDraftBriefFromText(message))
    .find((draft) => briefSignalCount(draft) > 0);

  if (recentAssistantDraft !== undefined) {
    applyRecoveredBrief(session, recentAssistantDraft);
  }

  if (session.intake.readiness !== "ready" && briefCanStartFirstPass(session.brief)) {
    session.intake.readiness = "ready";
    session.intake.rationale = "The brief is concrete enough to start a first-pass research run.";
    session.intake.openQuestions = [];
    await store.save(session);
  }

  const neededCompletion = summarizeMissingFields(session).length > 0
    || session.intake.readiness !== "ready";

  if (neededCompletion && !briefCanStartFirstPass(session.brief)) {
    try {
      await attemptBriefCompletionForGo(session, backend);
      await store.save(session);
    } catch (error) {
      session.intake.lastError = error instanceof Error ? error.message : "Unknown backend failure";
      await store.save(session);
    }
  }

  const failures = goReadinessFailures(session);

  if (failures.length > 0) {
    const lines = buildGoNotReadyLines(session);

    renderTaggedLines(writer, "consultant", lines);

    saveAssistantMessage(session, lines.join(" "), now(), "command");
    await store.save(session);
    return;
  }

  const workerState = await loadResearchWorkerState(session.projectRoot);
  const workerObjectiveChanged = workerState === null ? false : !briefsMatch(workerState.brief, session.brief);

  if (workerState?.status === "release_ready" && !workerObjectiveChanged) {
    const lines = [
      "The autonomous research worker is already release-ready for the current objective.",
      workerState.statusReason,
      `Latest run id: ${workerState.lastRunId ?? "<none>"}`,
      `Paper readiness: ${workerState.paperReadiness ?? "<unknown>"}`
    ];
    renderTaggedLines(writer, "run", lines);
    saveAssistantMessage(session, lines.join(" "), now(), "command");
    await store.save(session);
    return;
  }

  if (workerState?.status === "needs_user_decision" && !workerObjectiveChanged) {
    const lines = [
      "The autonomous research worker needs a user research decision before another segment can help.",
      workerState.statusReason,
      ...workerState.userBlockers.map((blocker) => `- ${blocker}`)
    ];
    renderTaggedLines(writer, "run", lines);
    saveAssistantMessage(session, lines.join(" "), now(), "command");
    await store.save(session);
    return;
  }

  session.status = "ready";
  let run: RunRecord;

  try {
    run = await runStore.create(session.brief, createInitialRunCommand());
    run.job.launchCommand = runController.launchCommand(run);
    await runStore.save(run);
    const workerPid = await runController.launch(run);
    run.workerPid = workerPid;
    run.status = "queued";
    run.statusMessage = "Detached run launched. Waiting for the run worker to start.";
    await runStore.save(run);
    session.activeRunId = run.id;
    session.lastRunId = run.id;
    session.goCount += 1;
    session.lastGoRequestedAt = now();
    await store.save(session);
  } catch (error) {
    const response = error instanceof Error
      ? `I couldn't start the detached run: ${error.message}`
      : "I couldn't start the detached run due to an unknown error.";
    renderTaggedBlock(writer, "error", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  const responseLines = [
    workerState?.status === "working"
      ? "Research run started. Autonomous research worker continuation segment started."
      : workerState?.status === "externally_blocked"
        ? "Research run started. Autonomous research worker retry segment started after an external blocker."
        : workerObjectiveChanged
          ? "Research run started. Autonomous research worker segment started for the updated objective."
      : "Research run started. Autonomous research worker segment started.",
    `Run id: ${run.id}`,
    `Status: ${run.status}`,
    `Launch command: ${run.job.launchCommand?.join(" ") ?? "<unknown>"}`,
    `Trace: ${relativeProjectPath(session.projectRoot, run.artifacts.tracePath)}`,
    `Events: ${relativeProjectPath(session.projectRoot, run.artifacts.eventsPath)}`,
    `Stdout: ${relativeProjectPath(session.projectRoot, run.artifacts.stdoutPath)}`,
    `Stderr: ${relativeProjectPath(session.projectRoot, run.artifacts.stderrPath)}`,
    `Plan: ${relativeProjectPath(session.projectRoot, run.artifacts.planPath)}`,
    `Sources: ${relativeProjectPath(session.projectRoot, run.artifacts.sourcesPath)}`,
    `Literature review: ${relativeProjectPath(session.projectRoot, run.artifacts.literaturePath)}`,
    `Review protocol: ${relativeProjectPath(session.projectRoot, run.artifacts.reviewProtocolPath)}`,
    `Verification: ${relativeProjectPath(session.projectRoot, run.artifacts.verificationPath)}`,
    `Paper: ${relativeProjectPath(session.projectRoot, run.artifacts.paperPath)}`,
    `Paper checks: ${relativeProjectPath(session.projectRoot, run.artifacts.manuscriptChecksPath)}`,
    `Workspace db: ${relativeProjectPath(session.projectRoot, researchWorkStoreFilePath(session.projectRoot))}`,
    watchRuns
      ? "The detached run is working in the current project directory, and the console will stream live progress until the current run reaches a terminal state."
      : "The detached run is working in the current project directory. Use `/status` to inspect it, `/pause` to stop it temporarily, or `/resume` to continue a paused run."
  ];

  renderTaggedLines(writer, "run", responseLines);

  saveAssistantMessage(session, responseLines.join(" "), now(), "command");

  if (watchRuns) {
    await watchRunProgress(
      writer,
      session,
      store,
      runStore,
      runController,
      run,
      now,
      watchPollMs
    );
  }
}

export async function handlePauseCommand(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  runController: RunController,
  now: () => string
): Promise<void> {
  const run = await reconcileRelevantRun(session, store, runStore, runController, now);

  if (run === null) {
    const response = "There is no detached run to pause right now.";
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (isTerminalRun(run)) {
    const response = `Run ${run.id} is already ${run.status}. There is nothing to pause.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (run.status === "paused") {
    const response = `Run ${run.id} is already paused.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (run.workerPid === null) {
    const response = `Run ${run.id} does not currently have a live worker process to pause.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  await runController.pause(run.workerPid);
  run.status = "paused";
  run.statusMessage = "Run paused from the console.";
  await runStore.save(run);

  const response = `Paused run ${run.id}.`;
  renderTaggedBlock(writer, "run", response);
  saveAssistantMessage(session, response, now(), "command");
  await store.save(session);
}

export async function handleResumeCommand(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  runController: RunController,
  now: () => string
): Promise<void> {
  const run = await reconcileRelevantRun(session, store, runStore, runController, now);

  if (run === null) {
    const response = "There is no detached run to resume right now.";
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (isTerminalRun(run)) {
    const response = `Run ${run.id} is already ${run.status}. There is nothing to resume.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (run.status !== "paused") {
    const response = `Run ${run.id} is not paused. Its current status is ${run.status}.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (run.workerPid === null) {
    const response = `Run ${run.id} does not currently have a live worker process to resume.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  await runController.resume(run.workerPid);
  run.status = "running";
  run.statusMessage = "Run resumed from the console.";
  await runStore.save(run);

  const response = `Resumed run ${run.id}.`;
  renderTaggedBlock(writer, "run", response);
  saveAssistantMessage(session, response, now(), "command");
  await store.save(session);
}

export async function handleUserInput(
  input: string,
  io: ConsoleIo,
  transcript: ConsoleTranscript,
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  projectConfig: ProjectConfigState,
  projectConfigStore: ProjectConfigStore,
  credentials: CredentialStoreState,
  credentialStore: CredentialStore,
  backend: IntakeBackend,
  projectAssistantBackend: ProjectAssistantBackend,
  now: () => string
): Promise<void> {
  const sourceSelection = parseSourceSelectionUpdate(input);

  if (sourceSelection !== null) {
    const providerIds = sourceSelection.category === "localContext"
      ? null
      : parseProviderSelection(sourceSelection.value, sourceSelection.category);
    saveUserMessage(session, input, now(), "command");

    if (sourceSelection.category === "localContext") {
      const localSetting = parseLocalToggle(sourceSelection.value);

      if (localSetting === null) {
        const response = "I couldn't parse that local-files setting. Use `local: on` or `local: off`.";
        renderTaggedBlock(writer, "system", response);
        saveAssistantMessage(session, response, now(), "command");
        await store.save(session);
        return;
      }

      projectConfig.sources.localContext.projectFilesEnabled = localSetting;
      projectConfig.sources.explicitlyConfigured = true;
      await projectConfigStore.save(projectConfig);

      const response = `Updated local context for this project: ${localSetting ? "on" : "off"}.`;
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "command");
      await store.save(session);
      return;
    }

    if (providerIds === null) {
      const response = invalidProviderSelectionMessage(sourceSelection.category);
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "command");
      await store.save(session);
      return;
    }

    projectConfig.sources[sourceSelection.category].selectedProviderIds = providerIds;

    if (sourceSelection.category !== "generalWeb") {
      const authPrompted = await promptProviderCredentials(
        io,
        transcript,
        writer,
        credentials,
        providerIds
      );

      if (!authPrompted) {
        const response = "Input closed while configuring provider credentials. Session saved.";
        renderTaggedBlock(writer, "system", response);
        saveAssistantMessage(session, response, now(), "command");
        await store.save(session);
        return;
      }
    }

    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);
    await credentialStore.save(credentials);

    const responseLines = [
      updatedProviderSelectionMessage(sourceSelection.category, providerIds),
      `Config saved to ${relativeProjectPath(session.projectRoot, projectConfigPath(session.projectRoot))}.`
    ];

    renderTaggedLines(writer, "system", responseLines);
    saveAssistantMessage(session, responseLines.join(" "), now(), "command");
    await store.save(session);
    return;
  }

  const timestamp = now();
  saveUserMessage(session, input, timestamp);

  const explicitUpdate = parseExplicitBriefUpdate(input);

  if (explicitUpdate !== null) {
    applyExplicitFieldUpdate(session, explicitUpdate);
  }

  await emitAssistantTurn(writer, session, store, runStore, backend, projectAssistantBackend, "continue", now);
}

async function handleCommand(
  command: string,
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  projectConfig: ProjectConfigState,
  projectConfigStore: ProjectConfigStore,
  credentials: CredentialStoreState,
  credentialStore: CredentialStore,
  backend: IntakeBackend,
  runController: RunController,
  now: () => string,
  transcriptPath: string,
  watchRuns: boolean,
  watchPollMs: number
): Promise<"continue" | "quit"> {
  const timestamp = now();
  saveUserMessage(session, command, timestamp, "command");

  switch (command) {
    case "/help": {
      renderHelp(writer, session);
      saveAssistantMessage(session, "Displayed help and input hints.", now(), "command");
      await store.save(session);
      return "continue";
    }
    case "/status": {
      const run = await reconcileRelevantRun(session, store, runStore, runController, now);
      const currentProjectConfig = await projectConfigStore.load();
      const currentCredentials = await credentialStore.load();
      applyCredentialsToEnvironment(currentCredentials);
      projectConfig.sources = currentProjectConfig.sources;
      credentials.providers = currentCredentials.providers;
      const agendaSnapshot = await latestAgendaSnapshot(runStore);
      const workerState = await loadResearchWorkerState(session.projectRoot);
      const workStore = await loadResearchWorkStore({
        projectRoot: session.projectRoot,
        brief: session.brief,
        now: now()
      });
      renderStatus(writer, session, run, transcriptPath, currentProjectConfig, currentCredentials, agendaSnapshot, workerState, workStore);
      saveAssistantMessage(session, "Displayed the current research brief.", now(), "command");
      await store.save(session);
      return "continue";
    }
    case "/agenda": {
      const snapshot = await latestAgendaSnapshot(runStore);
      renderAgenda(writer, snapshot, session.projectRoot);
      saveAssistantMessage(session, "Displayed the latest research agenda.", now(), "command");
      await store.save(session);
      return "continue";
    }
    case "/paper": {
      const snapshot = await latestPaperSnapshot(runStore);
      renderPaperStatus(writer, snapshot, session.projectRoot);
      saveAssistantMessage(session, "Displayed the latest review-paper status.", now(), "command");
      await store.save(session);
      return "continue";
    }
    case "/paper open": {
      const snapshot = await latestPaperSnapshot(runStore);
      if (snapshot === null || snapshot.markdown === null) {
        renderTaggedBlock(writer, "paper", "No review-paper draft is available yet.");
      } else {
        renderTaggedBlock(writer, "paper", snapshot.markdown);
      }
      saveAssistantMessage(session, "Displayed the latest review-paper draft.", now(), "command");
      await store.save(session);
      return "continue";
    }
    case "/paper checks": {
      const snapshot = await latestPaperSnapshot(runStore);
      renderPaperChecks(writer, snapshot);
      saveAssistantMessage(session, "Displayed the latest manuscript readiness checks.", now(), "command");
      await store.save(session);
      return "continue";
    }
    case "/sources": {
      const currentProjectConfig = await projectConfigStore.load();
      const currentCredentials = await credentialStore.load();
      applyCredentialsToEnvironment(currentCredentials);
      projectConfig.sources = currentProjectConfig.sources;
      credentials.providers = currentCredentials.providers;
      renderSources(writer, session, currentProjectConfig, currentCredentials);
      saveAssistantMessage(session, "Displayed the configured literature providers.", now(), "command");
      await store.save(session);
      return "continue";
    }
    case "/go": {
      await handleGoCommand(writer, session, store, runStore, backend, runController, now, watchRuns, watchPollMs);
      await store.save(session);
      return "continue";
    }
    case "/pause": {
      await handlePauseCommand(writer, session, store, runStore, runController, now);
      return "continue";
    }
    case "/resume": {
      await handleResumeCommand(writer, session, store, runStore, runController, now);
      return "continue";
    }
    case "/quit":
    case "/exit": {
      const response = "Session saved. Closing ClawResearch.";
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "command");
      await store.save(session);
      return "quit";
    }
    default: {
      const response = `Unknown command: ${command}. Use \`/help\` to see the available commands.`;
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "command");
      await store.save(session);
      return "continue";
    }
  }
}

export async function runPhaseOneConsole(io: ConsoleIo, options: RunOptions): Promise<number> {
  const now = options.now ?? (() => new Date().toISOString());
  const store = new SessionStore(options.projectRoot, options.version, now);
  const session = await store.load();
  const runStore = new RunStore(options.projectRoot, options.version, now);
  const projectConfigStore = new ProjectConfigStore(options.projectRoot, now);
  const credentialStore = new CredentialStore(options.projectRoot, now);
  const modelCredentialStore = new ModelCredentialStore(options.projectRoot, now);
  const projectConfig = await projectConfigStore.load();
  const credentials = await credentialStore.load();
  const modelCredentials = await modelCredentialStore.load();
  applyCredentialsToEnvironment(credentials);
  const runController = options.runController ?? createDefaultRunController();
  const transcript = new ConsoleTranscript(options.projectRoot);
  const writer = createLoggedWriter(io.writer, transcript);
  const watchRuns = options.watchRuns ?? options.runController === undefined;
  const watchPollMs = options.watchPollMs ?? 150;

  const reconciledRun = await reconcileRelevantRun(session, store, runStore, runController, now);

  renderBanner(writer, session, transcript.filePath);
  renderWelcome(writer, session);
  const modelSetupResult = await runInitialModelSetup(
    io,
    transcript,
    writer,
    projectConfig,
    projectConfigStore,
    modelCredentials,
    modelCredentialStore
  );

  if (!modelSetupResult.completed) {
    io.close?.();
    return 0;
  }

  const backend = options.intakeBackend ?? await createProjectIntakeBackend({
    projectRoot: options.projectRoot,
    projectConfig,
    timestampFactory: now
  });
  const projectAssistantBackend = options.projectAssistantBackend ?? await createProjectAssistantBackend({
    projectRoot: options.projectRoot,
    projectConfig,
    timestampFactory: now
  });
  session.intake.backendLabel = backend.label;
  await store.save(session);
  if (modelSetupResult.pendingInput !== null && !projectConfig.sources.explicitlyConfigured) {
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);
  }
  const setupResult = await runInitialSourceSetup(
    io,
    transcript,
    writer,
    session,
    projectConfig,
    projectConfigStore,
    credentialStore,
    credentials
  );

  if (!setupResult.completed) {
    io.close?.();
    return 0;
  }

  renderLiteratureSetup(writer, session, projectConfig);

  if (reconciledRun !== null) {
    const completionSummary = await summarizeCompletedRunIfNeeded(
      session,
      store,
      reconciledRun,
      now
    );

    if (completionSummary !== null) {
      renderTaggedBlock(writer, "consultant", completionSummary);
    }
  }

  const initialChatEntry = latestChatEntry(session);

  if (initialChatEntry === null) {
    await emitAssistantTurn(writer, session, store, runStore, backend, projectAssistantBackend, "start", now);
  } else if (initialChatEntry.role === "user") {
    await emitAssistantTurn(writer, session, store, runStore, backend, projectAssistantBackend, "resume", now);
  }

  const pendingInput = modelSetupResult.pendingInput ?? setupResult.pendingInput;

  if (pendingInput !== null) {
    await handleUserInput(
      pendingInput.trim(),
      io,
      transcript,
      writer,
      session,
      store,
      runStore,
      projectConfig,
      projectConfigStore,
      credentials,
      credentialStore,
      backend,
      projectAssistantBackend,
      now
    );
  }

  while (true) {
    const line = await io.prompt("clawresearch> ");

    if (line === null) {
      const response = "Input closed. Session saved.";
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "system");
      await store.save(session);
      break;
    }

    transcript.appendInput("clawresearch> ", line);
    const input = line.trim();

    if (input.length === 0) {
      const response = session.intake.openQuestions[0]
        ?? "Take your time. Tell me more about the research goal or use `/status` to inspect the current brief.";
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "system");
      await store.save(session);
      continue;
    }

    if (input.startsWith("/")) {
      const result = await handleCommand(
        input,
        writer,
        session,
        store,
        runStore,
        projectConfig,
        projectConfigStore,
        credentials,
        credentialStore,
        backend,
        runController,
        now,
        transcript.filePath,
        watchRuns,
        watchPollMs
      );

      if (result === "quit") {
        break;
      }

      continue;
    }

    await handleUserInput(
      input,
      io,
      transcript,
      writer,
      session,
      store,
      runStore,
      projectConfig,
      projectConfigStore,
      credentials,
      credentialStore,
      backend,
      projectAssistantBackend,
      now
    );
  }

  io.close?.();
  return 0;
}
