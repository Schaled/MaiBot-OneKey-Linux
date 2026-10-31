import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NetworkProxySettings, RuntimePaths } from "../../shared/contracts";
import type { ProxyApplier } from "../platform/types";

const NETWORK_PROXY_CONFIG_FILE = "network-proxy.json";
const DEFAULT_PROXY_PORT = 7890;
const PROXY_ENV_BYPASS_RULES = "localhost,127.0.0.1,::1";
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;
const FORWARDED_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export class NetworkProxyManager {
  private readonly configPath: string;
  private readonly originalProxyEnv = new Map<string, string | undefined>();
  private readonly applier: ProxyApplier;
  private cache: NetworkProxySettings;
  private fetchPatched = false;

  constructor(paths: RuntimePaths, applier: ProxyApplier) {
    this.configPath = join(paths.userDataRoot, NETWORK_PROXY_CONFIG_FILE);
    this.applier = applier;
    for (const key of PROXY_ENV_KEYS) {
      this.originalProxyEnv.set(key, process.env[key]);
    }
    this.cache = this.read();
    this.applyEnvironment(this.cache);
  }

  getSettings(): NetworkProxySettings {
    return { ...this.cache };
  }

  async applyStoredSettings(): Promise<NetworkProxySettings> {
    this.installFetchHook();
    this.applyEnvironment(this.cache);
    await this.applier.apply({
      enabled: this.cache.enabled,
      proxyRules: localProxyUrl(this.cache.port),
      bypassRules: PROXY_ENV_BYPASS_RULES,
    });
    return this.getSettings();
  }

  async saveSettings(settings: NetworkProxySettings): Promise<NetworkProxySettings> {
    const normalized = normalizeNetworkProxySettings(settings);
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(
      this.configPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8",
    );
    this.cache = normalized;
    await this.applyStoredSettings();
    return this.getSettings();
  }

  async resetSettings(): Promise<NetworkProxySettings> {
    this.cache = defaultNetworkProxySettings();
    await this.applyStoredSettings();
    return this.getSettings();
  }

  private read(): NetworkProxySettings {
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<NetworkProxySettings>;
      return normalizeNetworkProxySettings(raw);
    } catch {
      return defaultNetworkProxySettings();
    }
  }

  private installFetchHook(): void {
    if (this.fetchPatched || !this.applier.isReady() || !this.applier.fetch || typeof globalThis.fetch !== "function") {
      return;
    }

    const hostFetch = this.applier.fetch.bind(this.applier);
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof URL ? input.toString() : input;
      if (typeof request === "string" || isRequestLike(request)) {
        return hostFetch(request as string, init) as unknown as Promise<Response>;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    this.fetchPatched = true;
  }

  private applyEnvironment(settings: NetworkProxySettings): void {
    if (settings.enabled) {
      const proxyUrl = localProxyUrl(settings.port);
      for (const key of FORWARDED_PROXY_ENV_KEYS) {
        process.env[key] = proxyUrl;
      }
      process.env.NO_PROXY = PROXY_ENV_BYPASS_RULES;
      process.env.no_proxy = PROXY_ENV_BYPASS_RULES;
      return;
    }

    for (const key of PROXY_ENV_KEYS) {
      const originalValue = this.originalProxyEnv.get(key);
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }
}

function defaultNetworkProxySettings(): NetworkProxySettings {
  return {
    enabled: false,
    port: DEFAULT_PROXY_PORT,
  };
}

function normalizeNetworkProxySettings(value: Partial<NetworkProxySettings>): NetworkProxySettings {
  return {
    enabled: value.enabled === true,
    port: normalizeProxyPort(value.port ?? DEFAULT_PROXY_PORT),
  };
}

function normalizeProxyPort(value: unknown): number {
  const port = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("\u4ee3\u7406\u7aef\u53e3\u9700\u8981\u662f 1-65535 \u4e4b\u95f4\u7684\u6574\u6570\u3002");
  }
  return port;
}

function localProxyUrl(port: number): string {
  return `http://127.0.0.1:${normalizeProxyPort(port)}`;
}

function isRequestLike(value: unknown): value is Request {
  return typeof value === "object" && value !== null && "url" in value && "method" in value;
}
