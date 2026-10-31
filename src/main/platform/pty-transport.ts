import { existsSync, statSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  SessionExitListener,
  SessionTransport,
  SessionTransportFactory,
  SessionTransportSpawnOptions,
} from "./types";

const require = createRequire(import.meta.url);

function toUnpackedAsarPath(path: string): string {
  return path.replace("app.asar", "app.asar.unpacked").replace("node_modules.asar", "node_modules.asar.unpacked");
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  let packagePath: string;
  try {
    packagePath = require.resolve("node-pty/package.json");
  } catch {
    return;
  }
  const helperPath = toUnpackedAsarPath(
    join(dirname(packagePath), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  );
  if (!existsSync(helperPath)) return;
  const stat = statSync(helperPath);
  if ((stat.mode & 0o111) === 0) {
    chmodSync(helperPath, stat.mode | 0o755);
  }
}

interface NodePtyProcess {
  pid: number;
  onData(listener: (data: string | Buffer) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  clear(): void;
  kill(signal?: string): void;
}

/**
 * TTY-backed transport. `node-pty` is required lazily so a headless install
 * that never opens an interactive terminal does not need the native addon.
 */
export class PtySessionTransport implements SessionTransport {
  private readonly process: NodePtyProcess;
  private readonly dataListeners = new Set<(chunk: string | Buffer) => void>();
  private readonly exitListeners = new Set<SessionExitListener>();
  private exited = false;

  constructor(options: SessionTransportSpawnOptions, encoding: string | null = "utf8") {
    ensureNodePtySpawnHelperExecutable();
    const nodePty = require("node-pty") as {
      spawn: (file: string, args: string[], options: Record<string, unknown>) => NodePtyProcess;
    };
    this.process = nodePty.spawn(options.file, options.args, {
      name: "xterm-256color",
      cols: options.cols ?? 100,
      rows: options.rows ?? 32,
      cwd: options.cwd,
      env: options.env,
      encoding,
      handleFlowControl: true,
      useConpty: true,
    });
    this.process.onData((data) => {
      for (const listener of this.dataListeners) listener(data);
    });
    this.process.onExit(({ exitCode, signal }) => {
      this.exited = true;
      for (const listener of this.exitListeners) {
        listener({ code: exitCode, signal: signal ?? null });
      }
    });
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  onData(listener: (chunk: string | Buffer) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: SessionExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    if (this.exited) return;
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.process.resize(cols, rows);
  }

  clear(): void {
    if (this.exited) return;
    this.process.clear();
  }

  stop(): void {
    this.write("\x03");
  }

  kill(): void {
    if (this.exited) return;
    this.process.kill();
  }

  dispose(): void {
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

export const ptySessionTransportFactory: SessionTransportFactory = {
  kind: "pty",
  spawn: (options) => new PtySessionTransport(options),
};
