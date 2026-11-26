import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { parseEventEnvelope } from "../src/index.js";

const pactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contracts",
  "core-contract-boundary.pact.json",
);

test("CoreContractBoundary pact loads consumer/provider names and envelope parse satisfies the boundary contract", () => {
  const pact = JSON.parse(readFileSync(pactPath, "utf8"));

  assert.equal(pact.consumer.name, "@hobo/runtime");
  assert.equal(pact.provider.name, "CoreContractBoundary");
  assert.equal(pact.metadata.pactSpecification.version, "3.0.0");
  assert.equal(pact.interactions[0]?.response.body.ok, true);

  const envelope = parseEventEnvelope({
    id: "evt-pact",
    type: "deployment.Planned",
    v: 1,
    streamId: "deployment:01H",
    seq: 0,
    ts: "2026-07-01T00:00:00.000Z",
    actor: { kind: "system", id: "system:boundary" },
    tenant: "tenant-demo",
    data: {},
  });
  assert.equal(envelope.type, "deployment.Planned");
});
