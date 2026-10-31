/**
 * Platform abstraction contracts.
 *
 * Everything the service layer needs that differs between Windows, macOS and
 * Linux lives behind one of these interfaces. The Electron main process and the
 * headless CLI both build the same service objects; only the implementations
 * injected here differ.
 */

export interface ProcessInfo {
  pid: number;
  /** Absolute path of the executable, when the platform exposes it. */
  executablePath?: string;
  commandLine?: string;
}

export interface KillTreeOptions {
  /** Send SIGKILL / taskkill /F instead of asking the process to exit. */
  force?: boolean;
  /** Milliseconds to wait for the process group to disappear. */
  timeoutMs?: number;
}

export interface ProcessController {
  /**
   * Terminate a process and every descendant. On POSIX the child is expected to
   * have been spawned as a process-group leader (detached: true), so the group
   * is signalled as a unit and grandchildren cannot outlive the parent.
   */
  killTree(pid: number, options?: KillTreeOptions): Promise<void>;
  /** Enumerate processes, optionally filtered by command line or executable path. */
  listProcesses(filter?: { commandLineIncludes?: string; executableInside?: string }): Promise<ProcessInfo[]>;
  /** Resolve when the process is gone, or reject after timeoutMs. */
  waitForExit(pid: number, timeoutMs?: number): Promise<boolean>;
}

export type SessionExitListener = (event: { code: number | null; signal: string | number | null }) => void;

export interface SessionTransport {
  readonly pid: number | undefined;
  onData(listener: (chunk: string | Buffer) => void): () => void;
  onExit(listener: SessionExitListener): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Ask the process to stop; escalation to kill is the caller's policy. */
  stop(): void;
  kill(): void;
  clear(): void;
  dispose(): void;
}

export interface SessionTransportSpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface SessionTransportFactory {
  /** A human-readable name used in logs, e.g. "pipe" or "pty". */
  readonly kind: string;
  spawn(options: SessionTransportSpawnOptions): SessionTransport;
}

export interface ProxyApplier {
  /** False before the host is able to accept proxy configuration. */
  isReady(): boolean;
  apply(settings: { enabled: boolean; proxyRules: string; bypassRules: string }): Promise<void>;
  /** Optional host-level fetch delegate used to honour the proxy for our own HTTP calls. */
  fetch?(input: string, init?: RequestInit): Promise<Response>;
}

export interface DecodedImage {
  isEmpty(): boolean;
  toDataUrl(): string;
  /** Opaque handle the host can hand to its native image APIs. */
  readonly native?: unknown;
}

export interface ImageDecoder {
  fromPath(path: string): DecodedImage;
}
