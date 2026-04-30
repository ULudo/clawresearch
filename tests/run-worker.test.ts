import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createLiteratureEntityId,
  type CanonicalPaper
} from "../src/runtime/literature-store.js";
import type {
  PaperExtractionRequest,
  ResearchAgenda,
  ResearchBackend,
  ResearchPlanningRequest,
  ResearchPlan,
  ResearchAgendaRequest,
  ResearchBackendCallOptions
} from "../src/runtime/research-backend.js";
import { ResearchBackendError } from "../src/runtime/research-backend.js";
import type {
  ResearchActionDecision,
  ResearchActionRequest
} from "../src/runtime/research-agent.js";
import type { CriticReviewArtifact, CriticReviewRequest } from "../src/runtime/research-critic.js";
import type {
  EvidenceMatrix,
  PaperExtraction
} from "../src/runtime/research-evidence.js";
import type {
  ResearchSourceGatherRequest,
  ResearchSourceGatherResult,
  ResearchSourceGatherer
} from "../src/runtime/research-sources.js";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import { researchDirectionPath, runDirectoryPath, runFilePath, RunStore } from "../src/runtime/run-store.js";
import { runDetachedJobWorker } from "../src/runtime/run-worker.js";
import { researchWorkerStatePath } from "../src/runtime/research-state.js";
import {
  createResearchWorkStore,
  researchWorkStoreFilePath,
  upsertResearchWorkStoreEntities,
  writeResearchWorkStore
} from "../src/runtime/research-work-store.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

