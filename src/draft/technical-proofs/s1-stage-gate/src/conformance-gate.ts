import {
  RUNTIME_PORT_CONFORMANCE_VERSION,
  createRuntimeLocalDurabilityBackend,
  runRuntimePortDurabilitySuite,
} from "../../runtime-port-conformance-contract/src/runtime-port-conformance.js";
import {
  COMPONENT_HOST_CONFORMANCE_SCHEMA,
  createReferenceComponentHostManifest,
  createReferenceInContainerHost,
  createReferenceRuntimeLocalHost,
  runComponentHostConformance,
} from "../../component-host-conformance-suite/src/component-host-conformance.js";

export type ConformanceGateResult = {
  readonly runtimePortContract: string;
  readonly runtimePortStatus: "pass" | "fail";
  readonly componentHostSchema: string;
  readonly componentHostStatus: "pass" | "fail";
};

export async function runRuntimePortConformanceGate(): Promise<{
  contract: string;
  status: "pass" | "fail";
  report: Awaited<ReturnType<typeof runRuntimePortDurabilitySuite>>;
}> {
  const report = await runRuntimePortDurabilitySuite(createRuntimeLocalDurabilityBackend);
  return Object.freeze({
    contract: report.contract,
    status: report.status,
    report,
  });
}

export async function runComponentHostConformanceGate(): Promise<{
  schema: string;
  status: "pass" | "fail";
  report: Awaited<ReturnType<typeof runComponentHostConformance>>;
}> {
  const manifest = createReferenceComponentHostManifest();
  const report = await runComponentHostConformance({
    manifest,
    hosts: [createReferenceRuntimeLocalHost(), createReferenceInContainerHost()],
  });

  return Object.freeze({
    schema: report.schema,
    status: report.status,
    report,
  });
}

export async function runConformanceGate(): Promise<ConformanceGateResult> {
  const [runtimePort, componentHost] = await Promise.all([
    runRuntimePortConformanceGate(),
    runComponentHostConformanceGate(),
  ]);

  if (runtimePort.contract !== RUNTIME_PORT_CONFORMANCE_VERSION) {
    throw new Error(`unexpected runtime-port contract: ${runtimePort.contract}`);
  }

  if (componentHost.schema !== COMPONENT_HOST_CONFORMANCE_SCHEMA) {
    throw new Error(`unexpected component-host schema: ${componentHost.schema}`);
  }

  if (runtimePort.status !== "pass" || componentHost.status !== "pass") {
    throw new Error("conformance gate failed");
  }

  return Object.freeze({
    runtimePortContract: runtimePort.contract,
    runtimePortStatus: runtimePort.status,
    componentHostSchema: componentHost.schema,
    componentHostStatus: componentHost.status,
  });
}
