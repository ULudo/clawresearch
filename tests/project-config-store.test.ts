import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultRuntimeLlmConfig,
  defaultRuntimeModelConfig,
  ProjectConfigStore,
  projectConfigPath,
  resolveRuntimeLlmConfig
} from "../src/runtime/project-config-store.js";

function createNow(): () => string {
  let step = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
    step += 1;
    return timestamp;
  };
}

test("project config store loads the current grouped source model and drops invalid selections", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-project-config-current-"));
  const now = createNow();

  try {
    await mkdir(path.dirname(projectConfigPath(projectRoot)), { recursive: true });
    await writeFile(projectConfigPath(projectRoot), `${JSON.stringify({
      schemaVersion: 8,
      projectRoot,
      runtimeDirectory: `${projectRoot}/.clawresearch`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sources: {
        scholarlyDiscovery: {
          selectedProviderIds: ["openalex", "elsevier", "bogus-provider", "openalex"]
        },
        publisherFullText: {
          selectedProviderIds: ["arxiv", "springer_nature", "openalex"]
        },
        oaRetrievalHelpers: {
          selectedProviderIds: ["core", "unpaywall", "elsevier"]
        },
        generalWeb: {
          selectedProviderIds: ["wikipedia", "openalex"]
        },
        localContext: {
          projectFilesEnabled: false
        },
        explicitlyConfigured: true
      },
      runtime: {
        llm: {
          ...defaultRuntimeLlmConfig,
          extractionInitialBatchSize: 4
        }
      }
    }, null, 2)}\n`, "utf8");

    const store = new ProjectConfigStore(projectRoot, now);
    const config = await store.load();

    assert.equal(config.schemaVersion, 8);
    assert.deepEqual(config.sources.scholarlyDiscovery.selectedProviderIds, ["openalex", "elsevier"]);
    assert.deepEqual(config.sources.publisherFullText.selectedProviderIds, ["arxiv", "springer_nature"]);
    assert.deepEqual(config.sources.oaRetrievalHelpers.selectedProviderIds, ["core", "unpaywall"]);
    assert.deepEqual(config.sources.generalWeb.selectedProviderIds, ["wikipedia"]);
    assert.equal(config.sources.localContext.projectFilesEnabled, false);
    assert.equal(config.sources.explicitlyConfigured, true);
    assert.equal(config.runtime.llm.extractionInitialBatchSize, 4);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("project config store saves only providers that belong to each category", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-project-config-save-"));
  const now = createNow();

  try {
    const store = new ProjectConfigStore(projectRoot, now);
    const config = await store.save({
      schemaVersion: 8,
      projectRoot,
      runtimeDirectory: `${projectRoot}/.clawresearch`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sources: {
        scholarlyDiscovery: {
          selectedProviderIds: ["openalex", "arxiv", "elsevier"]
        },
        publisherFullText: {
          selectedProviderIds: ["arxiv", "openalex", "springer_nature"]
        },
        oaRetrievalHelpers: {
          selectedProviderIds: ["core", "unpaywall", "wikipedia"]
        },
        generalWeb: {
          selectedProviderIds: ["wikipedia", "openalex"]
        },
        localContext: {
          projectFilesEnabled: true
        },
        explicitlyConfigured: true
      },
      runtime: {
        model: {
          ...defaultRuntimeModelConfig,
          configured: true
        },
        llm: {
          ...defaultRuntimeLlmConfig,
          planningTimeoutMs: 123_000
        }
      }
    });

    assert.equal(config.schemaVersion, 8);
    assert.deepEqual(config.sources.scholarlyDiscovery.selectedProviderIds, ["openalex", "elsevier"]);
    assert.deepEqual(config.sources.publisherFullText.selectedProviderIds, ["arxiv", "springer_nature"]);
    assert.deepEqual(config.sources.oaRetrievalHelpers.selectedProviderIds, ["core", "unpaywall"]);
    assert.deepEqual(config.sources.generalWeb.selectedProviderIds, ["wikipedia"]);
    assert.equal(config.runtime.llm.planningTimeoutMs, 123_000);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runtime llm config resolves env overrides over project defaults", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "clawresearch-project-config-llm-"));
  const now = createNow();

  try {
    const store = new ProjectConfigStore(projectRoot, now);
    const config = await store.load();
    config.runtime.llm.planningTimeoutMs = 111_000;
    config.runtime.llm.extractionInitialBatchSize = 6;
    config.runtime.llm.extractionMinBatchSize = 2;

    const resolved = resolveRuntimeLlmConfig(config, {
      CLAWRESEARCH_LLM_TIMEOUT_MS: "222000",
      CLAWRESEARCH_LLM_CRITIC_TIMEOUT_MS: "444000",
      CLAWRESEARCH_LLM_EXTRACTION_BATCH_SIZE: "5",
      CLAWRESEARCH_LLM_EXTRACTION_MIN_BATCH_SIZE: "3",
      CLAWRESEARCH_LLM_EXTRACTION_RETRY_BUDGET: "9",
      CLAWRESEARCH_LLM_AGENT_STEP_TIMEOUT_MS: "555000",
      CLAWRESEARCH_AGENT_CONTROL_MODE: "native_tool_calls",
      CLAWRESEARCH_AGENT_INVALID_ACTION_BUDGET: "3",
      CLAWRESEARCH_EVIDENCE_REVISION_MAX_PASSES: "4"
    });

    assert.equal(resolved.planningTimeoutMs, 222_000);
    assert.equal(resolved.extractionTimeoutMs, 222_000);
    assert.equal(resolved.criticTimeoutMs, 444_000);
    assert.equal(resolved.extractionInitialBatchSize, 5);
    assert.equal(resolved.extractionMinBatchSize, 3);
    assert.equal(resolved.extractionRetryBudget, 9);
    assert.equal(resolved.agentStepTimeoutMs, 555_000);
    assert.equal(resolved.agentControlMode, "native_tool_calls");
    assert.equal(resolved.agentInvalidActionBudget, 3);
    assert.equal(resolved.evidenceRecoveryMaxPasses, 4);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
