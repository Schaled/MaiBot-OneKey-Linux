import { basename } from "node:path";

export interface NapCatComposeOptions {
  instanceRoot: string;
  webuiPort: number;
  onebotPort: number;
  image?: string;
  /** Absolute napcat config dir ProtocolBackendManager writes to. */
  napcatConfigDir?: string;
}

/**
 * NapCat on Linux ships as a container image only (the npm package was
 * unpublished). The compose file binds both ports to loopback and mounts the
 * instance's napcat config so `ProtocolBackendManager` writes land in the
 * container.
 */
function composeQqVolume(options: NapCatComposeOptions): string {
  return `${options.napcatConfigDir?.replace(/\/napcat\/config$/u, "") ?? "."}/qq`;
}

export function generateNapCatCompose(options: NapCatComposeOptions): string {
  const image = options.image ?? "mlikiowa/napcat-docker:latest";
  const project = `maibot-ok-napcat-${basename(options.instanceRoot).replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  return `# 由 maibot-ok 生成。NapCat WebUI: http://127.0.0.1:${options.webuiPort}/webui
# OneBot v11 正向 WebSocket 已由 ProtocolBackendManager 写入挂载的配置目录。
services:
  napcat:
    image: ${image}
    container_name: ${project}
    restart: unless-stopped
    environment:
      - NAPCAT_UID=${"${UID:-1000}"}
      - NAPCAT_GID=${"${GID:-1000}"}
      - ACCOUNT=
    ports:
      - "127.0.0.1:${options.webuiPort}:6099"
      - "127.0.0.1:${options.onebotPort}:3001"
    volumes:
      - ${options.napcatConfigDir ?? "./config"}:/app/napcat/config
      - ${options.napcatConfigDir ? composeQqVolume(options) : "./qq"}:/app/.config/QQ
`;
}
