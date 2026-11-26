import assert from "node:assert/strict";
import { test } from "vitest";
import { isJsonString } from "../src/json.js";

import {
  config,
  emitConfigManifest,
  env,
  fromBinding,
  secretRef,
} from "../../hobo-config-secret-schema-contract/src/config-schema.js";
import {
  foldCredentialAudit,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import {
  createFixtureProviderSts,
  createOidcFederationBroker,
} from "../../oidc-federation-sts-contract/src/oidc-federation-sts.js";
import {
  assertNoPlaintextConformance,
  createFixtureSecretsAdapter,
  createSecretlessConfigResolver,
} from "../src/secretless-config-resolution.js";

const SUBJECT = {
  kind: "agent",
  id: "agent:checkout",
  delegatedBy: { kind: "user", id: "user:priya" },
};

const SVID = {
  svidRef: "svid://agent/checkout",
  issuer: "https://identity.hobo.local",
  subject: "agent:checkout",
  tenant: "tenant-acme",
  audience: "hobo-provider-sts",
  expiresAt: "2026-06-25T13:00:00.000Z",
  scope: [
    { port: "database", resource: "orders-db", actions: ["connect"] },
    { port: "secrets", resource: "prod/stripe/api-key", actions: ["read"] },
    { port: "secrets", resource: "prod/payments/aws-api-key", actions: ["read"] },
    { port: "secrets", resource: "prod/payments/azure-api-key", actions: ["read"] },
  ],
};

test("resolves ladder paths (a)-(c) with brokered events and no persisted secret", async () => {
  const { events, providerSts, resolver, secretsAdapter } = createResolverHarness({
    adapters: {
      aws: createFixtureSecretsAdapter({
        provider: "aws",
        store: { "prod/stripe/api-key": "sk_live_222" },
      }),
    },
  });
  const manifest = createManifest();
  const camp = createCamp();

  const db = await resolver.resolve("DB", manifest.entries.DB, {
    camp,
    bindle: manifest,
    subject: SUBJECT,
    svid: SVID,
  });
  assert.equal(db.kind, "bound-resource-token");
  assert.equal(db.source, "bound-resource");
  assert.equal(secretsAdapter.reads.length, 0);

  const stripe = await resolver.resolve("STRIPE", manifest.entries.STRIPE, {
    camp,
    bindle: manifest,
    subject: SUBJECT,
    svid: SVID,
  });
  assert.equal(stripe.kind, "secret-value");
  assert.equal(stripe.source, "provider-secret-store");
  assert.equal(stripe.value.reveal(), "sk_live_222");
  assert.equal(String(stripe.value), "[secret:redacted]");
  assert.equal(JSON.stringify({ stripe: stripe.value }), '{"stripe":"[secret:redacted]"}');

  const logLevel = await resolver.resolve("LOG_LEVEL", manifest.entries.LOG_LEVEL, {
    camp,
    bindle: manifest,
    subject: SUBJECT,
    svid: SVID,
  });
  assert.deepEqual(logLevel, {
    kind: "camp-config",
    key: "LOG_LEVEL",
    source: "camp-config",
    value: "debug",
  });

  assert.equal(providerSts.calls.length, 2);
  assert.equal(secretsAdapter.reads.length, 1);
  assert.equal(secretsAdapter.reads[0].path, "prod/stripe/api-key");
  assert.equal(isJsonString(secretsAdapter.reads[0].credentialRef), true);

  const validationErrors = events.flatMap((event) => validateIdentityEvent(event).errors);
  assert.deepEqual(validationErrors, []);
  assert.deepEqual(
    events.filter((event) => event.type === "config.Resolved").map((event) => event.data.source),
    ["bound-resource", "provider-secret-store", "camp-config"],
  );

  const secretAccess = events.find((event) => event.type === "secret.Accessed");
  assert.ok(secretAccess);
  const joinedTokenUse = events.find(
    (event) => event.type === "token.Used" && event.data.usageId === secretAccess.data.tokenUsageId,
  );
  assert.ok(joinedTokenUse, "secret.Accessed must join to token.Used");

  const audit = foldCredentialAudit(
    events.filter((event) => event.type.startsWith("token.") || event.type === "secret.Accessed"),
  );
  assert.deepEqual(audit.anomalies, []);

  assertNoPlaintextConformance(
    {
      bindle: manifest,
      camp: resolver.persistableCampView(camp),
      events,
      logs: [],
      spans: [],
    },
    ["sk_live_222"],
  );
});

test("no-plaintext conformance fails if a secret would land in an event log", () => {
  assert.throws(
    () =>
      assertNoPlaintextConformance(
        {
          bindle: {},
          camp: {},
          events: [{ type: "debug.Leaked", data: { message: "leaked sk_live_222" } }],
        },
        ["sk_live_222"],
      ),
    /events contains plaintext secret/,
  );
});

test("provider without federation routes to the bounded static hatch instead of plaintext", async () => {
  const events = [];
  const legacyAdapter = createFixtureSecretsAdapter({
    provider: "legacy",
    store: { "legacy/api-key": "legacy-static-secret" },
  });
  const { resolver } = createResolverHarness({
    events,
    adapters: { legacy: legacyAdapter },
  });
  const manifest = emitConfigManifest(config({ LEGACY: secretRef("legacy/api-key") }));
  const camp = createCamp({
    secretRefs: {
      "legacy/api-key": {
        provider: "legacy",
        path: "legacy/api-key",
        federation: false,
        staticHatch: { ttl: "P7D", audit: true },
      },
    },
  });

  const result = await resolver.resolve("LEGACY", manifest.entries.LEGACY, {
    camp,
    bindle: manifest,
    subject: SUBJECT,
    svid: SVID,
  });

  assert.deepEqual(result, {
    kind: "static-secret-hatch-required",
    key: "LEGACY",
    provider: "legacy",
    reason: "provider-federation-unavailable",
    source: "static-secret-hatch",
  });
  assert.equal(legacyAdapter.reads.length, 0);
  assert.equal(events.some((event) => event.type === "token.Used"), false);
  assert.equal(events.at(-1).type, "config.Resolved");
  assert.equal(events.at(-1).data.source, "static-secret-hatch");
  assertNoPlaintextConformance(
    { bindle: manifest, camp: resolver.persistableCampView(camp), events },
    ["legacy-static-secret"],
  );
});

test("swapping the Camp secrets adapter requires no app declaration edit", async () => {
  const awsAdapter = createFixtureSecretsAdapter({
    provider: "aws",
    store: { "prod/payments/aws-api-key": "aws-secret" },
  });
  const azureAdapter = createFixtureSecretsAdapter({
    provider: "azure",
    store: { "prod/payments/azure-api-key": "azure-secret" },
  });
  const { resolver } = createResolverHarness({
    adapters: { aws: awsAdapter, azure: azureAdapter },
  });
  const manifest = emitConfigManifest(config({ PAYMENTS: secretRef("payments/api-key") }));
  const appDeclaration = structuredClone(manifest.entries.PAYMENTS);

  const awsCamp = createCamp({
    secretRefs: {
      "payments/api-key": {
        provider: "aws",
        path: "prod/payments/aws-api-key",
        federation: true,
        flow: oidcFlow("aws", "urn:aws:secrets"),
      },
    },
  });
  const azureCamp = createCamp({
    secretRefs: {
      "payments/api-key": {
        provider: "azure",
        path: "prod/payments/azure-api-key",
        federation: true,
        flow: oidcFlow("azure", "urn:azure:keyvault"),
      },
    },
  });

  const aws = await resolver.resolve("PAYMENTS", manifest.entries.PAYMENTS, {
    camp: awsCamp,
    bindle: manifest,
    subject: SUBJECT,
    svid: SVID,
  });
  const azure = await resolver.resolve("PAYMENTS", manifest.entries.PAYMENTS, {
    camp: azureCamp,
    bindle: manifest,
    subject: SUBJECT,
    svid: SVID,
  });

  assert.deepEqual(manifest.entries.PAYMENTS, appDeclaration);
  assert.equal(aws.value.reveal(), "aws-secret");
  assert.equal(azure.value.reveal(), "azure-secret");
  assert.equal(awsAdapter.reads[0].provider, "aws");
  assert.equal(azureAdapter.reads[0].provider, "azure");
});

function createManifest() {
  return emitConfigManifest(
    config({
      DB: fromBinding("db"),
      STRIPE: secretRef("stripe/api-key"),
      LOG_LEVEL: env("info"),
    }),
  );
}

function createCamp(overrides = {}) {
  return {
    id: "camp-prod-us",
    config: { LOG_LEVEL: "debug" },
    bindings: {
      db: {
        provider: "aws",
        port: "database",
        resource: "orders-db",
        action: "connect",
        flow: oidcFlow("aws", "urn:aws:db"),
      },
    },
    secretRefs: {
      "stripe/api-key": {
        provider: "aws",
        path: "prod/stripe/api-key",
        federation: true,
        flow: oidcFlow("aws", "urn:aws:secrets"),
      },
    },
    ...overrides,
  };
}

function createResolverHarness({ adapters, events = [] }) {
  const providerSts = createFixtureProviderSts();
  const broker = createOidcFederationBroker({
    providerSts,
    issuer: "https://identity.hobo.local",
    now: () => new Date("2026-06-25T12:00:00.000Z"),
    eventSink: (event) => events.push(event),
  });
  const normalizedAdapters = adapters ?? {
    aws: createFixtureSecretsAdapter({
      provider: "aws",
      store: { "prod/stripe/api-key": "sk_live_222" },
    }),
  };

  return {
    events,
    providerSts,
    secretsAdapter: normalizedAdapters.aws,
    resolver: createSecretlessConfigResolver({
      tokenBroker: broker,
      secrets: normalizedAdapters,
      now: () => new Date("2026-06-25T12:00:00.000Z"),
      eventSink: (event) => events.push(event),
    }),
  };
}

function oidcFlow(providerKind, audience) {
  if (providerKind === "azure") {
    return {
      type: "oidc-federation",
      providerKind,
      exchange: "azure:federated-credential",
      audience,
      clientId: "azure-client-id",
      trust: { oidcDiscovery: "https://identity.hobo.local/.well-known/openid-configuration" },
    };
  }

  return {
    type: "oidc-federation",
    providerKind,
    exchange: "sts:AssumeRoleWithWebIdentity",
    audience,
    roleArn: "arn:aws:iam::123456789012:role/hobo-secretless-fixture",
    trust: { oidcDiscovery: "https://identity.hobo.local/.well-known/openid-configuration" },
  };
}
