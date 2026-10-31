import { existsSync, rmSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HeadlessRuntime } from "./bootstrap";

/**
 * Newline-delimited JSON control protocol over a Unix domain socket.
 * Requests:   {"id":1,"cmd":"status","params":{...}}
 * Responses:  {"id":1,"ok":true,"data":...} | {"id":1,"ok":false,"error":"..."}
 * Push:       {"id":1,"stream":"log","data":{...}} | {"id":1,"stream":"end"}
 */
export interface ControlRequest {
  id: number;
  cmd: string;
  params?: Record<string, unknown>;
}

type Responder = (payload: unknown) => void;

export interface CommandContext {
  runtime: HeadlessRuntime;
}

/**
 * Handlers may push streaming frames through `respond` before returning the
 * final payload (their return value becomes the terminal frame).
 */
export type CommandHandler = (params: Record<string, unknown>, ctx: CommandContext, respond: Responder) => Promise<unknown> | unknown;

export function createCommandRegistry(handlers: Record<string, CommandHandler>): Map<string, CommandHandler> {
  return new Map(Object.entries(handlers));
}

export function serveControlSocket(runtime: HeadlessRuntime, socketPath: string, registry: Map<string, CommandHandler>): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    if (existsSync(socketPath)) {
      // A stale socket from a crashed supervisor: only remove it when nothing answers.
      const probe = connect(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        reject(new Error(`已有 supervisor 在运行（${socketPath}）`));
      });
      probe.once("error", () => {
        rmSync(socketPath, { force: true });
        start();
      });
      return;
    }
    start();

    function start(): void {
      mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined);
      const server = createServer((socket) => {
        void handleConnection(socket, runtime, registry);
      });
      server.once("error", reject);
      server.listen(socketPath, () => resolveServer(server));
    }
  });
}

async function handleConnection(socket: Socket, runtime: HeadlessRuntime, registry: Map<string, CommandHandler>): Promise<void> {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) void dispatchLine(socket, line, runtime, registry);
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("error", () => undefined);
}

function respond(socket: Socket, payload: unknown): void {
  if (!socket.writable) return;
  socket.write(`${JSON.stringify(payload)}\n`);
}

async function dispatchLine(socket: Socket, line: string, runtime: HeadlessRuntime, registry: Map<string, CommandHandler>): Promise<void> {
  let request: ControlRequest;
  try {
    request = JSON.parse(line) as ControlRequest;
  } catch (error) {
    respond(socket, { id: null, ok: false, error: `无效请求: ${String(error)}` });
    return;
  }
  const handler = registry.get(request.cmd);
  if (!handler) {
    respond(socket, { id: request.id, ok: false, error: `未知命令: ${request.cmd}` });
    return;
  }
  const stream = (payload: unknown): void => {
    respond(socket, { id: request.id, stream: true, data: payload });
  };
  try {
    const data = await handler(request.params ?? {}, { runtime }, stream);
    respond(socket, { id: request.id, ok: true, data });
  } catch (error) {
    respond(socket, { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export interface ControlResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** One-shot request against a live supervisor; resolves with the final frame. */
export function requestControl(socketPath: string, cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<ControlResult> {
  return new Promise((resolveRequest, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`控制请求超时（${timeoutMs}ms）: ${cmd}`));
    }, timeoutMs);
    const finish = (result: { ok: boolean; data?: unknown; error?: string }): void => {
      clearTimeout(timer);
      resolveRequest(result);
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, cmd, params })}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          newline = buffer.indexOf("\n");
          continue;
        }
        let frame: { id?: number; ok?: boolean; data?: unknown; error?: string; stream?: boolean };
        try {
          frame = JSON.parse(line);
        } catch {
          newline = buffer.indexOf("\n");
          continue;
        }
        if (frame.stream) {
          // Streaming frames are consumed by requestStream(); one-shot ignores them.
          newline = buffer.indexOf("\n");
          continue;
        }
        socket.destroy();
        finish({ ok: Boolean(frame.ok), data: frame.data, error: frame.error });
        return;
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Subscribe to streaming frames until the final response frame arrives. */
export function requestStream(socketPath: string, cmd: string, params: Record<string, unknown>, onData: (payload: unknown) => void, signal?: AbortSignal): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolveRequest, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (result: { ok: boolean; data?: unknown; error?: string }): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveRequest(result);
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, cmd, params })}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          newline = buffer.indexOf("\n");
          continue;
        }
        let frame: { id?: number; ok?: boolean; data?: unknown; error?: string; stream?: boolean };
        try {
          frame = JSON.parse(line);
        } catch {
          newline = buffer.indexOf("\n");
          continue;
        }
        if (frame.stream) {
          onData(frame.data);
        } else {
          finish({ ok: Boolean(frame.ok), data: frame.data, error: frame.error });
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    signal?.addEventListener("abort", () => finish({ ok: true }), { once: true });
  });
}

export async function writeServePidFile(userDataRoot: string, pid: number): Promise<string> {
  const path = join(userDataRoot, "serve.pid");
  await mkdir(userDataRoot, { recursive: true });
  await writeFile(path, `${pid}\n`, "utf8");
  return path;
}
