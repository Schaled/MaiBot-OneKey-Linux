import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");
export const SCRATCH_ROOT = process.env.MAIBOT_SMOKE_SCRATCH
  ? resolve(process.env.MAIBOT_SMOKE_SCRATCH)
  : mkdtempSync(join(tmpdir(), "maibot-smoke-"));

export interface SmokeInstance {
  root: string;
  payloadRoot: string;
}

export function createSmokeInstance(name: string): SmokeInstance {
  const root = join(SCRATCH_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return { root, payloadRoot: REPO_ROOT };
}

/**
 * Hermetic XDG environment: the suite must not share agreement stores, payload
 * caches or sockets with a real install, and tests must not poison each other.
 */
export function smokeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_CONFIG_HOME: join(SCRATCH_ROOT, "xdg-config"),
    XDG_DATA_HOME: join(SCRATCH_ROOT, "xdg-data"),
    XDG_RUNTIME_DIR: join(SCRATCH_ROOT, "xdg-runtime"),
    MAIBOT_ONEKEY_SMOKE: "1",
  };
}

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number;
}

export function runCli(args: string[], instance?: SmokeInstance, timeoutMs = 120_000): CliResult {
  const full = [join(REPO_ROOT, "src/cli/main.ts"), ...args];
  if (instance) {
    full.push("--root", instance.root, "--payload", instance.payloadRoot);
  }
  const result = spawnSync(process.execPath, full, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    env: smokeEnv(),
  });
  // Bun's spawnSync reports the real code in `status`; `exitCode` stays undefined
  // for children that call process.exit().
  const code = result.status ?? result.exitCode ?? -1;
  return {
    ok: code === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: code,
  };
}

/** Run a CLI command, retrying transient network failures. */
export function runCliWithRetry(args: string[], instance: SmokeInstance, attempts = 3, timeoutMs = 300_000): CliResult {
  let last: CliResult | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = runCli(args, instance, timeoutMs);
    if (last.ok) return last;
    // Only download-style commands benefit from a retry; fail fast on usage errors.
    if (last.status === 2) return last;
  }
  return last as CliResult;
}

/** Parse the final JSON value out of mixed stdout (progress lines, then pretty JSON). */
export function extractLastJson(text: string): unknown {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] !== "{") continue;
    try {
      return JSON.parse(text.slice(index).trim());
    } catch {
      // Keep scanning backwards for the real start of the JSON document.
    }
  }
  throw new Error(`输出中没有 JSON：${text.slice(0, 400)}`);
}

const supervisors = new Map<string, ChildProcess>();

/** Start `serve` in the background and wait until the control socket answers. */
export async function startSupervisor(instance: SmokeInstance, timeoutMs = 20_000): Promise<ChildProcess> {
  const existing = supervisors.get(instance.root);
  if (existing && !existing.killed) return existing;
  const serveLog = join(SCRATCH_ROOT, "serve-debug.log");
  const child = spawn(process.execPath, [join(REPO_ROOT, "src/cli/main.ts"), "serve", "--root", instance.root, "--payload", instance.payloadRoot], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: smokeEnv(),
  });
  const tee = (chunk: unknown): void => {
    appendFileSync(serveLog, String(chunk));
  };
  child.stdout?.on("data", tee);
  child.stderr?.on("data", tee);
  supervisors.set(instance.root, child);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = runCli(["status", "--json"], instance, 5_000);
    if (probe.ok) return child;
    await new Promise((done) => setTimeout(done, 400));
  }
  throw new Error(`supervisor 未就绪: ${instance.root}\n${child.stdout.read()?.toString() ?? ""}${child.stderr.read()?.toString() ?? ""}`);
}

export async function stopSupervisor(instance: SmokeInstance): Promise<void> {
  const child = supervisors.get(instance.root);
  supervisors.delete(instance.root);
  runCli(["shutdown"], instance, 30_000);
  if (child && !child.killed) {
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 8_000);
    });
  }
}

export function cleanupScratch(): void {
  if (!process.env.MAIBOT_SMOKE_KEEP) {
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  }
}

export function waitForHttp(url: string, timeoutMs = 60_000, expected = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const attempt = async (): Promise<boolean> => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      return response.status === expected;
    } catch {
      return false;
    }
  };
  return (async () => {
    while (Date.now() < deadline) {
      if (await attempt()) return true;
      await new Promise((done) => setTimeout(done, 700));
    }
    return false;
  })();
}

export function deploymentState(instance: SmokeInstance): { generation: string; packageVersion: string } | undefined {
  const file = join(instance.root, "modules", "MaiBot", ".onekey-deployment.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The per-install log directory for an instance (XDG scope of the payload root). */
export function userDataLogsDir(instance: SmokeInstance): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const scope = createHash("sha256").update(instance.payloadRoot).digest("hex").slice(0, 12);
  const configHome = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.startsWith("/")
    ? process.env.XDG_CONFIG_HOME
    : join(process.env.HOME ?? "", ".config");
  return join(configHome, "MaiBotOneKeyDesktop", scope, "logs");
}
