import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { HeadlessRuntime } from "./bootstrap";

/**
 * Same archive contract as the GUI backup (manifest.json + maibot/config +
 * maibot/data + maibot/plugins), implemented with system tar so P1 and P2
 * archives stay byte-compatible.
 */
export async function exportMaibotBackup(runtime: HeadlessRuntime, outputPath: string, onProgress: (label: string) => void): Promise<void> {
  const staging = `${outputPath}.staging-${process.pid}`;
  await mkdir(join(staging, "maibot"), { recursive: true });
  const maibotRoot = runtime.paths.maibotRoot;
  for (const name of ["config", "data", "plugins"]) {
    const source = join(maibotRoot, name);
    if (await exists(source)) {
      onProgress(`打包 ${name}/`);
      await copyTree(source, join(staging, "maibot", name));
    }
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(staging, "manifest.json"),
    `${JSON.stringify({ version: 1, createdAt: Date.now(), launcher: "maibot-ok-headless" }, null, 2)}\n`,
    "utf8",
  );
  onProgress("压缩归档…");
  await runTar(["-czf", outputPath, "-C", staging, "."]);
  await rmTree(staging);
}

export async function importMaibotBackup(runtime: HeadlessRuntime, archivePath: string, onProgress: (label: string) => void): Promise<void> {
  const staging = `${archivePath}.staging-${process.pid}`;
  await rmTree(staging);
  await mkdir(staging, { recursive: true });
  await runTar(["-xzf", archivePath, "-C", staging]);
  const maibotRoot = runtime.paths.maibotRoot;
  for (const name of ["config", "data", "plugins"]) {
    const source = join(staging, "maibot", name);
    if (await exists(source)) {
      onProgress(`恢复 ${name}/`);
      await copyTree(source, join(maibotRoot, name));
    }
  }
  await rmTree(staging);
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function copyTree(source: string, target: string): Promise<void> {
  const { cp } = await import("node:fs/promises");
  await cp(source, target, { recursive: true });
}

async function rmTree(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true, force: true });
}

function runTar(args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", fail);
    child.once("exit", (code) => {
      if (code === 0) {
        done();
        return;
      }
      fail(new Error(`tar 失败: ${stderr.trim().split("\n").at(-1) ?? code}`));
    });
  });
}
