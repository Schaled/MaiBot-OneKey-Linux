import { app, net, session } from "electron";
import type { ProxyApplier } from "./types";

const ELECTRON_PROXY_BYPASS_RULES = "localhost,127.0.0.1,::1,<local>";

/** Electron host: proxy applies to the default session and our own fetch calls. */
export class ElectronProxyApplier implements ProxyApplier {
  isReady(): boolean {
    return app.isReady();
  }

  async apply(settings: { enabled: boolean; proxyRules: string; bypassRules: string }): Promise<void> {
    if (!this.isReady()) return;
    const defaultSession = session.defaultSession;
    if (settings.enabled) {
      await defaultSession.setProxy({
        mode: "fixed_servers",
        proxyRules: settings.proxyRules,
        proxyBypassRules: ELECTRON_PROXY_BYPASS_RULES,
      });
    } else {
      await defaultSession.setProxy({ mode: "system" });
    }
    await defaultSession.closeAllConnections();
  }

  async fetch(input: string, init?: RequestInit): Promise<Response> {
    return (await net.fetch(input, init)) as unknown as Response;
  }
}
