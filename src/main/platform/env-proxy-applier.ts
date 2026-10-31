import type { ProxyApplier } from "./types";

/**
 * Headless host. There is no Chromium session to configure, so the proxy is
 * expressed purely through the environment variables that every child process
 * (pip, node, uvicorn) inherits. `isReady` is always true because there is no
 * session that can still be booting.
 */
export class EnvProxyApplier implements ProxyApplier {
  isReady(): boolean {
    return true;
  }

  async apply(): Promise<void> {
    // Environment application happens in NetworkProxyManager.applyEnvironment,
    // which runs for every host. Nothing extra is required here.
  }
}
