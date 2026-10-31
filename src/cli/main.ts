#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHeadlessRuntime, type HeadlessRuntime } from "./bootstrap";
import { resolveHeadlessLayout, type LayoutOptions } from "./paths";
import { createSupervisorHandlers } from "./supervisor-handlers";
import { requestControl, requestStream, serveControlSocket, writeServePidFile } from "./control-socket";

const VERSION = readVersion();

function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface CliArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | number>;
  json: boolean;
  root?: string;
  payloadRoot?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string | boolean | number> = {};
  const positional: string[] = [];
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (command === undefined) command = token;
    else positional.push(token);
  }
  if (!command) {
    printUsage();
    process.exit(2);
  }
  return {
    command,
    positional,
    flags,
    json: flags.json === true,
    root: typeof flags.root === "string" ? flags.root : undefined,
    payloadRoot: typeof flags.payload === "string" ? flags.payload : undefined,
  };
}

function printUsage(): void {
  console.log(`maibot-ok — MaiBot OneKey headless supervisor (linux)

用法:
  maibot-ok serve [--root <dir>]                前台启动 supervisor 并监听控制 socket
  maibot-ok start [maibot|napcat] [--all]       启动服务（无 supervisor 时自动拉起）
  maibot-ok stop [maibot|napcat]                停止服务
  maibot-ok restart [maibot|napcat]             重启服务
  maibot-ok status [--json]                     查看服务与 payload 状态
  maibot-ok logs <service> [-f]                 查看/跟踪服务日志
  maibot-ok install [--version <v>]             安装/升级 Maibot（默认最新正式版）
  maibot-ok rollback                            回滚到上一个部署
  maibot-ok backup [--output <file>]            导出实例备份 (tar.gz)
  maibot-ok restore <archive>                   恢复实例备份
  maibot-ok backend snowluma install            下载并校验 SnowLuma 协议端
  maibot-ok backend napcat compose              生成 NapCat Docker compose 文件
  maibot-ok backend napcat up|down|logs         管理 NapCat 容器 (docker compose)
  maibot-ok eula [--accept]                     查看/接受 EULA 与隐私政策
  maibot-ok doctor [--json]                     环境体检
  maibot-ok shutdown                            停止全部服务并退出 supervisor

通用选项:
  --root <dir>    实例目录（默认 ~/.local/share/maibot-onekey/instance）
  --payload <dir> payload 目录（默认当前目录或 MAIBOT_ONEKEY_PAYLOAD）
  --json          机器可读输出`);
}

function fail(message: string): never {
  console.error(`错误: ${message}`);
  process.exit(1);
}

function output(json: boolean, data: unknown, human: () => void): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

async function connectOrStart(layout: ReturnType<typeof resolveHeadlessLayout>): Promise<void> {
  try {
    await requestControl(layout.socketPath, "status", {}, 3_000);
    return;
  } catch {
    // Not running: start a detached supervisor.
  }
  const entry = resolveEntryPath();
  mkdirSync(layout.runtimeDir, { recursive: true });
  const logFile = join(layout.userDataRoot, "logs", "serve.log");
  await mkdir(join(layout.userDataRoot, "logs"), { recursive: true });
  const child = spawn(process.execPath, [entry, "serve", "--root", layout.instanceRoot, "--payload", layout.payloadRoot], {
    detached: true,
    stdio: ["ignore", await openLogFile(logFile), await openLogFile(logFile)],
    env: process.env,
  });
  child.unref();
  await writeServePidFile(layout.userDataRoot, child.pid ?? 0);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await requestControl(layout.socketPath, "status", {}, 2_000);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 300));
    }
  }
  fail(`supervisor 未能在 15s 内就绪，日志: ${logFile}`);
}

async function openLogFile(path: string): Promise<number> {
  await mkdir(join(path, ".."), { recursive: true });
  const { open } = await import("node:fs/promises");
  return (await open(path, "a")).fd;
}

