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
  ResearchSourceToolRequest,
  ResearchSourceSnapshot,
  ResearchSourceToolAdapter
} from "../src/runtime/research-sources.js";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
import { researchDirectionPath, runDirectoryPath, runFilePath, RunStore } from "../src/runtime/run-store.js";
import { runDetachedJobWorker } from "../src/runtime/run-worker.js";
import { loadResearchWorkerState, researchWorkerStatePath } from "../src/runtime/research-state.js";
import {
  createResearchWorkStore,
  loadResearchWorkStore,
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
        reason: "Test backend checkpoint."
      },
      expectedOutcome: "Checkpoint durable workspace state.",
      stopCondition: "Stop this worker segment.",
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
      action: "manuscript.release",
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
      action: "manuscript.release",
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
      action: "manuscript.release",
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
            paperIds: sourceState.candidatePaperIds
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
            reason: "Source tool smoke run complete."
          },
          expectedOutcome: "Checkpoint current model-driven research state.",
          stopCondition: "Stop this worker segment.",
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
          reason: "Unknown evidence selection test complete."
        },
        expectedOutcome: "Checkpoint without fallback evidence.",
        stopCondition: "Stop this worker segment.",
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
          reason: null
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
          reason: "Source dashboard test complete."
        },
        expectedOutcome: "Checkpoint current model-driven research state.",
        stopCondition: "Stop this worker segment.",
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
          paperIds: sourceState.candidatePaperIds
        },
        expectedOutcome: "Selected evidence set.",
        stopCondition: "Stop after selection.",
        transport: "strict_json"
      };
    } else if ((sourceState?.repeatedSearchWarnings.length ?? 0) > 0 || (sourceState?.consecutiveNoProgressSearches ?? 0) >= 2) {
      action = {
        schemaVersion: 1,
        action: "source.merge",
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
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
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
          reason: "Providerless source search test complete."
        },
        expectedOutcome: "Checkpoint without fallback provider execution.",
        stopCondition: "Stop this worker segment.",
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
    if (request.phase === "research" && (request.workStore?.recentSections.length ?? 0) > 0) {
      return {
        schemaVersion: 1,
        action: "workspace.status",
        rationale: "Checkpoint after prior literature memory has been used to create durable claim and section state.",
        confidence: 0.86,
        inputs: {
          providerIds: [],
          searchQueries: [],
          evidenceTargets: [],
          paperIds: [],
          criticScope: null,
          reason: "Literature-aware model-driven session checkpoint."
        },
        expectedOutcome: "Checkpoint current workspace state.",
        stopCondition: "Stop this worker segment.",
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

class ArchitectureForbiddenWorkflowBackend extends StubResearchBackend {
  extractionCalls = 0;
  agendaCalls = 0;
  readonly criticScopes: string[] = [];
}

class EndlessReadOnlySourceBackend extends StubResearchBackend {
  readonly sourceActions: ResearchActionDecision[] = [];

  override async chooseResearchAction(request: ResearchActionRequest): Promise<ResearchActionDecision> {
    if (request.phase !== "research") {
      return super.chooseResearchAction(request);
    }

    const action: ResearchActionDecision = {
      schemaVersion: 1,
      action: "workspace.search",
      rationale: "Inspect workspace state without choosing a terminal source, extraction, evidence, or release action.",
      confidence: 0.8,
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
          semanticQuery: "open source work",
          limit: 5,
          cursor: null,
          changes: {},
          entity: {}
        }
      },
      expectedOutcome: "Return visible workspace observations.",
      stopCondition: "Checkpoint when the segment budget is exhausted.",
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

class ExplicitResearchToolBackend extends StubResearchBackend {
  readonly sourceActions: ResearchActionDecision[] = [];
  readonly researchRequests: ResearchActionRequest[] = [];
  private extractionId: string | null = null;
  private evidenceCellId: string | null = null;
  private matrixViewed = false;
  private criticReviewed = false;
  private releaseVerified = false;
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
    } else if (!this.criticReviewed) {
      this.criticReviewed = true;
      action = {
        schemaVersion: 1,
        action: "critic.review",
        rationale: "Ask the explicit critic tool to create visible research-debt work items.",
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
            entity: {
              stage: "release",
              readiness: "revise",
              confidence: 0.76,
              objections: [{
                code: "critic-tighten-limitations",
                severity: "minor",
                target: "manuscript",
                message: "The limitations paragraph should clearly state that this is a single-source smoke scenario.",
                affectedClaimIds: [claim.id],
                suggestedRevision: "Keep the limitation visible in the final export."
              }],
              revisionAdvice: {
                searchQueries: [],
                evidenceTargets: [],
                papersToExclude: [],
                papersToPromote: [],
                claimsToSoften: []
              }
            }
          }
        },
        expectedOutcome: "Critic output becomes work items only.",
        stopCondition: "Visible critic work item exists.",
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
        action: "manuscript.release",
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
          reason: "Explicit tool smoke run complete."
        },
        expectedOutcome: "Checkpoint current workspace state.",
        stopCondition: "Stop after checkpoint.",
        transport: "strict_json"
      };
    }

    this.sourceActions.push(action);
    return action;
  }
}

