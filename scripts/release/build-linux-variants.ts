/**
 * Linux packaging (AppImage + deb), mirroring build-windows-variants.ts.
 *
 * Preconditions:
 *   - `bun run build` has produced out/ (same as the Windows flow)
 *   - repo runtime/python holds python-build-standalone 3.12 with pip+packaging
 *   - node-pty must be rebuilt against Electron's ABI (npmRebuild is off)
 *
 * Usage: bun run scripts/release/build-linux-variants.ts [--skip-rebuild]
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false, env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
}

async function main(): Promise<void> {
  const { build, version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const pythonRoot = join(root, "runtime", "python");
  const pythonBin = join(pythonRoot, "bin", "python3.12");
  if (!existsSync(pythonBin)) {
    throw new Error(`Missing Python runtime: ${pythonBin}（先运行 bun run payload:linux 或 prepare-linux-payload 到 repo runtime/）`);
  }
  // Build-time guarantee: the version probe needs packaging before any env exists.
  execFileSync(pythonBin, ["-I", "-c", "import packaging"], { stdio: "ignore" });

  const flags = process.argv.slice(2);
  if (!flags.includes("--skip-rebuild")) {
    console.log("[release] Rebuilding node-pty against Electron ABI…");
    await run(process.execPath, [
      join(root, "node_modules/@electron/rebuild/lib/cli.js"),
      "-f", "-w", "node-pty", "-v", "38.8.6",
    ]);
  }

  const output = join(root, "release", "linux");
  await mkdir(join(root, "release"), { recursive: true });
  await mkdir(join(root, ".codex-tmp"), { recursive: true });
  const configPath = join(root, ".codex-tmp", "electron-builder-linux.json");
  await writeFile(configPath, JSON.stringify({
    ...build,
    directories: { ...build.directories, output },
  }, null, 2));

  try {
    console.log("[release] Building Linux x64 AppImage + deb");
    await run(join(root, "node_modules/electron-builder/cli.js"), [
      "--linux", "AppImage", "deb", "--x64", "--publish", "never", "--config", configPath,
    ], {
      // electron-builder downloads Electron and AppImage tooling from GitHub;
      // the mirror keeps that off the flaky direct path.
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/",
      ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? "https://npmmirror.com/mirrors/electron-builder-binaries/",
    });

    const resources = join(output, "linux-unpacked", "resources");
    const required = [
      join(resources, "runtime/python/bin/python3.12"),
      join(resources, "runtime/python/lib/python3.12/site-packages/packaging"),
      join(resources, "maibot/package.json"),
      join(resources, "icon.png"),
      join(resources, "tray-icon.png"),
      join(resources, "app.asar"),
    ];
    for (const path of required) {
      if (!existsSync(path)) throw new Error(`Linux payload incomplete: missing ${path}`);
    }
    const ptyBinary = join(resources, "app.asar.unpacked/node_modules/node-pty/build/Release/pty.node");
    if (!existsSync(ptyBinary)) throw new Error(`node-pty native module missing: ${ptyBinary}`);

    for (const name of [`MaiBot-OK-${version}-linux.AppImage`, `MaiBot-OK-${version}-linux.deb`]) {
      await copyFile(join(output, name), join(root, "release", name));
    }
    console.log(`[release] Linux ${version} artifacts ready in release/:`);
    for (const name of [`MaiBot-OK-${version}-linux.AppImage`, `MaiBot-OK-${version}-linux.deb`]) {
      execFileSync("sha256sum", [join(root, "release", name)], { stdio: "inherit" });
    }
  } finally {
    await rm(configPath, { force: true });
  }
}

await main();
