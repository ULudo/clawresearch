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
  ResearchBackend,
  ResearchPlanningRequest,
  ResearchPlan,
  ResearchBackendCallOptions
} from "../src/runtime/research-backend.js";
import { ResearchBackendError } from "../src/runtime/research-backend.js";
import { workspaceResearchActions } from "../src/runtime/research-agent.js";
import type {
  ResearchActionDecision,
  ResearchActionRequest
} from "../src/runtime/research-agent.js";
import type {
  CriticReviewArtifact,
  CriticReviewRequest
} from "../src/runtime/research-critic.js";
import type {
  ResearchSourceToolRequest,
  ResearchSourceSnapshot,
  ResearchSourceToolAdapter
} from "../src/runtime/research-sources.js";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import { runDirectoryPath, runFilePath, RunStore } from "../src/runtime/run-store.js";
import { runDetachedJobWorker } from "../src/runtime/run-worker.js";
import { loadResearchWorkerState, researchWorkerStatePath } from "../src/runtime/research-state.js";
import {
  createResearchWorkStore,
  loadResearchWorkStore,
  researchWorkStoreFilePath,
  upsertResearchWorkStoreEntities,
  writeResearchWorkStore,
  type ResearchMissionTarget,
  type WorkStoreEntity
} from "../src/runtime/research-work-store.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

async function assertOldPhaseArtifactsAbsent(runDirectory: string): Promise<void> {
  const oldPhaseArtifactNames = [
    "literature-review.json",
    "paper-extractions.json",
    "evidence-matrix.json",
    "synthesis.md",
    "synthesis.json",
    "claims.json",
    "verification.json",
    "paper-outline.json",
    "quality-report.json",
    "next-questions.json",
    "agenda.json",
    "agenda.md",
    "research-journal.json"
  ];

  for (const artifactName of oldPhaseArtifactNames) {
    await assert.rejects(readFile(path.join(runDirectory, artifactName), "utf8"), /ENOENT/);
  }
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

function terminalUserDecisionWorkStore(statusReason: string): ResearchActionDecision["inputs"]["workStore"] {
  return {
    collection: "worker",
    entityId: null,
    filters: {},
    semanticQuery: null,
    limit: null,
    cursor: null,
    changes: {},
    entity: {
      status: "needs_user_decision",
      statusReason: `Choose between scripted test options: ${statusReason}`,
      nextInternalActions: [
        "Keep the scripted test state.",
        "Run another scripted test action."
      ]
    }
  };
}

function sourceSelectionWorkStore(mode: "append" | "replace" | "remove"): ResearchActionDecision["inputs"]["workStore"] {
  return {
    collection: "canonicalSources",
    entityId: null,
    filters: {},
    semanticQuery: null,
    limit: null,
    cursor: null,
    changes: {},
    entity: { mode }
  };
}

function workspaceManuscriptDecisionForRequest(
  request: ResearchActionRequest,
  rationale = "Proceed with the next claim/evidence/section workspace action."
): ResearchActionDecision | null {
  if (request.phase !== "research") {
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
    criticScope: null,
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
      action: "section.create",
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
      action: "section.check_claims",
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
    action: "manuscript.finalize",
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
	      ],
	      notebookPatch: {
	        objective: "Map the main proof-technique families and their limitations.",
	        definitionOfDone: [
	          "Research tasks are tracked in the notebook.",
	          "Central claims are supported by evidence before finalization."
	        ],
	        currentFocus: "Establish the initial research workspace.",
	        readiness: "Not sufficient yet; the notebook has only been initialized before research actions.",
	        tasks: [{
	          id: "task-initialize-research-workspace",
	          title: "Initialize the research workspace and source protocol",
	          status: "in_progress",
	          notes: "This model-authored planning task keeps the run oriented before source, evidence, claim, and section work.",
	          linkedSourceIds: [],
	          linkedExtractionIds: [],
	          linkedEvidenceCellIds: [],
	          linkedClaimIds: [],
	          linkedSectionIds: [],
	          linkedArtifactPaths: []
	        }]
	      }
	    };
	  }

  async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    this.actionRequests.push(request);
    if (request.phase === "research" && (request.workStore?.recentProtocols.length ?? 0) === 0) {
      return {
        schemaVersion: 1,
        action: "protocol.create_or_revise",
        rationale: "Persist the researcher-owned protocol before source work begins.",
        confidence: 0.92,
        inputs: {
          providerIds: [],
          searchQueries: request.plan.searchQueries,
          evidenceTargets: request.plan.localFocus,
          paperIds: [],
          criticScope: null,
          reason: "The protocol should be durable workspace state.",
          workStore: {
            collection: "protocols",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            changes: {},
            entity: {
              id: "protocol-current",
              protocolId: "current-protocol",
              title: "Researcher-authored review protocol",
              objective: request.plan.objective,
              researchQuestion: request.brief.researchQuestion,
              scope: [
                request.brief.researchDirection ?? request.brief.topic ?? request.plan.objective
              ],
              inclusionCriteria: request.plan.localFocus.map((focus) => `Include sources that directly inform ${focus}.`),
              exclusionCriteria: ["Exclude output-style instructions as evidence targets."],
              evidenceTargets: request.plan.localFocus,
              manuscriptConstraints: ["Use traceable support links for manuscript claims."],
              notes: ["Authored through the protocol workspace tool loop."]
            }
          }
        },
        expectedOutcome: "The protocol is visible through the work store.",
        stopCondition: "Continue to source work after the protocol exists.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Checkpoint the model-driven research session after the intended test action.",
      confidence: 0.9,
      inputs: {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticScope: null,
        reason: "Test backend terminal decision.",
        workStore: {
          collection: "worker",
          entityId: null,
          filters: {},
          semanticQuery: null,
          limit: null,
          cursor: null,
          changes: {},
          entity: {
            status: "needs_user_decision",
            statusReason: "Choose whether the scripted test should keep or rerun its final state.",
            nextInternalActions: [
              "Keep the scripted test state.",
              "Run another scripted test action."
            ]
          }
        }
      },
      expectedOutcome: "Stop only through a structured user-decision terminal state.",
      stopCondition: "Structured test decision reached.",
      transport: "strict_json"
    };
  }

}

class ProtocolToolBackend extends StubResearchBackend {
  private protocolCreated = false;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase === "research" && !this.protocolCreated && (request.workStore?.recentProtocols.length ?? 0) === 0) {
      this.actionRequests.push(request);
      this.protocolCreated = true;
      return {
        schemaVersion: 1,
        action: "protocol.create_or_revise",
        rationale: "Persist the researcher-owned review protocol before constructing claims.",
        confidence: 0.91,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: ["agentic tool-loop evidence"],
          paperIds: [],
          criticScope: null,
          reason: "The protocol should be visible as workspace state.",
          workStore: {
            collection: "protocols",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            changes: {},
            entity: {
              id: "protocol-current",
              protocolId: "current-protocol",
              title: "Agentic research protocol",
              objective: "Review evidence for agentic research tool loops.",
              researchQuestion: "How should ClawResearch structure autonomous research work?",
              scope: ["autonomous research agents"],
              inclusionCriteria: ["tool-loop architecture evidence"],
              exclusionCriteria: ["pure output-style constraints"],
              evidenceTargets: ["agentic tool-loop evidence"],
              manuscriptConstraints: ["cite support links"]
            }
          }
        },
        expectedOutcome: "The protocol is persisted as a queryable workspace protocol object.",
        stopCondition: "Continue after the protocol can be read through workspace tools.",
        transport: "strict_json"
      };
    }

    return super.chooseResearchAction(request);
  }
}

class ToolResultAwareSynthesisBackend extends StubResearchBackend {
  readonly synthesisRequests: ResearchActionRequest[] = [];

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }

    this.synthesisRequests.push(request);
    const extractionPreview = request.toolResults
      ?.flatMap((result) => result.items ?? [])
      .find((item) => item.kind === "extraction" && typeof item.sourceId === "string");
    const sourceId = extractionPreview?.sourceId ?? null;
    const claim = request.workStore?.recentClaims[0];
    const section = request.workStore?.recentSections[0];
    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: sourceId === null ? [] : [sourceId],
      criticScope: null,
      reason: null
    };

    if (sourceId === null) {
      return {
        schemaVersion: 1,
        action: "workspace.list",
        rationale: "Inspect extraction previews before creating claims.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "extractions",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: 2,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Return extraction previews for claim construction.",
        stopCondition: "Stop after extraction previews are visible.",
        transport: "strict_json"
      };
    }

    if (claim === undefined) {
      return {
        schemaVersion: 1,
        action: "claim.create",
        rationale: "Use the returned extraction preview to create a grounded claim.",
        confidence: 0.91,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "claims",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              text: "Autonomous research-agent work benefits from durable evidence inspection before synthesis.",
              evidence: extractionPreview?.snippet ?? "Supported by the inspected extraction preview.",
              sourceIds: [sourceId],
              confidence: "medium"
            }
          }
        },
        expectedOutcome: "Create one claim from the visible extraction preview.",
        stopCondition: "The claim is persisted.",
        transport: "strict_json"
      };
    }

    if (section === undefined) {
      return {
        schemaVersion: 1,
        action: "section.create",
        rationale: "Create a section from the grounded claim.",
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
            cursor: null,
            changes: {},
            entity: {
              sectionId: "synthesis",
              role: "synthesis",
              title: "Synthesis",
              paragraph: "The inspected extraction supports a cautious synthesis around durable evidence inspection and claim-led manuscript construction.",
              claimIds: [claim.id],
              sourceIds: claim.sourceIds
            }
          }
        },
        expectedOutcome: "Create a manuscript section linked to the claim.",
        stopCondition: "The section is persisted.",
        transport: "strict_json"
      };
    }

    if (section.status !== "checked") {
      return {
        schemaVersion: 1,
        action: "section.check_claims",
        rationale: "Check section claim support before release.",
        confidence: 0.86,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: section.id,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Mark the section checked when support exists.",
        stopCondition: "The section claim check is persisted.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "manuscript.finalize",
      rationale: "Release checks can evaluate the completed workspace manuscript.",
      confidence: 0.84,
      inputs: {
        ...baseInputs,
        workStore: {
          collection: null,
          entityId: null,
          filters: {},
          semanticQuery: null,
          limit: null,
          cursor: null,
          changes: {},
          entity: {}
        }
      },
      expectedOutcome: "Release checks run against workspace objects.",
      stopCondition: "Stop after release checks.",
      transport: "strict_json"
    };
  }
}

class SupportLinkSynthesisBackend extends StubResearchBackend {
  readonly synthesisRequests: ResearchActionRequest[] = [];
  private lastEvidenceCellPreview: {
    id: string;
    sourceId?: string;
    snippet?: string;
    confidence?: string;
  } | null = null;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }

    this.synthesisRequests.push(request);
    const claim = request.workStore?.recentClaims[0];
    const citation = request.workStore?.recentCitations[0];
    const section = request.workStore?.recentSections[0];
    const visibleEvidenceCell = request.toolResults
      ?.flatMap((result) => result.items ?? [])
      .find((item) => item.id.startsWith("evidence-cell-") && typeof item.sourceId === "string") ?? null;
    if (visibleEvidenceCell !== null) {
      this.lastEvidenceCellPreview = {
        id: visibleEvidenceCell.id,
        sourceId: visibleEvidenceCell.sourceId,
        snippet: visibleEvidenceCell.snippet,
        confidence: visibleEvidenceCell.confidence
      };
    }
    const evidenceCellPreview = this.lastEvidenceCellPreview;
    const sourceId = evidenceCellPreview?.sourceId ?? request.workStore?.recentSources[0]?.id ?? null;
    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: sourceId === null ? [] : [sourceId],
      criticScope: null,
      reason: null
    };

    if (claim === undefined) {
      return {
        schemaVersion: 1,
        action: "claim.create",
        rationale: "Create a claim that must be backed by a later durable support link.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "claims",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              text: "Autonomous research-agent workspaces need durable evidence-to-claim links.",
              evidence: "Autonomous research-agent workspace evidence will be linked to an evidence cell before release.",
              confidence: "medium"
            }
          }
        },
        expectedOutcome: "Persist an initially unsupported claim.",
        stopCondition: "The claim exists in the workspace.",
        transport: "strict_json"
      };
    }

    if (evidenceCellPreview === null && citation === undefined) {
      return {
        schemaVersion: 1,
        action: "workspace.list",
        rationale: "Find an evidence cell to support the claim.",
        confidence: 0.88,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "evidenceCells",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: 3,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Return evidence-cell previews with ids and snippets.",
        stopCondition: "Stop after evidence-cell previews are visible.",
        transport: "strict_json"
      };
    }

    if (citation === undefined) {
      return {
        schemaVersion: 1,
        action: "claim.link_support",
        rationale: "Attach the selected evidence cell as durable, citation-renderable claim support.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "citations",
            entityId: claim.id,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              evidenceCellId: evidenceCellPreview?.id,
              sourceId,
              supportSnippet: evidenceCellPreview?.snippet,
              confidence: evidenceCellPreview?.confidence ?? "medium",
              relevance: "direct support"
            }
          }
        },
        expectedOutcome: "Create a durable support link with provenance.",
        stopCondition: "The support link exists in the citations collection.",
        transport: "strict_json"
      };
    }

    if (section === undefined) {
      return {
        schemaVersion: 1,
        action: "section.create",
        rationale: "Create a manuscript section using the supported claim.",
        confidence: 0.87,
        inputs: {
          ...baseInputs,
          paperIds: [citation.sourceId],
          workStore: {
            collection: "manuscriptSections",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              sectionId: "synthesis",
              role: "synthesis",
              title: "Synthesis",
              paragraph: "Durable evidence-to-claim links make manuscript references renderable from workspace state.",
              claimIds: [claim.id],
              sourceIds: [citation.sourceId]
            }
          }
        },
        expectedOutcome: "Create a manuscript section linked to the supported claim.",
        stopCondition: "The section exists.",
        transport: "strict_json"
      };
    }

    if (section.status !== "checked") {
      return {
        schemaVersion: 1,
        action: "section.check_claims",
        rationale: "Check the supported section before release.",
        confidence: 0.86,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: section.id,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Mark the section checked.",
        stopCondition: "The section claim check is persisted.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "manuscript.finalize",
      rationale: "Release checks can now render references from support links.",
      confidence: 0.85,
      inputs: {
        ...baseInputs,
        workStore: {
          collection: null,
          entityId: null,
          filters: {},
          semanticQuery: null,
          limit: null,
          cursor: null,
          changes: {},
          entity: {}
        }
      },
      expectedOutcome: "Release checks pass.",
      stopCondition: "Stop after release checks.",
      transport: "strict_json"
    };
  }
}

class MismatchedSupportSynthesisBackend extends StubResearchBackend {
  private readonly evidencePreviews: Array<{ id: string; sourceId: string; snippet?: string; confidence?: string }> = [];

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }

    for (const item of request.toolResults?.flatMap((result) => result.items ?? []) ?? []) {
      if (item.id.startsWith("evidence-cell-") && typeof item.sourceId === "string" && !this.evidencePreviews.some((preview) => preview.id === item.id)) {
        this.evidencePreviews.push({
          id: item.id,
          sourceId: item.sourceId,
          snippet: item.snippet,
          confidence: item.confidence
        });
      }
    }

    const claim = request.workStore?.recentClaims[0];
    const citation = request.workStore?.recentCitations[0];
    const section = request.workStore?.recentSections[0];
    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };

    if (claim === undefined) {
      return {
        schemaVersion: 1,
        action: "claim.create",
        rationale: "Create a claim for support-readiness validation.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "claims",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              text: "Support readiness must reject mismatched evidence provenance.",
              evidence: "This claim intentionally receives a mismatched support link for validation.",
              confidence: "medium"
            }
          }
        },
        expectedOutcome: "Create a claim.",
        stopCondition: "The claim exists.",
        transport: "strict_json"
      };
    }

    if (this.evidencePreviews.length < 12) {
      return {
        schemaVersion: 1,
        action: "workspace.list",
        rationale: "Inspect enough evidence cells to find cells from different sources.",
        confidence: 0.88,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "evidenceCells",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: 20,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Return evidence-cell previews.",
        stopCondition: "Evidence-cell previews are visible.",
        transport: "strict_json"
      };
    }

    const first = this.evidencePreviews[0];
    const mismatched = this.evidencePreviews.find((preview) => preview.sourceId !== first?.sourceId);
    if (citation === undefined && first !== undefined) {
      return {
        schemaVersion: 1,
        action: "claim.link_support",
        rationale: "Create an initially valid support link.",
        confidence: 0.88,
        inputs: {
          ...baseInputs,
          paperIds: [first.sourceId],
          workStore: {
            collection: "citations",
            entityId: claim.id,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              evidenceCellId: first.id,
              sourceId: first.sourceId,
              supportSnippet: first.snippet,
              confidence: first.confidence ?? "medium",
              relevance: "direct support"
            }
          }
        },
        expectedOutcome: "Create a support link.",
        stopCondition: "Support link exists.",
        transport: "strict_json"
      };
    }

    if (citation !== undefined && mismatched !== undefined && citation.evidenceCellId !== mismatched.id) {
      return {
        schemaVersion: 1,
        action: "workspace.patch",
        rationale: "Corrupt the support link to simulate mismatched evidence provenance.",
        confidence: 0.7,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "citations",
            entityId: citation.id,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {
              evidenceCellId: mismatched.id,
              supportSnippet: mismatched.snippet ?? "Mismatched evidence snippet from another source."
            },
            entity: {}
          }
        },
        expectedOutcome: "Persist a deliberately invalid support link.",
        stopCondition: "The citation has mismatched evidence provenance.",
        transport: "strict_json"
      };
    }

    if (section === undefined && citation !== undefined) {
      return {
        schemaVersion: 1,
        action: "section.create",
        rationale: "Create a section using the claim with invalid support provenance.",
        confidence: 0.82,
        inputs: {
          ...baseInputs,
          paperIds: [citation.sourceId],
          workStore: {
            collection: "manuscriptSections",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              sectionId: "synthesis",
              role: "synthesis",
              title: "Synthesis",
              paragraph: "This section should not pass release because support provenance is mismatched.",
              claimIds: [claim.id],
              sourceIds: [citation.sourceId]
            }
          }
        },
        expectedOutcome: "Create a section.",
        stopCondition: "Section exists.",
        transport: "strict_json"
      };
    }

    if (section !== undefined && section.status !== "needs_revision") {
      return {
        schemaVersion: 1,
        action: "section.check_claims",
        rationale: "Run support-readiness checks on the section.",
        confidence: 0.86,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: section.id,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "The section should need revision.",
        stopCondition: "Section support state is updated.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "manuscript.finalize",
      rationale: "Let release checks report the support-readiness blocker.",
      confidence: 0.8,
      inputs: {
        ...baseInputs,
        workStore: {
          collection: null,
          entityId: null,
          filters: {},
          semanticQuery: null,
          limit: null,
          cursor: null,
          changes: {},
          entity: {}
        }
      },
      expectedOutcome: "Release remains blocked by invalid support.",
      stopCondition: "Stop after release checks.",
      transport: "strict_json"
    };
  }
}

class RevisionThenWorkspaceBackend extends StubResearchBackend {
  private requestedEvidenceRevision = false;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase === "research" && !this.requestedEvidenceRevision) {
      this.actionRequests.push(request);
      this.requestedEvidenceRevision = true;
      return {
        schemaVersion: 1,
        action: "source.search",
        rationale: "Before drafting claims, gather one more targeted evidence pass around benchmark evaluation.",
        confidence: 0.87,
        inputs: {
          providerIds: ["openalex"],
          searchQueries: ["autonomous research agents benchmark evaluation"],
          evidenceTargets: ["benchmark evaluation"],
          paperIds: [],
          criticScope: null,
          reason: null
        },
        expectedOutcome: "Strengthen the reviewed evidence set before manuscript construction.",
        stopCondition: "Return to manuscript construction after the evidence pass.",
        transport: "strict_json"
      };
    }

    return super.chooseResearchAction(request);
  }
}

class EvidenceTargetOnlyRevisionBackend extends StubResearchBackend {
  private requestedEvidenceRevision = false;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase === "research" && !this.requestedEvidenceRevision) {
      this.actionRequests.push(request);
      this.requestedEvidenceRevision = true;
      return {
        schemaVersion: 1,
        action: "source.search",
        rationale: "Signal a semantic evidence gap without giving explicit search query text.",
        confidence: 0.82,
        inputs: {
          providerIds: ["openalex"],
          searchQueries: [],
          evidenceTargets: ["benchmark evaluation"],
          paperIds: [],
          criticScope: null,
          reason: null
        },
        expectedOutcome: "The runtime should not invent a recovery query from this target.",
        stopCondition: "Continue with visible diagnostics.",
        transport: "strict_json"
      };
    }

    return super.chooseResearchAction(request);
  }
}

