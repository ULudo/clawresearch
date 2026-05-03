import type { CanonicalPaper } from "./literature-store.js";
import type {
  ResearchClaim,
  ResearchPlan
} from "./research-backend.js";
import { briefFingerprint } from "./research-evidence.js";
import type { ResearchSourceSnapshot } from "./research-sources.js";
import type { CriticReviewArtifact } from "./research-critic.js";
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

export type PaperOutline = {
  schemaVersion: 1;
  runId: string;
  briefFingerprint: string;
  title: string;
  reviewType: ReviewType;
  structureRationale: string;
  abstractClaims: string[];
  rhetoricalPlan: Array<{
    id: string;
    role: string;
    title: string;
    intent: string;
    evidenceIds: string[];
    claimIds: string[];
  }>;
  keyThemes: string[];
  evidenceTablesToCite: string[];
  openQuestions: string[];
  limitations: string[];
  agendaImplications: string[];
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

export type ManuscriptBundle = {
  protocol: ReviewProtocol;
  protocolMarkdown: string;
  outline: PaperOutline;
  paper: ReviewPaperArtifact;
  paperMarkdown: string;
  references: ReferencesArtifact;
  checks: ManuscriptChecksArtifact;
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

function referenceFromPaper(paper: CanonicalPaper): ReferenceRecord {
  return {
    sourceId: paper.id,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    doi: paper.identifiers.doi ?? null,
    arxivId: paper.identifiers.arxivId ?? null,
    pmid: paper.identifiers.pmid ?? null,
    pmcid: paper.identifiers.pmcid ?? null,
    url: paper.bestAccessUrl,
    citation: paper.citation
  };
}

export function buildReferencesArtifact(run: RunRecord, papers: CanonicalPaper[]): ReferencesArtifact {
  const references = papers.map(referenceFromPaper);

  return {
    schemaVersion: 1,
    runId: run.id,
    referenceCount: references.length,
    references
  };
}

function readinessAfterChecks(
  preliminary: ManuscriptReadinessState,
  checks: ManuscriptCheck[]
): ManuscriptReadinessState {
  if (checks.some((item) => item.severity === "blocker" && item.status === "fail")) {
    if (preliminary === "blocked" || preliminary === "needs_more_evidence") {
      return preliminary;
    }

    return "needs_human_review";
  }

  return preliminary;
}

function criticCheckSeverity(report: CriticReviewArtifact, objectionSeverity: string): "warning" | "blocker" {
  void report;
  void objectionSeverity;
  return "warning";
}

function criticReportsToChecks(reports: CriticReviewArtifact[]): ManuscriptCheck[] {
  return reports.flatMap((report) => {
    if (report.objections.length === 0) {
      return report.readiness === "pass"
        ? []
        : [{
          id: `critic-${report.stage}`,
          title: `${report.stage.replace(/_/g, " ")} critic diagnostic`,
          status: "warning" as const,
          severity: "warning" as const,
          message: `The ${report.stage.replace(/_/g, " ")} critic returned ${report.readiness}.`
        }];
    }

    return report.objections.map((objection, index) => {
      const severity = criticCheckSeverity(report, objection.severity);
      const paperSuffix = objection.affectedPaperIds.length > 0
        ? ` Papers: ${objection.affectedPaperIds.join(", ")}.`
        : "";
      const claimSuffix = objection.affectedClaimIds.length > 0
        ? ` Claims: ${objection.affectedClaimIds.join(", ")}.`
        : "";
      const revisionSuffix = objection.suggestedRevision !== null
        ? ` Suggested revision: ${objection.suggestedRevision}`
        : "";

      return {
        id: `critic-${report.stage}-${objection.code || index + 1}`,
        title: `${report.stage.replace(/_/g, " ")} critic: ${objection.target.replace(/_/g, " ")}`,
        status: severity === "blocker" ? "fail" as const : "warning" as const,
        severity,
        message: `${objection.message}${paperSuffix}${claimSuffix}${revisionSuffix}`
      };
    });
  });
}

function readinessWithCriticReports(
  current: ManuscriptReadinessState,
  reports: CriticReviewArtifact[]
): ManuscriptReadinessState {
  void reports;
  return current;
}

function renderBundlePaperMarkdown(paper: ReviewPaperArtifact, references: ReferencesArtifact): string {
  const lines = [
    `# ${paper.title}`,
    "",
    "## Abstract",
    "",
    paper.abstract,
    "",
    "## Manuscript Structure",
    "",
    paper.structureRationale,
    ""
  ];

  for (const section of paper.sections) {
    lines.push(`## ${section.title}`, "", section.markdown, "");
  }

  lines.push("## References", "");

  if (references.references.length === 0) {
    lines.push("- No reviewed references are available yet.");
  } else {
    for (const reference of references.references) {
      lines.push(`- [${reference.sourceId}] ${reference.citation}`);
    }
  }

  return lines.join("\n");
}

function criticOutcomeLabel(readinessStatus: ManuscriptReadinessState): string {
  if (readinessStatus === "blocked") {
    return "Externally blocked";
  }

  if (readinessStatus === "needs_human_review") {
    return "Needs expert decision";
  }

  if (readinessStatus === "needs_more_evidence") {
    return "Needs further evidence work";
  }

  return "Not release-ready";
}

function buildCriticGatedPaperArtifact(
  run: RunRecord,
  bundle: ManuscriptBundle,
  readinessStatus: ManuscriptReadinessState,
  blockers: string[]
): ReviewPaperArtifact {
  const outcomeLabel = criticOutcomeLabel(readinessStatus);
  const sourceIds = uniqueStrings([
    ...bundle.paper.referencedPaperIds,
    ...bundle.paper.claims.flatMap((claim) => claim.sourceIds)
  ]);
  const claimLines = bundle.paper.claims.length > 0
    ? bundle.paper.claims.map((claim) => {
        const sources = uniqueStrings(claim.sourceIds);
        const suffix = sources.length > 0 ? ` Sources: ${sources.map((id) => `[${id}]`).join(", ")}.` : "";
        return `${claim.claim} ${claim.evidence}${suffix}`;
      })
    : ["No release-ready structured claims were available from the work store."];
  const blockerLines = blockers.length > 0
    ? blockers
    : ["The critic review did not pass, but no concrete objection text was available."];
  const nextStepLines = bundle.outline.openQuestions.length > 0
    ? bundle.outline.openQuestions
    : ["Resolve the critic-generated work items in the research work store before releasing a manuscript."];
  const existingStatusTitle = bundle.paper.scientificRoles.includes("status_report");

  return {
    schemaVersion: 1,
    runId: run.id,
    briefFingerprint: briefFingerprint(run.brief),
    title: existingStatusTitle ? bundle.paper.title : `${bundle.paper.title} - critic-gated research outcome`,
    abstract: `${outcomeLabel}: ${bundle.paper.abstract}`,
    reviewType: bundle.paper.reviewType,
    structureRationale: "This artifact reports the current research state after critic review. It is not a released manuscript; manuscript release requires the work-store claims, evidence, citations, sections, deterministic checks, and critic checks to pass.",
    scientificRoles: ["status_report"],
    sections: [
      {
        id: "research-outcome",
        role: "status_report",
        title: "Research Outcome",
        markdown: markdownList([
          `Outcome: ${outcomeLabel}.`,
          "The critic review created release blockers for the current work-store manuscript bundle.",
          bundle.paper.abstract
        ], "No research outcome was recorded.").join("\n"),
        sourceIds: [],
        claimIds: []
      },
      {
        id: "current-findings",
        role: "status_report",
        title: "Current Evidence-Led Findings",
        markdown: markdownList(claimLines, "No evidence-led findings were recorded.").join("\n"),
        sourceIds,
        claimIds: bundle.paper.claims.map((claim) => claim.claimId)
      },
      {
        id: "critic-blockers",
        role: "status_report",
        title: "Critic Blockers",
        markdown: markdownList(blockerLines, "No critic blockers were recorded.").join("\n"),
        sourceIds: [],
        claimIds: []
      },
      {
        id: "next-evidence-work",
        role: "status_report",
        title: "Next Evidence Work",
        markdown: markdownList(nextStepLines, "No next evidence work was recorded.").join("\n"),
        sourceIds,
        claimIds: bundle.paper.claims.map((claim) => claim.claimId)
      }
    ],
    claims: bundle.paper.claims,
    citationLinks: bundle.paper.citationLinks,
    referencedPaperIds: sourceIds,
    evidenceTableIds: bundle.paper.evidenceTableIds,
    limitations: uniqueStrings([...bundle.paper.limitations, ...blockerLines]),
    readinessStatus
  };
}

export function applyCriticReportsToManuscriptBundle(
  run: RunRecord,
  bundle: ManuscriptBundle,
  reports: CriticReviewArtifact[]
): ManuscriptBundle {
  const criticChecks = criticReportsToChecks(reports);
  if (criticChecks.length === 0) {
    return bundle;
  }

  const checks = [...bundle.checks.checks, ...criticChecks];
  const preliminaryReadiness = readinessWithCriticReports(bundle.checks.readinessStatus, reports);
  const readinessStatus = readinessAfterChecks(preliminaryReadiness, checks);
  const blockerCount = checks.filter((item) => item.severity === "blocker" && item.status === "fail").length;
  const warningCount = checks.filter((item) => item.status === "warning").length;
  const blockers = checks
    .filter((item) => item.severity === "blocker" && item.status === "fail")
    .map((item) => item.message);
  const manuscriptReady = readinessStatus === "ready_for_revision" && blockerCount === 0;
  const paper = manuscriptReady
    ? { ...bundle.paper, readinessStatus }
    : buildCriticGatedPaperArtifact(run, bundle, readinessStatus, blockers);

  return {
    ...bundle,
    paper,
    paperMarkdown: renderBundlePaperMarkdown(paper, bundle.references),
    checks: {
      ...bundle.checks,
      readinessStatus,
      blockerCount,
      warningCount,
      checks,
      blockers
    }
  };
}
