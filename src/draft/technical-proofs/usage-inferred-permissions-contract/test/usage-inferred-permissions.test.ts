import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  PermissionContractError,
  buildUsagePermissionManifest,
} from "../src/usage-permissions.js";

describe("usage-inferred permissions contract", () => {
  it("infers least-privilege allow verbs from observed resource calls", () => {
    const manifest = buildUsagePermissionManifest({
      bindle: "checkout",
      resources: [
        {
          kind: "bucket",
          name: "receipts",
          port: "wasi:blobstore",
          catalogVerbs: ["read", "write", "delete"],
          observedCalls: [
            { verb: "read", source: "handler.checkout" },
            { verb: "write", source: "handler.checkout" },
          ],
        },
      ],
    });

    const [bucket] = manifest.resources;

    assert.deepEqual(bucket.allow.map((entry) => entry.verb), ["read", "write"]);
    assert.equal(bucket.allow.some((entry) => entry.verb === "delete"), false);
    assert.deepEqual(manifest.links, [
      {
        import: "wasi:blobstore",
        to: "receipts",
        allow: ["read", "write"],
        contractStatus: "satisfied",
      },
    ]);
    assert.deepEqual(bucket.capabilityContract, {
      required: ["read", "write"],
      granted: ["read", "write"],
      status: "satisfied",
      failures: [],
    });
  });

  it("caps manifest allow to a declared .allow() narrow and records the contract marker", () => {
    const manifest = buildUsagePermissionManifest({
      bindle: "events",
      resources: [
        {
          kind: "topic",
          name: "user-created",
          port: "wasi:messaging",
          catalogVerbs: ["publish", "subscribe"],
          observedCalls: [{ verb: "publish", source: "handler.userCreated" }],
          declaredAllow: ["publish"],
        },
      ],
    });

    const [topic] = manifest.resources;

    assert.deepEqual(topic.allow, [
      { verb: "publish", provenance: "declared-narrow-or-equal" },
    ]);
    assert.deepEqual(manifest.links, [
      {
        import: "wasi:messaging",
        to: "user-created",
        allow: ["publish"],
        contractStatus: "satisfied",
      },
    ]);
    assert.deepEqual(topic.capabilityContract, {
      required: ["publish"],
      granted: ["publish"],
      status: "satisfied",
      failures: [],
    });
  });

  it("records a can-deploy readable failure marker when .allow() narrows below observed usage", () => {
    const manifest = buildUsagePermissionManifest({
      bindle: "events",
      resources: [
        {
          kind: "topic",
          name: "user-created",
          port: "wasi:messaging",
          catalogVerbs: ["publish", "subscribe"],
          observedCalls: [
            { verb: "publish", source: "handler.userCreated" },
            { verb: "subscribe", source: "helper.auditSubscriptions" },
          ],
          declaredAllow: ["publish"],
        },
      ],
    });

    const [topic] = manifest.resources;

    assert.deepEqual(topic.allow.map((entry) => entry.verb), ["publish"]);
    assert.deepEqual(manifest.links, [
      {
        import: "wasi:messaging",
        to: "user-created",
        allow: ["publish"],
        contractStatus: "failed",
      },
    ]);
    assert.deepEqual(topic.capabilityContract, {
      required: ["publish", "subscribe"],
      granted: ["publish"],
      status: "failed",
      failures: [
        {
          code: "capability.required-not-granted",
          missing: ["subscribe"],
          message: "Resource user-created uses subscribe but .allow() grants only publish.",
        },
      ],
    });
  });

  it("keeps deny-by-default across helper calls and marks dynamic grants as declared", () => {
    const manifest = buildUsagePermissionManifest({
      bindle: "notifications",
      resources: [
        {
          kind: "queue",
          name: "mail",
          port: "hobo:queue",
          catalogVerbs: ["enqueue", "dequeue", "purge"],
          observedCalls: [
            { verb: "enqueue", source: "helper.enqueueReceipt" },
          ],
          dynamicAllow: ["dequeue"],
        },
      ],
    });

    const [queue] = manifest.resources;

    assert.deepEqual(queue.allow, [
      { verb: "dequeue", provenance: "declared-dynamic" },
      { verb: "enqueue", provenance: "inferred-from-usage" },
    ]);
    assert.equal(queue.allow.some((entry) => entry.verb === "purge"), false);
    assert.deepEqual(queue.capabilityContract, {
      required: ["enqueue"],
      granted: ["dequeue", "enqueue"],
      status: "satisfied",
      failures: [],
    });
  });

  it("rejects unmarked .allow() widening beyond observed usage", () => {
    assert.throws(
      () =>
        buildUsagePermissionManifest({
          bindle: "bad-widen",
          resources: [
            {
              kind: "bucket",
              name: "receipts",
              port: "wasi:blobstore",
              catalogVerbs: ["read", "write", "delete"],
              observedCalls: [{ verb: "read", source: "handler.checkout" }],
              declaredAllow: ["read", "delete"],
            },
          ],
        }),
      (error) => {
        assert.ok(error instanceof PermissionContractError);
        assert.equal(error.code, "capability.allow-widens-usage");
        assert.deepEqual(error.details, {
          resource: "receipts",
          widened: ["delete"],
        });
        return true;
      },
    );
  });
});
