import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";
import { extractTarGz, fetchVerifiedArtifact, temporaryArchivePath } from "./artifact-fetch";

const SNOWLUMA_UPSTREAM_FILE = "snowluma-upstream.json";
const PYTHON_RUNTIME_DIR = "python";
/** Mirrors in preference order; the pinned sha256 is what makes them interchangeable. */
const PYTHON_MIRRORS = [
  "https://gh-proxy.com/https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-{arch}-unknown-linux-gnu-install_only.tar.gz",
  "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-{arch}-unknown-linux-gnu-install_only.tar.gz",
];
const PYTHON_SHA256: Record<string, string> = {
  x64: "6a79e922e50006b601f29e688407659da1c2b86ebcd4e9c7254cf234be8b89de",
};
const SNOWLUMA_RELEASE_MIRRORS = (repository: string, tag: string, asset: string): string[] => {
  const slug = repository.replace(/^https?:\/\/[^/]+\//u, "").replace(/\.git$/u, "").replace(/\/+$/u, "");
  return [
    `https://gh-proxy.com/https://github.com/${slug}/releases/download/${tag}/${asset}`,
    `https://github.com/${slug}/releases/download/${tag}/${asset}`,
  ];
};

export interface PayloadComponent {
  id: "python" | "snowluma";
  label: string;
  ready: boolean;
  path?: string;
  detail?: string;
}

interface SnowLumaUpstream {
  repository: string;
  tag: string;
  version: string;
  linux?: Partial<Record<"x64" | "arm64", { asset: string; sha256: string | null }>>;
}

export interface SnowLumaInstallProgress {
  stage: "download" | "extract" | "verify" | "done";
  downloaded?: number;
  total?: number;
}

export class PayloadManager {
  constructor(private readonly paths: RuntimePaths) {}

  /** Linux payload python root: <runtimeRoot>/python with bin/python3.12. */
  pythonRuntimeRoot(): string {
    return join(this.paths.runtimeRoot, PYTHON_RUNTIME_DIR);
  }

  bundledPythonPath(): string | undefined {
    const root = this.pythonRuntimeRoot();
    for (const candidate of ["bin/python3.12", "bin/python3", "bin/python"]) {
      const path = join(root, candidate);
      if (existsSync(path)) return path;
    }
    return undefined;
  }

  async ensurePythonRuntime(onProgress?: (message: string) => void): Promise<string> {
    const existing = this.bundledPythonPath();
    if (existing) {
      // The interpreter alone is not enough: the version probe needs packaging
      // before any environment exists (Windows payload ships it baked in).
      await this.bootstrapBundledPython(existing, onProgress);
      return existing;
    }

    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const pinned = PYTHON_SHA256[process.arch === "arm64" ? "arm64" : "x64"];
    if (!pinned) throw new Error(`没有适用于 ${process.arch} 的 python-build-standalone 校验值，拒绝安装。`);
    const mirrors = PYTHON_MIRRORS.map((template) => template.replace("{arch}", arch));
    const archive = temporaryArchivePath("maibot-onekey-python", ".tar.gz");
    onProgress?.(`下载 python-build-standalone 3.12.16 (${arch})…`);
    await fetchVerifiedArtifact({ mirrors, sha256: pinned }, archive);
    onProgress?.("解压 Python 运行时…");
    await extractTarGz(archive, this.pythonRuntimeRoot());
    const python = this.bundledPythonPath();
    if (!python) throw new Error(`Python 运行时解压后缺少解释器: ${this.pythonRuntimeRoot()}`);
    await this.bootstrapBundledPython(python, onProgress);
    return python;
  }

  /**
   * The Windows payload ships a lean runtime with pip/setuptools/wheel/packaging
   * baked in; python-build-standalone only ships pip, and the version probe
   * needs `packaging` for PEP 440 ordering before any environment exists.
   */
  private async bootstrapBundledPython(python: string, onProgress?: (message: string) => void): Promise<void> {
    const hasPackaging = await this.pythonHasModule(python, "packaging");
    if (hasPackaging) return;
    onProgress?.("安装 Python 引导依赖 (packaging)…");
    const { execFile } = await import("node:child_process");
    const indexes = [
      ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"],
      [],
    ];
    let lastError: unknown;
    for (const index of indexes) {
      try {
        await new Promise<void>((done, fail) => {
          execFile(python, ["-I", "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--no-compile", ...index, "packaging"],
            { timeout: 180_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" } },
            (error, _stdout, stderr) => {
              if (error) fail(new Error(String(stderr || error.message).split("\n").at(-1) ?? "pip install packaging 失败"));
              else done();
            });
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("安装 Python 引导依赖失败");
  }

  private async pythonHasModule(python: string, moduleName: string): Promise<boolean> {
    const { execFile } = await import("node:child_process");
    return new Promise((done) => {
      execFile(python, ["-I", "-c", `import ${moduleName}`], { timeout: 15_000 }, (error) => done(!error));
    });
  }

  /**
   * SnowLuma ships its own node (engines ^24.22.1), so this is the only
   * protocol-backend payload the CLI has to provision.
   */
  async ensureSnowLuma(onProgress?: (progress: SnowLumaInstallProgress) => void): Promise<string> {
    const target = this.paths.snowlumaRoot;
    if (isSnowLumaRootValid(target)) return target;

    const upstream = await this.readSnowLumaUpstream();
    const archKey = process.arch === "arm64" ? "arm64" : "x64";
    const pinned = upstream.linux?.[archKey];
    if (!pinned?.asset) throw new Error(`snowluma-upstream.json 没有 ${archKey} 的发布配置。`);
    if (!pinned.sha256) throw new Error(`SnowLuma ${upstream.tag} ${archKey} 没有固定的 sha256，拒绝下载。请先补全 resources/snowluma-upstream.json。`);

    const archive = temporaryArchivePath("maibot-onekey-snowluma", ".tar.gz");
    onProgress?.({ stage: "download" });
    await fetchVerifiedArtifact(
      { mirrors: SNOWLUMA_RELEASE_MIRRORS(upstream.repository, upstream.tag, pinned.asset), sha256: pinned.sha256 },
      archive,
      { onProgress: (downloaded, total) => onProgress?.({ stage: "download", downloaded, total }) },
    );
    onProgress?.({ stage: "extract" });
    await extractTarGz(archive, target);
    if (!isSnowLumaRootValid(target)) {
      throw new Error(`SnowLuma 解压后不完整: ${target} 缺少 index.mjs 或 native/`);
    }
    onProgress?.({ stage: "verify" });
    onProgress?.({ stage: "done" });
    return target;
  }

  async readSnowLumaUpstream(): Promise<SnowLumaUpstream> {
    const candidates = [
      join(this.paths.installRoot, "resources", SNOWLUMA_UPSTREAM_FILE),
      join(this.paths.payloadRoot, "resources", SNOWLUMA_UPSTREAM_FILE),
      join(this.paths.payloadRoot, SNOWLUMA_UPSTREAM_FILE),
    ];
    for (const candidate of candidates) {
      try {
        return JSON.parse(await readFile(candidate, "utf8")) as SnowLumaUpstream;
      } catch {
        // Try the next candidate.
      }
    }
    throw new Error(`找不到 ${SNOWLUMA_UPSTREAM_FILE}，无法确定 SnowLuma 的官方发布信息。`);
  }

  /** Copy resources/maibot-package (EULA/PRIVACY/pyproject manifest) into the payload. */
  async ensureMaibotPackageResources(sourceOverride?: string): Promise<string> {
    const target = join(this.paths.payloadRoot, "maibot");
    if (existsSync(join(target, "package.json"))) return target;
    const source = sourceOverride
      ?? [join(this.paths.installRoot, "resources", "maibot-package"), join(this.paths.payloadRoot, "resources", "maibot-package")]
        .find((candidate) => existsSync(candidate));
    if (!source) throw new Error(`缺少 maibot-package 模板: ${join(this.paths.installRoot, "resources", "maibot-package")}`);
    await mkdir(this.paths.payloadRoot, { recursive: true });
    await cp(source, target, { recursive: true });
    return target;
  }

  async inspect(): Promise<PayloadComponent[]> {
    const components: PayloadComponent[] = [];
    const python = this.bundledPythonPath();
    components.push({
      id: "python",
      label: "Python 运行时 (python-build-standalone 3.12)",
      ready: Boolean(python),
      path: python ? this.pythonRuntimeRoot() : this.pythonRuntimeRoot(),
      detail: python ? undefined : "未安装；首次安装 Maibot 环境时会自动下载",
    });
    const snowluma = this.paths.snowlumaRoot;
    const snowlumaReady = isSnowLumaRootValid(snowluma);
    components.push({
      id: "snowluma",
      label: "SnowLuma 协议端",
      ready: snowlumaReady,
      path: snowluma,
      detail: snowlumaReady ? undefined : "未安装；使用 backend snowluma install 下载",
    });
    return components;
  }
}

export function isSnowLumaRootValid(root: string): boolean {
  try {
    return statSync(join(root, "index.mjs")).isFile() && statSync(join(root, "native")).isDirectory();
  } catch {
    return false;
  }
}

/** Check the bundled python answers the same probe the deployment manager uses. */
export async function probePython(pythonPath: string): Promise<{ ok: boolean; detail: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((done) => {
    execFile(
      pythonPath,
      ["-I", "-c", "import sys, ssl, sqlite3, tomllib; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"],
      { timeout: 30_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } },
      (error, stdout) => {
        if (error) {
          done({ ok: false, detail: String(error) });
          return;
        }
        done({ ok: true, detail: stdout.trim() });
      },
    );
  });
}

export async function removePayloadDirectory(path: string): Promise<void> {
  await stat(path);
  await rm(path, { recursive: true, force: true });
}
