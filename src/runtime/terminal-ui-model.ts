import type { ProjectConfigState } from "./project-config-store.js";
import {
  getSourceProviderDefinition,
  listSourceProvidersByCategory,
  type SourceProviderCategory,
  type SourceProviderId
} from "./provider-registry.js";
import type { ResearchBrief } from "./session-store.js";

export type SourceChecklistEntry = {
  id: string;
  category: SourceProviderCategory | "local";
  label: string;
  description: string;
  selected: boolean;
  providerId: SourceProviderId | null;
};

export type ScreenLogEntry = {
  tag: string;
  text: string;
};

type ChatFrameOptions = {
  width: number;
  height: number;
  title: string;
  subtitle: string;
  brief: ResearchBrief;
  logs: ScreenLogEntry[];
  inputLabel: string;
  inputValue: string;
  footerHint: string;
  modalTitle?: string | null;
  modalLines?: string[];
};

type AuthPromptFrameOptions = {
  width: number;
  height: number;
  title: string;
  subtitle: string;
  providerLabel: string;
  providerDescription: string;
  guidanceLines: string[];
  inputLabel: string;
  inputValue: string;
  footerHint: string;
};

const minimumWidth = 60;
const defaultHeight = 24;

function clampWidth(width: number): number {
  return Math.max(minimumWidth, Number.isFinite(width) ? Math.floor(width) : 80);
}

function clampHeight(height: number): number {
  return Math.max(defaultHeight, Number.isFinite(height) ? Math.floor(height) : defaultHeight);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  if (limit <= 3) {
    return text.slice(0, limit);
  }

  return `${text.slice(0, limit - 3)}...`;
}

function pad(text: string, width: number): string {
  if (text.length >= width) {
    return text.slice(0, width);
  }

  return `${text}${" ".repeat(width - text.length)}`;
}

export function wrapText(text: string, width: number): string[] {
  const normalizedWidth = Math.max(12, width);
  const lines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const source = rawLine.trim();

    if (source.length === 0) {
      lines.push("");
      continue;
    }

    const words = source.split(/\s+/);
    let current = "";

    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;

      if (candidate.length <= normalizedWidth) {
        current = candidate;
        continue;
      }

      if (current.length > 0) {
        lines.push(current);
      }

      if (word.length <= normalizedWidth) {
        current = word;
        continue;
      }

      let remainder = word;
      while (remainder.length > normalizedWidth) {
        lines.push(remainder.slice(0, normalizedWidth));
        remainder = remainder.slice(normalizedWidth);
      }
      current = remainder;
    }

    lines.push(current);
  }

  return lines.length === 0 ? [""] : lines;
}

function sectionHeader(title: string, width: number): string {
  const normalizedWidth = clampWidth(width);
  const ruleWidth = Math.max(0, normalizedWidth - title.length - 1);
  return `${title} ${"-".repeat(ruleWidth)}`;
}

function briefLines(brief: ResearchBrief, width: number): string[] {
  const compactWidth = Math.max(20, width - 2);
  const entries: Array<[label: string, value: string | null]> = [
    ["topic", brief.topic],
    ["question", brief.researchQuestion],
    ["direction", brief.researchDirection],
    ["success", brief.successCriterion]
  ];

  return entries.flatMap(([label, value]) => wrapText(`${label}: ${value ?? "<missing>"}`, compactWidth));
}

function flattenLogs(logs: ScreenLogEntry[], width: number): string[] {
  return logs.flatMap((entry) => wrapText(`[${entry.tag}] ${entry.text}`, width));
}

