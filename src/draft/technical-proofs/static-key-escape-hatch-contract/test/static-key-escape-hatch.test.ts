import assert from "node:assert/strict";
import { test } from "vitest";

import {
  foldCredentialAudit,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import {
  StaticKeyExpiredError,
  assertStaticKeyNoPlaintextConformance,
  createFixtureEnvelopeStore,
  createStaticKeyEscapeHatch,
} from "../src/static-key-escape-hatch.js";

const NOW = "2026-06-25T12:00:00.000Z";
const SUBJECT = {
  kind: "agent",
  id: "agent:checkout",
  delegatedBy: { kind: "user", id: "user:priya" },
};

test("rejects static keys beyond the max TTL and fails closed after expiry", async () => {
  const hatch = createHarness();

  assert.throws(() => createHarness({ maxTtlDays: 8 }), /configurable down from P7D/);
  assert.throws(
    () =>
      hatch.register({
        ...staticKeyRecord({
          keyRef: "static://legacy/too-long",
          expiresAt: "2026-07-03T12:00:00.000Z",
        }),
      }),
    /exceeds max TTL P7D/,
  );

  const tighterHatch = createHarness({ maxTtlDays: 2 });
  assert.throws(
    () =>
      tighterHatch.register(
        staticKeyRecord({
          keyRef: "static://legacy/down-configured",
          expiresAt: "2026-06-28T10:00:01.000Z",
        }),
      ),
    /exceeds max TTL P2D/,
  );

  hatch.register(
    staticKeyRecord({
      keyRef: "static://legacy/expired",
      expiresAt: "2026-06-25T11:59:00.000Z",
    }),
  );

  await assert.rejects(
    () =>
      hatch.fetch("static://legacy/expired", {
        subject: SUBJECT,
        optIn: explicitOptIn(),
        operation: "secret.read",
        resource: "legacy/api-key",
      }),
    StaticKeyExpiredError,
  );
  assert.equal(hatch.events.length, 0, "expired keys fail before use events are emitted");
});

test("requires per-use opt-in and audits every successful fetch with redacted payloads", async () => {
  const hatch = createHarness();
  hatch.register(staticKeyRecord());

  await assert.rejects(
    () =>
      hatch.fetch("static://legacy/api-key", {
        subject: SUBJECT,
        operation: "secret.read",
        resource: "legacy/api-key",
      }),
    /explicit opt-in is required/,
  );

  const first = await hatch.fetch("static://legacy/api-key", {
    subject: SUBJECT,
    optIn: explicitOptIn({ reason: "legacy provider has no federation" }),
    operation: "secret.read",
    resource: "legacy/api-key",
  });
  const second = await hatch.fetch("static://legacy/api-key", {
    subject: SUBJECT,
    optIn: explicitOptIn({ reason: "second cache miss still audits" }),
    operation: "secret.read",
    resource: "legacy/api-key",
  });

  assert.equal(first.value.reveal(), "legacy-static-secret");
  assert.equal(String(first.value), "[secret:redacted]");
  assert.equal(JSON.stringify({ value: first.value }), '{"value":"[secret:redacted]"}');
  assert.equal(second.value.reveal(), "legacy-static-secret");

  assert.equal(hatch.events.filter((event) => event.type === "token.Used").length, 2);
  assert.equal(hatch.events.filter((event) => event.type === "secret.Accessed").length, 2);
  assert.deepEqual(hatch.events.flatMap((event) => validateIdentityEvent(event).errors), []);

  const audit = foldCredentialAudit(hatch.events);
  assert.deepEqual(audit.anomalies, []);
  assert.deepEqual(audit.chains[0].secretRefs, ["static://legacy/api-key"]);

  assertStaticKeyNoPlaintextConformance(
    {
      bindle: { config: { LEGACY: { secretRef: "legacy/api-key" } } },
      camp: hatch.persistableView(),
      events: hatch.events,
      logs: [{ message: "static key fetched", keyRef: "static://legacy/api-key" }],
      spans: [{ name: "static-key.fetch", attributes: { keyRef: "static://legacy/api-key" } }],
      trainingTrajectories: [{ input: "fetch legacy provider", output: "[secret:redacted]" }],
    },
    ["legacy-static-secret"],
  );
});

test("enforces rotation schedule and never falls back to degraded best-effort", async () => {
  const hatch = createHarness();
  hatch.register(
    staticKeyRecord({
      keyRef: "static://legacy/rotation-overdue",
      rotationDueAt: "2026-06-25T11:00:00.000Z",
    }),
  );

  await assert.rejects(
    () =>
      hatch.fetch("static://legacy/rotation-overdue", {
        subject: SUBJECT,
        optIn: explicitOptIn(),
        operation: "secret.read",
        resource: "legacy/api-key",
        degradedBestEffort: true,
      }),
    /rotation is overdue/,
  );
  assert.equal(hatch.events.length, 0);

  hatch.register(
    staticKeyRecord({
      keyRef: "static://legacy/rotated",
      issuedAt: "2026-06-25T11:30:00.000Z",
      expiresAt: "2026-06-30T12:00:00.000Z",
      rotationDueAt: "2026-06-26T12:00:00.000Z",
      previousKeyRef: "static://legacy/rotation-overdue",
    }),
  );

  const rotated = await hatch.fetch("static://legacy/rotated", {
    subject: SUBJECT,
    optIn: explicitOptIn(),
    operation: "secret.read",
    resource: "legacy/api-key",
  });
  assert.equal(rotated.record.rotation.previousKeyRef, "static://legacy/rotation-overdue");
  assert.equal(rotated.value.reveal(), "legacy-static-secret");
});

test("stores only envelope references and detects plaintext across persistence and telemetry", () => {
  const hatch = createHarness();
  hatch.register(staticKeyRecord());

  assert.deepEqual(hatch.persistableView().keys["static://legacy/api-key"].envelope, {
    ciphertextRef: "kms://ciphertexts/legacy-api-key",
    dekRef: "kms://dek/static-key-fixture",
    kekRef: "kms://kek/yard-prod",
  });
  assert.equal(JSON.stringify(hatch.persistableView()).includes("legacy-static-secret"), false);

  assert.throws(
    () =>
      hatch.register({
        ...staticKeyRecord({ keyRef: "static://legacy/plaintext" }),
        value: "legacy-static-secret",
      }),
    /plaintext static key material is forbidden/,
  );

  assert.throws(
    () =>
      assertStaticKeyNoPlaintextConformance(
        {
          bindle: {},
          camp: hatch.persistableView(),
          events: [],
          logs: [],
          spans: [],
          trainingTrajectories: [{ output: "model saw legacy-static-secret" }],
        },
        ["legacy-static-secret"],
      ),
    /trainingTrajectories contains plaintext static key/,
  );
});

function createHarness(options = {}) {
  const events = [];
  const envelopeStore = createFixtureEnvelopeStore({
    "kms://ciphertexts/legacy-api-key": "legacy-static-secret",
  });
  const hatch = createStaticKeyEscapeHatch({
    now: () => new Date(NOW),
    envelopeStore,
    eventSink: (event) => events.push(event),
    idFactory: (() => {
      let seq = 0;
      return (prefix) => `${prefix}-${++seq}`;
    })(),
    ...options,
  });
  return { ...hatch, events };
}

function staticKeyRecord(overrides = {}) {
  return {
    keyRef: "static://legacy/api-key",
    provider: "legacy",
    audience: "urn:legacy:api",
    scopes: ["legacy:read"],
    issuedAt: "2026-06-25T10:00:00.000Z",
    expiresAt: "2026-06-30T12:00:00.000Z",
    rotationDueAt: "2026-06-26T12:00:00.000Z",
    envelope: {
      ciphertextRef: "kms://ciphertexts/legacy-api-key",
      dekRef: "kms://dek/static-key-fixture",
      kekRef: "kms://kek/yard-prod",
    },
    ...overrides,
  };
}

function explicitOptIn(overrides = {}) {
  return {
    approvedBy: { kind: "user", id: "user:security-admin" },
    reason: "provider lacks federation",
    ...overrides,
  };
}
