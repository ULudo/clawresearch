import type { CanonicalPaper } from "./literature-store.js";
import { createMemoryRecordId } from "./memory-store.js";
import type {
  ResearchAgenda,
  ResearchClaim,
  ResearchPlan,
  ResearchSynthesis
} from "./research-backend.js";
import { briefFingerprint, type EvidenceMatrix } from "./research-evidence.js";
import {
  buildReviewFacets,
  isRetrievalQualityConstraintPhrase
} from "./literature-review.js";
import type { ResearchSourceGatherResult } from "./research-sources.js";
import type { CriticReviewArtifact } from "./research-critic.js";
import type { RunRecord } from "./run-store.js";
import type { VerificationReport, VerifiedClaim } from "./verifier.js";

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
  requiredSuccessCriterionFacets: Array<{
    id: string;
    label: string;
    kind: string;
    required: boolean;
    terms: string[];
    rationale: string;
  }>;
  screeningStages: string[];
  qualityAppraisalCriteria: string[];
  stoppingConditions: string[];
  protocolLimitations: string[];
  actualRetrieval: {
    rawSourceCount: number;
    canonicalPaperCount: number;
    reviewedPaperCount: number;
    reviewWorkflow: ResearchSourceGatherResult["reviewWorkflow"];
    providerAttempts: NonNullable<ResearchSourceGatherResult["retrievalDiagnostics"]>["providerAttempts"];
    screeningSummary: NonNullable<ResearchSourceGatherResult["retrievalDiagnostics"]>["screeningSummary"] | null;
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
  gathered?: ResearchSourceGatherResult | null;
};

export type ManuscriptBundleInput = ReviewProtocolInput & {
  gathered: ResearchSourceGatherResult;
  reviewedPapers: CanonicalPaper[];
  evidenceMatrix: EvidenceMatrix;
  synthesis: ResearchSynthesis;
  verification: VerificationReport;
  agenda: ResearchAgenda;
};

const requiredScientificRoles = [
  "title_and_abstract",
  "motivation_and_question",
  "literature_positioning",
  "review_method",
  "evidence_appraisal",
  "synthesis",
  "open_problems",
  "limitations",
  "conclusion",
  "references"
];

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