class ExplicitManuscriptReleaseBlockedBackend extends StubResearchBackend {
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
        action: "manuscript.release",
        rationale: "Try to release before claims, sections, support links, and references exist.",
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
        reason: "Blocked release was reported."
      },
      expectedOutcome: "Checkpoint.",
      stopCondition: "Stop.",
      transport: "strict_json"
    };
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

test("architecture contract: agenda generation is not a mandatory post-manuscript step", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-no-hidden-agenda-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can next work be represented by explicit work items?",
      researchDirection: "The model should create agenda/work items when it wants them.",
      successCriterion: "Agenda generation must not be hidden runtime synthesis."
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

    const agendaArtifact = JSON.parse(await readFile((await runStore.load(run.id)).artifacts.agendaPath, "utf8")) as {
      status?: string;
      candidateDirections?: unknown[];
    };

    assert.equal(backend.agendaCalls, 0);
    assert.equal(agendaArtifact.status, "pending");
    assert.equal(agendaArtifact.candidateDirections, undefined);
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

    assert.deepEqual(backend.criticScopes, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("architecture contract: budget exhaustion checkpoints the worker instead of completing research", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-budget-checkpoint-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can segment budget exhaustion preserve ongoing work?",
      researchDirection: "Repeated observation actions should end in a checkpoint, not completion.",
      successCriterion: "The next /go can resume the same objective."
    }, ["clawresearch", "research-loop"]);

    await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: new EndlessReadOnlySourceBackend()
    });

    const completedRun = await runStore.load(run.id);
    const workStore = await loadResearchWorkStore({
      projectRoot,
      now: now()
    });

    assert.notEqual(completedRun.status, "completed");
    assert.equal(workStore.worker.status, "checkpointed_budget_exhausted");
    assert.match(workStore.worker.statusReason, /budget|checkpoint/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("architecture contract: release_ready requires explicit release verification and manuscript release", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-architecture-release-invariants-"));
  const now = createNow();

  try {
    const runStore = new RunStore(projectRoot, "0.7.0", now);
    const run = await runStore.create({
      topic: "autonomous research agents",
      researchQuestion: "Can release state be validated explicitly?",
      researchDirection: "A draft or checked section must not imply released research.",
      successCriterion: "release_ready requires explicit release.verify and manuscript.release."
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

    assert.doesNotMatch(agentSteps, /"action":"release\.verify"|"action":"manuscript\.release"/);
    assert.notEqual(workStore.worker.status, "release_ready");
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
    assert.equal(workStore.worker.userBlockers.length, 0);
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

test("explicit researcher tools create extraction, evidence, critic work items, release checks, and manuscript exports only when selected", async () => {
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
      "critic.review",
      "release.verify",
      "manuscript.release"
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
    assert.equal(workStore.objects.extractions.length, 1);
    assert.equal(workStore.objects.extractions[0]?.sourceId, sourceId);
    assert.equal(workStore.objects.evidenceCells.length, 1);
    assert.equal(workStore.objects.evidenceCells[0]?.sourceId, sourceId);
    assert.equal(workStore.objects.citations.length, 1);
    assert.equal(workStore.objects.citations[0]?.sourceId, sourceId);
    assert.equal(workStore.objects.workItems.filter((item) => item.source === "critic").length, 1);
    assert.ok(workStore.objects.releaseChecks.length > 0);
    assert.equal(references.referenceCount, 1);
    assert.equal(references.references[0]?.sourceId, sourceId);
    assert.equal(paper.readinessStatus, "ready_for_revision");
    assert.deepEqual(paper.referencedPaperIds, [sourceId]);
    assert.equal(criticReview.readiness, "revise");
    assert.match(paperMarkdown, /Tool-Loop Architecture/);
    assert.match(paperMarkdown, /Agentic research tool runtimes for scientific synthesis/);
    assert.match(stdout, /Research tool observation: Extraction created/);
    assert.match(stdout, /Research tool observation: Evidence matrix view returned 1 row/);
    assert.match(stdout, /Research tool observation: Manuscript released from workspace state/);
    assert.match(agentSteps, /"action":"manuscript\.release_result"/);
    assert.match(agentSteps, /"toolAction":"manuscript\.release"/);
    assert.match(agentSteps, /"manuscriptExportsCreated":1/);
    assert.equal(workStore.worker.status, "release_ready");
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
            reason: "Matrix view read-only test complete."
          },
          expectedOutcome: "Checkpoint.",
          stopCondition: "Stop.",
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

test("explicit manuscript.release fails visibly when release invariants are missing", async () => {
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

    const backend = new ExplicitManuscriptReleaseBlockedBackend();
    const exitCode = await runDetachedJobWorker({
      projectRoot,
      runId: run.id,
      version: "0.7.0",
      now,
      researchBackend: backend
    });

    const completedRun = await runStore.load(run.id);
    const paperMarkdown = await readFile(completedRun.artifacts.paperPath, "utf8");
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
    assert.match(paperMarkdown, /Manuscript release was explicitly requested/);
    assert.match(paperMarkdown, /No claims have been created/);
    assert.notEqual(workStore.worker.status, "release_ready");
    assert.ok(workStore.worker.nextInternalActions.some((action) => /not_ready tool result from manuscript\.release/i.test(action)));
    assert.ok(workStore.worker.nextInternalActions.some((action) => /release checks/i.test(action)));
    const releaseResult = backend.researchRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "manuscript.release");
    assert.equal(releaseResult?.status, "not_ready");
    assert.equal(releaseResult?.stateDelta?.manuscriptExportsCreated, 0);
    assert.ok(releaseResult?.related?.some((item) => item.kind === "releaseRepair" && item.fields?.suggestedActions !== undefined));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
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
      assert.equal(request.observations.sessionStepsRemaining, 24 - index);
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
    assert.match((sourcesArtifact.reviewWorkflow?.notes ?? []).join(" "), /no fallback semantic selection/i);
    assert.match((sourcesArtifact.reviewWorkflow?.notes ?? []).join(" "), /paper-does-not-exist/i);
    assert.match(stdout, /no fallback evidence selection was substituted/i);
    const selectionResult = backend.sourceActionRequests
      .flatMap((request) => request.toolResults ?? [])
      .find((result) => result.action === "source.select_evidence");
    assert.equal(selectionResult?.status, "noop");
    assert.match(selectionResult?.message ?? "", /unknown id/i);
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

test("source tool dashboard asks the model to reconsider repeated low-yield searches", async () => {
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
        repeatedSearchWarnings?: string[];
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
    assert.equal(sourcesArtifact.sourceToolState?.canonicalMergeCompleted, true);
    assert.ok(sourcesArtifact.sourceToolState?.recentActions?.some((action) => action.action === "source.select_evidence"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("source tool dashboard does not fabricate evidence when the model ignores exhausted-search guidance", async () => {
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
    assert.equal(completedRun.status, "paused");
    assert.ok(backend.sourceActions.every((action) => action.action === "source.search"));
    assert.match(stdout, /Source dashboard:/);
    assert.match(stdout, /without automatic merge or selection/i);
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
