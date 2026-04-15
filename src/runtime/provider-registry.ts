export type SourceProviderId =
  | "project_files"
  | "openalex"
  | "crossref"
  | "arxiv"
  | "dblp"
  | "pubmed"
  | "europe_pmc"
  | "core"
  | "unpaywall"
  | "wikipedia"
  | "ieee_xplore"
  | "scopus"
  | "sciencedirect"
  | "springer_nature"
  | "acm_digital_library";

export type SourceProviderCategory =
  | "scholarly"
  | "background"
  | "local";

export type SourceProviderRole =
  | "discovery"
  | "resolver"
  | "acquisition";

export type SourceProviderDomain =
  | "general"
  | "cs_ai"
  | "biomedical";

export type SourceProviderAuthMode =
  | "none"
  | "optional_api_key"
  | "required_api_key"
  | "institution_token";

export type ProviderAuthStatus =
  | "not_needed"
  | "configured"
  | "missing_optional"
  | "missing_required";

export type SourceProviderDefinition = {
  id: SourceProviderId;
  label: string;
  description: string;
  category: SourceProviderCategory;
  roles: SourceProviderRole[];
  domains: SourceProviderDomain[];
  authMode: SourceProviderAuthMode;
  implemented: boolean;
  defaultEnabled: boolean;
  defaultEnvVarName: string | null;
};

