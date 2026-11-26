import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  SandboxContractError,
  declareConformanceRun,
  profileDigest,
  validateSandboxEvent,
  validateSandboxProfile
} from "../src/contract.js";

const validProfile = Object.freeze({
  schema: "hobo.sandbox.profile/v1",
  id: "gen-provider-db-profile",
  isolation: {
    tier: "microvm",
    engine: "firecracker"
  },
  network: {
    mode: "none",
    allow: []
  },
  filesystem: {
    scratch: "/sandbox/scratch",
    writable: ["/sandbox/scratch"],
    readonly: ["/workspace/input"]
  },
  capabilities: [
    {
      interface: "hobo:conformance/runner@0.1.0",
      stability: "preview",
      scope: {
        suiteId: "conformance.provider.database@0.1.0",
        targetPort: "hobo:database/postgres@0.1.0"
      },
      verbs: ["run"]
    }
  ],
  resources: {
    cpuMs: 30_000,
    memoryMiB: 512,
    wallClockMs: 60_000
  },
  assertions: [
    "no-egress",
    "capability-scoped",
    "scratch-only-write",
    "resource-budgeted"
  ]
});

test("valid generation sandbox profile fixture validates and gets a stable digest", async () => {
  const fixture = JSON.parse(
    await readFile(
      join(import.meta.dirname, "..", "fixtures", "valid-generation-profile.json"),
      "utf8"
    )
  );
  const validated = validateSandboxProfile(fixture);

  assert.deepEqual(validated, validProfile);
  assert.equal(profileDigest(validated), profileDigest({ ...validProfile }));
  assert.match(profileDigest(validated), /^sha256:[a-f0-9]{64}$/);
});

test("profiles permitting egress or unscoped capabilities fail closed", () => {
  assertSandboxError(
    {
      ...validProfile,
      network: { mode: "allowlist", allow: ["https://api.example.com"] }
    },
    "network.egress_not_allowed"
  );

  assertSandboxError(
    {
      ...validProfile,
      capabilities: [
        {
          interface: "hobo:conformance/runner@0.1.0",
          stability: "preview",
          verbs: ["run"]
        }
      ]
    },
    "capability.scope_required"
  );

  assertSandboxError(
    {
      ...validProfile,
      capabilities: [
        {
          interface: "wasi:http/outgoing-handler@0.2.0",
          stability: "preview",
          scope: {
            host: "api.example.com"
          },
          verbs: ["send"]
        }
      ]
    },
    "capability.egress_not_allowed"
  );
});

test("filesystem writes outside scratch are rejected by construction", () => {
  assertSandboxError(
    {
      ...validProfile,
      filesystem: {
        scratch: "/sandbox/scratch",
        writable: ["/sandbox/scratch", "/workspace/output"],
        readonly: ["/workspace/input"]
      }
    },
    "filesystem.write_outside_scratch"
  );

  assertSandboxError(
    {
      ...validProfile,
      filesystem: {
        scratch: "/",
        writable: ["/workspace/output"],
        readonly: ["/workspace/input"]
      }
    },
    "filesystem.scratch_root_forbidden"
  );
});

test("conformance declaration records sandbox proof without implementing a runner", () => {
  const declaration = declareConformanceRun(validProfile, {
    runId: "gen-run-123",
    suiteId: "conformance.provider.database@0.1.0",
    artifactKind: "provider",
    targetPort: "hobo:database/postgres@0.1.0",
    validator: "@hobo/conformance"
  });

  assert.deepEqual(declaration, {
    schema: "hobo.sandbox.conformance/v1",
    runId: "gen-run-123",
    profileId: "gen-provider-db-profile",
    profileDigest: profileDigest(validProfile),
    suiteId: "conformance.provider.database@0.1.0",
    artifactKind: "provider",
    targetPort: "hobo:database/postgres@0.1.0",
    validator: "@hobo/conformance",
    assertions: [
      "no-egress",
      "capability-scoped",
      "scratch-only-write",
      "resource-budgeted"
    ]
  });
});

test("sandbox event payloads require run, profile digest, and denied attempt evidence", () => {
  const event = validateSandboxEvent({
    type: "sandbox.EscapeAttemptBlocked",
    runId: "gen-run-123",
    profileDigest: profileDigest(validProfile),
    attempt: {
      kind: "network",
      target: "https://api.example.com",
      decision: "denied"
    }
  });

  assert.equal(event.type, "sandbox.EscapeAttemptBlocked");
  assert.equal(event.attempt.decision, "denied");

  assert.throws(
    () =>
      validateSandboxEvent({
        type: "sandbox.EscapeAttemptBlocked",
        runId: "gen-run-123",
        profileDigest: profileDigest(validProfile),
        attempt: {
          kind: "network",
          target: "https://api.example.com",
          decision: "allowed"
        }
      }),
    /sandbox.escape_attempt_must_be_denied/
  );
});

function assertSandboxError(profile, code) {
  assert.throws(
    () => validateSandboxProfile(profile),
    (error) => error instanceof SandboxContractError && error.code === code
  );
}
