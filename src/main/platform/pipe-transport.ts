import { spawn, type ChildProcess } from "node:child_process";
import type {
  SessionExitListener,
  SessionTransport,
  SessionTransportFactory,
  SessionTransportSpawnOptions,
} from "./types";

/**
 * Pipes-based transport used when no TTY is needed. This is the headless
 * default: it has no native build step, works on every platform, and gives the
 * supervisor the exact same event surface the PTY transport provides.
 *
 * The child is spawned detached so it becomes a process-group leader. Stopping
 * the session signals the whole group, which is what keeps grandchildren
 * (pip's build subprocesses, node workers) from surviving a stop.
 */
const CLOSE_GRACE_MS = 800;

export class PipeSessionTransport implements SessionTransport {
  private readonly child: ChildProcess;
  private readonly dataListeners = new Set<(chunk: string | Buffer) => void>();
  private readonly exitListeners = new Set<SessionExitListener>();
  private groupReapTimer: NodeJS.Timeout | null = null;
  private exited = false;

  constructor(options: SessionTransportSpawnOptions) {
    this.child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const forward = (chunk: Buffer): void => {
      for (const listener of this.dataListeners) listener(chunk);
    };
    this.child.stdout?.on("data", forward);
    this.child.stderr?.on("data", forward);
    this.child.on("error", (error) => {
      const message = `[transport] ${error.message}\n`;
      for (const listener of this.dataListeners) listener(message);
    });
    this.child.on("exit", (code, signal) => {
      // `exit` fires the moment the direct child dies. `close` additionally
      // waits for the stdio pipes — which descendants inherit — so a service
      // whose runner was SIGKILLed would otherwise stay invisible to the
      // supervisor forever. Detect that case, reap the group, and report.
      if (this.exited) return;
      this.exited = true;
      // signalGroup() refuses once exited; the reap must not.
      this.groupReapTimer = setTimeout(() => this.signalGroupRaw("SIGKILL"), CLOSE_GRACE_MS);
      for (const listener of this.exitListeners) listener({ code, signal: signal ?? null });
    });
    this.child.on("close", (code, signal) => {
      if (this.groupReapTimer) {
        clearTimeout(this.groupReapTimer);
        this.groupReapTimer = null;
      }
      if (this.exited) return;
      this.exited = true;
      for (const listener of this.exitListeners) listener({ code, signal });
    });
    // A child that exits without us reading can otherwise raise EPIPE.
    this.child.stdin?.on("error", () => undefined);
    this.child.stdout?.on("error", () => undefined);
    this.child.stderr?.on("error", () => undefined);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onData(listener: (chunk: string | Buffer) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: SessionExitListener): () => void {
    this.exitListeners.add(listener);
    if (this.exited) listener({ code: null, signal: null });
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    if (this.exited || !this.child.stdin?.writable) return;
    this.child.stdin.write(data);
  }

  resize(): void {
    // Pipes have no geometry.
  }

  clear(): void {
    // No screen buffer to clear; the session's output history owns that.
  }

  stop(): void {
    this.signalGroup("SIGINT");
  }

  kill(): void {
    this.signalGroup("SIGKILL");
  }

  dispose(): void {
    if (this.groupReapTimer) {
      clearTimeout(this.groupReapTimer);
      this.groupReapTimer = null;
    }
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  private signalGroup(signal: NodeJS.Signals): void {
    if (this.exited) return;
    this.signalGroupRaw(signal);
  }

  /** Signal regardless of the exited flag — used by the orphan-group reap. */
  private signalGroupRaw(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }
}

export const pipeSessionTransportFactory: SessionTransportFactory = {
  kind: "pipe",
  spawn: (options) => new PipeSessionTransport(options),
};