class SourceToolBackend extends StubResearchBackend {
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
    if (request.phase === "research") {
      this.sourceActionRequests.push(request);
      const sourceState = request.sourceState;
      const baseInputs = {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticScope: null,
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
            criticScope: null,
            reason: null
          },
          expectedOutcome: "Retrieve full-text-accessible candidate literature from arXiv.",
          stopCondition: "Stop this action after the arXiv result is screened.",
          transport: "strict_json"
        };
      } else if (sourceState.canonicalMergeCompleted !== true) {
        action = {
          schemaVersion: 1,
          action: "source.merge",
          rationale: "The retrieved hits should be merged into canonical papers before access resolution and evidence selection.",
          confidence: 0.88,
          inputs: baseInputs,
          expectedOutcome: "Canonical papers are available in source state.",
          stopCondition: "Stop when canonical merge completes.",
          transport: "strict_json"
        };
      } else if (sourceState.resolvedPaperIds.length === 0) {
        action = {
          schemaVersion: 1,
          action: "source.resolve_access",
          rationale: "Resolve access only for the currently visible candidate papers.",
          confidence: 0.85,
          inputs: {
            ...baseInputs,
            paperIds: sourceState.candidatePaperIds
          },
          expectedOutcome: "Candidate paper access metadata is resolved.",
          stopCondition: "Stop after targeted access resolution.",
          transport: "strict_json"
        };
      } else if ((sourceState.selectedPapers ?? 0) === 0) {
        action = {
          schemaVersion: 1,
          action: "source.select_evidence",
          rationale: "Access-resolved candidates are ready for the synthesis evidence set.",
          confidence: 0.86,
          inputs: {
            ...baseInputs,
            paperIds: sourceState.resolvedPaperIds.length > 0 ? sourceState.resolvedPaperIds : sourceState.candidatePaperIds,
            workStore: sourceSelectionWorkStore("replace")
          },
          expectedOutcome: "Select the current evidence set.",
          stopCondition: "Stop after the evidence set has been checkpointed.",
          transport: "strict_json"
        };
      } else {
        action = {
          schemaVersion: 1,
          action: "workspace.status",
          rationale: "Checkpoint after the researcher-selected source tool sequence.",
          confidence: 0.86,
          inputs: {
            ...baseInputs,
            reason: "Source tool smoke run complete.",
            workStore: terminalUserDecisionWorkStore("Source tool smoke run complete.")
          },
          expectedOutcome: "Stop only through a structured user-decision terminal state.",
          stopCondition: "Structured test decision reached.",
          transport: "strict_json"
        };
      }

      this.sourceActions.push(action);
      return action;
    }

    return super.chooseResearchAction(request);
  }
}

class UnknownEvidenceSelectionBackend extends SourceToolBackend {
  private attemptedUnknownSelection = false;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase === "research" && this.attemptedUnknownSelection) {
      this.sourceActionRequests.push(request);
      const action: ResearchActionDecision = {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "Checkpoint after the unknown id selection was visibly rejected.",
        confidence: 0.8,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: "Unknown evidence selection test complete.",
          workStore: terminalUserDecisionWorkStore("Unknown evidence selection test complete.")
        },
        expectedOutcome: "Stop only through a structured user-decision terminal state.",
        stopCondition: "Structured test decision reached.",
        transport: "strict_json"
      };
      this.sourceActions.push(action);
      return action;
    }

    if (request.phase === "research" && (request.sourceState?.resolvedPaperIds.length ?? 0) > 0) {
      this.attemptedUnknownSelection = true;
      this.sourceActionRequests.push(request);
      const action: ResearchActionDecision = {
        schemaVersion: 1,
        action: "source.select_evidence",
        rationale: "Intentionally select an unknown paper id to prove the runtime does not substitute fallback evidence.",
        confidence: 0.8,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: ["paper-does-not-exist"],
          criticScope: null,
          reason: null,
          workStore: sourceSelectionWorkStore("append")
        },
        expectedOutcome: "Unknown ids are rejected visibly.",
        stopCondition: "Stop after the selection attempt.",
        transport: "strict_json"
      };
      this.sourceActions.push(action);
      return action;
    }

    return super.chooseResearchAction(request);
  }
}

class WorkStoreFirstSourceBackend extends SourceToolBackend {
  private createdWorkItem = false;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase === "research" && !this.createdWorkItem) {
      this.createdWorkItem = true;
      this.sourceActionRequests.push(request);
      const action: ResearchActionDecision = {
        schemaVersion: 1,
        action: "workspace.create",
        rationale: "Record a durable source-screening work item before querying the provider.",
        confidence: 0.83,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
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
  readonly sourceActionRequests: ResearchActionRequest[] = [];

  async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Review autonomous research-agent harness architectures and evaluation practices.",
      rationale: "The model starts with a repeated source-search strategy and should receive factual search-result counts.",
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
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }

    this.sourceActionRequests.push(request);
    const sourceState = request.sourceState;
    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };
    let action: ResearchActionDecision;

    if ((sourceState?.selectedPapers ?? 0) > 0) {
      action = {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "Checkpoint after selected sources are persisted.",
        confidence: 0.84,
        inputs: {
          ...baseInputs,
          reason: "Source dashboard test complete.",
          workStore: terminalUserDecisionWorkStore("Source dashboard test complete.")
        },
        expectedOutcome: "Stop only through a structured user-decision terminal state.",
        stopCondition: "Structured test decision reached.",
        transport: "strict_json"
      };
    } else if (sourceState?.canonicalMergeCompleted === true) {
      action = {
        schemaVersion: 1,
        action: "source.select_evidence",
        rationale: "Canonical sources are ready for explicit evidence selection.",
        confidence: 0.82,
        inputs: {
          ...baseInputs,
          paperIds: sourceState.resolvedPaperIds.length > 0 ? sourceState.resolvedPaperIds : sourceState.candidatePaperIds,
          workStore: sourceSelectionWorkStore("replace")
        },
        expectedOutcome: "Selected evidence set.",
        stopCondition: "Stop after selection.",
        transport: "strict_json"
      };
    } else if ((sourceState?.repeatedSearchFacts.length ?? 0) > 0 || (sourceState?.consecutiveNoProgressSearches ?? 0) >= 2) {
      action = {
        schemaVersion: 1,
        action: "source.merge",
        rationale: "The source dashboard shows repeated provider/query search counts, so merge the screened sources.",
        confidence: 0.84,
        inputs: baseInputs,
        expectedOutcome: "Canonical papers are available.",
        stopCondition: "Stop when canonical merge completes.",
        transport: "strict_json"
      };
    } else {
      action = {
        schemaVersion: 1,
        action: "source.search",
        rationale: "Repeat the same arXiv query.",
        confidence: 0.74,
        inputs: {
          providerIds: ["arxiv"],
          searchQueries: ["autonomous research agent harness architecture evaluation"],
          evidenceTargets: ["architecture", "evaluation"],
          paperIds: [],
          criticScope: null,
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
  readonly sourceActionRequests: ResearchActionRequest[] = [];

  async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Review autonomous research-agent harness architectures and evaluation practices.",
      rationale: "The model ignores source-dashboard facts, so the runtime must not fabricate later source steps.",
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
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.sourceActionRequests.push(request);

    if (this.sourceActions.length >= 3) {
      const action: ResearchActionDecision = {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "End the scripted test after repeated source searches were still executed.",
        confidence: 0.78,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: "Repeated search fact test complete.",
          workStore: terminalUserDecisionWorkStore("Repeated search fact test complete.")
        },
        expectedOutcome: "Stop only through a structured user-decision terminal state.",
        stopCondition: "Structured test decision reached.",
        transport: "strict_json"
      };
      this.sourceActions.push(action);
      return action;
    }

    const action: ResearchActionDecision = {
      schemaVersion: 1,
      action: "source.search",
      rationale: "Keep searching the same provider even after dashboard warnings.",
      confidence: 0.65,
      inputs: {
        providerIds: ["arxiv"],
        searchQueries: ["autonomous research agent harness architecture evaluation"],
        evidenceTargets: ["architecture", "evaluation"],
        paperIds: [],
        criticScope: null,
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

class ProviderlessSourceSearchBackend extends StubResearchBackend {
  readonly sourceActions: ResearchActionDecision[] = [];
  private attemptedProviderlessSearch = false;

  async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Test that source.search requires explicit provider choices.",
      rationale: "The runtime should not choose a fallback provider for the researcher.",
      searchQueries: [
        "autonomous research agent harness architecture evaluation"
      ],
      localFocus: [
        "provider choice"
      ]
    };
  }

  async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }

    if (this.attemptedProviderlessSearch) {
      const action: ResearchActionDecision = {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "Checkpoint after the providerless search no-op was observed.",
        confidence: 0.78,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: "Providerless source search test complete.",
          workStore: terminalUserDecisionWorkStore("Providerless source search test complete.")
        },
        expectedOutcome: "Stop only through a structured user-decision terminal state.",
        stopCondition: "Structured test decision reached.",
        transport: "strict_json"
      };
      this.sourceActions.push(action);
      return action;
    }

    this.attemptedProviderlessSearch = true;
    const action: ResearchActionDecision = {
      schemaVersion: 1,
      action: "source.search",
      rationale: "Try a search without provider ids to prove the runtime does not pick one.",
      confidence: 0.72,
      inputs: {
        providerIds: [],
        searchQueries: ["autonomous research agent harness architecture evaluation"],
        evidenceTargets: ["provider choice"],
        paperIds: [],
        criticScope: null,
        reason: null
      },
      expectedOutcome: "The runtime returns a no-op observation instead of querying a fallback provider.",
      stopCondition: "Stop after the no-op observation.",
      transport: "strict_json"
    };
    this.sourceActions.push(action);
    return action;
  }
}

class StubSourceToolAdapter implements ResearchSourceToolAdapter {
  async run(): Promise<ResearchSourceSnapshot> {
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
          configuredFieldIds: [],
          missingRequiredFieldIds: [],
          missingOptionalFieldIds: ["api_key"],
          status: "missing_optional"
        }
      ],
      reviewWorkflow: reviewWorkflowFor(papers)
    };
  }
}

class MultiPaperSourceToolAdapter implements ResearchSourceToolAdapter {
  constructor(private readonly count: number) {}

  async run(): Promise<ResearchSourceSnapshot> {
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

class EvidenceRecoverySourceToolAdapter implements ResearchSourceToolAdapter {
  requests: ResearchSourceToolRequest[] = [];

  async run(request: ResearchSourceToolRequest): Promise<ResearchSourceSnapshot> {
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
        }
      };
    }

    assert.ok((request.revisionQueries?.length ?? 0) > 0);
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
      }
    };
  }
}

class UsefulThenEmptySourceToolAdapter implements ResearchSourceToolAdapter {
  readonly requests: ResearchSourceToolRequest[] = [];

  async run(request: ResearchSourceToolRequest): Promise<ResearchSourceSnapshot> {
    this.requests.push(request);

    if (this.requests.length > 1) {
      return {
        notes: ["Targeted revision pass returned no selected sources."],
        sources: [],
        canonicalPapers: [],
        reviewedPapers: [],
        routing: {
          domain: "mixed",
          plannedQueries: request.revisionQueries ?? request.plan.searchQueries,
          discoveryProviderIds: ["openalex"],
          resolverProviderIds: [],
          acquisitionProviderIds: ["openalex"]
        },
        mergeDiagnostics: [],
        authStatus: [],
        reviewWorkflow: reviewWorkflowFor([])
      };
    }

    const papers = Array.from({ length: 3 }, (_, index) => canonicalPaper({
      id: `paper-useful-${index + 1}`,
      key: `doi:10.1000/useful-evidence-${index + 1}`,
      title: `Useful autonomous research-agent evidence paper ${index + 1}`,
      citation: `Example Author (${2022 + index}). Useful autonomous research-agent evidence paper ${index + 1}.`,
      abstract: `Paper ${index + 1} reports benchmark and evaluation evidence for autonomous research-agent workspaces.`,
      year: 2022 + index
    }));

    return {
      notes: ["Collected a useful initial reviewed set."],
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
      reviewWorkflow: reviewWorkflowFor(papers)
    };
  }
}

class CriticExclusionSourceToolAdapter implements ResearchSourceToolAdapter {
  requests: ResearchSourceToolRequest[] = [];

  async run(request: ResearchSourceToolRequest): Promise<ResearchSourceSnapshot> {
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
      }
    };
  }
}

class CriticPromotionSourceToolAdapter implements ResearchSourceToolAdapter {
  requests: ResearchSourceToolRequest[] = [];

  async run(request: ResearchSourceToolRequest): Promise<ResearchSourceSnapshot> {
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
      }
    };
  }
}

class NoEvidenceSourceToolAdapter implements ResearchSourceToolAdapter {
  async run(): Promise<ResearchSourceSnapshot> {
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
      objective: "Use prior literature context to continue the mollifier-focused review.",
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
    if (request.phase === "research" && (request.workStore?.recentSections.length ?? 0) > 0) {
      return {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "Checkpoint after prior literature context has been used to create durable claim and section state.",
        confidence: 0.86,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: "Literature-aware model-driven session checkpoint.",
          workStore: terminalUserDecisionWorkStore("Literature-aware model-driven session checkpoint.")
        },
        expectedOutcome: "Stop only through a structured user-decision terminal state.",
        stopCondition: "Structured test decision reached.",
        transport: "strict_json"
      };
    }

    const workspaceDecision = workspaceManuscriptDecisionForRequest(
      request,
      "Use the claim/evidence/section tool loop to continue the literature-aware run."
    );
    if (workspaceDecision !== null) {
      return workspaceDecision;
    }

    return {
      schemaVersion: 1,
      action: request.allowedActions[0] ?? "workspace.status",
      rationale: "Use the structured action loop to continue the literature-aware run.",
      confidence: 0.9,
      inputs: {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticScope: null,
        reason: null
      },
      expectedOutcome: "Continue with the next checkpointed artifact.",
      stopCondition: "The artifact is written.",
      transport: "strict_json"
    };
  }

}

class LiteratureAwareSourceToolAdapter implements ResearchSourceToolAdapter {
  async run(request: ResearchSourceToolRequest): Promise<ResearchSourceSnapshot> {
    assert.equal(request.literatureContext?.available, true);
    assert.match(request.literatureContext?.papers[0]?.title ?? "", /mollifier/i);
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
        "Used prior literature context to focus retrieval on mollifier methods."
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

class ArchitectureForbiddenWorkflowBackend extends StubResearchBackend {
  extractionCalls = 0;
  readonly criticScopes: string[] = [];
}

class PlanningProviderOverloadBackend extends StubResearchBackend {
  override async planResearch(): Promise<ResearchPlan> {
    throw new ResearchBackendError(
      "http",
      "planning",
      "openai-codex planning provider unavailable: Our servers are currently overloaded. Please try again later.",
      null
    );
  }
}

class FailingCriticBackend extends StubResearchBackend {
  readonly capabilities = {
    actionControl: {
      nativeToolCalls: false,
      strictJsonFallback: true
    },
    criticReview: true
  };
  readonly researchRequests: ResearchActionRequest[] = [];
  private reviewed = false;
  private stopped = false;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);
    if (!this.reviewed) {
      this.reviewed = true;
      return {
        schemaVersion: 1,
        action: "critic.review",
        rationale: "Call critic explicitly to test durable critic failure visibility.",
        confidence: 0.9,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: "release",
          reason: null,
          workStore: {
            collection: null,
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Critic failure is persisted visibly.",
        stopCondition: "Continue after observing failed critic transport.",
        transport: "strict_json"
      };
    }
    if (!this.stopped) {
      this.stopped = true;
      return {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "Stop after critic failure visibility is observed.",
        confidence: 0.8,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: "Critic failure visibility test complete.",
          workStore: terminalUserDecisionWorkStore("Critic failure visibility test complete.")
        },
        expectedOutcome: "Stop through structured test decision.",
        stopCondition: "Structured test decision reached.",
        transport: "strict_json"
      };
    }
    return super.chooseResearchAction(request);
  }

  async reviewResearchArtifact(): Promise<CriticReviewArtifact> {
    throw new ResearchBackendError("http", "critic", "critic provider unavailable in test", null);
  }
}

class RepeatedCriticBackend extends StubResearchBackend {
  readonly capabilities = {
    actionControl: {
      nativeToolCalls: false,
      strictJsonFallback: true
    },
    criticReview: true
  };
  readonly researchRequests: ResearchActionRequest[] = [];
  private reviewCount = 0;
  private stopped = false;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);
    if (this.reviewCount < 2) {
      return {
        schemaVersion: 1,
        action: "critic.review",
        rationale: "Call the same critic stage again so the latest review replaces stale readiness.",
        confidence: 0.9,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: "release",
          reason: null,
          workStore: {
            collection: null,
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "The repeated critic artifact link reflects the newest readiness.",
        stopCondition: "Continue after observing the repeated critic review.",
        transport: "strict_json"
      };
    }
    if (!this.stopped) {
      this.stopped = true;
      return {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "Stop after repeated critic review visibility is observed.",
        confidence: 0.8,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: "Repeated critic review visibility test complete.",
          workStore: terminalUserDecisionWorkStore("Repeated critic review visibility test complete.")
        },
        expectedOutcome: "Stop through structured test decision.",
        stopCondition: "Structured test decision reached.",
        transport: "strict_json"
      };
    }
    return super.chooseResearchAction(request);
  }

  async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    this.reviewCount += 1;
    const readiness = this.reviewCount === 1 ? "revise" : "pass";
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness,
      confidence: 0.82,
      summary: `Repeated critic review ${this.reviewCount} returns ${readiness}.`,
      objections: readiness === "revise"
        ? [{
          code: "repeat-review-revise",
          severity: "major",
          target: "manuscript",
          targetId: null,
          message: "The first review asks for revision.",
          affectedPaperIds: [],
          affectedEvidenceCellIds: [],
          affectedClaimIds: [],
          affectedSectionIds: [],
          suggestedRevision: "Run the critic again after revision."
        }]
        : [],
      positiveFindings: [],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      },
      recommendedNextActions: readiness === "revise" ? ["Revise before release."] : []
    };
  }
}

class NotebookToolBackend extends StubResearchBackend {
  private patched = false;
  private read = false;
  readonly researchRequests: ResearchActionRequest[] = [];

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };

    if (!this.patched) {
      this.patched = true;
      return {
        schemaVersion: 1,
        action: "notebook.patch",
        rationale: "Keep the research objective and task list alive in the visible notebook.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: null,
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              objective: "Produce a professional review of model-driven research workspaces.",
              definitionOfDone: [
                "Representative sources are extracted.",
                "Central claims are supported by citations.",
                "The final manuscript is finalized only after checks pass."
              ],
              currentFocus: "Create the synthesis task list.",
              readiness: "Not sufficient yet; only the task scaffold exists.",
              tasks: [{
                id: "task-build-synthesis",
                title: "Build claim-led synthesis from selected evidence",
                status: "todo",
                notes: "Use workspace reads before writing claims.",
                linkedEvidenceCellIds: ["evidence-cell-planned"],
                linkedArtifactPaths: ["research-notes/synthesis-plan.md"]
              }]
            }
          }
        },
        expectedOutcome: "Notebook stores objective, definition of done, and linked task metadata.",
        stopCondition: "Continue after the notebook is updated.",
        transport: "strict_json"
      };
    }

    if (!this.read) {
      this.read = true;
      return {
        schemaVersion: 1,
        action: "notebook.read",
        rationale: "Inspect the notebook summary before deciding the next action.",
        confidence: 0.86,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: null,
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Notebook read returns visible task state.",
        stopCondition: "Continue after the notebook observation.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "End the scripted notebook smoke test with a structured user decision.",
      confidence: 0.8,
      inputs: {
        ...baseInputs,
        reason: "Notebook test complete.",
        workStore: terminalUserDecisionWorkStore("Notebook smoke test complete.")
      },
      expectedOutcome: "Stop only through a structured test terminal state.",
      stopCondition: "Structured test decision reached.",
      transport: "strict_json"
    };
  }
}

class InvalidStatusThenDecisionBackend extends StubResearchBackend {
  readonly sourceActions: ResearchActionDecision[] = [];

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }

    const action: ResearchActionDecision = this.sourceActions.length === 0 ? {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Try to mark the work externally blocked without a concrete external blocker record.",
      confidence: 0.8,
      inputs: {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticScope: null,
        reason: null,
        workStore: {
          collection: "worker",
          entityId: null,
          filters: {},
          semanticQuery: null,
          limit: 5,
          cursor: null,
          changes: {},
          entity: {
            status: "externally_blocked",
            statusReason: "The evidence is not good enough yet."
          }
        }
      },
      expectedOutcome: "Runtime should reject the terminal status and return an observation.",
      stopCondition: "Continue because the status is not externally validated.",
      transport: "strict_json"
    } : {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Ask for a real user decision with explicit options after the invalid status was rejected.",
      confidence: 0.8,
      inputs: {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticScope: null,
        reason: null,
        workStore: {
          collection: "worker",
          entityId: null,
          filters: {},
          semanticQuery: null,
          limit: 5,
          cursor: null,
          changes: {},
          entity: {
            status: "needs_user_decision",
            statusReason: "Choose whether to broaden the objective beyond the confirmed scope.",
            nextInternalActions: [
              "Keep the confirmed scope and continue source work.",
              "Broaden the objective to adjacent domains."
            ]
          }
        }
      },
      expectedOutcome: "Stop only for the structured user decision.",
      stopCondition: "Needs user decision with explicit options.",
      transport: "strict_json"
    };
    this.sourceActions.push(action);
    return action;
  }
}

