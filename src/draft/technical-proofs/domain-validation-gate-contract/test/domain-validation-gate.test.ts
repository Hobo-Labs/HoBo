import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  createInMemoryDnsAdapter,
  createPreValidationDnsPort,
  routingPolicy,
} from "../../hobo-dns-port-contract/src/dns-port.js";
import {
  REQUIRED_CHECK_KINDS,
  assertValidationEventSequence,
  createDomainValidationGate,
  createLiveZoneSnapshot,
  domainValidationChecks,
} from "../src/domain-validation-gate.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscPath = path.resolve(
  packageRoot,
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);

test("WIT and TypeScript surfaces publish the domain validation gate contract", async () => {
  const wit = await readFile(path.join(packageRoot, "wit", "world.wit"), "utf8");
  const declarations = await readFile(
    path.join(packageRoot, "src", "domain-validation-gate.d.mts"),
    "utf8",
  );

  assert.match(wit, /package hobo:domain-validation-gate@0\.1\.0;/);
  assert.match(wit, /enum check-kind/);
  assert.match(wit, /multi-vantage-resolve/);
  assert.match(wit, /ttl-aware-propagation/);
  assert.match(wit, /acme-challenge/);
  assert.match(wit, /endpoint-health/);
  assert.match(wit, /domain\.ValidationStarted/);
  assert.match(wit, /domain\.ValidationFailed/);
  assert.match(wit, /domain\.Validated/);
  assert.match(declarations, /export interface DomainValidationGate/);
  assert.match(declarations, /export type CheckKind/);
});

test("typed declarations compile a validation gate consumer", () => {
  const result = spawnSync(process.execPath, [tscPath, "--noEmit", "--project", "tsconfig.json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n") ||
      "TypeScript exited non-zero",
  );
});

test("all green stub checks emit domain.Validated after staging through the shadow DNS port", async () => {
  const adapter = createInMemoryDnsAdapter({ id: "local-dns" });
  const dns = createPreValidationDnsPort({ domain: "shop.com", camp: "prod-us", adapter });
  const gate = createDomainValidationGate({
    checks: domainValidationChecks({
      "multi-vantage-resolve": { vantagePoints: ["1.1.1.1", "8.8.8.8"], expected: "203.0.113.10" },
      "ttl-aware-propagation": { waitedSeconds: 120, ttlSeconds: 60 },
      "acme-challenge": { challengeName: "_acme-challenge.shop.com" },
      "endpoint-health": { healthPath: "/healthz", status: 200 },
    }),
  });

  const result = await gate.validate({
    domain: "shop.com",
    changeId: "change-001",
    camp: "prod-us",
    liveZone: createLiveZoneSnapshot(adapter, "shop.com"),
    stage: () =>
      dns.upsertRecord({
        name: "api.shop.com",
        type: "A",
        ttl: 60,
        targets: [{ camp: "prod-us", value: "203.0.113.10" }],
        policy: routingPolicy("failover", [{ camp: "prod-us", priority: 1 }]),
      }),
  });

  assert.equal(result.status, "validated");
  assert.deepEqual(result.events.map((event) => event.type), [
    "domain.ValidationStarted",
    "domain.Validated",
  ]);
  assert.deepEqual(result.events[1].data.checks.map((check) => check.kind), REQUIRED_CHECK_KINDS);
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), []);
  assertValidationEventSequence(result.events);
});

test("a red check emits domain.ValidationFailed naming that check and blocks promotion", async () => {
  const adapter = createInMemoryDnsAdapter({ id: "local-dns" });
  const dns = createPreValidationDnsPort({ domain: "shop.com", camp: "prod-us", adapter });
  const checks = domainValidationChecks({
    "multi-vantage-resolve": { vantagePoints: ["1.1.1.1", "8.8.8.8"], expected: "203.0.113.10" },
    "ttl-aware-propagation": { waitedSeconds: 10, ttlSeconds: 60 },
    "acme-challenge": { challengeName: "_acme-challenge.shop.com" },
    "endpoint-health": { healthPath: "/healthz", status: 200 },
  });

  const result = await createDomainValidationGate({ checks }).validate({
    domain: "shop.com",
    changeId: "change-ttl",
    camp: "prod-us",
    liveZone: createLiveZoneSnapshot(adapter, "shop.com"),
    stage: () =>
      dns.upsertRecord({
        name: "api.shop.com",
        type: "A",
        ttl: 60,
        targets: [{ camp: "prod-us", value: "203.0.113.10" }],
      }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.events[1].type, "domain.ValidationFailed");
  assert.equal(result.events[1].data.failedCheck, "ttl-aware-propagation");
  assert.match(result.events[1].data.reason, /TTL/i);
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), []);
});

test("thrown and timed-out checks fail closed", async () => {
  const passing = () => Promise.resolve({ ok: true, evidence: { source: "stub" } });
  const throwingGate = createDomainValidationGate({
    timeoutMs: 50,
    checks: {
      "multi-vantage-resolve": passing,
      "ttl-aware-propagation": () => {
        throw new Error("resolver exploded");
      },
      "acme-challenge": passing,
      "endpoint-health": passing,
    },
  });
  const timeoutGate = createDomainValidationGate({
    timeoutMs: 10,
    checks: {
      "multi-vantage-resolve": passing,
      "ttl-aware-propagation": () => new Promise(() => {}),
      "acme-challenge": passing,
      "endpoint-health": passing,
    },
  });

  const request = {
    domain: "shop.com",
    changeId: "change-fail-closed",
    camp: "prod-us",
    stage: () => Promise.resolve({ event: { type: "domain.RoutingChanged" } }),
  };

  const thrown = await throwingGate.validate(request);
  const timedOut = await timeoutGate.validate(request);

  assert.equal(thrown.status, "failed");
  assert.equal(thrown.events[1].data.failedCheck, "ttl-aware-propagation");
  assert.match(thrown.events[1].data.reason, /resolver exploded/);
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.events[1].data.failedCheck, "ttl-aware-propagation");
  assert.match(timedOut.events[1].data.reason, /timed out/);
});

test("live zone invariant breaches fail closed before domain.Validated", async () => {
  const passing = () => Promise.resolve({ ok: true, evidence: { source: "stub" } });
  const gate = createDomainValidationGate({
    checks: {
      "multi-vantage-resolve": passing,
      "ttl-aware-propagation": passing,
      "acme-challenge": passing,
      "endpoint-health": passing,
    },
  });

  const result = await gate.validate({
    domain: "shop.com",
    changeId: "change-live-mutation",
    camp: "prod-us",
    stage: () => Promise.resolve({ event: { type: "domain.RoutingChanged" } }),
    liveZone: {
      assertUnchanged(label) {
        if (label === "multi-vantage-resolve") {
          throw new Error("live zone changed before validation");
        }
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.events[1].type, "domain.ValidationFailed");
  assert.equal(result.events[1].data.failedCheck, "live-zone-invariant");
  assert.equal(result.events[1].data.liveZoneUntouched, false);
  assert.match(result.events[1].data.reason, /live zone changed/);
});

test("conformance rejects a domain.Validated event while any required check is unfinished", () => {
  assert.throws(
    () =>
      assertValidationEventSequence([
        {
          type: "domain.ValidationStarted",
          data: { changeId: "bad", checks: REQUIRED_CHECK_KINDS },
        },
        {
          type: "domain.Validated",
          data: {
            changeId: "bad",
            checks: REQUIRED_CHECK_KINDS.slice(0, 3).map((kind) => ({ kind, status: "passed" })),
          },
        },
      ]),
    /missing passed check: endpoint-health/,
  );
});
