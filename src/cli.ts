#!/usr/bin/env node

import { access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import { version } from "./index.js";
import {
  type ConsoleIo,
  type OutputWriter,
  runPhaseOneConsole
} from "./runtime/console-app.js";
import type { IntakeBackend } from "./runtime/intake-backend.js";
import { runDetachedJobWorker } from "./runtime/run-worker.js";

function writeLine(writer: OutputWriter, line = ""): void {
  writer.write(`${line}\n`);
}

async function findPackageRoot(startDirectory: string): Promise<string> {
  let currentDirectory = startDirectory;

  while (true) {
    const packageJsonPath = path.join(currentDirectory, "package.json");

    try {
      await access(packageJsonPath, fsConstants.F_OK);
      return currentDirectory;
    } catch {
      const parentDirectory = path.dirname(currentDirectory);

      if (parentDirectory === currentDirectory) {
        return startDirectory;
      }

      currentDirectory = parentDirectory;
    }
  }
}

async function resolveDocs(packageRoot: string): Promise<{ resetDoc: string; literatureDoc: string }> {
  return {
    resetDoc: path.join(packageRoot, "docs", "reset-development-concept.md"),
    literatureDoc: path.join(packageRoot, "docs", "autonomous-research-agent-literature-synthesis.md")
  };
}

function renderDocs(writer: OutputWriter, packageRoot: string, resetDoc: string, literatureDoc: string): void {
  writeLine(writer, "ClawResearch reset documents:");
  writeLine(writer, `1. ${path.relative(packageRoot, resetDoc) || resetDoc}`);
  writeLine(writer, `2. ${path.relative(packageRoot, literatureDoc) || literatureDoc}`);
  writeLine(writer);
  writeLine(writer, "Read those first, then run `clawresearch` in the project directory you want to research.");
}

function renderHelp(writer: OutputWriter): void {
  writeLine(writer, "Usage:");
  writeLine(writer, "  clawresearch");
  writeLine(writer, "  clawresearch --docs");
  writeLine(writer, "  clawresearch --version");
  writeLine(writer, "  clawresearch --help");
  writeLine(writer);
  writeLine(writer, "Default behavior:");
  writeLine(writer, "  Starts the interactive research chat in the current directory, launches detached runs from `/go`, and streams their saved progress events in the terminal.");
  writeLine(writer);
  writeLine(writer, "Slash commands inside the console:");
  writeLine(writer, "  /help");
  writeLine(writer, "  /status");
  writeLine(writer, "  /go");
  writeLine(writer, "  /pause");
  writeLine(writer, "  /resume");
  writeLine(writer, "  /quit");
  writeLine(writer, "  /exit");
}

function readOptionValue(argv: string[], optionName: string): string | null {
  const index = argv.indexOf(optionName);

  if (index === -1) {
    return null;
  }

  return argv[index + 1] ?? null;
}

function createConsoleIo(input = process.stdin, output = process.stdout): ConsoleIo {
  const rl = readline.createInterface({
    input,
    output,
    terminal: true
  });

  return {
    writer: output,
    async prompt(promptText: string): Promise<string | null> {
      try {
        return await rl.question(promptText);
      } catch {
        return null;
      }
    },
    close(): void {
      rl.close();
    }
  };
}

type MainOptions = {
  io?: ConsoleIo;
  writer?: OutputWriter;
  projectRoot?: string;
  intakeBackend?: IntakeBackend;
};

export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const args = new Set(argv);
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = await findPackageRoot(moduleDirectory);
  const docs = await resolveDocs(packageRoot);
  const writer = options.writer ?? process.stdout;
  const runId = readOptionValue(argv, "--run-job");
  const detachedProjectRoot = readOptionValue(argv, "--project-root");

  if (runId !== null) {
    return runDetachedJobWorker({
      projectRoot: detachedProjectRoot ?? process.cwd(),
      runId,
      version
    });
  }

  if (args.has("--version")) {
    writeLine(writer, version);
    return 0;
  }

  if (args.has("--docs")) {
    renderDocs(writer, packageRoot, docs.resetDoc, docs.literatureDoc);
    return 0;
  }

  if (args.has("--help") || args.has("-h")) {
    renderHelp(writer);
    return 0;
  }

  const io = options.io ?? createConsoleIo();

  return runPhaseOneConsole(io, {
    projectRoot: options.projectRoot ?? process.cwd(),
    version,
    intakeBackend: options.intakeBackend
  });
}

function isInvokedAsScript(argvPath: string | undefined): boolean {
  if (argvPath === undefined) {
    return false;
  }

  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(argvPath) === fileURLToPath(import.meta.url);
  }
}

const invokedAsScript = isInvokedAsScript(process.argv[1]);

if (invokedAsScript) {
  process.exitCode = await main(process.argv.slice(2));
}
