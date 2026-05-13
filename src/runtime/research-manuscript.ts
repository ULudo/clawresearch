import type {
  ResearchClaim,
  ResearchPlan
} from "./research-backend.js";
import { briefFingerprint } from "./research-evidence.js";
import type { ResearchSourceSnapshot } from "./research-sources.js";
import type { RunRecord } from "./run-store.js";

export type ReviewType =
  | "systematic_review"
  | "scoping_review"
  | "narrative_review"
  | "methodological_review"
  | "technical_survey";

export type ManuscriptReadinessState =
  | "not_started"
  | "drafted"
  | "needs_more_evidence"
  | "needs_human_review"
  | "ready_for_revision"
  | "blocked";

export type ReviewProtocol = {
  schemaVersion: 1;
  runId: string;
  briefFingerprint: string;
  researchQuestion: string | null;
  reviewType: ReviewType;
  objective: string;
  scope: {
    topic: string | null;
    coreQuestion: string | null;
    boundaries: string[];
  };
  searchStrategy: {
    plannedQueries: string[];
    queryCandidates: Array<{
      query: string;
      source: string;
      reason: string;
    }>;
    providerIds: {
      scholarlyDiscovery: string[];
      publisherFullText: string[];
      oaRetrievalHelpers: string[];
      generalWeb: string[];
    };
    localContextEnabled: boolean;
  };
  inclusionCriteria: string[];
  exclusionCriteria: string[];
  evidenceTargets: string[];
  manuscriptConstraints: string[];
  manuscriptRequirements: string[];
  workflowNotes: string[];
  successCriteria: string[];
  screeningStages: string[];
  qualityAppraisalCriteria: string[];
  stoppingConditions: string[];
  protocolLimitations: string[];
  actualRetrieval: {
    rawSourceCount: number;
    canonicalPaperCount: number;
    reviewedPaperCount: number;
    reviewWorkflow: ResearchSourceSnapshot["reviewWorkflow"];
    providerAttempts: NonNullable<ResearchSourceSnapshot["retrievalDiagnostics"]>["providerAttempts"];
    screeningSummary: NonNullable<ResearchSourceSnapshot["retrievalDiagnostics"]>["screeningSummary"] | null;
    revisionPasses: number;
    recoveryPasses?: number;
    accessLimitations: string[];
  } | null;
};

export type ReferenceRecord = {
  sourceId: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  citation: string;
};

export type ReferencesArtifact = {
  schemaVersion: 1;
  runId: string;
  referenceCount: number;
  references: ReferenceRecord[];
};

export type PaperCitationLink = {
  sourceId: string;
  sourceTitle?: string;
  evidenceCellId?: string | null;
  supportSnippet?: string;
  confidence?: string | null;
  relevance?: string | null;
  claimIds: string[];
  sectionIds: string[];
};

export type ReviewPaperArtifact = {
  schemaVersion: 1;
  runId: string;
  briefFingerprint: string;
  title: string;
  abstract: string;
  reviewType: ReviewType;
  structureRationale: string;
  scientificRoles: string[];
  sections: Array<{
    id: string;
    role: string;
    orderIndex?: number | null;
    title: string;
    markdown: string;
    sourceIds: string[];
    claimIds: string[];
  }>;
  claims: Array<ResearchClaim & { claimId: string }>;
  citationLinks: PaperCitationLink[];
  referencedPaperIds: string[];
  evidenceTableIds: string[];
  limitations: string[];
  readinessStatus: ManuscriptReadinessState;
};

export type ManuscriptCheckStatus =
  | "pass"
  | "warning"
  | "fail";

export type ManuscriptCheck = {
  id: string;
  title: string;
  status: ManuscriptCheckStatus;
  severity: "info" | "warning" | "blocker";
  message: string;
};

export type ManuscriptChecksArtifact = {
  schemaVersion: 1;
  runId: string;
  paperPath: string;
  readinessStatus: ManuscriptReadinessState;
  blockerCount: number;
  warningCount: number;
  checks: ManuscriptCheck[];
  blockers: string[];
};

export type ReviewProtocolInput = {
  run: RunRecord;
  plan: ResearchPlan;
  scholarlyDiscoveryProviders: string[];
  publisherFullTextProviders: string[];
  oaRetrievalHelperProviders: string[];
  generalWebProviders: string[];
  localContextEnabled: boolean;
  gathered?: ResearchSourceSnapshot | null;
};

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(compactText).filter((value) => value.length > 0))];
}

