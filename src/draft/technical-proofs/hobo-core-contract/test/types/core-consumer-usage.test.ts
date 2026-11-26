import assert from "node:assert/strict";
import { test } from "vitest";

import { createEventEnvelope, createPortDescriptor } from "../../src/core-contract.js";
import type { EventEnvelope, ProviderPort, RuntimePort } from "../../src/core-contract.d.js";

test("@hobo/core type surface can be imported by a consumer package", () => {
  const runtime: RuntimePort = createPortDescriptor({
    kind: "runtime",
    name: "EventStore",
    interface: "hobo:runtime/event-store@0.1.0",
    stability: "stable",
  });
  const provider: ProviderPort = createPortDescriptor({
    kind: "provider",
    name: "CloudProvider",
    interface: "hobo:provider/cloud@0.1.0",
    stability: "preview",
  });
  const envelope: EventEnvelope<{ ok: true }> = createEventEnvelope({
    id: "evt-type-import",
    type: "contract.Checked",
    tenant: "tenant-acme",
    streamId: "contract/core",
    seq: 1,
    ts: "2026-06-25T12:00:00.000Z",
    actor: { kind: "service", id: "svc:contract" },
    correlationId: "corr-type-import",
    causationId: "cmd-type-import",
    data: { ok: true },
  });

  assert.equal(runtime.kind, "runtime");
  assert.equal(provider.kind, "provider");
  assert.equal(envelope.data.ok, true);
});
