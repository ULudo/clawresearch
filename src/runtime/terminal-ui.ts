import readline from "node:readline";
import {
  ConsoleTranscript
} from "./console-transcript.js";
import {
  emitAssistantTurn,
  handleGoCommand,
  handlePauseCommand,
  handleResumeCommand,
  handleUserInput,
  reconcileRelevantRun,
  renderHelp,
  renderStatus,
  type OutputWriter,
  type RunOptions
} from "./console-app.js";
import {
  createDefaultIntakeBackend,
  type IntakeBackend
} from "./intake-backend.js";
import {
  LiteratureStore
} from "./literature-store.js";
import {
  MemoryStore
} from "./memory-store.js";
import {
  applyCredentialsToEnvironment,
  CredentialStore,
  setCredentialValue,
  type CredentialStoreState
} from "./credential-store.js";
import {
  authStatesForSelectedProviders,
  ProjectConfigStore,
  type ProjectConfigState
} from "./project-config-store.js";
import {
  getSourceProviderDefinition,
  providerCredentialFields,
  type SourceProviderId
} from "./provider-registry.js";
import {
  RunStore,
  type RunRecord
} from "./run-store.js";
import {
  appendConversationEntry,
  type ConversationEntry,
  SessionStore,
  type SessionState
} from "./session-store.js";
import {
  parseRunEventLines,
  readRunEventChunk,
  type RunEventKind
} from "./run-events.js";
import {
  authPromptLabel,
  authPromptGuidance,
  buildSourceChecklistEntries,
  renderAuthPromptFrame,
  renderChatFrame,
  renderSourceChecklist,
  toggleSourceChecklistEntry,
  type ScreenLogEntry,
  type SourceChecklistEntry
} from "./terminal-ui-model.js";
import {
  createDefaultRunController,
  type RunController
} from "./run-controller.js";

type TerminalInput = NodeJS.ReadStream & {
  setRawMode?: (mode: boolean) => void;
};

type TerminalOutput = NodeJS.WriteStream & {
  columns?: number;
  rows?: number;
};

type TerminalUiOptions = RunOptions & {
  input?: TerminalInput;
  output?: TerminalOutput;
  intakeBackend?: IntakeBackend;
};

type SourceOverlayState = {
  draft: ProjectConfigState;
  original: ProjectConfigState;
  focusIndex: number;
  initialSetup: boolean;
};

type AuthOverlayState = {
  fields: Array<{
    providerId: SourceProviderId;
    fieldId: string;
  }>;
  index: number;
  input: string;
  initialSetup: boolean;
};

type ModalState = {
  title: string;
  lines: string[];
};

type RunCursor = {
  runId: string;
  offset: number;
  trailingBuffer: string;
  terminalNoticeShown: boolean;
};

function cloneConfig(config: ProjectConfigState): ProjectConfigState {
  return JSON.parse(JSON.stringify(config)) as ProjectConfigState;
}

function conversationTag(entry: ConversationEntry): string {
  if (entry.role === "user") {
    return entry.kind === "command" ? "cmd" : "you";
  }

  if (entry.kind === "command" || entry.kind === "system") {
    return "system";
  }

  return "consultant";
}

function mapConversationEntry(entry: ConversationEntry): ScreenLogEntry {
  return {
    tag: conversationTag(entry),
    text: entry.text
  };
}

function appendTranscriptEntry(
  transcript: ConsoleTranscript,
  entry: ConversationEntry
): void {
  if (entry.role === "user") {
    transcript.appendInput("clawresearch> ", entry.text);
    return;
  }

  transcript.appendOutput(`${conversationTag(entry).padEnd(10)} ${entry.text}\n`);
}

function latestChatEntry(session: SessionState): ConversationEntry | null {
  return [...session.conversation]
    .reverse()
    .find((entry) => entry.kind === "chat")
    ?? null;
}

function createBufferWriter(): {
  writer: OutputWriter;
  readText: () => string;
} {
  let buffer = "";

  return {
    writer: {
      write(chunk: string): void {
        buffer += chunk;
      }
    },
    readText(): string {
      return buffer;
    }
  };
}

