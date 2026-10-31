import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInstallScope } from "../main/platform/runtime-paths";

export interface HeadlessLayout {
  installRoot: string;
  payloadRoot: string;
  appDataRoot: string;
  instanceRoot: string;
  userDataRoot: string;
  socketPath: string;
  runtimeDir: string;
}

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
}

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
    ? process.env.XDG_DATA_HOME
    : join(homedir(), ".local", "share");
}

function xdgRuntimeDir(): string {
  const fallback = join("/tmp", `maibot-onekey-${process.getuid?.() ?? 0}`);
  const candidate = process.env.XDG_RUNTIME_DIR;
  if (candidate && isAbsolute(candidate) && existsSync(candidate)) return candidate;
  mkdirSync(fallback, { recursive: true, mode: 0o700 });
  return fallback;
}

export interface LayoutOptions {
  /** Payload directory; defaults to the checkout root when run from source. */
  payloadRoot?: string;
  /** Instance root override (--root). */
  instanceRoot?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Headless layout: payload (runtime/, modules/, cli/) lives in one directory,
 * per-instance data in another, per-install settings under XDG config, and the
 * control socket under XDG_RUNTIME_DIR.
 */
export function resolveHeadlessLayout(options: LayoutOptions = {}): HeadlessLayout {
  const env = options.env ?? process.env;
  const payloadRoot = resolve(options.payloadRoot ?? process.env.MAIBOT_ONEKEY_PAYLOAD ?? process.cwd());
  const instanceRoot = resolve(
    options.instanceRoot
      ?? (isAbsolute(env.MAIBOT_ONEKEY_INSTANCE ?? "") ? env.MAIBOT_ONEKEY_INSTANCE : undefined)
      ?? join(xdgDataHome(), "maibot-onekey", "instance"),
  );
  const appDataRoot = xdgConfigHome();
  const scope = createInstallScope(payloadRoot);
  const runtimeDir = join(xdgRuntimeDir(), "maibot-onekey");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  return {
    installRoot: payloadRoot,
    payloadRoot,
    appDataRoot,
    instanceRoot,
    userDataRoot: join(appDataRoot, "MaiBotOneKeyDesktop", scope),
    runtimeDir,
    socketPath: join(runtimeDir, `${scope}.sock`),
  };
}