export function buildSourceChecklistEntries(config: ProjectConfigState): SourceChecklistEntry[] {
  const scholarlySelected = new Set(config.sources.scholarly.selectedProviderIds);
  const backgroundSelected = new Set(config.sources.background.selectedProviderIds);

  const scholarly = listSourceProvidersByCategory("scholarly")
    .filter((provider) => provider.implemented)
    .map((provider) => ({
      id: `scholarly:${provider.id}`,
      category: "scholarly" as const,
      label: provider.label,
      description: provider.description,
      selected: scholarlySelected.has(provider.id),
      providerId: provider.id
    }));

  const background = listSourceProvidersByCategory("background")
    .filter((provider) => provider.implemented)
    .map((provider) => ({
      id: `background:${provider.id}`,
      category: "background" as const,
      label: provider.label,
      description: provider.description,
      selected: backgroundSelected.has(provider.id),
      providerId: provider.id
    }));

  return [
    ...scholarly,
    ...background,
    {
      id: "local:project_files",
      category: "local",
      label: "project files",
      description: "Use local markdown and text files in the current project as context.",
      selected: config.sources.local.projectFilesEnabled,
      providerId: "project_files"
    }
  ];
}

export function toggleSourceChecklistEntry(
  config: ProjectConfigState,
  entry: SourceChecklistEntry
): ProjectConfigState {
  if (entry.category === "local") {
    return {
      ...config,
      sources: {
        ...config.sources,
        local: {
          projectFilesEnabled: !config.sources.local.projectFilesEnabled
        }
      }
    };
  }

  if (entry.providerId === null) {
    return config;
  }

  const selected = new Set(
    entry.category === "scholarly"
      ? config.sources.scholarly.selectedProviderIds
      : config.sources.background.selectedProviderIds
  );

  if (selected.has(entry.providerId)) {
    selected.delete(entry.providerId);
  } else {
    selected.add(entry.providerId);
  }

  return {
    ...config,
    sources: {
      ...config.sources,
      [entry.category]: {
        selectedProviderIds: [...selected]
      }
    }
  };
}

export function authPromptLabel(
  providerId: SourceProviderId,
  authRef: string | null
): string {
  const definition = getSourceProviderDefinition(providerId);
  const example = authRef ?? "ENV_VAR_NAME";

  return definition.authMode === "optional_api_key"
    ? `${definition.label} env ref [optional; example ${example}]`
    : `${definition.label} env ref [required; example ${example}]`;
}

export function authPromptGuidance(providerId: SourceProviderId): string[] {
  switch (providerId) {
    case "pubmed":
      return [
        "Optional. Without an NCBI API key, PubMed can still be queried, but retrieval may be slower or rate-limited.",
        "If you want a key, generate it in your NCBI account settings, then point ClawResearch to the env var that holds it.",
        "Leave it blank to continue without it, or type the env-var name you want ClawResearch to use."
      ];
    case "openalex":
      return [
        "Optional. OpenAlex can be used without a key, but an API key gives you a cleaner authenticated route when available.",
        "If you have one already, enter the env-var name that holds it. Otherwise you can keep going without it.",
        "Leave it blank to continue without it, or type the env-var name you want ClawResearch to use."
      ];
    case "core":
      return [
        "Optional. CORE access works best with an API key, but you can continue without it and rely on the other providers.",
        "If you have a CORE key, enter the env-var name that holds it.",
        "Leave it blank to continue without it, or type the env-var name you want ClawResearch to use."
      ];
    case "unpaywall":
      return [
        "Required for Unpaywall. This provider stays unavailable until an env var with the configured email value is available.",
        "Set an env var for the email or token you want ClawResearch to use for Unpaywall requests, then reference that env var here.",
        "Leave it blank and this provider will stay unavailable until you configure it later."
      ];
    default: {
      const definition = getSourceProviderDefinition(providerId);
      return definition.authMode === "optional_api_key"
        ? [
          "Optional. You can continue without this credential, but that provider may be slower, limited, or unavailable for some requests.",
          `If you already have a ${definition.label} credential, enter the env-var name that holds it.`,
          "Leave it blank to continue without it, or type the env-var name you want ClawResearch to use."
        ]
        : [
          "Required for this provider. If you leave it unset, that provider will stay unavailable until configured.",
          `Enter the env-var name that holds your ${definition.label} credential.`,
          "Leave it blank and this provider will stay unavailable until you configure it later."
        ];
    }
  }
}