const providerDefinitions: SourceProviderDefinition[] = [
  {
    id: "project_files",
    label: "project-files",
    description: "Read markdown and text notes from the current project directory.",
    category: "local",
    roles: ["discovery", "acquisition"],
    domains: ["general", "cs_ai", "biomedical"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null
  },
  {
    id: "openalex",
    label: "openalex",
    description: "Broad scholarly discovery with metadata, identifiers, and OA hints.",
    category: "scholarly",
    roles: ["discovery", "resolver"],
    domains: ["general", "cs_ai", "biomedical"],
    authMode: "optional_api_key",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: "OPENALEX_API_KEY"
  },
  {
    id: "crossref",
    label: "crossref",
    description: "DOI normalization and metadata resolution with light discovery fallback.",
    category: "scholarly",
    roles: ["discovery", "resolver"],
    domains: ["general", "cs_ai", "biomedical"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null
  },
  {
    id: "arxiv",
    label: "arxiv",
    description: "Preprint discovery and direct access for arXiv-hosted papers.",
    category: "scholarly",
    roles: ["discovery", "acquisition"],
    domains: ["general", "cs_ai"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null
  },
  {
    id: "dblp",
    label: "dblp",
    description: "Computer-science bibliographic discovery and venue grounding.",
    category: "scholarly",
    roles: ["discovery"],
    domains: ["cs_ai"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null
  },
  {
    id: "pubmed",
    label: "pubmed",
    description: "Biomedical discovery through NCBI PubMed and E-utilities.",
    category: "scholarly",
    roles: ["discovery"],
    domains: ["biomedical"],
    authMode: "optional_api_key",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: "NCBI_API_KEY"
  },
  {
    id: "europe_pmc",
    label: "europe-pmc",
    description: "Biomedical discovery with abstract and OA/full-text resolution.",
    category: "scholarly",
    roles: ["discovery", "resolver", "acquisition"],
    domains: ["biomedical"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null
  },
  {
    id: "core",
    label: "core",
    description: "OA full-text resolution and acquisition from repository aggregations.",
    category: "scholarly",
    roles: ["resolver", "acquisition"],
    domains: ["general", "cs_ai", "biomedical"],
    authMode: "optional_api_key",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: "CORE_API_KEY"
  },
  {
    id: "unpaywall",
    label: "unpaywall",
    description: "DOI-based legal OA resolution and best open copy lookup.",
    category: "scholarly",
    roles: ["resolver"],
    domains: ["general", "cs_ai", "biomedical"],
    authMode: "required_api_key",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: "UNPAYWALL_EMAIL"
  },
  {
    id: "wikipedia",
    label: "wikipedia",
    description: "Optional non-scholarly background fallback when scholarly retrieval is sparse.",
    category: "background",
    roles: ["discovery", "acquisition"],
    domains: ["general", "cs_ai", "biomedical"],
    authMode: "none",
    implemented: true,
    defaultEnabled: false,
    defaultEnvVarName: null
  },
  {
    id: "ieee_xplore",
    label: "ieee-xplore",
    description: "Licensed engineering and applied-science metadata/full-text APIs.",
    category: "scholarly",
    roles: ["discovery", "acquisition"],
    domains: ["cs_ai", "general"],
    authMode: "required_api_key",
    implemented: false,
    defaultEnabled: false,
    defaultEnvVarName: "IEEE_XPLORE_API_KEY"
  },
  {
    id: "scopus",
    label: "scopus",
    description: "Broad scholarly index through Elsevier APIs and institutional access.",
    category: "scholarly",
    roles: ["discovery", "resolver"],
    domains: ["general", "cs_ai", "biomedical"],
    authMode: "required_api_key",
    implemented: false,
    defaultEnabled: false,
    defaultEnvVarName: "SCOPUS_API_KEY"
  },
  {
    id: "sciencedirect",
    label: "sciencedirect",
    description: "Licensed full-text retrieval through Elsevier publisher APIs.",
    category: "scholarly",
    roles: ["acquisition"],
    domains: ["general", "cs_ai", "biomedical"],
    authMode: "institution_token",
    implemented: false,
    defaultEnabled: false,
    defaultEnvVarName: "SCIENCEDIRECT_INSTITUTION_TOKEN"
  },
  {
    id: "springer_nature",
    label: "springer-nature",
    description: "Publisher metadata and TDM/full-text APIs for Springer Nature content.",
    category: "scholarly",
    roles: ["acquisition", "resolver"],
    domains: ["general", "cs_ai", "biomedical"],
    authMode: "required_api_key",
    implemented: false,
    defaultEnabled: false,
    defaultEnvVarName: "SPRINGER_NATURE_API_KEY"
  },
  {
    id: "acm_digital_library",
    label: "acm-dl",
    description: "Future ACM Digital Library integration for CS publisher access.",
    category: "scholarly",
    roles: ["acquisition"],
    domains: ["cs_ai"],
    authMode: "institution_token",
    implemented: false,
    defaultEnabled: false,
    defaultEnvVarName: "ACM_DL_TOKEN"
  }
];

const providerAliases = new Map<string, SourceProviderId>([
  ["project-files", "project_files"],
  ["project_files", "project_files"],
  ["project files", "project_files"],
  ["local-files", "project_files"],
  ["local_files", "project_files"],
  ["local files", "project_files"],
  ["local", "project_files"],
  ["project", "project_files"],
  ["openalex", "openalex"],
  ["open alex", "openalex"],
  ["crossref", "crossref"],
  ["cross ref", "crossref"],
  ["arxiv", "arxiv"],
  ["ar-xiv", "arxiv"],
  ["ar x i v", "arxiv"],
  ["dblp", "dblp"],
  ["pubmed", "pubmed"],
  ["europe-pmc", "europe_pmc"],
  ["europe_pmc", "europe_pmc"],
  ["europe pmc", "europe_pmc"],
  ["core", "core"],
  ["unpaywall", "unpaywall"],
  ["wikipedia", "wikipedia"],
  ["wiki", "wikipedia"],
  ["ieee", "ieee_xplore"],
  ["ieee-xplore", "ieee_xplore"],
  ["ieee_xplore", "ieee_xplore"],
  ["ieee xplore", "ieee_xplore"],
  ["scopus", "scopus"],
  ["sciencedirect", "sciencedirect"],
  ["science-direct", "sciencedirect"],
  ["science direct", "sciencedirect"],
  ["springer", "springer_nature"],
  ["springer-nature", "springer_nature"],
  ["springer_nature", "springer_nature"],
  ["springer nature", "springer_nature"],
  ["acm", "acm_digital_library"],
  ["acm-dl", "acm_digital_library"],
  ["acm dl", "acm_digital_library"],
  ["acm_digital_library", "acm_digital_library"],
  ["acm digital library", "acm_digital_library"]
]);

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeToken(text: string): string {
  return normalizeWhitespace(text.toLowerCase())
    .replace(/[_-]/g, " ");
}

export function listSourceProviders(): SourceProviderDefinition[] {
  return providerDefinitions.map((provider) => ({ ...provider }));
}

export function listSourceProvidersByCategory(
  category: SourceProviderCategory,
  options: { includeUnimplemented?: boolean } = {}
): SourceProviderDefinition[] {
  return providerDefinitions
    .filter((provider) => provider.category === category)
    .filter((provider) => options.includeUnimplemented === true || provider.implemented);
}

export function getSourceProviderDefinition(providerId: SourceProviderId): SourceProviderDefinition {
  const provider = providerDefinitions.find((candidate) => candidate.id === providerId);

  if (provider === undefined) {
    throw new Error(`Unknown source provider: ${providerId}`);
  }

  return provider;
}

export function defaultSourceProviderIds(
  category: SourceProviderCategory,
  options: { includeUnimplemented?: boolean } = {}
): SourceProviderId[] {
  return listSourceProvidersByCategory(category, options)
    .filter((provider) => provider.defaultEnabled)
    .map((provider) => provider.id);
}

export function defaultScholarlyProviderIds(): SourceProviderId[] {
  return defaultSourceProviderIds("scholarly");
}

export function defaultBackgroundProviderIds(): SourceProviderId[] {
  return defaultSourceProviderIds("background");
}

export function dedupeProviderIds(providerIds: SourceProviderId[]): SourceProviderId[] {
  const seen = new Set<SourceProviderId>();
  const normalized: SourceProviderId[] = [];

  for (const providerId of providerIds) {
    if (seen.has(providerId)) {
      continue;
    }

    seen.add(providerId);
    normalized.push(providerId);
  }

  return normalized;
}

export function parseProviderSelection(
  selectionText: string,
  category: SourceProviderCategory,
  options: { includeUnimplemented?: boolean } = {}
): SourceProviderId[] | null {
  const normalized = normalizeWhitespace(selectionText);

  if (normalized.length === 0) {
    return [];
  }

  const lowered = normalized.toLowerCase();

  if (lowered === "default" || lowered === "defaults" || lowered === "all") {
    return defaultSourceProviderIds(category, options);
  }

  if (lowered === "none" || lowered === "off") {
    return [];
  }

  const allowedProviderIds = new Set(
    listSourceProvidersByCategory(category, options).map((provider) => provider.id)
  );
  const tokens = normalized
    .split(/[,\n;]/)
    .map((entry) => normalizeToken(entry))
    .flatMap((entry) => entry.length === 0 ? [] : [entry]);

  if (tokens.length === 0) {
    return [];
  }

  const providerIds = tokens.flatMap((token) => {
    const providerId = providerAliases.get(token);

    if (providerId === undefined || !allowedProviderIds.has(providerId)) {
      return [];
    }

    return [providerId];
  });

  if (providerIds.length === 0) {
    return null;
  }

  return dedupeProviderIds(providerIds);
}

export function formatSelectedProviderLabels(providerIds: SourceProviderId[]): string {
  if (providerIds.length === 0) {
    return "none";
  }

  const selected = new Set(providerIds);

  return providerDefinitions
    .filter((provider) => selected.has(provider.id))
    .map((provider) => provider.label)
    .join(", ");
}

export function createProviderSelectionLines(
  category: SourceProviderCategory,
  providerIds: SourceProviderId[],
  options: { includeUnimplemented?: boolean } = {}
): string[] {
  const selected = new Set(providerIds);

  return listSourceProvidersByCategory(category, options).map((provider, index) => {
    const marker = selected.has(provider.id) ? "[x]" : "[ ]";
    return `${marker} ${index + 1}. ${provider.label} - ${provider.description}`;
  });
}

export function normalizeProviderId(value: unknown): SourceProviderId | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = providerAliases.get(normalizeToken(value));

  if (normalized !== undefined) {
    return normalized;
  }

  return providerDefinitions.some((provider) => provider.id === value)
    ? value as SourceProviderId
    : null;
}

export function providerAuthStatus(
  providerId: SourceProviderId,
  authRef: string | null | undefined
): ProviderAuthStatus {
  const provider = getSourceProviderDefinition(providerId);

  if (provider.authMode === "none") {
    return "not_needed";
  }

  const envVarName = authRef === undefined
    ? provider.defaultEnvVarName
    : authRef;
  const configured = typeof envVarName === "string"
    && envVarName.trim().length > 0
    && typeof process.env[envVarName] === "string"
    && process.env[envVarName]!.trim().length > 0;

  if (configured) {
    return "configured";
  }

  return provider.authMode === "optional_api_key"
    ? "missing_optional"
    : "missing_required";
}
