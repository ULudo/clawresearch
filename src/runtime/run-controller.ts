import { spawn } from "node:child_process";
import type { RunRecord } from "./run-store.js";

export interface RunController {
  launchCommand(run: RunRecord): string[];
  launch(run: RunRecord): Promise<number>;
  pause(workerPid: number): Promise<void>;
  resume(workerPid: number): Promise<void>;
  isProcessAlive(workerPid: number): boolean;
}

type NodeRunControllerOptions = {
  execPath?: string;
  execArgv?: string[];
  scriptPath?: string;
};

function requireScriptPath(scriptPath: string | undefined): string {
  if (scriptPath === undefined || scriptPath.trim().length === 0) {
    throw new Error("Could not determine the current CLI entrypoint for detached run launch.");
  }

  return scriptPath;
}

export class NodeRunController implements RunController {
  private readonly execPath: string;
  private readonly execArgv: string[];
  private readonly scriptPath: string;

  constructor(options: NodeRunControllerOptions = {}) {
    this.execPath = options.execPath ?? process.execPath;
    this.execArgv = options.execArgv ?? process.execArgv;
    this.scriptPath = requireScriptPath(options.scriptPath ?? process.argv[1]);
  }

  launchCommand(run: RunRecord): string[] {
    return [
      this.execPath,
      ...this.execArgv,
      this.scriptPath,
      "--run-job",
      run.id,
      "--project-root",
      run.projectRoot
    ];
  }

  async launch(run: RunRecord): Promise<number> {
    const [command, ...args] = this.launchCommand(run);
    if (command === undefined) {
      throw new Error("Detached run launch command is empty.");
    }

    const child = spawn(
      command,
      args,
      {
        cwd: run.projectRoot,
        env: process.env,
        detached: true,
        stdio: "ignore"
      }
    );

    child.unref();

    if (child.pid === undefined) {
      throw new Error("Detached run worker did not report a process id.");
    }

    return child.pid;
  }

  async pause(workerPid: number): Promise<void> {
    process.kill(-workerPid, "SIGSTOP");
  }

  async resume(workerPid: number): Promise<void> {
    process.kill(-workerPid, "SIGCONT");
  }

  isProcessAlive(workerPid: number): boolean {
    try {
      process.kill(workerPid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export function createDefaultRunController(): RunController {
  return new NodeRunController();
}
