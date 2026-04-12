import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  appendConversationEntry,
  type ConversationKind,
  type ResearchBrief,
  type ResearchBriefField,
  type SessionState,
  SessionStore,
  setBriefField
} from "./session-store.js";
import {
  createDefaultIntakeBackend,
  type IntakeBackend,
  type IntakeRequest,
  type IntakeResponse
} from "./intake-backend.js";
import {
  createDefaultRunController,
  type RunController
} from "./run-controller.js";
import {
  RunStore,
  type RunRecord
} from "./run-store.js";
import {
  ConsoleTranscript
} from "./console-transcript.js";
import {
  parseRunEventLines,
  readRunEventChunk,
  type RunEventKind,
  type RunEventRecord
} from "./run-events.js";

export type OutputWriter = {
  write: (chunk: string) => void;
};

export type ConsoleIo = {
  writer: OutputWriter;
  prompt: (promptText: string) => Promise<string | null>;
  close?: () => void;
};

type RunOptions = {
  projectRoot: string;
  version: string;
  now?: () => string;
  intakeBackend?: IntakeBackend;
  runController?: RunController;
  watchRuns?: boolean;
  watchPollMs?: number;
};

type BriefUpdate = {
  field: ResearchBriefField;
  value: string;
};

const fieldLabels: Record<ResearchBriefField, string> = {
  topic: "topic",
  researchQuestion: "research question",
  researchDirection: "research direction",
  successCriterion: "success criterion"
};

const fieldPrefixMatchers: Array<{ field: ResearchBriefField; pattern: RegExp }> = [
  { field: "topic", pattern: /^(?:topic|research topic)\s*:\s*(.+)$/i },
  { field: "researchQuestion", pattern: /^(?:question|research question)\s*:\s*(.+)$/i },
  { field: "researchDirection", pattern: /^(?:direction|research direction)\s*:\s*(.+)$/i },
  { field: "successCriterion", pattern: /^(?:success|success criterion)\s*:\s*(.+)$/i }
];

const userAmbitionPattern = /\b(prove|proof|solve|solution|solvab|solvability|cure|eradicate|eliminate|breakthrough|invent|discover the answer|fully automate|full solution)\b/i;
const directEndStatePattern = /\b(prove|proof|cure|eradicate|eliminate|breakthrough|resolve|resolution|fully automate|full solution|solve (?:it|this|the problem|the hypothesis|the disease|the crisis))\b/i;
const boundedModePattern = /\b(literature|survey|review|map|mapping|synthesis|synthesize|evaluate|evaluation|compare|comparison|benchmark|benchmarking|replicat|reproduc|exploratory|exploration|pilot|feasibility|bounded|subproblem|case study|research note|note|prototype|ablation|identify|assessment|assess|scope|follow[- ]?up|baseline|artifact|memo|analysis)\b/i;
const deliverablePattern = /\b(note|report|analysis|benchmark|evaluation|survey|mapping|synthesis|prototype|experiment|ablation|dataset|replication|reproduction|review|plan|feasibility|baseline|artifact|memo)\b/i;
const genericFieldPattern = /^(?:algorithmic approaches?|computational methods?|literature review|historical context|theoretical frameworks?|number theory|physics|mathematics|applications?)$/i;
const taggedLabelWidth = 10;

function writeLine(writer: OutputWriter, line = ""): void {
  writer.write(`${line}\n`);
}

function createLoggedWriter(baseWriter: OutputWriter, transcript: ConsoleTranscript): OutputWriter {
  return {
    write(chunk: string): void {
      baseWriter.write(chunk);
      transcript.appendOutput(chunk);
    }
  };
}

function renderTaggedBlock(writer: OutputWriter, tag: string, text: string): void {
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (line.length === 0) {
      writeLine(writer);
      continue;
    }

    writeLine(writer, `${tag.padEnd(taggedLabelWidth)} ${line}`);
  }
}

function renderTaggedLines(writer: OutputWriter, tag: string, lines: string[]): void {
  for (const line of lines) {
    renderTaggedBlock(writer, tag, line);
  }
}

function relativeProjectPath(projectRoot: string, targetPath: string): string {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath.length === 0 ? "." : relativePath;
}

function renderBanner(writer: OutputWriter, session: SessionState, transcriptPath: string): void {
  writeLine(writer, "ClawResearch");
  writeLine(writer, "============");
  writeLine(writer, `Project root: ${session.projectRoot}`);
  writeLine(writer, `Runtime state: ${relativeProjectPath(session.projectRoot, session.runtimeDirectory)}/${"session.json"}`);
  writeLine(writer, `Debug log: ${relativeProjectPath(session.projectRoot, transcriptPath)}`);
  writeLine(writer);
}

