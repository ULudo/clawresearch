import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LiteratureStore,
  literatureStoreFilePath,
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
  ResearchSynthesisRequest,
  ResearchSynthesis,
  ResearchBackendCallOptions
} from "../src/runtime/research-backend.js";
import { ResearchBackendError } from "../src/runtime/research-backend.js";
import type {
  EvidenceMatrix,
  PaperExtraction
} from "../src/runtime/research-evidence.js";
import type { RunController } from "../src/runtime/run-controller.js";
import type {
  ResearchSourceGatherRequest,
  ResearchSourceGatherResult,
  ResearchSourceGatherer
} from "../src/runtime/research-sources.js";
import { MemoryStore, memoryFilePath } from "../src/runtime/memory-store.js";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import { researchDirectionPath, runDirectoryPath, runFilePath, RunStore } from "../src/runtime/run-store.js";
import { runDetachedJobWorker } from "../src/runtime/run-worker.js";

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

class StubResearchBackend implements ResearchBackend {
  readonly label = "stub:research";
  capturedPaperIds: string[] = [];
  capturedExtractionPaperIds: string[] = [];
  capturedMatrixRowCount = 0;

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

  async extractReviewedPapers(request: PaperExtractionRequest): Promise<PaperExtraction[]> {
    this.capturedExtractionPaperIds = request.papers.map((paper) => paper.id);
    return request.papers.map((paper, index) => paperExtraction({
      id: `extraction-${index + 1}`,
      paperId: paper.id,
      runId: request.runId
    }));
  }

  async synthesizeResearch(request: ResearchSynthesisRequest): Promise<ResearchSynthesis> {
    this.capturedPaperIds = request.papers.map((paper) => paper.id);
    this.capturedMatrixRowCount = request.evidenceMatrix.rowCount;
    const sourceIds = request.evidenceMatrix.rows.map((row) => row.paperId);

    return {
      executiveSummary: "The initial paper pass suggests a small number of recurring technique families, each with clear limitations.",
      themes: [
        {
          title: "Analytic number theory dominates",
          summary: "Most approaches cluster around analytic number theory and the zeta function.",
          sourceIds
        }
      ],
      claims: [
        {
          claim: "Current proof attempts repeatedly return to analytic techniques around the zeta function.",
          evidence: "The retained canonical survey paper emphasizes analytic methods and frames them as central to the problem.",
          sourceIds
        }
      ],
      nextQuestions: [
        "Which proof-technique family has the clearest bounded open subproblem for a first computational or expository follow-up?"
      ]
    };
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
          whyNow: "The evidence base is grounded enough for a small comparative work package.",
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
      selectedWorkPackage: {
        id: "wp-1",
        title: "Benchmark technique-family framing",
        mode: "benchmarking",
        objective: "Produce a bounded comparison of the main proof-technique families.",
        hypothesisOrQuestion: "Which proof-technique family offers the clearest bounded next step?",
        methodSketch: "Compare the reviewed technique families against explicit limitations and follow-up tractability.",
        baselines: ["Current survey framing"],
        controls: ["Hold the reviewed canonical paper set fixed"],
        decisiveExperiment: "Produce a comparative note that distinguishes at least two technique families with explicit limits.",
        stopCriterion: "The comparison is either concrete enough to guide a next run or clearly not yet grounded.",
        expectedArtifact: "comparative research note",
        requiredInputs: ["reviewed papers", "run summary"],
        blockedBy: []
      },
      holdReasons: [],
      recommendedHumanDecision: "Inspect the selected work package and continue if it looks suitably bounded."
    };
  }
}

class CapturingRunController implements RunController {
  launchedRuns: Array<{ id: string; stage: string; parentRunId: string | null }> = [];
  private nextPid = 9000;

  launchCommand(run: { id: string; projectRoot: string }): string[] {
    return ["node", "stub-cli.js", "--run-job", run.id, "--project-root", run.projectRoot];
  }

