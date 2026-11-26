import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createFixtureProviderSts,
  createOidcFederationBroker,
} from "../src/oidc-federation-sts.js";

const NOW = "2026-06-25T12:00:00.000Z";

const subject = {
  kind: "agent",
  id: "agent:release",
  delegatedBy: { kind: "user", id: "user:priya" },
};

const svid = {
  svidRef: "identity://svid/svid-110",
  issuer: "https://identity.prod-yard.example",
  subject: "spiffe://yard/tenant-a/agent/release",
  tenant: "tenant-a",
  audience: "hobo-broker",
  expiresAt: "2026-06-25T12:30:00.000Z",
  scope: [
    { port: "database", resource: "shop.db", actions: ["read", "write"] },
  ],
};

const databaseWrite = { port: "database", resource: "shop.db", action: "write" };

describe("OIDC federation provider STS exchange", () => {
  it("exchanges SVID-bound OIDC assertions with AWS, GCP, and Azure STS without reading static secrets", async () => {
    const scenarios = [
      {
        provider: "aws-prod",
        operation: "aws:AssumeRoleWithWebIdentity",
        flow: {
          type: "oidc-federation",
          providerKind: "aws",
          audience: "arn:aws:iam::123456789012:role/hobo-db-writer",
          exchange: "sts:AssumeRoleWithWebIdentity",
          roleArn: "arn:aws:iam::123456789012:role/hobo-db-writer",
          trust: { oidcDiscovery: "https://identity.prod-yard.example/.well-known/openid-configuration" },
        },
      },
      {
        provider: "gcp-prod",
        operation: "gcp:WorkloadIdentityFederation",
        flow: {
          type: "oidc-federation",
          providerKind: "gcp",
          audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/hobo/providers/yard",
          exchange: "gcp:workload-identity-federation",
          serviceAccount: "deploy@prod.iam.gserviceaccount.com",
          trust: { oidcDiscovery: "https://identity.prod-yard.example/.well-known/openid-configuration" },
        },
      },
      {
        provider: "azure-prod",
        operation: "azure:FederatedCredential",
        flow: {
          type: "oidc-federation",
          providerKind: "azure",
          audience: "api://AzureADTokenExchange",
          exchange: "azure:federated-credential",
          clientId: "00000000-0000-4000-8000-000000000110",
          trust: { oidcDiscovery: "https://identity.prod-yard.example/.well-known/openid-configuration" },
        },
      },
    ];

    for (const scenario of scenarios) {
      const events = [];
      const staticReads = [];
      const sts = createFixtureProviderSts({
        expiresAt: "2026-06-25T14:00:00.000Z",
      });
      const broker = createFixtureBroker({
        providerSts: sts,
        eventSink: (event) => events.push(event),
        staticCredentialReader: () => {
          staticReads.push("fixture-static-secret");
          throw new Error("static secrets must not be read");
        },
      });

      const result = await broker.requestToken(baseRequest({
        provider: scenario.provider,
        flow: scenario.flow,
      }));

      assert.equal(result.ok, true, scenario.provider);
      assert.equal(result.flow.operation, scenario.operation);
      assert.equal(result.credential.expiresAt, "2026-06-25T12:10:00.000Z");
      assert.deepEqual(result.credential.permissions, [
        { port: "database", resource: "shop.db", actions: ["write"] },
      ]);
      assert.deepEqual(staticReads, []);
      assert.equal(sts.calls.length, 1);
      assert.equal(sts.calls[0].operation, scenario.operation);
      assert.equal(sts.calls[0].assertionClaims.aud, scenario.flow.audience);
      assert.equal(sts.calls[0].assertionClaims.sub, svid.subject);
      assert.deepEqual(sts.calls[0].assertionClaims.scope, [
        { port: "database", resource: "shop.db", actions: ["write"] },
      ]);
      assert.deepEqual(events.map((event) => event.type), ["token.Granted", "token.Used"]);
      assert.equal(events[0].data.tokenRef, result.credential.credentialRef);
      assert.equal(events[0].data.expiresAt, result.credential.expiresAt);
      assert.equal(JSON.stringify(events).includes("fixture-static-secret"), false);
    }
  });

  it("rejects requests beyond the SVID scope before any provider STS exchange", async () => {
    const events = [];
    const sts = createFixtureProviderSts();
    const broker = createFixtureBroker({
      providerSts: sts,
      eventSink: (event) => events.push(event),
    });

    const result = await broker.requestToken(baseRequest({
      scope: { ...databaseWrite, action: "admin" },
    }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "requested scope is outside caller SVID scope");
    assert.equal(sts.calls.length, 0);
    assert.deepEqual(events.map((event) => event.type), ["token.Denied"]);
  });

  it("rejects provider federation without required trust setup before any provider STS exchange", async () => {
    const scenarios = [
      {
        flow: {
          type: "oidc-federation",
          providerKind: "aws",
          audience: "arn:aws:iam::123456789012:role/hobo-db-writer",
          exchange: "sts:AssumeRoleWithWebIdentity",
          trust: { oidcDiscovery: "https://identity.prod-yard.example/.well-known/openid-configuration" },
        },
        reason: "AWS AssumeRoleWithWebIdentity flow requires roleArn",
      },
      {
        flow: {
          type: "oidc-federation",
          providerKind: "gcp",
          audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/hobo/providers/yard",
          exchange: "gcp:workload-identity-federation",
          trust: { oidcDiscovery: "https://identity.prod-yard.example/.well-known/openid-configuration" },
        },
        reason: "GCP Workload Identity Federation flow requires serviceAccount",
      },
      {
        flow: {
          type: "oidc-federation",
          providerKind: "azure",
          audience: "api://AzureADTokenExchange",
          exchange: "azure:federated-credential",
          trust: { oidcDiscovery: "https://identity.prod-yard.example/.well-known/openid-configuration" },
        },
        reason: "Azure federated credential flow requires clientId",
      },
      {
        flow: {
          type: "oidc-federation",
          providerKind: "aws",
          audience: "arn:aws:iam::123456789012:role/hobo-db-writer",
          exchange: "sts:AssumeRoleWithWebIdentity",
          roleArn: "arn:aws:iam::123456789012:role/hobo-db-writer",
        },
        reason: "oidc-federation flow requires trust.oidcDiscovery",
      },
    ];

    for (const scenario of scenarios) {
      const events = [];
      const sts = createFixtureProviderSts();
      const broker = createFixtureBroker({
        providerSts: sts,
        eventSink: (event) => events.push(event),
      });

      const result = await broker.requestToken(baseRequest({ flow: scenario.flow }));

      assert.equal(result.ok, false);
      assert.equal(result.reason, scenario.reason);
      assert.equal(sts.calls.length, 0);
      assert.deepEqual(events.map((event) => event.type), ["token.Denied"]);
    }
  });

  it("narrows and flags a provider STS token that grants broader permissions than requested", async () => {
    const events = [];
    const sts = createFixtureProviderSts({
      permissions: [
        { port: "database", resource: "shop.db", actions: ["read", "write", "admin"] },
        { port: "objectStore", resource: "prod-bucket", actions: ["read"] },
      ],
    });
    const broker = createFixtureBroker({
      providerSts: sts,
      eventSink: (event) => events.push(event),
    });

    const result = await broker.requestToken(baseRequest());

    assert.equal(result.ok, true);
    assert.deepEqual(result.credential.permissions, [
      { port: "database", resource: "shop.db", actions: ["write"] },
    ]);
    assert.deepEqual(result.credential.flags, ["provider-token-overbroad"]);
    assert.deepEqual(events[0].data.flags, ["provider-token-overbroad"]);
  });

  it("rejects expired SVIDs before minting an assertion or calling provider STS", async () => {
    const events = [];
    const sts = createFixtureProviderSts();
    const broker = createFixtureBroker({
      providerSts: sts,
      eventSink: (event) => events.push(event),
    });

    const result = await broker.requestToken(baseRequest({
      svid: { ...svid, expiresAt: "2026-06-25T11:59:59.000Z" },
    }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "expired SVID cannot be exchanged");
    assert.equal(sts.calls.length, 0);
    assert.deepEqual(events.map((event) => event.type), ["token.Denied"]);
  });
});

function createFixtureBroker(overrides = {}) {
  return createOidcFederationBroker({
    issuer: "https://identity.prod-yard.example",
    now: () => new Date(NOW),
    maxTtlSeconds: 600,
    idFactory: deterministicIds(),
    ...overrides,
  });
}

function baseRequest(overrides = {}) {
  return {
    requestId: "req-hobo-110-db-write",
    provider: "aws-prod",
    subject,
    svid,
    scope: databaseWrite,
    flow: {
      type: "oidc-federation",
      providerKind: "aws",
      audience: "arn:aws:iam::123456789012:role/hobo-db-writer",
      exchange: "sts:AssumeRoleWithWebIdentity",
      roleArn: "arn:aws:iam::123456789012:role/hobo-db-writer",
      trust: { oidcDiscovery: "https://identity.prod-yard.example/.well-known/openid-configuration" },
    },
    ...overrides,
  };
}

function deterministicIds() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}