function renderWelcome(writer: OutputWriter, session: SessionState): void {
  if (session.conversation.length === 0) {
    writeLine(writer, "Startup research chat is ready.");
    writeLine(writer, "This chat should feel like a stakeholder handing a research project to a capable research partner.");
  } else {
    writeLine(writer, "Resuming the saved startup chat for this project.");
  }

  writeLine(writer, "The current directory is treated as the project root automatically.");
  writeLine(writer, "Use `/help` for commands, `/status` for the current brief and run state, `/go` to start a detached run when the brief is ready, and `/quit` to leave.");
  writeLine(writer);
}

function renderHelp(writer: OutputWriter, session: SessionState): void {
  writeLine(writer, "Commands:");
  writeLine(writer, "  /help   Show the command list and input hints");
  writeLine(writer, "  /status Show the current research brief, run state, and backend");
  writeLine(writer, "  /go     Start a detached run from the current research brief");
  writeLine(writer, "  /pause  Pause the active detached run");
  writeLine(writer, "  /resume Resume the active detached run");
  writeLine(writer, "  /quit   Save and exit");
  writeLine(writer, "  /exit   Alias for /quit");
  writeLine(writer);
  writeLine(writer, "Input hints:");
  writeLine(writer, "  Talk naturally about the project as if briefing a researcher.");
  writeLine(writer, "  You can still force a specific field with `topic:`, `question:`, `direction:`, or `success:`.");
  writeLine(writer, "  Detached runs stream progress in the console and save a debug transcript locally.");
  writeLine(writer, `  Local intake backend: ${session.intake.backendLabel ?? "not configured"}`);
}

function renderStatus(
  writer: OutputWriter,
  session: SessionState,
  run: RunRecord | null,
  transcriptPath: string
): void {
  writeLine(writer, "Current brief:");
  writeLine(writer, `  topic: ${session.brief.topic ?? "<missing>"}`);
  writeLine(writer, `  research question: ${session.brief.researchQuestion ?? "<missing>"}`);
  writeLine(writer, `  research direction: ${session.brief.researchDirection ?? "<missing>"}`);
  writeLine(writer, `  success criterion: ${session.brief.successCriterion ?? "<missing>"}`);
  writeLine(writer);
  writeLine(writer, `Readiness: ${session.intake.readiness}`);

  if (session.intake.summary !== null) {
    writeLine(writer, `Summary: ${session.intake.summary}`);
  }

  if (session.intake.rationale !== null) {
    writeLine(writer, `Rationale: ${session.intake.rationale}`);
  }

  if (session.intake.openQuestions.length > 0) {
    writeLine(writer, "Still unclear:");

    for (const question of session.intake.openQuestions) {
      writeLine(writer, `  - ${question}`);
    }
  }

  if (session.intake.lastError !== null) {
    writeLine(writer, `Last backend issue: ${session.intake.lastError}`);
  }

  writeLine(writer);
  writeLine(writer, "Run:");

  if (run === null) {
    writeLine(writer, "  none yet");
  } else {
    writeLine(writer, `  id: ${run.id}`);
    writeLine(writer, `  status: ${run.status}`);

    if (run.statusMessage !== null) {
      writeLine(writer, `  detail: ${run.statusMessage}`);
    }

    writeLine(writer, `  trace: ${relativeProjectPath(session.projectRoot, run.artifacts.tracePath)}`);
    writeLine(writer, `  events: ${relativeProjectPath(session.projectRoot, run.artifacts.eventsPath)}`);
    writeLine(writer, `  stdout: ${relativeProjectPath(session.projectRoot, run.artifacts.stdoutPath)}`);
    writeLine(writer, `  stderr: ${relativeProjectPath(session.projectRoot, run.artifacts.stderrPath)}`);
  }

  writeLine(writer);
  writeLine(writer, `Status: ${session.status}`);
  writeLine(writer, `Go requests: ${session.goCount}`);
  writeLine(writer, `Messages saved: ${session.conversation.length}`);
  writeLine(writer, `Backend: ${session.intake.backendLabel ?? "<unknown>"}`);
  writeLine(writer, `Debug log: ${relativeProjectPath(session.projectRoot, transcriptPath)}`);
}

function parseExplicitBriefUpdate(input: string): BriefUpdate | null {
  for (const matcher of fieldPrefixMatchers) {
    const match = input.match(matcher.pattern);

    if (match?.[1] !== undefined) {
      return {
        field: matcher.field,
        value: match[1]
      };
    }
  }

  return null;
}

function summarizeMissingFields(session: SessionState): string[] {
  return Object.entries(session.brief)
    .filter(([, value]) => value === null)
    .map(([field]) => fieldLabels[field as ResearchBriefField]);
}

