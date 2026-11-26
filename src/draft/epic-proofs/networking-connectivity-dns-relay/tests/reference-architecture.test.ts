import assert from "node:assert/strict";
import { test } from "vitest";

import { runNetworkingConnectivityDnsRelaySimulation } from "../services/networking-reference-architecture.js";

test("platform engineer gets secure cross-cloud connectivity without policy widening", async () => {
  const result = await runNetworkingConnectivityDnsRelaySimulation();

  assert.equal(result.epic.slug, "networking-connectivity-dns-relay");
  assert.equal(result.crossCloudBind.outcome, "deployable");
  assert.equal(result.crossCloudBind.tierPlan.tier, 3);
  assert.equal(result.crossCloudBind.policyGate.effect, "allow");
  assert.equal(result.crossCloudBind.mtls.ok, true);
  assert.equal(result.crossCloudBind.discovery.ok, true);
  assert.equal(result.crossCloudBind.junction.validation.ok, true);
  assert.deepEqual(result.crossCloudBind.junction.deliveryYards.sort(), ["yard-aws-us", "yard-azure-eu"]);
});

test("domain operator validates and promotes custom domains only through shadow DNS gates", async () => {
  const result = await runNetworkingConnectivityDnsRelaySimulation();

  assert.equal(result.domainPromotion.validation.status, "validated");
  assert.equal(result.domainPromotion.acme.status, "issued");
  assert.equal(result.domainPromotion.gateway.status, "ready");
  assert.equal(result.domainPromotion.routing.status, "routed");
  assert.equal(result.domainPromotion.liveZoneWrites, 0);
  assert.equal(result.domainPromotion.junctionDomain.status, "ready");
  assert.equal(result.domainPromotion.negativeRebinding.status, "failed");
  assert.equal(result.domainPromotion.negativeSplitHorizon.promotion, "blocked");
});

test("relay executor stays outbound-only and refuses SSRF and credential movement", async () => {
  const result = await runNetworkingConnectivityDnsRelaySimulation();

  assert.equal(result.relay.status, "attached");
  assert.equal(result.relay.execution.status, "completed");
  assert.equal(result.relay.network.outboundOnly, true);
  assert.deepEqual(result.relay.deniedAttempts.map((attempt) => attempt.code), [
    "relay.target.not-allowed",
    "relay.forward-proxy.denied",
    "relay.credential-egress.denied",
  ]);
});

test("tenant-aware ingress resolves ctx.tenant before handlers and blocks mismatch", async () => {
  const result = await runNetworkingConnectivityDnsRelaySimulation();

  assert.equal(result.tenantIngress.resolved.ok, true);
  assert.equal(result.tenantIngress.resolved.ctx.tenant, "tenant-alpha");
  assert.equal(result.tenantIngress.placement.kind, "region-pooled");
  assert.equal(result.tenantIngress.mismatch.ok, false);
  assert.equal(result.tenantIngress.mismatch.code, "tenant-routing.tenant-mismatch");
});

test("adversarial topology and policy cases fail closed", async () => {
  const result = await runNetworkingConnectivityDnsRelaySimulation();

  assert.equal(result.negative.policyWidening.effect, "deny");
  assert.equal(result.negative.overrideConflict.ok, false);
  assert.equal(result.negative.partitionSafety.status, "refused");
  assert.equal(result.negative.publicTierRequiresMtls.effect, "deny");
});