async function seedCanonicalWorkspaceSource(input: {
  projectRoot: string;
  runId: string;
  brief: Parameters<typeof createResearchWorkStore>[0]["brief"];
  now: () => string;
  sourceId?: string;
}): Promise<string> {
  const sourceId = input.sourceId ?? "source-agentic-tool-runtime";
  const timestamp = input.now();
  const workStore = upsertResearchWorkStoreEntities(createResearchWorkStore({
    projectRoot: input.projectRoot,
    brief: input.brief,
    now: timestamp
  }), [{
    id: sourceId,
    kind: "canonicalSource" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    key: "doi:10.5555/agentic-tool-runtime",
    title: "Agentic research tool runtimes for scientific synthesis",
    citation: "Example Author (2026). Agentic research tool runtimes for scientific synthesis.",
    abstract: "Describes explicit model-selected source, evidence, claim, critic, and release tools for scientific synthesis.",
    year: 2026,
    authors: ["Example Author"],
    venue: "Journal of Agentic Research Systems",
    providerIds: ["test"],
    identifiers: {
      doi: "10.5555/agentic-tool-runtime",
      pmid: null,
      pmcid: null,
      arxivId: null
    },
    accessMode: "fulltext_open",
    bestAccessUrl: "https://example.org/agentic-tool-runtime.pdf",
    screeningDecision: "include",
    screeningRationale: "Seeded test source for explicit researcher-tool execution.",
    tags: ["agentic-runtime"]
  }], timestamp);
  await writeResearchWorkStore(workStore);
  return sourceId;
}

async function seedThinReviewWorkspace(input: {
  projectRoot: string;
  runId: string;
  brief: Parameters<typeof createResearchWorkStore>[0]["brief"];
  now: () => string;
  missionTarget: ResearchMissionTarget;
  sourceCount?: number;
  extractedCount?: number;
  evidenceCount?: number;
  citedCount?: number;
}): Promise<void> {
  const timestamp = input.now();
  const sourceCount = input.sourceCount ?? 22;
  const extractedCount = Math.min(input.extractedCount ?? 19, sourceCount);
  const evidenceCount = Math.min(input.evidenceCount ?? 8, extractedCount);
  const citedCount = Math.min(input.citedCount ?? 3, evidenceCount);
  const sourceIds = Array.from({ length: sourceCount }, (_, index) => `source-review-${index + 1}`);
  const extractedSourceIds = sourceIds.slice(0, extractedCount);
  const evidenceSourceIds = sourceIds.slice(0, evidenceCount);
  const citedSourceIds = sourceIds.slice(0, citedCount);
  const canonicalSources: WorkStoreEntity[] = sourceIds.map((sourceId, index) => ({
    id: sourceId,
    kind: "canonicalSource" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    key: `doi:10.5555/thin-review-${index + 1}`,
    title: `Representative research workspace paper ${index + 1}`,
    citation: `Author ${index + 1} (2026). Representative research workspace paper ${index + 1}.`,
    abstract: "A representative source used to test artifact-contract finalization.",
    year: 2026,
    authors: [`Author ${index + 1}`],
    venue: "Workspace Review Journal",
    providerIds: ["test"],
    identifiers: {
      doi: `10.5555/thin-review-${index + 1}`,
      pmid: null,
      pmcid: null,
      arxivId: null
    },
    accessMode: "fulltext_open",
    bestAccessUrl: `https://example.org/thin-review-${index + 1}.pdf`,
    screeningDecision: "include",
    screeningRationale: "Selected by the fake researcher for review.",
    tags: ["review-source"]
  }));
  const extractions: WorkStoreEntity[] = extractedSourceIds.map((sourceId, index) => ({
    id: `extraction-review-${index + 1}`,
    kind: "extraction" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceId,
    extraction: {
      id: `extraction-review-${index + 1}`,
      paperId: sourceId,
      runId: input.runId,
      problemSetting: "Model-driven research workspaces need explicit synthesis affordances.",
      systemType: "research workspace",
      architecture: "SQLite workspace plus explicit model-selected tools.",
      toolsAndMemory: "source, extraction, evidence, claim, section, critic, and finalization tools",
      planningStyle: "model-owned planning with runtime provenance",
      evaluationSetup: "architecture and behavior smoke tests",
      successSignals: ["state is inspectable", "citations are traceable"],
      failureModes: ["thin synthesis can look mechanically valid"],
      limitations: ["test fixture"],
      supportedClaims: [{
        claim: "Research workspaces need artifact-aware finalization.",
        support: "explicit" as const
      }],
      confidence: "high" as const,
      evidenceNotes: ["Synthetic test extraction."]
    }
  }));
  const evidenceCells: WorkStoreEntity[] = evidenceSourceIds.map((sourceId, index) => ({
    id: `evidence-review-${index + 1}`,
    kind: "evidenceCell" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceId,
    extractionId: `extraction-review-${index + 1}`,
    field: "successSignals" as const,
    value: "Artifact-aware finalization keeps checkpoint briefs distinct from professional papers.",
    confidence: "high"
  }));
  const claims: WorkStoreEntity[] = citedSourceIds.map((sourceId, index) => ({
    id: `claim-review-${index + 1}`,
    kind: "claim" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    text: `Artifact-aware finalization claim ${index + 1}`,
    evidence: "Supported by synthetic evidence cells in this test fixture.",
    sourceIds: [sourceId],
    supportStatus: "supported",
    confidence: "high",
    usedInSections: ["section-thin-synthesis"],
    risk: null
  }));
  const citations: WorkStoreEntity[] = citedSourceIds.map((sourceId, index) => ({
    id: `citation-review-${index + 1}`,
    kind: "citation" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceId,
    sourceTitle: `Representative research workspace paper ${index + 1}`,
    evidenceCellId: `evidence-review-${index + 1}`,
    supportSnippet: "Artifact-aware finalization keeps checkpoint briefs distinct from professional papers.",
    confidence: "high",
    relevance: "direct support",
    claimIds: [`claim-review-${index + 1}`],
    sectionIds: ["section-thin-synthesis"]
  }));
  const section: WorkStoreEntity = {
    id: "section-thin-synthesis",
    kind: "manuscriptSection" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    sectionId: "thin-synthesis",
    role: "synthesis",
    title: "Thin Synthesis",
    markdown: "This deliberately thin section cites only a few sources despite a larger selected and extracted source set.",
    sourceIds: citedSourceIds,
    claimIds: claims.map((claim) => claim.id),
    status: "checked"
  };
  const store = upsertResearchWorkStoreEntities({
    ...createResearchWorkStore({
      projectRoot: input.projectRoot,
      brief: input.brief,
      now: timestamp
    }),
    notebook: {
      schemaVersion: 1,
      missionTarget: input.missionTarget,
      paperMode: "literature_review",
      objective: "Produce an artifact-contract regression review.",
      definitionOfDone: ["Do not confuse a checkpoint brief with a professional paper."],
      tasks: [{
        id: "task-thin-synthesis",
        title: "Show thin synthesis cannot pass professional finalization",
        status: "in_progress",
        notes: "The workspace is mechanically linked but intentionally too thin for professional_paper.",
        linkedSourceIds: citedSourceIds,
        linkedExtractionIds: ["extraction-review-1"],
        linkedEvidenceCellIds: ["evidence-review-1"],
        linkedClaimIds: ["claim-review-1"],
        linkedSectionIds: ["section-thin-synthesis"],
        linkedArtifactPaths: []
      }],
      currentFocus: "Validate artifact-aware finalization.",
      readiness: input.missionTarget === "professional_paper"
        ? "Ready to finalize professional_paper literature_review with caveats according to the fake researcher."
        : "Ready to finalize research_brief literature_review with caveats according to the fake researcher.",
      notes: [],
      artifactLinks: [],
      updatedAt: timestamp
    },
    worker: {
      ...createResearchWorkStore({
        projectRoot: input.projectRoot,
        brief: input.brief,
        now: timestamp
      }).worker,
      evidence: {
        canonicalPapers: sourceIds.length,
        includedPapers: sourceIds.length,
        selectedSourceIds: sourceIds,
        explicitlySelectedEvidencePapers: sourceIds.length,
        selectedPapers: sourceIds.length,
        extractedPapers: extractedSourceIds.length,
        evidenceRows: evidenceCells.length,
        referencedPapers: citedSourceIds.length
      }
    }
  }, [
    ...canonicalSources,
    ...extractions,
    ...evidenceCells,
    ...claims,
    ...citations,
    section
  ], timestamp);
  await writeResearchWorkStore(store);
}

async function seedSharedClaimSupportWorkspace(input: {
  projectRoot: string;
  runId: string;
  brief: Parameters<typeof createResearchWorkStore>[0]["brief"];
  now: () => string;
}): Promise<{
  claimId: string;
  sourceIds: string[];
  evidenceCellIds: string[];
}> {
  const timestamp = input.now();
  const claimId = "claim-support-link-regression-with-a-deliberately-long-identifier-that-used-to-truncate-source-identity";
  const sourceIds = ["source-support-1", "source-support-2", "source-support-3"];
  const evidenceCellIds = sourceIds.map((_, index) => `evidence-support-${index + 1}`);
  const canonicalSources: WorkStoreEntity[] = sourceIds.map((sourceId, index) => ({
    id: sourceId,
    kind: "canonicalSource" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    key: `doi:10.5555/support-link-${index + 1}`,
    title: `Support link regression source ${index + 1}`,
    citation: `Support Author ${index + 1} (2026). Support link regression source ${index + 1}.`,
    abstract: "A seeded source used to test durable support-link identity across sources.",
    year: 2026,
    authors: [`Support Author ${index + 1}`],
    venue: "Support Link Test Journal",
    providerIds: ["test"],
    identifiers: {
      doi: `10.5555/support-link-${index + 1}`,
      pmid: null,
      pmcid: null,
      arxivId: null
    },
    accessMode: "fulltext_open",
    bestAccessUrl: `https://example.org/support-link-${index + 1}.pdf`,
    screeningDecision: "include",
    screeningRationale: "Selected by the fake researcher for support-link identity testing.",
    tags: ["support-link-regression"]
  }));
  const extractions: WorkStoreEntity[] = sourceIds.map((sourceId, index) => ({
    id: `extraction-support-${index + 1}`,
    kind: "extraction" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceId,
    extraction: {
      id: `extraction-support-${index + 1}`,
      paperId: sourceId,
      runId: input.runId,
      problemSetting: "Durable support links can be attached from multiple sources to one claim.",
      systemType: "support-link regression fixture",
      architecture: "one claim, multiple selected sources, and distinct evidence cells",
      toolsAndMemory: "claim.link_support writes citation-renderable support links",
      planningStyle: "scripted regression test",
      evaluationSetup: "attach support links for three source/evidence identities",
      successSignals: ["all support links remain durable"],
      failureModes: ["generated ids can collide when long claim ids are truncated"],
      limitations: ["synthetic fixture"],
      supportedClaims: [{
        claim: "Support-link identity must include source and evidence identity.",
        support: "explicit" as const
      }],
      confidence: "high" as const,
      evidenceNotes: ["Synthetic extraction for support-link regression."]
    }
  }));
  const evidenceCells: WorkStoreEntity[] = sourceIds.map((sourceId, index) => ({
    id: evidenceCellIds[index] ?? `evidence-support-${index + 1}`,
    kind: "evidenceCell" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceId,
    extractionId: `extraction-support-${index + 1}`,
    field: "successSignals" as const,
    value: `Source ${index + 1} provides independent evidence that durable support links must preserve source identity.`,
    confidence: "high"
  }));
  const claim: WorkStoreEntity = {
    id: claimId,
    kind: "claim" as const,
    runId: input.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    text: "Durable support links must preserve distinct source identities for the same claim.",
    evidence: "Multiple seeded sources each provide independent support for this single claim.",
    sourceIds: [],
    supportStatus: "weak",
    confidence: "medium",
    usedInSections: [],
    risk: "No support links have been attached yet."
  };
  const store = upsertResearchWorkStoreEntities({
    ...createResearchWorkStore({
      projectRoot: input.projectRoot,
      brief: input.brief,
      now: timestamp
    }),
    worker: {
      ...createResearchWorkStore({
        projectRoot: input.projectRoot,
        brief: input.brief,
        now: timestamp
      }).worker,
      evidence: {
        canonicalPapers: sourceIds.length,
        includedPapers: sourceIds.length,
        selectedSourceIds: sourceIds,
        explicitlySelectedEvidencePapers: sourceIds.length,
        selectedPapers: sourceIds.length,
        extractedPapers: 0,
        evidenceRows: evidenceCells.length,
        referencedPapers: 0
      }
    }
  }, [
    ...canonicalSources,
    ...extractions,
    ...evidenceCells,
    claim
  ], timestamp);
  await writeResearchWorkStore(store);
  return {
    claimId,
    sourceIds,
    evidenceCellIds
  };
}

class ExplicitResearchToolBackend extends StubResearchBackend {
  readonly capabilities = {
    actionControl: {
      nativeToolCalls: false,
      strictJsonFallback: true
    },
    criticReview: true
  };
  readonly sourceActions: ResearchActionDecision[] = [];
  readonly researchRequests: ResearchActionRequest[] = [];
  readonly criticRequests: CriticReviewRequest[] = [];
  private extractionId: string | null = null;
  private evidenceCellId: string | null = null;
	  private matrixViewed = false;
	  private criticReviewed = false;
	  private releaseVerified = false;
	  private notebookReadinessPatched = false;
	  private manuscriptReleased = false;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    for (const result of request.toolResults ?? []) {
      if (result.action === "extraction.create" && result.entity?.id !== undefined) {
        this.extractionId = result.entity.id;
      }
      if (result.action === "evidence.create_cell" && result.entity?.id !== undefined) {
        this.evidenceCellId = result.entity.id;
      }
      if (result.action === "evidence.matrix_view") {
        this.matrixViewed = true;
      }
    }

    const sourceId = request.workStore?.recentSources[0]?.id ?? "source-agentic-tool-runtime";
    const claim = request.workStore?.recentClaims[0];
    const citation = request.workStore?.recentCitations[0];
    const section = request.workStore?.recentSections[0];
    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [sourceId],
      criticScope: null,
      reason: null
    };
    let action: ResearchActionDecision;

    if ((request.workStore?.summary.extractions ?? 0) === 0) {
      action = {
        schemaVersion: 1,
        action: "extraction.create",
        rationale: "Create model-authored extraction content for the seeded source.",
        confidence: 0.91,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "extractions",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              sourceId,
              problemSetting: "Long-running research agents need explicit model-selected tools over durable workspace state.",
              systemType: "agentic research runtime",
              architecture: "persistent workspace plus provider, evidence, claim, critic, and release tools",
              toolsAndMemory: "workspace database, source search tools, evidence cells, claim ledger, support links",
              planningStyle: "observe, act, persist, validate",
              evaluationSetup: "architecture-contract tests inspect that hidden workflow steps are absent",
              successSignals: ["tool results are visible to the next model step", "release invariants are explicit"],
              failureModes: ["hidden orchestration can overwrite model-owned state"],
              limitations: ["single seeded source in this smoke scenario"],
              supportedClaims: [{
                claim: "Explicit researcher tools preserve model ownership of synthesis decisions.",
                support: "explicit"
              }],
              confidence: "high",
              evidenceNotes: ["Seeded test extraction authored by the fake researcher backend."]
            }
          }
        },
        expectedOutcome: "Persist one extraction object without calling hidden extraction.",
        stopCondition: "The extraction is queryable in the workspace.",
        transport: "strict_json"
      };
    } else if ((request.workStore?.summary.evidenceCells ?? 0) === 0) {
      action = {
        schemaVersion: 1,
        action: "evidence.create_cell",
        rationale: "Create an evidence cell from the model-authored extraction.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "evidenceCells",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              sourceId,
              extractionId: this.extractionId,
              field: "successSignals",
              value: "Explicit tool observations let the model inspect and build research state step by step.",
              confidence: "high"
            }
          }
        },
        expectedOutcome: "Persist one evidence cell with source and extraction provenance.",
        stopCondition: "The evidence cell is queryable.",
        transport: "strict_json"
      };
    } else if (!this.matrixViewed) {
      action = {
        schemaVersion: 1,
        action: "evidence.matrix_view",
        rationale: "Inspect a read-only evidence matrix view before drafting claims.",
        confidence: 0.86,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "evidenceCells",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: 10,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Return an evidence view without mutating evidence cells.",
        stopCondition: "Evidence rows are visible.",
        transport: "strict_json"
      };
    } else if (claim === undefined) {
      action = {
        schemaVersion: 1,
        action: "claim.create",
        rationale: "Create a claim from explicit evidence observations.",
        confidence: 0.89,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "claims",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              text: "Explicit researcher tools preserve model ownership of research synthesis decisions.",
              evidence: "The seeded extraction and evidence cell describe an observe-act-persist tool loop.",
              sourceIds: [sourceId],
              confidence: "high"
            }
          }
        },
        expectedOutcome: "Persist a claim object.",
        stopCondition: "The claim is queryable.",
        transport: "strict_json"
      };
    } else if (citation === undefined) {
      action = {
        schemaVersion: 1,
        action: "claim.link_support",
        rationale: "Create a durable support link from the claim to the evidence cell.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "citations",
            entityId: claim.id,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              sourceId,
              evidenceCellId: this.evidenceCellId,
              supportSnippet: "Explicit tool observations let the model inspect and build research state step by step.",
              confidence: "high",
              relevance: "direct support"
            }
          }
        },
        expectedOutcome: "Persist citation-renderable support.",
        stopCondition: "Support link exists.",
        transport: "strict_json"
      };
    } else if (section === undefined) {
      action = {
        schemaVersion: 1,
        action: "section.create",
        rationale: "Draft a manuscript section from a supported claim.",
        confidence: 0.87,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              sectionId: "tool-loop-architecture",
              role: "synthesis",
              title: "Tool-Loop Architecture",
              paragraph: "Explicit researcher tools keep semantic judgment with the model while the runtime validates provenance and export invariants.",
              claimIds: [claim.id],
              sourceIds: [sourceId]
            }
          }
        },
        expectedOutcome: "Persist a manuscript section linked to the claim.",
        stopCondition: "Section state exists.",
        transport: "strict_json"
      };
	    } else if (!this.notebookReadinessPatched) {
	      this.notebookReadinessPatched = true;
	      action = {
	        schemaVersion: 1,
	        action: "notebook.patch",
	        rationale: "Record the model-owned readiness assessment before finalization.",
	        confidence: 0.9,
	        inputs: {
	          ...baseInputs,
	          workStore: {
	            collection: null,
	            entityId: null,
	            filters: {},
	            semanticQuery: null,
	            limit: null,
	            cursor: null,
	            changes: {},
	            entity: {
	              missionTarget: "research_brief",
	              paperMode: "technical_survey",
	              currentFocus: "Finalize the validated smoke manuscript export.",
	              readiness: "Ready to finalize with caveats: this is a bounded single-source smoke manuscript whose mechanical provenance and citation invariants have been checked.",
	              task: {
	                id: "task-finalize-explicit-tool-smoke",
	                title: "Finalize explicit tool smoke manuscript",
	                status: "done",
	                notes: "The manuscript is acceptable as a bounded smoke test, not as a professional literature review.",
	                linkedSourceIds: [sourceId],
	                linkedExtractionIds: this.extractionId === null ? [] : [this.extractionId],
	                linkedEvidenceCellIds: this.evidenceCellId === null ? [] : [this.evidenceCellId],
	                linkedClaimIds: claim === undefined ? [] : [claim.id],
	                linkedSectionIds: section === undefined ? [] : [section.id]
	              }
	            }
	          }
	        },
	        expectedOutcome: "Notebook readiness is explicit before critic review and finalization.",
	        stopCondition: "Notebook readiness records the bounded release decision.",
	        transport: "strict_json"
	      };
    } else if (!this.criticReviewed) {
      this.criticReviewed = true;
      action = {
        schemaVersion: 1,
        action: "critic.review",
        rationale: "Ask the explicit critic tool for visible reviewer feedback.",
        confidence: 0.84,
        inputs: {
          ...baseInputs,
          criticScope: "release",
          workStore: {
            collection: "workItems",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Critic output is returned as feedback only.",
        stopCondition: "Visible critic feedback exists.",
        transport: "strict_json"
      };
    } else if (!this.releaseVerified) {
      this.releaseVerified = true;
      action = {
        schemaVersion: 1,
        action: "release.verify",
        rationale: "Run explicit mechanical release invariant checks.",
        confidence: 0.88,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "releaseChecks",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Release checks are persisted without critic calls.",
        stopCondition: "Release checks exist.",
        transport: "strict_json"
      };
	    } else if (!this.manuscriptReleased) {
      this.manuscriptReleased = true;
      action = {
        schemaVersion: 1,
        action: "manuscript.finalize",
        rationale: "Export the manuscript from validated workspace state.",
        confidence: 0.88,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Paper markdown and JSON are exported from workspace state.",
        stopCondition: "Manuscript export exists.",
        transport: "strict_json"
      };
    } else {
      action = {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "Checkpoint after explicit research tools have run.",
        confidence: 0.8,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: "Explicit tool smoke run complete.",
          workStore: terminalUserDecisionWorkStore("Explicit tool smoke run complete.")
        },
        expectedOutcome: "Stop only through a structured user-decision terminal state.",
        stopCondition: "Structured test decision reached.",
        transport: "strict_json"
      };
    }

    this.sourceActions.push(action);
    return action;
  }

  async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    this.criticRequests.push(request);
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "pass",
      confidence: 0.76,
      summary: "The critic sees a bounded single-source smoke manuscript and approves release with the limitation visible.",
      objections: [{
        code: "critic-tighten-limitations",
        severity: "minor",
        target: "manuscript",
        targetId: "invented-manuscript-target",
        message: "The limitations paragraph should clearly state that this is a single-source smoke scenario.",
        affectedPaperIds: ["invented-source"],
        affectedEvidenceCellIds: [],
        affectedClaimIds: [
          ...(request.workspace?.claims[0]?.id === undefined ? [] : [String(request.workspace.claims[0].id)]),
          "invented-claim"
        ],
        affectedSectionIds: [
          ...(request.workspace?.manuscriptSections[0]?.id === undefined ? [] : [String(request.workspace.manuscriptSections[0].id)]),
          "invented-section"
        ],
        suggestedRevision: "Keep the limitation visible in the final export."
      }],
      positiveFindings: Array.from({ length: 8 }, (_, index) => ({
        target: "manuscript",
        targetId: `invented-positive-${index}`,
        message: `Readiness-relevant smoke-test strength ${index}`
      })),
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      },
      recommendedNextActions: []
    };
  }
}

