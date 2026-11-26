import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import {
  CREDENTIAL_AUDIT_RETENTION,
  IDENTITY_EVENT_SCHEMA_VERSION,
  IDENTITY_EVENT_TYPES,
  createFixtureEventForType,
  createIdentityEvent,
  foldCredentialAudit,
  roundTripIdentityEvent,
  validateIdentityEvent,
} from "../src/identity-event-contract.js";

const actor = {
  kind: "agent",
  id: "agent:release",
  delegatedBy: {
    kind: "user",
    id: "user:priya",
  },
};

describe("identity/token/session event contract", () => {
  it("publishes every identity audit event family and round-trips fixture events", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../schema/identity-events.v1.schema.json", import.meta.url), "utf8"),
    );

    assert.equal(IDENTITY_EVENT_SCHEMA_VERSION, "hobo.identity-events/v1");
    assert.deepEqual(schema.properties.type.enum, IDENTITY_EVENT_TYPES);
    assert.equal(CREDENTIAL_AUDIT_RETENTION.neverCompact, true);

    for (const type of IDENTITY_EVENT_TYPES) {
      const event = createFixtureEventForType(type);
      const validation = validateIdentityEvent(event);

      assert.equal(validation.ok, true, `${type}: ${validation.errors.join("\n")}`);
      assert.deepEqual(roundTripIdentityEvent(event), event);
      assert.equal(event.retention.class, "security-audit");
      assert.equal(event.retention.neverCompact, true);
    }
  });

  it("folds a user -> agent -> external-app XAA trace into CredentialAudit", () => {
    const authenticated = createIdentityEvent(
      "user.Authenticated",
      {
        principal: { kind: "user", id: "user:priya" },
        provider: "workos",
        authTime: "2026-06-25T10:00:00.000Z",
        sessionId: "session-1",
      },
      { id: "evt-user", actor: { kind: "user", id: "user:priya" }, seq: 1 },
    );
    const granted = createIdentityEvent(
      "token.Granted",
      {
        grantId: "grant-asana-write",
        subject: actor,
        target: { kind: "external-app", id: "asana" },
        audience: "urn:asana:tasks",
        scopes: ["tasks:write"],
        tokenRef: "vault://tokens/grant-asana-write",
        expiresAt: "2026-06-25T10:10:00.000Z",
      },
      { id: "evt-grant", actor, seq: 2, causationId: "evt-user" },
    );
    const used = createIdentityEvent(
      "token.Used",
      {
        grantId: "grant-asana-write",
        usageId: "use-asana-create-task",
        operation: "tasks.create",
        resource: "asana:task/42",
      },
      { id: "evt-used", actor, seq: 3, causationId: "evt-grant" },
    );
    const accessed = createIdentityEvent(
      "secret.Accessed",
      {
        secretRef: "secret://asana/webhook-signing-key",
        source: "provider-secret-store",
        tokenUsageId: "use-asana-create-task",
      },
      { id: "evt-secret", actor, seq: 4, causationId: "evt-used" },
    );
    const revoked = createIdentityEvent(
      "token.Revoked",
      {
        grantId: "grant-asana-write",
        reason: "user disconnected app",
      },
      { id: "evt-revoke", actor, seq: 5, causationId: "evt-used" },
    );

    const audit = foldCredentialAudit([authenticated, granted, used, accessed, revoked]);

    assert.deepEqual(audit.chains, [
      {
        user: "user:priya",
        agent: "agent:release",
        target: "external-app:asana",
        audience: "urn:asana:tasks",
        scopes: ["tasks:write"],
        grants: ["grant-asana-write"],
        uses: ["use-asana-create-task"],
        secretRefs: ["secret://asana/webhook-signing-key"],
        revoked: true,
      },
    ]);
    assert.deepEqual(audit.revokedGrantIds, ["grant-asana-write"]);
    assert.equal(audit.grantsById["grant-asana-write"].type, "token.Granted");
    assert.equal(audit.grantsById["grant-asana-write"].data.revoked, undefined);
    assert.deepEqual(audit.anomalies, []);
  });

  it("flags token.Used without a preceding token.Granted instead of silently folding", () => {
    const audit = foldCredentialAudit([
      createIdentityEvent(
        "token.Used",
        {
          grantId: "missing-grant",
          usageId: "use-missing",
          operation: "objectStore.write",
          resource: "bucket/photos",
        },
        { id: "evt-missing-use", actor, seq: 1 },
      ),
    ]);

    assert.deepEqual(audit.anomalies, [
      {
        type: "token.Used",
        id: "evt-missing-use",
        code: "missing-token-grant",
        grantId: "missing-grant",
      },
    ]);
    assert.deepEqual(audit.chains, []);
  });

  it("rejects plaintext secret and config values at the event boundary", () => {
    const secret = createIdentityEvent(
      "secret.Accessed",
      {
        secretRef: "secret://prod/db-password",
        source: "provider-secret-store",
        tokenUsageId: "use-db",
      },
      { id: "evt-secret", actor, seq: 1 },
    );
    const config = createIdentityEvent(
      "config.Resolved",
      {
        configRef: "config://prod/api-base-url",
        source: "camp-config",
      },
      { id: "evt-config", actor, seq: 2 },
    );

    assert.equal(validateIdentityEvent(secret).ok, true);
    assert.equal(validateIdentityEvent(config).ok, true);

    assert.match(
      validateIdentityEvent({ ...secret, data: { ...secret.data, value: "p@ssw0rd" } }).errors.join("\n"),
      /secret.Accessed data.value is forbidden/,
    );
    assert.match(
      validateIdentityEvent({ ...config, data: { ...config.data, plaintext: "https://internal" } }).errors.join("\n"),
      /config.Resolved data.plaintext is forbidden/,
    );
  });
});
