import assert from "node:assert/strict";
import { test } from "vitest";

import {
  AppendOnlyLogViolationError,
  ForgettableInvariantError,
  TOMBSTONE,
  activateSnapshot,
  appendNotificationSent,
  appendRegisteredCustomer,
  assertNoForgettableWriteInvariants,
  assertOriginalEventsUnchanged,
  attemptDeleteForErasure,
  createEventLog,
  createKeyring,
  createSnapshot,
  cryptoShredSubject,
  cryptoShredTenant,
  digestEventStructure,
  provisionTenant,
  rebuildProjection,
} from "../src/crypto-shred-erasure-contract.js";

test("crypto-shred tombstones PII, rebuilds projections excluding the subject, and never rewrites prior log events", () => {
  const { keyring, log } = fixture();
  appendRegisteredCustomer(log, keyring, {
    email: "alice@example.test",
    name: "Alice",
    subjectId: "alice",
    tenantId: "tenant-a",
  });
  appendNotificationSent(log, keyring, {
    recipient: "alice@example.test",
    subjectId: "alice",
    template: "welcome",
    tenantId: "tenant-a",
  });
  appendRegisteredCustomer(log, keyring, {
    email: "bob@example.test",
    name: "Bob",
    subjectId: "bob",
    tenantId: "tenant-a",
  });
  const originalEvents = structuredClone(log.events);

  cryptoShredSubject(log, keyring, {
    reason: "gdpr-request",
    subjectId: "alice",
    tenantId: "tenant-a",
  });

  const projection = rebuildProjection(log.events, keyring);
  assert.equal(projection.decryptedRecords["tenant/tenant-a/subject/alice"].email, TOMBSTONE);
  assert.equal(projection.notificationTrail[0].recipient, TOMBSTONE);
  assert.deepEqual(Object.keys(projection.customers), ["tenant/tenant-a/subject/bob"]);
  assert.equal(projection.customers["tenant/tenant-a/subject/bob"].email, "bob@example.test");
  assert.equal(assertOriginalEventsUnchanged(originalEvents, log.events), true);
  assert.equal(log.events.length, originalEvents.length + 2);
  assert.deepEqual(log.events.slice(-2).map((event) => event.type), ["erasure.Requested", "erasure.Completed"]);
});

test("replay preserves the same log structure digest while shredded fields decrypt to post-erasure tombstones", () => {
  const { keyring, log } = fixture();
  appendRegisteredCustomer(log, keyring, {
    email: "alice@example.test",
    name: "Alice",
    subjectId: "alice",
    tenantId: "tenant-a",
  });
  cryptoShredSubject(log, keyring, {
    reason: "gdpr-request",
    subjectId: "alice",
    tenantId: "tenant-a",
  });

  const firstReplay = rebuildProjection(log.events, keyring);
  const secondReplay = rebuildProjection(log.events, keyring);

  assert.equal(firstReplay.eventStructureDigest, secondReplay.eventStructureDigest);
  assert.equal(firstReplay.eventStructureDigest, digestEventStructure(log.events));
  assert.equal(secondReplay.decryptedRecords["tenant/tenant-a/subject/alice"].email, TOMBSTONE);
});

test("codegen lint rejects a write-side uniqueness invariant over a forgettable field", () => {
  assert.throws(
    () =>
      assertNoForgettableWriteInvariants({
        fields: {
          email: { forgettable: true, type: "string" },
          tenantScopedHandle: { forgettable: false, type: "string" },
        },
        invariants: [
          {
            fields: ["email"],
            kind: "unique",
            name: "uniqueCustomerEmail",
            writeSide: true,
          },
        ],
      }),
    (error) => {
      assert.equal(error instanceof ForgettableInvariantError, true);
      assert.deepEqual(error.details.violations.map((violation) => violation.code), [
        "FORGETTABLE_WRITE_INVARIANT",
      ]);
      return true;
    },
  );
});

test("pre-erasure snapshot is invalidated so shredded content cannot resurrect", () => {
  const { keyring, log } = fixture();
  appendRegisteredCustomer(log, keyring, {
    email: "alice@example.test",
    name: "Alice",
    subjectId: "alice",
    tenantId: "tenant-a",
  });
  const snapshot = createSnapshot({ events: log.events, keyring });
  assert.equal(snapshot.state.customers["tenant/tenant-a/subject/alice"].email, "alice@example.test");

  cryptoShredSubject(log, keyring, {
    reason: "gdpr-request",
    subjectId: "alice",
    tenantId: "tenant-a",
  });
  const activated = activateSnapshot({ events: log.events, keyring, snapshot });

  assert.equal(activated.usedSnapshot, false);
  assert.equal(activated.ignoredSnapshotReason, "erasure-epoch-changed");
  assert.equal(activated.state.decryptedRecords["tenant/tenant-a/subject/alice"].email, TOMBSTONE);
  assert.deepEqual(Object.keys(activated.state.customers), []);
});

test("replay after erasure is graceful and never errors on tombstones", () => {
  const { keyring, log } = fixture();
  appendRegisteredCustomer(log, keyring, {
    email: "alice@example.test",
    name: "Alice",
    subjectId: "alice",
    tenantId: "tenant-a",
  });
  cryptoShredSubject(log, keyring, {
    reason: "gdpr-request",
    subjectId: "alice",
    tenantId: "tenant-a",
  });

  assert.doesNotThrow(() => rebuildProjection(log.events, keyring));
  assert.equal(rebuildProjection(log.events, keyring).decryptedRecords["tenant/tenant-a/subject/alice"].email, TOMBSTONE);
});

test("per-tenant erasure destroys only the target tenant key hierarchy", () => {
  const { keyring, log } = fixture();
  provisionTenant(keyring, "tenant-b");
  appendRegisteredCustomer(log, keyring, {
    email: "alice@tenant-a.test",
    name: "Alice A",
    subjectId: "alice",
    tenantId: "tenant-a",
  });
  appendRegisteredCustomer(log, keyring, {
    email: "alice@tenant-b.test",
    name: "Alice B",
    subjectId: "alice",
    tenantId: "tenant-b",
  });

  cryptoShredTenant(log, keyring, {
    reason: "tenant-offboarding",
    tenantId: "tenant-a",
  });
  const projection = rebuildProjection(log.events, keyring);

  assert.equal(projection.decryptedRecords["tenant/tenant-a/subject/alice"].email, TOMBSTONE);
  assert.equal(projection.decryptedRecords["tenant/tenant-b/subject/alice"].email, "alice@tenant-b.test");
  assert.deepEqual(Object.keys(projection.customers), ["tenant/tenant-b/subject/alice"]);
  assert.deepEqual(projection.erasedTenants, ["tenant-a"]);
  assert.equal(log.events.at(-1).type, "tenant.Erased");
});

test("attempting to satisfy erasure by deleting log events is blocked", () => {
  const { keyring, log } = fixture();
  appendRegisteredCustomer(log, keyring, {
    email: "alice@example.test",
    name: "Alice",
    subjectId: "alice",
    tenantId: "tenant-a",
  });
  const beforeDigest = digestEventStructure(log.events);

  assert.throws(
    () => attemptDeleteForErasure(log, (event) => event.data?.subjectId === "alice"),
    AppendOnlyLogViolationError,
  );
  assert.equal(digestEventStructure(log.events), beforeDigest);
});

function fixture() {
  const keyring = createKeyring();
  provisionTenant(keyring, "tenant-a");
  return {
    keyring,
    log: createEventLog(),
  };
}
