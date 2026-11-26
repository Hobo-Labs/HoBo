import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PermissionContractError,
  buildUsagePermissionManifest,
  parseUsagePermissionInput,
  projectPermissionTriple,
} from "../src/usage-permissions.js";

const goldenPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fr-002-permission-triple.golden.json",
);

describe("usage-inferred permissions", () => {
  it("infers least-privilege allow verbs from observed resource calls", () => {
    const { manifest } = buildUsagePermissionManifest(
      parseUsagePermissionInput({
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
      }),
    );

    const [bucket] = manifest.resources;
    expect(bucket?.allow.map((entry) => entry.verb)).toEqual(["read", "write"]);
    expect(bucket?.allow.some((entry) => entry.verb === "delete")).toBe(false);
    expect(manifest.links).toEqual([
      {
        import: "wasi:blobstore",
        to: "receipts",
        allow: ["read", "write"],
        contractStatus: "satisfied",
      },
    ]);
    expect(bucket?.capabilityContract).toEqual({
      required: ["read", "write"],
      granted: ["read", "write"],
      status: "satisfied",
      failures: [],
    });
  });

  it("records capability.required-not-granted when .allow() narrows below usage", () => {
    const { manifest, eventLog } = buildUsagePermissionManifest(
      parseUsagePermissionInput({
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
      }),
    );

    const [topic] = manifest.resources;
    expect(topic?.capabilityContract.status).toBe("failed");
    expect(topic?.capabilityContract.failures[0]?.code).toBe("capability.required-not-granted");
    expect(eventLog.events[0]?.type).toBe("capability.ContractFailed");
  });

  it("rejects unmarked .allow() widening beyond observed usage", () => {
    try {
      buildUsagePermissionManifest(
        parseUsagePermissionInput({
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
      );
      throw new Error("expected PermissionContractError");
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionContractError);
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      expect((error as PermissionContractError).code).toBe("capability.allow-widens-usage");
    }
  });

  it("deep-equals FR-002 golden fixture permission triple projection", () => {
    const { manifest } = buildUsagePermissionManifest(
      parseUsagePermissionInput({
        bindle: "support-sync",
        resources: [
          {
            kind: "topic",
            name: "user-created",
            port: "wasi:messaging",
            catalogVerbs: ["publish", "subscribe"],
            observedCalls: [{ verb: "publish", source: "handler.userCreated" }],
            declaredAllow: ["publish"],
          },
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
          {
            kind: "kv",
            name: "profile-cache",
            port: "wasi:keyvalue",
            catalogVerbs: ["get", "set", "delete"],
            observedCalls: [
              { verb: "get", source: "handler.profile" },
              { verb: "set", source: "handler.profile" },
            ],
            declaredAllow: ["get"],
          },
        ],
      }),
    );

    const triple = projectPermissionTriple(manifest);
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));

    expect(triple).toEqual(golden);

    for (const entry of triple) {
      expect(entry.iam.verbs).toEqual(entry.link.allow);
      expect(entry.tokenScope.verbs).toEqual(entry.link.allow);
    }
  });

  it("appends capability.ContractEvaluated events for satisfied contracts", () => {
    const { eventLog } = buildUsagePermissionManifest(
      parseUsagePermissionInput({
        bindle: "ok",
        resources: [
          {
            kind: "kv",
            name: "cache",
            port: "wasi:keyvalue",
            catalogVerbs: ["get", "set"],
            observedCalls: [{ verb: "get", source: "handler" }],
          },
        ],
      }),
    );

    expect(eventLog.events).toHaveLength(1);
    expect(eventLog.events[0]?.type).toBe("capability.ContractEvaluated");
  });
});
