import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProjectConfigStore,
  projectConfigPath
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
      schemaVersion: 6,
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
        postReviewBehavior: "confirm"
      }
    }, null, 2)}\n`, "utf8");

    const store = new ProjectConfigStore(projectRoot, now);
    const config = await store.load();

    assert.equal(config.schemaVersion, 6);
    assert.deepEqual(config.sources.scholarlyDiscovery.selectedProviderIds, ["openalex", "elsevier"]);
    assert.deepEqual(config.sources.publisherFullText.selectedProviderIds, ["arxiv", "springer_nature"]);
    assert.deepEqual(config.sources.oaRetrievalHelpers.selectedProviderIds, ["core", "unpaywall"]);
    assert.deepEqual(config.sources.generalWeb.selectedProviderIds, ["wikipedia"]);
    assert.equal(config.sources.localContext.projectFilesEnabled, false);
    assert.equal(config.sources.explicitlyConfigured, true);
    assert.equal(config.runtime.postReviewBehavior, "confirm");
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
      schemaVersion: 6,
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
        postReviewBehavior: "auto_continue"
      }
    });

    assert.equal(config.schemaVersion, 6);
    assert.deepEqual(config.sources.scholarlyDiscovery.selectedProviderIds, ["openalex", "elsevier"]);
    assert.deepEqual(config.sources.publisherFullText.selectedProviderIds, ["arxiv", "springer_nature"]);
    assert.deepEqual(config.sources.oaRetrievalHelpers.selectedProviderIds, ["core", "unpaywall"]);
    assert.deepEqual(config.sources.generalWeb.selectedProviderIds, ["wikipedia"]);
    assert.equal(config.runtime.postReviewBehavior, "auto_continue");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