function markdownList(values: string[], fallback: string): string[] {
  const effectiveValues = values.length > 0 ? values : [fallback];
  return effectiveValues.map((value) => `- ${value}`);
}

function reviewTypeFor(plan: ResearchPlan, run: RunRecord): ReviewType {
  const combined = [
    run.brief.topic,
    run.brief.researchQuestion,
    run.brief.researchDirection,
    run.brief.successCriterion,
    plan.objective,
    plan.rationale
  ].filter(nonEmpty).join(" ").toLowerCase();

  if (/\bsystematic\b/.test(combined)) {
    return "systematic_review";
  }

  if (/\b(scoping|map|mapping|landscape)\b/.test(combined)) {
    return "scoping_review";
  }

  if (/\b(method|methodological|technique|protocol|verification|algorithm)\b/.test(combined)) {
    return "methodological_review";
  }

  if (/\b(system|architecture|implementation|evaluation|benchmark)\b/.test(combined)) {
    return "technical_survey";
  }

  return "narrative_review";
}

function reviewTypeLabel(reviewType: ReviewType): string {
  return reviewType.replace(/_/g, " ");
}

function splitSentences(text: string | null | undefined): string[] {
  if (!nonEmpty(text)) {
    return [];
  }

  return text
    .split(/(?<=[.!?])\s+|;\s+/)
    .map(compactText)
    .filter((sentence) => sentence.length > 0);
}

function manuscriptConstraintsFor(input: ReviewProtocolInput): string[] {
  return uniqueStrings([
    "Release a manuscript export only when computable citation, provenance, schema, and export checks pass.",
    "Keep limitations and unresolved work visible when the researcher or critic records them in the workspace."
  ]);
}

function workflowNotesFor(input: ReviewProtocolInput): string[] {
  return uniqueStrings(splitSentences(input.run.brief.successCriterion)).slice(0, 12);
}

function successCriteriaFor(input: ReviewProtocolInput): string[] {
  const criteria = splitSentences(input.run.brief.successCriterion);
  return uniqueStrings(criteria.length > 0
    ? criteria
    : [input.run.brief.successCriterion ?? ""]
  ).slice(0, 12);
}

function evidenceTargetsFor(input: ReviewProtocolInput): string[] {
  return uniqueStrings([
    ...input.plan.localFocus,
    input.plan.objective
  ]).slice(0, 16);
}

