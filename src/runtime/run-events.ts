import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type RunEventKind =
  | "run"
  | "plan"
  | "literature"
  | "summary"
  | "memory"
  | "verify"
  | "next"
  | "source"
  | "claim"
  | "exec"
  | "stdout"
  | "stderr";

export type RunEventRecord = {
  timestamp: string;
  kind: RunEventKind;
  message: string;
};

export async function appendRunEvent(
  eventsPath: string,
  event: RunEventRecord
): Promise<void> {
  await mkdir(path.dirname(eventsPath), { recursive: true });
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

export async function readRunEventChunk(
  eventsPath: string,
  offset: number
): Promise<{ content: string; nextOffset: number }> {
  try {
    const contents = await readFile(eventsPath, "utf8");
    const nextOffset = contents.length;
    const content = contents.slice(offset);

    return {
      content,
      nextOffset
    };
  } catch (error) {
    const missingFile = error instanceof Error && "code" in error && error.code === "ENOENT";

    if (missingFile) {
      return {
        content: "",
        nextOffset: offset
      };
    }

    throw error;
  }
}

export function parseRunEventLines(
  chunk: string,
  trailingBuffer = ""
): { events: RunEventRecord[]; trailingBuffer: string } {
  const combined = `${trailingBuffer}${chunk}`;
  const lines = combined.split("\n");
  const nextTrailingBuffer = lines.pop() ?? "";
  const events: RunEventRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    try {
      const raw = JSON.parse(trimmed) as Partial<RunEventRecord>;

      if (
        typeof raw.timestamp === "string"
        && typeof raw.message === "string"
        && typeof raw.kind === "string"
      ) {
        events.push({
          timestamp: raw.timestamp,
          kind: raw.kind as RunEventKind,
          message: raw.message
        });
      }
    } catch {
      continue;
    }
  }

  return {
    events,
    trailingBuffer: nextTrailingBuffer
  };
}
