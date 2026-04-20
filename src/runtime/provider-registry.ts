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
  | "elsevier"
  | "springer_nature"
  | "acm_digital_library";

export type SourceProviderCategory =
  | "scholarlyDiscovery"
  | "publisherFullText"
  | "oaRetrievalHelpers"
  | "generalWeb"
  | "localContext";

export type SourceProviderRole =
  | "discovery"
  | "resolver"
  | "acquisition";

export type SourceProviderDomain =
  | "general"
  | "cs_ai"
  | "biomedical"
  | "mathematics"
  | "social_science";

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

export type ProviderCredentialFieldKind =
  | "api_key"
  | "institution_token"
  | "email";

export type SourceProviderCredentialField = {
  id: string;
  label: string;
  kind: ProviderCredentialFieldKind;
  required: boolean;
};

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
  credentialFields: SourceProviderCredentialField[];
};

const providerDefinitions: SourceProviderDefinition[] = [
  {
    id: "project_files",
    label: "project-files",
    description: "Read markdown and text notes from the current project directory.",
    category: "localContext",
    roles: ["discovery", "acquisition"],
    domains: ["general", "cs_ai", "biomedical", "mathematics", "social_science"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null,
    credentialFields: []
  },
  {
    id: "openalex",
    label: "openalex",
    description: "Broad scholarly discovery with metadata, identifiers, and OA hints.",
    category: "scholarlyDiscovery",
    roles: ["discovery", "resolver"],
    domains: ["general", "cs_ai", "biomedical", "mathematics", "social_science"],
    authMode: "optional_api_key",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: "OPENALEX_API_KEY",
    credentialFields: [
      {
        id: "api_key",
        label: "API key",
        kind: "api_key",
        required: false
      }
    ]
  },
  {
    id: "crossref",
    label: "crossref",
    description: "DOI normalization and metadata resolution with light discovery fallback.",
    category: "scholarlyDiscovery",
    roles: ["discovery", "resolver"],
    domains: ["general", "cs_ai", "biomedical", "mathematics", "social_science"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null,
    credentialFields: []
  },
  {
    id: "arxiv",
    label: "arxiv",
    description: "Preprint discovery and direct access for arXiv-hosted papers.",
    category: "publisherFullText",
    roles: ["discovery", "acquisition"],
    domains: ["general", "cs_ai", "mathematics"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null,
    credentialFields: []
  },
  {
    id: "dblp",
    label: "dblp",
    description: "Computer-science bibliographic discovery and venue grounding.",
    category: "scholarlyDiscovery",
    roles: ["discovery"],
    domains: ["cs_ai"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null,
    credentialFields: []
  },
  {
    id: "pubmed",
    label: "pubmed",
    description: "Biomedical discovery through NCBI PubMed and E-utilities.",
    category: "scholarlyDiscovery",
    roles: ["discovery"],
    domains: ["biomedical"],
    authMode: "optional_api_key",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: "NCBI_API_KEY",
    credentialFields: [
      {
        id: "api_key",
        label: "NCBI API key",
        kind: "api_key",
        required: false
      }
    ]
  },
  {
    id: "europe_pmc",
    label: "europe-pmc",
    description: "Biomedical discovery with abstract and OA/full-text resolution.",
    category: "publisherFullText",
    roles: ["discovery", "resolver", "acquisition"],
    domains: ["biomedical"],
    authMode: "none",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: null,
    credentialFields: []
  },
  {
    id: "core",
    label: "core",
    description: "OA full-text resolution and acquisition from repository aggregations.",
    category: "oaRetrievalHelpers",
    roles: ["resolver", "acquisition"],
    domains: ["general", "cs_ai", "biomedical", "mathematics", "social_science"],
    authMode: "optional_api_key",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: "CORE_API_KEY",
    credentialFields: [
      {
        id: "api_key",
        label: "CORE API key",
        kind: "api_key",
        required: false
      }
    ]
  },
  {
    id: "unpaywall",
    label: "unpaywall",
    description: "DOI-based legal OA resolution and best open copy lookup.",
    category: "oaRetrievalHelpers",
    roles: ["resolver"],
    domains: ["general", "cs_ai", "biomedical", "mathematics", "social_science"],
    authMode: "required_api_key",
    implemented: true,
    defaultEnabled: true,
    defaultEnvVarName: "UNPAYWALL_EMAIL",
    credentialFields: [
      {
        id: "email",
        label: "Unpaywall email",
        kind: "email",
        required: true
      }
    ]
  },
  {
    id: "wikipedia",
    label: "wikipedia",
    description: "Optional non-scholarly background fallback when scholarly retrieval is sparse.",
    category: "generalWeb",
    roles: ["discovery", "acquisition"],
    domains: ["general", "cs_ai", "biomedical", "mathematics", "social_science"],
    authMode: "none",
    implemented: true,
    defaultEnabled: false,
    defaultEnvVarName: null,
    credentialFields: []
  },
  {
    id: "ieee_xplore",
    label: "ieee-xplore",
    description: "IEEE engineering metadata search with open-access and licensed full-text hints.",
    category: "publisherFullText",
    roles: ["discovery", "acquisition"],
    domains: ["cs_ai", "general"],
    authMode: "required_api_key",
    implemented: true,
    defaultEnabled: false,
    defaultEnvVarName: "IEEE_XPLORE_API_KEY",
    credentialFields: [
      {
        id: "api_key",
        label: "IEEE Xplore API key",
        kind: "api_key",
        required: true
      }
    ]
  },
  {
    id: "elsevier",
    label: "elsevier",
    description: "Elsevier discovery via Scopus plus ScienceDirect full-text routing when entitlement is available.",
    category: "scholarlyDiscovery",
    roles: ["discovery", "resolver", "acquisition"],
    domains: ["general", "cs_ai", "biomedical", "mathematics", "social_science"],
    authMode: "required_api_key",
    implemented: true,
    defaultEnabled: false,
    defaultEnvVarName: "ELSEVIER_API_KEY",
    credentialFields: [
      {
        id: "api_key",
        label: "Elsevier API key",
        kind: "api_key",
        required: true
      },
      {
        id: "institution_token",
        label: "Elsevier institution token",
        kind: "institution_token",
        required: false
      }
    ]
  },
  {
    id: "springer_nature",
    label: "springer-nature",
    description: "Springer Nature metadata, OA lookup, and publisher-route resolution.",
    category: "publisherFullText",
    roles: ["discovery", "resolver", "acquisition"],
    domains: ["general", "cs_ai", "biomedical", "mathematics", "social_science"],
    authMode: "required_api_key",
    implemented: true,
    defaultEnabled: false,
    defaultEnvVarName: "SPRINGER_NATURE_API_KEY",
    credentialFields: [
      {
        id: "api_key",
        label: "Springer Nature API key",
        kind: "api_key",
        required: true
      }
    ]
  },
  {
    id: "acm_digital_library",
    label: "acm-dl",
    description: "Future ACM Digital Library integration for CS publisher access.",
    category: "publisherFullText",
    roles: ["acquisition"],
    domains: ["cs_ai"],
    authMode: "institution_token",
    implemented: false,
    defaultEnabled: false,
    defaultEnvVarName: "ACM_DL_TOKEN",
    credentialFields: [
      {
        id: "institution_token",
        label: "ACM DL institution token",
        kind: "institution_token",
        required: true
      }
    ]
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
  ["elsevier", "elsevier"],
  ["scopus", "elsevier"],
  ["science direct", "elsevier"],
  ["science-direct", "elsevier"],
  ["sciencedirect", "elsevier"],
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

const scholarlyProviderCategories = new Set<SourceProviderCategory>([
  "scholarlyDiscovery",
  "publisherFullText",
  "oaRetrievalHelpers"
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

export function providerCredentialFields(providerId: SourceProviderId): SourceProviderCredentialField[] {
  return getSourceProviderDefinition(providerId).credentialFields.map((field) => ({ ...field }));
}

export function defaultSourceProviderIds(
  category: SourceProviderCategory,
  options: { includeUnimplemented?: boolean } = {}
): SourceProviderId[] {
  return listSourceProvidersByCategory(category, options)
    .filter((provider) => provider.defaultEnabled)
    .map((provider) => provider.id);
}

export function defaultScholarlyDiscoveryProviderIds(): SourceProviderId[] {
  return defaultSourceProviderIds("scholarlyDiscovery");
}

export function defaultPublisherFullTextProviderIds(): SourceProviderId[] {
  return defaultSourceProviderIds("publisherFullText");
}

export function defaultOaRetrievalHelperProviderIds(): SourceProviderId[] {
  return defaultSourceProviderIds("oaRetrievalHelpers");
}

export function defaultGeneralWebProviderIds(): SourceProviderId[] {
  return defaultSourceProviderIds("generalWeb");
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

export function isScholarlyProviderCategory(category: SourceProviderCategory): boolean {
  return scholarlyProviderCategories.has(category);
}

export function isGeneralWebProviderCategory(category: SourceProviderCategory): boolean {
  return category === "generalWeb";
}

export function isLocalContextProviderCategory(category: SourceProviderCategory): boolean {
  return category === "localContext";
}

export function defaultScholarlyProviderIds(): SourceProviderId[] {
  return dedupeProviderIds([
    ...defaultScholarlyDiscoveryProviderIds(),
    ...defaultPublisherFullTextProviderIds(),
    ...defaultOaRetrievalHelperProviderIds()
  ]);
}

export function defaultBackgroundProviderIds(): SourceProviderId[] {
  return defaultGeneralWebProviderIds();
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
  configuredFieldIds: string[] | undefined
): ProviderAuthStatus {
  const provider = getSourceProviderDefinition(providerId);

  if (provider.authMode === "none") {
    return "not_needed";
  }

  const configured = new Set(configuredFieldIds ?? []);
  const fields = provider.credentialFields;
  const requiredFields = fields.filter((field) => field.required);
  const optionalFields = fields.filter((field) => !field.required);

  if (fields.length === 0) {
    return "not_needed";
  }

  const hasAllRequired = requiredFields.every((field) => configured.has(field.id));
  const hasAnyOptional = optionalFields.some((field) => configured.has(field.id));

  if (hasAllRequired && (requiredFields.length > 0 || hasAnyOptional)) {
    return "configured";
  }

  return requiredFields.length === 0
    ? "missing_optional"
    : "missing_required";
}