function parseTaggedOutput(output: string): ScreenLogEntry[] {
  const entries: ScreenLogEntry[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    if (line.trim().length === 0) {
      continue;
    }

    const match = line.match(/^([a-z]+)\s+(.*)$/i);

    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.push({
        tag: match[1].toLowerCase(),
        text: match[2]
      });
      continue;
    }

    entries.push({
      tag: "system",
      text: line.trim()
    });
  }

  return entries;
}

function helpLines(backendLabel: string | null): string[] {
  const capture = createBufferWriter();
  const session = {
    intake: {
      backendLabel
    }
  } as SessionState;
  renderHelp(capture.writer, session);
  return capture.readText().trimEnd().split("\n");
}

function sourceCommandLike(input: string): boolean {
  return /^(?:sources?|scholarly|scholarly discovery|publishers?|publisher(?:\/| )full(?:[- ]|)text|fulltext|oa|oa helpers?|helpers?|general web|web|background|local|literature sources?)\s*:/i.test(input);
}

function footerHint(pendingLabel: string | null): string {
  return pendingLabel ?? "/help  /sources  /status  /go  /pause  /resume  /quit";
}

function isSubmitKey(key: readline.Key): boolean {
  return key.name === "return" || key.name === "enter";
}

function statusSubtitle(
  session: SessionState,
  run: RunRecord | null,
  projectRoot: string,
  pendingLabel: string | null
): string {
  const runStatus = run === null ? "none" : `${run.status}${run.id ? ` (${run.id})` : ""}`;
  const base = `project: ${projectRoot}  backend: ${session.intake.backendLabel ?? "unknown"}  run: ${runStatus}`;
  return pendingLabel === null ? base : `${base}  state: ${pendingLabel}`;
}

function eventTag(kind: RunEventKind): string {
  return kind === "literature" ? "lit" : kind;
}

export class ClawResearchTerminalUi {
  private readonly now: () => string;
  private readonly store: SessionStore;
  private readonly runStore: RunStore;
  private readonly memoryStore: MemoryStore;
  private readonly literatureStore: LiteratureStore;
  private readonly projectConfigStore: ProjectConfigStore;
  private readonly credentialStore: CredentialStore;
  private readonly runController: RunController;
  private readonly backend: IntakeBackend;
  private readonly transcript: ConsoleTranscript;

  private session!: SessionState;
  private projectConfig!: ProjectConfigState;
  private credentials!: CredentialStoreState;
  private currentRun: RunRecord | null = null;
  private logEntries: ScreenLogEntry[] = [];
  private composer = "";
  private modal: ModalState | null = null;
  private sourceOverlay: SourceOverlayState | null = null;
  private authOverlay: AuthOverlayState | null = null;
  private pendingLabel: string | null = null;
  private runCursor: RunCursor | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private resolveRun: ((code: number) => void) | null = null;
  private closed = false;
  private spinnerStep = 0;

  constructor(
    private readonly input: TerminalInput,
    private readonly output: TerminalOutput,
    private readonly options: TerminalUiOptions
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.store = new SessionStore(options.projectRoot, options.version, this.now);
    this.runStore = new RunStore(options.projectRoot, options.version, this.now);
    this.memoryStore = new MemoryStore(options.projectRoot, this.now);
    this.literatureStore = new LiteratureStore(options.projectRoot, this.now);
    this.projectConfigStore = new ProjectConfigStore(options.projectRoot, this.now);
    this.credentialStore = new CredentialStore(options.projectRoot, this.now);
    this.runController = options.runController ?? createDefaultRunController();
    this.backend = options.intakeBackend ?? createDefaultIntakeBackend();
    this.transcript = new ConsoleTranscript(options.projectRoot);
  }