function briefValues(brief: ResearchBrief): string[] {
  return Object.values(brief).filter((value): value is string => value !== null);
}

function responseHasCompleteBrief(response: IntakeResponse): boolean {
  return briefValues(response.brief).length === Object.keys(response.brief).length;
}

function saveAssistantMessage(
  session: SessionState,
  text: string,
  timestamp: string,
  kind: ConversationKind = "chat"
): void {
  appendConversationEntry(session, "assistant", text, timestamp, kind);
}

function saveUserMessage(
  session: SessionState,
  text: string,
  timestamp: string,
  kind: ConversationKind = "chat"
): void {
  appendConversationEntry(session, "user", text, timestamp, kind);
}

function applyExplicitFieldUpdate(session: SessionState, update: BriefUpdate): void {
  setBriefField(session, update.field, update.value);
}

function comparableRootSet(text: string): Set<string> {
  return new Set(
    normalizeComparableText(text)
      .split(" ")
      .filter((token) => token.length >= 4)
      .map((token) => token.slice(0, 7))
  );
}

function sharedComparableRoots(left: string, right: string): number {
  const leftRoots = comparableRootSet(left);
  const rightRoots = comparableRootSet(right);
  let overlap = 0;

  for (const root of leftRoots) {
    if (rightRoots.has(root)) {
      overlap += 1;
    }
  }

  return overlap;
}

function fieldSpecificityScore(value: string): number {
  const normalized = normalizeComparableText(value);
  const words = normalized.split(" ").filter((word) => word.length > 0);
  let score = words.length;

  if (/[,:;]/.test(value)) {
    score += 1;
  }

  if (/\b(with|through|using|around|focused|focus|rather than|identify|produce|review|compare|evaluate|explor|grounded|deliverable)\b/i.test(value)) {
    score += 2;
  }

  if (genericFieldPattern.test(normalized)) {
    score -= 4;
  }

  return score;
}

function shouldKeepExistingField(existing: string, incoming: string): boolean {
  const normalizedExisting = normalizeComparableText(existing);
  const normalizedIncoming = normalizeComparableText(incoming);

  if (normalizedExisting === normalizedIncoming) {
    return true;
  }

  const existingContainsIncoming = normalizedIncoming.length >= 8 && normalizedExisting.includes(normalizedIncoming);
  const sharedRoots = sharedComparableRoots(existing, incoming);
  const specificityGap = fieldSpecificityScore(existing) - fieldSpecificityScore(incoming);
  const incomingWordCount = normalizedIncoming.split(" ").filter((word) => word.length > 0).length;

  return specificityGap >= 3
    && (sharedRoots > 0 || existingContainsIncoming || incomingWordCount <= 3);
}

function mergeBriefFieldValue(existing: string | null, incoming: string | null): string | null {
  if (incoming === null) {
    return null;
  }

  if (existing !== null && shouldKeepExistingField(existing, incoming)) {
    return existing;
  }

  return incoming;
}

function textHasBoundedMode(text: string | null): boolean {
  return text !== null && boundedModePattern.test(text);
}

function successCriterionNeedsReframe(text: string | null): boolean {
  if (text === null) {
    return false;
  }

  return directEndStatePattern.test(text) && !deliverablePattern.test(text);
}

function researchQuestionNeedsReframe(text: string | null): boolean {
  if (text === null) {
    return false;
  }

  return directEndStatePattern.test(text) && !textHasBoundedMode(text);
}

function briefNeedsBoundedReframe(brief: ResearchBrief): boolean {
  if (successCriterionNeedsReframe(brief.successCriterion)) {
    return true;
  }

  const boundedSignals = [
    brief.researchQuestion,
    brief.researchDirection,
    brief.successCriterion
  ].filter(textHasBoundedMode).length;

  return researchQuestionNeedsReframe(brief.researchQuestion) && boundedSignals === 0;
}

function briefCanStartFirstPass(brief: ResearchBrief): boolean {
  return briefValues(brief).length === Object.keys(brief).length
    && !briefNeedsBoundedReframe(brief);
}

function stabilizeIntakeResponse(session: SessionState, response: IntakeResponse): IntakeResponse {
  const brief: ResearchBrief = {
    topic: mergeBriefFieldValue(session.brief.topic, response.brief.topic),
    researchQuestion: mergeBriefFieldValue(session.brief.researchQuestion, response.brief.researchQuestion),
    researchDirection: mergeBriefFieldValue(session.brief.researchDirection, response.brief.researchDirection),
    successCriterion: mergeBriefFieldValue(session.brief.successCriterion, response.brief.successCriterion)
  };
  const normalizedResponse: IntakeResponse = {
    ...response,
    brief
  };

  if (briefCanStartFirstPass(brief)) {
    return {
      ...normalizedResponse,
      readiness: "ready",
      readinessRationale: response.readinessRationale ?? "The brief is concrete enough to start a first-pass research run.",
      openQuestions: response.readiness === "ready" ? response.openQuestions : []
    };
  }

  return normalizedResponse;
}

