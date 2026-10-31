import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { KillTreeOptions, ProcessController, ProcessInfo } from "./types";

function sameOrInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * POSIX implementation. Children are spawned detached so each one leads its own
 * process group; signalling the negated pid reaches every descendant, which is
 * the equivalent of `taskkill /T`.
 */
export class PosixProcessController implements ProcessController {
  async killTree(pid: number, options: KillTreeOptions = {}): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
    const signal: NodeJS.Signals = options.force ? "SIGKILL" : "SIGTERM";
    const signalGroup = (sig: NodeJS.Signals): boolean => {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        return false;
      }
    };
    const signalPid = (sig: NodeJS.Signals): boolean => {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    };

    if (!signalGroup(signal) && !signalPid(signal)) return;

    const timeoutMs = options.timeoutMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) {
        // The group may still hold members that outlived the leader.
        signalGroup("SIGKILL");
        return;
      }
      await sleep(100);
    }
    signalGroup("SIGKILL");
    signalPid("SIGKILL");
  }

  async listProcesses(filter: { commandLineIncludes?: string; executableInside?: string } = {}): Promise<ProcessInfo[]> {
    const entries = readdirSync("/proc").filter((name) => /^\d+$/u.test(name));
    const results: ProcessInfo[] = [];
    for (const entry of entries) {
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
      let commandLine = "";
      try {
        commandLine = readFileSync(join("/proc", entry, "cmdline"), "utf8").replace(/\0/gu, " ").trim();
      } catch {
        continue;
      }
      if (!commandLine) continue;
      let executablePath: string | undefined;
      try {
        executablePath = readlinkSync(join("/proc", entry, "exe"));
      } catch {
        executablePath = undefined;
      }
      if (filter.commandLineIncludes && !commandLine.includes(filter.commandLineIncludes)) continue;
      if (filter.executableInside && (!executablePath || !sameOrInside(filter.executableInside, executablePath))) continue;
      results.push({ pid, commandLine, executablePath });
    }
    return results;
  }

  async waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await sleep(100);
    }
    return !isAlive(pid);
  }
}

/** Windows implementation; keeps the existing taskkill / PowerShell behaviour. */
export class WindowsProcessController implements ProcessController {
  async killTree(pid: number, options: KillTreeOptions = {}): Promise<void> {
    const args = options.force === false ? ["/T", "/PID", String(pid)] : ["/F", "/T", "/PID", String(pid)];
    await new Promise<void>((done, fail) => {
      const child = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
      child.once("error", fail);
      child.once("exit", (code) => {
        if (code === 0) {
          done();
          return;
        }
        fail(new Error(`taskkill exited with code ${code ?? "unknown"}`));
      });
    });
  }

  async listProcesses(filter: { commandLineIncludes?: string; executableInside?: string } = {}): Promise<ProcessInfo[]> {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Get-CimInstance Win32_Process |",
      "Select-Object ProcessId,ExecutablePath,CommandLine |",
      "ConvertTo-Json -Compress -Depth 2",
    ].join(" ");
    const output = await new Promise<string>((done, fail) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
      });
      child.once("error", fail);
      child.once("exit", (code) => {
        if (code === 0) done(buffer);
        else fail(new Error(`powershell exited with code ${code ?? "unknown"}`));
      });
    });
    if (!output.trim()) return [];
    const parsed = JSON.parse(output) as
      | { ProcessId?: number; ExecutablePath?: string; CommandLine?: string }
      | { ProcessId?: number; ExecutablePath?: string; CommandLine?: string }[];
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter((item) => typeof item.ProcessId === "number" && item.ProcessId > 0 && item.ProcessId !== process.pid)
      .filter((item) => {
        if (filter.commandLineIncludes && !(item.CommandLine ?? "").includes(filter.commandLineIncludes)) return false;
        if (filter.executableInside) {
          const executable = item.ExecutablePath ?? "";
          if (!executable || !sameOrInside(filter.executableInside, executable)) return false;
        }
        return true;
      })
      .map((item) => ({
        pid: item.ProcessId as number,
        commandLine: item.CommandLine,
        executablePath: item.ExecutablePath,
      }));
  }

  async waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await sleep(100);
    }
    return !isAlive(pid);
  }
}

export function createProcessController(platform: NodeJS.Platform = process.platform): ProcessController {
  return platform === "win32" ? new WindowsProcessController() : new PosixProcessController();
}
