import type {
  ConfigurableProviderCategory,
  ProjectConfigState
} from "./project-config-store.js";
import {
  getSourceProviderDefinition,
  listSourceProvidersByCategory,
  type SourceProviderId
} from "./provider-registry.js";
import type { ResearchBrief } from "./session-store.js";

export type SourceChecklistEntry = {
  id: string;
  category: ConfigurableProviderCategory | "localContext";
  label: string;
  description: string;
  selected: boolean;
  providerId: SourceProviderId | null;
};

export type ScreenLogEntry = {
  tag: string;
  text: string;
};

export type CommandSuggestion = {
  command: string;
  description: string;
  selected: boolean;
};

type ChatFrameOptions = {
  width: number;
  height: number;
  title: string;
  subtitle: string;
  brief: ResearchBrief;
  conversationLogs: ScreenLogEntry[];
  activityLogs: ScreenLogEntry[];
  latestReply: ScreenLogEntry | null;
  activityLabel: string | null;
  commandSuggestions: CommandSuggestion[];
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
const rightEdgeSafetyGutter = 4;

function clampWidth(width: number): number {
  return Math.max(minimumWidth, Number.isFinite(width) ? Math.floor(width) : 80);
}

function clampHeight(height: number): number {
  return Math.max(defaultHeight, Number.isFinite(height) ? Math.floor(height) : defaultHeight);
}

function contentWidth(width: number): number {
  return Math.max(20, clampWidth(width) - rightEdgeSafetyGutter);
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

function labelForTag(tag: string): string {
  switch (tag) {
    case "consultant":
      return "ClawResearch";
    case "you":
      return "You";
    case "cmd":
      return "Command";
    case "system":
      return "System";
    case "run":
      return "Run";
    case "plan":
      return "Plan";
    case "lit":
    case "literature":
      return "Literature";
    case "memory":
      return "Memory";
    case "verify":
      return "Verify";
    case "next":
      return "Next";
    case "source":
      return "Paper";
    case "claim":
      return "Claim";
    case "exec":
      return "Exec";
    case "done":
      return "Done";
    case "error":
      return "Error";
    case "stdout":
      return "Stdout";
    case "stderr":
      return "Stderr";
    default:
      return tag.length === 0
        ? "Log"
        : `${tag.slice(0, 1).toUpperCase()}${tag.slice(1)}`;
  }
}

function wrapLabeledLine(label: string, text: string, width: number): string[] {
  const prefix = `${label}: `;
  const wrapped = wrapText(`${prefix}${text}`, width);

  if (wrapped.length <= 1) {
    return wrapped;
  }

  const continuationPrefix = " ".repeat(prefix.length);
  return wrapped.map((line, index) => {
    if (index === 0 || line.length === 0) {
      return line;
    }

    return `${continuationPrefix}${line}`;
  });
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
  return logs.flatMap((entry) => wrapLabeledLine(labelForTag(entry.tag), entry.text, width));
}

function latestReplyLines(entry: ScreenLogEntry | null, width: number): string[] {
  if (entry === null) {
    return wrapText("ClawResearch: Waiting for the next consultant response.", width);
  }

  return wrapLabeledLine(labelForTag(entry.tag), entry.text, width);
}

function activitySectionLines(
  activityLabel: string | null,
  activityLogs: ScreenLogEntry[],
  width: number
): string[] {
  const lines: string[] = [
    ...wrapText(`status: ${activityLabel ?? "idle"}`, width)
  ];
  const latestActivity = activityLogs[activityLogs.length - 1] ?? null;

  if (latestActivity !== null) {
    lines.push(...wrapLabeledLine("latest", `${labelForTag(latestActivity.tag)} - ${latestActivity.text}`, width));
  } else {
    lines.push(...wrapText("latest: No live run activity yet.", width));
  }

  return lines;
}

function commandSuggestionLines(
  suggestions: CommandSuggestion[],
  width: number
): string[] {
  return suggestions.flatMap((suggestion) => wrapText(
    `${suggestion.selected ? ">" : " "} ${suggestion.command.padEnd(9)} ${suggestion.description}`,
    width
  ));
}

export function buildSourceChecklistEntries(config: ProjectConfigState): SourceChecklistEntry[] {
  const scholarlyDiscoverySelected = new Set(config.sources.scholarlyDiscovery.selectedProviderIds);
  const publisherFullTextSelected = new Set(config.sources.publisherFullText.selectedProviderIds);
  const oaRetrievalHelpersSelected = new Set(config.sources.oaRetrievalHelpers.selectedProviderIds);
  const generalWebSelected = new Set(config.sources.generalWeb.selectedProviderIds);

  const scholarlyDiscovery = listSourceProvidersByCategory("scholarlyDiscovery")
    .filter((provider) => provider.implemented)
    .map((provider) => ({
      id: `scholarlyDiscovery:${provider.id}`,
      category: "scholarlyDiscovery" as const,
      label: provider.label,
      description: provider.description,
      selected: scholarlyDiscoverySelected.has(provider.id),
      providerId: provider.id
    }));

  const publisherFullText = listSourceProvidersByCategory("publisherFullText")
    .filter((provider) => provider.implemented)
    .map((provider) => ({
      id: `publisherFullText:${provider.id}`,
      category: "publisherFullText" as const,
      label: provider.label,
      description: provider.description,
      selected: publisherFullTextSelected.has(provider.id),
      providerId: provider.id
    }));

  const oaRetrievalHelpers = listSourceProvidersByCategory("oaRetrievalHelpers")
    .filter((provider) => provider.implemented)
    .map((provider) => ({
      id: `oaRetrievalHelpers:${provider.id}`,
      category: "oaRetrievalHelpers" as const,
      label: provider.label,
      description: provider.description,
      selected: oaRetrievalHelpersSelected.has(provider.id),
      providerId: provider.id
    }));

  const generalWeb = listSourceProvidersByCategory("generalWeb")
    .filter((provider) => provider.implemented)
    .map((provider) => ({
      id: `generalWeb:${provider.id}`,
      category: "generalWeb" as const,
      label: provider.label,
      description: provider.description,
      selected: generalWebSelected.has(provider.id),
      providerId: provider.id
    }));

  return [
    ...scholarlyDiscovery,
    ...publisherFullText,
    ...oaRetrievalHelpers,
    ...generalWeb,
    {
      id: "local:project_files",
      category: "localContext",
      label: "project files",
      description: "Use local markdown and text files in the current project as context.",
      selected: config.sources.localContext.projectFilesEnabled,
      providerId: "project_files"
    }
  ];
}

export function toggleSourceChecklistEntry(
  config: ProjectConfigState,
  entry: SourceChecklistEntry
): ProjectConfigState {
  if (entry.category === "localContext") {
    return {
      ...config,
      sources: {
        ...config.sources,
        localContext: {
          projectFilesEnabled: !config.sources.localContext.projectFilesEnabled
        }
      }
    };
  }

  if (entry.providerId === null) {
    return config;
  }

  const selected = new Set(
    config.sources[entry.category].selectedProviderIds
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
  fieldId: string
): string {
  const definition = getSourceProviderDefinition(providerId);
  const field = definition.credentialFields.find((candidate) => candidate.id === fieldId);
  const qualifier = field?.required === true ? "required" : "optional";
  const providerLabel = definition.label.toLowerCase();

  return field === undefined
    ? `${definition.label} credential [${qualifier}]`
    : `${field.label.toLowerCase().startsWith(providerLabel)
      ? field.label.toLowerCase()
      : `${providerLabel} ${field.label.toLowerCase()}`} [${qualifier}]`;
}

export function authPromptGuidance(
  providerId: SourceProviderId,
  fieldId: string
): string[] {
  const definition = getSourceProviderDefinition(providerId);
  const field = definition.credentialFields.find((candidate) => candidate.id === fieldId);

  if (field === undefined) {
    return [
      "Enter the credential value for this provider.",
      "Leave it blank to continue without configuring it right now."
    ];
  }

  if (providerId === "pubmed" && fieldId === "api_key") {
    return [
      "Optional. PubMed works without an NCBI API key, but the request budget is tighter and rate limits can hit sooner.",
      "If you have one already, paste it here.",
      "Leave it blank to continue without it."
    ];
  }

  if (providerId === "openalex" && fieldId === "api_key") {
    return [
      "Optional. OpenAlex works without a key, but authenticated access can be steadier when available.",
      "Paste the OpenAlex API key here if you want to use one.",
      "Leave it blank to continue without it."
    ];
  }

  if (providerId === "core" && fieldId === "api_key") {
    return [
      "Optional. CORE can still be used through the broader stack, but a key improves direct retrieval.",
      "Paste the CORE API key here if you have one.",
      "Leave it blank to continue without it."
    ];
  }

  if (providerId === "unpaywall" && fieldId === "email") {
    return [
      "Required for Unpaywall. This is the contact email Unpaywall expects for legal OA resolution requests.",
      "Paste the email address you want ClawResearch to use.",
      "Leave it blank only if you want Unpaywall to stay unavailable."
    ];
  }

  if (providerId === "ieee_xplore" && fieldId === "api_key") {
    return [
      "Required for IEEE Xplore discovery.",
      "Paste the IEEE Xplore API key here.",
      "Leave it blank to keep IEEE Xplore unavailable for now."
    ];
  }

  if (providerId === "elsevier" && fieldId === "api_key") {
    return [
      "Required for Elsevier discovery. This powers Scopus search and the ScienceDirect route family.",
      "Paste the Elsevier API key here.",
      "Leave it blank to keep Elsevier unavailable for now."
    ];
  }

  if (providerId === "elsevier" && fieldId === "institution_token") {
    return [
      "Optional. If your institution provides an Elsevier or ScienceDirect entitlement token, it can unlock licensed full-text routes.",
      "Paste the institution token here if you have one.",
      "Leave it blank to continue with metadata-only or open-access routes."
    ];
  }

  if (providerId === "springer_nature" && fieldId === "api_key") {
    return [
      "Required for Springer Nature retrieval.",
      "Paste the Springer Nature API key here.",
      "Leave it blank to keep Springer Nature unavailable for now."
    ];
  }

  switch (field.kind) {
    case "api_key":
      return [
        field.required
          ? `Required for ${definition.label}. Paste the API key here to enable this provider.`
          : `Optional for ${definition.label}. Paste the API key here if you want to use it.`,
        field.required
          ? "Leave it blank to keep this provider unavailable for now."
          : "Leave it blank to continue without it."
      ];
    case "institution_token":
      return [
        field.required
          ? `Required for ${definition.label}. Paste the institution or entitlement token here.`
          : `Optional. Paste the institution or entitlement token for ${definition.label} if you want licensed access routes.`,
        field.required
          ? "Leave it blank to keep this provider unavailable for now."
          : "Leave it blank to continue without it."
      ];
    case "email":
      return [
        field.required
          ? `Required for ${definition.label}. Paste the email address this provider expects.`
          : `Optional. Paste the email address you want ${definition.label} to use.`,
        field.required
          ? "Leave it blank to keep this provider unavailable for now."
          : "Leave it blank to continue without it."
      ];
  }

  return [
    field.required
      ? `Required for ${definition.label}. Paste the credential value here to enable this provider.`
      : `Optional for ${definition.label}. Paste the credential value here if you want to use it.`,
    field.required
      ? "Leave it blank to keep this provider unavailable for now."
      : "Leave it blank to continue without it."
  ];
  }

export function renderSourceChecklist(
  config: ProjectConfigState,
  focusIndex: number,
  width: number,
  height: number
): string {
  const normalizedWidth = contentWidth(width);
  const normalizedHeight = clampHeight(height);
  const lineWidth = normalizedWidth;
  const entries = buildSourceChecklistEntries(config);
  const sections: Array<{ title: string; category: SourceChecklistEntry["category"] }> = [
    { title: "Scholarly Discovery", category: "scholarlyDiscovery" },
    { title: "Publisher / Full Text", category: "publisherFullText" },
    { title: "OA / Retrieval Helpers", category: "oaRetrievalHelpers" },
    { title: "General Web", category: "generalWeb" },
    { title: "Local Context", category: "localContext" }
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
  const width = contentWidth(options.width);
  const height = clampHeight(options.height);
  const innerWidth = width;

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
  const width = contentWidth(options.width);
  const height = clampHeight(options.height);
  const innerWidth = width;
  const header = [
    truncate(options.title, innerWidth),
    truncate(options.subtitle, innerWidth)
  ];

  const modalLines = options.modalTitle === undefined || options.modalTitle === null
    ? []
    : [
      sectionHeader(options.modalTitle, innerWidth),
      ...options.modalLines!.flatMap((line) => wrapText(line, innerWidth))
    ];

  const briefBody = briefLines(options.brief, innerWidth).slice(0, 4);
  const activityBody = activitySectionLines(options.activityLabel, options.activityLogs, innerWidth).slice(0, 2);
  const latestReplyBody = latestReplyLines(options.latestReply, innerWidth);
  const commandSuggestionBody = commandSuggestionLines(options.commandSuggestions, innerWidth);
  const transcriptBody = flattenLogs(options.conversationLogs, innerWidth);
  const composer = [
    sectionHeader("Input", innerWidth),
    ...wrapText(`${options.inputLabel} ${options.inputValue}`, innerWidth),
    truncate(options.footerHint, innerWidth)
  ];
  const minimumLatestReplyLines = Math.min(2, latestReplyBody.length);
  const baseReserved = header.length
    + modalLines.length
    + 1 + briefBody.length
    + 1 + activityBody.length
    + 1 + minimumLatestReplyLines
    + composer.length;

  let remaining = Math.max(0, height - 1 - baseReserved);
  const commandBodyLimit = Math.min(commandSuggestionBody.length, remaining >= 5 ? 3 : remaining >= 3 ? 2 : remaining >= 2 ? 1 : 0);
  remaining -= commandBodyLimit > 0 ? commandBodyLimit + 1 : 0;
  const transcriptBodyLimit = Math.min(transcriptBody.length, remaining >= 4 ? remaining - 1 : 0);
  remaining -= transcriptBodyLimit > 0 ? transcriptBodyLimit + 1 : 0;
  const extraReplyLines = Math.min(
    Math.max(0, latestReplyBody.length - minimumLatestReplyLines),
    Math.max(0, remaining)
  );
  const latestReplyLimit = minimumLatestReplyLines + extraReplyLines;

  const brief = [
    sectionHeader("Brief", innerWidth),
    ...briefBody
  ];

  const activity = [
    sectionHeader("Activity", innerWidth),
    ...activityBody
  ];

  const transcript = transcriptBodyLimit === 0
    ? []
    : [
      sectionHeader("Recent Chat", innerWidth),
      ...transcriptBody.slice(-transcriptBodyLimit)
    ];

  const latestReply = [
    sectionHeader("Latest Reply", innerWidth),
    ...latestReplyBody.slice(0, latestReplyLimit)
  ];

  const commandSuggestions = commandBodyLimit === 0
    ? []
    : [
      sectionHeader("Commands", innerWidth),
      ...commandSuggestionBody.slice(0, commandBodyLimit)
    ];

  const lines = [
    ...header,
    ...modalLines,
    ...brief,
    ...activity,
    ...transcript,
    ...latestReply,
    ...commandSuggestions,
    ...composer
  ];

  return lines.slice(0, height - 1).map((line) => pad(line, innerWidth)).join("\n");
}
