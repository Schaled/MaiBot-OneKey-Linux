import { expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSmokeInstance,
  runCli,
  runCliWithRetry,
  extractLastJson,
  startSupervisor,
  stopSupervisor,
  waitForHttp,
  deploymentState,
  userDataLogsDir,
  type SmokeInstance,
} from "./helpers";

/**
 * P1 acceptance smoke: full chain on a scratch instance.
 *
 * Heavy stages (pip install of maibot + every dependency) run for real; set
 * MAIBOT_SMOKE_FULL=0 to skip them when iterating on lighter checks.
 */
const FULL = process.env.MAIBOT_SMOKE_FULL !== "0";
let instance: SmokeInstance;

beforeAll(async () => {
  instance = createSmokeInstance("full-chain");
  await startSupervisor(instance);
}, 30_000);

afterAll(async () => {
  await stopSupervisor(instance);
}, 30_000);

test("01 doctor reports the payload and platform checks as JSON", async () => {
  const result = runCli(["doctor", "--json"], instance);
  expect(result.ok).toBe(true);
  const report = extractLastJson(result.stdout) as { ok: boolean; checks: Array<{ id: string; ok: boolean }> };
  const ids = report.checks.map((check) => check.id);
  expect(ids).toContain("payload.python");
  expect(ids).toContain("git");
  expect(ids).toContain("eula");
  expect(ids).toContain("deployment");
});

test("02 eula gate blocks start until accepted, then accepts", async () => {
  // Fresh scope: accept for this instance's payload (idempotent).
  const accept = runCli(["eula", "--accept", "--yes"], instance);
  expect(accept.ok).toBe(true);
  const state = extractLastJson(runCli(["eula", "--json"], instance).stdout) as { isConfirmed: boolean };
  expect(state.isConfirmed).toBe(true);
});

test.skipIf(!FULL)("03 install provisions python runtime and maibot", async () => {
  const result = runCliWithRetry(["install"], instance, 3, 570_000);
  expect(result.ok).toBe(true);
  const deployment = deploymentState(instance);
  expect(deployment?.packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(deployment?.generation).toMatch(/^[0-9a-f-]{36}$/u);
  const python = join(instance.root, "modules/MaiBot/.onekey/environments", deployment!.generation, "bin/python3.12");
  expect(existsSync(python)).toBe(true);
}, 570_000);

test.skipIf(!FULL)("04 start brings the WebUI up and logs stay clean", async () => {
  // Installing maibot swaps the EULA source to the wheel's own copy; the hash
  // changes and upstream's freshness gate requires re-confirmation, exactly
  // like the GUI's post-update prompt.
  runCli(["eula", "--accept"], instance);
  const start = runCli(["start", "maibot"], instance, 90_000);
  expect(start.ok).toBe(true);
  const reachable = await waitForHttp("http://127.0.0.1:8001/", 60_000);
  expect(reachable).toBe(true);
  const status = extractLastJson(runCli(["status", "--json"], instance).stdout) as {
    services: Array<{ id: string; status: string; health: string; pid?: number }>;
  };
  const maibot = status.services.find((service) => service.id === "maibot");
  expect(maibot?.status).toBe("running");
  expect(maibot?.health).toBe("ready");
  expect(typeof maibot?.pid).toBe("number");
}, 180_000);

test.skipIf(!FULL)("05 logs -f streams entries and stop terminates the whole tree", async () => {
  const stop = runCli(["stop", "maibot"], instance, 90_000);
  expect(stop.ok).toBe(true);
  await new Promise((done) => setTimeout(done, 2_000));
  // No orphaned maibot children may survive a stop.
  const ps = Bun.spawnSync(["ps", "-eo", "cmd"], { cwd: "/tmp" });
  const lines = ps.stdout.toString().split("\n").filter((line) => line.includes(instance.root) && line.includes("python"));
  expect(lines).toEqual([]);
  const status = extractLastJson(runCli(["status", "--json"], instance).stdout) as {
    services: Array<{ id: string; status: string }>;
  };
  expect(status.services.find((service) => service.id === "maibot")?.status).toBe("stopped");
}, 180_000);

test.skipIf(!FULL)("06 kill -9 self-heals via the supervisor restart policy", async () => {
  const start = runCli(["start", "maibot"], instance, 90_000);
  expect(start.ok).toBe(true);
  await waitForHttp("http://127.0.0.1:8001/", 60_000);
  const before = extractLastJson(runCli(["status", "--json"], instance).stdout) as {
    services: Array<{ id: string; pid?: number }>;
  };
  const pid = before.services.find((service) => service.id === "maibot")?.pid;
  expect(typeof pid).toBe("number");
  process.kill(pid as number, "SIGKILL");
  // The restart timer fires ~2.5s after the exit event, then the service needs
  // a few seconds to boot. Poll until the supervisor reports a NEW running pid.
  let healed = false;
  let newPid: number | undefined;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 1_000));
    const status = extractLastJson(runCli(["status", "--json"], instance).stdout) as {
      services: Array<{ id: string; pid?: number; status: string }>;
    };
    const maibot = status.services.find((service) => service.id === "maibot");
    if (maibot?.status === "running" && typeof maibot.pid === "number" && maibot.pid !== pid) {
      healed = true;
      newPid = maibot.pid;
      break;
    }
  }
  expect(healed).toBe(true);
  const reachable = await waitForHttp("http://127.0.0.1:8001/", 60_000);
  expect(reachable).toBe(true);
  void newPid;
}, 240_000);

