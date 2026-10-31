export { applyRuntimeResourcePaths, LEGACY_RESOURCE_LOCATION_FILE, RESOURCE_PATHS_FILE } from "./runtime-resource-paths";
import { app } from "electron";
import { dirname } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";
import { buildRuntimePaths, createInstallScope } from "../platform/runtime-paths";

export { createInstallScope };

function resolveInstallRoot(): string {
  return app.isPackaged ? dirname(process.execPath) : process.cwd();
}

/**
 * Electron adapter over the shared path builder. The headless CLI builds the
 * same object from XDG directories instead of `app.getPath`.
 */
export function configureRuntimePaths(): RuntimePaths {
  const installRoot = resolveInstallRoot();
  const paths = buildRuntimePaths({
    installRoot,
    payloadRoot: app.isPackaged ? process.resourcesPath : installRoot,
    appDataRoot: app.getPath("appData"),
    packaged: app.isPackaged,
  });
  app.setPath("userData", paths.userDataRoot);
  return paths;
}