class SupportRepairDiagnosticsBackend extends StubResearchBackend {
  readonly researchRequests: ResearchActionRequest[] = [];
  private readonly sourceId: string;
  private stopped = false;

  constructor(sourceId: string) {
    super();
    this.sourceId = sourceId;
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [this.sourceId],
      criticScope: null,
      reason: null
    };
    const lastBlockedSupport = request.toolResults?.find((result) => result.action === "claim.link_support" && result.status === "blocked");
    if (lastBlockedSupport !== undefined || this.stopped) {
      this.stopped = true;
      return {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "Stop the diagnostic smoke test after observing the blocked support-link repair packet.",
        confidence: 0.8,
        inputs: {
          ...baseInputs,
          reason: "Support-link diagnostic test complete.",
          workStore: terminalUserDecisionWorkStore("Support-link diagnostic test complete.")
        },
        expectedOutcome: "Structured test terminal state.",
        stopCondition: "Diagnostic observation captured.",
        transport: "strict_json"
      };
    }

    if ((request.workStore?.summary.extractions ?? 0) === 0) {
      return {
        schemaVersion: 1,
        action: "extraction.create",
        rationale: "Create a rich extraction before testing support-link diagnostics.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "extractions",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              sourceId: this.sourceId,
              problemSetting: "Research tool runtimes need durable model-visible observations.",
              systemType: "research workspace runtime",
              architecture: "model-selected tools over a persistent workspace",
              toolsAndMemory: "source tools, evidence cells, claims, and support links",
              planningStyle: "state-driven observe-act-persist",
              evaluationSetup: "architecture-contract tests and tool-result diagnostics",
              successSignals: ["blocked tool calls return repair context"],
              failureModes: ["missing ids can cause repeated no-op attempts"],
              limitations: ["seeded smoke-test source"],
              supportedClaims: [{ claim: "Repair context reduces support-link friction.", support: "explicit" }],
              confidence: "high"
            }
          }
        },
        expectedOutcome: "Create extraction.",
        stopCondition: "Extraction exists.",
        transport: "strict_json"
      };
    }

    if ((request.workStore?.summary.evidenceCells ?? 0) === 0) {
      const extractionId = request.toolResults?.find((result) => result.action === "extraction.create")?.entity?.id
        ?? null;
      return {
        schemaVersion: 1,
        action: "evidence.create_cell",
        rationale: "Create evidence before testing support-link diagnostics.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "evidenceCells",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              sourceId: this.sourceId,
              extractionId,
              field: "successSignals",
              value: "Blocked support-link calls return valid claim and evidence-cell previews so the researcher can repair IDs without treating any preview as automatically correct support.",
              confidence: "high"
            }
          }
        },
        expectedOutcome: "Create evidence cell.",
        stopCondition: "Evidence cell exists.",
        transport: "strict_json"
      };
    }

    const claim = request.workStore?.recentClaims[0];
    if (claim === undefined) {
      return {
        schemaVersion: 1,
        action: "claim.create",
        rationale: "Create a claim before testing support-link diagnostics.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "claims",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              text: "Support-link diagnostics should behave like IDE completion, not semantic auto-approval.",
              evidence: "The evidence cell describes repair context for blocked support-link calls.",
              sourceIds: [this.sourceId],
              confidence: "medium"
            }
          }
        },
        expectedOutcome: "Create claim.",
        stopCondition: "Claim exists.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "claim.link_support",
      rationale: "Intentionally omit evidence/source ids to inspect repair diagnostics.",
      confidence: 0.7,
      inputs: {
        ...baseInputs,
        paperIds: [],
        workStore: {
          collection: "citations",
          entityId: null,
          filters: {},
          semanticQuery: null,
          limit: null,
          cursor: null,
          changes: {},
          entity: {
            claimId: claim.id
          }
        }
      },
      expectedOutcome: "Return a blocked repair packet with valid ids and cautions.",
      stopCondition: "Support link remains uncreated.",
      transport: "strict_json"
    };
  }
}

class MultiSourceSupportLinkBackend extends StubResearchBackend {
  readonly researchRequests: ResearchActionRequest[] = [];
  private nextSourceIndex = 0;

  constructor(
    private readonly claimId: string,
    private readonly sourceIds: string[],
    private readonly evidenceCellIds: string[]
  ) {
    super();
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };

    if (this.nextSourceIndex < this.sourceIds.length) {
      const sourceId = this.sourceIds[this.nextSourceIndex] ?? "";
      const evidenceCellId = this.evidenceCellIds[this.nextSourceIndex] ?? "";
      this.nextSourceIndex += 1;
      return {
        schemaVersion: 1,
        action: "claim.link_support",
        rationale: "Attach another source-backed support link to the same long claim id.",
        confidence: 0.92,
        inputs: {
          ...baseInputs,
          paperIds: [sourceId],
          workStore: {
            collection: "citations",
            entityId: this.claimId,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              claimId: this.claimId,
              sourceId,
              evidenceCellId,
              supportSnippet: `Source ${this.nextSourceIndex} provides independent evidence that durable support links must preserve source identity.`,
              confidence: "high",
              relevance: "direct support"
            }
          }
        },
        expectedOutcome: "Attach one durable support link without overwriting links from other sources.",
        stopCondition: "The support link count increases or updates only the same claim/source/evidence identity.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Stop after all same-claim support links have been attempted.",
      confidence: 0.84,
      inputs: {
        ...baseInputs,
        reason: "Multi-source support-link regression complete.",
        workStore: terminalUserDecisionWorkStore("Multi-source support-link regression complete.")
      },
      expectedOutcome: "Structured terminal state for the regression test.",
      stopCondition: "The regression workspace can be inspected.",
      transport: "strict_json"
    };
  }
}

class SupportLinkLifecycleBackend extends StubResearchBackend {
  readonly researchRequests: ResearchActionRequest[] = [];
  private step = 0;

  constructor(
    private readonly mode: "replace" | "remove",
    private readonly claimId: string,
    private readonly sourceIds: string[],
    private readonly evidenceCellIds: string[]
  ) {
    super();
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };

    if (this.step === 0) {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "claim.link_support",
        rationale: "Attach provisional support before testing explicit repair operations.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          paperIds: [this.sourceIds[0] ?? ""],
          workStore: {
            collection: "citations",
            entityId: this.claimId,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              mode: "append",
              claimId: this.claimId,
              sourceId: this.sourceIds[0],
              evidenceCellId: this.evidenceCellIds[0],
              supportSnippet: "The first source is provisional support that will be explicitly replaced or retired.",
              confidence: "medium",
              relevance: "provisional support"
            }
          }
        },
        expectedOutcome: "Create provisional support.",
        stopCondition: "Provisional support link exists.",
        transport: "strict_json"
      };
    }

    if (this.step === 1 && this.mode === "replace") {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "claim.link_support",
        rationale: "Replace provisional support with stronger support from another evidence cell.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          paperIds: [this.sourceIds[1] ?? ""],
          reason: "Better evidence supersedes the provisional support link.",
          workStore: {
            collection: "citations",
            entityId: this.claimId,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              mode: "replace",
              claimId: this.claimId,
              sourceId: this.sourceIds[1],
              evidenceCellId: this.evidenceCellIds[1],
              oldSourceId: this.sourceIds[0],
              oldEvidenceCellId: this.evidenceCellIds[0],
              supportSnippet: "The second source gives stronger replacement support with distinct source identity.",
              confidence: "high",
              relevance: "replacement support"
            }
          }
        },
        expectedOutcome: "Supersede provisional support and attach replacement support.",
        stopCondition: "One support link is superseded and one remains active.",
        transport: "strict_json"
      };
    }

    if (this.step === 1 && this.mode === "remove") {
      this.step += 1;
      const supportLinkId = request.toolResults?.find((result) => result.action === "claim.link_support" && result.status === "ok")?.entity?.id ?? null;
      return {
        schemaVersion: 1,
        action: "claim.link_support",
        rationale: "Retire provisional support without deleting the audit trail.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          reason: "The provisional support is not adequate.",
          workStore: {
            collection: "citations",
            entityId: this.claimId,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              mode: "remove",
              claimId: this.claimId,
              citationId: supportLinkId,
              oldSourceId: this.sourceIds[0],
              oldEvidenceCellId: this.evidenceCellIds[0],
              statusReason: "The support was intentionally retired by the researcher."
            }
          }
        },
        expectedOutcome: "Retire the support link without hard-deleting it.",
        stopCondition: "The support link is retired.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Stop after explicit support-link lifecycle operation.",
      confidence: 0.84,
      inputs: {
        ...baseInputs,
        reason: "Support-link lifecycle regression complete.",
        workStore: terminalUserDecisionWorkStore("Support-link lifecycle regression complete.")
      },
      expectedOutcome: "Structured terminal state for lifecycle regression.",
      stopCondition: "The regression workspace can be inspected.",
      transport: "strict_json"
    };
  }
}

class ExtractionEvidencePatchBackend extends StubResearchBackend {
  readonly researchRequests: ResearchActionRequest[] = [];
  private step = 0;

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };

    if (this.step === 0) {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "extraction.patch",
        rationale: "Mark a provisional extraction as superseded by a better extraction.",
        confidence: 0.88,
        inputs: {
          ...baseInputs,
          reason: "A newer extraction supersedes this provisional extraction.",
          workStore: {
            collection: "extractions",
            entityId: "extraction-support-1",
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              extractionId: "extraction-support-1",
              status: "superseded",
              supersededBy: "extraction-support-2",
              statusReason: "Replaced by a more useful extraction."
            }
          }
        },
        expectedOutcome: "Extraction lifecycle status is updated.",
        stopCondition: "Extraction is superseded.",
        transport: "strict_json"
      };
    }

    if (this.step === 1) {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "evidence.patch",
        rationale: "Retire a weak evidence cell without deleting it.",
        confidence: 0.88,
        inputs: {
          ...baseInputs,
          reason: "The evidence cell is too provisional to support claims.",
          workStore: {
            collection: "evidenceCells",
            entityId: "evidence-support-1",
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              evidenceCellId: "evidence-support-1",
              status: "retired",
              statusReason: "Retired by explicit evidence.patch after review."
            }
          }
        },
        expectedOutcome: "Evidence lifecycle status is updated.",
        stopCondition: "Evidence cell is retired.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Stop after explicit extraction/evidence patch actions.",
      confidence: 0.84,
      inputs: {
        ...baseInputs,
        reason: "Extraction/evidence patch regression complete.",
        workStore: terminalUserDecisionWorkStore("Extraction/evidence patch regression complete.")
      },
      expectedOutcome: "Structured terminal state for patch regression.",
      stopCondition: "The regression workspace can be inspected.",
      transport: "strict_json"
    };
  }
}

class SectionLinkClaimBackend extends StubResearchBackend {
  readonly researchRequests: ResearchActionRequest[] = [];

  constructor(private readonly mode: "payloadIds" | "swappedLinkIds") {
    super();
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    const claim = request.workStore?.recentClaims[0];
    const section = request.workStore?.recentSections[0];
    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };

    if (claim === undefined) {
      return {
        schemaVersion: 1,
        action: "claim.create",
        rationale: "Create a claim before linking it to a section.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "claims",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              text: "Research lab tools should make provenance repair easy for the model.",
              evidence: "This test claim is used to verify section-link tool ergonomics.",
              confidence: "medium"
            }
          }
        },
        expectedOutcome: "Claim is persisted.",
        stopCondition: "Continue to section creation.",
        transport: "strict_json"
      };
    }

    if (section === undefined) {
      return {
        schemaVersion: 1,
        action: "section.create",
        rationale: "Create an unlinked section before testing section.link_claim.",
        confidence: 0.88,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              sectionId: "discussion",
              role: "synthesis",
              title: "Discussion",
              paragraph: "This section should be linked to an existing claim by the explicit section.link_claim tool."
            }
          }
        },
        expectedOutcome: "Section is persisted without a claim link.",
        stopCondition: "Continue to section.link_claim.",
        transport: "strict_json"
      };
    }

    if (!section.claimIds.includes(claim.id)) {
      return {
        schemaVersion: 1,
        action: "section.link_claim",
        rationale: "Link the existing section to the existing claim using the selected ID shape.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: this.mode === "payloadIds"
              ? {
                sectionId: section.sectionId,
                claimId: claim.id
              }
              : {},
            link: this.mode === "swappedLinkIds"
              ? {
                fromCollection: "claims",
                fromId: claim.id,
                toCollection: "manuscriptSections",
                toId: section.id,
                relation: "uses_claim",
                snippet: null
              }
              : undefined
          }
        },
        expectedOutcome: "Section and claim are durably linked.",
        stopCondition: "Continue after the link exists.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Checkpoint after section claim link was created.",
      confidence: 0.8,
      inputs: {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticScope: null,
        reason: "Section link test complete.",
        workStore: terminalUserDecisionWorkStore("Section link test complete.")
      },
      expectedOutcome: "Stop only through a structured user-decision terminal state.",
      stopCondition: "Structured test decision reached.",
      transport: "strict_json"
    };
  }
}

class ExplicitManuscriptFinalizeBlockedBackend extends StubResearchBackend {
  private releaseRequested = false;
  readonly researchRequests: ResearchActionRequest[] = [];

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    if (!this.releaseRequested) {
      this.releaseRequested = true;
      return {
        schemaVersion: 1,
        action: "manuscript.finalize",
        rationale: "Try to finalize before claims, sections, support links, and references exist.",
        confidence: 0.6,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: null,
          workStore: {
            collection: "manuscriptSections",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Release should be visibly blocked by hard invariants.",
        stopCondition: "Stop after the blocked release attempt.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Checkpoint after explicit blocked release.",
      confidence: 0.8,
      inputs: {
        providerIds: [],
        searchQueries: [],
        evidenceTargets: [],
        paperIds: [],
        criticScope: null,
        reason: "Blocked release was reported.",
        workStore: terminalUserDecisionWorkStore("Blocked release was reported.")
      },
      expectedOutcome: "Stop only through a structured user-decision terminal state.",
      stopCondition: "Structured test decision reached.",
      transport: "strict_json"
    };
  }
}

class FinalizeSeededWorkspaceBackend extends StubResearchBackend {
  readonly researchRequests: ResearchActionRequest[] = [];
  private finalized = false;

  constructor(
    private readonly requestedMissionTarget: ResearchMissionTarget | null = null,
    private readonly missionTarget: ResearchMissionTarget = "professional_paper"
  ) {
    super();
  }

  override async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Finalize the seeded workspace according to the notebook artifact contract.",
      rationale: "The regression test preloads the workspace; planning only preserves artifact intent.",
      searchQueries: [],
      localFocus: [],
      notebookPatch: {
        missionTarget: this.missionTarget,
        paperMode: "literature_review",
        currentFocus: "Validate seeded artifact finalization.",
        readiness: `Ready to finalize ${this.missionTarget} literature_review with caveats according to the fake researcher.`
      }
    };
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };

    if (!this.finalized) {
      this.finalized = true;
      return {
        schemaVersion: 1,
        action: "manuscript.finalize",
        rationale: "Attempt to finalize the seeded workspace exactly as it stands.",
        confidence: 0.8,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: this.requestedMissionTarget === null ? {} : {
              missionTarget: this.requestedMissionTarget
            }
          }
        },
        expectedOutcome: "Finalization either writes paper.md or returns artifact-contract repair diagnostics.",
        stopCondition: "The explicit finalization result is visible.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Stop the seeded finalization regression test after observing the result.",
      confidence: 0.8,
      inputs: {
        ...baseInputs,
        reason: "Seeded finalization test complete.",
        workStore: terminalUserDecisionWorkStore("Seeded finalization test complete.")
      },
      expectedOutcome: "Structured terminal state.",
      stopCondition: "Structured test terminal state reached.",
      transport: "strict_json"
    };
  }
}

class CriticAvailableFinalizeSeededWorkspaceBackend extends FinalizeSeededWorkspaceBackend {
  readonly capabilities = {
    actionControl: {
      nativeToolCalls: false,
      strictJsonFallback: true
    },
    criticReview: true
  };
  readonly criticRequests: CriticReviewRequest[] = [];

  async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    this.criticRequests.push(request);
    throw new Error("critic.review should not be auto-run by manuscript.finalize");
  }
}

class CriticThenFinalizeSeededWorkspaceBackend extends FinalizeSeededWorkspaceBackend {
  readonly capabilities = {
    actionControl: {
      nativeToolCalls: false,
      strictJsonFallback: true
    },
    criticReview: true
  };
  readonly criticRequests: CriticReviewRequest[] = [];
  private reviewed = false;

  constructor(missionTarget: ResearchMissionTarget = "research_brief") {
    super(null, missionTarget);
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    if (!this.reviewed) {
      this.reviewed = true;
      this.researchRequests.push(request);
      return {
        schemaVersion: 1,
        action: "critic.review",
        rationale: "Create the runtime-owned release critic pass before finalization.",
        confidence: 0.9,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: "release",
          reason: null,
          workStore: {
            collection: "workItems",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "A release critic pass is persisted by the critic.review handler.",
        stopCondition: "Continue to manuscript.finalize after the pass is visible.",
        transport: "strict_json"
      };
    }

    return super.chooseResearchAction(request);
  }

  async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    this.criticRequests.push(request);
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "pass",
      confidence: 0.9,
      summary: "The release critic approves this bounded seeded workspace for export.",
      objections: [],
      positiveFindings: [{
        target: "release",
        targetId: null,
        message: "Mechanical support links and references are sufficient for this bounded fixture."
      }],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      },
      recommendedNextActions: []
    };
  }
}

class CriticFreshnessScenarioBackend extends StubResearchBackend {
  readonly capabilities = {
    actionControl: {
      nativeToolCalls: false,
      strictJsonFallback: true
    },
    criticReview: true
  };
  readonly researchRequests: ResearchActionRequest[] = [];
  readonly criticRequests: CriticReviewRequest[] = [];
  private step = 0;

  constructor(
    private readonly mutation: "none" | "section" | "evidence" | "support",
    private readonly terminalAction: "release.verify" | "manuscript.finalize" = "release.verify"
  ) {
    super();
  }

