import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildReviewProtocol } from "../src/runtime/research-manuscript.js";

async function runtimeSourceFiles(directory = path.resolve("src/runtime")): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await runtimeSourceFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function runtimeSourceText(): Promise<string> {
  const files = await runtimeSourceFiles();
  const contents = await Promise.all(files.map(async (file) => {
    const text = await readFile(file, "utf8");
    return `\n// ${path.relative(process.cwd(), file)}\n${text}`;
  }));
  return contents.join("\n");
}

test("production runtime no longer imports or calls the old deterministic literature/facet manager", async () => {
  const sourceText = await runtimeSourceText();

  assert.doesNotMatch(sourceText, /from "\.\/literature-review\.js"/);
  assert.doesNotMatch(sourceText, /\bbuildReviewFacets\b/);
  assert.doesNotMatch(sourceText, /\bbuildLiteratureReviewProfile\b/);
  assert.doesNotMatch(sourceText, /\bshouldUseLiteratureReviewSubsystem\b/);
  assert.doesNotMatch(sourceText, /\bprotocolFacetsFor\b/);
  assert.doesNotMatch(sourceText, /\brequiredSuccessCriterionFacets\b/);
});

test("production runtime contains no protected domain phrase lists for semantic source logic", async () => {
  const sourceText = await runtimeSourceText();

  assert.doesNotMatch(sourceText, /\bnursing homes?\b/i);
  assert.doesNotMatch(sourceText, /\bRiemann zeta\b/i);
  assert.doesNotMatch(sourceText, /\bzeta zeros?\b/i);
  assert.doesNotMatch(sourceText, /\bautonomous research agents?\b/i);
  assert.doesNotMatch(sourceText, /\binterval arithmetic\b/i);
  assert.doesNotMatch(sourceText, /\bball arithmetic\b/i);
});

test("prompt wording does not create runtime-required facets in fallback protocol exports", () => {
  const protocol = buildReviewProtocol({
    run: {
      id: "run-test",
      brief: {
        topic: "model-selected topic",
        researchQuestion: "Which evidence should the researcher inspect?",
        researchDirection: "Let the researcher define scope and evidence through the workspace protocol.",
        successCriterion: "Write a complete publication-style paper with traceable citations, limitations, and a source matrix."
      }
    } as never,
    plan: {
      researchMode: "literature_synthesis",
      objective: "Review model-selected evidence.",
      rationale: "The model owns semantic scope.",
      searchQueries: ["model selected evidence"],
      localFocus: ["workspace protocol evidence"]
    },
    scholarlyDiscoveryProviders: ["openalex"],
    publisherFullTextProviders: [],
    oaRetrievalHelperProviders: [],
    generalWebProviders: [],
    localContextEnabled: true
  }) as Record<string, unknown>;

  assert.equal("requiredSuccessCriterionFacets" in protocol, false);
  assert.deepEqual(protocol.evidenceTargets, ["workspace protocol evidence", "Review model-selected evidence."]);
  assert.doesNotMatch(JSON.stringify(protocol.evidenceTargets), /publication-style|traceable citations|source matrix/i);
});
