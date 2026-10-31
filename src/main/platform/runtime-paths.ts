import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";
import { applyRuntimeResourcePaths, readStoredResourcePaths } from "../services/runtime-resource-paths";
import { developmentRuntimeProfile, resolvePythonEnvironmentRoot } from "../services/service-startup-defaults";

export interface RuntimePathsInput {
  /** Directory the launcher lives in; also the default instance root for portable layouts. */
  installRoot: string;
  /** Directory holding `runtime/`, `modules/` and `maibot/` payloads. */
  payloadRoot: string;
  /** Root that per-install settings directories are created under. */
  appDataRoot: string;
  /** True for a shipped build, false when running from a checkout. */
  packaged: boolean;
  /** Overrides the default module/instance root. */
  resourceRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export function createInstallScope(installRoot: string): string {
  return createHash("sha256").update(installRoot).digest("hex").slice(0, 12);
}

/**
 * Pure builder shared by the Electron main process and the headless CLI.
 *
 * The Electron adapter passes `app.getPath("appData")` and `process.resourcesPath`;
 * the CLI passes XDG directories. Everything downstream of this function is
 * host-agnostic.
 */
export function buildRuntimePaths(input: RuntimePathsInput): RuntimePaths {
  const env = input.env ?? process.env;
  const { installRoot, payloadRoot, packaged } = input;
  const profile = developmentRuntimeProfile(installRoot, packaged, env);
  const userDataRoot = join(
    input.appDataRoot,
    "MaiBotOneKeyDesktop",
    `${createInstallScope(installRoot)}${profile.settingsSuffix}`,
  );
  const defaultResourceRoot = input.resourceRoot ?? (packaged ? userDataRoot : profile.resourceRoot ?? installRoot);
  const defaults = {
    maibot: profile.sourceRoot ?? join(defaultResourceRoot, "modules", "MaiBot"),
    napcat: join(defaultResourceRoot, "modules", "napcat"),
    snowluma: join(defaultResourceRoot, "modules", "SnowLuma"),
  };
  const stored = readStoredResourcePaths(userDataRoot);

  const paths: RuntimePaths = {
    maibotDevMode: profile.mode,
    packaged,
    installRoot,
    payloadRoot,
    userDataRoot,
    defaultResourceRoot,
    resourceRoot: defaultResourceRoot,
    modulesRoot: join(defaultResourceRoot, "modules"),
    defaultMaibotRoot: defaults.maibot,
    maibotRoot: defaults.maibot,
    defaultNapcatRoot: defaults.napcat,
    napcatRoot: defaults.napcat,
    defaultSnowlumaRoot: defaults.snowluma,
    snowlumaRoot: defaults.snowluma,
    bundledModulesRoot: join(payloadRoot, "modules"),
    runtimeRoot: join(payloadRoot, "runtime"),
    pythonEnvRoot: resolvePythonEnvironmentRoot(installRoot, defaultResourceRoot, packaged, env),
    logsRoot: join(userDataRoot, "logs"),
  };
  applyRuntimeResourcePaths(paths, profile.mode === "source" ? { ...stored, maibot: profile.sourceRoot } : stored);
  return paths;
}
