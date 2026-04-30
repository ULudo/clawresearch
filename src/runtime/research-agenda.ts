import type { ResearchAgenda } from "./research-backend.js";

export function agendaSummaryLines(agenda: ResearchAgenda): string[] {
  const lines = [
    `Executive summary: ${agenda.executiveSummary}`,
    `Candidate directions: ${agenda.candidateDirections.length}`,
    `Selected direction: ${agenda.selectedDirectionId ?? "<none>"}`,
    `Internal gaps: ${agenda.gaps.length}`
  ];

  if (agenda.holdReasons.length > 0) {
    lines.push(`Hold reasons: ${agenda.holdReasons.join(" | ")}`);
  }

  lines.push(`Recommended human decision: ${agenda.recommendedHumanDecision}`);
  return lines;
}
