import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canDeployWithRawEdges,
  createRawView,
  defineProjectionSink,
} from "../src/raw-driver-escape-hatch.js";

test("raw reads bind to the resolved driver and record portability debt for can-deploy", () => {
  const view = createRawView(
    defineProjectionSink({
      name: "tickets",
      driver: "postgres",
      rawAccess: true,
      source: "projected",
    }),
  );

  const result = view.raw((pg) => pg.query("select * from tickets where tenant_id = $1", ["tenant-a"], {
    tenantScope: "tenant-a",
  }));

  assert.equal(result.operation.driver, "postgres");
  assert.deepEqual(result.manifest.rawEdges, [
    {
      code: "RAW_DRIVER_ESCAPE_HATCH",
      driver: "postgres",
      projection: "tickets",
      readOnly: true,
      satisfiedBy: ["postgres"],
    },
  ]);
  assert.deepEqual(result.planWarnings, [
    {
      code: "RAW_DRIVER_PORTABILITY_DEBT",
      driver: "postgres",
      projection: "tickets",
      severity: "portability-debt",
    },
  ]);
  assert.deepEqual(canDeployWithRawEdges(result.manifest.rawEdges, ["postgres"]), {
    ok: true,
    warnings: result.planWarnings,
  });
  assert.deepEqual(canDeployWithRawEdges(result.manifest.rawEdges, ["mongo"]), {
    ok: false,
    reason: "raw edge tickets requires postgres; unsatisfied by mongo",
    warnings: result.planWarnings,
  });
});

test("raw writes are rejected on projected sinks and allowed only for authoritative external stores", () => {
  const projected = createRawView(
    defineProjectionSink({
      name: "tickets",
      driver: "postgres",
      rawAccess: true,
      source: "projected",
    }),
  );

  assert.throws(
    () => projected.raw((pg) => pg.execute("update tickets set status = 'closed' where id = $1", ["ticket-1"])),
    /raw writes require an authoritative-external store/,
  );

  const adopted = createRawView(
    defineProjectionSink({
      name: "legacyTickets",
      driver: "postgres",
      rawAccess: true,
      source: "authoritative-external",
    }),
  );

  assert.equal(
    adopted.raw((pg) => pg.execute("update legacy_tickets set status = 'closed' where id = $1", ["ticket-1"]))
      .operation.access,
    "write",
  );
});

test("raw reads on pooled tenant stores must prove hand-scoping", () => {
  const view = createRawView(
    defineProjectionSink({
      name: "tickets",
      driver: "postgres",
      rawAccess: true,
      source: "projected",
      pooledMultiTenant: true,
    }),
    { tenantId: "tenant-a" },
  );

  assert.deepEqual(
    view.raw((pg) => pg.query("select * from tickets", [])).isolationWarnings,
    [
      {
        code: "RAW_TENANT_SCOPE_UNPROVEN",
        projection: "tickets",
        severity: "isolation-debt",
      },
    ],
  );
  assert.deepEqual(
    view.raw((pg) => pg.query("select * from tickets where tenant_id = $1", ["tenant-b"], {
      tenantScope: "tenant-b",
    })).isolationWarnings,
    [
      {
        code: "RAW_TENANT_SCOPE_MISMATCH",
        expectedTenant: "tenant-a",
        projection: "tickets",
        severity: "isolation-debt",
        tenantScope: "tenant-b",
      },
    ],
  );
  assert.deepEqual(
    view.raw((pg) => pg.query("select * from tickets where tenant_id = $1", ["tenant-a"], {
      tenantScope: "tenant-a",
    })).isolationWarnings,
    [],
  );
});

test("raw calls fail closed when the resolved sink does not advertise raw access", () => {
  const view = createRawView(
    defineProjectionSink({
      name: "tickets",
      driver: "native",
      rawAccess: false,
      source: "projected",
    }),
  );

  assert.throws(() => view.raw((driver) => driver.read()), /raw access not advertised by tickets/);
});