function applyIntakeResponse(session: SessionState, response: IntakeResponse): void {
  for (const [field, value] of Object.entries(response.brief)) {
    if (value === null) {
      session.brief[field as ResearchBriefField] = null;
      session.status = "startup_chat";
      continue;
    }

    setBriefField(session, field as ResearchBriefField, value);
  }

  session.intake.readiness = response.readiness;
  session.intake.rationale = response.readinessRationale;
  session.intake.openQuestions = response.openQuestions;
  session.intake.summary = response.summary;
  session.intake.lastError = null;
}

function recentChatMessages(
  session: SessionState,
  role: "assistant" | "user",
  limit = 4
): string[] {
  return session.conversation
    .filter((entry) => entry.kind === "chat" && entry.role === role)
    .slice(-limit)
    .map((entry) => entry.text);
}

function allChatMessages(
  session: SessionState,
  role: "assistant" | "user"
): string[] {
  return session.conversation
    .filter((entry) => entry.kind === "chat" && entry.role === role)
    .map((entry) => entry.text);
}

function normalizeComparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"()[\],.:;!?-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparableTokenSet(text: string): Set<string> {
  return new Set(
    normalizeComparableText(text)
      .split(" ")
      .filter((token) => token.length >= 4)
  );
}

function textSimilarity(left: string, right: string): number {
  const leftTokens = comparableTokenSet(left);
  const rightTokens = comparableTokenSet(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return normalizeComparableText(left) === normalizeComparableText(right) ? 1 : 0;
  }

  let overlap = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function looksLikeSubstantialUserTurn(text: string): boolean {
  const normalized = normalizeComparableText(text);

  if (normalized.length < 6) {
    return false;
  }

  if (/^(hi|hello|hey|yes|no|maybe|sure|okay|ok|thanks)$/.test(normalized)) {
    return false;
  }

  return true;
}

function assistantIsStillClarifying(response: IntakeResponse): boolean {
  return response.readiness === "needs_clarification"
    && (response.assistantMessage.includes("?") || response.openQuestions.length > 0);
}

function extractTopicHint(session: SessionState, response: IntakeResponse): string | null {
  if (response.brief.topic !== null) {
    return response.brief.topic;
  }

  if (session.brief.topic !== null) {
    return session.brief.topic;
  }

  const recentUser = recentChatMessages(session, "user", 4).reverse();

  for (const message of recentUser) {
    const normalized = message.trim();

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
}

function seemsLikeRepeatedAssistantTurn(session: SessionState, response: IntakeResponse): boolean {
  const assistantMessages = recentChatMessages(session, "assistant", 2);
  const previousAssistant = assistantMessages.at(-1);

  if (previousAssistant === undefined) {
    return false;
  }

  return textSimilarity(previousAssistant, response.assistantMessage) >= 0.72;
}

function userSignaledRepeatedQuestion(session: SessionState): boolean {
  const lastUserMessage = recentChatMessages(session, "user", 1).at(-1);

  if (lastUserMessage === undefined) {
    return false;
  }

  return /(already|same question|repeat|repeating|you asked me that)/i.test(lastUserMessage);
}

function enoughSignalToDraft(session: SessionState, response: IntakeResponse): boolean {
  if (!assistantIsStillClarifying(response)) {
    return false;
  }

  const userTurns = allChatMessages(session, "user").filter(looksLikeSubstantialUserTurn);
  const assistantQuestions = recentChatMessages(session, "assistant", 4)
    .filter((message) => message.includes("?"))
    .length;
  const hasTopicSignal = extractTopicHint(session, response) !== null;

  return hasTopicSignal
    && userTurns.length >= 4
    && assistantQuestions >= 3;
}

function overambitiousGoalDetected(session: SessionState, response: IntakeResponse): boolean {
  const texts = [
    response.brief.topic,
    response.brief.researchQuestion,
    response.brief.researchDirection,
    session.brief.topic,
    session.brief.researchQuestion,
    ...recentChatMessages(session, "user", 4)
  ].filter((value): value is string => value !== null);

  const combined = texts.join(" ").toLowerCase();
  const mentionsGrandGoal = userAmbitionPattern.test(combined);
  const lacksBoundedPlan = response.brief.researchDirection === null
    && session.brief.researchDirection === null
    && response.brief.successCriterion === null
    && session.brief.successCriterion === null;

  return mentionsGrandGoal && lacksBoundedPlan;
}

function buildRecoveryReason(session: SessionState, response: IntakeResponse): string | null {
  if (responseHasCompleteBrief(response) && briefNeedsBoundedReframe(response.brief)) {
    const topicHint = extractTopicHint(session, response) ?? "the project";
    return `The current brief for ${topicHint} still mirrors an end-state breakthrough goal too literally. Reframe it as a bounded first-pass research program with a realistic deliverable. Keep the topic, but rewrite the research question, direction, and success criterion so they describe credible next-step work rather than directly solving the grand challenge.`;
  }

  const repeatedClarification = userSignaledRepeatedQuestion(session)
    || seemsLikeRepeatedAssistantTurn(session, response);
  const enoughSignal = enoughSignalToDraft(session, response);

  if (!(repeatedClarification || enoughSignal)) {
    return null;
  }

  if (enoughSignal) {
    const topicHint = extractTopicHint(session, response) ?? "the project";
    return `The user has already provided several rounds of narrowing detail about ${topicHint}. Stop asking smaller clarifications. Draft the best working research brief and suggestion you can from the current context, then ask the user to confirm or correct it.`;
  }

  if (overambitiousGoalDetected(session, response)) {
    const topicHint = extractTopicHint(session, response) ?? "the project";
    return `The conversation is stuck in repeated clarification and the user is aiming directly at a broad end goal for ${topicHint}. Propose a realistic first-pass research brief instead of asking another narrow follow-up.`;
  }

  const topicHint = extractTopicHint(session, response) ?? "the project";
  return `The conversation is stuck in repeated clarification around ${topicHint}. Stop drilling into smaller details. Draft the most workable brief you can from the existing context and ask the user to confirm or correct it.`;
}

function userFacingGoRationale(session: SessionState): string | null {
  const rationale = session.intake.rationale;

  if (rationale === null) {
    return null;
  }

  if (/structured brief|field/i.test(rationale)) {
    return null;
  }

  return rationale;
}

function buildGoNotReadyLines(session: SessionState): string[] {
  const missingFields = summarizeMissingFields(session);
  const lines = ["I'm not ready to start the run yet."];

  if (missingFields.length > 0) {
    lines.push(`I still need: ${missingFields.join(", ")}.`);
  }

  const rationale = userFacingGoRationale(session);

  if (rationale !== null) {
    lines.push(rationale);
  }

  if (session.intake.openQuestions.length > 0) {
    lines.push(`Best next question: ${session.intake.openQuestions[0]}`);
  }

  if (lines.length === 1) {
    lines.push("I need one more clarification before I can lock the project brief.");
  }

  return lines;
}

function eventTag(kind: RunEventKind): string {
  switch (kind) {
    case "run":
      return "run";
    case "plan":
      return "plan";
    case "summary":
      return "summary";
    case "next":
      return "next";
    case "exec":
      return "exec";
    case "stdout":
      return "stdout";
    case "stderr":
      return "stderr";
  }
}

function renderRunEvent(writer: OutputWriter, event: RunEventRecord): void {
  renderTaggedBlock(writer, eventTag(event.kind), event.message);
}

async function readNewRunEvents(
  run: RunRecord,
  cursor: { offset: number; trailingBuffer: string }
): Promise<RunEventRecord[]> {
  const chunk = await readRunEventChunk(run.artifacts.eventsPath, cursor.offset);
  cursor.offset = chunk.nextOffset;
  const parsed = parseRunEventLines(chunk.content, cursor.trailingBuffer);
  cursor.trailingBuffer = parsed.trailingBuffer;
  return parsed.events;
}

function isTerminalRun(run: RunRecord): boolean {
  return run.status === "completed" || run.status === "failed";
}

function createInitialRunCommand(): string[] {
  return ["bash", "-lc", "clawresearch phase-2 bootstrap"];
}

async function loadRunIfPresent(
  runStore: RunStore,
  runId: string | null
): Promise<RunRecord | null> {
  if (runId === null) {
    return null;
  }

  try {
    return await runStore.load(runId);
  } catch {
    return null;
  }
}

async function reconcileRelevantRun(
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  runController: RunController,
  now: () => string
): Promise<RunRecord | null> {
  let run = await loadRunIfPresent(runStore, session.activeRunId);

  if (run !== null && !isTerminalRun(run) && run.workerPid !== null && !runController.isProcessAlive(run.workerPid)) {
    run.status = "failed";
    run.finishedAt = run.finishedAt ?? now();
    run.workerPid = null;
    run.statusMessage = "Detached run worker stopped before the run finished cleanly.";
    await runStore.save(run);
  }

  if (run !== null && isTerminalRun(run) && session.activeRunId === run.id) {
    session.activeRunId = null;
    session.lastRunId = run.id;
    await store.save(session);
  }

  if (run !== null) {
    return run;
  }

  if (session.activeRunId !== null) {
    session.activeRunId = null;
    await store.save(session);
  }

  return loadRunIfPresent(runStore, session.lastRunId);
}

function goReadinessFailures(session: SessionState): string[] {
  const failures: string[] = [];
  const missingFields = summarizeMissingFields(session);

  if (missingFields.length > 0) {
    failures.push(`Missing brief fields: ${missingFields.join(", ")}`);
  }

  if (session.intake.readiness !== "ready") {
    failures.push(session.intake.rationale ?? "The intake chat still needs clarification.");
  }

  return failures;
}

async function requestAssistantTurn(
  session: SessionState,
  backend: IntakeBackend,
  mode: IntakeRequest["mode"],
  recoveryReason?: string
): Promise<IntakeResponse> {
  return backend.respond({
    mode,
    projectRoot: session.projectRoot,
    brief: session.brief,
    openQuestions: session.intake.openQuestions,
    conversation: session.conversation
      .filter((entry) => entry.kind === "chat")
      .map((entry) => ({
        role: entry.role,
        content: entry.text
      })),
    recoveryReason
  });
}

async function emitAssistantTurn(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  backend: IntakeBackend,
  mode: "start" | "resume" | "continue",
  now: () => string
): Promise<void> {
  try {
    const initialResponse = stabilizeIntakeResponse(
      session,
      await requestAssistantTurn(session, backend, mode)
    );
    const recoveryReason = buildRecoveryReason(session, initialResponse);
    const response = recoveryReason === null
      ? initialResponse
      : stabilizeIntakeResponse(
        session,
        await requestAssistantTurn(session, backend, "recover", recoveryReason)
      );
    applyIntakeResponse(session, response);
    renderTaggedBlock(writer, "consultant", response.assistantMessage);
    saveAssistantMessage(session, response.assistantMessage, now());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown backend failure";
    session.intake.lastError = message;
    const fallback = "The local intake model is unavailable right now. You can keep chatting, use explicit field prefixes, or retry once Ollama is responding again.";
    renderTaggedBlock(writer, "system", fallback);
    saveAssistantMessage(session, fallback, now(), "system");
  }

  await store.save(session);
}

async function attemptBriefCompletionForGo(
  session: SessionState,
  backend: IntakeBackend
): Promise<boolean> {
  const missingFields = summarizeMissingFields(session);
  const reasonParts = [
    "The user invoked /go and wants to proceed with the current conversation.",
    missingFields.length > 0
      ? `The brief still needs: ${missingFields.join(", ")}.`
      : "The brief is still marked as not ready.",
    "Draft the strongest complete first-pass research brief you can from the existing conversation.",
    "If a full draft brief is already present, keep that wording unless you are making it more concrete or more realistically bounded.",
    "Fill in a reasonable research question, research direction, and success criterion when the conversation already provides enough signal.",
    "Only leave fields null if the conversation truly lacks enough information."
  ];

  const response = stabilizeIntakeResponse(
    session,
    await requestAssistantTurn(
      session,
      backend,
      "recover",
      reasonParts.join(" ")
    )
  );
  applyIntakeResponse(session, response);

  return goReadinessFailures(session).length === 0;
}

async function watchRunProgress(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  runController: RunController,
  run: RunRecord,
  now: () => string,
  watchPollMs: number
): Promise<RunRecord | null> {
  const cursor = {
    offset: 0,
    trailingBuffer: ""
  };

  renderTaggedBlock(
    writer,
    "watch",
    `Streaming live run activity from ${relativeProjectPath(session.projectRoot, run.artifacts.eventsPath)}.`
  );

  while (true) {
    const events = await readNewRunEvents(run, cursor);

    for (const event of events) {
      renderRunEvent(writer, event);
    }

    const currentRun = await reconcileRelevantRun(session, store, runStore, runController, now);

    if (currentRun === null) {
      renderTaggedBlock(writer, "run", "The detached run record is no longer available.");
      return null;
    }

    run = currentRun;

    if (isTerminalRun(run)) {
      const trailingEvents = await readNewRunEvents(run, cursor);

      for (const event of trailingEvents) {
        renderRunEvent(writer, event);
      }

      renderTaggedBlock(
        writer,
        run.status === "completed" ? "done" : "error",
        run.status === "completed"
          ? `Run ${run.id} completed.`
          : `Run ${run.id} failed.`
      );
      return run;
    }

    await delay(watchPollMs);
  }
}

async function handleGoCommand(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  backend: IntakeBackend,
  runController: RunController,
  now: () => string,
  watchRuns: boolean,
  watchPollMs: number
): Promise<void> {
  const reconciledRun = await reconcileRelevantRun(session, store, runStore, runController, now);

  if (reconciledRun !== null && !isTerminalRun(reconciledRun)) {
    const lines = [
      "A detached research run is already active for this project.",
      `Run id: ${reconciledRun.id}`,
      `Status: ${reconciledRun.status}`,
      `Trace: ${relativeProjectPath(session.projectRoot, reconciledRun.artifacts.tracePath)}`,
      "Use `/status` to inspect it, or `/pause` and `/resume` to control it."
    ];

    renderTaggedLines(writer, "run", lines);

    saveAssistantMessage(session, lines.join(" "), now(), "command");
    await store.save(session);
    return;
  }

  const neededCompletion = summarizeMissingFields(session).length > 0
    || session.intake.readiness !== "ready";

  if (session.intake.readiness !== "ready" && briefCanStartFirstPass(session.brief)) {
    session.intake.readiness = "ready";
    session.intake.rationale = "The brief is concrete enough to start a first-pass research run.";
    session.intake.openQuestions = [];
    await store.save(session);
  }

  if (neededCompletion && !briefCanStartFirstPass(session.brief)) {
    try {
      await attemptBriefCompletionForGo(session, backend);
      await store.save(session);
    } catch (error) {
      session.intake.lastError = error instanceof Error ? error.message : "Unknown backend failure";
      await store.save(session);
    }
  }

  const failures = goReadinessFailures(session);

  if (failures.length > 0) {
    const lines = buildGoNotReadyLines(session);

    renderTaggedLines(writer, "consultant", lines);

    saveAssistantMessage(session, lines.join(" "), now(), "command");
    await store.save(session);
    return;
  }

  session.status = "ready";
  let run: RunRecord;

  try {
    run = await runStore.create(session.brief, createInitialRunCommand());
    const workerPid = await runController.launch(run);
    run.workerPid = workerPid;
    run.status = "queued";
    run.statusMessage = "Detached run launched. Waiting for the run worker to start.";
    await runStore.save(run);
    session.activeRunId = run.id;
    session.lastRunId = run.id;
    session.goCount += 1;
    session.lastGoRequestedAt = now();
    await store.save(session);
  } catch (error) {
    const response = error instanceof Error
      ? `I couldn't start the detached run: ${error.message}`
      : "I couldn't start the detached run due to an unknown error.";
    renderTaggedBlock(writer, "error", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  const responseLines = [
    "Research run started.",
    `Run id: ${run.id}`,
    `Status: ${run.status}`,
    `Trace: ${relativeProjectPath(session.projectRoot, run.artifacts.tracePath)}`,
    `Events: ${relativeProjectPath(session.projectRoot, run.artifacts.eventsPath)}`,
    `Stdout: ${relativeProjectPath(session.projectRoot, run.artifacts.stdoutPath)}`,
    `Stderr: ${relativeProjectPath(session.projectRoot, run.artifacts.stderrPath)}`,
    watchRuns
      ? "The detached run is working in the current project directory, and the console will stream live progress until the current run reaches a terminal state."
      : "The detached run is working in the current project directory. Use `/status` to inspect it, `/pause` to stop it temporarily, or `/resume` to continue a paused run."
  ];

  renderTaggedLines(writer, "run", responseLines);

  saveAssistantMessage(session, responseLines.join(" "), now(), "command");

  if (watchRuns) {
    await watchRunProgress(
      writer,
      session,
      store,
      runStore,
      runController,
      run,
      now,
      watchPollMs
    );
  }
}

async function handlePauseCommand(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  runController: RunController,
  now: () => string
): Promise<void> {
  const run = await reconcileRelevantRun(session, store, runStore, runController, now);

  if (run === null) {
    const response = "There is no detached run to pause right now.";
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (isTerminalRun(run)) {
    const response = `Run ${run.id} is already ${run.status}. There is nothing to pause.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (run.status === "paused") {
    const response = `Run ${run.id} is already paused.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (run.workerPid === null) {
    const response = `Run ${run.id} does not currently have a live worker process to pause.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  await runController.pause(run.workerPid);
  run.status = "paused";
  run.statusMessage = "Run paused from the console.";
  await runStore.save(run);

  const response = `Paused run ${run.id}.`;
  renderTaggedBlock(writer, "run", response);
  saveAssistantMessage(session, response, now(), "command");
  await store.save(session);
}

async function handleResumeCommand(
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  runController: RunController,
  now: () => string
): Promise<void> {
  const run = await reconcileRelevantRun(session, store, runStore, runController, now);

  if (run === null) {
    const response = "There is no detached run to resume right now.";
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (isTerminalRun(run)) {
    const response = `Run ${run.id} is already ${run.status}. There is nothing to resume.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (run.status !== "paused") {
    const response = `Run ${run.id} is not paused. Its current status is ${run.status}.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  if (run.workerPid === null) {
    const response = `Run ${run.id} does not currently have a live worker process to resume.`;
    renderTaggedBlock(writer, "system", response);
    saveAssistantMessage(session, response, now(), "command");
    await store.save(session);
    return;
  }

  await runController.resume(run.workerPid);
  run.status = "running";
  run.statusMessage = "Run resumed from the console.";
  await runStore.save(run);

  const response = `Resumed run ${run.id}.`;
  renderTaggedBlock(writer, "run", response);
  saveAssistantMessage(session, response, now(), "command");
  await store.save(session);
}

async function handleUserInput(
  input: string,
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  backend: IntakeBackend,
  now: () => string
): Promise<void> {
  const timestamp = now();
  saveUserMessage(session, input, timestamp);

  const explicitUpdate = parseExplicitBriefUpdate(input);

  if (explicitUpdate !== null) {
    applyExplicitFieldUpdate(session, explicitUpdate);
  }

  await emitAssistantTurn(writer, session, store, backend, "continue", now);
}

async function handleCommand(
  command: string,
  writer: OutputWriter,
  session: SessionState,
  store: SessionStore,
  runStore: RunStore,
  backend: IntakeBackend,
  runController: RunController,
  now: () => string,
  transcriptPath: string,
  watchRuns: boolean,
  watchPollMs: number
): Promise<"continue" | "quit"> {
  const timestamp = now();
  saveUserMessage(session, command, timestamp, "command");

  switch (command) {
    case "/help": {
      renderHelp(writer, session);
      saveAssistantMessage(session, "Displayed help and input hints.", now(), "command");
      await store.save(session);
      return "continue";
    }
    case "/status": {
      const run = await reconcileRelevantRun(session, store, runStore, runController, now);
      renderStatus(writer, session, run, transcriptPath);
      saveAssistantMessage(session, "Displayed the current research brief.", now(), "command");
      await store.save(session);
      return "continue";
    }
    case "/go": {
      await handleGoCommand(writer, session, store, runStore, backend, runController, now, watchRuns, watchPollMs);
      await store.save(session);
      return "continue";
    }
    case "/pause": {
      await handlePauseCommand(writer, session, store, runStore, runController, now);
      return "continue";
    }
    case "/resume": {
      await handleResumeCommand(writer, session, store, runStore, runController, now);
      return "continue";
    }
    case "/quit":
    case "/exit": {
      const response = "Session saved. Closing ClawResearch.";
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "command");
      await store.save(session);
      return "quit";
    }
    default: {
      const response = `Unknown command: ${command}. Use \`/help\` to see the available commands.`;
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "command");
      await store.save(session);
      return "continue";
    }
  }
}

export async function runPhaseOneConsole(io: ConsoleIo, options: RunOptions): Promise<number> {
  const now = options.now ?? (() => new Date().toISOString());
  const store = new SessionStore(options.projectRoot, options.version, now);
  const session = await store.load();
  const backend = options.intakeBackend ?? createDefaultIntakeBackend();
  const runStore = new RunStore(options.projectRoot, options.version, now);
  const runController = options.runController ?? createDefaultRunController();
  const transcript = new ConsoleTranscript(options.projectRoot);
  const writer = createLoggedWriter(io.writer, transcript);
  const watchRuns = options.watchRuns ?? options.runController === undefined;
  const watchPollMs = options.watchPollMs ?? 150;

  session.intake.backendLabel = backend.label;
  await store.save(session);
  await reconcileRelevantRun(session, store, runStore, runController, now);

  renderBanner(writer, session, transcript.filePath);
  renderWelcome(writer, session);

  await emitAssistantTurn(
    writer,
    session,
    store,
    backend,
    session.conversation.some((entry) => entry.kind === "chat") ? "resume" : "start",
    now
  );

  while (true) {
    const line = await io.prompt("clawresearch> ");

    if (line === null) {
      const response = "Input closed. Session saved.";
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "system");
      await store.save(session);
      break;
    }

    transcript.appendInput("clawresearch> ", line);
    const input = line.trim();

    if (input.length === 0) {
      const response = session.intake.openQuestions[0]
        ?? "Take your time. Tell me more about the research goal or use `/status` to inspect the current brief.";
      renderTaggedBlock(writer, "system", response);
      saveAssistantMessage(session, response, now(), "system");
      await store.save(session);
      continue;
    }

    if (input.startsWith("/")) {
      const result = await handleCommand(
        input,
        writer,
        session,
        store,
        runStore,
        backend,
        runController,
        now,
        transcript.filePath,
        watchRuns,
        watchPollMs
      );

      if (result === "quit") {
        break;
      }

      continue;
    }

    await handleUserInput(input, writer, session, store, backend, now);
  }

  io.close?.();
  return 0;
}
