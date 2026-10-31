import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { HeadlessRuntime } from "./bootstrap";
import { createCommandRegistry, type CommandHandler, type ControlResult } from "./control-socket";
import type { ServiceId } from "../shared/contracts";
import { assertNoActiveServices } from "./bootstrap";

function parseServiceId(value: unknown): ServiceId {
  if (value === "maibot" || value === "napcat") return value;
  throw new Error(`服务名必须是 maibot 或 napcat，收到: ${String(value)}`);
}

const handlers: Record<string, CommandHandler> = {
  async status(_params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    return {
      services: runtime.serviceManager.snapshot(),
      runtimeOperation: runtime.resourceLocationManager.getOperationLabel(),
      payload: await runtime.payloadManager.inspect(),
    };
  },

  async start(params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    const serviceId = parseServiceId(params.service);
    return await runtime.serviceManager.start(serviceId);
  },

  async startAll(_params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    return await runtime.serviceManager.startAll();
  },

  async stop(params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    const serviceId = parseServiceId(params.service);
    return await runtime.serviceManager.stop(serviceId);
  },

  async restart(params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    const serviceId = parseServiceId(params.service);
    return await runtime.serviceManager.restart(serviceId);
  },

  async refresh(_params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    return await runtime.serviceManager.refresh();
  },

  async logs(params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }, stream: (payload: unknown) => void) {
    const serviceId = parseServiceId(params.service);
    const follow = params.follow === true;
    if (!follow) {
      return { entries: runtime.logStore.list().filter((entry) => entry.source === serviceId) };
    }
    const seen = new Set<string>();
    for (const entry of runtime.logStore.list()) {
      if (entry.source === serviceId) {
        seen.add(entry.id);
        stream({ kind: "entry", entry });
      }
    }
    runtime.logStore.onEntry((entry) => {
      if (entry.source !== serviceId || seen.has(entry.id)) return;
      seen.add(entry.id);
      stream({ kind: "entry", entry });
    });
    // Live tail: the socket stays open until the client disconnects.
    return await new Promise<ControlResult>(() => undefined);
  },

  async install(params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }, stream: (payload: unknown) => void) {
    const version = typeof params.version === "string" && params.version ? params.version : undefined;
    await runtime.payloadManager.ensurePythonRuntime((message) => {
      stream({ kind: "progress", progress: { phase: "preparing", percent: 1, label: message, updatedAt: Date.now() } });
    });
    if (version) {
      await runtime.maiBotDeploymentManager.install(version, (progress) => stream({ kind: "progress", progress }));
    } else {
      await runtime.maiBotDeploymentManager.ensureInstalled((progress) => stream({ kind: "progress", progress }));
    }
    return await runtime.serviceManager.snapshot();
  },

  async rollback(_params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    await runtime.maiBotDeploymentManager.rollback();
    return await runtime.serviceManager.snapshot();
  },

  async versions(_params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    await runtime.payloadManager.ensurePythonRuntime();
    return await runtime.pythonDependencyManager.listMaiBotVersions();
  },

  async eulaStatus(_params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    return await runtime.initManager.getAgreementState();
  },

  async eulaAccept(_params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    await runtime.initManager.confirmAgreements();
    return await runtime.initManager.getAgreementState();
  },

  async doctor(_params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    const payload = await runtime.payloadManager.inspect();
    const services = runtime.serviceManager.snapshot();
    return { payload, services, paths: runtime.paths };
  },

  async shutdown(_params: Record<string, unknown>, { runtime }: { runtime: HeadlessRuntime }) {
    await runtime.serviceManager.shutdownAll();
    return { bye: true };
  },
};

export function createSupervisorHandlers(): Map<string, CommandHandler> {
  return createCommandRegistry(handlers);
}

export async function readServePid(runtime: HeadlessRuntime): Promise<number | undefined> {
  const path = `${runtime.paths.userDataRoot}/serve.pid`;
  if (!existsSync(path)) return undefined;
  const content = await readFile(path, "utf8").catch(() => "");
  const pid = Number(content.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export { assertNoActiveServices };