  override async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Validate release critic freshness for the current workspace.",
      rationale: "The regression test preloads a mechanically linked workspace.",
      searchQueries: [],
      localFocus: [],
      notebookPatch: {
        missionTarget: "research_brief",
        paperMode: "literature_review",
        currentFocus: "Validate release critic freshness.",
        readiness: "Ready to finalize research_brief literature_review with caveats: the seeded workspace satisfies the bounded regression definition of done."
      }
    };
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };

    if (this.step === 0) {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "critic.review",
        rationale: "Create a runtime-owned release critic review snapshot.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          criticScope: "release",
          workStore: {
            collection: "workItems",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "The release critic pass is persisted with snapshot metadata.",
        stopCondition: "Continue to the mutation or terminal check.",
        transport: "strict_json"
      };
    }

    if (this.step === 1 && this.mutation === "section") {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "section.patch",
        rationale: "Change a manuscript section after critic review.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: "section-thin-synthesis",
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              markdown: "This revised section was changed after the release critic reviewed the manuscript.",
              claimIds: ["claim-review-1"],
              sourceIds: ["source-review-1"]
            }
          }
        },
        expectedOutcome: "The section changes after critic review.",
        stopCondition: "Continue to release verification.",
        transport: "strict_json"
      };
    }

    if (this.step === 1 && this.mutation === "evidence") {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "evidence.create_cell",
        rationale: "Add new evidence after critic review.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "evidenceCells",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              id: "evidence-review-added-after-critic",
              sourceId: "source-review-1",
              extractionId: "extraction-review-1",
              field: "limitations",
              value: "This evidence cell was added after the release critic review and was therefore not reviewed.",
              confidence: "medium"
            }
          }
        },
        expectedOutcome: "New evidence is persisted after critic review.",
        stopCondition: "Continue to release verification.",
        transport: "strict_json"
      };
    }

    if (this.step === 1 && this.mutation === "support") {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "claim.link_support",
        rationale: "Retire a support link after critic review.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "citations",
            entityId: "claim-review-1",
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              mode: "remove",
              claimId: "claim-review-1",
              citationId: "citation-review-1",
              oldSourceId: "source-review-1",
              oldEvidenceCellId: "evidence-review-1",
              statusReason: "Retired after critic review for freshness regression."
            }
          }
        },
        expectedOutcome: "Support link is retired after critic review.",
        stopCondition: "Continue to finalization.",
        transport: "strict_json"
      };
    }

    if ((this.step === 1 && this.mutation === "none") || (this.step === 2 && this.mutation !== "none")) {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: this.terminalAction,
        rationale: "Inspect critic freshness before allowing release.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "releaseChecks",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "Release verification/finalization reports critic freshness.",
        stopCondition: "Continue to structured test stop.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Stop after critic freshness scenario.",
      confidence: 0.8,
      inputs: {
        ...baseInputs,
        reason: "Critic freshness scenario complete.",
        workStore: terminalUserDecisionWorkStore("Critic freshness scenario complete.")
      },
      expectedOutcome: "Structured terminal state.",
      stopCondition: "Structured test terminal state reached.",
      transport: "strict_json"
    };
  }

  async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    this.criticRequests.push(request);
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "pass",
      confidence: 0.9,
      summary: "The release critic approves the current workspace snapshot.",
      objections: [],
      positiveFindings: [],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      },
      recommendedNextActions: []
    };
  }
}

class RepeatedCriticReviewDiffBackend extends StubResearchBackend {
  readonly capabilities = {
    actionControl: {
      nativeToolCalls: false,
      strictJsonFallback: true
    },
    criticReview: true
  };
  readonly researchRequests: ResearchActionRequest[] = [];
  readonly criticRequests: CriticReviewRequest[] = [];
  private step = 0;

  override async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Validate critic objection diff observations.",
      rationale: "The regression test preloads a workspace and runs the release critic twice.",
      searchQueries: [],
      localFocus: [],
      notebookPatch: {
        missionTarget: "research_brief",
        paperMode: "literature_review",
        currentFocus: "Compare repeated critic objections.",
        readiness: "Not ready until the critic objection diff is visible."
      }
    };
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);
    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: "release",
      reason: null,
      workStore: {
        collection: "workItems",
        entityId: null,
        filters: {},
        semanticQuery: null,
        limit: null,
        cursor: null,
        changes: {},
        entity: {}
      }
    };
    if (this.step < 2) {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "critic.review",
        rationale: "Run a release critic pass.",
        confidence: 0.9,
        inputs: baseInputs,
        expectedOutcome: "Critic feedback is persisted.",
        stopCondition: "Run the next critic pass or stop.",
        transport: "strict_json"
      };
    }
    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Stop after critic diff observation.",
      confidence: 0.8,
      inputs: {
        ...baseInputs,
        criticScope: null,
        reason: "Critic diff scenario complete.",
        workStore: terminalUserDecisionWorkStore("Critic diff scenario complete.")
      },
      expectedOutcome: "Structured terminal state.",
      stopCondition: "Structured terminal state reached.",
      transport: "strict_json"
    };
  }

  async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    this.criticRequests.push(request);
    const firstPass = this.criticRequests.length === 1;
    const objections: CriticReviewArtifact["objections"] = firstPass
      ? [
        {
          code: "section-too-thin",
          severity: "major",
          target: "section",
          targetId: "section-thin-synthesis",
          message: "The section is too thin.",
          affectedPaperIds: [],
          affectedEvidenceCellIds: [],
          affectedClaimIds: [],
          affectedSectionIds: ["section-thin-synthesis"],
          suggestedRevision: "Expand the synthesis."
        },
        {
          code: "missing-limitations",
          severity: "major",
          target: "manuscript",
          targetId: null,
          message: "The manuscript lacks limitations.",
          affectedPaperIds: [],
          affectedEvidenceCellIds: [],
          affectedClaimIds: [],
          affectedSectionIds: [],
          suggestedRevision: "Add a limitations discussion."
        }
      ]
      : [
        {
          code: "missing-limitations",
          severity: "major",
          target: "manuscript",
          targetId: null,
          message: "The manuscript lacks limitations.",
          affectedPaperIds: [],
          affectedEvidenceCellIds: [],
          affectedClaimIds: [],
          affectedSectionIds: [],
          suggestedRevision: "Add a limitations discussion."
        },
        {
          code: "weak-corpus-description",
          severity: "major",
          target: "section",
          targetId: "section-thin-synthesis",
          message: "The corpus description is weak.",
          affectedPaperIds: ["source-review-1"],
          affectedEvidenceCellIds: [],
          affectedClaimIds: [],
          affectedSectionIds: ["section-thin-synthesis"],
          suggestedRevision: "Describe selected source disposition."
        }
      ];
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "revise",
      confidence: 0.8,
      summary: "The release critic requests revision.",
      objections,
      positiveFindings: [],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      },
      recommendedNextActions: []
    };
  }
}

class SectionRepairErgonomicsBackend extends StubResearchBackend {
  readonly capabilities = {
    actionControl: {
      nativeToolCalls: false,
      strictJsonFallback: true
    },
    criticReview: true
  };
  readonly researchRequests: ResearchActionRequest[] = [];
  readonly criticRequests: CriticReviewRequest[] = [];
  private step = 0;

  constructor(private readonly scenario: "read" | "replace_block") {
    super();
  }

  override async planResearch(): Promise<ResearchPlan> {
    return {
      researchMode: "literature_synthesis",
      objective: "Validate manuscript section repair ergonomics.",
      rationale: "The regression test preloads a section with linked evidence.",
      searchQueries: [],
      localFocus: [],
      notebookPatch: {
        missionTarget: "research_brief",
        paperMode: "literature_review",
        currentFocus: "Repair manuscript sections from critic feedback and linked evidence.",
        readiness: "Not sufficient yet; section repair ergonomics are under test."
      }
    };
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    this.researchRequests.push(request);

    const baseInputs = {
      providerIds: [],
      searchQueries: [],
      evidenceTargets: [],
      paperIds: [],
      criticScope: null,
      reason: null
    };

    if (this.scenario === "read" && this.step === 0) {
      this.step += 1;
      return {
        schemaVersion: 1,
        action: "critic.review",
        rationale: "Create a critic objection that targets the manuscript section.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          criticScope: "release",
          workStore: {
            collection: "workItems",
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "A release critic review is available as repair context.",
        stopCondition: "Continue to section.read.",
        transport: "strict_json"
      };
    }

    if ((this.scenario === "read" && this.step === 1) || (this.scenario === "replace_block" && this.step === 0)) {
      this.step += 1;
      if (this.scenario === "replace_block") {
        return {
          schemaVersion: 1,
          action: "section.patch",
          rationale: "Replace the first section block using the block index contract from section.read.",
          confidence: 0.9,
          inputs: {
            ...baseInputs,
            workStore: {
              collection: "manuscriptSections",
              entityId: "section-thin-synthesis",
              filters: {},
              semanticQuery: null,
              limit: null,
              cursor: null,
              changes: {},
              entity: {
                operation: "replace_block",
                blockIndex: 1,
                markdown: "The repaired synthesis paragraph states the manuscript argument directly and uses the linked claim and evidence instead of raw workspace identifiers.",
                claimIds: ["claim-review-1"],
                sourceIds: ["source-review-1"]
              }
            }
          },
          expectedOutcome: "Only the targeted section block is replaced.",
          stopCondition: "The patched section remains linked to its claim.",
          transport: "strict_json"
        };
      }

      return {
        schemaVersion: 1,
        action: "section.read",
        rationale: "Inspect full section text, block indexes, linked evidence, and critic objections before repairing.",
        confidence: 0.9,
        inputs: {
          ...baseInputs,
          workStore: {
            collection: "manuscriptSections",
            entityId: "section-thin-synthesis",
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {}
          }
        },
        expectedOutcome: "The model receives a repair packet for the section.",
        stopCondition: "Section repair context is visible.",
        transport: "strict_json"
      };
    }

    return {
      schemaVersion: 1,
      action: "workspace.status",
      rationale: "Stop after the section repair ergonomics scenario.",
      confidence: 0.8,
      inputs: {
        ...baseInputs,
        reason: "Section repair ergonomics regression complete.",
        workStore: terminalUserDecisionWorkStore("Section repair ergonomics regression complete.")
      },
      expectedOutcome: "Structured terminal state.",
      stopCondition: "Regression complete.",
      transport: "strict_json"
    };
  }

  async reviewResearchArtifact(request: CriticReviewRequest): Promise<CriticReviewArtifact> {
    this.criticRequests.push(request);
    return {
      schemaVersion: 1,
      runId: request.runId,
      stage: request.stage,
      reviewer: "ephemeral_critic",
      readiness: "revise",
      confidence: 0.9,
      summary: "The manuscript section needs targeted repair.",
      objections: [{
        code: "section_process_prose",
        severity: "major",
        target: "section",
        targetId: "section-thin-synthesis",
        message: "The section contains placeholder/source-id prose instead of manuscript argument.",
        affectedPaperIds: ["source-review-1"],
        affectedEvidenceCellIds: ["evidence-review-1"],
        affectedClaimIds: ["claim-review-1"],
        affectedSectionIds: ["section-thin-synthesis"],
        suggestedRevision: "Replace the placeholder block with a substantive synthesis paragraph grounded in the linked claim and evidence."
      }],
      positiveFindings: [],
      revisionAdvice: {
        searchQueries: [],
        evidenceTargets: [],
        papersToExclude: [],
        papersToPromote: [],
        claimsToSoften: []
      },
      recommendedNextActions: ["section.read", "section.patch"]
    };
  }
}

class FakeCriticNotebookLinkFinalizeBackend extends CriticAvailableFinalizeSeededWorkspaceBackend {
  private patched = false;

  constructor(private readonly fakeCriticPath: string) {
    super(null, "research_brief");
  }

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }
    if (!this.patched) {
      this.patched = true;
      this.researchRequests.push(request);
      return {
        schemaVersion: 1,
        action: "notebook.patch",
        rationale: "Try to fake critic authority through a notebook artifact link.",
        confidence: 0.88,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: null,
          workStore: {
            collection: null,
            entityId: null,
            filters: {},
            semanticQuery: null,
            limit: null,
            cursor: null,
            changes: {},
            entity: {
              artifactLink: {
                label: "Critic review: release (pass)",
                path: this.fakeCriticPath,
                kind: "other"
              }
            }
          }
        },
        expectedOutcome: "The fake critic link is visible but not trusted for finalization.",
        stopCondition: "Continue to manuscript.finalize.",
        transport: "strict_json"
      };
    }

    return super.chooseResearchAction(request);
  }
}


