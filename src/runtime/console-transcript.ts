import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runtimeDirectoryPath } from "./session-store.js";

export function consoleTranscriptPath(projectRoot: string): string {
  return path.join(runtimeDirectoryPath(projectRoot), "console-transcript.log");
}

export class ConsoleTranscript {
  readonly filePath: string;

  constructor(projectRoot: string) {
    const runtimeDirectory = runtimeDirectoryPath(projectRoot);
    mkdirSync(runtimeDirectory, { recursive: true });
    this.filePath = consoleTranscriptPath(projectRoot);
  }

  appendOutput(chunk: string): void {
    appendFileSync(this.filePath, chunk, "utf8");
  }

  appendInput(promptText: string, input: string): void {
    appendFileSync(this.filePath, `${promptText}${input}\n`, "utf8");
  }
}
