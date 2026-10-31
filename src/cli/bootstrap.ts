import type { RuntimePaths } from "../shared/contracts";
import { buildRuntimePaths } from "../main/platform/runtime-paths";
import { createProcessController } from "../main/platform/process-controller";
import { pipeSessionTransportFactory } from "../main/platform/pipe-transport";
import { EnvProxyApplier } from "../main/platform/env-proxy-applier";
import { PayloadManager } from "../main/platform/payload-manager";
import { InitManager } from "../main/services/init-manager";
import { LogStore } from "../main/services/log-store";
import { LauncherUiSettingsManager } from "../main/services/launcher-ui-settings-manager";
import { MaiBotDeploymentManager } from "../main/services/maibot-deployment-manager";
import { ModuleUpdater } from "../main/services/module-updater";
import { NetworkProxyManager } from "../main/services/network-proxy-manager";
import { ProtocolBackendManager } from "../main/services/protocol-backend-manager";
import { ProtocolComponentManager } from "../main/services/protocol-component-manager";
import { PythonDependencyManager } from "../main/services/python-dependency-manager";
import { ResourceLocationManager } from "../main/services/resource-location-manager";
import { RuntimeOperationLock } from "../main/services/runtime-operation-lock";
import { ServiceManager } from "../main/services/service-manager";
import { SourceSettingsManager } from "../main/services/source-settings-manager";
import { PtySessionManager } from "../main/pty/pty-session-manager";
import { resolveHeadlessLayout, type HeadlessLayout, type LayoutOptions } from "./paths";

/**
 * The same object graph the Electron main process builds in src/main/index.ts,
 * but with headless host implementations injected and no `electron` import
 * anywhere on this path.
 */
export interface HeadlessRuntime {
  layout: HeadlessLayout;
  paths: RuntimePaths;
  runtimeOperationLock: RuntimeOperationLock;
  resourceLocationManager: ResourceLocationManager;
  logStore: LogStore;
  initManager: InitManager;
  networkProxyManager: NetworkProxyManager;
  launcherUiSettingsManager: LauncherUiSettingsManager;
  sourceSettingsManager: SourceSettingsManager;
  moduleUpdater: ModuleUpdater;
  pythonDependencyManager: PythonDependencyManager;
  maiBotDeploymentManager: MaiBotDeploymentManager;
  ptySessionManager: PtySessionManager;
  serviceManager: ServiceManager;
  payloadManager: PayloadManager;
  protocolBackendManager: ProtocolBackendManager;
  protocolComponentManager: ProtocolComponentManager;
}

export function createHeadlessRuntime(options: LayoutOptions = {}): HeadlessRuntime {
  const layout = resolveHeadlessLayout(options);
  const paths = buildRuntimePaths({
    installRoot: layout.installRoot,
    payloadRoot: layout.payloadRoot,
    appDataRoot: layout.appDataRoot,
    packaged: true,
    resourceRoot: layout.instanceRoot,
  });

  const runtimeOperationLock = new RuntimeOperationLock();
  const logStore = new LogStore(paths);
  const initManager = new InitManager(paths);
  const networkProxyManager = new NetworkProxyManager(paths, new EnvProxyApplier());
  const launcherUiSettingsManager = new LauncherUiSettingsManager(paths);
  const sourceSettingsManager = new SourceSettingsManager(paths);
  const moduleUpdater = new ModuleUpdater(paths);
  const pythonDependencyManager = new PythonDependencyManager(paths, sourceSettingsManager);
  const maiBotDeploymentManager = new MaiBotDeploymentManager(paths, sourceSettingsManager);
  const payloadManager = new PayloadManager(paths);
  initManager.setDeploymentManager(maiBotDeploymentManager);
  initManager.setPayloadManager(payloadManager);
  moduleUpdater.setDeploymentManager(maiBotDeploymentManager);
  const ptySessionManager = new PtySessionManager(pipeSessionTransportFactory);
  const serviceManager = new ServiceManager(
    paths,
    initManager,
    logStore,
    ptySessionManager,
    pythonDependencyManager,
    runtimeOperationLock,
    createProcessController(),
    payloadManager,
  );
  const resourceLocationManager = new ResourceLocationManager(paths, true, runtimeOperationLock, () => {
    const active = serviceManager
      .snapshot()
      .filter((service) => service.managed || ["starting", "running", "stopping"].includes(service.status));
    if (active.length > 0) {
      throw new Error(`请先停止所有服务，再操作组件目录：${active.map((service) => service.name).join("、")}`);
    }
  });
  return {
    layout,
    paths,
    runtimeOperationLock,
    resourceLocationManager,
    logStore,
    initManager,
    networkProxyManager,
    launcherUiSettingsManager,
    sourceSettingsManager,
    moduleUpdater,
    pythonDependencyManager,
    maiBotDeploymentManager,
    ptySessionManager,
    serviceManager,
    payloadManager,
    protocolBackendManager: initManager.protocols,
    protocolComponentManager: initManager.protocolComponents,
  };
}

export function assertNoActiveServices(runtime: HeadlessRuntime): void {
  const active = runtime.serviceManager
    .snapshot()
    .filter((service) => service.managed || ["starting", "running", "stopping"].includes(service.status));
  if (active.length > 0) {
    throw new Error(`请先停止所有服务，再操作组件目录：${active.map((service) => service.name).join("、")}`);
  }
}
