import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultRuntimeLlmConfig,
  ProjectConfigStore
} from "../src/runtime/project-config-store.js";
import type { ProjectConfigState } from "../src/runtime/project-config-store.js";
import {
  authPromptGuidance,
  buildSourceChecklistEntries,
  renderAuthPromptFrame,
  renderChatFrame,
  renderSourceChecklist,
  toggleSourceChecklistEntry
} from "../src/runtime/terminal-ui-model.js";

function sampleConfig(): ProjectConfigState {
  const store = new ProjectConfigStore("/tmp/clawresearch-ui-model");
  return {
    schemaVersion: 7,
    projectRoot: store.projectRoot,
    runtimeDirectory: `${store.projectRoot}/.clawresearch`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sources: {
      scholarlyDiscovery: {
        selectedProviderIds: ["openalex"]
      },
      publisherFullText: {
        selectedProviderIds: ["arxiv"]
      },
      oaRetrievalHelpers: {
        selectedProviderIds: []
      },
      generalWeb: {
        selectedProviderIds: []
      },
      localContext: {
        projectFilesEnabled: true
      },
      explicitlyConfigured: true
    },
    runtime: {
      postReviewBehavior: "confirm",
      llm: defaultRuntimeLlmConfig
    }
  };
}

function maxRenderedLineLength(output: string): number {
  return Math.max(...output.split("\n").map((line) => line.length));
}

test("source checklist toggles scholarly providers and local files", () => {
  const config = sampleConfig();
  const entries = buildSourceChecklistEntries(config);
  const openAlexEntry = entries.find((entry) => entry.providerId === "openalex");
  const localEntry = entries.find((entry) => entry.category === "localContext");

  assert.ok(openAlexEntry);
  assert.ok(localEntry);

  const withoutOpenAlex = toggleSourceChecklistEntry(config, openAlexEntry);
  assert.deepEqual(withoutOpenAlex.sources.scholarlyDiscovery.selectedProviderIds, []);

  const localOff = toggleSourceChecklistEntry(withoutOpenAlex, localEntry);
  assert.equal(localOff.sources.localContext.projectFilesEnabled, false);
});

test("source checklist render shows checkboxes and a focused row", () => {
  const output = renderSourceChecklist(sampleConfig(), 0, 100, 30);

  assert.match(output, /ClawResearch source setup/);
  assert.match(output, /Space or Enter to toggle, S to save, Esc to cancel/);
  assert.match(output, /Scholarly Discovery/);
  assert.match(output, /Publisher \/ Full Text/);
  assert.match(output, /OA \/ Retrieval Helpers/);
  assert.match(output, /General Web/);
  assert.match(output, /> \[x\] openalex - Broad scholarly discovery/);
  assert.match(output, /\[x\] arxiv - Preprint discovery and direct access/);
  assert.match(output, /\[x\] project files - Use local markdown and text files/);
});

