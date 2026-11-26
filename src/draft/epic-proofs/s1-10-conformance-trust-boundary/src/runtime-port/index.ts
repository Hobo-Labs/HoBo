import { RUNTIME_PORT_CHECKS } from "./checks.js";
import { parseRuntimePortReport } from "./parse.js";
import {
  RUNTIME_PORT_CONFORMANCE_VERSION,
  type RuntimeDurabilityBackend,
  type RuntimePortConformanceReport,
} from "./types.js";

export {
  RUNTIME_PORT_CONFORMANCE_VERSION,
  type RuntimeDurabilityBackend,
  type RuntimePortConformanceReport,
} from "./types.js";
export { proveCheckoutDurability } from "./checkout-proof.js";
export { parseRuntimePortReport } from "./parse.js";

export async function runRuntimePortDurabilitySuite(
  createBackend: () => RuntimeDurabilityBackend,
): Promise<RuntimePortConformanceReport> {
  if (!(createBackend instanceof Function)) {
    throw new TypeError("createBackend must be a function");
  }

  const probe = createBackend();
  const checks = [];
  const failures = [];

  for (const definition of RUNTIME_PORT_CHECKS) {
    const backend = createBackend();
    let passed = false;
    let message = definition.failureMessage;

    try {
      passed = await definition.run(backend);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    checks.push(Object.freeze({
      checkId: definition.checkId,
      port: definition.port,
      tag: "local" as const,
      status: passed ? ("pass" as const) : ("fail" as const),
    }));

    if (!passed) {
      failures.push(Object.freeze({
        checkId: definition.checkId,
        message,
      }));
    }
  }

  return parseRuntimePortReport({
    contract: RUNTIME_PORT_CONFORMANCE_VERSION,
    backend: probe.name,
    status: failures.length === 0 ? "pass" : "fail",
    checks,
    failures,
    coverage: {
      local: {
        status: failures.length === 0 ? "pass" : "fail",
        passed: checks.filter((check) => check.status === "pass").length,
        failed: failures.length,
        total: checks.length,
      },
    },
  });
}
