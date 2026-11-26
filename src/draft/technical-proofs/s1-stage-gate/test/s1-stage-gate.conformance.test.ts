import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RUNTIME_PORT_CONFORMANCE_VERSION,
} from "../../runtime-port-conformance-contract/src/runtime-port-conformance.js";
import {
  COMPONENT_HOST_CONFORMANCE_SCHEMA,
} from "../../component-host-conformance-suite/src/component-host-conformance.js";
import { runConformanceGate } from "../src/conformance-gate.js";

test("runtime-port and component-host conformance suites pass for runtime-local", async () => {
  const result = await runConformanceGate();

  assert.equal(result.runtimePortContract, RUNTIME_PORT_CONFORMANCE_VERSION);
  assert.equal(result.runtimePortStatus, "pass");
  assert.equal(result.componentHostSchema, COMPONENT_HOST_CONFORMANCE_SCHEMA);
  assert.equal(result.componentHostStatus, "pass");
});