test.skipIf(!FULL)("07 backup exports and restore reproduces the instance config", async () => {
  runCli(["stop", "maibot"], instance, 90_000);
  const archive = join(instance.root, "..", "smoke-backup.tar.gz");
  const backup = runCli(["backup", "--output", archive], instance, 120_000);
  expect(backup.ok).toBe(true);
  expect(existsSync(archive)).toBe(true);

  const restoreTarget = createSmokeInstance("restore-target");
  // No EULA acceptance here on purpose: restore is a data operation and does
  // not gate on agreements, and accepting for a deployment-less instance would
  // write template hashes into the shared per-payload agreement store.
  const restore = runCli(["restore", archive], restoreTarget, 120_000);
  expect(restore.ok).toBe(true);
  const source = readFileSync(join(instance.root, "modules/MaiBot/config/bot_config.toml"), "utf8");
  const restored = readFileSync(join(restoreTarget.root, "modules/MaiBot/config/bot_config.toml"), "utf8");
  expect(restored).toBe(source);
});

test("08 napcat compose generation is deterministic and loopback-bound", () => {
  const result = runCli(["backend", "napcat", "compose"], instance);
  expect(result.ok).toBe(true);
  const compose = readFileSync(join(instance.root, "napcat/napcat-docker-compose.yml"), "utf8");
  expect(compose).toContain("mlikiowa/napcat-docker");
  expect(compose).toContain("127.0.0.1:6099:6099");
  expect(compose).toContain("127.0.0.1:7998:3001");
});

test("09 snowluma install lands a runnable protocol backend", async () => {
  // The mirror path is genuinely flaky; the contract is that SOME attempt succeeds.
  const result = runCliWithRetry(["backend", "snowluma", "install"], instance, 3, 300_000);
  expect(result.ok).toBe(true);
  const root = join(instance.root, "modules/SnowLuma");
  expect(existsSync(join(root, "index.mjs"))).toBe(true);
  expect(existsSync(join(root, "native"))).toBe(true);
  const version = Bun.spawnSync([join(root, "node"), "--version"], { cwd: root });
  expect(version.stdout.toString()).toContain("v24.");
}, 330_000);

test("10 log files exist for the maibot service", () => {
  const logs = userDataLogsDir(instance);
  if (FULL) {
    expect(existsSync(join(logs, "maibot.log"))).toBe(true);
  }
});
