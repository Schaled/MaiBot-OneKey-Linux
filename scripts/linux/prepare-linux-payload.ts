/**
 * Assemble the Linux payload: bundled Python runtime + SnowLuma protocol
 * backend + maibot package manifest, ready for install.sh or P2 packaging.
 *
 * Usage: bun run scripts/linux/prepare-linux-payload.ts [--out <dir>]
 */
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildRuntimePaths } from "../../src/main/platform/runtime-paths";
import { PayloadManager } from "../../src/main/platform/payload-manager";

const repoRoot = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const payloadRoot = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(repoRoot, "payload");

const paths = buildRuntimePaths({
  installRoot: payloadRoot,
  payloadRoot,
  appDataRoot: join(repoRoot, ".cache", "payload-appdata"),
  packaged: true,
  resourceRoot: join(payloadRoot, "instance"),
});
const manager = new PayloadManager(paths);

console.log(`组装 Linux payload: ${payloadRoot}`);

// Manifests must exist before SnowLuma provisioning reads them.
for (const name of ["snowluma-upstream.json", "snowluma-adapter-upstream.json"]) {
  const source = join(repoRoot, "resources", name);
  if (existsSync(source)) {
    await mkdir(join(payloadRoot, "resources"), { recursive: true });
    await cp(source, join(payloadRoot, "resources", name));
  }
}

const python = await manager.ensurePythonRuntime((message) => console.log(`  ${message}`));
console.log(`  Python: ${python}`);
const snowluma = await manager.ensureSnowLuma((progress) => {
  if (progress.stage === "download" && progress.total) {
    process.stdout.write(`\r  SnowLuma ${((progress.downloaded ?? 0) / 1048576).toFixed(0)}/${(progress.total / 1048576).toFixed(0)}MB`);
  }
});
process.stdout.write("\n");
console.log(`  SnowLuma: ${snowluma}`);
await manager.ensureMaibotPackageResources(join(repoRoot, "resources", "maibot-package"));
console.log(`  maibot-package: ${join(payloadRoot, "maibot")}`);

// Ship the upstream manifests so the installed payload can fetch future updates.
for (const name of ["snowluma-upstream.json", "snowluma-adapter-upstream.json"]) {
  const source = join(repoRoot, "resources", name);
  if (existsSync(source)) {
    await mkdir(join(payloadRoot, "resources"), { recursive: true });
    await cp(source, join(payloadRoot, "resources", name));
  }
}

// Bundle the CLI as a single ESM file executed by any node >= 20 (payload or system).
console.log("构建 CLI bundle…");
const { execFileSync } = await import("node:child_process");
try {
  execFileSync(process.execPath, [
    "build", join(repoRoot, "src/cli/main.ts"),
    "--target=node", "--format=esm",
    "--external", "node-pty",
    "--outfile", join(payloadRoot, "cli/maibot-ok.mjs"),
  ], { cwd: repoRoot, stdio: "inherit" });
} catch (error) {
  throw new Error(`CLI bundle 构建失败: ${error instanceof Error ? error.message : String(error)}`);
}

console.log("payload 就绪。安装: bash scripts/linux/install.sh");