test("chat frame keeps the latest conversation visible and shows a chat field", () => {
  const output = renderChatFrame({
    width: 96,
    height: 24,
    title: "ClawResearch",
    subtitle: "project: test-project  backend: ollama:qwen  run: queued",
    brief: {
      topic: "autonomous research agents",
      researchQuestion: "How should they review literature?",
      researchDirection: "compare retrieval and synthesis architectures",
      successCriterion: "produce concrete design recommendations"
    },
    conversationLogs: [
      { tag: "consultant", text: "Hello, tell me what you want to research." },
      { tag: "you", text: "I want to study autonomous research agents." }
    ],
    activityLogs: [
      { tag: "run", text: "Research run started." },
      { tag: "plan", text: "Plan the first literature pass." },
      { tag: "next", text: "Read the most relevant canonical papers next." }
    ],
    latestReply: { tag: "consultant", text: "Great, I can help narrow that into a strong first-pass review brief." },
    activityLabel: "Gather provider-aware scholarly sources...",
    commandSuggestions: [
      { command: "/go", description: "Start the detached research run", selected: true },
      { command: "/status", description: "Show the current brief and run state", selected: false }
    ],
    inputLabel: "Chat >",
    inputValue: "Focus on literature review workflows_",
    footerHint: "Up/Down choose  Tab complete  Enter accept/send  Esc clear"
  });

  assert.match(output, /Brief -----------------------------------------------/);
  assert.match(output, /topic: autonomous research agents/);
  assert.match(output, /Activity --------------------------------------------/);
  assert.match(output, /status: Gather provider-aware scholarly sources/);
  assert.match(output, /latest: Next - Read the most relevant canonical papers next\./);
  assert.match(output, /Recent Chat -----------------------------------------/);
  assert.match(output, /ClawResearch: Hello, tell me what you want to research\./);
  assert.match(output, /You: I want to study autonomous research agents\./);
  assert.match(output, /Latest Reply ----------------------------------------/);
  assert.match(output, /Great, I can help narrow that into a strong first-pass review brief\./);
  assert.match(output, /Commands --------------------------------------------/);
  assert.match(output, /> \/go\s+Start the detached research run/);
  assert.match(output, /Input -----------------------------------------------/);
  assert.match(output, /Chat > Focus on literature review workflows_/);
  assert.ok(maxRenderedLineLength(output) <= 92);
});

test("auth prompt frame stays focused on the credential question", () => {
  const output = renderAuthPromptFrame({
    width: 96,
    height: 20,
    title: "ClawResearch",
    subtitle: "project: /tmp/research-test  backend: ollama:qwen  auth setup",
    providerLabel: "pubmed",
    providerDescription: "Biomedical discovery through NCBI PubMed and E-utilities.",
    guidanceLines: authPromptGuidance("pubmed", "api_key"),
    inputLabel: "pubmed ncbi api key [optional]",
    inputValue: "secret-key_",
    footerHint: "Enter saves this value, blank leaves it unset"
  });

  assert.match(output, /Provider auth/);
  assert.match(output, /Provider: pubmed/);
  assert.match(output, /PubMed works without an NCBI API key/);
  assert.match(output, /Leave it blank to continue without it\./);
  assert.match(output, /Input/);
  assert.match(output, /pubmed ncbi api key \[optional\]/);
  assert.doesNotMatch(output, /Chat --------------------------------/);
  assert.doesNotMatch(output, /Brief --------------------------------/);
});

test("chat frame keeps narrow terminal lines inside the safety gutter", () => {
  const width = 64;
  const output = renderChatFrame({
    width,
    height: 22,
    title: "ClawResearch",
    subtitle: "project: /tmp/a/very/long/project/path/that/would/otherwise/clip  backend: ollama:qwen3:14b",
    brief: {
      topic: "autonomous research agents with unusually long prompt text",
      researchQuestion: "How should long live run updates avoid clipping at the terminal edge?",
      researchDirection: "Validate wrapping behavior for narrow TUI terminals.",
      successCriterion: "No rendered line should use the rightmost unsafe terminal columns."
    },
    conversationLogs: [
      { tag: "you", text: "x".repeat(180) }
    ],
    activityLogs: [
      { tag: "next", text: "Extracting reviewed paper batch with an extremely long canonical path and revision diagnostic message ".repeat(3) }
    ],
    latestReply: { tag: "consultant", text: "I will keep the layout readable even on a narrow terminal." },
    activityLabel: "Revising extraction by shrinking the next batch size to 1",
    commandSuggestions: [
      { command: "/paper checks", description: "Show manuscript readiness checks and revision diagnostics", selected: true },
      { command: "/status", description: "Show the current brief and latest run state", selected: false }
    ],
    inputLabel: "Chat >",
    inputValue: "/paper checks",
    footerHint: "Enter accept/send  Esc clear"
  });

  assert.ok(maxRenderedLineLength(output) <= width - 4);
});
