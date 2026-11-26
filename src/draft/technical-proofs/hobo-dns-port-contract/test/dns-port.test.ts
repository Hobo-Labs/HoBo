import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  createInMemoryDnsAdapter,
  createPreValidationDnsPort,
  routingPolicy,
  runDnsConformance,
} from "../src/dns-port.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("WIT and TypeScript surfaces publish the hobo:dns port contract", async () => {
  const wit = await readFile(path.join(packageRoot, "wit", "world.wit"), "utf8");
  const declarations = await readFile(path.join(packageRoot, "src", "dns-port.d.ts"), "utf8");

  assert.match(wit, /package hobo:dns@0\.1\.0;/);
  assert.match(wit, /upsert-record: func\(record: dns-record\) -> result<dns-change, dns-error>;/);
  assert.match(wit, /read-records: func\(name: string\) -> result<list<dns-record>, dns-error>;/);
  assert.match(wit, /delete-record: func\(name: string, record-type: record-type\) -> result<dns-change, dns-error>;/);
  assert.match(wit, /variant routing-policy/);
  assert.match(declarations, /export interface DnsPort/);
  assert.match(declarations, /export type RoutingPolicy/);
});

test("pre-validation DNS port programs and reads records only in the shadow zone", async () => {
  const adapter = createInMemoryDnsAdapter({ id: "local-dns" });
  const dns = createPreValidationDnsPort({
    domain: "shop.com",
    camp: "prod-us",
    adapter,
  });

  const policy = routingPolicy("weighted", [
    { camp: "prod-us", weight: 90 },
    { camp: "prod-eu", weight: 10 },
  ]);

  const change = await dns.upsertRecord({
    name: "api.shop.com",
    type: "A",
    ttl: 60,
    targets: [{ camp: "prod-us", value: "203.0.113.10" }],
    policy,
  });

  assert.equal(change.zone, "shadow");
  assert.equal(change.event.type, "domain.RoutingChanged");
  assert.deepEqual(await dns.readRecords("api.shop.com"), [
    {
      name: "api.shop.com",
      type: "A",
      ttl: 60,
      targets: [{ camp: "prod-us", value: "203.0.113.10" }],
      policy,
    },
  ]);
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), []);
  assert.equal("promoteLive" in dns, false);
  assert.equal("writeLive" in dns, false);
});

test("routing policy params validate instead of coercing malformed input", () => {
  assert.deepEqual(routingPolicy("latency", [{ camp: "prod-us", region: "us-east" }]), {
    kind: "latency",
    targets: [{ camp: "prod-us", region: "us-east" }],
  });
  assert.deepEqual(routingPolicy("geo", [{ camp: "prod-eu", geo: "EU" }]), {
    kind: "geo",
    targets: [{ camp: "prod-eu", geo: "EU" }],
  });
  assert.throws(
    () =>
      routingPolicy("weighted", [
        { camp: "prod-us", weight: 125 },
        { camp: "prod-eu", weight: -25 },
      ]),
    /positive/i,
  );
  assert.throws(
    () =>
      routingPolicy("failover", [
        { camp: "prod-us", priority: 1 },
        { camp: "prod-eu", priority: 1 },
      ]),
    /unique priority/i,
  );
  assert.throws(
    () => routingPolicy("cost", [{ camp: "prod-us", replicaClass: "single-writer" }]),
    /cost routing requires active-active-eventual or pinned/i,
  );
});

test("per-Camp overrides are preserved in shadow records and delete emits a domain event", async () => {
  const adapter = createInMemoryDnsAdapter({ id: "local-dns" });
  const dns = createPreValidationDnsPort({
    domain: "shop.com",
    camp: "yard-global",
    adapter,
  });

  await dns.upsertRecord({
    name: "shop.com",
    type: "CNAME",
    ttl: 120,
    targets: [{ camp: "prod-us", value: "edge-global.example.net" }],
    policy: routingPolicy("geo", [
      { camp: "prod-us", geo: "NA" },
      { camp: "prod-eu", geo: "EU" },
    ]),
    campOverrides: [
      {
        camp: "prod-eu",
        targets: [{ camp: "prod-eu", value: "edge-eu.example.net" }],
      },
    ],
  });

  assert.deepEqual((await dns.readRecords("shop.com"))[0].campOverrides, [
    {
      camp: "prod-eu",
      targets: [{ camp: "prod-eu", value: "edge-eu.example.net" }],
    },
  ]);

  const deletion = await dns.deleteRecord("shop.com", "CNAME");

  assert.equal(deletion.zone, "shadow");
  assert.equal(deletion.event.type, "domain.RecordDeleted");
  assert.deepEqual(await dns.readRecords("shop.com"), []);
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), []);
});

test("conformance fails an adapter that writes live records during a shadow call", async () => {
  const adapter = createInMemoryDnsAdapter({
    id: "lying-dns",
    shadowWritesAlsoTouchLive: true,
  });

  const report = await runDnsConformance(adapter, {
    domain: "shop.com",
    camp: "prod-us",
  });

  assert.equal(report.ok, false);
  assert.match(report.failures.join("\n"), /live zone changed during shadow write/);
});
