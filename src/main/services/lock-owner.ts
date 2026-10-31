import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A PID alone is not an identity: any platform can reuse it after a crash or reboot.
export function isLockOwnerAlive(owner: { pid?: number; startedAt?: number } | undefined): boolean {
  const pid = owner?.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!Number.isFinite(owner?.startedAt)) return true;
  const processStartedAt = readProcessStartedAt(pid);
  if (processStartedAt !== undefined && processStartedAt > owner!.startedAt!) return false;
  return true;
}

/**
 * Process start time in Unix milliseconds, used to detect PID reuse.
 * Returns undefined when the platform cannot provide it; callers then keep the lock.
 */
function readProcessStartedAt(pid: number): number | undefined {
  if (process.platform === "win32") {
    try {
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`],
      { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const value = Number(result.trim());
      return Number.isFinite(value) ? value : undefined;
    } catch {
      // Access denied or unavailable process metadata must not steal a live lock.
      return undefined;
    }
  }

  if (process.platform === "linux") {
    // /proc/<pid>/stat field 22 is the start time in clock ticks since boot.
    // The comm field can contain spaces, so split from the last ')'.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[19]);
      const bootMs = readBootTimeMs();
      const hz = 100;
      if (Number.isFinite(ticks) && bootMs !== undefined) return bootMs + (ticks / hz) * 1000;
    } catch {
      return undefined;
    }
    return undefined;
  }

  if (process.platform === "darwin") {
    try {
      const result = execFileSync("ps", ["-o", "lstart= ", "-p", String(pid)],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const parsed = Date.parse(result.trim());
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function readBootTimeMs(): number | undefined {
  try {
    const line = readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((candidate) => candidate.startsWith("btime "));
    const seconds = Number(line?.split(/\s+/u)[1]);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}