function claimRecordId(claim: ResearchClaim): string {
  return createMemoryRecordId("claim", claim.claim);
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

function titleFor(run: RunRecord, reviewType: ReviewType): string {
  const question = run.brief.researchQuestion?.replace(/\?+$/, "").trim();
  const topic = run.brief.topic?.trim();

  if (question !== undefined && question.length > 0) {
    return `${question}: A ${reviewTypeLabel(reviewType)}`;
  }

  if (topic !== undefined && topic.length > 0) {
    return `${topic}: A ${reviewTypeLabel(reviewType)}`;
  }

  return `Review paper draft for ${run.id}`;
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

function isFileLikeProtocolPhrase(phrase: string): boolean {
  const compact = phrase.trim();
  return /(^|[/\\])[\w.-]+\.(txt|md|json|jsonl|log|csv|ts|tsx|js|jsx|py|yaml|yml)$/i.test(compact)
    || /^[\w.-]+\.(txt|md|json|jsonl|log|csv|ts|tsx|js|jsx|py|yaml|yml)$/i.test(compact);
}

function isProtocolEvidencePhrase(phrase: string): boolean {
  return !isRetrievalQualityConstraintPhrase(phrase)
    && !isFileLikeProtocolPhrase(phrase);
}

function protocolFacetsFor(input: ReviewProtocolInput): NonNullable<ResearchSourceGatherResult["selectionQuality"]>["requiredFacets"] {
  const gatheredFacets = input.gathered?.selectionQuality?.requiredFacets ?? [];

  if (gatheredFacets.length > 0) {
    return gatheredFacets.filter((facet) => isProtocolEvidencePhrase(facet.label));
  }

  return buildReviewFacets({
    brief: input.run.brief,
    plan: input.plan
  }).filter((facet) => facet.required && isProtocolEvidencePhrase(facet.label));
}

function manuscriptConstraintsFor(input: ReviewProtocolInput): string[] {
  const successSentences = splitSentences(input.run.brief.successCriterion);
  const constraints = successSentences.filter((sentence) => isRetrievalQualityConstraintPhrase(sentence));

  return uniqueStrings([
    ...constraints,
    "Do not present a full manuscript unless the selected evidence set is in scope and manuscript checks pass.",
    "Keep limitations and missing-evidence status visible when evidence is incomplete."
  ]);
}

function evidenceTargetsFor(input: ReviewProtocolInput, labels: string[]): string[] {
  return uniqueStrings([
    ...labels.filter(isProtocolEvidencePhrase),
    ...input.plan.localFocus.filter(isProtocolEvidencePhrase),
    ...splitSentences(input.run.brief.researchQuestion)
      .filter(isProtocolEvidencePhrase)
      .slice(0, 2)
  ]).slice(0, 16);
}

function structureRationaleFor(reviewType: ReviewType, input: ManuscriptBundleInput | ReviewProtocolInput): string {
  const question = input.run.brief.researchQuestion ?? input.plan.objective;
  const typeLabel = reviewTypeLabel(reviewType);

  return `The manuscript uses a ${typeLabel} structure because the scoped question asks for evidence-grounded synthesis rather than an original experiment. The sections are organized around scientific roles: framing the question, explaining the review method, appraising the evidence base, synthesizing findings, naming limitations, and deriving future work.`;
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
  const requiredFacets = protocolFacetsFor(input);
  const evidenceTargets = evidenceTargetsFor(input, requiredFacets.map((facet) => facet.label));
  const manuscriptConstraints = manuscriptConstraintsFor(input);
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
        input.run.brief.researchDirection ?? "",
        ...(input.run.brief.successCriterion === null
          ? []
          : splitSentences(input.run.brief.successCriterion).filter((sentence) => !isRetrievalQualityConstraintPhrase(sentence)))
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
    inclusionCriteria: [
      "Sources must match the scoped research question and the protocol evidence targets.",
      "Reviewed papers should expose at least abstract-level evidence; full text is preferred when available.",
      "Background sources may inform retrieval and framing but must not be cited as primary evidence unless explicitly reviewed."
    ],
    exclusionCriteria: [
      "Generic review noise without topic, task, or facet relevance is excluded from the reviewed set.",
      "Low-trust proof, revision, or repository spam is not promoted into the reviewed synthesis.",
      "Title-only or blocked records remain backlog evidence unless the workflow explicitly retains them as uncertain."
    ],
    evidenceTargets,
    manuscriptConstraints,
    requiredSuccessCriterionFacets: requiredFacets.map((facet) => ({
      id: facet.id,
      label: facet.label,
      kind: facet.kind,
      required: facet.required,
      terms: facet.terms,
      rationale: facet.rationale
    })),
    screeningStages: [
      "title screening",
      "abstract screening",
      "full-text or access-state screening",
      "reviewed-set selection for synthesis"
    ],
    qualityAppraisalCriteria: [
      "source trust and bibliographic quality",
      "fit to the research question and success criterion",
      "access state and extractable evidence",
      "coverage of required facets",
      "support for claims, limitations, and open problems"
    ],
    stoppingConditions: [
      "stop with a blocked manuscript if no canonical papers are retained",
      "stop with a blocked manuscript if no reviewed papers are retained for synthesis",
      "mark the manuscript as needing more evidence when required facets are missing or the reviewed set is too sparse",
      "mark the manuscript ready for revision only when citations, claims, method, limitations, and evidence coverage pass deterministic checks"
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
    "## Required Protocol Concepts",
    "",
    ...markdownList(
      protocol.requiredSuccessCriterionFacets.map((facet) => `${facet.label} (${facet.kind})`),
      "No required success-criterion facets were available yet."
    ),
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

function limitationsFor(input: ManuscriptBundleInput, protocolLimitations: string[]): string[] {
  const missingFacets = input.gathered.selectionQuality?.missingRequiredFacets
    .map((facet) => `The reviewed set does not yet cover the required facet "${facet.label}".`) ?? [];
  const selectionLimitations = input.gathered.selectionQuality?.adequacy !== undefined
    && input.gathered.selectionQuality.adequacy !== "strong"
    ? [`The reviewed-paper selection has ${input.gathered.selectionQuality.adequacy} adequacy for the scoped review question.`]
    : [];
  const verificationLimitations = [
    ...input.verification.unverifiedClaims.map((claim) => `Unverified claim: ${claim.claim}. ${claim.reason}`),
    ...input.verification.unknowns,
    ...input.verification.sourceRelevance
      .filter((source) => source.status === "off_topic")
      .map((source) => `Off-topic source: ${source.sourceId}. ${source.rationale}`)
  ];
  const evidenceLimitations = input.evidenceMatrix.rowCount < 3
    ? [`Only ${input.evidenceMatrix.rowCount} reviewed evidence rows were available, so cross-paper conclusions remain provisional.`]
    : [];

  return uniqueStrings([
    ...input.agenda.holdReasons,
    ...missingFacets,
    ...selectionLimitations,
    ...verificationLimitations,
    ...evidenceLimitations,
    ...protocolLimitations
  ]);
}

function claimIds(claims: ResearchClaim[]): string[] {
  return claims.map(claimRecordId);
}

function citationLinksFor(claims: Array<ResearchClaim & { claimId: string }>): PaperCitationLink[] {
  const bySourceId = new Map<string, Set<string>>();

  for (const claim of claims) {
    for (const sourceId of claim.sourceIds) {
      const entry = bySourceId.get(sourceId) ?? new Set<string>();
      entry.add(claim.claimId);
      bySourceId.set(sourceId, entry);
    }
  }

  return [...bySourceId.entries()].map(([sourceId, ids]) => ({
    sourceId,
    claimIds: [...ids],
    sectionIds: ["synthesis"]
  }));
}

function preliminaryReadiness(input: ManuscriptBundleInput): ManuscriptReadinessState {
  if (input.gathered.canonicalPapers.length === 0 || input.reviewedPapers.length === 0) {
    return "blocked";
  }

  if (
    input.evidenceMatrix.rowCount < 3
    || input.agenda.holdReasons.length > 0
    || input.verification.overallStatus === "insufficient_evidence"
    || input.verification.counts.offTopicSources > 0
    || (input.gathered.selectionQuality !== undefined
      && input.gathered.selectionQuality !== null
      && input.gathered.selectionQuality.adequacy !== "strong")
  ) {
    return "needs_more_evidence";
  }

  return "ready_for_revision";
}

function paperAbstract(input: ManuscriptBundleInput, readinessStatus: ManuscriptReadinessState): string {
  const topic = input.run.brief.topic ?? "the scoped research topic";
  const question = input.run.brief.researchQuestion ?? input.plan.objective;
  const statusClause = readinessStatus === "ready_for_revision"
    ? "The draft is ready for human scientific revision."
    : readinessStatus === "blocked"
      ? "The draft is blocked because the evidence base is not yet sufficient for a confident review."
      : "The draft remains provisional and needs more evidence before being treated as a mature review.";

  return compactText(
    `This review addresses ${question} in the context of ${topic}. ` +
    `The run screened ${input.gathered.reviewWorkflow.counts.titleScreened} records, retained ${input.gathered.canonicalPapers.length} canonical papers, and selected ${input.reviewedPapers.length} papers for synthesis. ` +
    `${input.synthesis.executiveSummary} ${statusClause}`
  );
}

function sectionMarkdown(values: string[], fallback: string): string {
  return markdownList(values, fallback).join("\n");
}

function buildPaperOutline(input: ManuscriptBundleInput, limitations: string[]): PaperOutline {
  const reviewType = reviewTypeFor(input.plan, input.run);
  const claims = input.synthesis.claims;

  return {
    schemaVersion: 1,
    runId: input.run.id,
    briefFingerprint: briefFingerprint(input.run.brief),
    title: titleFor(input.run, reviewType),
    reviewType,
    structureRationale: structureRationaleFor(reviewType, input),
    abstractClaims: claims.map((claim) => claim.claim),
    rhetoricalPlan: [
      {
        id: "abstract",
        role: "title_and_abstract",
        title: "Abstract",
        intent: "State the scope, evidence base, main contribution, and readiness state.",
        evidenceIds: [],
        claimIds: []
      },
      {
        id: "introduction",
        role: "motivation_and_question",
        title: "Introduction",
        intent: "Motivate the review and state the scoped research question.",
        evidenceIds: [],
        claimIds: []
      },
      {
        id: "method",
        role: "review_method",
        title: "Review Method",
        intent: "Describe search, screening, reviewed-set selection, and appraisal criteria.",
        evidenceIds: ["review-protocol", "sources", "literature-review"],
        claimIds: []
      },
      {
        id: "evidence-base",
        role: "evidence_appraisal",
        title: "Evidence Base",
        intent: "Characterize the included papers, access state, and evidence quality.",
        evidenceIds: input.reviewedPapers.map((paper) => paper.id),
        claimIds: []
      },
      {
        id: "synthesis",
        role: "synthesis",
        title: "Synthesis",
        intent: "Organize the main themes and source-grounded claims.",
        evidenceIds: input.reviewedPapers.map((paper) => paper.id),
        claimIds: claimIds(claims)
      },
      {
        id: "open-problems",
        role: "open_problems",
        title: "Open Problems And Research Agenda",
        intent: "Derive gaps, open questions, and next research directions from the reviewed evidence.",
        evidenceIds: ["agenda"],
        claimIds: []
      },
      {
        id: "limitations",
        role: "limitations",
        title: "Limitations",
        intent: "Disclose missing evidence, weak coverage, access limits, and threats to validity.",
        evidenceIds: ["verification", "selection-quality"],
        claimIds: []
      },
      {
        id: "conclusion",
        role: "conclusion",
        title: "Conclusion",
        intent: "State what the evidence supports and what remains open.",
        evidenceIds: [],
        claimIds: []
      },
      {
        id: "references",
        role: "references",
        title: "References",
        intent: "List cited canonical papers with stable IDs.",
        evidenceIds: input.reviewedPapers.map((paper) => paper.id),
        claimIds: []
      }
    ],
    keyThemes: input.synthesis.themes.map((theme) => theme.title),
    evidenceTablesToCite: ["evidence-matrix.json", "paper-extractions.json", "verification.json"],
    openQuestions: input.synthesis.nextQuestions,
    limitations,
    agendaImplications: [
      ...input.agenda.gaps.map((gap) => gap.title),
      ...input.agenda.candidateDirections.map((direction) => direction.title)
    ]
  };
}

function buildPaperArtifact(
  input: ManuscriptBundleInput,
  outline: PaperOutline,
  references: ReferencesArtifact,
  limitations: string[],
  readinessStatus: ManuscriptReadinessState
): ReviewPaperArtifact {
  const claims = input.synthesis.claims.map((claim) => ({
    ...claim,
    claimId: claimRecordId(claim)
  }));
  const referencedPaperIds = uniqueStrings([
    ...references.references.map((reference) => reference.sourceId),
    ...claims.flatMap((claim) => claim.sourceIds)
  ]);
  const methodLines = [
    `The review followed the run protocol in review-protocol.json for run ${input.run.id}.`,
    `Planned queries included: ${input.plan.searchQueries.join(" | ") || "no planned queries were recorded"}.`,
    `The workflow title-screened ${input.gathered.reviewWorkflow.counts.titleScreened} records, abstract-screened ${input.gathered.reviewWorkflow.counts.abstractScreened}, full-text-screened ${input.gathered.reviewWorkflow.counts.fulltextScreened}, and selected ${input.gathered.reviewWorkflow.counts.selectedForSynthesis} papers for synthesis.`
  ];
  const evidenceLines = input.reviewedPapers.map((paper) => `${paper.id}: ${paper.citation} Access: ${paper.accessMode}. Screening: ${paper.screeningDecision}.`);
  const themeLines = input.synthesis.themes.map((theme) => {
    const sources = theme.sourceIds.length > 0 ? ` Sources: ${theme.sourceIds.map((id) => `[${id}]`).join(", ")}.` : "";
    return `${theme.title}: ${theme.summary}${sources}`;
  });
  const claimLines = claims.map((claim) => {
    const sources = claim.sourceIds.length > 0 ? ` ${claim.sourceIds.map((id) => `[${id}]`).join(" ")}` : "";
    return `${claim.claim} ${claim.evidence}${sources}`;
  });
  const openProblemLines = [
    ...input.agenda.gaps.map((gap) => `${gap.title}: ${gap.summary}`),
    ...input.synthesis.nextQuestions
  ];
  const conclusion = readinessStatus === "ready_for_revision"
    ? "The reviewed evidence supports a coherent review draft that is ready for human scientific revision."
    : readinessStatus === "blocked"
      ? "The current evidence does not yet justify a confident review paper. The manuscript should remain a blocked local draft until retrieval or access improves."
      : "The current draft captures the available evidence but should remain provisional until the missing evidence and review-coverage limitations are resolved.";

  return {
    schemaVersion: 1,
    runId: input.run.id,
    briefFingerprint: briefFingerprint(input.run.brief),
    title: outline.title,
    abstract: paperAbstract(input, readinessStatus),
    reviewType: outline.reviewType,
    structureRationale: outline.structureRationale,
    scientificRoles: requiredScientificRoles,
    sections: [
      {
        id: "introduction",
        role: "motivation_and_question",
        title: "Introduction",
        markdown: [
          `This review addresses: ${input.run.brief.researchQuestion ?? input.plan.objective}.`,
          `Topic: ${input.run.brief.topic ?? "<missing>"}.`,
          `Direction: ${input.run.brief.researchDirection ?? input.plan.rationale}.`
        ].join("\n\n"),
        sourceIds: [],
        claimIds: []
      },
      {
        id: "method",
        role: "review_method",
        title: "Review Method",
        markdown: methodLines.join("\n\n"),
        sourceIds: [],
        claimIds: []
      },
      {
        id: "evidence-base",
        role: "evidence_appraisal",
        title: "Evidence Base",
        markdown: sectionMarkdown(evidenceLines, "No reviewed papers were selected for synthesis."),
        sourceIds: references.references.map((reference) => reference.sourceId),
        claimIds: []
      },
      {
        id: "synthesis",
        role: "synthesis",
        title: "Synthesis",
        markdown: [
          sectionMarkdown(themeLines, "No stable themes were synthesized."),
          "",
          sectionMarkdown(claimLines, "No source-grounded claims were synthesized.")
        ].join("\n"),
        sourceIds: referencedPaperIds,
        claimIds: claims.map((claim) => claim.claimId)
      },
      {
        id: "open-problems",
        role: "open_problems",
        title: "Open Problems And Research Agenda",
        markdown: sectionMarkdown(openProblemLines, "No stable open problems were derived from the current evidence."),
        sourceIds: input.agenda.gaps.flatMap((gap) => gap.sourceIds),
        claimIds: input.agenda.gaps.flatMap((gap) => gap.claimIds)
      },
      {
        id: "limitations",
        role: "limitations",
        title: "Limitations",
        markdown: sectionMarkdown(limitations, "No specific limitations were recorded."),
        sourceIds: [],
        claimIds: []
      },
      {
        id: "conclusion",
        role: "conclusion",
        title: "Conclusion",
        markdown: conclusion,
        sourceIds: [],
        claimIds: []
      }
    ],
    claims,
    citationLinks: citationLinksFor(claims),
    referencedPaperIds,
    evidenceTableIds: outline.evidenceTablesToCite,
    limitations,
    readinessStatus
  };
}

function renderPaperMarkdown(paper: ReviewPaperArtifact, references: ReferencesArtifact): string {
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

function buildStatusOnlyPaperArtifact(
  input: ManuscriptBundleInput,
  outline: PaperOutline,
  readinessStatus: ManuscriptReadinessState,
  limitations: string[],
  blockers: string[]
): ReviewPaperArtifact {
  const title = `${outline.title} - evidence status`;
  const statusLines = [
    `Readiness: ${readinessStatus}.`,
    `Canonical papers retained: ${input.gathered.canonicalPapers.length}.`,
    `In-scope papers selected for synthesis: ${input.reviewedPapers.length}.`,
    `Evidence matrix rows: ${input.evidenceMatrix.rowCount}.`,
    `Verification: ${input.verification.summary}`
  ];

  return {
    schemaVersion: 1,
    runId: input.run.id,
    briefFingerprint: briefFingerprint(input.run.brief),
    title,
    abstract: "No full review manuscript was released because the evidence set did not pass the protocol readiness gate.",
    reviewType: outline.reviewType,
    structureRationale: "This artifact is a status report, not a manuscript. ClawResearch withholds full paper drafting until the selected evidence set passes relevance, coverage, extraction, synthesis, references, and checks.",
    scientificRoles: ["status_report"],
    sections: [
      {
        id: "evidence-status",
        role: "status_report",
        title: "Evidence Status",
        markdown: sectionMarkdown(statusLines, "No evidence status was recorded."),
        sourceIds: [],
        claimIds: []
      },
      {
        id: "blockers",
        role: "status_report",
        title: "Blockers",
        markdown: sectionMarkdown(blockers, "No blockers were recorded."),
        sourceIds: [],
        claimIds: []
      },
      {
        id: "next-steps",
        role: "status_report",
        title: "Next Evidence Work",
        markdown: sectionMarkdown(input.synthesis.nextQuestions, "No next evidence questions were recorded."),
        sourceIds: [],
        claimIds: []
      }
    ],
    claims: [],
    citationLinks: [],
    referencedPaperIds: [],
    evidenceTableIds: [],
    limitations,
    readinessStatus
  };
}

function renderStatusOnlyPaperMarkdown(paper: ReviewPaperArtifact): string {
  return [
    `# ${paper.title}`,
    "",
    "## Status",
    "",
    paper.abstract,
    "",
    paper.structureRationale,
    "",
    ...paper.sections.flatMap((section) => [
      `## ${section.title}`,
      "",
      section.markdown,
      ""
    ])
  ].join("\n");
}

function verifiedClaimById(verification: VerificationReport): Map<string, VerifiedClaim> {
  return new Map(verification.verifiedClaims.map((claim) => [claim.claimId, claim]));
}

function check(
  id: string,
  title: string,
  passed: boolean,
  message: string,
  severity: "warning" | "blocker" = "blocker"
): ManuscriptCheck {
  return {
    id,
    title,
    status: passed ? "pass" : severity === "warning" ? "warning" : "fail",
    severity: passed ? "info" : severity,
    message
  };
}

function runManuscriptChecks(
  input: ManuscriptBundleInput,
  paper: ReviewPaperArtifact,
  references: ReferencesArtifact
): ManuscriptCheck[] {
  const referenceIds = new Set(references.references.map((reference) => reference.sourceId));
  const reviewedIds = new Set(input.reviewedPapers.map((paperRecord) => paperRecord.id));
  const verifiedById = verifiedClaimById(input.verification);
  const missingReferences = paper.referencedPaperIds.filter((sourceId) => !referenceIds.has(sourceId));
  const unreviewedReferences = paper.referencedPaperIds.filter((sourceId) => !reviewedIds.has(sourceId));
  const uncitedClaims = paper.claims.filter((claim) => claim.sourceIds.length === 0);
  const unsupportedClaims = paper.claims.filter((claim) => {
    const verified = verifiedById.get(claim.claimId);
    return verified?.supportStatus === "unverified";
  });
  const unknownClaims = paper.claims.filter((claim) => {
    const verified = verifiedById.get(claim.claimId);
    return verified?.supportStatus === "unknown";
  });
  const missingFacetLabels = input.gathered.selectionQuality?.missingRequiredFacets.map((facet) => facet.label) ?? [];
  const limitationText = paper.limitations.join(" ").toLowerCase();
  const unacknowledgedFacets = missingFacetLabels.filter((label) => !limitationText.includes(label.toLowerCase()));
  const roles = new Set(paper.scientificRoles);
  const missingRoles = requiredScientificRoles.filter((role) => !roles.has(role));
  const offTopicSourceIds = new Set(input.verification.sourceRelevance
    .filter((source) => source.status === "off_topic")
    .map((source) => source.sourceId));
  const offTopicReferencedPaperIds = paper.referencedPaperIds.filter((sourceId) => offTopicSourceIds.has(sourceId));
  const relevanceAssessments = input.gathered.relevanceAssessments ?? [];
  const selectedRelevance = relevanceAssessments.filter((assessment) => reviewedIds.has(assessment.paperId));
  const notInScopeSelected = selectedRelevance.filter((assessment) => assessment.status !== "in_scope");
  const selectionQualityReady = input.gathered.selectionQuality === null
    || input.gathered.selectionQuality === undefined
    || input.gathered.selectionQuality.adequacy === "strong";
  const agendaReady = input.agenda.holdReasons.length === 0;
  const evidenceRowsReady = input.evidenceMatrix.rowCount >= 3;
  const verificationReady = input.verification.overallStatus !== "insufficient_evidence"
    && input.verification.counts.offTopicSources === 0;

  return [
    check(
      "evidence-targets-covered",
      "Protocol evidence targets are covered",
      selectionQualityReady,
      selectionQualityReady
        ? "The selected set covers the protocol evidence targets."
        : `Missing or partial evidence targets: ${missingFacetLabels.join(", ") || "selection quality remained partial"}.`
    ),
    check(
      "selected-papers-in-scope",
      "Selected papers passed the protocol relevance gate",
      notInScopeSelected.length === 0,
      notInScopeSelected.length === 0
        ? "Every selected paper was marked in scope by the hybrid relevance gate."
        : `Selected papers failed the relevance gate: ${notInScopeSelected.map((assessment) => `${assessment.paperId} (${assessment.status})`).join(", ")}.`
    ),
    check(
      "evidence-matrix-ready",
      "Evidence matrix has enough reviewed rows",
      evidenceRowsReady,
      evidenceRowsReady
        ? "The evidence matrix has enough reviewed rows for synthesis."
        : `Only ${input.evidenceMatrix.rowCount} reviewed evidence rows were available.`
    ),
    check(
      "agenda-has-no-evidence-holds",
      "Agenda has no unresolved evidence holds",
      agendaReady,
      agendaReady
        ? "The agenda did not report retrieval or evidence holds."
        : `Agenda hold reasons: ${input.agenda.holdReasons.join(" | ")}.`
    ),
    check(
      "verification-ready",
      "Verification passed with in-scope sources",
      verificationReady,
      verificationReady
        ? "Verification did not report insufficient evidence or off-topic sources."
        : input.verification.summary
    ),
    check(
      "citation-ids-exist",
      "All cited source IDs exist in references",
      missingReferences.length === 0,
      missingReferences.length === 0
        ? "Every cited paper ID is present in references.json."
        : `Missing reference records for: ${missingReferences.join(", ")}.`
    ),
    check(
      "claims-cite-evidence",
      "All paper claims cite evidence",
      uncitedClaims.length === 0,
      uncitedClaims.length === 0
        ? "Every structured paper claim has at least one source ID."
        : `Claims without source IDs: ${uncitedClaims.map((claim) => claim.claim).join(" | ")}.`
    ),
    check(
      "no-excluded-citations",
      "No citation points outside the reviewed set",
      unreviewedReferences.length === 0,
      unreviewedReferences.length === 0
        ? "All referenced papers are in the reviewed synthesis set."
        : `Referenced papers outside the reviewed set: ${unreviewedReferences.join(", ")}.`,
      "warning"
    ),
    check(
      "cited-sources-topic-relevant",
      "Cited sources match the scoped topic",
      offTopicReferencedPaperIds.length === 0,
      offTopicReferencedPaperIds.length === 0
        ? "All referenced papers matched the scoped topic relevance gate."
        : `Referenced papers outside the scoped topic: ${offTopicReferencedPaperIds.join(", ")}.`,
      "warning"
    ),
    check(
      "unsupported-claims-not-established",
      "Unsupported claims are not presented as established",
      unsupportedClaims.length === 0,
      unsupportedClaims.length === 0
        ? "No unverified structured claims are presented in the paper artifact."
        : `Unverified claims need revision or explicit uncertainty: ${unsupportedClaims.map((claim) => claim.claim).join(" | ")}.`
    ),
    check(
      "unknown-claims-flagged",
      "Explicit unknowns remain visible",
      unknownClaims.length === 0 || paper.limitations.length > 0,
      unknownClaims.length === 0
        ? "No explicit unknown claims were present."
        : "Explicit unknowns are present and the limitations section is populated.",
      "warning"
    ),
    check(
      "missing-facets-acknowledged",
      "Missing required facets are acknowledged",
      unacknowledgedFacets.length === 0,
      unacknowledgedFacets.length === 0
        ? "Missing required facets are either absent or acknowledged in limitations."
        : `Missing required facets not acknowledged: ${unacknowledgedFacets.join(", ")}.`
    ),
    check(
      "limitations-present",
      "Limitations are present",
      paper.limitations.length > 0,
      paper.limitations.length > 0
        ? "The paper artifact includes explicit limitations."
        : "The paper artifact does not include explicit limitations."
    ),
    check(
      "method-described",
      "Review method is described",
      paper.sections.some((section) => section.role === "review_method" && section.markdown.trim().length > 0),
      "The paper includes a review-method section tied to the protocol."
    ),
    check(
      "references-complete",
      "References cover cited papers",
      references.referenceCount === referenceIds.size && missingReferences.length === 0,
      "references.json covers the cited canonical paper IDs."
    ),
    check(
      "scientific-roles-present",
      "Required scientific roles are present in the chosen structure",
      missingRoles.length === 0,
      missingRoles.length === 0
        ? "The paper artifact declares the required scientific roles for reviewability."
        : `Missing scientific roles: ${missingRoles.join(", ")}.`
    )
  ];
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
  if (report.stage === "release" && report.readiness !== "pass") {
    return "blocker";
  }

  return objectionSeverity === "blocking" && report.stage === "release" ? "blocker" : "warning";
}

function criticReportsToChecks(reports: CriticReviewArtifact[]): ManuscriptCheck[] {
  return reports.flatMap((report) => {
    if (report.objections.length === 0) {
      const severity = report.stage === "release" && report.readiness !== "pass"
        ? "blocker" as const
        : "warning" as const;
      return report.readiness === "pass"
        ? []
        : [{
          id: `critic-${report.stage}`,
          title: `${report.stage.replace(/_/g, " ")} critic passed release gate`,
          status: severity === "blocker" ? "fail" as const : "warning" as const,
          severity,
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
  if (reports.some((report) => report.stage === "release" && report.readiness !== "pass")) {
    return current === "ready_for_revision" ? "needs_human_review" : current;
  }

  return current;
}

export function applyCriticReportsToManuscriptBundle(
  input: ManuscriptBundleInput,
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
    : buildStatusOnlyPaperArtifact(
      input,
      bundle.outline,
      readinessStatus,
      bundle.paper.limitations,
      blockers
    );

  return {
    ...bundle,
    paper,
    paperMarkdown: manuscriptReady
      ? renderPaperMarkdown(paper, bundle.references)
      : renderStatusOnlyPaperMarkdown(paper),
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

export function buildManuscriptBundle(input: ManuscriptBundleInput): ManuscriptBundle {
  const protocol = buildReviewProtocol(input);
  const protocolMarkdown = reviewProtocolMarkdown(protocol);
  const limitations = limitationsFor(input, protocol.protocolLimitations);
  const preliminaryStatus = preliminaryReadiness(input);
  const references = buildReferencesArtifact(input.run, input.reviewedPapers);
  const outline = buildPaperOutline(input, limitations);
  const initialPaper = buildPaperArtifact(input, outline, references, limitations, preliminaryStatus);
  const checks = runManuscriptChecks(input, initialPaper, references);
  const readinessStatus = readinessAfterChecks(preliminaryStatus, checks);
  const blockerCount = checks.filter((item) => item.severity === "blocker" && item.status === "fail").length;
  const warningCount = checks.filter((item) => item.status === "warning").length;
  const blockers = checks
    .filter((item) => item.severity === "blocker" && item.status === "fail")
    .map((item) => item.message);
  const manuscriptReady = readinessStatus === "ready_for_revision" && blockerCount === 0;
  const paper = manuscriptReady
    ? readinessStatus === initialPaper.readinessStatus
      ? initialPaper
      : { ...initialPaper, readinessStatus }
    : buildStatusOnlyPaperArtifact(input, outline, readinessStatus, limitations, blockers);
  const paperMarkdown = manuscriptReady
    ? renderPaperMarkdown(paper, references)
    : renderStatusOnlyPaperMarkdown(paper);

  return {
    protocol,
    protocolMarkdown,
    outline,
    paper,
    paperMarkdown,
    references,
    checks: {
      schemaVersion: 1,
      runId: input.run.id,
      paperPath: input.run.artifacts.paperPath,
      readinessStatus,
      blockerCount,
      warningCount,
      checks,
      blockers
    }
  };
}