  async launch(run: { id: string; stage: string; parentRunId: string | null }): Promise<number> {
    this.launchedRuns.push({
      id: run.id,
      stage: run.stage,
      parentRunId: run.parentRunId
    });
    const pid = this.nextPid;
    this.nextPid += 1;
    return pid;
  }

  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  isProcessAlive(): boolean {
    return true;
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
      key: `doi:10.1000/recovery-${index + 1}`,
      title: `Recovery test paper ${index + 1}`,
      citation: `Example Author (${2020 + index}). Recovery test paper ${index + 1}.`,
      abstract: `Paper ${index + 1} discusses autonomous research-agent recovery behavior.`,
      year: 2020 + index
    }));

    return {
      notes: [`Collected ${papers.length} recovery-test sources.`],
      sources: [],
      canonicalPapers: papers,
      reviewedPapers: papers,
      routing: {
        domain: "mixed",
        plannedQueries: ["adaptive extraction recovery"],
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
          key: "doi:10.1000/thin-recovery",
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
          recoveryPasses: 0,
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

    assert.ok(request.recoveryQueries?.some((query) => /benchmark evaluation/i.test(query)));
    const papers = Array.from({ length: 3 }, (_, index) => canonicalPaper({
      id: `paper-recovered-${index + 1}`,
      key: `doi:10.1000/recovered-evidence-${index + 1}`,
      title: `Recovered benchmark evaluation paper ${index + 1}`,
      citation: `Example Author (${2021 + index}). Recovered benchmark evaluation paper ${index + 1}.`,
      abstract: `Paper ${index + 1} reports benchmark evaluation evidence for autonomous research agents.`,
      year: 2021 + index
    }));

    return {
      notes: ["Recovered a stronger benchmark-evaluation evidence set."],
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
        recoveryPasses: 0,
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

  async extractReviewedPapers(request: PaperExtractionRequest): Promise<PaperExtraction[]> {
    return request.papers.map((paper, index) => paperExtraction({
      id: `literature-aware-extraction-${index + 1}`,
      paperId: paper.id,
      runId: request.runId,
      systemType: "literature review",
      planningStyle: "memory-guided review"
    }));
  }

  async synthesizeResearch(): Promise<ResearchSynthesis> {
    return {
      executiveSummary: "The run reused prior literature memory to keep the review centered on mollifier limitations.",
      themes: [],
      claims: [],
      nextQuestions: []
    };
  }

  async developResearchAgenda(): Promise<ResearchAgenda> {
    return {
      executiveSummary: "The mollifier-centered literature suggests another bounded literature pass before execution.",
      gaps: [],
      candidateDirections: [],
      selectedDirectionId: null,
      selectedWorkPackage: null,
      holdReasons: ["The reviewed evidence is still too thin for an executable work package."],
      recommendedHumanDecision: "Refine the literature review before continuing."
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
      parentRunId: null,
      derivedFromWorkPackageId: null,
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
        workPackagePath: path.join(runDirectoryPath(projectRoot, runId), "work-package.json"),
        methodPlanPath: path.join(runDirectoryPath(projectRoot, runId), "method-plan.json"),
        executionChecklistPath: path.join(runDirectoryPath(projectRoot, runId), "execution-checklist.json"),
        findingsPath: path.join(runDirectoryPath(projectRoot, runId), "findings.json"),
        decisionPath: path.join(runDirectoryPath(projectRoot, runId), "decision.json"),
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
      selectedWorkPackage: { id: string; title: string } | null;
    };
    const workPackageArtifact = JSON.parse(await readFile(completedRun.artifacts.workPackagePath, "utf8")) as {
      title: string;
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
    const literatureStoreContents = await readFile(literatureStoreFilePath(projectRoot), "utf8");
    const memoryContents = await readFile(memoryFilePath(projectRoot), "utf8");
    const researchDirectionContents = await readFile(researchDirectionPath(projectRoot), "utf8");
    const researchDirection = JSON.parse(researchDirectionContents) as {
      selectedDirectionId: string | null;
      sourceRunId: string | null;
      sourceRunStage: string | null;
      sourceRunAgendaPath: string | null;
      acceptedAt: string | null;
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.deepEqual(backend.capturedPaperIds, [canonicalPaperId(canonicalPaper())]);
    assert.deepEqual(backend.capturedExtractionPaperIds, [canonicalPaperId(canonicalPaper())]);
    assert.equal(backend.capturedMatrixRowCount, 1);
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
    assert.match(paperOutline.structureRationale, /scientific roles/i);
    assert.ok(paperOutline.rhetoricalPlan.some((section) => section.role === "review_method"));
    assert.equal(paperArtifact.schemaVersion, 1);
    assert.equal(paperArtifact.runId, completedRun.id);
    assert.equal(paperArtifact.readinessStatus, "needs_more_evidence");
    assert.deepEqual(paperArtifact.referencedPaperIds, []);
    assert.equal(paperArtifact.claims.length, 0);
    assert.ok(paperArtifact.scientificRoles.includes("status_report"));
    assert.equal(referencesArtifact.schemaVersion, 1);
    assert.equal(referencesArtifact.runId, completedRun.id);
    assert.equal(referencesArtifact.referenceCount, 1);
    assert.equal(referencesArtifact.references[0]?.sourceId, canonicalPaperId(canonicalPaper()));
    assert.equal(manuscriptChecks.schemaVersion, 1);
    assert.equal(manuscriptChecks.runId, completedRun.id);
    assert.equal(manuscriptChecks.readinessStatus, "needs_more_evidence");
    assert.ok(manuscriptChecks.checks.some((check) => check.id === "evidence-matrix-ready" && check.status === "fail"));
    assert.match(paperMarkdown, /No full review manuscript was released/i);
    assert.doesNotMatch(paperMarkdown, new RegExp(`\\[${canonicalPaperId(canonicalPaper())}\\]`));
    assert.equal(evidenceMatrixArtifact.rowCount, 1);
    assert.equal(evidenceMatrixArtifact.rows.length, 1);
    assert.ok(evidenceMatrixArtifact.derivedInsights.length > 0);
    assert.match(JSON.stringify(verificationArtifact), /paper-1/);
    assert.equal(agendaArtifact.selectedDirectionId, "direction-1");
    assert.equal(agendaArtifact.selectedWorkPackage?.id, "wp-1");
    assert.equal(researchDirection.selectedDirectionId, "direction-1");
    assert.equal(researchDirection.sourceRunId, completedRun.id);
    assert.equal(researchDirection.sourceRunStage, "literature_review");
    assert.match(researchDirection.sourceRunAgendaPath ?? "", new RegExp(`${completedRun.id}/agenda\\.json`));
    assert.equal(typeof researchDirection.acceptedAt, "string");
    assert.equal(workPackageArtifact.title, "Benchmark technique-family framing");
    assert.match(agendaMarkdown, /Research Agenda/);
    assert.match(literatureStoreContents, /"paperCount": 1/);
    assert.match(memoryContents, /paper-1/);
    assert.doesNotMatch(memoryContents, /"type": "source"/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker shrinks extraction batches after timeout and checkpoints recovery", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-extraction-recovery-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Autonomous research agents",
      researchQuestion: "How should extraction recover from oversized prompts?",
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

test("run worker autonomously reruns retrieval when manuscript checks need more evidence", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-evidence-recovery-"));
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
      autonomousEvidence: { pass: number; recoveryPasses: number };
    };
    const planArtifact = JSON.parse(await readFile(completedRun.artifacts.planPath, "utf8")) as {
      searchQueries: string[];
    };
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(sourceGatherer.requests.length, 2);
    assert.ok(sourceGatherer.requests[1]?.recoveryQueries?.some((query) => /benchmark evaluation/i.test(query)));
    assert.equal(sourcesArtifact.autonomousEvidence.pass, 2);
    assert.equal(sourcesArtifact.autonomousEvidence.recoveryPasses, 1);
    assert.ok(planArtifact.searchQueries.some((query) => /benchmark evaluation/i.test(query)));
    assert.equal(backend.capturedExtractionPaperIds.length, 3);
    assert.equal(backend.capturedPaperIds.length, 3);
    assert.equal(paper.readinessStatus, "needs_human_review");
    assert.equal(paper.referencedPaperIds.length, 0);
    assert.match(stdout, /Evidence recovery pass 1/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker blocks manuscript generation when extraction cannot recover", async () => {
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

test("run worker auto-continues by creating a derived work-package run when configured", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-auto-continue-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "What bounded follow-up should we pursue next?",
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
    projectConfig.runtime.postReviewBehavior = "auto_continue";
    await projectConfigStore.save(projectConfig);

    const runController = new CapturingRunController();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceGatherer: new StubSourceGatherer(),
      runController
    });

    const runs = await runStore.list();
    const parentRun = await runStore.load(run.id);
    const childRun = runs.find((candidate) => candidate.parentRunId === run.id && candidate.stage === "work_package") ?? null;

    assert.equal(exitCode, 0);
    assert.equal(parentRun.status, "completed");
    assert.ok(childRun);
    assert.equal(childRun?.derivedFromWorkPackageId, "wp-1");
    assert.equal(childRun?.status, "queued");
    assert.ok(childRun?.job.launchCommand?.includes("--run-job"));
    assert.ok(childRun?.job.launchCommand?.includes(childRun.id));
    assert.ok(childRun?.job.launchCommand?.includes("--project-root"));
    assert.ok(childRun?.job.launchCommand?.includes(projectRoot));
    assert.equal(runController.launchedRuns.length, 1);
    assert.equal(runController.launchedRuns[0]?.id, childRun?.id);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("work-package runs write bounded execution artifacts and a decision record", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-work-package-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const literatureRun = await runStore.create({
      topic: "Riemann Hypothesis",
      researchQuestion: "What bounded follow-up should we pursue next?",
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

    await writeFile(path.join(projectRoot, "README.md"), "# Local context\n", "utf8");
    await writeFile(path.join(projectRoot, "reviewed-papers.md"), "Reviewed paper notes\n", "utf8");
    await writeFile(path.join(projectRoot, "run-summary.md"), "Run summary notes\n", "utf8");

    const literatureExitCode = await runDetachedJobWorker({
      projectRoot,
      runId: literatureRun.id,
      version: "0.7.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceGatherer: new StubSourceGatherer()
    });

    assert.equal(literatureExitCode, 0);

    const workPackageRun = await runStore.createWithOptions(
      literatureRun.brief,
      ["clawresearch", "research-loop", "--mode", "work-package", "--work-package-id", "wp-1"],
      {
        stage: "work_package",
        parentRunId: literatureRun.id,
        derivedFromWorkPackageId: "wp-1"
      }
    );

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: workPackageRun.id,
      version: "0.7.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceGatherer: new StubSourceGatherer()
    });

    const completedRun = await runStore.load(workPackageRun.id);
    const methodPlan = JSON.parse(await readFile(completedRun.artifacts.methodPlanPath, "utf8")) as {
      evaluationDesign: string;
      baselines: string[];
    };
    const checklist = JSON.parse(await readFile(completedRun.artifacts.executionChecklistPath, "utf8")) as {
      items: Array<{ title: string }>;
    };
    const findings = JSON.parse(await readFile(completedRun.artifacts.findingsPath, "utf8")) as Array<{ title: string }>;
    const decision = JSON.parse(await readFile(completedRun.artifacts.decisionPath, "utf8")) as {
      outcome: string;
      status: string;
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.stage, "work_package");
    assert.equal(completedRun.status, "completed");
    assert.match(methodPlan.evaluationDesign, /Success is bounded by/i);
    assert.ok(checklist.items.length >= 3);
    assert.ok(findings.length >= 2);
    assert.equal(decision.outcome, "continue");
    assert.equal(decision.status, "active");
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

    assert.equal(exitCode, 0);
    assert.deepEqual(
      backend.capturedPaperIds,
      [canonicalPaperId(canonicalPaper({
        id: "paper-reviewed",
        key: "doi:10.1000/reviewed"
      }))]
    );
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

    const literatureStore = new LiteratureStore(projectRoot, now);
    await literatureStore.upsert({
      papers: [
        {
          key: "doi:10.1000/mollifier",
          title: "Mollifier methods for the Riemann Hypothesis",
          citation: "Example Author (2025). Mollifier methods for the Riemann Hypothesis.",
          abstract: "Survey of mollifier methods and known limitations.",
          year: 2025,
          authors: ["Example Author"],
          venue: "Number Theory Review",
          discoveredVia: ["openalex"],
          identifiers: {
            doi: "10.1000/mollifier"
          },
          bestAccessUrl: "https://example.org/mollifier.pdf",
          bestAccessProvider: "openalex",
          accessMode: "fulltext_open",
          fulltextFormat: "pdf",
          screeningStage: "fulltext",
          screeningDecision: "include",
          runId: "run-prior"
        }
      ],
      themes: [
        {
          key: "Mollifier limitations",
          title: "Mollifier limitations",
          summary: "Prior work suggests mollifier limitations are the clearest bounded follow-up.",
          runId: "run-prior",
          paperIds: [],
          questionTexts: [
            "Which mollifier limitations are most promising for a deeper follow-up?"
          ]
        }
      ]
    });

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
    assert.equal(paper.readinessStatus, "blocked");
    assert.equal(paper.referencedPaperIds.length, 0);
    assert.equal(paper.claims.length, 0);
    assert.equal(references.referenceCount, 0);
    assert.equal(references.references.length, 0);
    assert.equal(checks.readinessStatus, "blocked");
    assert.match(paperMarkdown, /blocked/i);
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