function resolveEntryPath(): string {
  // Running from source (src/cli/main.ts) or from the bundled payload (cli/maibot-ok.mjs).
  if (import.meta.url.endsWith("src/cli/main.ts")) {
    return new URL("./main.ts", import.meta.url).pathname;
  }
  return new URL(import.meta.url).pathname;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options: LayoutOptions = { instanceRoot: args.root, payloadRoot: args.payloadRoot };
  const layout = resolveHeadlessLayout(options);

  // install/rollback need the supervisor; the rest build their own runtime.
  const standaloneCommands = new Set(["serve", "help", "--help", "eula", "backend", "doctor", "backup", "restore", "versions"]);
  if (!standaloneCommands.has(args.command)) {
    await connectOrStart(layout);
  }

  switch (args.command) {
    case "serve":
      return await runServe(layout, args);
    case "status":
      return await runControl(layout, "status", {}, args.json, (data) => {
        const services = (data as { services?: Array<{ id: string; name: string; status: string; health: string; detail?: string }> }).services ?? [];
        for (const service of services) {
          console.log(`${service.id.padEnd(8)} ${service.status.padEnd(9)} ${service.health.padEnd(12)} ${service.name}${service.detail ? ` — ${service.detail}` : ""}`);
        }
      });
    case "start":
    case "stop":
    case "restart": {
      const params: Record<string, unknown> = args.flags.all === true
        ? {}
        : { service: args.positional[0] ?? "maibot" };
      const cmd = args.flags.all === true && args.command === "start" ? "startAll" : args.command;
      return await runControl(layout, cmd, params, args.json, (data) => {
        const services = Array.isArray(data) ? data as Array<{ id: string; status: string }> : [];
        for (const service of services) console.log(`${service.id}: ${service.status}`);
      });
    }
    case "logs":
      return await runLogs(layout, args);
    case "install":
      return await runInstall(layout, args);
    case "rollback":
      return await runControl(layout, "rollback", {}, args.json, () => console.log("已回滚到上一个部署。"));
    case "versions": {
      const runtime = createHeadlessRuntime(options);
      const versions = await runtime.pythonDependencyManager.listMaiBotVersions();
      output(args.json, versions, () => console.log(versions.versions.slice(0, 20).map((v) => v.version).join("\n")));
      return;
    }
    case "eula":
      return await runEula(layout, args, options);
    case "backend":
      return await runBackend(layout, args, options);
    case "doctor":
      return await runDoctor(layout, args, options);
    case "backup":
      return await runBackup(layout, args);
    case "restore":
      return await runRestore(layout, args);
    case "shutdown":
      return await runControl(layout, "shutdown", {}, args.json, () => console.log("supervisor 已退出。"));
    case "help":
    case "--help":
      printUsage();
      return;
    default:
      fail(`未知命令: ${args.command}`);
  }
}

async function runControl(layout: ReturnType<typeof resolveHeadlessLayout>, cmd: string, params: Record<string, unknown>, json: boolean, human: (data: unknown) => void): Promise<void> {
  const result = await requestControl(layout.socketPath, cmd, params);
  if (!result.ok) fail(result.error ?? "命令失败");
  output(json, result.data, () => human(result.data));
}

async function runServe(layout: ReturnType<typeof resolveHeadlessLayout>, args: CliArgs): Promise<void> {
  const runtime = createHeadlessRuntime({ instanceRoot: layout.instanceRoot, payloadRoot: layout.payloadRoot });
  const handlers = createSupervisorHandlers();
  const server = await serveControlSocket(runtime, layout.socketPath, handlers).catch((error: Error) => fail(error.message));
  await writeServePidFile(runtime.layout.userDataRoot, process.pid);
  console.log(`maibot-ok supervisor ${VERSION} 就绪`);
  console.log(`  实例: ${runtime.layout.instanceRoot}`);
  console.log(`  设置: ${runtime.paths.userDataRoot}`);
  console.log(`  socket: ${layout.socketPath}`);
  if (args.json) console.log(JSON.stringify({ socket: layout.socketPath, instanceRoot: runtime.layout.instanceRoot }));

  const cleanup = async (): Promise<void> => {
    await runtime.serviceManager.shutdownAll().catch(() => undefined);
    runtime.serviceManager.dispose();
    runtime.ptySessionManager.dispose();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());
}

async function runLogs(layout: ReturnType<typeof resolveHeadlessLayout>, args: CliArgs): Promise<void> {
  const service = args.positional[0];
  if (service !== "maibot" && service !== "napcat") fail("logs 需要 maibot 或 napcat");
  const follow = args.flags.f === true;
  const socketPath = layout.socketPath;
  const print = (payload: unknown): void => {
    const entry = (payload as { entry?: { timestamp: number; stream: string; message: string } }).entry;
    if (!entry) return;
    console.log(`[${new Date(entry.timestamp).toISOString()}] [${entry.stream}] ${entry.message}`);
  };
  try {
    if (follow) {
      await requestStream(socketPath, "logs", { service, follow: true }, print);
      return;
    }
    const result = await requestControl(socketPath, "logs", { service });
    if (!result.ok) fail(result.error ?? "读取日志失败");
    for (const entry of (result.data as { entries: Array<{ timestamp: number; stream: string; message: string }> }).entries.slice(-200)) {
      console.log(`[${new Date(entry.timestamp).toISOString()}] [${entry.stream}] ${entry.message}`);
    }
  } catch {
    // Supervisor not running: fall back to the log file.
    const runtime = createHeadlessRuntime({ instanceRoot: layout.instanceRoot, payloadRoot: layout.payloadRoot });
    const logFile = join(runtime.paths.logsRoot, `${service}.log`);
    if (!existsSync(logFile)) fail(`日志文件不存在: ${logFile}`);
    const content = readFileSync(logFile, "utf8");
    const lines = content.split("\n").filter(Boolean);
    console.log(lines.slice(-200).join("\n"));
  }
}

