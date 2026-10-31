import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** SnowLuma requires node ^24.22.1 || >=26.12.1; the payload ships a pinned 24.x. */
export const MINIMUM_NODE_VERSION = [24, 22, 1] as const;

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function satisfiesMinimum(version: [number, number, number]): boolean {
  const [major, minor, patch] = version;
  const [minMajor, minMinor, minPatch] = MINIMUM_NODE_VERSION;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

function versionOf(executable: string): [number, number, number] | undefined {
  try {
    return parseVersion(
      execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }),
    );
  } catch {
    return undefined;
  }
}

/**
 * Node runtime for protocol backends. The bundled payload wins; otherwise fall
 * back to a system node that satisfies the minimum version.
 */
export function resolveNodeRuntime(runtimeRoot?: string): string {
  const candidates: string[] = [];
  if (runtimeRoot) {
    candidates.push(join(runtimeRoot, "node", "bin", "node"));
  }
  if (process.env.MAIBOT_ONEKEY_NODE) {
    candidates.push(process.env.MAIBOT_ONEKEY_NODE);
  }
  candidates.push("node");

  for (const candidate of candidates) {
    if (candidate === "node") {
      const version = versionOf("node");
      if (version && satisfiesMinimum(version)) return "node";
      continue;
    }
    if (!existsSync(candidate)) continue;
    const version = versionOf(candidate);
    if (!version || satisfiesMinimum(version)) return candidate;
  }
  return "node";
}