test("architecture contract: worker must not run hidden extraction after source selection", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-no-hidden-extraction-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can source selection checkpoint without hidden extraction?",
      researchDirection: "The model owns the next research action.",
      successCriterion: "Extraction happens only after an explicit extraction/evidence tool action."
    }, ["clawresearch", "research-loop"]);

    const backend = new ArchitectureForbiddenWorkflowBackend();
    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceToolAdapter: new MultiPaperSourceToolAdapter(2)
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const agentSteps = await readFile((await runStore.load(run.id)).artifacts.agentStepsPath, "utf8");

    assert.equal(backend.extractionCalls, 0);
    assert.equal(workStore.objects.extractions.length, 0);
    assert.equal(workStore.objects.evidenceCells.length, 0);
    assert.doesNotMatch(agentSteps, /extract_selected_papers/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("architecture contract: evidence matrix is a model-selected view, not a hidden workflow driver", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-no-hidden-matrix-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can evidence construction stay model-owned?",
      researchDirection: "Do not build evidence views unless the model chooses an evidence/check/view tool.",
      successCriterion: "No mandatory evidence matrix phase should run."
    }, ["clawresearch", "research-loop"]);

    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new ArchitectureForbiddenWorkflowBackend(),
      sourceToolAdapter: new MultiPaperSourceToolAdapter(2)
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const agentSteps = await readFile(completedRun.artifacts.agentStepsPath, "utf8");

    assert.equal(workStore.objects.evidenceCells.length, 0);
    assert.doesNotMatch(agentSteps, /build_evidence_matrix/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("architecture contract: old phase artifacts are not written during a source checkpoint", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-no-old-phase-artifacts-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can next work be represented by explicit work items?",
      researchDirection: "The model should create work items when it wants them.",
      successCriterion: "Old phase artifacts must not be hidden runtime exports."
    }, ["clawresearch", "research-loop"]);

    const backend = new ArchitectureForbiddenWorkflowBackend();
    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceToolAdapter: new MultiPaperSourceToolAdapter(3)
    });

    const runDirectory = (await runStore.load(run.id)).artifacts.runDirectory;

    await assertOldPhaseArtifactsAbsent(runDirectory);
    await assert.rejects(readFile(path.join(projectRoot, ".clawresearch", "research-journal.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("architecture contract: critic review scopes are explicit researcher tools, not automatic phases", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-no-hidden-critic-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can critic review be model-selected?",
      researchDirection: "The model should call critic.review when a fresh critique is useful.",
      successCriterion: "No semantic critic scope should run as hidden workflow."
    }, ["clawresearch", "research-loop"]);

    const backend = new ArchitectureForbiddenWorkflowBackend();
    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceToolAdapter: new MultiPaperSourceToolAdapter(2)
    });

    const completedRun = await runStore.load(run.id);
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    assert.deepEqual(backend.criticScopes, []);
    assert.ok(backend.actionRequests.every((request) => !request.allowedActions.includes("critic.review")));
    assert.match(stdout, /Critic review unavailable: backend stub:research does not expose a critic review transport/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("critic backend failures are linked into notebook context", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-critic-failure-visible-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "critic failure visibility",
      researchQuestion: "Does a failed configured critic remain visible?",
      researchDirection: "The runtime should persist the failed critic artifact link.",
      successCriterion: "The researcher can see the critic failure after the tool result window."
    }, ["clawresearch", "research-loop"]);

    const backend = new FailingCriticBackend();
    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const criticReview = JSON.parse(await readFile(completedRun.artifacts.criticReleaseReviewPath, "utf8")) as {
      readiness: string;
      objections: Array<{ code: string }>;
    };
    const laterRequest = backend.researchRequests.find((request) => (
      request.workStore?.dashboard?.recentCriticReviews?.some((review) => review.artifactPath === completedRun.artifacts.criticReleaseReviewPath)
    ));

    assert.equal(criticReview.readiness, "block");
    assert.equal(criticReview.objections[0]?.code, "critic-unavailable");
    assert.ok(workStore.notebook.artifactLinks.some((artifact) => artifact.label === "Critic review: release (block)" && artifact.path === completedRun.artifacts.criticReleaseReviewPath));
    assert.ok(laterRequest, "failed critic review should remain visible through recentCriticReviews");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("repeated critic reviews replace stale notebook artifact links", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-critic-review-replace-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "critic review replacement",
      researchQuestion: "Does the newest critic review replace stale notebook readiness?",
      researchDirection: "The runtime should keep the latest same-stage critic artifact link.",
      successCriterion: "Only the latest readiness is visible for the critic artifact path."
    }, ["clawresearch", "research-loop"]);

    const backend = new RepeatedCriticBackend();
    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const criticReview = JSON.parse(await readFile(completedRun.artifacts.criticReleaseReviewPath, "utf8")) as {
      readiness: string;
    };
    const matchingLinks = workStore.notebook.artifactLinks
      .filter((artifact) => artifact.path === completedRun.artifacts.criticReleaseReviewPath);
    const laterRequest = backend.researchRequests.find((request) => (
      request.workStore?.dashboard?.recentCriticReviews?.some((review) => (
        review.artifactPath === completedRun.artifacts.criticReleaseReviewPath
          && review.readiness === "pass"
      ))
    ));

    assert.equal(criticReview.readiness, "pass");
    assert.equal(matchingLinks.length, 1);
    assert.equal(matchingLinks[0]?.label, "Critic review: release (pass)");
    assert.ok(laterRequest, "latest same-stage critic review should be visible without stale readiness");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("architecture contract: invalid terminal workspace.status becomes an observation and the worker continues", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-status-observation-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can invalid terminal status attempts be rejected without stopping the worker?",
      researchDirection: "The runtime should return failed status attempts as observations and let the researcher continue.",
      successCriterion: "Only structured user decisions or concrete external blockers may stop the worker."
    }, ["clawresearch", "research-loop"]);

    const backend = new InvalidStatusThenDecisionBackend();
    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });

    assert.equal(completedRun.status, "completed");
    assert.equal(backend.sourceActions.length, 2);
    assert.equal(workStore.worker.status, "needs_user_decision");
    assert.match(workStore.worker.statusReason, /Choose whether to broaden/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("notebook.read and notebook.patch are explicit model-facing tools with artifact/evidence links", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-notebook-tools-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "model-driven research workspaces",
      researchQuestion: "Can the researcher maintain a simple living notebook?",
      researchDirection: "The notebook should keep objective, definition of done, tasks, readiness, and links visible.",
      successCriterion: "Notebook updates happen only through explicit notebook tools."
    }, ["clawresearch", "research-loop"]);

    const backend = new NotebookToolBackend();
    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const toolResults = backend.researchRequests.flatMap((request) => request.toolResults ?? []);
    const readResult = toolResults.find((result) => result.action === "notebook.read");

    assert.equal(workStore.notebook.objective, "Produce a professional review of model-driven research workspaces.");
    assert.deepEqual(workStore.notebook.definitionOfDone, [
      "Representative sources are extracted.",
      "Central claims are supported by citations.",
      "The final manuscript is finalized only after checks pass."
    ]);
	    const synthesisTask = workStore.notebook.tasks.find((task) => task.id === "task-build-synthesis");
	    assert.ok(synthesisTask);
	    assert.deepEqual(synthesisTask.linkedEvidenceCellIds, ["evidence-cell-planned"]);
	    assert.deepEqual(synthesisTask.linkedArtifactPaths, ["research-notes/synthesis-plan.md"]);
	    assert.ok(backend.researchRequests[1]?.workStore?.notebook.tasks.some((task) => task.title === "Build claim-led synthesis from selected evidence"));
    assert.equal(readResult?.collection, "notebook");
    assert.equal(readResult?.items?.[0]?.kind, "notebookTask");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("planning persists the model-authored notebook patch before research actions", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-planning-notebook-patch-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "planning-owned notebook",
      researchQuestion: "Does planning initialize notebook project state?",
      researchDirection: "Persist model-authored task state before tool actions.",
      successCriterion: "The notebook has tasks, focus, and readiness after planning."
    }, ["clawresearch", "research-loop"]);

    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new StubResearchBackend()
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const agentSteps = await readFile((await runStore.load(run.id)).artifacts.agentStepsPath, "utf8");

    assert.ok(workStore.notebook.tasks.some((task) => task.id === "task-initialize-research-workspace"));
    assert.equal(workStore.notebook.currentFocus, "Establish the initial research workspace.");
    assert.match(workStore.notebook.readiness, /Not sufficient yet/);
    assert.match(agentSteps, /protocol\.create_or_revise/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("architecture contract: manuscript completion requires explicit release verification and manuscript finalization", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-release-invariants-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can release state be validated explicitly?",
      researchDirection: "A draft or checked section must not imply released research.",
      successCriterion: "Manuscript completion requires explicit release.verify and manuscript.finalize."
    }, ["clawresearch", "research-loop"]);

    const backend = new ArchitectureForbiddenWorkflowBackend();
    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceToolAdapter: new MultiPaperSourceToolAdapter(3)
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const agentSteps = await readFile((await runStore.load(run.id)).artifacts.agentStepsPath, "utf8");

    assert.doesNotMatch(agentSteps, /"action":"release\.verify"|"action":"manuscript\.finalize"/);
    assert.equal(workStore.worker.completion, null);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("architecture contract: externally_blocked requires a concrete external blocker record", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-external-blockers-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can internal failures avoid masquerading as external blockers?",
      researchDirection: "Only credentials, quotas, permissions, source access, or required resources are external blockers.",
      successCriterion: "Internal tool failures remain recoverable/checkpointed diagnostics."
    }, ["clawresearch", "research-loop"]);

    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceToolAdapter: new MultiPaperSourceToolAdapter(1)
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });

    assert.notEqual(workStore.worker.status, "externally_blocked");
    assert.doesNotMatch(workStore.worker.userBlockers.join("\n"), /credential|quota|provider outage|source access|permission/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("provider overload during planning becomes an external blocker instead of a failed run", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-planning-provider-overload-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "research agents",
      researchQuestion: "How should provider overload be represented?",
      researchDirection: "Provider overload is an external blocker, not malformed research output.",
      successCriterion: "The worker should persist an externally_blocked state and leave /go resumable."
    }, ["clawresearch", "research-loop"]);

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new PlanningProviderOverloadBackend()
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const paperMarkdown = await readFile(completedRun.artifacts.paperPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(completedRun.job.exitCode, 0);
    assert.match(completedRun.statusMessage ?? "", /external blocker/i);
    assert.equal(workStore.worker.status, "externally_blocked");
    assert.equal(workStore.worker.completion, null);
    assert.ok(workStore.worker.userBlockers.some((blocker) => /overloaded/i.test(blocker)));
    assert.match(paperMarkdown, /external blocker/i);
    assert.match(paperMarkdown, /overloaded/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("architecture contract: critic or manuscript prose is not converted into hidden recovery queries", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-no-hidden-recovery-queries-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can critic advice remain visible work instead of hidden retrieval?",
      researchDirection: "Only a model-selected source.search action may run retrieval queries.",
      successCriterion: "The runtime must not synthesize strategic source queries from critic text."
    }, ["clawresearch", "research-loop"]);

    const sourceToolAdapter = new EvidenceRecoverySourceToolAdapter();
    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new StubResearchBackend(),
      sourceToolAdapter
    });

    assert.equal(sourceToolAdapter.requests.length, 0);
    assert.deepEqual(sourceToolAdapter.requests.flatMap((request) => request.revisionQueries ?? []), []);
    assert.deepEqual(sourceToolAdapter.requests.flatMap((request) => request.recoveryQueries ?? []), []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("explicit researcher tools create extraction, evidence, critic feedback, release checks, and finalized manuscript only when selected", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-explicit-researcher-tools-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "agentic research runtimes",
      researchQuestion: "How should ClawResearch expose research tools without hidden workflow?",
      researchDirection: "Validate explicit extraction, evidence, critic, release, and manuscript tools.",
      successCriterion: "All research objects are created through model-selected actions."
    }, ["clawresearch", "research-loop"]);
    const sourceId = await seedCanonicalWorkspaceSource({
      projectRoot,
      runId: run.id,
      brief: run.brief,
      now
    });

    const backend = new ExplicitResearchToolBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const paperMarkdown = await readFile(completedRun.artifacts.paperPath, "utf8");
    const references = JSON.parse(await readFile(completedRun.artifacts.referencesPath, "utf8")) as {
      referenceCount: number;
      references: Array<{ sourceId: string; citation: string }>;
    };
    const paper = JSON.parse(await readFile(completedRun.artifacts.paperJsonPath, "utf8")) as {
      readinessStatus: string;
      referencedPaperIds: string[];
    };
    const criticReview = JSON.parse(await readFile(completedRun.artifacts.criticReleaseReviewPath, "utf8")) as {
      readiness: string;
      objections: Array<{
        targetId: string | null;
        affectedPaperIds: string[];
        affectedClaimIds: string[];
        affectedSectionIds: string[];
      }>;
      positiveFindings: unknown[];
    };
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const agentSteps = await readFile(completedRun.artifacts.agentStepsPath, "utf8");

    assert.equal(exitCode, 0);
    assert.deepEqual(backend.sourceActions.map((action) => action.action), [
      "extraction.create",
      "evidence.create_cell",
      "evidence.matrix_view",
      "claim.create",
      "claim.link_support",
      "section.create",
      "notebook.patch",
      "critic.review",
      "release.verify",
      "manuscript.finalize"
    ]);
    const validActions = new Set(workspaceResearchActions());
    const emittedHints = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .flatMap((result) => result.nextHints ?? []);
    for (const hint of emittedHints) {
      assert.ok(validActions.has(hint as never), `Unexpected model-facing next hint ${hint}`);
    }
    const claimCreateResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "claim.create");
    assert.equal(claimCreateResult?.collection, "claims");
    assert.equal(claimCreateResult?.entity?.kind, "claim");
    assert.ok(claimCreateResult?.entity?.id);
    assert.ok(claimCreateResult?.nextHints?.includes("claim.link_support"));
    const supportLinkResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "claim.link_support");
    assert.equal(supportLinkResult?.collection, "citations");
    assert.equal(supportLinkResult?.entity?.kind, "citation");
    assert.ok(supportLinkResult?.related?.some((item) => item.kind === "claim"));
    const sectionCreateResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "section.create");
    assert.equal(sectionCreateResult?.collection, "manuscriptSections");
    assert.equal(sectionCreateResult?.entity?.kind, "manuscriptSection");
    const releaseVerifyResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "release.verify");
    assert.equal(releaseVerifyResult?.status, "ok");
    assert.match(releaseVerifyResult?.message ?? "", /Mechanical release verification only/i);
    assert.match(releaseVerifyResult?.message ?? "", /Release critic freshness is fresh/i);
    assert.ok(releaseVerifyResult?.related?.some((item) => item.kind === "notebookDiagnostic"));
    assert.equal(workStore.objects.extractions.length, 1);
    assert.equal(workStore.objects.extractions[0]?.sourceId, sourceId);
    assert.equal(workStore.objects.evidenceCells.length, 1);
    assert.equal(workStore.objects.evidenceCells[0]?.sourceId, sourceId);
    assert.equal(workStore.objects.citations.length, 1);
    assert.equal(workStore.objects.citations[0]?.sourceId, sourceId);
    assert.equal(workStore.objects.workItems.filter((item) => item.source === "critic").length, 0);
    assert.equal(backend.criticRequests.length, 1);
    assert.equal(backend.criticRequests[0]?.stage, "release");
    assert.equal(backend.criticRequests[0]?.workspace?.claims[0]?.id, workStore.objects.claims[0]?.id);
    assert.equal(backend.criticRequests[0]?.workspace?.manuscriptSections[0]?.id, workStore.objects.manuscriptSections[0]?.id);
    assert.ok(workStore.notebook.artifactLinks.some((artifact) => artifact.label === "Critic review: release (pass)" && artifact.path === completedRun.artifacts.criticReleaseReviewPath && artifact.createdBy === "runtime"));
    assert.ok(workStore.objects.releaseChecks.length > 0);
    assert.equal(references.referenceCount, 1);
    assert.equal(references.references[0]?.sourceId, sourceId);
    assert.equal(paper.readinessStatus, "ready_for_revision");
    assert.deepEqual(paper.referencedPaperIds, [sourceId]);
    assert.equal(criticReview.readiness, "pass");
    assert.equal(criticReview.objections[0]?.targetId, null);
    assert.deepEqual(criticReview.objections[0]?.affectedPaperIds, []);
    assert.deepEqual(criticReview.objections[0]?.affectedClaimIds, [workStore.objects.claims[0]?.id]);
    assert.deepEqual(criticReview.objections[0]?.affectedSectionIds, [workStore.objects.manuscriptSections[0]?.id]);
    assert.equal(criticReview.positiveFindings.length, 5);
    const postCriticRequest = backend.researchRequests.find((request) => (
      request.workStore?.dashboard?.recentCriticReviews?.some((review) => review.artifactPath === completedRun.artifacts.criticReleaseReviewPath)
    ));
    assert.ok(postCriticRequest, "critic review summary should remain visible in later workspace dashboard context");
    assert.match(paperMarkdown, /Tool-Loop Architecture/);
    assert.match(paperMarkdown, /Agentic research tool runtimes for scientific synthesis/);
    assert.doesNotMatch(paperMarkdown, /## Abstract/);
    assert.doesNotMatch(paperMarkdown, /## Manuscript Structure/);
    assert.doesNotMatch(paperMarkdown, /## Claim Ledger/);
    assert.match(paperMarkdown, /## References/);
    assert.match(stdout, /Research tool observation: Extraction created/);
    assert.match(stdout, /Research tool observation: Evidence matrix view returned 1 row/);
    assert.match(stdout, /Research tool observation: Manuscript finalized from workspace state/);
    assert.match(agentSteps, /"action":"manuscript\.finalize_result"/);
    assert.match(agentSteps, /"toolAction":"manuscript\.finalize"/);
    assert.match(agentSteps, /"manuscriptFinalized":1/);
    assert.equal(workStore.worker.status, "working");
    assert.equal(workStore.worker.completion?.kind, "manuscript_finalized");
    assert.deepEqual(workStore.worker.completion?.artifactPaths, [
      completedRun.artifacts.paperPath,
      completedRun.artifacts.paperJsonPath,
      completedRun.artifacts.referencesPath,
      completedRun.artifacts.manuscriptChecksPath
    ]);
    assert.ok(workStore.notebook.artifactLinks.some((artifact) => artifact.kind === "paper" && artifact.path === completedRun.artifacts.paperPath));
    assert.ok(workStore.notebook.artifactLinks.some((artifact) => artifact.kind === "references" && artifact.path === completedRun.artifacts.referencesPath));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("explicit evidence matrix view is read-only and does not create evidence cells", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-explicit-matrix-readonly-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "agentic research runtimes",
      researchQuestion: "Can matrix views remain read-only?",
      researchDirection: "Run extraction then matrix view without evidence-cell creation.",
      successCriterion: "Matrix view must not mutate evidence objects."
    }, ["clawresearch", "research-loop"]);
    await seedCanonicalWorkspaceSource({
      projectRoot,
      runId: run.id,
      brief: run.brief,
      now
    });

    class MatrixOnlyBackend extends StubResearchBackend {
      private extractionCreated = false;
      private matrixViewed = false;

      override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
        if (request.phase !== "research") {
          return super.chooseResearchAction(request);
        }
        const sourceId = request.workStore?.recentSources[0]?.id ?? "source-agentic-tool-runtime";
        if (!this.extractionCreated) {
          this.extractionCreated = true;
          return {
            schemaVersion: 1,
            action: "extraction.create",
            rationale: "Create one extraction for read-only matrix inspection.",
            confidence: 0.86,
            inputs: {
              providerIds: [],
              searchQueries: [],
              evidenceTargets: [],
              paperIds: [sourceId],
              criticScope: null,
              reason: null,
              workStore: {
                collection: "extractions",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: {
                  sourceId,
                  problemSetting: "Matrix views summarize model-authored extractions.",
                  successSignals: ["read-only view"],
                  confidence: "medium"
                }
              }
            },
            expectedOutcome: "Extraction exists.",
            stopCondition: "Continue to matrix view.",
            transport: "strict_json"
          };
        }
        if (!this.matrixViewed) {
          this.matrixViewed = true;
          return {
            schemaVersion: 1,
            action: "evidence.matrix_view",
            rationale: "Inspect the extraction-derived matrix.",
            confidence: 0.84,
            inputs: {
              providerIds: [],
              searchQueries: [],
              evidenceTargets: [],
              paperIds: [sourceId],
              criticScope: null,
              reason: null,
              workStore: {
                collection: "evidenceCells",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: {}
              }
            },
            expectedOutcome: "Matrix view is visible.",
            stopCondition: "Checkpoint.",
            transport: "strict_json"
          };
        }
        return {
          schemaVersion: 1,
          action: "workspace.status",
          rationale: "Checkpoint after read-only matrix view.",
          confidence: 0.8,
          inputs: {
            providerIds: [],
            searchQueries: [],
            evidenceTargets: [],
            paperIds: [],
            criticScope: null,
            reason: "Matrix view read-only test complete.",
            workStore: terminalUserDecisionWorkStore("Matrix view read-only test complete.")
          },
          expectedOutcome: "Stop only through a structured user-decision terminal state.",
          stopCondition: "Structured test decision reached.",
          transport: "strict_json"
        };
      }
    }

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new MatrixOnlyBackend()
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const stdout = await readFile((await runStore.load(run.id)).artifacts.stdoutPath, "utf8");

    assert.equal(exitCode, 0);
    assert.equal(workStore.objects.extractions.length, 1);
    assert.equal(workStore.objects.evidenceCells.length, 0);
    assert.match(stdout, /Evidence matrix view returned 1 row/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("claim.link_support failures return repair context without auto-approving support", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-support-repair-diagnostics-"));
  const now = createNow();

  try {
    const brief = {
      topic: "support-link diagnostics",
      researchQuestion: "Can support-link failures return useful repair context?",
      researchDirection: "Test claim and evidence-cell previews after missing-id support-link failure.",
      successCriterion: "The model receives valid IDs and a caution without creating a citation."
    };
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create(brief, ["clawresearch", "research-loop"]);
    const sourceId = await seedCanonicalWorkspaceSource({
      projectRoot,
      runId: run.id,
      brief,
      now
    });
    const backend = new SupportRepairDiagnosticsBackend(sourceId);

    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const toolResults = backend.researchRequests.flatMap((request) => request.toolResults ?? []);
    const blockedSupport = toolResults.find((result) => result.action === "claim.link_support" && result.status === "blocked");

    assert.equal(exitCode, 0);
    assert.equal(workStore.objects.citations.length, 0);
    assert.equal(blockedSupport?.collection, "citations");
    assert.match(blockedSupport?.message ?? "", /Only link support when the evidence snippet actually supports the claim/i);
    assert.ok(blockedSupport?.items?.some((item) => item.kind === "claim"));
    assert.ok(blockedSupport?.related?.some((item) => item.kind === "evidenceCell"));
    assert.ok(blockedSupport?.nextHints?.includes("evidence.create_cell"));
    assert.ok(blockedSupport?.nextHints?.includes("claim.link_support"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("claim.link_support preserves distinct support links for the same long claim id", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-support-link-id-regression-"));
  const now = createNow();

  try {
    const brief = {
      topic: "support-link identity regression",
      researchQuestion: "Can one claim accumulate support links from multiple selected sources?",
      researchDirection: "Attach multiple evidence-backed citations to the same long claim id.",
      successCriterion: "Different source/evidence identities must not overwrite each other."
    };
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create(brief, ["clawresearch", "research-loop"]);
    const seeded = await seedSharedClaimSupportWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now
    });

    const backend = new MultiSourceSupportLinkBackend(seeded.claimId, seeded.sourceIds, seeded.evidenceCellIds);
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const linkedSourceIds = workStore.objects.citations.map((citation) => citation.sourceId).sort();
    const supportLinkIds = workStore.objects.citations.map((citation) => citation.id);
    const supportResults = backend.researchRequests.flatMap((request) => request.toolResults ?? [])
      .filter((result) => result.action === "claim.link_support");

    assert.equal(exitCode, 0);
    assert.equal(workStore.objects.citations.length, seeded.sourceIds.length);
    assert.equal(new Set(supportLinkIds).size, seeded.sourceIds.length);
    assert.deepEqual(linkedSourceIds, [...seeded.sourceIds].sort());
    assert.equal(workStore.objects.claims[0]?.sourceIds.length, seeded.sourceIds.length);
    assert.equal(workStore.objects.claims[0]?.supportStatus, "supported");
    assert.ok(supportResults.every((result) => result.stateDelta?.supportLinksCreated === 1));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("claim.link_support replace supersedes old support without hard-deleting audit history", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-support-link-replace-"));
  const now = createNow();

  try {
    const brief = {
      topic: "support-link replacement",
      researchQuestion: "Can the researcher explicitly replace provisional support?",
      researchDirection: "Attach one support link, replace it with another, and preserve lifecycle history.",
      successCriterion: "Old support is superseded while the replacement remains active."
    };
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create(brief, ["clawresearch", "research-loop"]);
    const seeded = await seedSharedClaimSupportWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now
    });

    const backend = new SupportLinkLifecycleBackend("replace", seeded.claimId, seeded.sourceIds, seeded.evidenceCellIds);
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const superseded = workStore.objects.citations.filter((citation) => citation.status === "superseded");
    const active = workStore.objects.citations.filter((citation) => citation.status !== "superseded" && citation.status !== "retired");
    const claim = workStore.objects.claims.find((candidate) => candidate.id === seeded.claimId);
    const replaceResult = backend.researchRequests.flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "claim.link_support" && result.stateDelta?.supportLinksSuperseded === 1);

    assert.equal(exitCode, 0);
    assert.equal(workStore.objects.citations.length, 2);
    assert.equal(superseded.length, 1);
    assert.equal(active.length, 1);
    assert.equal(superseded[0]?.sourceId, seeded.sourceIds[0]);
    assert.equal(active[0]?.sourceId, seeded.sourceIds[1]);
    assert.equal(superseded[0]?.supersededBy, active[0]?.id);
    assert.deepEqual(claim?.sourceIds, [seeded.sourceIds[1]]);
    assert.equal(claim?.supportStatus, "supported");
    assert.match(replaceResult?.message ?? "", /superseded 1 old support link/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("claim.link_support remove retires support without deleting the citation record", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-support-link-remove-"));
  const now = createNow();

  try {
    const brief = {
      topic: "support-link removal",
      researchQuestion: "Can the researcher explicitly retire mistaken support?",
      researchDirection: "Attach a support link, remove it, and preserve audit history.",
      successCriterion: "The support link is retired and no longer supports the claim."
    };
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create(brief, ["clawresearch", "research-loop"]);
    const seeded = await seedSharedClaimSupportWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now
    });

    const backend = new SupportLinkLifecycleBackend("remove", seeded.claimId, seeded.sourceIds, seeded.evidenceCellIds);
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const retired = workStore.objects.citations.filter((citation) => citation.status === "retired");
    const active = workStore.objects.citations.filter((citation) => citation.status !== "superseded" && citation.status !== "retired");
    const claim = workStore.objects.claims.find((candidate) => candidate.id === seeded.claimId);
    const removeResult = backend.researchRequests.flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "claim.link_support" && result.stateDelta?.supportLinksRetired === 1);

    assert.equal(exitCode, 0);
    assert.equal(workStore.objects.citations.length, 1);
    assert.equal(retired.length, 1);
    assert.equal(active.length, 0);
    assert.equal(retired[0]?.sourceId, seeded.sourceIds[0]);
    assert.deepEqual(claim?.sourceIds, []);
    assert.equal(claim?.supportStatus, "weak");
    assert.match(removeResult?.message ?? "", /Retired 1 support link/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("extraction.patch and evidence.patch update lifecycle state explicitly", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-extraction-evidence-patch-"));
  const now = createNow();

  try {
    const brief = {
      topic: "extraction and evidence lifecycle",
      researchQuestion: "Can the researcher revise provenance objects explicitly?",
      researchDirection: "Patch lifecycle status on extraction and evidence records.",
      successCriterion: "Patch tools update lifecycle state without hidden workflow."
    };
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create(brief, ["clawresearch", "research-loop"]);
    await seedSharedClaimSupportWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now
    });

    const backend = new ExtractionEvidencePatchBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const extraction = workStore.objects.extractions.find((candidate) => candidate.id === "extraction-support-1");
    const evidenceCell = workStore.objects.evidenceCells.find((candidate) => candidate.id === "evidence-support-1");
    const patchResultActions = new Set(backend.researchRequests.flatMap((request) => request.toolResults ?? [])
      .filter((result) => result.action === "extraction.patch" || result.action === "evidence.patch")
      .map((result) => result.action));

    assert.equal(exitCode, 0);
    assert.equal(extraction?.status, "superseded");
    assert.equal(extraction?.supersededBy, "extraction-support-2");
    assert.equal(evidenceCell?.status, "retired");
    assert.deepEqual([...patchResultActions].sort(), ["evidence.patch", "extraction.patch"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("durable research content never falls back to process metadata", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-content-boundaries-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "content-boundary contracts",
      researchQuestion: "Can process metadata be kept out of durable research content?",
      researchDirection: "Exercise blocked and successful create tools.",
      successCriterion: "Only explicit content fields persist."
    }, ["clawresearch", "research-loop"]);
    const sourceId = await seedCanonicalWorkspaceSource({
      projectRoot,
      runId: run.id,
      brief: run.brief,
      now
    });

    class ContentBoundaryBackend extends StubResearchBackend {
      private step = 0;
      readonly researchRequests: ResearchActionRequest[] = [];

      override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
        if (request.phase !== "research") {
          return super.chooseResearchAction(request);
        }
        this.researchRequests.push(request);
        this.step += 1;
        const baseInputs = {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [sourceId],
          criticScope: null,
          reason: "PROCESS REASON MUST NOT PERSIST"
        };
        const extractionId = request.toolResults?.find((result) => result.action === "extraction.create" && result.status === "ok")?.entity?.id ?? null;

        if (this.step === 1) {
          return {
            schemaVersion: 1,
            action: "extraction.create",
            rationale: "PROCESS RATIONALE MUST NOT PERSIST",
            confidence: 0.8,
            inputs: {
              ...baseInputs,
              workStore: {
                collection: "extractions",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: { sourceId }
              }
            },
            expectedOutcome: "PROCESS EXPECTED EXTRACTION MUST NOT PERSIST",
            stopCondition: "Process stop metadata.",
            transport: "strict_json"
          };
        }
        if (this.step === 2) {
          return {
            schemaVersion: 1,
            action: "extraction.create",
            rationale: "Create explicit extraction content.",
            confidence: 0.9,
            inputs: {
              ...baseInputs,
              reason: null,
              workStore: {
                collection: "extractions",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: {
                  sourceId,
                  problemSetting: "Explicit extraction content is source-derived.",
                  successSignals: ["Explicit extraction fields persist."]
                }
              }
            },
            expectedOutcome: "Create extraction.",
            stopCondition: "Extraction exists.",
            transport: "strict_json"
          };
        }
        if (this.step === 3) {
          return {
            schemaVersion: 1,
            action: "evidence.create_cell",
            rationale: "PROCESS RATIONALE MUST NOT PERSIST",
            confidence: 0.8,
            inputs: {
              ...baseInputs,
              workStore: {
                collection: "evidenceCells",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: { sourceId, extractionId, field: "successSignals" }
              }
            },
            expectedOutcome: "PROCESS EXPECTED EVIDENCE MUST NOT PERSIST",
            stopCondition: "Process stop metadata.",
            transport: "strict_json"
          };
        }
        if (this.step === 4) {
          return {
            schemaVersion: 1,
            action: "evidence.create_cell",
            rationale: "Create explicit evidence content.",
            confidence: 0.9,
            inputs: {
              ...baseInputs,
              reason: null,
              workStore: {
                collection: "evidenceCells",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: {
                  sourceId,
                  extractionId,
                  field: "successSignals",
                  value: "Explicit evidence value persists.",
                  confidence: "medium"
                }
              }
            },
            expectedOutcome: "Create evidence cell.",
            stopCondition: "Evidence exists.",
            transport: "strict_json"
          };
        }
        if (this.step === 5) {
          return {
            schemaVersion: 1,
            action: "claim.create",
            rationale: "PROCESS RATIONALE MUST NOT PERSIST",
            confidence: 0.8,
            inputs: {
              ...baseInputs,
              workStore: {
                collection: "claims",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: {}
              }
            },
            expectedOutcome: "PROCESS EXPECTED CLAIM MUST NOT PERSIST",
            stopCondition: "Process stop metadata.",
            transport: "strict_json"
          };
        }
        if (this.step === 6) {
          return {
            schemaVersion: 1,
            action: "claim.create",
            rationale: "Create explicit claim content.",
            confidence: 0.9,
            inputs: {
              ...baseInputs,
              reason: null,
              workStore: {
                collection: "claims",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: {
                  text: "Explicit claim text persists.",
                  evidence: "Explicit evidence statement persists.",
                  confidence: "medium"
                }
              }
            },
            expectedOutcome: "Create claim.",
            stopCondition: "Claim exists.",
            transport: "strict_json"
          };
        }
        if (this.step === 7) {
          return {
            schemaVersion: 1,
            action: "section.create",
            rationale: "PROCESS RATIONALE MUST NOT PERSIST",
            confidence: 0.8,
            inputs: {
              ...baseInputs,
              workStore: {
                collection: "manuscriptSections",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: { sectionId: "boundary", title: "Boundary" }
              }
            },
            expectedOutcome: "PROCESS EXPECTED SECTION MUST NOT PERSIST",
            stopCondition: "Process stop metadata.",
            transport: "strict_json"
          };
        }
        if (this.step === 8) {
          return {
            schemaVersion: 1,
            action: "section.create",
            rationale: "Create explicit section content.",
            confidence: 0.9,
            inputs: {
              ...baseInputs,
              reason: null,
              workStore: {
                collection: "manuscriptSections",
                entityId: null,
                filters: {},
                semanticQuery: null,
                limit: null,
                cursor: null,
                changes: {},
                entity: {
                  sectionId: "boundary",
                  title: "Boundary",
                  markdown: "Explicit manuscript markdown persists."
                }
              }
            },
            expectedOutcome: "Create section.",
            stopCondition: "Section exists.",
            transport: "strict_json"
          };
        }

        return {
          schemaVersion: 1,
          action: "workspace.status",
          rationale: "Stop after content-boundary checks.",
          confidence: 0.8,
          inputs: {
            providerIds: [],
            searchQueries: [],
            evidenceTargets: [],
            paperIds: [],
            criticScope: null,
            reason: "Content boundary test complete.",
            workStore: terminalUserDecisionWorkStore("Content boundary test complete.")
          },
          expectedOutcome: "Structured test terminal state.",
          stopCondition: "Stop after blocked and successful content tools.",
          transport: "strict_json"
        };
      }
    }

    const backend = new ContentBoundaryBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const toolResults = backend.researchRequests.flatMap((request) => request.toolResults ?? []);
    const uniqueToolResults = [...new Map(toolResults.map((result) => [`${result.status}:${result.action}:${result.message}`, result])).values()];
    const persistedText = JSON.stringify(workStore.objects);

    assert.equal(exitCode, 0);
    assert.deepEqual(
      uniqueToolResults
        .filter((result) => result.status === "blocked")
        .map((result) => result.action),
      ["extraction.create", "evidence.create_cell", "claim.create", "section.create"]
    );
    assert.equal(workStore.objects.extractions.length, 1);
    assert.equal(workStore.objects.evidenceCells.length, 1);
    assert.equal(workStore.objects.claims.length, 1);
    assert.equal(workStore.objects.manuscriptSections.length, 1);
    assert.equal(workStore.objects.claims[0]?.text, "Explicit claim text persists.");
    assert.equal(workStore.objects.evidenceCells[0]?.value, "Explicit evidence value persists.");
    assert.equal(workStore.objects.manuscriptSections[0]?.markdown, "Explicit manuscript markdown persists.");
    assert.doesNotMatch(persistedText, /PROCESS RATIONALE MUST NOT PERSIST/);
    assert.doesNotMatch(persistedText, /PROCESS EXPECTED/);
    assert.doesNotMatch(persistedText, /PROCESS REASON MUST NOT PERSIST/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("explicit manuscript.finalize fails visibly when release invariants are missing", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-explicit-release-blocked-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "agentic research runtimes",
      researchQuestion: "Can release fail visibly without hidden repair?",
      researchDirection: "Release before claims, sections, support links, and references exist.",
      successCriterion: "The explicit release tool reports invariant failures."
    }, ["clawresearch", "research-loop"]);

    const backend = new ExplicitManuscriptFinalizeBlockedBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const checks = JSON.parse(await readFile(completedRun.artifacts.manuscriptChecksPath, "utf8")) as {
      blockerCount: number;
      checks: Array<{ id: string; status: string; severity: string }>;
    };
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });

    assert.equal(exitCode, 0);
    assert.ok(checks.blockerCount > 0);
    assert.ok(checks.checks.some((check) => check.id === "workspace-claims" && check.status === "fail" && check.severity === "blocker"));
    assert.ok(checks.checks.some((check) => check.id === "workspace-sections" && check.status === "fail" && check.severity === "blocker"));
    await assert.rejects(readFile(completedRun.artifacts.paperPath, "utf8"), /ENOENT/);
    assert.equal(workStore.worker.completion, null);
    assert.ok(workStore.worker.nextInternalActions.some((action) => /not_ready tool result from manuscript\.finalize/i.test(action)));
    assert.ok(workStore.worker.nextInternalActions.some((action) => /release checks/i.test(action)));
    const releaseResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "manuscript.finalize");
    assert.equal(releaseResult?.status, "not_ready");
    assert.equal(releaseResult?.stateDelta?.manuscriptFinalized, 0);
    assert.ok(releaseResult?.related?.some((item) => item.kind === "releaseRepair" && item.fields?.suggestedActions !== undefined));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("test-08-shaped source collapse blocks finalization and keeps working", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-professional-contract-blocked-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "model-driven research workspaces",
      researchQuestion: "Can artifact contracts stop thin professional review exports?",
      researchDirection: "Use a seeded weak workspace to test finalization.",
      successCriterion: "Produce a professional literature review paper."
    };
    const run = await runStore.create(brief, ["clawresearch", "artifact-contract"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "professional_paper"
    });

    const backend = new FinalizeSeededWorkspaceBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const checks = JSON.parse(await readFile(completedRun.artifacts.manuscriptChecksPath, "utf8")) as {
      blockerCount: number;
    };
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const finalizeResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "manuscript.finalize");

    assert.equal(exitCode, 0);
    assert.equal(checks.blockerCount, 0);
    await assert.rejects(readFile(completedRun.artifacts.paperPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(completedRun.artifacts.paperJsonPath, "utf8"), /ENOENT/);
    assert.equal(workStore.worker.completion, null);
    assert.equal(finalizeResult?.status, "not_ready");
    assert.equal(finalizeResult?.stateDelta?.hardInvariantBlockers, 0);
    assert.ok((finalizeResult?.stateDelta?.artifactContractFailures ?? 0) > 0);
    assert.match(finalizeResult?.message ?? "", /not ready for professional_paper\/literature_review/i);
    assert.match(finalizeResult?.message ?? "", /continue/i);
    assert.ok(finalizeResult?.related?.some((item) => item.kind === "artifactContractDiagnostic" && /runtime-owned release-scope critic\.review pass/i.test(item.snippet ?? "")));
    assert.ok(finalizeResult?.related?.some((item) => item.kind === "artifactContractDiagnostic" && /Selected-to-rendered source disposition collapsed/i.test(item.snippet ?? "")));
    assert.ok(finalizeResult?.related?.some((item) => item.kind === "artifactContractDiagnostic" && /checkpoint brief/i.test(item.snippet ?? "")));
    const collapseDiagnostic = finalizeResult?.related?.find((item) => item.kind === "artifactContractDiagnostic" && /Selected-to-rendered source disposition collapsed/i.test(item.snippet ?? ""));
    assert.deepEqual(finalizeResult?.nextHints?.slice(0, 3), ["workspace.list", "claim.link_support", "section.patch"]);
    assert.ok(Array.isArray(collapseDiagnostic?.fields?.selectedToRenderedCollapseSourceIds));
    assert.ok((collapseDiagnostic?.fields?.selectedToRenderedCollapseSourceIds as string[]).length > 0);
    assert.ok((collapseDiagnostic?.fields?.suggestedActions as string[]).includes("claim.link_support"));
    assert.ok(workStore.worker.nextInternalActions.some((action) => /not_ready tool result from manuscript\.finalize/i.test(action)));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("professional_paper mission cannot be finalized as a research_brief downgrade", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-professional-no-brief-downgrade-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "model-driven research workspaces",
      researchQuestion: "Can the model downgrade the mission at finalization time?",
      researchDirection: "Use a seeded weak workspace to test requested artifact mismatch.",
      successCriterion: "Produce a professional literature review paper."
    };
    const run = await runStore.create(brief, ["clawresearch", "artifact-contract"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "professional_paper"
    });

    const backend = new FinalizeSeededWorkspaceBackend("research_brief");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const finalizeResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "manuscript.finalize");

    assert.equal(exitCode, 0);
    await assert.rejects(readFile(completedRun.artifacts.paperPath, "utf8"), /ENOENT/);
    assert.equal(workStore.worker.completion, null);
    assert.equal(finalizeResult?.status, "not_ready");
    assert.ok(finalizeResult?.related?.some((item) => item.kind === "artifactContractDiagnostic" && /downgrade/i.test(item.snippet ?? "")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("research_brief without a runtime release critic pass is not ready", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-brief-needs-release-critic-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "model-driven research workspaces",
      researchQuestion: "Does a brief need release critic authority?",
      researchDirection: "Use a mechanically linked seeded workspace.",
      successCriterion: "Return not_ready until critic.review release passes."
    };
    const run = await runStore.create(brief, ["clawresearch", "artifact-contract"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });

    const backend = new CriticAvailableFinalizeSeededWorkspaceBackend(null, "research_brief");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const finalizeResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "manuscript.finalize");

    assert.equal(exitCode, 0);
    await assert.rejects(readFile(completedRun.artifacts.paperPath, "utf8"), /ENOENT/);
    assert.equal(workStore.worker.completion, null);
    assert.equal(backend.criticRequests.length, 0);
    assert.equal(finalizeResult?.status, "not_ready");
    assert.ok(finalizeResult?.nextHints?.includes("critic.review"));
    assert.ok(finalizeResult?.related?.some((item) => item.kind === "artifactContractDiagnostic" && /No runtime-owned release-scope critic\.review pass/i.test(item.snippet ?? "")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("release.verify reports a fresh release critic review when reviewed objects are unchanged", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-critic-freshness-fresh-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "critic freshness",
      researchQuestion: "Can release verification recognize a fresh critic pass?",
      researchDirection: "Run critic.review and then release.verify without changing critic-relevant objects.",
      successCriterion: "release.verify reports freshness as fresh."
    };
    const run = await runStore.create(brief, ["clawresearch", "critic-freshness"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });

    const backend = new CriticFreshnessScenarioBackend("none");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const releaseResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "release.verify");
    const freshnessDiagnostic = releaseResult?.related
      ?.find((item) => item.kind === "criticFreshnessDiagnostic");
    const criticArtifact = JSON.parse(await readFile(run.artifacts.criticReleaseReviewPath, "utf8")) as CriticReviewArtifact;

    assert.equal(exitCode, 0);
    assert.equal(backend.criticRequests.length, 1);
    assert.ok(criticArtifact.reviewedSnapshot?.fingerprint);
    assert.equal(releaseResult?.status, "ok");
    assert.equal(freshnessDiagnostic?.status, "fresh");
    assert.equal(releaseResult?.stateDelta?.releaseCriticFreshnessProblems, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("release.verify reports stale critic review after manuscript section changes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-critic-freshness-section-stale-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "critic freshness",
      researchQuestion: "Can section edits stale a critic review?",
      researchDirection: "Run critic.review, patch a section, and verify release.",
      successCriterion: "release.verify reports a stale release critic."
    };
    const run = await runStore.create(brief, ["clawresearch", "critic-freshness"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });

    const backend = new CriticFreshnessScenarioBackend("section");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const releaseResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "release.verify");
    const freshnessDiagnostic = releaseResult?.related
      ?.find((item) => item.kind === "criticFreshnessDiagnostic");

    assert.equal(exitCode, 0);
    assert.equal(releaseResult?.status, "ok");
    assert.equal(freshnessDiagnostic?.status, "stale");
    assert.equal(releaseResult?.stateDelta?.mechanicalReleaseChecksPassed, 1);
    assert.equal(releaseResult?.stateDelta?.finalizationReady, 0);
    assert.ok((freshnessDiagnostic?.fields?.changedObjects as string[] | undefined)?.includes("manuscriptSection:section-thin-synthesis"));
    assert.ok(releaseResult?.nextHints?.includes("critic.review"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("release.verify reports incomplete critic review after new evidence is added", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-critic-freshness-new-evidence-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "critic freshness",
      researchQuestion: "Can new evidence make a critic review incomplete?",
      researchDirection: "Run critic.review, add evidence, and verify release.",
      successCriterion: "release.verify reports an incomplete release critic."
    };
    const run = await runStore.create(brief, ["clawresearch", "critic-freshness"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });

    const backend = new CriticFreshnessScenarioBackend("evidence");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const releaseResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "release.verify");
    const freshnessDiagnostic = releaseResult?.related
      ?.find((item) => item.kind === "criticFreshnessDiagnostic");

    assert.equal(exitCode, 0);
    assert.equal(releaseResult?.status, "ok");
    assert.equal(freshnessDiagnostic?.status, "incomplete");
    assert.equal(releaseResult?.stateDelta?.mechanicalReleaseChecksPassed, 1);
    assert.equal(releaseResult?.stateDelta?.finalizationReady, 0);
    assert.ok((freshnessDiagnostic?.fields?.newObjects as string[] | undefined)?.includes("evidenceCell:evidence-review-added-after-critic"));
    assert.ok(releaseResult?.nextHints?.includes("critic.review"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("manuscript.finalize blocks when support links changed after release critic review", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-critic-freshness-finalize-stale-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "critic freshness",
      researchQuestion: "Can finalization trust a critic pass after support links change?",
      researchDirection: "Run critic.review, retire support, and attempt finalization.",
      successCriterion: "manuscript.finalize returns not_ready."
    };
    const run = await runStore.create(brief, ["clawresearch", "critic-freshness"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });

    const backend = new CriticFreshnessScenarioBackend("support", "manuscript.finalize");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const finalizeResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "manuscript.finalize");
    const freshnessDiagnostic = finalizeResult?.related
      ?.find((item) => item.kind === "criticFreshnessDiagnostic");

    assert.equal(exitCode, 0);
    assert.equal(finalizeResult?.status, "not_ready");
    assert.equal(freshnessDiagnostic?.status, "stale");
    assert.ok((freshnessDiagnostic?.fields?.missingObjects as string[] | undefined)?.includes("citation:citation-review-1"));
    assert.equal(workStore.worker.completion, null);
    await assert.rejects(readFile(completedRun.artifacts.paperPath, "utf8"), /ENOENT/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("repeated critic.review returns new repeated and resolved objection diagnostics", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-critic-objection-diff-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "critic objection diff",
      researchQuestion: "Can repeated critic reviews report what changed?",
      researchDirection: "Run release critic twice against a seeded workspace.",
      successCriterion: "The second critic tool result reports new, repeated, and resolved objections."
    };
    const run = await runStore.create(brief, ["clawresearch", "critic-diff"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });

    const backend = new RepeatedCriticReviewDiffBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const criticResults = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .filter((result) => result.action === "critic.review");
    const secondCriticResult = criticResults.at(-1);

    assert.equal(exitCode, 0);
    assert.equal(backend.criticRequests.length, 2);
    assert.equal(secondCriticResult?.stateDelta?.criticNewObjections, 1);
    assert.equal(secondCriticResult?.stateDelta?.criticRepeatedObjections, 1);
    assert.equal(secondCriticResult?.stateDelta?.criticResolvedObjections, 1);
    assert.ok(secondCriticResult?.related?.some((item) => item.kind === "criticResolvedObjection" && /section-too-thin/i.test(String(item.fields?.code ?? ""))));
    assert.ok(secondCriticResult?.related?.some((item) => item.kind === "criticRepeatedObjection" && /missing-limitations/i.test(String(item.fields?.code ?? ""))));
    assert.ok(secondCriticResult?.nextHints?.includes("release.verify"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("section.read returns repair context with blocks, linked evidence, hygiene warnings, and critic objections", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-section-read-repair-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "section repair ergonomics",
      researchQuestion: "Can section.read orient the model for manuscript repair?",
      researchDirection: "Read a section after critic feedback.",
      successCriterion: "Section read returns repair context, not just a compact preview."
    };
    const run = await runStore.create(brief, ["clawresearch", "section-repair"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });
    const seededStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const seededSection = seededStore.objects.manuscriptSections[0];
    assert.ok(seededSection);
    const rawSection = {
      ...seededSection,
      markdown: "TODO create benchmark detail from source-review-1.\n\nThis second paragraph should remain visible as block two.",
      updatedAt: now()
    } as WorkStoreEntity;
    await writeResearchWorkStore(upsertResearchWorkStoreEntities(seededStore, [rawSection], now()));

    const backend = new SectionRepairErgonomicsBackend("read");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const sectionReadResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "section.read");

    assert.equal(exitCode, 0);
    assert.equal(backend.criticRequests.length, 1);
    assert.equal(sectionReadResult?.status, "ok");
    assert.match(sectionReadResult?.entity?.text ?? "", /TODO create benchmark detail/);
    assert.equal(sectionReadResult?.items?.filter((item) => item.kind === "manuscriptSectionBlock").length, 2);
    assert.ok(sectionReadResult?.related?.some((item) => item.kind === "manuscriptHygieneWarning" && /raw workspace ids/i.test(item.snippet ?? "")));
    assert.ok(sectionReadResult?.related?.some((item) => item.kind === "criticObjection" && item.sectionIds?.includes("section-thin-synthesis")));
    assert.ok(sectionReadResult?.related?.some((item) => item.kind === "claim" && item.id === "claim-review-1"));
    assert.ok(sectionReadResult?.related?.some((item) => item.kind === "evidenceCell" && item.id === "evidence-review-1"));
    assert.ok(sectionReadResult?.related?.some((item) => item.kind === "citation" && item.id === "citation-review-1"));
    assert.ok(sectionReadResult?.related?.some((item) => item.kind === "canonicalSource" && item.id === "source-review-1"));
    assert.ok(sectionReadResult?.nextHints?.includes("section.patch"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("section.patch supports targeted block replacement without rewriting the whole section", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-section-patch-block-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "section repair ergonomics",
      researchQuestion: "Can section.patch replace one manuscript block?",
      researchDirection: "Patch a targeted section block.",
      successCriterion: "Only the requested block changes and section links survive."
    };
    const run = await runStore.create(brief, ["clawresearch", "section-repair"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });
    const seededStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const seededSection = seededStore.objects.manuscriptSections[0];
    assert.ok(seededSection);
    const twoBlockSection = {
      ...seededSection,
      markdown: "TODO create benchmark detail from source-review-1.\n\nThis second paragraph should remain unchanged.",
      updatedAt: now()
    } as WorkStoreEntity;
    await writeResearchWorkStore(upsertResearchWorkStoreEntities(seededStore, [twoBlockSection], now()));

    const backend = new SectionRepairErgonomicsBackend("replace_block");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const updatedSection = workStore.objects.manuscriptSections.find((section) => section.id === "section-thin-synthesis");
    const patchResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "section.patch");

    assert.equal(exitCode, 0);
    assert.ok(updatedSection);
    assert.match(updatedSection.markdown, /repaired synthesis paragraph/i);
    assert.match(updatedSection.markdown, /This second paragraph should remain unchanged/);
    assert.doesNotMatch(updatedSection.markdown, /source-review-1/);
    assert.deepEqual(updatedSection.claimIds, ["claim-review-1"]);
    assert.equal(patchResult?.status, "ok");
    assert.equal(patchResult?.items?.filter((item) => item.kind === "manuscriptSectionBlock").length, 2);
    assert.ok(patchResult?.related?.some((item) => item.kind === "claim" && item.id === "claim-review-1"));
    assert.equal(patchResult?.stateDelta?.sectionsPatched, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("fake critic notebook link does not satisfy finalization authority", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-fake-critic-link-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "model-driven research workspaces",
      researchQuestion: "Can notebook.patch fake critic authority?",
      researchDirection: "Patch a critic-looking artifact link without invoking critic.review.",
      successCriterion: "Finalization remains blocked."
    };
    const run = await runStore.create(brief, ["clawresearch", "artifact-contract"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });

    const backend = new FakeCriticNotebookLinkFinalizeBackend(run.artifacts.criticReleaseReviewPath);
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const fakeLink = workStore.notebook.artifactLinks.find((artifact) => (
      artifact.label === "Critic review: release (pass)"
      && artifact.path === completedRun.artifacts.criticReleaseReviewPath
    ));
    const finalizeResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "manuscript.finalize");

    assert.equal(exitCode, 0);
    assert.ok(fakeLink, "the model-authored fake critic link should be present as notebook context");
    assert.equal(fakeLink?.createdBy, undefined);
    assert.equal(backend.criticRequests.length, 0);
    await assert.rejects(readFile(completedRun.artifacts.paperPath, "utf8"), /ENOENT/);
    assert.equal(workStore.worker.completion, null);
    assert.equal(finalizeResult?.status, "not_ready");
    assert.ok(finalizeResult?.nextHints?.includes("critic.review"));
    assert.ok(finalizeResult?.related?.some((item) => item.kind === "artifactContractDiagnostic" && /Model-authored notebook artifact links/i.test(item.snippet ?? "")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("research_brief mission can finalize after a runtime release critic pass", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-brief-contract-finalizes-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "model-driven research workspaces",
      researchQuestion: "Can a lightweight linked workspace finalize as a brief?",
      researchDirection: "Use a seeded workspace to test research_brief finalization.",
      successCriterion: "Produce a research brief."
    };
    const run = await runStore.create(brief, ["clawresearch", "artifact-contract"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 1,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });

    const backend = new CriticThenFinalizeSeededWorkspaceBackend("research_brief");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const paperMarkdown = await readFile(completedRun.artifacts.paperPath, "utf8");
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });

    assert.equal(exitCode, 0);
    assert.equal(backend.criticRequests.length, 1);
    assert.match(paperMarkdown, /Thin Synthesis/);
    assert.match(paperMarkdown, /## References/);
    assert.equal(workStore.worker.completion?.kind, "manuscript_finalized");
    assert.ok(workStore.notebook.artifactLinks.some((artifact) => artifact.path === completedRun.artifacts.criticReleaseReviewPath && artifact.createdBy === "runtime"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("critic review packet uses exact selected and cited sources, not every screened include", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-critic-exact-selection-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const brief = {
      topic: "critic source packets",
      researchQuestion: "Does critic review receive the model-selected evidence set?",
      researchDirection: "Only exact selected and cited sources should be sent as selected sources.",
      successCriterion: "Broad screened includes are not mislabeled as selected."
    };
    const run = await runStore.create(brief, ["clawresearch", "critic-source-packet"]);
    await seedThinReviewWorkspace({
      projectRoot,
      runId: run.id,
      brief,
      now,
      missionTarget: "research_brief",
      sourceCount: 5,
      extractedCount: 1,
      evidenceCount: 1,
      citedCount: 1
    });
    const seededStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    await writeResearchWorkStore({
      ...seededStore,
      worker: {
        ...seededStore.worker,
        evidence: {
          ...(seededStore.worker.evidence ?? {
            canonicalPapers: 5,
            includedPapers: 5,
            extractedPapers: 1,
            evidenceRows: 1,
            referencedPapers: 1
          }),
          selectedSourceIds: ["source-review-2"],
          explicitlySelectedEvidencePapers: 1,
          selectedPapers: 1
        }
      }
    });

    const backend = new CriticThenFinalizeSeededWorkspaceBackend("research_brief");
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });
    const criticSelectedIds = backend.criticRequests[0]?.workspace?.selectedSources
      .map((source) => String(source.id))
      .sort();

    assert.equal(exitCode, 0);
    assert.equal(backend.criticRequests.length, 1);
    assert.equal(backend.criticRequests[0]?.paper, null);
    assert.equal(backend.criticRequests[0]?.draftManuscriptPreview?.sections.length, 1);
    assert.equal(backend.criticRequests[0]?.paperExportExists, false);
    assert.deepEqual(backend.criticRequests[0]?.finalizedArtifactPaths, []);
    assert.equal(backend.criticRequests[0]?.releaseChecksExist, false);
    assert.equal(backend.criticRequests[0]?.manuscriptFinalized, false);
    assert.deepEqual(criticSelectedIds, ["source-review-1", "source-review-2"]);
    assert.equal(criticSelectedIds?.includes("source-review-3"), false);
    assert.equal(criticSelectedIds?.includes("source-review-4"), false);
    assert.equal(criticSelectedIds?.includes("source-review-5"), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("section.link_claim resolves natural and swapped section/claim ids", async () => {
  for (const mode of ["payloadIds", "swappedLinkIds"] as const) {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), `clawresearch-section-link-${mode}-`));
    const now = createNow();

    try {
      const runStore = new RunStore(projectRoot, "0.7.0", now);
      const run = await runStore.create({
        topic: "research lab tools",
        researchQuestion: "Can section links be repaired from model-facing ids?",
        researchDirection: "The model should be able to link an existing section to an existing claim.",
        successCriterion: "section.link_claim creates durable section and claim linkage."
      }, ["clawresearch", "research-loop"]);

      const backend = new SectionLinkClaimBackend(mode);
      const exitCode = await runDetachedJobWorker({
        projectRoot,
        runId: run.id,
        version: "0.7.0",
        now,
        researchBackend: backend
      });

      const workStore = await loadResearchWorkStore({
        projectRoot,
        now: now()
      });
      const section = workStore.objects.manuscriptSections[0];
      const claim = workStore.objects.claims[0];
      const linkResult = backend.researchRequests
        .flatMap((request) => request.toolResults ?? [])
        .find((result) => result.action === "section.link_claim");

      assert.equal(exitCode, 0);
      assert.ok(section);
      assert.ok(claim);
      assert.deepEqual(section.claimIds, [claim.id]);
      assert.deepEqual(claim.usedInSections, [section.id]);
      assert.equal(linkResult?.status, "ok");
      assert.equal(linkResult?.query?.sectionId, section.id);
      assert.equal(linkResult?.query?.claimId, claim.id);
      assert.ok(linkResult?.related?.some((item) => item.kind === "claim" && item.id === claim.id));
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
});

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
        summaryPath: path.join(runDirectoryPath(projectRoot, runId), "summary.md")
      }
    }, null, 2)}\n`, "utf8");

    const loaded = await new RunStore(projectRoot, "0.7.0", createNow()).load(runId);

    assert.match(loaded.artifacts.reviewProtocolPath, /review-protocol\.json$/);
    assert.match(loaded.artifacts.paperPath, /paper\.md$/);
    assert.match(loaded.artifacts.paperJsonPath, /paper\.json$/);
    assert.match(loaded.artifacts.referencesPath, /references\.json$/);
    assert.match(loaded.artifacts.manuscriptChecksPath, /manuscript-checks\.json$/);
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

    const backend = new SourceToolBackend();
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
      sourceToolState?: {
        canonicalMergeCompleted?: boolean;
        recentActions?: Array<{ action: string }>;
      } | null;
    };
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const workerState = await loadResearchWorkerState(projectRoot);

    assert.equal(exitCode, 0);
    assert.equal(sourcesArtifact.retrievalDiagnostics?.providerAttempts?.[0]?.providerId, "arxiv");
    assert.ok((sourcesArtifact.reviewWorkflow?.counts?.selectedForSynthesis ?? 0) > 0);
    assert.equal(sourcesArtifact.sourceToolState?.canonicalMergeCompleted, true);
    assert.ok(sourcesArtifact.sourceToolState?.recentActions?.some((action) => action.action === "source.select_evidence"));
    assert.deepEqual(backend.sourceActions.map((action) => action.action).slice(0, 4), [
      "source.search",
      "source.merge",
      "source.resolve_access",
      "source.select_evidence"
    ]);
    assert.ok(backend.sourceActions[0]?.inputs.providerIds.includes("arxiv"));
    assert.ok(backend.sourceActionRequests.every((request) => request.allowedActions.includes("workspace.search")));
    assert.ok(backend.sourceActionRequests.every((request) => request.allowedActions.includes("section.create")));
    for (const [index, request] of backend.sourceActionRequests.entries()) {
      assert.equal(request.observations.sessionStepsUsed, index);
    }
    const postSearchRequest = backend.sourceActionRequests.find((request) => (
      request.sourceState?.attemptedProviderIds.includes("arxiv") === true
      && request.toolResults?.some((result) => result.action === "source.search") === true
    ));
    assert.ok(postSearchRequest);
    assert.ok(postSearchRequest.observations.sourceCandidates > 0);
    assert.match(postSearchRequest.workStore?.dashboard?.lookupReminder ?? "", /workspace\.list/);
    assert.ok((postSearchRequest.workStore?.dashboard?.sourceAccess.sourceCandidates ?? 0) > 0);
    assert.equal("recentExtractions" in (postSearchRequest.workStore?.dashboard ?? {}), false);
    const sourceSearchResult = postSearchRequest.toolResults?.find((result) => result.action === "source.search");
    assert.equal(sourceSearchResult?.collection, "sources");
    assert.ok((sourceSearchResult?.count ?? 0) > 0);
    assert.ok(sourceSearchResult?.items?.some((item) => (
      item.kind === "source"
      && /Autonomous research agent harnesses/i.test(item.title ?? "")
      && /architecture/i.test(item.snippet ?? "")
      && item.fields?.providerId === "arxiv"
    )));
    const postMergeRequest = backend.sourceActionRequests.find((request) => request.sourceState?.canonicalMergeCompleted === true);
    assert.ok(postMergeRequest);
    assert.ok(postMergeRequest.observations.canonicalSources > 0);
    assert.ok(postMergeRequest.observations.screenedInSources > 0);
    assert.equal(postMergeRequest.observations.explicitlySelectedEvidenceSources, 0);
    const postSelectionRequest = backend.sourceActionRequests.find((request) => (request.sourceState?.selectedPapers ?? 0) > 0);
    assert.ok(postSelectionRequest);
    assert.equal(postSelectionRequest.observations.explicitlySelectedEvidenceSources, postSelectionRequest.sourceState?.selectedPapers);
    assert.equal(postSelectionRequest.observations.selectedPapers, postSelectionRequest.observations.explicitlySelectedEvidenceSources);
    assert.ok(postSelectionRequest.observations.screenedInSources >= postSelectionRequest.observations.explicitlySelectedEvidenceSources);
    assert.ok((workerState?.evidence?.includedPapers ?? 0) >= (workerState?.evidence?.explicitlySelectedEvidencePapers ?? 0));
    assert.equal(workerState?.evidence?.selectedPapers, workerState?.evidence?.explicitlySelectedEvidencePapers);
    assert.match(stdout, /Research agent action \(research\): source\.search/);
    assert.match(stdout, /Research agent action \(research\): source\.merge/);
    assert.match(stdout, /Research agent action \(research\): source\.resolve_access/);
    assert.match(stdout, /Research agent action \(research\): source\.select_evidence/);
    assert.match(stdout, /Source tool observation: arxiv returned/i);
    assert.match(stdout, /Model-driven research session active/i);
    assert.doesNotMatch(stdout, /Source tool execution completed with/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source tool runtime does not substitute fallback evidence for unknown researcher-selected ids", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-no-fallback-evidence-"));
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
      researchQuestion: "Can the runtime avoid fallback evidence selection?",
      researchDirection: "The model must explicitly select known source ids.",
      successCriterion: "Unknown selected ids should not be replaced by runtime-selected evidence."
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

    const backend = new UnknownEvidenceSelectionBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const sourcesArtifact = JSON.parse(await readFile(completedRun.artifacts.sourcesPath, "utf8")) as {
      reviewWorkflow?: {
        counts?: {
          selectedForSynthesis?: number;
        };
        notes?: string[];
      };
      sourceToolState?: {
        selectedPapers?: number;
      } | null;
    };
    const stdout = await readFile(completedRun.artifacts.stdoutPath, "utf8");
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.equal(sourcesArtifact.reviewWorkflow?.counts?.selectedForSynthesis, 0);
    assert.equal(sourcesArtifact.sourceToolState?.selectedPapers, 0);
    assert.equal(workStore.objects.extractions.length, 0);
    assert.equal(workStore.objects.evidenceCells.length, 0);
    assert.match(stdout, /unknown requested paper id/i);
    assert.match(stdout, /No evidence selection state was changed/i);
    const selectionResult = backend.sourceActionRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "source.select_evidence");
    assert.equal(selectionResult?.status, "blocked");
    assert.match(selectionResult?.message ?? "", /unknown requested paper id/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker executes work-store tool operations inside the model-driven research session", async () => {
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
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.deepEqual(backend.sourceActions.map((action) => action.action).slice(0, 2), [
      "workspace.create",
      "source.search"
    ]);
    assert.ok(backend.sourceActionRequests.every((request) => request.allowedActions.includes("workspace.patch")));
    assert.ok(backend.sourceActionRequests.some((request) => (
      request.workStore?.summary.sources === 2
      && request.workStore.summary.providerRuns === 1
      && request.workStore.recentSourceCandidates.some((source) => /Autonomous research agent harnesses/i.test(source.title))
    )));
    assert.ok(backend.sourceActionRequests.some((request) => (
      (request.workStore?.summary.canonicalSources ?? 0) > 0
      && (request.workStore?.recentSources.some((source) => /Autonomous research agent harnesses/i.test(source.title)) ?? false)
    )));
    assert.match(stdout, /Research tool observation: Workspace created work item/);
    assert.ok(workStore.objects.workItems.some((item) => item.title === "Inspect full-text-accessible autonomous research agent sources" && item.source === "runtime"));
    assert.equal(workStore.objects.providerRuns.length, 1);
    assert.ok(workStore.objects.sources.some((source) => /Autonomous research agent harnesses/i.test(source.title)));
    assert.ok(workStore.objects.canonicalSources.some((source) => /Autonomous research agent harnesses/i.test(source.title)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source tool runtime does not choose a fallback provider for providerless searches", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-no-source-provider-fallback-"));
  const now = createNow();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    globalThis.fetch = async (): Promise<Response> => {
      fetchCalls += 1;
      throw new Error("No source provider should be queried without explicit provider ids.");
    };

    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agent harnesses",
      researchQuestion: "How should source tools handle missing provider choices?",
      researchDirection: "Validate source-tool autonomy boundaries.",
      successCriterion: "Do not let the runtime choose semantic/provider strategy for the model."
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

    const backend = new ProviderlessSourceSearchBackend();
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
      sourceToolState?: {
        attemptedProviderIds?: string[];
        canonicalMergeCompleted?: boolean;
      } | null;
      reviewWorkflow?: {
        counts?: {
          selectedForSynthesis?: number;
        };
      };
    };

    assert.equal(exitCode, 0);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(backend.sourceActions.map((action) => action.action), [
      "source.search",
      "workspace.status"
    ]);
    assert.match(stdout, /no fallback provider was selected/i);
    assert.equal(sourcesArtifact.sourceToolState?.canonicalMergeCompleted, false);
    assert.deepEqual(sourcesArtifact.sourceToolState?.attemptedProviderIds, []);
    assert.equal(sourcesArtifact.reviewWorkflow?.counts?.selectedForSynthesis, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source tool dashboard exposes repeated search facts without interpreting them", async () => {
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
      sourceToolState?: {
        canonicalMergeCompleted?: boolean;
        consecutiveNoProgressSearches?: number;
        repeatedSearchFacts?: Array<{
          providerId: string;
          attempts: number;
          lastRawCandidates: number;
          lastNewSources: number;
        }>;
        recentActions?: Array<{ action: string; newSources: number }>;
      } | null;
    };

    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
    assert.ok(backend.sourceActions.some((action) => action.action === "source.search"));
    assert.ok(backend.sourceActions.some((action) => action.action === "source.merge"));
    assert.ok(backend.sourceActionRequests.some((request) => (
      (request.sourceState?.candidatePaperIds.length ?? 0) > 0
      && request.allowedActions.includes("source.merge")
    )));
    assert.ok(backend.sourceActionRequests.some((request) => (request.sourceState?.repeatedSearchFacts.length ?? 0) > 0));
    assert.equal(sourcesArtifact.sourceToolState?.canonicalMergeCompleted, true);
    assert.ok((sourcesArtifact.sourceToolState?.repeatedSearchFacts?.[0]?.attempts ?? 0) >= 2);
    assert.ok(sourcesArtifact.sourceToolState?.recentActions?.some((action) => action.action === "source.select_evidence"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source tool dashboard does not fabricate evidence when the model ignores repeated search facts", async () => {
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
      sourceToolState?: {
        canonicalMergeCompleted?: boolean;
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
    assert.ok(backend.sourceActions.filter((action) => action.action === "source.search").length >= 3);
    assert.ok(backend.sourceActionRequests.some((request) => (request.sourceState?.repeatedSearchFacts.length ?? 0) > 0));
    assert.doesNotMatch(stdout, /Source tool observation: Merged 1 screened scholarly sources into 1 canonical papers/i);
    assert.match(stdout, /Research work store checkpointed: 0 canonical sources, \d+ source candidates, 0 open work items/i);
    assert.equal(sourcesArtifact.sourceToolState?.canonicalMergeCompleted, false);
    assert.equal(sourcesArtifact.reviewWorkflow?.counts?.selectedForSynthesis, 0);
    assert.equal(sourcesArtifact.sourceToolState?.recentActions?.some((action) => action.action === "source.select_evidence"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("protocol.create_or_revise persists a researcher-owned protocol object", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-run-worker-protocol-tool-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "Autonomous research agents",
      researchQuestion: "How should autonomous research work be structured?",
      researchDirection: "Test model-owned protocol persistence.",
      successCriterion: "The protocol must be queryable as workspace state and the paper should be complete, publication-style, traceable, and citation-backed."
    }, ["clawresearch", "research-loop"]);

    const backend = new ProtocolToolBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceToolAdapter: new MultiPaperSourceToolAdapter(3)
    });

    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });
    const reviewProtocol = JSON.parse(await readFile((await runStore.load(run.id)).artifacts.reviewProtocolPath, "utf8")) as {
      evidenceTargets: string[];
      manuscriptConstraints: string[];
      protocolLimitations: string[];
    };

    assert.equal(exitCode, 0);
    assert.equal(workStore.objects.protocols.length, 1);
    assert.equal(workStore.objects.protocols[0]?.author, "researcher");
    assert.equal(workStore.objects.protocols[0]?.title, "Agentic research protocol");
    assert.deepEqual(workStore.objects.protocols[0]?.evidenceTargets, ["agentic tool-loop evidence"]);
    assert.deepEqual(reviewProtocol.evidenceTargets, ["agentic tool-loop evidence"]);
    assert.equal("requiredSuccessCriterionFacets" in reviewProtocol, false);
    assert.doesNotMatch(reviewProtocol.evidenceTargets.join(" "), /complete|publication-style|traceable|citation-backed/i);
    assert.match(reviewProtocol.protocolLimitations.join(" "), /Canonical protocol authored by researcher/i);
    const protocolAction = backend.actionRequests.find((request) => request.phase === "research");
    assert.ok(protocolAction);
    assert.ok(protocolAction.allowedActions.includes("workspace.search"));
    assert.ok(protocolAction.allowedActions.includes("source.search"));
    assert.ok(!workStore.objects.workItems.some((item) => item.targetKind === "protocol" && item.source === "runtime"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("run worker uses prior literature context to inform planning and retrieval", async () => {
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
        source: "runtime"
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
      sourceToolAdapter: new LiteratureAwareSourceToolAdapter()
    });

    const completedRun = await runStore.load(run.id);
    assert.equal(exitCode, 0);
    assert.equal(completedRun.status, "completed");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("generic critic fallback text is recorded without becoming retrieval query text", async () => {
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

    const gatherer = new EvidenceRecoverySourceToolAdapter();
    const backend = new StubResearchBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend,
      sourceToolAdapter: gatherer
    });

    const revisionQueries = gatherer.requests.flatMap((request) => request.revisionQueries ?? []);
    const joinedQueries = revisionQueries.join(" | ");

    assert.equal(exitCode, 0);
    assert.equal(gatherer.requests.length, 0);
    assert.equal(joinedQueries, "");
    assert.doesNotMatch(joinedQueries, /prior research stage|focused evidence|before release|full manuscript|working critic backend/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