async function runInstall(layout: ReturnType<typeof resolveHeadlessLayout>, args: CliArgs): Promise<void> {
  await runEulaIfNeeded(layout, args);
  const version = typeof args.flags.version === "string" ? args.flags.version : undefined;
  const params: Record<string, unknown> = version ? { version } : {};
  const result = await requestStream(layout.socketPath, "install", params, (payload) => {
    const progress = (payload as { progress?: { label?: string; percent?: number; detail?: string } }).progress;
    if (progress) console.log(`[${progress.percent ?? 0}%] ${progress.label ?? ""}${progress.detail ? ` — ${progress.detail}` : ""}`);
  });
  if (!result.ok) fail(result.error ?? "安装失败");
  console.log("Maibot 安装完成。");
}

async function runEulaIfNeeded(layout: ReturnType<typeof resolveHeadlessLayout>, args: CliArgs): Promise<void> {
  const result = await requestControl(layout.socketPath, "eulaStatus", {});
  if (!result.ok) fail(result.error ?? "读取协议状态失败");
  const state = result.data as { isConfirmed: boolean };
  if (state.isConfirmed || args.flags.yes === true || args.flags["accept-eula"] === true) return;
  fail(`需要先接受 EULA 与隐私政策：运行 maibot-ok eula --accept --root ${layout.instanceRoot}`);
}

async function runEula(_layout: ReturnType<typeof resolveHeadlessLayout>, args: CliArgs, options: LayoutOptions): Promise<void> {
  const runtime = createHeadlessRuntime(options);
  if (args.flags.accept === true) {
    const result = await runtime.initManager.confirmAgreements();
    console.log(`已记录协议确认: ${result.changedFiles.join(", ")}`);
    return;
  }
  const state = await runtime.initManager.getAgreementState();
  output(args.json, state, () => {
    for (const document of state.documents) {
      console.log(`${document.title}: ${document.exists ? (document.confirmed ? "已确认" : "未确认") : "文件缺失"} — ${document.sourcePath}`);
    }
    console.log(state.isConfirmed ? "\n协议已确认。" : "\n使用 maibot-ok eula --accept 确认。");
  });
}

async function runDoctor(_layout: ReturnType<typeof resolveHeadlessLayout>, args: CliArgs, options: LayoutOptions): Promise<void> {
  const runtime = createHeadlessRuntime(options);
  const checks: Array<{ id: string; label: string; ok: boolean; detail?: string }> = [];
  const { probePython } = await import("../main/platform/payload-manager");

  const payload = await runtime.payloadManager.inspect();
  for (const component of payload) {
    checks.push({ id: `payload.${component.id}`, label: component.label, ok: component.ready, detail: component.detail });
  }
  const gitPath = await runtime.initManager.getGitPath();
  checks.push({ id: "git", label: "系统 git（插件安装需要）", ok: Boolean(gitPath), detail: gitPath });

  const python = runtime.payloadManager.bundledPythonPath();
  if (python) {
    const probe = await probePython(python);
    checks.push({ id: "python.probe", label: "Python stdlib 冒烟 (ssl/sqlite3/tomllib)", ok: probe.ok, detail: probe.ok ? probe.detail : probe.detail });
  }

  const agreements = await runtime.initManager.getAgreementState().catch((error: Error) => ({ isConfirmed: false, error: error.message }));
  checks.push({ id: "eula", label: "EULA / 隐私政策", ok: agreements.isConfirmed });

  const deployment = readDeploymentState(runtime);
  checks.push({ id: "deployment", label: "Maibot 部署", ok: Boolean(deployment), detail: deployment ? `v${deployment.packageVersion} gen=${deployment.generation.slice(0, 8)}` : "未安装；运行 maibot-ok install" });

  const docker = await probeDocker();
  checks.push({ id: "docker", label: "Docker（NapCat 可选后端）", ok: docker.ok, detail: docker.detail });

  const failed = checks.filter((check) => !check.ok);
  output(args.json, { ok: failed.length === 0, checks }, () => {
    for (const check of checks) {
      console.log(`${check.ok ? "✔" : "✘"} ${check.label}${check.detail ? ` — ${check.detail}` : ""}`);
    }
    console.log(failed.length === 0 ? "\n全部检查通过。" : `\n${failed.length} 项未通过。`);
  });
  if (failed.length > 0 && !args.json) process.exitCode = 1;
}

