import { type ResearchBrief } from "./session-store.js";
import {
  createResearchWorkStore,
  loadResearchWorkStore,
  researchWorkStoreFilePath,
  updateResearchWorkStoreWorker,
  writeResearchWorkStore,
  type ResearchWorkerStatus
} from "./research-work-store.js";

export type { ResearchWorkerStatus } from "./research-work-store.js";

export type ResearchWorkerEvidenceSnapshot = {
  canonicalPapers: number;
  selectedPapers: number;
  extractedPapers: number;
  evidenceRows: number;
  referencedPapers: number;
};

export type ResearchWorkerCriticSnapshot = {
  finalSatisfaction: string | null;
  unresolvedStages: string[];
  objections: string[];
};

export type ResearchWorkerState = {
  schemaVersion: 1;
  projectRoot: string;
  brief: ResearchBrief;
  status: ResearchWorkerStatus;
  activeRunId: string | null;
  lastRunId: string | null;
  segmentCount: number;
  updatedAt: string;
  statusReason: string;
  paperReadiness: string | null;
  nextInternalActions: string[];
  userBlockers: string[];
  evidence: ResearchWorkerEvidenceSnapshot | null;
  critic: ResearchWorkerCriticSnapshot | null;
};

export function researchWorkerStatePath(projectRoot: string): string {
  return researchWorkStoreFilePath(projectRoot);
}

export function createResearchWorkerState(input: {
  projectRoot: string;
  brief: ResearchBrief;
  now: string;
}): ResearchWorkerState {
  return {
    schemaVersion: 1,
    projectRoot: input.projectRoot,
    brief: input.brief,
    status: "not_started",
    activeRunId: null,
    lastRunId: null,
    segmentCount: 0,
    updatedAt: input.now,
    statusReason: "No autonomous research worker segment has started yet.",
    paperReadiness: null,
    nextInternalActions: [],
    userBlockers: [],
    evidence: null,
    critic: null
  };
}

export async function loadResearchWorkerState(
  projectRoot: string
): Promise<ResearchWorkerState | null> {
  const now = new Date().toISOString();
  const store = await loadResearchWorkStore({
    projectRoot,
    now
  });

  if (store.worker.status === "not_started" && store.worker.lastRunId === null) {
    return null;
  }

  return {
    schemaVersion: 1,
    projectRoot,
    brief: store.brief,
    status: store.worker.status,
    activeRunId: store.worker.activeRunId,
    lastRunId: store.worker.lastRunId,
    segmentCount: store.worker.segmentCount,
    updatedAt: store.worker.updatedAt,
    statusReason: store.worker.statusReason,
    paperReadiness: store.worker.paperReadiness,
    nextInternalActions: store.worker.nextInternalActions,
    userBlockers: store.worker.userBlockers,
    evidence: {
      canonicalPapers: store.objects.canonicalSources.length,
      selectedPapers: store.objects.canonicalSources.filter((source) => source.screeningDecision === "include").length,
      extractedPapers: store.objects.extractions.length,
      evidenceRows: new Set(store.objects.evidenceCells.map((cell) => cell.sourceId)).size,
      referencedPapers: new Set(store.objects.citations.map((citation) => citation.sourceId)).size
    },
    critic: {
      finalSatisfaction: store.objects.workItems.some((item) => item.source === "critic" && item.status === "open")
        ? "unresolved"
        : store.objects.workItems.some((item) => item.source === "critic")
          ? "pass"
          : null,
      unresolvedStages: [],
      objections: store.objects.workItems
        .filter((item) => item.source === "critic" && item.status === "open")
        .map((item) => item.description)
        .slice(0, 12)
    }
  };
}

export async function writeResearchWorkerState(state: ResearchWorkerState): Promise<void> {
  if (state.status === "needs_user_decision") {
    const decisionText = [
      state.statusReason,
      ...state.userBlockers,
      ...state.nextInternalActions
    ].join("\n");
    const hasDecision = /\b(decision|choose|approve|reject|option|alternative)\b/i.test(decisionText);
    const hasOptions = state.userBlockers.length >= 2
      || state.nextInternalActions.length >= 2
      || /\b(option\s*[ab12]|approve\/reject|yes\/no|choose between)\b/i.test(decisionText);

    if (!hasDecision || !hasOptions) {
      throw new Error("needs_user_decision requires a concrete user decision with explicit options and a reason the model cannot choose alone.");
    }
  }

  const now = state.updatedAt || new Date().toISOString();
  const existing = await loadResearchWorkStore({
    projectRoot: state.projectRoot,
    brief: state.brief,
    now
  });
  const store = existing.projectRoot === state.projectRoot
    ? existing
    : createResearchWorkStore({
      projectRoot: state.projectRoot,
      brief: state.brief,
      now
    });

  await writeResearchWorkStore(updateResearchWorkStoreWorker({
    ...store,
    brief: state.brief
  }, {
    status: state.status,
    activeRunId: state.activeRunId,
    lastRunId: state.lastRunId,
    segmentCount: state.segmentCount,
    updatedAt: state.updatedAt,
    statusReason: state.statusReason,
    paperReadiness: state.paperReadiness,
    nextInternalActions: state.nextInternalActions,
    userBlockers: state.userBlockers
  }, now));
}
