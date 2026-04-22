import type {
  ResearchAgenda,
  ResearchDirectionCandidate,
  WorkPackage
} from "./research-backend.js";

export type MethodPlan = {
  assumptions: string[];
  evaluationDesign: string;
  baselines: string[];
  controls: string[];
  ablations: string[];
  decisiveChecks: string[];
};

export type ExecutionChecklistItem = {
  id: string;
  title: string;
  kind: "inspection" | "command";
  intent: string;
  expectedOutput: string;
  failureInterpretation: string;
  status?: "pending" | "completed" | "blocked";
  notes?: string;
};

export type ExecutionChecklist = {
  items: ExecutionChecklistItem[];
};

export type WorkPackageDecision =
  | "continue"
  | "revise"
  | "failed_direction"
  | "return_to_agenda";

export type WorkPackageFinding = {
  id: string;
  title: string;
  summary: string;
  evidence: string[];
  status: "observed" | "blocked" | "missing";
};

export type WorkPackageDecisionRecord = {
  outcome: WorkPackageDecision;
  rationale: string;
  nextActions: string[];
  blockedBy: string[];
  status: "active" | "blocked" | "failed" | "returned";
};

function selectedDirection(
  agenda: ResearchAgenda
): ResearchDirectionCandidate | null {
  if (agenda.selectedDirectionId === null) {
    return null;
  }

  return agenda.candidateDirections.find((direction) => direction.id === agenda.selectedDirectionId) ?? null;
}

export function agendaHasActionableWorkPackage(agenda: ResearchAgenda): boolean {
  return workPackageContinueBlockers(agenda).length === 0;
}

export function autoRunnableMode(workPackage: WorkPackage | null): boolean {
  if (workPackage === null) {
    return false;
  }

  return workPackage.mode === "replication"
    || workPackage.mode === "benchmarking"
    || workPackage.mode === "ablation"
    || workPackage.mode === "method_improvement";
}

export function isWorkPackageAutoContinuable(agenda: ResearchAgenda): boolean {
  return workPackageAutoContinueBlockers(agenda).length === 0;
}

export function workPackageContinueBlockers(agenda: ResearchAgenda): string[] {
  if (agenda.selectedDirectionId === null || agenda.selectedWorkPackage === null) {
    return ["No actionable selected work package is available."];
  }

  const workPackage = agenda.selectedWorkPackage;
  const blockers: string[] = [];

  if (!autoRunnableMode(workPackage)) {
    blockers.push(`Mode ${workPackage.mode} is not executable in this phase.`);
  }

  if (agenda.holdReasons.length > 0) {
    blockers.push(`The agenda is on hold: ${agenda.holdReasons.join(" | ")}`);
  }

  if (workPackage.blockedBy.length > 0) {
    blockers.push(`The selected work package is blocked by: ${workPackage.blockedBy.join(" | ")}`);
  }

  return blockers;
}

export function workPackageAutoContinueBlockers(agenda: ResearchAgenda): string[] {
  const blockers = workPackageContinueBlockers(agenda);

  if (blockers.length > 0) {
    return blockers;
  }

  const workPackage = agenda.selectedWorkPackage;
  const direction = selectedDirection(agenda);

  if (workPackage === null || direction === null) {
    return ["The agenda does not have a matched selected direction and work package."];
  }

  if (!autoRunnableMode(workPackage)) {
    blockers.push(`Mode ${workPackage.mode} is not auto-runnable in this phase.`);
  }

  if (direction.scores.evidenceBase < 3) {
    blockers.push(`Evidence base score is ${direction.scores.evidenceBase}/5, below the 3/5 auto-continue threshold.`);
  }

  if (direction.scores.tractability < 3) {
    blockers.push(`Tractability score is ${direction.scores.tractability}/5, below the 3/5 auto-continue threshold.`);
  }

  if (direction.scores.overall < 3) {
    blockers.push(`Overall score is ${direction.scores.overall}/5, below the 3/5 auto-continue threshold.`);
  }

  if (workPackage.expectedArtifact.trim().length === 0) {
    blockers.push("The selected work package does not define an expected artifact.");
  }

  if (workPackage.decisiveExperiment.trim().length === 0) {
    blockers.push("The selected work package does not define a decisive experiment.");
  }

  if (workPackage.blockedBy.length > 0) {
    blockers.push(`The selected work package is blocked by: ${workPackage.blockedBy.join(" | ")}`);
  }

  return blockers;
}

export function agendaSummaryLines(agenda: ResearchAgenda): string[] {
  const lines = [
    `Executive summary: ${agenda.executiveSummary}`,
    `Candidate directions: ${agenda.candidateDirections.length}`,
    `Selected direction: ${agenda.selectedDirectionId ?? "<none>"}`,
    `Selected work package: ${agenda.selectedWorkPackage?.title ?? "<none>"}`
  ];

  if (agenda.holdReasons.length > 0) {
    lines.push(`Hold reasons: ${agenda.holdReasons.join(" | ")}`);
  }

  lines.push(`Recommended human decision: ${agenda.recommendedHumanDecision}`);
  return lines;
}