function canonicalPaper(overrides: Partial<CanonicalPaper> = {}): CanonicalPaper {
  return {
    id: "paper-1",
    key: "doi:10.1000/rh-survey",
    title: "A survey of proof strategies for the Riemann Hypothesis",
    citation: "Example Author (2024). A survey of proof strategies for the Riemann Hypothesis.",
    abstract: "Survey-style source describing analytic approaches, common obstacles, and recurring proof motifs.",
    year: 2024,
    authors: ["Example Author"],
    venue: "Number Theory Review",
    discoveredVia: ["openalex"],
    identifiers: {
      doi: "10.1000/rh-survey",
      pmid: null,
      pmcid: null,
      arxivId: null
    },
    discoveryRecords: [],
    accessCandidates: [],
    bestAccessUrl: "https://example.org/rh-survey.pdf",
    bestAccessProvider: "openalex" as const,
    accessMode: "fulltext_open" as const,
    fulltextFormat: "pdf" as const,
    license: null,
    tdmAllowed: true,
    contentStatus: {
      abstractAvailable: true,
      fulltextAvailable: true,
      fulltextFetched: false,
      fulltextExtracted: false
    },
    screeningHistory: [{
      stage: "title",
      decision: "uncertain",
      rationale: "Retained after title screening for deeper review."
    }, {
      stage: "abstract",
      decision: "include",
      rationale: "Abstract-level screening supported deeper review."
    }, {
      stage: "fulltext",
      decision: "include",
      rationale: "Directly relevant survey."
    }],
    screeningStage: "fulltext" as const,
    screeningDecision: "include" as const,
    screeningRationale: "Directly relevant survey.",
    accessErrors: [],
    tags: [],
    runIds: [],
    linkedThemeIds: [],
    linkedClaimIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function canonicalPaperId(paper: CanonicalPaper): string {
  return createLiteratureEntityId("paper", paper.key);
}

function paperExtraction(overrides: Partial<PaperExtraction> = {}): PaperExtraction {
  return {
    id: "extraction-1",
    paperId: "paper-1",
    runId: "run-1",
    problemSetting: "Compare proof-technique families for the Riemann Hypothesis.",
    systemType: "literature review",
    architecture: "survey comparison",
    toolsAndMemory: "canonical paper set plus bounded notes",
    planningStyle: "comparative synthesis",
    evaluationSetup: "Compare technique families against explicit limitations.",
    successSignals: ["clear bounded comparison"],
    failureModes: ["weak evaluation comparability"],
    limitations: ["single reviewed survey paper"],
    supportedClaims: [{
      claim: "Analytic number theory remains central.",
      support: "explicit"
    }],
    confidence: "high",
    evidenceNotes: ["Grounded in the reviewed survey paper abstract and metadata."],
    ...overrides
  };
}

function reviewWorkflowFor(papers: CanonicalPaper[], reviewedPaperIds?: string[]) {
  const reviewedIds = reviewedPaperIds ?? papers
    .filter((paper) => paper.screeningDecision === "include")
    .map((paper) => paper.id);
  const blockedIds = papers
    .filter((paper) => paper.accessMode === "needs_credentials" || paper.accessMode === "fulltext_blocked")
    .map((paper) => paper.id);
  const excludedIds = papers
    .filter((paper) => paper.screeningDecision === "exclude" || paper.screeningDecision === "background")
    .map((paper) => paper.id);
  const uncertainIds = papers
    .filter((paper) => paper.screeningDecision === "uncertain")
    .map((paper) => paper.id);
  const abstractIds = papers
    .filter((paper) => paper.screeningStage === "abstract" || paper.screeningStage === "fulltext")
    .map((paper) => paper.id);
  const fulltextIds = papers
    .filter((paper) => paper.screeningStage === "fulltext")
    .map((paper) => paper.id);

  return {
    titleScreenedPaperIds: papers.map((paper) => paper.id),
    abstractScreenedPaperIds: abstractIds,
    fulltextScreenedPaperIds: fulltextIds,
    includedPaperIds: papers.filter((paper) => paper.screeningDecision === "include").map((paper) => paper.id),
    excludedPaperIds: excludedIds,
    uncertainPaperIds: uncertainIds,
    blockedPaperIds: blockedIds,
    synthesisPaperIds: reviewedIds,
    deferredPaperIds: [],
    counts: {
      titleScreened: papers.length,
      abstractScreened: abstractIds.length,
      fulltextScreened: fulltextIds.length,
      included: papers.filter((paper) => paper.screeningDecision === "include").length,
      excluded: excludedIds.length,
      uncertain: uncertainIds.length,
      blocked: blockedIds.length,
      selectedForSynthesis: reviewedIds.length,
      deferred: 0
    },
    notes: []
  };
}

function selectionQualityFor(
  papers: CanonicalPaper[],
  options: {
    adequacy: "thin" | "partial" | "strong";
    facetLabel: string;
    missing?: boolean;
  }
) {
  const facet = {
    id: `facet-${options.facetLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    label: options.facetLabel,
    kind: "method" as const,
    required: true,
    terms: [options.facetLabel],
    source: "success_criterion" as const,
    rationale: "Extracted from the test success criterion."
  };
  const selectedIds = papers.map((paper) => paper.id);

  return {
    schemaVersion: 1 as const,
    requiredFacets: [facet],
    optionalFacets: [],
    paperFacetCoverage: papers.map((paper) => ({
      paperId: paper.id,
      coveredFacetIds: options.missing ? [] : [facet.id],
      missingRequiredFacetIds: options.missing ? [facet.id] : [],
      coverageScore: options.missing ? 0 : 4,
      matchedTerms: options.missing ? [] : [options.facetLabel],
      rationale: options.missing ? "The facet is not visible in this pass." : "The facet is covered by the selected paper."
    })),
    selectedSetCoverage: [{
      facetId: facet.id,
      label: facet.label,
      required: true,
      coveredByPaperIds: options.missing ? [] : selectedIds,
      count: options.missing ? 0 : selectedIds.length
    }],
    missingRequiredFacets: options.missing ? [facet] : [],
    backgroundOnlyFacets: [],
    adequacy: options.adequacy,
    selectionRationale: options.missing
      ? [`Missing required facets in the selected reviewed set: ${options.facetLabel}.`]
      : [`Selected set covers the ${options.facetLabel} facet.`]
  };
}

function workspaceManuscriptDecisionForRequest(
  request: ResearchActionRequest,
  rationale = "Proceed with the next claim/evidence/section workspace action."
): ResearchActionDecision | null {
  if (request.phase !== "synthesis") {
    return null;
  }

  const sourceId = request.workStore?.recentSources[0]?.id ?? "paper-1";
  const claim = request.workStore?.recentClaims[0];
  const section = request.workStore?.recentSections[0];
  const baseInputs = {
    providerIds: [],
    searchQueries: [],
    evidenceTargets: [],
    paperIds: sourceId === "paper-1" ? [] : [sourceId],
    criticStage: null,
    reason: null
  };

  if (claim === undefined) {
    return {
      schemaVersion: 1,
      action: "claim.create",
      rationale,
      confidence: 0.9,
      inputs: {
        ...baseInputs,
        paperIds: [sourceId],
        workStore: {
          collection: "claims",
          entityId: null,
          filters: {},
          semanticQuery: null,
          limit: null,
          changes: {},
          entity: {
            text: "Reviewed sources identify recurring methods, evaluation patterns, and limitations relevant to the research objective.",
            evidence: "The claim is grounded in the selected reviewed source set and extraction fields.",
            sourceIds: [sourceId],
            confidence: "medium"
          }
        }
      },
      expectedOutcome: "Create a checked synthesis claim in the work store.",
      stopCondition: "The claim object is persisted.",
      transport: "strict_json"
    };
  }

  if (section === undefined) {
    return {
      schemaVersion: 1,
      action: "manuscript.add_paragraph",
      rationale,
      confidence: 0.88,
      inputs: {
        ...baseInputs,
        paperIds: claim.sourceIds,
        workStore: {
          collection: "manuscriptSections",
          entityId: null,
          filters: {},
          semanticQuery: null,
          limit: null,
          changes: {},
          entity: {
            sectionId: "synthesis",
            role: "synthesis",
            title: "Synthesis",
            paragraph: "The reviewed evidence supports a cautious synthesis around recurring methods, evaluation practices, and limitations. The claim ledger links this paragraph to the selected source set.",
            claimIds: [claim.id],
            sourceIds: claim.sourceIds
          }
        }
      },
      expectedOutcome: "Create a manuscript section from the claim ledger.",
      stopCondition: "The section object is persisted.",
      transport: "strict_json"
    };
  }

  if (section.status !== "checked") {
    return {
      schemaVersion: 1,
      action: "manuscript.check_section_claims",
      rationale,
      confidence: 0.86,
      inputs: {
        ...baseInputs,
        workStore: {
          collection: "manuscriptSections",
          entityId: section.id,
          filters: {},
          semanticQuery: null,
          limit: null,
          changes: {},
          entity: {}
        }
      },
      expectedOutcome: "Check section claims against the claim ledger.",
      stopCondition: "The section check status is persisted.",
      transport: "strict_json"
    };
  }

  return {
    schemaVersion: 1,
    action: "manuscript.release",
    rationale,
    confidence: 0.84,
    inputs: {
      ...baseInputs,
      workStore: {
        collection: null,
        entityId: null,
        filters: {},
        semanticQuery: null,
        limit: null,
        changes: {},
        entity: {}
      }
    },
    expectedOutcome: "Release checks can evaluate the workspace manuscript.",
    stopCondition: "Stop after release checks are derived from the work store.",
    transport: "strict_json"
  };
}

class StubResearchBackend implements ResearchBackend {
  readonly label = "stub:research";
  capturedExtractionPaperIds: string[] = [];
  readonly actionRequests: ResearchActionRequest[] = [];

  async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Map the main proof-technique families and their limitations.",
      rationale: "A first-pass literature synthesis is the most credible bounded mode for this brief.",
      searchQueries: [
        "Riemann Hypothesis proof techniques",
        "Riemann zeta function proof strategy survey"
      ],
      localFocus: [
        "proof techniques",
        "limitations"
      ]
    };
  }

  async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    this.actionRequests.push(request);
    const workspaceDecision = workspaceManuscriptDecisionForRequest(request);
    if (workspaceDecision !== null) {
      return workspaceDecision;
    }

    return {
      schemaVersion: 1,
      action: request.allowedActions[0] ?? "manuscript.status",
      rationale: "Proceed with the next structured research action.",
      confidence: 0.9,
      inputs: {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticStage: null,
        reason: null
      },
      expectedOutcome: "Continue the run.",
      stopCondition: "The next artifact is checkpointed.",
      transport: "strict_json"
    };
  }

  async extractReviewedPapers(request: PaperExtractionRequest): Promise<PaperExtraction[]> {
    this.capturedExtractionPaperIds = request.papers.map((paper) => paper.id);
    return request.papers.map((paper, index) => paperExtraction({
      id: `extraction-${index + 1}`,
      paperId: paper.id,
      runId: request.runId
    }));
  }

  async developResearchAgenda(request: ResearchAgendaRequest): Promise<ResearchAgenda> {
    const sourceIds = request.evidenceMatrix.rows.map((row) => row.paperId);

    return {
      executiveSummary: "A bounded next step is available from the reviewed literature.",
      gaps: [
        {
          id: "gap-1",
          title: "Method comparison remains shallow",
          summary: "The current literature still needs clearer bounded comparisons across technique families.",
          sourceIds,
          claimIds: [],
          severity: "medium",
          gapKind: "method_gap"
        }
      ],
      candidateDirections: [
        {
          id: "direction-1",
          title: "Benchmark bounded proof-technique families",
          summary: "Turn the reviewed literature into a more explicit bounded comparison of technique families.",
          mode: "benchmarking",
          whyNow: "The evidence base is grounded enough for a small comparative internal revision step.",
          sourceIds,
          claimIds: [],
          gapIds: ["gap-1"],
          scores: {
            evidenceBase: 4,
            novelty: 2,
            tractability: 4,
            expectedCost: 2,
            risk: 2,
            overall: 4
          }
        }
      ],
      selectedDirectionId: "direction-1",
      selectedWorkPackage: null,
      holdReasons: [],
      recommendedHumanDecision: "Continue the autonomous worker toward release readiness."
    };
  }

  async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "pass",
      confidence: 0.9,
      objections: [],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

class AgenticSourceBackend extends StubResearchBackend {
  readonly sourceActions: ResearchActionDecision[] = [];
  readonly sourceActionRequests: ResearchActionRequest[] = [];

  async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Review autonomous research-agent harness architectures and evaluation practices.",
      rationale: "The model should choose which source provider to query first.",
      searchQueries: [
        "autonomous research agent harness architecture evaluation"
      ],
      localFocus: [
        "planning",
        "tool use",
        "verification",
        "reproducibility"
      ]
    };
  }

  async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase === "source_selection") {
      this.sourceActionRequests.push(request);
      const sourceState = request.sourceState;
      const baseInputs = {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticStage: null,
        reason: null
      };
      let action: ResearchActionDecision;

      if (sourceState?.attemptedProviderIds.includes("arxiv") !== true) {
        action = {
          schemaVersion: 1,
          action: "source.search",
          rationale: "arXiv should be queried first because the topic is CS/AI and full text is likely available.",
          confidence: 0.91,
          inputs: {
            providerIds: ["arxiv"],
            searchQueries: ["autonomous research agent harness architecture evaluation"],
            evidenceTargets: ["architecture", "evaluation", "tool use"],
            paperIds: [],
            criticStage: null,
            reason: null
          },
          expectedOutcome: "Retrieve full-text-accessible candidate literature from arXiv.",
          stopCondition: "Stop this action after the arXiv result is screened.",
          transport: "strict_json"
        };
      } else if (sourceState.sourceStage === "querying") {
        action = {
          schemaVersion: 1,
          action: "source.merge",
          rationale: "The retrieved hits should be merged into canonical papers before ranking.",
          confidence: 0.88,
          inputs: baseInputs,
          expectedOutcome: "Canonical papers are available in source state.",
          stopCondition: "Stop when canonical merge completes.",
          transport: "strict_json"
        };
      } else if (sourceState.sourceStage === "merged") {
        action = {
          schemaVersion: 1,
          action: "source.rank",
          rationale: "The canonical papers should be ranked against the review protocol before access resolution.",
          confidence: 0.87,
          inputs: baseInputs,
          expectedOutcome: "Candidate paper ids are available for access resolution.",
          stopCondition: "Stop when candidate ranking is checkpointed.",
          transport: "strict_json"
        };
      } else if (sourceState.sourceStage === "ranked") {
        action = {
          schemaVersion: 1,
          action: "source.resolve_access",
          rationale: "Resolve access only for the currently ranked candidate papers.",
          confidence: 0.85,
          inputs: {
            ...baseInputs,
            paperIds: sourceState.candidatePaperIds
          },
          expectedOutcome: "Candidate paper access metadata is resolved.",
          stopCondition: "Stop after targeted access resolution.",
          transport: "strict_json"
        };
      } else {
        action = {
          schemaVersion: 1,
          action: "source.select_evidence",
          rationale: "Ranked and access-resolved candidates are ready for the synthesis evidence set.",
          confidence: 0.86,
          inputs: baseInputs,
          expectedOutcome: "Select the current evidence set.",
          stopCondition: "Stop after the evidence set has been checkpointed.",
          transport: "strict_json"
        };
      }

      this.sourceActions.push(action);
      return action;
    }

    return super.chooseResearchAction(request);
  }
}

class WorkStoreFirstSourceBackend extends AgenticSourceBackend {
  private createdWorkItem = false;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase === "source_selection" && !this.createdWorkItem) {
      this.createdWorkItem = true;
      this.sourceActionRequests.push(request);
      const action: ResearchActionDecision = {
        schemaVersion: 1,
        action: "work_store.create",
        rationale: "Record a durable source-screening work item before querying the provider.",
        confidence: 0.83,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticStage: null,
          reason: null,
          workStore: {
            collection: "workItems",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            changes: {},
            entity: {
              kind: "workItem",
              title: "Inspect full-text-accessible autonomous research agent sources",
              description: "Use the work store as durable state before source querying.",
              suggestedActions: ["source.search arxiv autonomous research agent harness"]
            }
          }
        },
        expectedOutcome: "A source-screening work item is persisted.",
        stopCondition: "Stop after the work item is created.",
        transport: "strict_json"
      };
      this.sourceActions.push(action);
      return action;
    }

    return super.chooseResearchAction(request);
  }
}

class StubbornSourceSearchBackend extends StubResearchBackend {
  readonly sourceActions: ResearchActionDecision[] = [];

  async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Review autonomous research-agent harness architectures and evaluation practices.",
      rationale: "The model starts with a repeated source-search strategy that the runtime should help it reconsider.",
      searchQueries: [
        "autonomous research agent harness architecture evaluation"
      ],
      localFocus: [
        "planning",
        "tool use",
        "verification"
      ]
    };
  }

  async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "source_selection") {
      return super.chooseResearchAction(request);
    }

    const sourceState = request.sourceState;
    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticStage: null,
      reason: null
    };
    let action: ResearchActionDecision;

    if (sourceState?.sourceStage === "merged") {
      action = {
        schemaVersion: 1,
        action: "rank_sources",
        rationale: "Canonical sources can now be ranked.",
        confidence: 0.82,
        inputs: baseInputs,
        expectedOutcome: "Candidate source ranking.",
        stopCondition: "Stop after ranking.",
        transport: "strict_json"
      };
    } else if (sourceState?.sourceStage === "ranked") {
      action = {
        schemaVersion: 1,
        action: "select_evidence_set",
        rationale: "Ranked sources are ready for the evidence pass.",
        confidence: 0.82,
        inputs: baseInputs,
        expectedOutcome: "Selected evidence set.",
        stopCondition: "Stop after selection.",
        transport: "strict_json"
      };
    } else if (request.retryInstruction?.includes("exhausted") === true || request.retryInstruction?.includes("screened sources are enough") === true) {
      action = {
        schemaVersion: 1,
        action: "merge_sources",
        rationale: "The source dashboard shows this repeated provider/query search is low-yield, so merge the screened sources.",
        confidence: 0.84,
        inputs: baseInputs,
        expectedOutcome: "Canonical papers are available.",
        stopCondition: "Stop when canonical merge completes.",
        transport: "strict_json"
      };
    } else {
      action = {
        schemaVersion: 1,
        action: "search_sources",
        rationale: "Repeat the same arXiv query.",
        confidence: 0.74,
        inputs: {
          providerIds: ["arxiv"],
          searchQueries: ["autonomous research agent harness architecture evaluation"],
          evidenceTargets: ["architecture", "evaluation"],
          paperIds: [],
          criticStage: null,
          reason: null
        },
        expectedOutcome: "Retrieve additional arXiv candidates.",
        stopCondition: "Stop after the search.",
        transport: "strict_json"
      };
    }

    this.sourceActions.push(action);
    return action;
  }
}

class DashboardIgnoringSourceSearchBackend extends StubResearchBackend {
  readonly sourceActions: ResearchActionDecision[] = [];

  async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Review autonomous research-agent harness architectures and evaluation practices.",
      rationale: "The model ignores source-dashboard guidance, so the runtime fallback should still converge.",
      searchQueries: [
        "autonomous research agent harness architecture evaluation"
      ],
      localFocus: [
        "planning",
        "tool use",
        "verification"
      ]
    };
  }

  async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "source_selection") {
      return super.chooseResearchAction(request);
    }

    const action: ResearchActionDecision = {
      schemaVersion: 1,
      action: "search_sources",
      rationale: "Keep searching the same provider even after dashboard warnings.",
      confidence: 0.65,
      inputs: {
        providerIds: ["arxiv"],
        searchQueries: ["autonomous research agent harness architecture evaluation"],
        evidenceTargets: ["architecture", "evaluation"],
        paperIds: [],
        criticStage: null,
        reason: null
      },
      expectedOutcome: "Retrieve more arXiv candidates.",
      stopCondition: "Stop after the search.",
      transport: "strict_json"
    };
    this.sourceActions.push(action);
    return action;
  }
}

class StubSourceGatherer implements ResearchSourceGatherer {
  async gather(): Promise<ResearchSourceGatherResult> {
    const papers = [
      canonicalPaper()
    ];
    const selectionQuality = {
      schemaVersion: 1 as const,
      requiredFacets: [{
        id: "facet-proof-techniques",
        label: "proof techniques",
        kind: "method" as const,
        required: true,
        terms: ["proof techniques"],
        source: "success_criterion" as const,
        rationale: "Extracted from the test success criterion."
      }],
      optionalFacets: [],
      paperFacetCoverage: [{
        paperId: "paper-1",
        coveredFacetIds: ["facet-proof-techniques"],
        missingRequiredFacetIds: [],
        coverageScore: 4,
        matchedTerms: ["proof techniques"],
        rationale: "Covered by the survey metadata."
      }],
      selectedSetCoverage: [{
        facetId: "facet-proof-techniques",
        label: "proof techniques",
        required: true,
        coveredByPaperIds: ["paper-1"],
        count: 1
      }],
      missingRequiredFacets: [],
      backgroundOnlyFacets: [],
      adequacy: "strong" as const,
      selectionRationale: ["Selected set covers the proof-techniques facet."]
    };

    return {
      notes: [
        "Collected 1 OpenAlex literature source."
      ],
      sources: [
        {
          id: "brief:project",
          providerId: null,
          category: "brief",
          kind: "project_brief",
          title: "Riemann Hypothesis",
          locator: null,
          citation: "User-provided project brief.",
          excerpt: "Topic: Riemann Hypothesis. Research question: What proof-technique families are most prominent?",
          year: null,
          authors: [],
          venue: null,
          identifiers: {},
          access: null
        },
        {
          id: "openalex:https://example.org/rh-survey",
          providerId: "openalex",
          category: "scholarly",
          kind: "scholarly_hit",
          title: "A survey of proof strategies for the Riemann Hypothesis",
          locator: "https://example.org/rh-survey",
          citation: "Example Author (2024). A survey of proof strategies for the Riemann Hypothesis.",
          excerpt: "Survey-style source describing analytic approaches, common obstacles, and recurring proof motifs.",
          year: 2024,
          authors: ["Example Author"],
          venue: "Number Theory Review",
          identifiers: {
            doi: "10.1000/rh-survey"
          },
          access: {
            providerId: "openalex",
            url: "https://example.org/rh-survey.pdf",
            accessMode: "fulltext_open",
            fulltextFormat: "pdf",
            note: "Open access PDF."
          }
        }
      ],
      canonicalPapers: papers,
      reviewedPapers: papers,
      routing: {
        domain: "mixed",
        plannedQueries: ["Riemann Hypothesis proof techniques"],
        discoveryProviderIds: ["openalex"],
        resolverProviderIds: [],
        acquisitionProviderIds: ["openalex"]
      },
      mergeDiagnostics: [
        "Merged 1 provider hits into canonical paper paper-1."
      ],
      authStatus: [
        {
          providerId: "openalex",
          configuredFieldIds: [],
          missingRequiredFieldIds: [],
          missingOptionalFieldIds: ["api_key"],
          status: "missing_optional"
        }
      ],
      reviewWorkflow: reviewWorkflowFor(papers),
      selectionQuality
    };
  }
}

class MultiPaperSourceGatherer implements ResearchSourceGatherer {
  constructor(private readonly count: number) {}

  async gather(): Promise<ResearchSourceGatherResult> {
    const papers = Array.from({ length: this.count }, (_, index) => canonicalPaper({
      id: `paper-${index + 1}`,
      key: `doi:10.1000/revision-${index + 1}`,
      title: `Revision test paper ${index + 1}`,
      citation: `Example Author (${2020 + index}). Revision test paper ${index + 1}.`,
      abstract: `Paper ${index + 1} discusses autonomous research-agent revision behavior.`,
      year: 2020 + index
    }));

    return {
      notes: [`Collected ${papers.length} revision-test sources.`],
      sources: [],
      canonicalPapers: papers,
      reviewedPapers: papers,
      routing: {
        domain: "mixed",
        plannedQueries: ["adaptive extraction revision"],
        discoveryProviderIds: ["openalex"],
        resolverProviderIds: [],
        acquisitionProviderIds: ["openalex"]
      },
      mergeDiagnostics: [],
      authStatus: [],
      reviewWorkflow: reviewWorkflowFor(papers)
    };
  }
}

class EvidenceRecoverySourceGatherer implements ResearchSourceGatherer {
  requests: ResearchSourceGatherRequest[] = [];

  async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
    this.requests.push(request);

    if (this.requests.length === 1) {
      const papers = [
        canonicalPaper({
          id: "paper-thin",
          key: "doi:10.1000/thin-revision",
          title: "Thin autonomous research agent note",
          citation: "Example Author (2024). Thin autonomous research agent note.",
          abstract: "A narrow note about autonomous agents without benchmark evidence."
        })
      ];

      return {
        notes: ["Collected an initial thin reviewed set."],
        sources: [],
        canonicalPapers: papers,
        reviewedPapers: papers,
        routing: {
          domain: "mixed",
          plannedQueries: request.plan.searchQueries,
          discoveryProviderIds: ["openalex"],
          resolverProviderIds: [],
          acquisitionProviderIds: ["openalex"]
        },
        mergeDiagnostics: [],
        authStatus: [],
        reviewWorkflow: reviewWorkflowFor(papers),
        retrievalDiagnostics: {
          queries: [],
          providerAttempts: [],
          screeningSummary: {
          accepted: 1,
          rejected: 0,
          weakMatchSamples: []
        },
          revisionPasses: 0,
          accessLimitations: [],
          suggestedNextQueries: ["autonomous research agents benchmark evaluation"]
        },
        selectionQuality: selectionQualityFor(papers, {
          adequacy: "partial",
          facetLabel: "benchmark evaluation",
          missing: true
        })
      };
    }

    assert.ok(request.revisionQueries?.some((query) => /benchmark evaluation/i.test(query)));
    const papers = Array.from({ length: 3 }, (_, index) => canonicalPaper({
      id: `paper-revised-${index + 1}`,
      key: `doi:10.1000/revised-evidence-${index + 1}`,
      title: `Revised benchmark evaluation paper ${index + 1}`,
      citation: `Example Author (${2021 + index}). Revised benchmark evaluation paper ${index + 1}.`,
      abstract: `Paper ${index + 1} reports benchmark evaluation evidence for autonomous research agents.`,
      year: 2021 + index
    }));

    return {
      notes: ["Revised into a stronger benchmark-evaluation evidence set."],
      sources: [],
      canonicalPapers: papers,
      reviewedPapers: papers,
      routing: {
        domain: "mixed",
        plannedQueries: request.plan.searchQueries,
        discoveryProviderIds: ["openalex"],
        resolverProviderIds: [],
        acquisitionProviderIds: ["openalex"]
      },
      mergeDiagnostics: [],
      authStatus: [],
      reviewWorkflow: reviewWorkflowFor(papers),
      retrievalDiagnostics: {
        queries: [],
        providerAttempts: [],
        screeningSummary: {
          accepted: 3,
          rejected: 0,
          weakMatchSamples: []
        },
        revisionPasses: 0,
        accessLimitations: [],
        suggestedNextQueries: []
      },
      selectionQuality: selectionQualityFor(papers, {
        adequacy: "strong",
        facetLabel: "benchmark evaluation"
      })
    };
  }
}

class CriticExclusionSourceGatherer implements ResearchSourceGatherer {
  requests: ResearchSourceGatherRequest[] = [];

  async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
    this.requests.push(request);
    const weakPaper = canonicalPaper({
      id: "paper-weak",
      key: "doi:10.1000/weak-source",
      title: "Weak background survey",
      citation: "Example Author (2024). Weak background survey.",
      abstract: "A broad survey that should not remain in the selected primary evidence set."
    });
    const strongPaper = canonicalPaper({
      id: "paper-strong",
      key: "doi:10.1000/strong-source",
      title: "Strong autonomous research agent system",
      citation: "Example Author (2025). Strong autonomous research agent system.",
      abstract: "A directly relevant autonomous research-agent system with workflow and evaluation evidence."
    });
    const papers = request.criticExcludedPaperIds?.includes("paper-weak")
      ? [strongPaper]
      : [weakPaper, strongPaper];

    return {
      notes: [`Collected ${papers.length} critic-exclusion sources.`],
      sources: [],
      canonicalPapers: papers,
      reviewedPapers: papers,
      routing: {
        domain: "mixed",
        plannedQueries: request.plan.searchQueries,
        discoveryProviderIds: ["openalex"],
        resolverProviderIds: [],
        acquisitionProviderIds: ["openalex"]
      },
      mergeDiagnostics: [],
      authStatus: [],
      reviewWorkflow: reviewWorkflowFor(papers),
      retrievalDiagnostics: {
        queries: [],
        providerAttempts: [],
        screeningSummary: {
          accepted: papers.length,
          rejected: 0,
          weakMatchSamples: []
        },
        revisionPasses: 0,
        accessLimitations: [],
        suggestedNextQueries: []
      },
      selectionQuality: selectionQualityFor(papers, {
        adequacy: "strong",
        facetLabel: "research-agent system"
      })
    };
  }
}

class CriticPromotionSourceGatherer implements ResearchSourceGatherer {
  requests: ResearchSourceGatherRequest[] = [];

  async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
    this.requests.push(request);
    const weakPaper = canonicalPaper({
      id: "paper-weak",
      key: "doi:10.1000/promotion-weak-source",
      title: "Weak autonomous research agent overview",
      citation: "Example Author (2024). Weak autonomous research agent overview.",
      abstract: "A broad overview with limited direct system evidence."
    });
    const strongPaper = canonicalPaper({
      id: "paper-strong",
      key: "doi:10.1000/promotion-strong-source",
      title: "Strong autonomous research agent architecture",
      citation: "Example Author (2025). Strong autonomous research agent architecture.",
      abstract: "A directly relevant autonomous research-agent architecture with tool-use, workflow, and evaluation evidence."
    });
    const reviewed = request.criticPromotedPaperIds?.includes("paper-strong")
      ? [strongPaper]
      : [weakPaper];
    const papers = [weakPaper, strongPaper];

    return {
      notes: [`Collected ${papers.length} critic-promotion sources.`],
      sources: [],
      canonicalPapers: papers,
      reviewedPapers: reviewed,
      routing: {
        domain: "mixed",
        plannedQueries: request.plan.searchQueries,
        discoveryProviderIds: ["openalex"],
        resolverProviderIds: [],
        acquisitionProviderIds: ["openalex"]
      },
      mergeDiagnostics: [],
      authStatus: [],
      reviewWorkflow: reviewWorkflowFor(papers, reviewed.map((paper) => paper.id)),
      retrievalDiagnostics: {
        queries: [],
        providerAttempts: [],
        screeningSummary: {
          accepted: papers.length,
          rejected: 0,
          weakMatchSamples: []
        },
        revisionPasses: 0,
        accessLimitations: [],
        suggestedNextQueries: []
      },
      selectionQuality: selectionQualityFor(reviewed, {
        adequacy: "strong",
        facetLabel: "research-agent architecture"
      })
    };
  }
}

class RecoveringExtractionBackend extends StubResearchBackend {
  calls: string[][] = [];
  private failedLargeBatch = false;

  override async extractReviewedPapers(
    request: PaperExtractionRequest,
    options?: ResearchBackendCallOptions
  ): Promise<PaperExtraction[]> {
    this.calls.push(request.papers.map((paper) => paper.id));

    if (!this.failedLargeBatch && request.papers.length > 1) {
      this.failedLargeBatch = true;
      throw new ResearchBackendError(
        "timeout",
        "extraction",
        "simulated oversized extraction batch",
        options?.timeoutMs ?? null
      );
    }

    return super.extractReviewedPapers(request);
  }
}

class InvalidActionResearchBackend extends StubResearchBackend {
  override async chooseResearchAction(
    _request: ResearchActionRequest,
    options?: ResearchBackendCallOptions
  ): Promise<ResearchActionDecision> {
    throw new ResearchBackendError(
      "malformed_json",
      "agent_step",
      "simulated invalid action JSON",
      options?.timeoutMs ?? null
    );
  }
}

class PersistentlyFailingExtractionBackend extends StubResearchBackend {
  override async extractReviewedPapers(
    request: PaperExtractionRequest,
    options?: ResearchBackendCallOptions
  ): Promise<PaperExtraction[]> {
    throw new ResearchBackendError(
      "malformed_json",
      "extraction",
      `simulated malformed extraction for ${request.papers.map((paper) => paper.id).join(", ")}`,
      options?.timeoutMs ?? null
    );
  }
}

class NoEvidenceSourceGatherer implements ResearchSourceGatherer {
  async gather(): Promise<ResearchSourceGatherResult> {
    return {
      notes: [
        "No relevant scholarly hits were retained."
      ],
      sources: [
        {
          id: "brief:project",
          providerId: null,
          category: "brief",
          kind: "project_brief",
          title: "Riemann Hypothesis",
          locator: null,
          citation: "User-provided project brief.",
          excerpt: "Topic: Riemann Hypothesis.",
          year: null,
          authors: [],
          venue: null,
          identifiers: {},
          access: null
        }
      ],
      canonicalPapers: [],
      reviewedPapers: [],
      routing: {
        domain: "mixed",
        plannedQueries: ["Riemann Hypothesis"],
        discoveryProviderIds: ["openalex"],
        resolverProviderIds: [],
        acquisitionProviderIds: []
      },
      mergeDiagnostics: [],
      authStatus: [],
      reviewWorkflow: reviewWorkflowFor([])
    };
  }
}

class LiteratureAwareResearchBackend implements ResearchBackend {
  readonly label = "stub:literature-aware-research";

  async planResearch(request: ResearchPlanningRequest): Promise<ResearchPlan> {
    assert.equal(request.literatureContext?.available, true);
    assert.match(request.literatureContext?.papers[0]?.title ?? "", /mollifier methods/i);

    return {
      researchMode: "literature_synthesis",
      objective: "Use prior literature memory to continue the mollifier-focused review.",
      rationale: "The project already has canonical papers and theme boards that point to a bounded follow-up.",
      searchQueries: [
        "mollifier methods Riemann Hypothesis limitations"
      ],
      localFocus: [
        "mollifier methods",
        "limitations"
      ]
    };
  }

  async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    const workspaceDecision = workspaceManuscriptDecisionForRequest(
      request,
      "Use the claim/evidence/section tool loop to continue the literature-aware run."
    );
    if (workspaceDecision !== null) {
      return workspaceDecision;
    }

    return {
      schemaVersion: 1,
      action: request.allowedActions[0] ?? "manuscript.status",
      rationale: "Use the structured action loop to continue the literature-aware run.",
      confidence: 0.9,
      inputs: {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticStage: null,
        reason: null
      },
      expectedOutcome: "Continue with the next checkpointed artifact.",
      stopCondition: "The artifact is written.",
      transport: "strict_json"
    };
  }

  async extractReviewedPapers(request: PaperExtractionRequest): Promise<PaperExtraction[]> {
    return request.papers.map((paper, index) => paperExtraction({
      id: `literature-aware-extraction-${index + 1}`,
      paperId: paper.id,
      runId: request.runId,
      systemType: "literature review",
      planningStyle: "memory-guided review"
    }));
  }

  async developResearchAgenda(): Promise<ResearchAgenda> {
    return {
      executiveSummary: "The mollifier-centered literature suggests another bounded literature pass before execution.",
      gaps: [],
      candidateDirections: [],
      selectedDirectionId: null,
      selectedWorkPackage: null,
      holdReasons: ["The reviewed evidence is still too thin for a release-ready synthesis."],
      recommendedHumanDecision: "Refine the literature review before continuing."
    };
  }

  async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "pass",
      confidence: 0.9,
      objections: [],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

class LiteratureAwareSourceGatherer implements ResearchSourceGatherer {
  async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
    assert.equal(request.literatureContext?.available, true);
    assert.match(request.literatureContext?.queryHints.join(" | ") ?? "", /mollifier/i);
    const papers = [
      canonicalPaper({
        id: "paper-2",
        key: "doi:10.1000/mollifier",
        title: "Mollifier methods for the Riemann Hypothesis",
        citation: "Example Author (2025). Mollifier methods for the Riemann Hypothesis.",
        abstract: "Survey of mollifier methods and known limitations.",
        identifiers: {
          doi: "10.1000/mollifier",
          pmid: null,
          pmcid: null,
          arxivId: null
        }
      })
    ];

    return {
      notes: [
        "Used prior literature memory to focus retrieval on mollifier methods."
      ],
      sources: [],
      canonicalPapers: papers,
      reviewedPapers: papers,
      routing: {
        domain: "mixed",
        plannedQueries: ["mollifier methods Riemann Hypothesis limitations"],
        discoveryProviderIds: ["openalex"],
        resolverProviderIds: [],
        acquisitionProviderIds: []
      },
      mergeDiagnostics: [],
      authStatus: [],
      reviewWorkflow: reviewWorkflowFor(papers)
    };
  }
}

class ProtocolBlockingBackend extends StubResearchBackend {
  override async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    if (request.stage !== "protocol") {
      return super.reviewResearchArtifact(request);
    }

    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "block",
      confidence: 0.95,
      objections: [{
        code: "protocol-output-constraint",
        severity: "blocking",
        target: "protocol",
        message: "The protocol turns output-style requirements into evidence targets.",
        affectedPaperIds: [],
        affectedClaimIds: [],
        suggestedRevision: "Revise the protocol before retrieval."
      }],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

class ProtocolRecoveryBackend extends StubResearchBackend {
  protocolCalls = 0;

  override async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    if (request.stage !== "protocol") {
      return super.reviewResearchArtifact(request);
    }

    this.protocolCalls += 1;
    if (this.protocolCalls > 1) {
      return super.reviewResearchArtifact(request);
    }

    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "revise",
      confidence: 0.9,
      objections: [{
        code: "query-too-broad",
        severity: "major",
        target: "protocol",
        message: "The protocol search strategy is too broad for autonomous retrieval.",
        affectedPaperIds: [],
        affectedClaimIds: [],
        suggestedRevision: "Narrow retrieval toward direct protocol evidence."
      }],
      revisionAdvice: {
        searchQueries: ["direct protocol evidence autonomous research agents"],
        evidenceTargets: ["direct protocol evidence"],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

class ProtocolAlwaysReviseBackend extends StubResearchBackend {
  protocolCalls = 0;

  override async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    if (request.stage !== "protocol") {
      return super.reviewResearchArtifact(request);
    }

    this.protocolCalls += 1;
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "revise",
      confidence: 0.8,
      objections: [{
        code: "query-too-broad",
        severity: "major",
        target: "protocol",
        message: "The protocol search strategy could still be narrower.",
        affectedPaperIds: [],
        affectedClaimIds: [],
        suggestedRevision: "Narrow retrieval toward direct protocol evidence."
      }],
      revisionAdvice: {
        searchQueries: ["direct protocol evidence autonomous research agents"],
        evidenceTargets: ["direct protocol evidence"],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

class SourceSelectionRecoveryBackend extends StubResearchBackend {
  sourceSelectionCalls = 0;

  override async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    if (request.stage !== "source_selection") {
      return super.reviewResearchArtifact(request);
    }

    this.sourceSelectionCalls += 1;
    if (this.sourceSelectionCalls > 1) {
      return super.reviewResearchArtifact(request);
    }

    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "revise",
      confidence: 0.9,
      objections: [{
        code: "missing-benchmark-evaluation",
        severity: "major",
        target: "source_selection",
        message: "The selected set lacks direct benchmark evaluation evidence.",
        affectedPaperIds: [],
        affectedClaimIds: [],
        suggestedRevision: "Search for autonomous research agents benchmark evaluation."
      }],
      revisionAdvice: {
        searchQueries: ["autonomous research agents benchmark evaluation"],
        evidenceTargets: ["benchmark evaluation"],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

class SourceSelectionExclusionBackend extends StubResearchBackend {
  sourceSelectionCalls = 0;

  override async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    if (request.stage !== "source_selection") {
      return super.reviewResearchArtifact(request);
    }

    this.sourceSelectionCalls += 1;
    if (this.sourceSelectionCalls > 1) {
      return super.reviewResearchArtifact(request);
    }

    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "revise",
      confidence: 0.9,
      objections: [{
        code: "exclude-weak-source",
        severity: "major",
        target: "source_selection",
        message: "The weak background survey should not stay in the selected evidence set.",
        affectedPaperIds: ["paper-weak"],
        affectedClaimIds: [],
        suggestedRevision: "Remove paper-weak and rebuild the evidence set around direct system evidence."
      }],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: ["paper-weak"],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

class SourceSelectionPromotionBackend extends StubResearchBackend {
  sourceSelectionCalls = 0;

  override async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    if (request.stage !== "source_selection") {
      return super.reviewResearchArtifact(request);
    }

    this.sourceSelectionCalls += 1;
    if (this.sourceSelectionCalls > 1) {
      return super.reviewResearchArtifact(request);
    }

    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "revise",
      confidence: 0.9,
      objections: [{
        code: "promote-strong-source",
        severity: "major",
        target: "source_selection",
        message: "A stronger architecture paper is already present and should replace the weak overview before extraction.",
        affectedPaperIds: ["paper-weak", "paper-strong"],
        affectedClaimIds: [],
        suggestedRevision: "Promote paper-strong into the selected evidence set before searching for more sources."
      }],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: ["paper-strong"],
        claimsToSoften: []
      }
    };
  }
}

class GenericSourceSelectionCriticBackend extends StubResearchBackend {
  sourceSelectionCalls = 0;

  override async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    if (request.stage !== "source_selection") {
      return super.reviewResearchArtifact(request);
    }

    this.sourceSelectionCalls += 1;
    if (this.sourceSelectionCalls > 1) {
      return super.reviewResearchArtifact(request);
    }

    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "revise",
      confidence: 0.58,
      objections: [{
        code: "critic-source_selection-nonpass",
        severity: "blocking",
        target: "source_selection",
        message: "The source selection critic did not pass this artifact but did not provide a structured objection.",
        affectedPaperIds: [],
        affectedClaimIds: [],
        suggestedRevision: "Revise the prior research stage with more focused evidence before release."
      }],
      revisionAdvice: {
        searchQueries: ["Revise the prior research stage with more focused evidence before release."],
        evidenceTargets: ["full manuscript release"],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

class SourceSelectionAlwaysBlockBackend extends StubResearchBackend {
  sourceSelectionCalls = 0;

  override async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    if (request.stage !== "source_selection") {
      return super.reviewResearchArtifact(request);
    }

    this.sourceSelectionCalls += 1;
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "block",
      confidence: 0.87,
      objections: [{
        code: "selected-set-too-narrow",
        severity: "blocking",
        target: "source_selection",
        message: "The selected set still lacks direct comparative benchmark evidence.",
        affectedPaperIds: [],
        affectedClaimIds: [],
        suggestedRevision: "Search for direct comparative benchmark evidence before relying on the selected set."
      }],
      revisionAdvice: {
        searchQueries: ["direct comparative benchmark evidence autonomous research agents"],
        evidenceTargets: ["comparative benchmark evidence"],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

class ReleaseBlockingBackend extends StubResearchBackend {
  override async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    if (request.stage !== "release") {
      return super.reviewResearchArtifact(request);
    }

    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "block",
      confidence: 0.92,
      objections: [{
        code: "release-overclaim",
        severity: "blocking",
        target: "release",
        message: "The manuscript presents the synthesis as publishable despite unresolved review risk.",
        affectedPaperIds: [],
        affectedClaimIds: [],
        suggestedRevision: "Hold release and soften the manuscript claims."
      }],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      }
    };
  }
}

test("run store loads legacy run records with manuscript artifact defaults", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-store-legacy-manuscript-"));
  const runId = "run-legacy-manuscript";

  try {
    await mkdir(runDirectoryPath(projectRoot, runId), { recursive: true });
    await writeFile(runFilePath(projectRoot, runId), `${JSON.stringify({
      schemaVersion: 1,
      appVersion: "0.6.0",
      id: runId,
      projectRoot,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      status: "completed",
      stage: "literature_review",
      statusMessage: "legacy run",
      brief: {
        topic: "Legacy topic",
        researchQuestion: "Legacy question?",
        researchDirection: "Legacy direction.",
        successCriterion: "Legacy criterion."
      },
      workerPid: null,
      job: {
        command: ["clawresearch", "research-loop"],
        cwd: projectRoot,
        pid: null,
        startedAt: null,
        finishedAt: null,
        exitCode: 0,
        signal: null
      },
      artifacts: {
        runDirectory: runDirectoryPath(projectRoot, runId),
        tracePath: path.join(runDirectoryPath(projectRoot, runId), "trace.log"),
        eventsPath: path.join(runDirectoryPath(projectRoot, runId), "events.jsonl"),
        stdoutPath: path.join(runDirectoryPath(projectRoot, runId), "stdout.log"),
        stderrPath: path.join(runDirectoryPath(projectRoot, runId), "stderr.log"),
        briefPath: path.join(runDirectoryPath(projectRoot, runId), "brief.json"),
        planPath: path.join(runDirectoryPath(projectRoot, runId), "plan.json"),
        sourcesPath: path.join(runDirectoryPath(projectRoot, runId), "sources.json"),
        literaturePath: path.join(runDirectoryPath(projectRoot, runId), "literature-review.json"),
        paperExtractionsPath: path.join(runDirectoryPath(projectRoot, runId), "paper-extractions.json"),
        evidenceMatrixPath: path.join(runDirectoryPath(projectRoot, runId), "evidence-matrix.json"),
        synthesisPath: path.join(runDirectoryPath(projectRoot, runId), "synthesis.md"),
        claimsPath: path.join(runDirectoryPath(projectRoot, runId), "claims.json"),
        verificationPath: path.join(runDirectoryPath(projectRoot, runId), "verification.json"),
        nextQuestionsPath: path.join(runDirectoryPath(projectRoot, runId), "next-questions.json"),
        agendaPath: path.join(runDirectoryPath(projectRoot, runId), "agenda.json"),
        agendaMarkdownPath: path.join(runDirectoryPath(projectRoot, runId), "agenda.md"),
        summaryPath: path.join(runDirectoryPath(projectRoot, runId), "summary.md"),
        memoryPath: path.join(runDirectoryPath(projectRoot, runId), "research-journal.json")
      }
    }, null, 2)}\n`, "utf8");

    const loaded = await new RunStore(projectRoot, "0.7.0", createNow()).load(runId);

    assert.match(loaded.artifacts.reviewProtocolPath, /review-protocol\.json$/);
    assert.match(loaded.artifacts.paperOutlinePath, /paper-outline\.json$/);
    assert.match(loaded.artifacts.paperPath, /paper\.md$/);
    assert.match(loaded.artifacts.paperJsonPath, /paper\.json$/);
    assert.match(loaded.artifacts.referencesPath, /references\.json$/);
    assert.match(loaded.artifacts.manuscriptChecksPath, /manuscript-checks\.json$/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker writes raw retrieval and canonical literature artifacts, and synthesizes from canonical papers", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "What proof-technique families are most prominent?",
      researchDirection: "Review prior proof-technique families.",
      successCriterion: "Produce a concise technique map."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.localContext.projectFilesEnabled = false;
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const backend = new StubResearchBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: new StubSourceGatherer()
    });

    const completedRun = await runStore.load(run.id);
    const sourcesArtifact = JSON.parse(await readFile(completedRun.artifacts.sourcesPath, "utf8")) as Record<string, unknown>;
    const literatureArtifact = JSON.parse(await readFile(completedRun.artifacts.literaturePath, "utf8")) as Record<string, unknown>;
    const paperExtractionsArtifact = JSON.parse(await readFile(completedRun.artifacts.paperExtractionsPath, "utf8")) as {
      schemaVersion: number;
      runId: string;
      briefFingerprint: string;
      paperCount: number;
      extractionCount: number;
      extractions: Array<Record<string, unknown>>;
    };
    const evidenceMatrixArtifact = JSON.parse(await readFile(completedRun.artifacts.evidenceMatrixPath, "utf8")) as {
      rowCount: number;
      rows: unknown[];
      derivedInsights: Array<{ kind: string }>;
    };
    const verificationArtifact = JSON.parse(await readFile(completedRun.artifacts.verificationPath, "utf8")) as Record<string, unknown>;
    const agendaArtifact = JSON.parse(await readFile(completedRun.artifacts.agendaPath, "utf8")) as {
      selectedDirectionId: string | null;
      selectedWorkPackage: null;
    };
    const claimsArtifact = JSON.parse(await readFile(completedRun.artifacts.claimsPath, "utf8")) as {
      schemaVersion: number;
      runId: string;
      briefFingerprint: string;
      claimCount: number;
      claims: Array<Record<string, unknown>>;
    };
    const reviewProtocol = JSON.parse(await readFile(completedRun.artifacts.reviewProtocolPath, "utf8")) as {
      schemaVersion: number;
      runId: string;
      reviewType: string;
      actualRetrieval: {
        canonicalPaperCount: number;
        reviewedPaperCount: number;
      } | null;
      requiredSuccessCriterionFacets: Array<{ label: string }>;
      evidenceTargets: string[];
      manuscriptConstraints: string[];
    };
    const paperOutline = JSON.parse(await readFile(completedRun.artifacts.paperOutlinePath, "utf8")) as {
      schemaVersion: number;
      runId: string;
      structureRationale: string;
      rhetoricalPlan: Array<{ role: string }>;
    };
    const paperArtifact = JSON.parse(await readFile(completedRun.artifacts.paperJsonPath, "utf8")) as {
      schemaVersion: number;
      runId: string;
      readinessStatus: string;
      referencedPaperIds: string[];
      claims: Array<Record<string, unknown>>;
      scientificRoles: string[];
    };
    const referencesArtifact = JSON.parse(await readFile(completedRun.artifacts.referencesPath, "utf8")) as {
      schemaVersion: number;
      runId: string;
      referenceCount: number;
      references: Array<{ sourceId: string }>;
    };
    const manuscriptChecks = JSON.parse(await readFile(completedRun.artifacts.manuscriptChecksPath, "utf8")) as {
      schemaVersion: number;
      runId: string;
      readinessStatus: string;
      checks: Array<{ id: string; status: string }>;
    };
    const reviewProtocolMarkdown = await readFile(completedRun.artifacts.reviewProtocolMarkdownPath, "utf8");
    const paperMarkdown = await readFile(completedRun.artifacts.paperPath, "utf8");
    const agendaMarkdown = await readFile(completedRun.artifacts.agendaMarkdownPath, "utf8");
    const workStoreContents = await readFile(researchWorkStoreFilePath(projectRoot), "utf8");
    const workStore = JSON.parse(workStoreContents) as {
      worker: {
        status: string;
        activeRunId: string | null;
        lastRunId: string | null;
        segmentCount: number;
        paperReadiness: string | null;
        userBlockers: string[];
        nextInternalActions: string[];
      };
      objects: {
        canonicalSources: unknown[];
        extractions: unknown[];
        evidenceCells: unknown[];
        citations: unknown[];
        workItems: Array<{ type: string; status: string; description: string }>;
      };
    };
    const researchDirectionContents = await readFile(researchDirectionPath(projectRoot), "utf8");
    const workerState = workStore.worker;
    const researchDirection = JSON.parse(researchDirectionContents) as {
      selectedDirectionId: string | null;
      sourceRunId: string | null;
      sourceRunStage: string | null;
      sourceRunAgendaPath: string | null;
      acceptedAt: string | null;
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(researchWorkerStatePath(projectRoot), researchWorkStoreFilePath(projectRoot));
    assert.equal(workerState.status, "working");
    assert.equal(workerState.activeRunId, null);
    assert.equal(workerState.lastRunId, completedRun.id);
    assert.equal(workerState.segmentCount, 1);
    assert.equal(workerState.paperReadiness, "needs_more_evidence");
    assert.ok(workerState.nextInternalActions.length > 0);
    assert.deepEqual(workerState.userBlockers, []);
    assert.equal(workStore.objects.canonicalSources.length, 1);
    assert.equal(workStore.objects.extractions.length, 1);
    assert.equal(new Set(workStore.objects.evidenceCells.map((cell: unknown) => (cell as { sourceId: string }).sourceId)).size, 1);
    assert.equal(new Set(workStore.objects.citations.map((citation: unknown) => (citation as { sourceId: string }).sourceId)).size, 0);
    assert.ok(workStore.objects.workItems.some((item) => item.status === "open" && item.type === "evidence_gap"));
    assert.deepEqual(backend.capturedExtractionPaperIds, [canonicalPaperId(canonicalPaper())]);
    assert.equal(evidenceMatrixArtifact.rowCount, 1);
    assert.match(JSON.stringify(sourcesArtifact), /rawSources/);
    assert.match(JSON.stringify(sourcesArtifact), /sourceConfig/);
    assert.match(JSON.stringify(sourcesArtifact), /mergeDiagnostics/);
    assert.match(JSON.stringify(sourcesArtifact), /selectionQuality/);
    assert.match(JSON.stringify(literatureArtifact), /paper-1/);
    assert.match(JSON.stringify(literatureArtifact), /fulltext_open/);
    assert.match(JSON.stringify(literatureArtifact), /proof techniques/);
    assert.match(JSON.stringify(literatureArtifact), /selectionQuality/);
    assert.equal(paperExtractionsArtifact.schemaVersion, 1);
    assert.equal(paperExtractionsArtifact.runId, completedRun.id);
    assert.equal(typeof paperExtractionsArtifact.briefFingerprint, "string");
    assert.equal(paperExtractionsArtifact.paperCount, 1);
    assert.equal(paperExtractionsArtifact.extractionCount, 1);
    assert.equal(paperExtractionsArtifact.extractions[0]?.paperId, canonicalPaperId(canonicalPaper()));
    assert.equal(claimsArtifact.schemaVersion, 1);
    assert.equal(claimsArtifact.runId, completedRun.id);
    assert.equal(typeof claimsArtifact.briefFingerprint, "string");
    assert.equal(claimsArtifact.claimCount, 1);
    assert.equal(claimsArtifact.claims.length, 1);
    assert.equal(reviewProtocol.schemaVersion, 1);
    assert.equal(reviewProtocol.runId, completedRun.id);
    assert.equal(reviewProtocol.actualRetrieval?.canonicalPaperCount, 1);
    assert.equal(reviewProtocol.actualRetrieval?.reviewedPaperCount, 1);
    assert.match(JSON.stringify(reviewProtocol.requiredSuccessCriterionFacets), /proof techniques/);
    assert.match(reviewProtocol.evidenceTargets.join(" "), /proof techniques/i);
    assert.match(reviewProtocol.manuscriptConstraints.join(" "), /Do not present a full manuscript/i);
    assert.match(reviewProtocolMarkdown, /Review Protocol/);
    assert.equal(paperOutline.schemaVersion, 1);
    assert.equal(paperOutline.runId, completedRun.id);
    assert.match(paperOutline.structureRationale, /work-store manuscript sections, claims, and evidence cells/i);
    assert.ok(paperOutline.rhetoricalPlan.some((section) => section.role === "synthesis"));
    assert.equal(paperArtifact.schemaVersion, 1);
    assert.equal(paperArtifact.runId, completedRun.id);
    assert.equal(paperArtifact.readinessStatus, "needs_more_evidence");
    assert.deepEqual(paperArtifact.referencedPaperIds, ["paper-1"]);
    assert.equal(paperArtifact.claims.length, 1);
    assert.ok(paperArtifact.scientificRoles.includes("synthesis"));
    assert.equal(referencesArtifact.schemaVersion, 1);
    assert.equal(referencesArtifact.runId, completedRun.id);
    assert.equal(referencesArtifact.referenceCount, 1);
    assert.equal(referencesArtifact.references[0]?.sourceId, "paper-1");
    assert.equal(manuscriptChecks.schemaVersion, 1);
    assert.equal(manuscriptChecks.runId, completedRun.id);
    assert.equal(manuscriptChecks.readinessStatus, "needs_more_evidence");
    assert.ok(manuscriptChecks.checks.some((check) => check.id === "evidence-coverage" && check.status === "fail"));
    assert.match(paperMarkdown, /No full review manuscript was released/i);
    assert.equal(evidenceMatrixArtifact.rowCount, 1);
    assert.equal(evidenceMatrixArtifact.rows.length, 1);
    assert.ok(evidenceMatrixArtifact.derivedInsights.length > 0);
    assert.match(JSON.stringify(verificationArtifact), /paper-1/);
    assert.equal(agendaArtifact.selectedDirectionId, "direction-1");
    assert.equal(agendaArtifact.selectedWorkPackage, null);
    assert.equal(researchDirection.selectedDirectionId, "direction-1");
    assert.equal(researchDirection.sourceRunId, completedRun.id);
    assert.equal(researchDirection.sourceRunStage, "literature_review");
    assert.match(researchDirection.sourceRunAgendaPath ?? "", new RegExp(`${completedRun.id}/agenda\\.json`));
    assert.equal(typeof researchDirection.acceptedAt, "string");
    assert.match(agendaMarkdown, /Research Agenda/);
    assert.match(agendaMarkdown, /No separate handoff artifact is generated/);
    assert.match(workStoreContents, /paper-1/);
    assert.match(workStoreContents, /canonicalSource/);
    assert.match(workStoreContents, /workItem/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker lets the research agent choose source provider order and source tool sequence", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-agentic-sources-"));
  const now = createNow();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "export.arxiv.org" && url.pathname === "/api/query") {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
          <feed>
            <entry>
              <id>http://arxiv.org/abs/2601.12345</id>
              <title>Autonomous research agent harnesses for scientific workflow evaluation</title>
              <summary>Autonomous research agent harness architecture with planning, tool use, retrieval, verification, reproducibility, and benchmark evaluation for digital scientific workflows.</summary>
              <published>2026-01-10T00:00:00Z</published>
              <author><name>Example Author</name></author>
            </entry>
          </feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } });
      }

      if (url.hostname === "api.openalex.org") {
        throw new Error("OpenAlex should not be queried before the model-selected arXiv action.");
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agent harnesses",
      researchQuestion: "How should autonomous research agent harnesses be designed for digital scientific workflows?",
      researchDirection: "Review architectures, planning, tool use, retrieval, verification, reproducibility, and evaluation.",
      successCriterion: "Produce design principles grounded in research-agent harness architecture and evaluation evidence."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = ["arxiv"];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.localContext.projectFilesEnabled = false;
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const backend = new AgenticSourceBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const sourcesArtifact = JSON.parse(await readFile(completedRun.artifacts.sourcesPath, "utf8")) as {
      retrievalDiagnostics?: {
        providerAttempts?: Array<{ providerId: string }>;
      };
      reviewWorkflow?: {
        counts?: {
          selectedForSynthesis?: number;
        };
      };
      agenticSourceState?: {
        sourceStage?: string;
        recentActions?: Array<{ action: string }>;
      } | null;
    };
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(sourcesArtifact.retrievalDiagnostics?.providerAttempts?.[0]?.providerId, "arxiv");
    assert.ok((sourcesArtifact.reviewWorkflow?.counts?.selectedForSynthesis ?? 0) > 0);
    assert.equal(sourcesArtifact.agenticSourceState?.sourceStage, "selected");
    assert.ok(sourcesArtifact.agenticSourceState?.recentActions?.some((action) => action.action === "select_evidence_set"));
    assert.deepEqual(backend.sourceActions.map((action) => action.action).slice(0, 5), [
      "source.search",
      "source.merge",
      "source.rank",
      "source.resolve_access",
      "source.select_evidence"
    ]);
    assert.ok(backend.sourceActions[0]?.inputs.providerIds.includes("arxiv"));
    assert.ok(backend.sourceActionRequests.every((request) => request.allowedActions.includes("work_store.query")));
    assert.ok(backend.sourceActionRequests.every((request) => request.allowedActions.includes("manuscript.add_paragraph")));
    assert.match(stdout, /Research agent action \(source_selection\): source\.search/);
    assert.match(stdout, /Research agent action \(source_selection\): source\.merge/);
    assert.match(stdout, /Research agent action \(source_selection\): source\.rank/);
    assert.match(stdout, /Research agent action \(source_selection\): source\.resolve_access/);
    assert.match(stdout, /Research agent action \(source_selection\): source\.select_evidence/);
    assert.match(stdout, /Source tool observation: arxiv returned/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker executes work-store tool operations inside the source loop", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-work-store-tool-"));
  const now = createNow();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "export.arxiv.org" && url.pathname === "/api/query") {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
          <feed>
            <entry>
              <id>http://arxiv.org/abs/2601.12345</id>
              <title>Autonomous research agent harnesses for scientific workflow evaluation</title>
              <summary>Autonomous research agent harness architecture with planning, tool use, retrieval, verification, reproducibility, and benchmark evaluation.</summary>
              <published>2026-01-10T00:00:00Z</published>
              <author><name>Example Author</name></author>
            </entry>
          </feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agent harnesses",
      researchQuestion: "How should autonomous research agent harnesses be designed for digital scientific workflows?",
      researchDirection: "Review architectures, planning, tool use, retrieval, verification, reproducibility, and evaluation.",
      successCriterion: "Produce design principles grounded in research-agent harness architecture and evaluation evidence."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = [];
    projectConfig.sources.publisherFullText.selectedProviderIds = ["arxiv"];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.localContext.projectFilesEnabled = false;
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const backend = new WorkStoreFirstSourceBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const workStore = JSON.parse(await readFile(researchWorkStoreFilePath(projectRoot), "utf8")) as {
      objects?: {
        workItems?: Array<{ title?: string; source?: string }>;
      };
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.deepEqual(backend.sourceActions.map((action) => action.action).slice(0, 2), [
      "work_store.create",
      "source.search"
    ]);
    assert.ok(backend.sourceActionRequests.every((request) => request.allowedActions.includes("work_store.patch")));
    assert.match(stdout, /Work store tool observation: Work store created work item/);
    assert.ok(workStore.objects?.workItems?.some((item) => item.title === "Inspect full-text-accessible autonomous research agent sources" && item.source === "runtime"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("agentic source dashboard asks the model to reconsider repeated low-yield searches", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-source-dashboard-"));
  const now = createNow();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "export.arxiv.org" && url.pathname === "/api/query") {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
          <feed>
            <entry>
              <id>http://arxiv.org/abs/2601.12345</id>
              <title>Autonomous research agent harnesses for scientific workflow evaluation</title>
              <summary>Autonomous research agent harness architecture with planning, tool use, retrieval, verification, reproducibility, and benchmark evaluation.</summary>
              <published>2026-01-10T00:00:00Z</published>
              <author><name>Example Author</name></author>
            </entry>
          </feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agent harnesses",
      researchQuestion: "How should autonomous research agent harnesses be designed for digital scientific workflows?",
      researchDirection: "Review architectures, planning, tool use, retrieval, verification, reproducibility, and evaluation.",
      successCriterion: "Produce design principles grounded in research-agent harness architecture and evaluation evidence."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = [];
    projectConfig.sources.publisherFullText.selectedProviderIds = ["arxiv"];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.localContext.projectFilesEnabled = false;
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const backend = new StubbornSourceSearchBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const sourcesArtifact = JSON.parse(await readFile(completedRun.artifacts.sourcesPath, "utf8")) as {
      agenticSourceState?: {
        sourceStage?: string;
        consecutiveNoProgressSearches?: number;
        repeatedSearchWarnings?: string[];
        recentActions?: Array<{ action: string; newSources: number }>;
      } | null;
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.ok(backend.sourceActions.filter((action) => action.action === "search_sources").length >= 3);
    assert.ok(backend.sourceActions.some((action) => action.action === "merge_sources"));
    assert.match(stdout, /Source dashboard:/);
    assert.match(stdout, /low-yield|exhausted|consecutive source searches/i);
    assert.equal(sourcesArtifact.agenticSourceState?.sourceStage, "selected");
    assert.ok((sourcesArtifact.agenticSourceState?.consecutiveNoProgressSearches ?? 0) >= 2);
    assert.ok(sourcesArtifact.agenticSourceState?.repeatedSearchWarnings?.some((warning) => /consecutive source searches/i.test(warning)));
    assert.ok(sourcesArtifact.agenticSourceState?.recentActions?.some((action) => action.action === "select_evidence_set"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("agentic source dashboard converges even when the model ignores exhausted-search guidance", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-source-dashboard-ignore-"));
  const now = createNow();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

      if (url.hostname === "export.arxiv.org" && url.pathname === "/api/query") {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
          <feed>
            <entry>
              <id>http://arxiv.org/abs/2601.12345</id>
              <title>Autonomous research agent harnesses for scientific workflow evaluation</title>
              <summary>Autonomous research agent harness architecture with planning, tool use, retrieval, verification, reproducibility, and benchmark evaluation.</summary>
              <published>2026-01-10T00:00:00Z</published>
              <author><name>Example Author</name></author>
            </entry>
          </feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url.toString()}`);
    };

    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agent harnesses",
      researchQuestion: "How should autonomous research agent harnesses be designed for digital scientific workflows?",
      researchDirection: "Review architectures, planning, tool use, retrieval, verification, reproducibility, and evaluation.",
      successCriterion: "Produce design principles grounded in research-agent harness architecture and evaluation evidence."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = [];
    projectConfig.sources.publisherFullText.selectedProviderIds = ["arxiv"];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.localContext.projectFilesEnabled = false;
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const backend = new DashboardIgnoringSourceSearchBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const sourcesArtifact = JSON.parse(await readFile(completedRun.artifacts.sourcesPath, "utf8")) as {
      agenticSourceState?: {
        sourceStage?: string;
        recentActions?: Array<{ action: string; newSources: number }>;
      } | null;
      reviewWorkflow?: {
        counts?: {
          selectedForSynthesis?: number;
        };
      };
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.ok(backend.sourceActions.every((action) => action.action === "search_sources"));
    assert.match(stdout, /Source dashboard:/);
    assert.match(stdout, /Source tool observation: Merged 1 screened scholarly sources into 1 canonical papers/i);
    assert.equal(sourcesArtifact.agenticSourceState?.sourceStage, "selected");
    assert.ok((sourcesArtifact.reviewWorkflow?.counts?.selectedForSynthesis ?? 0) > 0);
    assert.ok(sourcesArtifact.agenticSourceState?.recentActions?.some((action) => action.action === "select_evidence_set"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker shrinks extraction batches after timeout and checkpoints retries", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-extraction-retry-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Autonomous research agents",
      researchQuestion: "How should extraction retry after oversized prompts?",
      researchDirection: "Test adaptive extraction batches.",
      successCriterion: "Complete extraction for every selected paper before drafting."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    projectConfig.runtime.llm.extractionInitialBatchSize = 4;
    projectConfig.runtime.llm.extractionMinBatchSize = 1;
    projectConfig.runtime.llm.extractionRetryBudget = 8;
    await projectConfigStore.save(projectConfig);

    const backend = new RecoveringExtractionBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: new MultiPaperSourceGatherer(3)
    });

    const completedRun = await runStore.load(run.id);
    const artifact = JSON.parse(await readFile(completedRun.artifacts.paperExtractionsPath, "utf8")) as {
      status: string;
      paperCount: number;
      extractionCount: number;
      batchAttempts: Array<{ status: string; errorKind: string | null; batchSize: number }>;
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.deepEqual(backend.calls.map((call) => call.length), [3, 2, 1]);
    assert.equal(artifact.status, "completed");
    assert.equal(artifact.paperCount, 3);
    assert.equal(artifact.extractionCount, 3);
    assert.equal(artifact.batchAttempts[0]?.status, "failed");
    assert.equal(artifact.batchAttempts[0]?.errorKind, "timeout");
    assert.ok(artifact.batchAttempts.some((attempt) => attempt.status === "succeeded" && attempt.batchSize === 2));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker builds manuscript progress through claim, evidence, and section tools", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-synthesis-revision-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Autonomous research agents",
      researchQuestion: "How should synthesis retry after oversized prompts?",
      researchDirection: "Test clustered synthesis revision.",
      successCriterion: "Complete synthesis without losing extracted evidence."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const backend = new StubResearchBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: new MultiPaperSourceGatherer(4)
    });

    const completedRun = await runStore.load(run.id);
    const synthesisArtifact = JSON.parse(await readFile(completedRun.artifacts.synthesisJsonPath, "utf8")) as {
      status: string;
      strategy: string;
      synthesis: { claims: unknown[] };
    };
    const paperArtifact = JSON.parse(await readFile(completedRun.artifacts.paperJsonPath, "utf8")) as {
      claims: unknown[];
      sections: unknown[];
    };
    const workStore = JSON.parse(await readFile(researchWorkStoreFilePath(projectRoot), "utf8")) as {
      objects: {
        claims: Array<{ id: string; text: string; sourceIds: string[] }>;
        citations: unknown[];
        manuscriptSections: Array<{ id: string; sectionId: string; claimIds: string[]; sourceIds: string[] }>;
      };
    };
    const agentSteps = await readFile(completedRun.artifacts.agentStepsPath, "utf8");
    const parsedAgentSteps = agentSteps.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      actor: string;
      action: string;
      metadata?: { transport?: string };
    }>;
    const agentState = JSON.parse(await readFile(completedRun.artifacts.agentStatePath, "utf8")) as {
      completedSteps: number;
      currentPhase: string;
      lastMetadata?: { transport?: string };
    };
    const qualityReport = JSON.parse(await readFile(completedRun.artifacts.qualityReportPath, "utf8")) as {
      agentControl: {
        transportCounts: Record<string, number>;
        actions: Array<{ action: string; transport: string }>;
      };
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(synthesisArtifact.status, "derived_from_work_store");
    assert.equal(synthesisArtifact.strategy, "claim_evidence_section_tool_loop");
    assert.ok(synthesisArtifact.synthesis.claims.length > 0);
    assert.ok(paperArtifact.claims.length > 0);
    assert.ok(paperArtifact.sections.length > 0);
    assert.equal(workStore.objects.claims.length, 1);
    assert.equal(workStore.objects.manuscriptSections.length, 1);
    assert.equal(workStore.objects.citations.length, 0);
    assert.equal(new Set(workStore.objects.claims.map((claim) => claim.text)).size, workStore.objects.claims.length);
    assert.equal(new Set(workStore.objects.manuscriptSections.map((section) => section.sectionId)).size, workStore.objects.manuscriptSections.length);
    const synthesisActionRequest = backend.actionRequests.find((request) => request.phase === "synthesis");
    assert.ok(synthesisActionRequest?.allowedActions.includes("work_store.query"));
    assert.ok(synthesisActionRequest?.allowedActions.includes("source.search"));
    assert.ok(synthesisActionRequest?.allowedActions.includes("claim.create"));
    assert.ok(synthesisActionRequest?.allowedActions.includes("manuscript.add_paragraph"));
    assert.doesNotMatch(agentSteps, /plan_clustered_synthesis|revise_synthesis_cluster|merge_cluster_syntheses/);
    assert.equal(parsedAgentSteps.find((step) => step.action === "claim.create")?.metadata?.transport, "strict_json");
    assert.ok((qualityReport.agentControl.transportCounts.strict_json ?? 0) >= 3);
    assert.ok(qualityReport.agentControl.actions.some((action) => action.action === "claim.create" && action.transport === "strict_json"));
    assert.ok(qualityReport.agentControl.actions.some((action) => action.action === "manuscript.add_paragraph" && action.transport === "strict_json"));
    assert.ok(qualityReport.agentControl.actions.some((action) => action.action === "manuscript.check_section_claims" && action.transport === "strict_json"));
    assert.ok(agentState.completedSteps > 0);
    assert.equal(agentState.currentPhase, "release");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker finishes status-only when the model cannot choose structured actions", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-agent-control-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Autonomous research agents",
      researchQuestion: "Can the runtime avoid fake completion when action control fails?",
      researchDirection: "Test strict JSON action control.",
      successCriterion: "Finish with status diagnostics instead of releasing a paper."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    projectConfig.runtime.llm.agentControlMode = "strict_json";
    projectConfig.runtime.llm.agentInvalidActionBudget = 2;
    await projectConfigStore.save(projectConfig);

    const backend = new InvalidActionResearchBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: new MultiPaperSourceGatherer(3)
    });

    const completedRun = await runStore.load(run.id);
    const qualityReport = JSON.parse(await readFile(completedRun.artifacts.qualityReportPath, "utf8")) as {
      agentControl: {
        mode: string;
        transportCounts: Record<string, number>;
        actions: Array<{ action: string; transport: string }>;
        invalidActionCount: number;
        diagnostics: Array<{ kind: string; message: string }>;
      };
      modelSuitability: {
        rationale: string[];
      };
    };
    const paper = JSON.parse(await readFile(completedRun.artifacts.paperJsonPath, "utf8")) as {
      readinessStatus: string;
      scientificRoles: string[];
      claims: unknown[];
    };
    const paperMarkdown = await readFile(completedRun.artifacts.paperPath, "utf8");
    const synthesisArtifact = JSON.parse(await readFile(completedRun.artifacts.synthesisJsonPath, "utf8")) as {
      status: string;
      synthesis: {
        claims: unknown[];
      };
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(qualityReport.agentControl.mode, "strict_json");
    assert.ok((qualityReport.agentControl.transportCounts.runtime_fallback ?? 0) >= 1);
    assert.equal(qualityReport.agentControl.actions[0]?.transport, "runtime_fallback");
    assert.ok(qualityReport.agentControl.invalidActionCount >= 2);
    assert.equal(qualityReport.agentControl.diagnostics[0]?.kind, "malformed_action");
    assert.match(qualityReport.modelSuitability.rationale.join(" "), /action control/i);
    assert.equal(paper.readinessStatus, "needs_more_evidence");
    assert.deepEqual(paper.claims, []);
    assert.match(paperMarkdown, /No full review manuscript was released/i);
    assert.equal(synthesisArtifact.status, "derived_from_work_store");
    assert.deepEqual(synthesisArtifact.synthesis.claims, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker autonomously reruns retrieval when manuscript checks need more evidence", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-evidence-revision-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Autonomous research agents",
      researchQuestion: "How should autonomous research agents be evaluated?",
      researchDirection: "Review benchmark evaluation evidence.",
      successCriterion: "Cover benchmark evaluation before writing the paper."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    projectConfig.runtime.llm.evidenceRecoveryMaxPasses = 2;
    await projectConfigStore.save(projectConfig);

    const backend = new StubResearchBackend();
    const sourceGatherer = new EvidenceRecoverySourceGatherer();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer
    });

    const completedRun = await runStore.load(run.id);
    const paper = JSON.parse(await readFile(completedRun.artifacts.paperJsonPath, "utf8")) as {
      readinessStatus: string;
      referencedPaperIds: string[];
    };
    const sourcesArtifact = JSON.parse(await readFile(completedRun.artifacts.sourcesPath, "utf8")) as {
      autonomousEvidence: { pass: number; revisionPasses: number };
    };
    const planArtifact = JSON.parse(await readFile(completedRun.artifacts.planPath, "utf8")) as {
      searchQueries: string[];
    };
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(sourceGatherer.requests.length, 2);
    assert.ok(sourceGatherer.requests[1]?.revisionQueries?.some((query) => /benchmark evaluation/i.test(query)));
    assert.equal(sourcesArtifact.autonomousEvidence.pass, 2);
    assert.equal(sourcesArtifact.autonomousEvidence.revisionPasses, 1);
    assert.ok(planArtifact.searchQueries.some((query) => /benchmark evaluation/i.test(query)));
    assert.equal(backend.capturedExtractionPaperIds.length, 3);
    assert.equal(paper.readinessStatus, "ready_for_revision");
    assert.ok(paper.referencedPaperIds.length >= 1);
    assert.match(stdout, /Evidence revision pass 1/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker blocks manuscript generation when extraction cannot complete after retries", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-extraction-blocked-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Autonomous research agents",
      researchQuestion: "How should persistent extraction failures be handled?",
      researchDirection: "Do not draft when selected evidence is not fully extracted.",
      successCriterion: "Block manuscript generation until extraction succeeds."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    projectConfig.runtime.llm.extractionInitialBatchSize = 2;
    projectConfig.runtime.llm.extractionMinBatchSize = 1;
    projectConfig.runtime.llm.extractionRetryBudget = 4;
    await projectConfigStore.save(projectConfig);

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new PersistentlyFailingExtractionBackend(),
      sourceGatherer: new MultiPaperSourceGatherer(2)
    });

    const failedRun = await runStore.load(run.id);
    const extractionArtifact = JSON.parse(await readFile(failedRun.artifacts.paperExtractionsPath, "utf8")) as {
      status: string;
      extractionCount: number;
      failedPaperIds: string[];
    };
    const paperArtifact = JSON.parse(await readFile(failedRun.artifacts.paperJsonPath, "utf8")) as {
      artifactKind: string;
      status: string;
      error: { kind: string };
    };
    const paperMarkdown = await readFile(failedRun.artifacts.paperPath, "utf8");

    assert.equal(exitCode, 1);
    assert.equal(failedRun.status, "failed");
    assert.equal(extractionArtifact.status, "failed");
    assert.equal(extractionArtifact.extractionCount, 0);
    assert.ok(extractionArtifact.failedPaperIds.length > 0);
    assert.equal(paperArtifact.artifactKind, "paper");
    assert.equal(paperArtifact.status, "failed");
    assert.equal(paperArtifact.error.kind, "stage_blocked");
    assert.match(paperMarkdown, /No review-paper draft was produced/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker synthesizes from the reviewed subset instead of the full canonical harvest", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-reviewed-subset-"));
  const now = createNow();

  class ReviewedSubsetSourceGatherer implements ResearchSourceGatherer {
    async gather(): Promise<ResearchSourceGatherResult> {
      const includedPaper = canonicalPaper({
        id: "paper-reviewed",
        key: "doi:10.1000/reviewed",
        title: "Reviewed full-text survey",
        citation: "Example Author (2024). Reviewed full-text survey.",
        identifiers: {
          doi: "10.1000/reviewed",
          pmid: null,
          pmcid: null,
          arxivId: null
        }
      });
      const blockedPaper = canonicalPaper({
        id: "paper-blocked",
        key: "doi:10.1000/blocked",
        title: "Blocked but possibly relevant paper",
        citation: "Example Author (2025). Blocked but possibly relevant paper.",
        bestAccessUrl: "https://example.org/blocked",
        bestAccessProvider: "crossref",
        accessMode: "needs_credentials",
        fulltextFormat: "none",
        contentStatus: {
          abstractAvailable: false,
          fulltextAvailable: false,
          fulltextFetched: false,
          fulltextExtracted: false
        },
        screeningStage: "title",
        screeningDecision: "uncertain",
        screeningRationale: "Title-level match only; access is blocked.",
        identifiers: {
          doi: "10.1000/blocked",
          pmid: null,
          pmcid: null,
          arxivId: null
        }
      });
      const papers = [includedPaper, blockedPaper];

      return {
        notes: [
          "Collected a reviewed full-text paper and one blocked backlog paper."
        ],
        sources: [],
        canonicalPapers: papers,
        reviewedPapers: [includedPaper],
        routing: {
          domain: "general",
          plannedQueries: ["reviewed subset test"],
          discoveryProviderIds: ["openalex"],
          resolverProviderIds: [],
          acquisitionProviderIds: []
        },
        mergeDiagnostics: [],
        authStatus: [],
        reviewWorkflow: reviewWorkflowFor(papers, ["paper-reviewed"])
      };
    }
  }

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "Which papers should ground synthesis?",
      researchDirection: "Use only reviewed papers for synthesis.",
      successCriterion: "Avoid synthesizing from blocked papers."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const backend = new StubResearchBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: new ReviewedSubsetSourceGatherer()
    });

    const completedRun = await runStore.load(run.id);
    const summary = await readFile(completedRun.artifacts.summaryPath, "utf8");
    const sourcesArtifact = JSON.parse(await readFile(completedRun.artifacts.sourcesPath, "utf8")) as Record<string, unknown>;
    const paperExtractions = JSON.parse(await readFile(completedRun.artifacts.paperExtractionsPath, "utf8")) as {
      extractions: Array<{ paperId: string }>;
    };
    const paperArtifact = JSON.parse(await readFile(completedRun.artifacts.paperJsonPath, "utf8")) as {
      referencedPaperIds: string[];
    };
    const reviewedPaperId = canonicalPaperId(canonicalPaper({
      id: "paper-reviewed",
      key: "doi:10.1000/reviewed"
    }));
    const blockedPaperId = canonicalPaperId(canonicalPaper({
      id: "paper-blocked",
      key: "doi:10.1000/blocked"
    }));

    assert.equal(exitCode, 0);
    assert.deepEqual(paperExtractions.extractions.map((extraction) => extraction.paperId), [reviewedPaperId]);
    assert.ok(paperArtifact.referencedPaperIds.some((paperId) => [reviewedPaperId, "paper-reviewed"].includes(paperId)));
    assert.ok(!paperArtifact.referencedPaperIds.some((paperId) => [blockedPaperId, "paper-blocked"].includes(paperId)));
    assert.match(summary, /Reviewed papers selected for synthesis: 1/);
    assert.match(JSON.stringify(sourcesArtifact), /reviewWorkflow/);
    assert.match(JSON.stringify(sourcesArtifact), /paper-blocked/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker previews reviewed papers instead of raw-source noise in the live logs", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-preview-"));
  const now = createNow();

  class PreviewSourceGatherer implements ResearchSourceGatherer {
    async gather(): Promise<ResearchSourceGatherResult> {
      const reviewedPaper = canonicalPaper({
        id: "paper-reviewed-preview",
        key: "doi:10.1000/reviewed-preview",
        title: "Reviewed survey of autonomous research agents",
        citation: "Example Author (2025). Reviewed survey of autonomous research agents.",
        venue: "AI Systems Review",
        identifiers: {
          doi: "10.1000/reviewed-preview",
          pmid: null,
          pmcid: null,
          arxivId: null
        }
      });

      return {
        notes: [
          "Collected one relevant reviewed paper and one noisy raw hit."
        ],
        sources: [
          {
            id: "brief:project",
            providerId: null,
            category: "brief",
            kind: "project_brief",
            title: "autonomous research agents",
            locator: null,
            citation: "User-provided project brief.",
            excerpt: "Topic: autonomous research agents.",
            year: null,
            authors: [],
            venue: null,
            identifiers: {},
            access: null
          },
          {
            id: "openalex:https://example.org/noise",
            providerId: "openalex",
            category: "scholarly",
            kind: "scholarly_hit",
            title: "Irrelevant sewer flooding review",
            locator: "https://example.org/noise",
            citation: "Noise Author (2024). Irrelevant sewer flooding review.",
            excerpt: "This should not be previewed once the reviewed set exists.",
            year: 2024,
            authors: ["Noise Author"],
            venue: "Noise Journal",
            identifiers: {},
            access: {
              providerId: "openalex",
              url: "https://example.org/noise",
              accessMode: "metadata_only",
              fulltextFormat: "none",
              note: "Noise"
            }
          }
        ],
        canonicalPapers: [reviewedPaper],
        reviewedPapers: [reviewedPaper],
        routing: {
          domain: "cs_ai",
          plannedQueries: ["autonomous research agents"],
          discoveryProviderIds: ["openalex"],
          resolverProviderIds: [],
          acquisitionProviderIds: []
        },
        mergeDiagnostics: [],
        authStatus: [],
        reviewWorkflow: reviewWorkflowFor([reviewedPaper], ["paper-reviewed-preview"])
      };
    }
  }

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Which papers should be previewed in the console?",
      researchDirection: "Preview reviewed papers rather than raw-source noise.",
      successCriterion: "Keep the live console focused on the reviewed set."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceGatherer: new PreviewSourceGatherer()
    });

    const completedRun = await runStore.load(run.id);
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const events = await readFile(completedRun.artifacts.eventsPath, "utf8");

    assert.equal(exitCode, 0);
    assert.match(
      stdout,
      new RegExp(`Reviewed paper: ${canonicalPaperId(canonicalPaper({
        id: "paper-reviewed-preview",
        key: "doi:10.1000/reviewed-preview"
      }))}: Reviewed survey of autonomous research agents`)
    );
    assert.doesNotMatch(stdout, /Source selected:/);
    assert.doesNotMatch(events, /Irrelevant sewer flooding review/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker uses prior literature memory to inform planning and retrieval", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-literature-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "What bounded follow-up should we pursue next?",
      researchDirection: "Build on the strongest prior lead.",
      successCriterion: "Produce a focused follow-up synthesis."
    }, ["clawresearch", "research-loop"]);

    const priorWorkStore = upsertResearchWorkStoreEntities(createResearchWorkStore({
      projectRoot,
      brief: run.brief,
      now: now()
    }), [
      {
        id: createLiteratureEntityId("paper", "doi:10.1000/mollifier"),
        kind: "canonicalSource",
        runId: "run-prior",
        createdAt: now(),
        updatedAt: now(),
        key: "doi:10.1000/mollifier",
        title: "Mollifier methods for the Riemann Hypothesis",
        citation: "Example Author (2025). Mollifier methods for the Riemann Hypothesis.",
        abstract: "Survey of mollifier methods and known limitations.",
        year: 2025,
        authors: ["Example Author"],
        venue: "Number Theory Review",
        providerIds: ["openalex"],
        identifiers: {
          doi: "10.1000/mollifier",
          pmid: null,
          pmcid: null,
          arxivId: null
        },
        accessMode: "fulltext_open",
        bestAccessUrl: "https://example.org/mollifier.pdf",
        screeningDecision: "include",
        screeningRationale: "Prior canonical source.",
        tags: ["mollifier methods", "limitations"]
      },
      {
        id: "work-item-prior-mollifier",
        kind: "workItem",
        runId: "run-prior",
        createdAt: now(),
        updatedAt: now(),
        type: "open_question",
        status: "open",
        severity: "minor",
        title: "Mollifier limitations follow-up",
        description: "Which mollifier limitations are most promising for a deeper follow-up?",
        targetKind: "canonicalSource",
        targetId: createLiteratureEntityId("paper", "doi:10.1000/mollifier"),
        affectedSourceIds: [createLiteratureEntityId("paper", "doi:10.1000/mollifier")],
        affectedClaimIds: [],
        suggestedActions: ["mollifier methods Riemann Hypothesis limitations"],
        source: "synthesis"
      }
    ], now());
    await writeResearchWorkStore(priorWorkStore);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new LiteratureAwareResearchBackend(),
      sourceGatherer: new LiteratureAwareSourceGatherer()
    });

    const completedRun = await runStore.load(run.id);
    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker writes a hold agenda when no canonical papers are retained", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-no-evidence-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "What proof-technique families are most prominent?",
      researchDirection: "Review prior proof-technique families.",
      successCriterion: "Produce a concise technique map."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceGatherer: new NoEvidenceSourceGatherer()
    });

    const completedRun = await runStore.load(run.id);
    const summary = await readFile(completedRun.artifacts.summaryPath, "utf8");
    const paperExtractions = JSON.parse(await readFile(completedRun.artifacts.paperExtractionsPath, "utf8")) as {
      schemaVersion: number;
      runId: string;
      paperCount: number;
      extractionCount: number;
      extractions: unknown[];
    };
    const claims = JSON.parse(await readFile(completedRun.artifacts.claimsPath, "utf8")) as {
      schemaVersion: number;
      runId: string;
      claimCount: number;
      claims: unknown[];
    };
    const paper = JSON.parse(await readFile(completedRun.artifacts.paperJsonPath, "utf8")) as {
      readinessStatus: string;
      referencedPaperIds: string[];
      claims: unknown[];
    };
    const references = JSON.parse(await readFile(completedRun.artifacts.referencesPath, "utf8")) as {
      referenceCount: number;
      references: unknown[];
    };
    const checks = JSON.parse(await readFile(completedRun.artifacts.manuscriptChecksPath, "utf8")) as {
      readinessStatus: string;
      blockerCount: number;
    };
    const paperMarkdown = await readFile(completedRun.artifacts.paperPath, "utf8");
    const evidenceMatrix = JSON.parse(await readFile(completedRun.artifacts.evidenceMatrixPath, "utf8")) as {
      rowCount: number;
      rows: unknown[];
    };
    const agenda = JSON.parse(await readFile(completedRun.artifacts.agendaPath, "utf8")) as {
      selectedDirectionId: string | null;
      selectedWorkPackage: unknown;
      holdReasons: string[];
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.match(summary, /did not retain any canonical papers/i);
    assert.equal(paperExtractions.schemaVersion, 1);
    assert.equal(paperExtractions.runId, completedRun.id);
    assert.equal(paperExtractions.paperCount, 0);
    assert.equal(paperExtractions.extractionCount, 0);
    assert.equal(paperExtractions.extractions.length, 0);
    assert.equal(claims.schemaVersion, 1);
    assert.equal(claims.runId, completedRun.id);
    assert.equal(claims.claimCount, 0);
    assert.equal(claims.claims.length, 0);
    assert.equal(paper.readinessStatus, "needs_more_evidence");
    assert.equal(paper.referencedPaperIds.length, 0);
    assert.equal(paper.claims.length, 0);
    assert.equal(references.referenceCount, 0);
    assert.equal(references.references.length, 0);
    assert.equal(checks.readinessStatus, "needs_more_evidence");
    assert.match(paperMarkdown, /needs_more_evidence/i);
    assert.equal(evidenceMatrix.rowCount, 0);
    assert.equal(evidenceMatrix.rows.length, 0);
    assert.equal(agenda.selectedDirectionId, null);
    assert.equal(agenda.selectedWorkPackage, null);
    assert.ok(agenda.holdReasons.length > 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker writes a hold agenda when retrieval found papers but review retained none for synthesis", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-no-reviewed-"));
  const now = createNow();

  class NoReviewedSubsetSourceGatherer implements ResearchSourceGatherer {
    async gather(): Promise<ResearchSourceGatherResult> {
      const papers = [
        canonicalPaper({
          id: "paper-blocked",
          key: "doi:10.1000/blocked",
          title: "Blocked title-only paper",
          citation: "Example Author (2025). Blocked title-only paper.",
          bestAccessUrl: "https://example.org/blocked",
          bestAccessProvider: "crossref",
          accessMode: "needs_credentials",
          fulltextFormat: "none",
          contentStatus: {
            abstractAvailable: false,
            fulltextAvailable: false,
            fulltextFetched: false,
            fulltextExtracted: false
          },
          screeningStage: "title",
          screeningDecision: "uncertain",
          screeningRationale: "Potentially relevant but not reviewed deeply enough.",
          identifiers: {
            doi: "10.1000/blocked",
            pmid: null,
            pmcid: null,
            arxivId: null
          }
        })
      ];

      return {
        notes: [
          "Retrieved one title-level paper but no reviewed subset."
        ],
        sources: [],
        canonicalPapers: papers,
        reviewedPapers: [],
        routing: {
          domain: "general",
          plannedQueries: ["blocked review test"],
          discoveryProviderIds: ["openalex"],
          resolverProviderIds: [],
          acquisitionProviderIds: []
        },
        mergeDiagnostics: [],
        authStatus: [],
        reviewWorkflow: reviewWorkflowFor(papers, [])
      };
    }
  }

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "Which sources should be retained after review?",
      researchDirection: "Fail when review retains nothing.",
      successCriterion: "Avoid unsupported synthesis."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.scholarlyDiscovery.selectedProviderIds = ["openalex"];
    projectConfig.sources.publisherFullText.selectedProviderIds = [];
    projectConfig.sources.oaRetrievalHelpers.selectedProviderIds = [];
    projectConfig.sources.generalWeb.selectedProviderIds = [];
    projectConfig.sources.explicitlyConfigured = true;
    await projectConfigStore.save(projectConfig);

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceGatherer: new NoReviewedSubsetSourceGatherer()
    });

    const completedRun = await runStore.load(run.id);
    const summary = await readFile(completedRun.artifacts.summaryPath, "utf8");
    const agenda = JSON.parse(await readFile(completedRun.artifacts.agendaPath, "utf8")) as {
      selectedDirectionId: string | null;
      selectedWorkPackage: unknown;
      holdReasons: string[];
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.match(summary, /did not retain any sufficiently reviewed papers/i);
    assert.equal(agenda.selectedDirectionId, null);
    assert.equal(agenda.selectedWorkPackage, null);
    assert.ok(agenda.holdReasons.length > 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("protocol critic block records a warning and continues to source gathering", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-critic-protocol-"));
  const now = createNow();

  class CapturingSourceGatherer implements ResearchSourceGatherer {
    private readonly base = new StubSourceGatherer();
    requests: ResearchSourceGatherRequest[] = [];

    async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
      this.requests.push(request);
      return this.base.gather();
    }
  }

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "How should evidence be reviewed?",
      researchDirection: "Review the literature.",
      successCriterion: "Produce a publication-style paper with citations."
    }, ["clawresearch", "research-loop"]);

    const gatherer = new CapturingSourceGatherer();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new ProtocolBlockingBackend(),
      sourceGatherer: gatherer
    });

    const completedRun = await runStore.load(run.id);
    const critic = JSON.parse(await readFile(completedRun.artifacts.criticProtocolReviewPath, "utf8")) as CriticReviewArtifact;
    const checks = JSON.parse(await readFile(completedRun.artifacts.manuscriptChecksPath, "utf8")) as {
      readinessStatus: string;
      blockers: string[];
      checks: Array<{ id: string; severity: string; status: string; message: string }>;
    };
    const qualityReport = JSON.parse(await readFile(completedRun.artifacts.qualityReportPath, "utf8")) as {
      critic: {
        finalSatisfaction: string;
        iterations: Array<{ stage: string; finalReadiness: string }>;
      };
    };
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(critic.readiness, "block");
    assert.ok(gatherer.requests.length >= 1);
    assert.ok(checks.checks.some((item) => item.id.includes("critic-protocol") && item.severity === "warning"));
    assert.doesNotMatch(checks.blockers.join(" "), /output-style requirements/);
    assert.equal(qualityReport.critic.finalSatisfaction, "unresolved");
    assert.ok(qualityReport.critic.iterations.some((item) => item.stage === "protocol" && item.finalReadiness === "block"));
    assert.match(stdout, /continuing to retrieval/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("protocol critic feedback revises the protocol and continues autonomously", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-critic-protocol-revision-"));
  const now = createNow();

  class CapturingSourceGatherer implements ResearchSourceGatherer {
    private readonly base = new StubSourceGatherer();
    requests: ResearchSourceGatherRequest[] = [];

    async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
      this.requests.push(request);
      return this.base.gather();
    }
  }

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "How should evidence be reviewed?",
      researchDirection: "Review the literature.",
      successCriterion: "Produce a publication-style paper with citations."
    }, ["clawresearch", "research-loop"]);

    const backend = new ProtocolRecoveryBackend();
    const gatherer = new CapturingSourceGatherer();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: gatherer
    });

    const completedRun = await runStore.load(run.id);
    const critic = JSON.parse(await readFile(completedRun.artifacts.criticProtocolReviewPath, "utf8")) as CriticReviewArtifact;
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(backend.protocolCalls, 2);
    assert.equal(critic.readiness, "pass");
    assert.ok(gatherer.requests.length >= 1);
    assert.ok(gatherer.requests[0]?.plan.searchQueries.some((query) => /direct protocol evidence/i.test(query)));
    assert.match(stdout, /Protocol revision 1/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("persistent protocol critic revise continues to source gathering after bounded retries", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-critic-protocol-revise-"));
  const now = createNow();

  class CapturingSourceGatherer implements ResearchSourceGatherer {
    private readonly base = new StubSourceGatherer();
    requests: ResearchSourceGatherRequest[] = [];

    async gather(request: ResearchSourceGatherRequest): Promise<ResearchSourceGatherResult> {
      this.requests.push(request);
      return this.base.gather();
    }
  }

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "How should evidence be reviewed?",
      researchDirection: "Review the literature.",
      successCriterion: "Produce a publication-style paper with citations."
    }, ["clawresearch", "research-loop"]);

    const backend = new ProtocolAlwaysReviseBackend();
    const gatherer = new CapturingSourceGatherer();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: gatherer
    });

    const completedRun = await runStore.load(run.id);
    const critic = JSON.parse(await readFile(completedRun.artifacts.criticProtocolReviewPath, "utf8")) as CriticReviewArtifact;
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(critic.readiness, "revise");
    assert.ok(backend.protocolCalls >= 2);
    assert.ok(gatherer.requests.length >= 1);
    assert.match(stdout, /continuing to retrieval/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source-selection critic feedback triggers an autonomous revision pass", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-critic-source-revision-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "What evidence supports benchmark evaluation?",
      researchDirection: "Revise benchmark evaluation evidence.",
      successCriterion: "Cover benchmark evaluation directly."
    }, ["clawresearch", "research-loop"]);

    const gatherer = new EvidenceRecoverySourceGatherer();
    const backend = new SourceSelectionRecoveryBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: gatherer
    });

    const completedRun = await runStore.load(run.id);
    const critic = JSON.parse(await readFile(completedRun.artifacts.criticSourceSelectionPath, "utf8")) as CriticReviewArtifact;
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.ok(gatherer.requests.length >= 2);
    assert.ok(backend.sourceSelectionCalls >= 2);
    assert.equal(critic.readiness, "pass");
    assert.match(stdout, /Source-selection critic requested evidence revision pass 1|Evidence revision pass 1/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source-selection critic paper exclusions revise the selected evidence set", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-critic-source-exclusion-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Which selected papers should support the final synthesis?",
      researchDirection: "Revise source selection using critic exclusions.",
      successCriterion: "Use direct autonomous research-agent system evidence."
    }, ["clawresearch", "research-loop"]);

    const gatherer = new CriticExclusionSourceGatherer();
    const backend = new SourceSelectionExclusionBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: gatherer
    });

    const completedRun = await runStore.load(run.id);
    const paperExtractions = JSON.parse(await readFile(completedRun.artifacts.paperExtractionsPath, "utf8")) as {
      extractions: Array<{ paperId: string }>;
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.ok(backend.sourceSelectionCalls >= 2);
    assert.ok(gatherer.requests[1]?.criticExcludedPaperIds?.includes("paper-weak"));
    assert.deepEqual(paperExtractions.extractions.map((extraction) => extraction.paperId), [
      canonicalPaperId(canonicalPaper({ key: "doi:10.1000/strong-source" }))
    ]);
    assert.ok(!paperExtractions.extractions.some((extraction) => extraction.paperId === canonicalPaperId(canonicalPaper({ key: "doi:10.1000/weak-source" }))));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source-selection critic paper promotions revise the selected evidence set before searching more", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-critic-promote-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Which selected papers should support the final synthesis?",
      researchDirection: "Revise source selection using critic promotions.",
      successCriterion: "Use the strongest autonomous research-agent architecture evidence already found."
    }, ["clawresearch", "research-loop"]);

    const gatherer = new CriticPromotionSourceGatherer();
    const backend = new SourceSelectionPromotionBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: gatherer
    });

    const completedRun = await runStore.load(run.id);
    const paperExtractions = JSON.parse(await readFile(completedRun.artifacts.paperExtractionsPath, "utf8")) as {
      extractions: Array<{ paperId: string }>;
    };
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.ok(backend.sourceSelectionCalls >= 2);
    assert.ok(gatherer.requests[1]?.criticPromotedPaperIds?.includes("paper-strong"));
    assert.match(stdout, /promoting stronger candidates already in the source pool/i);
    assert.deepEqual(paperExtractions.extractions.map((extraction) => extraction.paperId), [
      canonicalPaperId(canonicalPaper({ key: "doi:10.1000/promotion-strong-source" }))
    ]);
    assert.ok(!paperExtractions.extractions.some((extraction) => extraction.paperId === canonicalPaperId(canonicalPaper({ key: "doi:10.1000/promotion-weak-source" }))));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("generic critic fallback text is not used as retrieval query text", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-query-guard-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "What evidence supports benchmark evaluation?",
      researchDirection: "Revise benchmark evaluation evidence.",
      successCriterion: "Cover benchmark evaluation directly."
    }, ["clawresearch", "research-loop"]);

    const gatherer = new EvidenceRecoverySourceGatherer();
    const backend = new GenericSourceSelectionCriticBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: gatherer
    });

    const revisionQueries = gatherer.requests[1]?.revisionQueries ?? [];
    const joinedQueries = revisionQueries.join(" | ");

    assert.equal(exitCode, 0);
    assert.ok(gatherer.requests.length >= 2);
    assert.match(joinedQueries, /benchmark evaluation/i);
    assert.doesNotMatch(joinedQueries, /prior research stage|focused evidence|before release|full manuscript|working critic backend/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("persistent source-selection critic concerns are reported without stopping synthesis", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-critic-source-persistent-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research-agent revision",
      researchQuestion: "Which revision behaviors are reported in autonomous research-agent papers?",
      researchDirection: "Review autonomous research-agent revision behavior.",
      successCriterion: "Produce a grounded review paper."
    }, ["clawresearch", "research-loop"]);

    const backend = new SourceSelectionAlwaysBlockBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceGatherer: new MultiPaperSourceGatherer(3)
    });

    const completedRun = await runStore.load(run.id);
    const critic = JSON.parse(await readFile(completedRun.artifacts.criticSourceSelectionPath, "utf8")) as CriticReviewArtifact;
    const paperExtractions = JSON.parse(await readFile(completedRun.artifacts.paperExtractionsPath, "utf8")) as {
      extractionCount: number;
    };
    const checks = JSON.parse(await readFile(completedRun.artifacts.manuscriptChecksPath, "utf8")) as {
      readinessStatus: string;
      blockerCount: number;
      warningCount: number;
      checks: Array<{ id: string; severity: string; status: string; message: string }>;
    };
    const qualityReport = JSON.parse(await readFile(completedRun.artifacts.qualityReportPath, "utf8")) as {
      evidence: {
        reviewedPapers: number;
        extractedPapers: number;
      };
      critic: {
        finalSatisfaction: string;
        iterations: Array<{ stage: string; iterations: number; finalReadiness: string }>;
      };
    };
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(critic.readiness, "block");
    assert.ok(backend.sourceSelectionCalls >= 2);
    assert.equal(paperExtractions.extractionCount, 3);
    assert.equal(qualityReport.evidence.reviewedPapers, 3);
    assert.equal(qualityReport.evidence.extractedPapers, 3);
    assert.equal(qualityReport.critic.finalSatisfaction, "unresolved");
    assert.ok(qualityReport.critic.iterations.some((item) => item.stage === "source_selection" && item.iterations === backend.sourceSelectionCalls && item.finalReadiness === "block"));
    assert.ok(checks.warningCount > 0);
    assert.ok(checks.checks.some((item) => item.id.includes("critic-source_selection") && item.severity === "warning"));
    assert.ok(!checks.checks.some((item) => item.id.includes("critic-source_selection") && item.severity === "blocker"));
    assert.notEqual(checks.readinessStatus, "blocked");
    assert.match(stdout, /continuing so later evidence, synthesis, and final quality checks can complete/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("release critic block converts an otherwise ready manuscript to status-only", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-critic-release-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research-agent revision",
      researchQuestion: "Which revision behaviors are reported in autonomous research-agent papers?",
      researchDirection: "Review autonomous research-agent revision behavior.",
      successCriterion: "Produce a grounded review paper."
    }, ["clawresearch", "research-loop"]);

    const projectConfigStore = new ProjectConfigStore(projectRoot, now);
    const projectConfig = await projectConfigStore.load();
    projectConfig.sources.localContext.projectFilesEnabled = false;
    await projectConfigStore.save(projectConfig);

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new ReleaseBlockingBackend(),
      sourceGatherer: new MultiPaperSourceGatherer(3)
    });

    const completedRun = await runStore.load(run.id);
    const critic = JSON.parse(await readFile(completedRun.artifacts.criticReleaseReviewPath, "utf8")) as CriticReviewArtifact;
    const checks = JSON.parse(await readFile(completedRun.artifacts.manuscriptChecksPath, "utf8")) as {
      readinessStatus: string;
      blockers: string[];
    };
    const paper = await readFile(completedRun.artifacts.paperPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(critic.readiness, "block");
    assert.equal(checks.readinessStatus, "needs_human_review");
    assert.match(checks.blockers.join(" "), /unresolved review risk/);
    assert.match(paper, /not a released manuscript/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
