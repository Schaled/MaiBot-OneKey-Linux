import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ArtifactSource {
  /** Mirrors in preference order; the first that yields a hash-matching file wins. */
  mirrors: string[];
  /** Expected sha256. Null refuses to install (unsigned download). */
  sha256: string | null;
}

export interface FetchOptions {
  signal?: AbortSignal;
  onProgress?: (downloaded: number, total: number) => void;
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", fail);
    stream.on("end", () => done(hash.digest("hex")));
  });
}

/**
 * Download the first mirror whose bytes match the pinned sha256.
 *
 * A mirror only changes the transport, never the trust root: mismatched or
 * unpinned content is rejected instead of silently accepted. Two transports
 * are tried per mirror (in-process fetch, then curl) because some runtimes
 * reject mirror TLS chains that curl accepts.
 */
export async function fetchVerifiedArtifact(source: ArtifactSource, destination: string, options: FetchOptions = {}): Promise<string> {
  if (!source.sha256) {
    throw new Error("没有固定的 sha256，拒绝下载（不能信任未校验的传输路径）。");
  }
  const errors: string[] = [];
  for (const mirror of source.mirrors) {
    let verified = false;
    try {
      const bytes = await downloadToBuffer(mirror, options);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== source.sha256) {
        errors.push(`${mirror}: sha256 不匹配 (got ${actual.slice(0, 16)}…, want ${source.sha256.slice(0, 16)}…)`);
        continue;
      }
      await mkdir(dirnameOf(destination), { recursive: true });
      await writeFile(destination, bytes);
      verified = true;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      errors.push(`${mirror}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (verified) return destination;

    try {
      await downloadWithCurl(mirror, destination, options);
      const actual = await sha256File(destination);
      if (actual !== source.sha256) {
        errors.push(`${mirror} (curl): sha256 不匹配`);
        continue;
      }
      return destination;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      errors.push(`${mirror} (curl): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`所有下载源都失败了：\n${errors.map((line) => `  - ${line}`).join("\n")}`);
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : ".";
}

async function downloadToBuffer(url: string, options: FetchOptions): Promise<Buffer> {
  const response = await fetch(url, { signal: options.signal, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  const header = response.headers.get("content-length");
  const total = header ? Number(header) : 0;
  const chunks: Buffer[] = [];
  let downloaded = 0;
  let lastReport = 0;
  const iterable = response.body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of iterable) {
    const buffer = chunk as Buffer;
    chunks.push(buffer);
    downloaded += buffer.byteLength;
    if (options.onProgress && downloaded - lastReport > 4 * 1024 * 1024) {
      lastReport = downloaded;
      options.onProgress(downloaded, total);
    }
  }
  if (options.onProgress) options.onProgress(downloaded, total);
  return Buffer.concat(chunks);
}

async function downloadWithCurl(url: string, destination: string, options: FetchOptions): Promise<void> {
  await mkdir(dirnameOf(destination), { recursive: true });
  await runCurl(["-fSL", "--retry", "2", "-o", destination, url], options.signal);
}

function runCurl(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", fail);
    child.once("exit", (code) => {
      if (code === 0) {
        done();
        return;
      }
      fail(new Error(`curl 退出码 ${code ?? "signal"}：${stderr.trim().split("\n").at(-1) ?? ""}`));
    });
    signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  });
}

/** Extract a .tar.gz into targetDir, stripping a single top-level directory when present. */
export async function extractTarGz(archivePath: string, targetDir: string, signal?: AbortSignal): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const staging = `${targetDir}.extracting-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await runTar(["-xzf", resolve(archivePath), "-C", staging], signal);
    const entries = await readdir(staging);
    const source = entries.length === 1 ? join(staging, entries[0]) : staging;
    await mkdir(targetDir, { recursive: true });
    await rename(source, targetDir).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
      // Merge into an existing directory entry by entry.
      for (const name of await readdir(source)) {
        await rename(join(source, name), join(targetDir, name)).catch(async (inner: NodeJS.ErrnoException) => {
          if (inner.code !== "ENOTEMPTY" && inner.code !== "EEXIST") throw inner;
          await rm(join(targetDir, name), { recursive: true, force: true });
          await rename(join(source, name), join(targetDir, name));
        });
      }
      await rm(staging, { recursive: true, force: true });
      return;
    });
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await rm(archivePath, { force: true });
}

function runTar(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", fail);
    child.once("exit", (code) => {
      if (code === 0) {
        done();
        return;
      }
      fail(new Error(`tar ${args[0]} 失败 (${code ?? "signal"})：${stderr.trim().split("\n").at(-1) ?? ""}`));
    });
    signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  });
}

export function temporaryArchivePath(prefix: string, extension: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`);
}

export async function assertDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
