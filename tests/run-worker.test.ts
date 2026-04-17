import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LiteratureStore,
  literatureStoreFilePath,
  type CanonicalPaper
} from "../src/runtime/literature-store.js";
import type {
  ResearchBackend,
  ResearchPlanningRequest,
  ResearchPlan,
  ResearchSynthesisRequest,
  ResearchSynthesis
} from "../src/runtime/research-backend.js";
import type {
  ResearchSourceGatherRequest,
  ResearchSourceGatherResult,
  ResearchSourceGatherer
} from "../src/runtime/research-sources.js";
import { MemoryStore, memoryFilePath } from "../src/runtime/memory-store.js";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import { RunStore } from "../src/runtime/run-store.js";
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

class StubResearchBackend implements ResearchBackend {
  readonly label = "stub:research";
  capturedPaperIds: string[] = [];

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

  async synthesizeResearch(request: ResearchSynthesisRequest): Promise<ResearchSynthesis> {
    this.capturedPaperIds = request.papers.map((paper) => paper.id);

    return {
      executiveSummary: "The initial paper pass suggests a small number of recurring technique families, each with clear limitations.",
      themes: [
        {
          title: "Analytic number theory dominates",
          summary: "Most approaches cluster around analytic number theory and the zeta function.",
          sourceIds: ["paper-1"]
        }
      ],
      claims: [
        {
          claim: "Current proof attempts repeatedly return to analytic techniques around the zeta function.",
          evidence: "The retained canonical survey paper emphasizes analytic methods and frames them as central to the problem.",
          sourceIds: ["paper-1"]
        }
      ],
      nextQuestions: [
        "Which proof-technique family has the clearest bounded open subproblem for a first computational or expository follow-up?"
      ]
    };
  }
}

class StubSourceGatherer implements ResearchSourceGatherer {
  async gather(): Promise<ResearchSourceGatherResult> {
    const papers = [
      canonicalPaper()
    ];

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
          authRef: "OPENALEX_API_KEY",
          status: "missing_optional"
        }
      ],
      reviewWorkflow: reviewWorkflowFor(papers)
    };
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

  async synthesizeResearch(): Promise<ResearchSynthesis> {
    return {
      executiveSummary: "The run reused prior literature memory to keep the review centered on mollifier limitations.",
      themes: [],
      claims: [],
      nextQuestions: []
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
    projectConfig.sources.scholarly.selectedProviderIds = ["openalex"];
    projectConfig.sources.background.selectedProviderIds = [];
    projectConfig.sources.local.projectFilesEnabled = false;
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
    const verificationArtifact = JSON.parse(await readFile(completedRun.artifacts.verificationPath, "utf8")) as Record<string, unknown>;
    const literatureStoreContents = await readFile(literatureStoreFilePath(projectRoot), "utf8");
    const memoryContents = await readFile(memoryFilePath(projectRoot), "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.deepEqual(backend.capturedPaperIds, ["paper-1"]);
    assert.match(JSON.stringify(sourcesArtifact), /rawSources/);
    assert.match(JSON.stringify(sourcesArtifact), /mergeDiagnostics/);
    assert.match(JSON.stringify(literatureArtifact), /paper-1/);
    assert.match(JSON.stringify(literatureArtifact), /fulltext_open/);
    assert.match(JSON.stringify(verificationArtifact), /paper-1/);
    assert.match(literatureStoreContents, /"paperCount": 1/);
    assert.match(memoryContents, /paper-1/);
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
    projectConfig.sources.scholarly.selectedProviderIds = ["openalex"];
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
    assert.deepEqual(backend.capturedPaperIds, ["paper-reviewed"]);
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
    projectConfig.sources.scholarly.selectedProviderIds = ["openalex"];
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
    assert.match(stdout, /Reviewed paper: paper-reviewed-preview: Reviewed survey of autonomous research agents/);
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
    projectConfig.sources.scholarly.selectedProviderIds = ["openalex"];
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

test("run worker fails honestly when no canonical papers are retained", async () => {
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
    projectConfig.sources.scholarly.selectedProviderIds = ["openalex"];
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

    assert.equal(exitCode, 1);
    assert.equal(completedRun.status, "failed");
    assert.match(summary, /did not retain any canonical papers/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker fails honestly when retrieval found papers but review retained none for synthesis", async () => {
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
    projectConfig.sources.scholarly.selectedProviderIds = ["openalex"];
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

    assert.equal(exitCode, 1);
    assert.equal(completedRun.status, "failed");
    assert.match(summary, /did not retain any sufficiently reviewed papers/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
