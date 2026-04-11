#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { version } from "./index.js";

type Writer = {
  write: (chunk: string) => void;
};

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resetDoc = path.join(runtimeRoot, "docs", "reset-development-concept.md");
const literatureDoc = path.join(runtimeRoot, "docs", "autonomous-research-agent-literature-synthesis.md");

function displayPath(absolutePath: string): string {
  return path.relative(runtimeRoot, absolutePath) || ".";
}

function writeLine(writer: Writer, line = ""): void {
  writer.write(`${line}\n`);
}

function renderIntro(writer: Writer): void {
  writeLine(writer, "ClawResearch Reset");
  writeLine(writer, "==================");
  writeLine(writer, "ClawResearch has been reset to a minimal TypeScript scaffold.");
  writeLine(writer, "The old prototype was removed so the next implementation can start clean.");
}

function renderDocs(writer: Writer): void {
  writeLine(writer);
  writeLine(writer, "Start with these files:");
  writeLine(writer, `1. ${displayPath(resetDoc)}`);
  writeLine(writer, `2. ${displayPath(literatureDoc)}`);
  writeLine(writer, "3. Implement the new runtime from the console inward.");
}

function renderHelp(writer: Writer): void {
  writeLine(writer);
  writeLine(writer, "Usage:");
  writeLine(writer, "  clawresearch [--docs] [--version] [--help]");
}

export function main(argv: string[], writer: Writer = process.stdout): number {
  const args = new Set(argv);

  if (args.has("--version")) {
    writeLine(writer, version);
    return 0;
  }

  renderIntro(writer);

  if (args.has("--docs")) {
    renderDocs(writer);
    return 0;
  }

  if (args.has("--help") || args.has("-h")) {
    renderHelp(writer);
    return 0;
  }

  writeLine(writer);
  writeLine(writer, "Run clawresearch --docs to see the reset implementation contract.");
  return 0;
}

const invokedAsScript = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  process.exitCode = main(process.argv.slice(2));
}
