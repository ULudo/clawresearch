import test from "node:test";
import assert from "node:assert/strict";
import { ProjectConfigStore } from "../src/runtime/project-config-store.js";
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
    schemaVersion: 2,
    projectRoot: store.projectRoot,
    runtimeDirectory: `${store.projectRoot}/.clawresearch`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sources: {
      scholarly: {
        selectedProviderIds: ["openalex", "arxiv"]
      },
      background: {
        selectedProviderIds: []
      },
      local: {
        projectFilesEnabled: true
      },
      authRefs: {},
      explicitlyConfigured: true
    }
  };
}

test("source checklist toggles scholarly providers and local files", () => {
  const config = sampleConfig();
  const entries = buildSourceChecklistEntries(config);
  const openAlexEntry = entries.find((entry) => entry.providerId === "openalex");
  const localEntry = entries.find((entry) => entry.category === "local");

  assert.ok(openAlexEntry);
  assert.ok(localEntry);

  const withoutOpenAlex = toggleSourceChecklistEntry(config, openAlexEntry);
  assert.deepEqual(withoutOpenAlex.sources.scholarly.selectedProviderIds, ["arxiv"]);

  const localOff = toggleSourceChecklistEntry(withoutOpenAlex, localEntry);
  assert.equal(localOff.sources.local.projectFilesEnabled, false);
});

test("source checklist render shows checkboxes and a focused row", () => {
  const output = renderSourceChecklist(sampleConfig(), 0, 100, 30);

  assert.match(output, /ClawResearch source setup/);
  assert.match(output, /Space or Enter to toggle, S to save, Esc to cancel/);
  assert.match(output, /> \[x\] openalex - Broad scholarly discovery/);
  assert.match(output, /\[x\] arxiv - Preprint discovery and direct access/);
  assert.match(output, /\[x\] project files - Use local markdown and text files/);
});

test("chat frame keeps the latest conversation visible and shows a chat field", () => {
  const output = renderChatFrame({
    width: 96,
    height: 20,
    title: "ClawResearch",
    subtitle: "project: test-project  backend: ollama:qwen  run: queued",
    brief: {
      topic: "autonomous research agents",
      researchQuestion: "How should they review literature?",
      researchDirection: "compare retrieval and synthesis architectures",
      successCriterion: "produce concrete design recommendations"
    },
    logs: [
      { tag: "consultant", text: "Hello, tell me what you want to research." },
      { tag: "you", text: "I want to study autonomous research agents." },
      { tag: "run", text: "Research run started." },
      { tag: "plan", text: "Plan the first literature pass." },
      { tag: "next", text: "Read the most relevant canonical papers next." }
    ],
    inputLabel: "Chat >",
    inputValue: "Focus on literature review workflows_",
    footerHint: "/help  /sources  /status  /go  /quit"
  });

  assert.match(output, /Chat ------------------------------------------------/);
  assert.match(output, /\[next\] Read the most relevant canonical papers next\./);
  assert.match(output, /Brief -----------------------------------------------/);
  assert.match(output, /topic: autonomous research agents/);
  assert.match(output, /Input -----------------------------------------------/);
  assert.match(output, /Chat > Focus on literature review workflows_/);
});

test("auth prompt frame stays focused on the credential question", () => {
  const output = renderAuthPromptFrame({
    width: 96,
    height: 20,
    title: "ClawResearch",
    subtitle: "project: /tmp/research-test  backend: ollama:qwen  auth setup",
    providerLabel: "pubmed",
    providerDescription: "Biomedical discovery through NCBI PubMed and E-utilities.",
    guidanceLines: authPromptGuidance("pubmed"),
    inputLabel: "pubmed env ref [optional; example NCBI_API_KEY]",
    inputValue: "NCBI_API_KEY_",
    footerHint: "Enter saves this provider, blank input leaves it unset"
  });

  assert.match(output, /Provider auth/);
  assert.match(output, /Provider: pubmed/);
  assert.match(output, /Without an NCBI API key, PubMed can still be queried/);
  assert.match(output, /Leave it blank to continue without it, or type the env-var name you want ClawResearch to use\./);
  assert.match(output, /Input/);
  assert.match(output, /pubmed env ref \[optional; example NCBI_API_KEY\]/);
  assert.doesNotMatch(output, /Chat --------------------------------/);
  assert.doesNotMatch(output, /Brief --------------------------------/);
});