function readDeploymentState(runtime: HeadlessRuntime): { packageVersion: string; generation: string } | undefined {
  const file = join(runtime.paths.maibotRoot, ".onekey-deployment.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function probeDocker(): Promise<{ ok: boolean; detail?: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((done) => {
    execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 8_000 }, (error, stdout, stderr) => {
      if (error) {
        const raw = String(stderr || error.message);
        const permission = /permission denied|docker\.sock/u.test(raw);
        done({
          ok: false,
          detail: permission
            ? "当前用户无 docker 权限；执行 sudo usermod -aG docker $USER 后重新登录"
            : raw.trim().split("\n")[0],
        });
        return;
      }
      done({ ok: true, detail: stdout.trim() });
    });
  });
}

async function runBackend(layout: ReturnType<typeof resolveHeadlessLayout>, args: CliArgs, options: LayoutOptions): Promise<void> {
  const sub = args.positional[0];
  const action = args.positional[1];
  if (sub === "snowluma") {
    const runtime = createHeadlessRuntime(options);
    if (action === "install") {
      console.log("下载 SnowLuma（sha256 校验通过后解压）…");
      const target = await runtime.payloadManager.ensureSnowLuma((progress) => {
        if (progress.stage === "download" && progress.total) {
          const downloaded = ((progress.downloaded ?? 0) / 1048576).toFixed(0);
          process.stdout.write(`\r下载 ${downloaded}MB/${(progress.total / 1048576).toFixed(0)}MB`);
        }
      });
      process.stdout.write("\n");
      console.log(`SnowLuma 就绪: ${target}`);
      return;
    }
    fail("用法: maibot-ok backend snowluma install");
  }
  if (sub === "napcat") {
    return await runNapCat(layout, args, action);
  }
  fail("用法: maibot-ok backend <snowluma|napcat> <action>");
}

async function runNapCat(layout: ReturnType<typeof resolveHeadlessLayout>, _args: CliArgs, action?: string): Promise<void> {
  const composeFile = join(layout.instanceRoot, "napcat", "napcat-docker-compose.yml");
  if (action === "compose" || action === undefined) {
    const { generateNapCatCompose } = await import("./napcat-compose");
    const content = generateNapCatCompose({ instanceRoot: layout.instanceRoot, webuiPort: 6099, onebotPort: 7998 });
    await mkdir(join(layout.instanceRoot, "napcat"), { recursive: true });
    await writeFile(composeFile, content, "utf8");
    console.log(`已生成 ${composeFile}`);
    console.log(`启动: maibot-ok backend napcat up\n停止: maibot-ok backend napcat down`);
    return;
  }
  if (!existsSync(composeFile)) fail(`未找到 ${composeFile}；先运行 maibot-ok backend napcat compose`);
  const { execFile } = await import("node:child_process");
  const command = action === "up" ? "up" : action === "down" ? "down" : action === "logs" ? "logs" : undefined;
  if (!command) fail("用法: maibot-ok backend napcat <compose|up|down|logs>");
  const child = execFile("docker", ["compose", "-f", composeFile, command, ...(command === "up" ? ["-d"] : []), ...(command === "logs" ? ["--tail", "100"] : [])], { timeout: 120_000 }, (error, stdout, stderr) => {
    if (error) fail(`docker compose ${command} 失败: ${String(stderr || error.message).split("\n")[0]}`);
    console.log(stdout.trim() || `napcat ${command} 完成。`);
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
}

async function runBackup(layout: ReturnType<typeof resolveHeadlessLayout>, args: CliArgs): Promise<void> {
  const runtime = createHeadlessRuntime({ instanceRoot: layout.instanceRoot, payloadRoot: layout.payloadRoot });
  assertStopped(runtime);
  const output_path = typeof args.flags.output === "string" ? resolve(args.flags.output) : join(layout.instanceRoot, "..", `maibot-onekey-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  console.log(`导出备份到 ${output_path} …`);
  const { exportMaibotBackup } = await import("./backup");
  await exportMaibotBackup(runtime, output_path, (label) => console.log(`  ${label}`));
  console.log("备份完成。");
}

async function runRestore(layout: ReturnType<typeof resolveHeadlessLayout>, args: CliArgs): Promise<void> {
  const archive = args.positional[0];
  if (!archive) fail("restore 需要备份文件路径");
  const runtime = createHeadlessRuntime({ instanceRoot: layout.instanceRoot, payloadRoot: layout.payloadRoot });
  assertStopped(runtime);
  const { importMaibotBackup } = await import("./backup");
  await importMaibotBackup(runtime, resolve(archive), (label) => console.log(`  ${label}`));
  console.log("恢复完成。");
}

function assertStopped(runtime: HeadlessRuntime): void {
  const active = runtime.serviceManager.snapshot()
    .filter((service) => service.managed || ["starting", "running", "stopping"].includes(service.status));
  if (active.length > 0) fail(`请先停止所有服务: ${active.map((service) => service.id).join(", ")}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