export function renderSourceChecklist(
  config: ProjectConfigState,
  focusIndex: number,
  width: number,
  height: number
): string {
  const normalizedWidth = clampWidth(width);
  const normalizedHeight = clampHeight(height);
  const lineWidth = normalizedWidth - 2;
  const entries = buildSourceChecklistEntries(config);
  const sections: Array<{ title: string; category: SourceChecklistEntry["category"] }> = [
    { title: "Scholarly", category: "scholarly" },
    { title: "Background", category: "background" },
    { title: "Local", category: "local" }
  ];

  const body: string[] = [
    "ClawResearch source setup",
    "",
    "Select the providers you want active for this project.",
    "Use Up/Down to move, Space or Enter to toggle, S to save, Esc to cancel.",
    ""
  ];

  let runningIndex = 0;

  for (const section of sections) {
    body.push(sectionHeader(section.title, lineWidth));
    const sectionEntries = entries.filter((entry) => entry.category === section.category);

    for (const entry of sectionEntries) {
      const marker = runningIndex === focusIndex ? ">" : " ";
      body.push(
        truncate(
          `${marker} [${entry.selected ? "x" : " "}] ${entry.label} - ${entry.description}`,
          lineWidth
        )
      );
      runningIndex += 1;
    }

    body.push("");
  }

  return body.slice(0, normalizedHeight - 1).join("\n");
}

export function renderAuthPromptFrame(options: AuthPromptFrameOptions): string {
  const width = clampWidth(options.width);
  const height = clampHeight(options.height);
  const innerWidth = width - 2;

  const lines = [
    truncate(options.title, innerWidth),
    truncate(options.subtitle, innerWidth),
    "",
    sectionHeader("Provider auth", innerWidth),
    ...wrapText(`Provider: ${options.providerLabel}`, innerWidth),
    ...wrapText(options.providerDescription, innerWidth),
    "",
    ...options.guidanceLines.flatMap((line) => wrapText(line, innerWidth)),
    "",
    sectionHeader("Input", innerWidth),
    ...wrapText(`${options.inputLabel} ${options.inputValue}`, innerWidth),
    "",
    truncate(options.footerHint, innerWidth)
  ];

  return lines.slice(0, height - 1).map((line) => pad(line, innerWidth)).join("\n");
}

export function renderChatFrame(options: ChatFrameOptions): string {
  const width = clampWidth(options.width);
  const height = clampHeight(options.height);
  const innerWidth = width - 2;
  const header = [
    truncate(options.title, innerWidth),
    truncate(options.subtitle, innerWidth),
    ""
  ];

  const modalLines = options.modalTitle === undefined || options.modalTitle === null
    ? []
    : [
      sectionHeader(options.modalTitle, innerWidth),
      ...options.modalLines!.flatMap((line) => wrapText(line, innerWidth)),
      ""
    ];

  const transcriptHeader = [sectionHeader("Chat", innerWidth)];
  const transcriptBody = flattenLogs(options.logs, innerWidth);

  const brief = [
    sectionHeader("Brief", innerWidth),
    ...briefLines(options.brief, innerWidth),
    ""
  ];

  const composer = [
    sectionHeader("Input", innerWidth),
    ...wrapText(`${options.inputLabel} ${options.inputValue}`, innerWidth),
    "",
    truncate(options.footerHint, innerWidth)
  ];

  const reserved = header.length
    + modalLines.length
    + transcriptHeader.length
    + 1
    + brief.length
    + composer.length;
  const transcriptSpace = Math.max(3, height - 1 - reserved);
  const transcript = [
    ...transcriptHeader,
    ...transcriptBody.slice(-transcriptSpace),
    ""
  ];

  const lines = [
    ...header,
    ...modalLines,
    ...transcript,
    ...brief,
    ...composer
  ];

  return lines.slice(0, height - 1).map((line) => pad(line, innerWidth)).join("\n");
}