export function buildReviewProtocol(input: ReviewProtocolInput): ReviewProtocol {
  const reviewType = reviewTypeFor(input.plan, input.run);
  const gathered = input.gathered ?? null;
  const queryCandidates = gathered?.retrievalDiagnostics?.queries
    ?? input.plan.searchQueries.map((query) => ({
      query,
      source: "plan",
      reason: "Planned by the research backend."
    }));
  const evidenceTargets = evidenceTargetsFor(input);
  const manuscriptConstraints = manuscriptConstraintsFor(input);
  const workflowNotes = workflowNotesFor(input);
  const successCriteria = successCriteriaFor(input);
  const accessLimitations = gathered?.retrievalDiagnostics?.accessLimitations ?? [];

  return {
    schemaVersion: 1,
    runId: input.run.id,
    briefFingerprint: briefFingerprint(input.run.brief),
    researchQuestion: input.run.brief.researchQuestion,
    reviewType,
    objective: input.plan.objective,
    scope: {
      topic: input.run.brief.topic,
      coreQuestion: input.run.brief.researchQuestion,
      boundaries: uniqueStrings([
        input.run.brief.researchDirection ?? ""
      ]).slice(0, 8)
    },
    searchStrategy: {
      plannedQueries: input.plan.searchQueries,
      queryCandidates: queryCandidates.map((candidate) => ({
        query: candidate.query,
        source: candidate.source,
        reason: candidate.reason
      })),
      providerIds: {
        scholarlyDiscovery: input.scholarlyDiscoveryProviders,
        publisherFullText: input.publisherFullTextProviders,
        oaRetrievalHelpers: input.oaRetrievalHelperProviders,
        generalWeb: input.generalWebProviders
      },
      localContextEnabled: input.localContextEnabled
    },
    inclusionCriteria: [],
    exclusionCriteria: [],
    evidenceTargets,
    manuscriptConstraints,
    manuscriptRequirements: manuscriptConstraints,
    workflowNotes,
    successCriteria,
    screeningStages: [
      "title screening",
      "abstract screening",
      "full-text or access-state screening",
      "reviewed-set selection for synthesis"
    ],
    qualityAppraisalCriteria: [
      "source identity, access state, and bibliographic quality",
      "traceable support for claims, limitations, and open problems"
    ],
    stoppingConditions: [
      "checkpoint progress without treating a budget boundary as research completion",
      "release only when computable citation, provenance, schema, and export checks pass"
    ],
    protocolLimitations: uniqueStrings([
      ...accessLimitations,
      gathered === null ? "Actual retrieval diagnostics are not available until the source-gathering step completes." : "",
      input.localContextEnabled ? "" : "Local project context was disabled for retrieval and framing.",
      input.scholarlyDiscoveryProviders.length === 0 ? "No scholarly discovery providers were configured." : ""
    ]),
    actualRetrieval: gathered === null
      ? null
      : {
        rawSourceCount: gathered.sources.length,
        canonicalPaperCount: gathered.canonicalPapers.length,
        reviewedPaperCount: gathered.reviewedPapers.length,
        reviewWorkflow: gathered.reviewWorkflow,
        providerAttempts: gathered.retrievalDiagnostics?.providerAttempts ?? [],
        screeningSummary: gathered.retrievalDiagnostics?.screeningSummary ?? null,
        revisionPasses: gathered.retrievalDiagnostics?.revisionPasses
          ?? gathered.retrievalDiagnostics?.recoveryPasses
          ?? 0,
        accessLimitations
      }
  };
}

export function reviewProtocolMarkdown(protocol: ReviewProtocol): string {
  return [
    "# Review Protocol",
    "",
    `- Run id: ${protocol.runId}`,
    `- Review type: ${reviewTypeLabel(protocol.reviewType)}`,
    `- Research question: ${protocol.researchQuestion ?? "<missing>"}`,
    `- Objective: ${protocol.objective}`,
    `- Topic: ${protocol.scope.topic ?? "<missing>"}`,
    "",
    "## Scope Boundaries",
    "",
    ...markdownList(protocol.scope.boundaries, "No additional scope boundaries were recorded."),
    "",
    "## Search Strategy",
    "",
    ...markdownList(protocol.searchStrategy.plannedQueries, "No planned queries were recorded."),
    "",
    "## Inclusion Criteria",
    "",
    ...markdownList(protocol.inclusionCriteria, "No inclusion criteria were recorded."),
    "",
    "## Exclusion Criteria",
    "",
    ...markdownList(protocol.exclusionCriteria, "No exclusion criteria were recorded."),
    "",
    "## Evidence Targets",
    "",
    ...markdownList(protocol.evidenceTargets, "No evidence targets were recorded."),
    "",
    "## Manuscript Constraints",
    "",
    ...markdownList(protocol.manuscriptConstraints, "No manuscript constraints were recorded."),
    "",
    "## Workflow Notes",
    "",
    ...markdownList(protocol.workflowNotes, "No workflow notes were separated from evidence targets."),
    "",
    "## Success Criteria",
    "",
    ...markdownList(protocol.successCriteria, "No success criteria were recorded."),
    "",
    "## Screening And Appraisal",
    "",
    ...markdownList(protocol.screeningStages, "No screening stages were recorded."),
    "",
    "## Limitations",
    "",
    ...markdownList(protocol.protocolLimitations, "No protocol limitations were recorded."),
    "",
    "## Actual Retrieval",
    "",
    protocol.actualRetrieval === null
      ? "- Retrieval has not completed yet."
      : `- Raw sources: ${protocol.actualRetrieval.rawSourceCount}\n- Canonical papers: ${protocol.actualRetrieval.canonicalPaperCount}\n- Reviewed papers: ${protocol.actualRetrieval.reviewedPaperCount}\n- Revision passes: ${protocol.actualRetrieval.revisionPasses ?? protocol.actualRetrieval.recoveryPasses ?? 0}`
  ].join("\n");
}