  async run(): Promise<number> {
    this.session = await this.store.load();
    this.projectConfig = await this.projectConfigStore.load();
    this.credentials = await this.credentialStore.load();
    applyCredentialsToEnvironment(this.credentials);

    this.session.intake.backendLabel = this.backend.label;
    await this.store.save(this.session);
    this.currentRun = await reconcileRelevantRun(
      this.session,
      this.store,
      this.runStore,
      this.runController,
      this.now
    );
    this.logEntries = this.session.conversation.map(mapConversationEntry);

    if (!this.projectConfig.sources.explicitlyConfigured) {
      this.sourceOverlay = {
        draft: cloneConfig(this.projectConfig),
        original: cloneConfig(this.projectConfig),
        focusIndex: 0,
        initialSetup: true
      };
    } else {
      await this.ensureOpeningAssistantTurn();
    }

    this.enterTerminal();
    this.startWatchers();
    this.render();

    return await new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });
  }

  private enterTerminal(): void {
    readline.emitKeypressEvents(this.input);
    this.input.setRawMode?.(true);
    this.input.resume();
    this.input.on("keypress", this.onKeypress);
    this.output.on?.("resize", this.onResize);
    this.output.write("\u001b[?1049h\u001b[?25l");
  }

  private cleanup(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.watchTimer !== null) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }

    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }

    this.input.off("keypress", this.onKeypress);
    this.output.off?.("resize", this.onResize);
    this.input.setRawMode?.(false);
    this.output.write("\u001b[?25h\u001b[?1049l");
  }

  private async shutdown(code = 0): Promise<void> {
    this.cleanup();
    this.resolveRun?.(code);
  }

  private readonly onResize = (): void => {
    this.render();
  };

  private startWatchers(): void {
    this.watchTimer = setInterval(() => {
      void this.pollRunProgress();
    }, this.options.watchPollMs ?? 200);

    this.spinnerTimer = setInterval(() => {
      if (this.pendingLabel !== null) {
        this.spinnerStep = (this.spinnerStep + 1) % 4;
        this.render();
      }
    }, 160);
  }

  private async ensureOpeningAssistantTurn(): Promise<void> {
    const lastEntry = latestChatEntry(this.session);

    if (lastEntry === null) {
      await this.runAssistantTurn("start");
      return;
    }

    if (lastEntry.role === "user") {
      await this.runAssistantTurn("resume");
    }
  }

  private async runAssistantTurn(mode: "start" | "resume" | "continue"): Promise<void> {
    const previousLength = this.session.conversation.length;
    this.pendingLabel = mode === "continue" ? "consultant thinking" : "consultant preparing";
    this.render();

    const capture = createBufferWriter();
    await emitAssistantTurn(
      capture.writer,
      this.session,
      this.store,
      this.backend,
      mode,
      this.now
    );
    this.syncConversationDiff(previousLength);
    this.pendingLabel = null;
  }

  private syncConversationDiff(previousLength: number): void {
    const nextEntries = this.session.conversation.slice(previousLength);

    for (const entry of nextEntries) {
      this.logEntries.push(mapConversationEntry(entry));
      appendTranscriptEntry(this.transcript, entry);
    }
  }

  private appendActivityEntries(entries: ScreenLogEntry[]): void {
    for (const entry of entries) {
      this.logEntries.push(entry);
      this.transcript.appendOutput(`${entry.tag.padEnd(10)} ${entry.text}\n`);
    }
  }

  private currentScreenSize(): { width: number; height: number } {
    return {
      width: this.output.columns ?? 100,
      height: this.output.rows ?? 32
    };
  }

  private authFieldsForSelection(
    previousConfig: ProjectConfigState,
    nextConfig: ProjectConfigState,
    initialSetup: boolean
  ): Array<{ providerId: SourceProviderId; fieldId: string }> {
    const previousSelected = initialSetup
      ? new Set<SourceProviderId>()
      : new Set(
        authStatesForSelectedProviders(previousConfig, this.credentials)
          .map((state) => state.providerId)
      );

    return authStatesForSelectedProviders(nextConfig, this.credentials).flatMap((state) => {
      const newlySelected = !previousSelected.has(state.providerId);
      const shouldPromptAll = initialSetup || newlySelected;
      const fields = shouldPromptAll
        ? providerCredentialFields(state.providerId)
        : providerCredentialFields(state.providerId)
          .filter((field) => state.missingRequiredFieldIds.includes(field.id));

      return fields.map((field) => ({
        providerId: state.providerId,
        fieldId: field.id
      }));
    });
  }

  private render(): void {
    if (this.closed) {
      return;
    }

    const { width, height } = this.currentScreenSize();
    let content: string;

    if (this.sourceOverlay !== null) {
      content = renderSourceChecklist(
        this.sourceOverlay.draft,
        this.sourceOverlay.focusIndex,
        width,
        height
      );
    } else if (this.authOverlay !== null) {
      const currentField = this.authOverlay.fields[this.authOverlay.index]!;
      const providerId = currentField.providerId;
      const definition = getSourceProviderDefinition(providerId);
      const field = providerCredentialFields(providerId)
        .find((candidate) => candidate.id === currentField.fieldId);
      content = renderAuthPromptFrame({
        width,
        height,
        title: "ClawResearch",
        subtitle: `project: ${this.options.projectRoot}  backend: ${this.session.intake.backendLabel ?? "unknown"}  auth setup`,
        providerLabel: definition.label,
        providerDescription: definition.description,
        guidanceLines: authPromptGuidance(providerId, currentField.fieldId),
        inputLabel: authPromptLabel(providerId, currentField.fieldId),
        inputValue: `${this.authOverlay.input}_`,
        footerHint: field?.required === true
          ? "Enter saves this value, blank keeps the provider unavailable"
          : "Enter saves this value, blank leaves it unset"
      });
    } else {
      content = renderChatFrame({
        width,
        height,
        title: "ClawResearch",
        subtitle: statusSubtitle(
          this.session,
          this.currentRun,
          this.options.projectRoot,
          this.pendingLabel === null ? null : `${this.pendingLabel}${". ".repeat(this.spinnerStep).slice(0, this.spinnerStep)}`
        ),
        brief: this.session.brief,
        logs: this.logEntries,
        inputLabel: "Chat >",
        inputValue: `${this.composer}${this.pendingLabel === null ? "_" : ""}`,
        footerHint: footerHint(this.pendingLabel),
        modalTitle: this.modal?.title ?? null,
        modalLines: this.modal?.lines ?? []
      });
    }

    this.output.write(`\u001b[2J\u001b[H${content}\n`);
  }

  private readonly onKeypress = (value: string, key: readline.Key): void => {
    if (this.closed) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      void this.shutdown(0);
      return;
    }

    if (this.pendingLabel !== null && this.authOverlay === null) {
      return;
    }

    if (this.sourceOverlay !== null) {
      void this.handleSourceOverlayKey(key);
      return;
    }

    if (this.authOverlay !== null) {
      void this.handleAuthOverlayKey(value, key);
      return;
    }

    if (this.modal !== null) {
      if (key.name === "escape" || isSubmitKey(key)) {
        this.modal = null;
        this.render();
      }
      return;
    }

    if (key.name === "backspace") {
      this.composer = Array.from(this.composer).slice(0, -1).join("");
      this.render();
      return;
    }

    if (isSubmitKey(key)) {
      void this.submitComposer();
      return;
    }

    if (key.name === "escape") {
      this.composer = "";
      this.render();
      return;
    }

    if (typeof value === "string" && value.length > 0 && !key.ctrl && !key.meta) {
      this.composer += value;
      this.render();
    }
  };

  private async handleSourceOverlayKey(key: readline.Key): Promise<void> {
    const overlay = this.sourceOverlay;

    if (overlay === null) {
      return;
    }

    const entries = buildSourceChecklistEntries(overlay.draft);

    if (key.name === "up") {
      overlay.focusIndex = (overlay.focusIndex - 1 + entries.length) % entries.length;
      this.render();
      return;
    }

    if (key.name === "down") {
      overlay.focusIndex = (overlay.focusIndex + 1) % entries.length;
      this.render();
      return;
    }

    if (key.name === "space" || isSubmitKey(key)) {
      const focused = entries[overlay.focusIndex];

      if (focused !== undefined) {
        overlay.draft = toggleSourceChecklistEntry(overlay.draft, focused);
      }

      this.render();
      return;
    }

    if (key.name === "escape") {
      if (overlay.initialSetup) {
        await this.commitSourceSelection(overlay.draft, true);
      } else {
        this.sourceOverlay = null;
        this.render();
      }
      return;
    }

    if (key.name === "s" || key.name === "S") {
      await this.commitSourceSelection(overlay.draft, overlay.initialSetup);
    }
  }

  private async commitSourceSelection(draft: ProjectConfigState, initialSetup: boolean): Promise<void> {
    const previousConfig = this.projectConfig;
    const committed = cloneConfig(draft);
    committed.sources.explicitlyConfigured = true;
    this.projectConfig = await this.projectConfigStore.save(committed);
    this.sourceOverlay = null;

    const authFields = this.authFieldsForSelection(previousConfig, this.projectConfig, initialSetup);

    if (authFields.length > 0) {
      this.authOverlay = {
        fields: authFields,
        index: 0,
        input: "",
        initialSetup
      };
      this.render();
      return;
    }

    this.appendActivityEntries([{
      tag: "system",
      text: "Saved literature providers for this project."
    }]);

    if (initialSetup) {
      await this.ensureOpeningAssistantTurn();
    }

    this.render();
  }

  private async handleAuthOverlayKey(value: string, key: readline.Key): Promise<void> {
    const overlay = this.authOverlay;

    if (overlay === null) {
      return;
    }

    if (key.name === "backspace") {
      overlay.input = Array.from(overlay.input).slice(0, -1).join("");
      this.render();
      return;
    }

    if (key.name === "escape") {
      await this.advanceAuthOverlay();
      return;
    }

    if (isSubmitKey(key)) {
      const currentField = overlay.fields[overlay.index]!;
      const trimmed = overlay.input.trim();

      setCredentialValue(
        this.credentials,
        currentField.providerId,
        currentField.fieldId,
        trimmed.length === 0 ? null : trimmed
      );
      applyCredentialsToEnvironment(this.credentials);

      await this.advanceAuthOverlay();
      return;
    }

    if (typeof value === "string" && value.length > 0 && !key.ctrl && !key.meta) {
      overlay.input += value;
      this.render();
    }
  }

  private async advanceAuthOverlay(): Promise<void> {
    const overlay = this.authOverlay;

    if (overlay === null) {
      return;
    }

    if (overlay.index + 1 < overlay.fields.length) {
      overlay.index += 1;
      overlay.input = "";
      this.render();
      return;
    }

    this.credentials = await this.credentialStore.save(this.credentials);
    applyCredentialsToEnvironment(this.credentials);
    this.authOverlay = null;
    this.appendActivityEntries([{
      tag: "system",
      text: "Saved provider credentials for this project."
    }]);

    if (overlay.initialSetup) {
      await this.ensureOpeningAssistantTurn();
    }

    this.render();
  }

  private async submitComposer(): Promise<void> {
    const input = this.composer.trim();
    this.composer = "";

    if (input.length === 0) {
      this.render();
      return;
    }

    if (sourceCommandLike(input)) {
      this.sourceOverlay = {
        draft: cloneConfig(this.projectConfig),
        original: cloneConfig(this.projectConfig),
        focusIndex: 0,
        initialSetup: false
      };
      this.render();
      return;
    }

    if (input === "/quit" || input === "/exit") {
      const timestamp = this.now();
      appendConversationEntry(this.session, "user", input, timestamp, "command");
      appendConversationEntry(this.session, "assistant", "Session saved. Closing ClawResearch.", this.now(), "command");
      await this.store.save(this.session);
      this.syncConversationDiff(Math.max(0, this.session.conversation.length - 2));
      await this.shutdown(0);
      return;
    }

    if (input === "/sources") {
      this.sourceOverlay = {
        draft: cloneConfig(this.projectConfig),
        original: cloneConfig(this.projectConfig),
        focusIndex: 0,
        initialSetup: false
      };
      this.render();
      return;
    }

    if (input === "/help") {
      this.modal = {
        title: "Help",
        lines: helpLines(this.session.intake.backendLabel)
      };
      this.render();
      return;
    }

    if (input === "/status") {
      this.modal = await this.buildStatusModal();
      this.render();
      return;
    }

    if (input === "/go") {
      await this.runCommandAction("starting detached run", async (writer) => {
        await handleGoCommand(
          writer,
          this.session,
          this.store,
          this.runStore,
          this.backend,
          this.runController,
          this.now,
          false,
          this.options.watchPollMs ?? 200
        );
      });
      return;
    }

    if (input === "/pause") {
      await this.runCommandAction("pausing run", async (writer) => {
        await handlePauseCommand(
          writer,
          this.session,
          this.store,
          this.runStore,
          this.runController,
          this.now
        );
      });
      return;
    }

    if (input === "/resume") {
      await this.runCommandAction("resuming run", async (writer) => {
        await handleResumeCommand(
          writer,
          this.session,
          this.store,
          this.runStore,
          this.runController,
          this.now
        );
      });
      return;
    }

    if (input.startsWith("/")) {
      this.appendActivityEntries([{
        tag: "system",
        text: `Unknown command: ${input}. Use /help to see the available commands.`
      }]);
      this.render();
      return;
    }

    await this.runUserTurn(input);
  }

  private async runCommandAction(
    pendingLabel: string,
    action: (writer: OutputWriter) => Promise<void>
  ): Promise<void> {
    const previousLength = this.session.conversation.length;
    const capture = createBufferWriter();
    this.pendingLabel = pendingLabel;
    this.render();

    await action(capture.writer);
    this.currentRun = await reconcileRelevantRun(
      this.session,
      this.store,
      this.runStore,
      this.runController,
      this.now
    );
    this.syncConversationDiff(previousLength);
    this.appendActivityEntries(parseTaggedOutput(capture.readText()));
    this.pendingLabel = null;
    this.render();
  }

  private async runUserTurn(input: string): Promise<void> {
    const previousLength = this.session.conversation.length;
    this.pendingLabel = "consultant thinking";
    this.render();

    const capture = createBufferWriter();
    const noopIo = {
      writer: capture.writer,
      async prompt(): Promise<string | null> {
        return null;
      }
    };

    await handleUserInput(
      input,
      noopIo,
      this.transcript,
      capture.writer,
      this.session,
      this.store,
      this.projectConfig,
      this.projectConfigStore,
      this.credentials,
      this.credentialStore,
      this.backend,
      this.now
    );

    this.projectConfig = await this.projectConfigStore.load();
    this.credentials = await this.credentialStore.load();
    applyCredentialsToEnvironment(this.credentials);
    this.syncConversationDiff(previousLength);
    this.pendingLabel = null;
    this.render();
  }

  private async buildStatusModal(): Promise<ModalState> {
    const memory = await this.memoryStore.load();
    const literature = await this.literatureStore.load();
    const currentProjectConfig = await this.projectConfigStore.load();
    const currentCredentials = await this.credentialStore.load();
    applyCredentialsToEnvironment(currentCredentials);
    this.projectConfig = currentProjectConfig;
    this.credentials = currentCredentials;
    this.currentRun = await reconcileRelevantRun(
      this.session,
      this.store,
      this.runStore,
      this.runController,
      this.now
    );
    const capture = createBufferWriter();

    renderStatus(
      capture.writer,
      this.session,
      this.currentRun,
      this.transcript.filePath,
      memory,
      currentProjectConfig,
      literature,
      currentCredentials
    );

    return {
      title: "Status",
      lines: capture.readText().trimEnd().split("\n")
    };
  }

  private async pollRunProgress(): Promise<void> {
    if (this.closed) {
      return;
    }

    const run = await reconcileRelevantRun(
      this.session,
      this.store,
      this.runStore,
      this.runController,
      this.now
    );

    if (run === null) {
      this.currentRun = null;
      this.runCursor = null;
      return;
    }

    this.currentRun = run;

    if (this.runCursor === null || this.runCursor.runId !== run.id) {
      this.runCursor = {
        runId: run.id,
        offset: 0,
        trailingBuffer: "",
        terminalNoticeShown: false
      };
    }

    const chunk = await readRunEventChunk(run.artifacts.eventsPath, this.runCursor.offset);
    this.runCursor.offset = chunk.nextOffset;
    const parsed = parseRunEventLines(chunk.content, this.runCursor.trailingBuffer);
    this.runCursor.trailingBuffer = parsed.trailingBuffer;

    if (parsed.events.length > 0) {
      this.appendActivityEntries(parsed.events.map((event) => ({
        tag: eventTag(event.kind),
        text: event.message
      })));
      this.render();
    }

    if ((run.status === "completed" || run.status === "failed") && !this.runCursor.terminalNoticeShown) {
      this.runCursor.terminalNoticeShown = true;
      this.appendActivityEntries([{
        tag: run.status === "completed" ? "done" : "error",
        text: `Run ${run.id} ${run.status}.`
      }]);
      this.render();
    }
  }
}

export async function runTerminalUi(options: TerminalUiOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const ui = new ClawResearchTerminalUi(input, output, options);
  return ui.run();
}
