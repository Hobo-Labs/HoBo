import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  EFFECTS,
  PHASES,
  POLICY_DECIDED_EVENT_TYPE,
  POLICY_IR_SCHEMA_VERSION,
  PolicyIrValidationError,
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
  migratePolicyIrDocument,
  parseDecision,
  parseDecisionRequest,
  parsePolicyIrDocument,
  serializePolicyIrDocument,
  toWitDecisionRecord,
  fromWitDecisionRecord,
} from "../src/policy-ir.js";

function validRequest(overrides = {}) {
  return createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "agent",
      id: "agent:swe-operator",
      roles: ["Operator-Supervisor"],
      scopes: ["deployment:apply"],
      delegatedBy: { kind: "user", id: "user:priya" },
    },
    action: "deployment.apply",
    resource: { kind: "deployment", id: "dep:checkout" },
    phase: "apply",
    context: {
      region: "us-east-1",
      provider: "aws",
      riskScore: 0.27,
      costEstimate: { amount: 42, unit: "usd-monthly" },
    },
    ...overrides,
  });
}

describe("HoBo Policy IR contract", () => {
  it("publishes a JSON schema for both request and decision response", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../schema/policy-ir.v1.schema.json", import.meta.url), "utf8"),
    );

    assert.equal(schema.properties.schemaVersion.const, POLICY_IR_SCHEMA_VERSION);
    assert.deepEqual(schema.properties.phase.enum, PHASES);
    assert.deepEqual(schema.$defs.decision.properties.effect.enum, EFFECTS);
    assert.equal(
      schema.$defs.decision.properties.evidence.properties.inputHash.pattern,
      "^sha256:[a-f0-9]{64}$",
    );
  });

  it("round-trips request and decision with stable canonical inputHash", () => {
    const request = validRequest();
    const sameRequestDifferentFieldOrder = createDecisionRequest({
      phase: "apply",
      resource: { id: "dep:checkout", kind: "deployment" },
      action: "deployment.apply",
      schemaVersion: POLICY_IR_SCHEMA_VERSION,
      context: {
        costEstimate: { unit: "usd-monthly", amount: 42 },
        riskScore: 0.27,
        provider: "aws",
        region: "us-east-1",
      },
      subject: {
        scopes: ["deployment:apply"],
        roles: ["Operator-Supervisor"],
        id: "agent:swe-operator",
        delegatedBy: { id: "user:priya", kind: "user" },
        kind: "agent",
      },
    });

    assert.equal(request.inputHash, sameRequestDifferentFieldOrder.inputHash);

    const decision = createDecision(request, {
      effect: "allow",
      reason: "operator role may apply non-prod deployment",
      evidence: { policyIds: ["policy:deployers-v1"], engine: "builtin-typescript@0.1.0" },
    });

    const serialized = serializePolicyIrDocument({ request, decision });
    const parsed = parsePolicyIrDocument(serialized);

    assert.deepEqual(parsed, { request, decision });
    assert.equal(parsed.decision.evidence.inputHash, request.inputHash);

    const event = createPolicyDecidedEvent({ request, decision, id: "evt-1" });
    assert.equal(event.type, POLICY_DECIDED_EVENT_TYPE);
    assert.equal(event.data.evidence.inputHash, request.inputHash);
  });

  it("covers every lifecycle phase and decision effect with golden fixtures", () => {
    for (const phase of PHASES) {
      const request = validRequest({
        phase,
        action: `golden.${phase}`,
        resource: { kind: "contract", id: `contract:${phase}` },
      });

      for (const effect of EFFECTS) {
        const decision = createDecision(request, {
          effect,
          reason: `golden ${effect} during ${phase}`,
          evidence: { policyIds: [`policy:${phase}:${effect}`], engine: "fixture-engine" },
          obligations:
            effect === "allow-degraded" || effect === "require-approval"
              ? [{ kind: "approval", id: `${phase}-${effect}`, deadline: "PT30M" }]
              : [],
        });

        assert.equal(parseDecision(decision, request).effect, effect);
        assert.equal(decision.evidence.inputHash, request.inputHash);
      }
    }
  });

  it("rejects unknown subject kinds, phases, and decision effects", () => {
    assert.throws(
      () => validRequest({ subject: { kind: "root", id: "root" } }),
      (error) =>
        error instanceof PolicyIrValidationError &&
        error.code === "unknown-subject-kind",
    );

    assert.throws(
      () => validRequest({ phase: "superuser" }),
      (error) => error instanceof PolicyIrValidationError && error.code === "unknown-phase",
    );

    assert.throws(
      () =>
        createDecision(validRequest(), {
          effect: "super-allow",
          reason: "bad fixture",
          evidence: { policyIds: [], engine: "fixture" },
        }),
      (error) => error instanceof PolicyIrValidationError && error.code === "unknown-effect",
    );
  });

  it("fails closed when subject is omitted instead of defaulting to a privileged subject", () => {
    assert.throws(
      () =>
        parseDecisionRequest({
          schemaVersion: POLICY_IR_SCHEMA_VERSION,
          action: "deployment.apply",
          resource: { kind: "deployment", id: "dep:checkout" },
          phase: "apply",
          context: {},
        }),
      (error) => error instanceof PolicyIrValidationError && error.code === "missing-subject",
    );
  });

  it("keeps unrecognized action strings representable for deny-by-default policy", () => {
    const request = validRequest({
      action: "hobo:future-resource:launch",
      resource: { kind: "hobo:future-resource", id: "future-1" },
    });
    const decision = createDecision(request, {
      effect: "deny",
      reason: "unmapped action denied by default",
      violations: [{ code: "unmapped-action", action: request.action }],
      evidence: { policyIds: ["policy:deny-default"], engine: "builtin-typescript@0.1.0" },
    });

    assert.equal(request.action, "hobo:future-resource:launch");
    assert.equal(decision.effect, "deny");
    assert.equal(decision.violations[0].action, "hobo:future-resource:launch");
  });

  it("pins schema version and migrates typed v0 request documents to v1", () => {
    assert.throws(
      () => validRequest({ schemaVersion: "hobo.policy-ir/v2" }),
      (error) =>
        error instanceof PolicyIrValidationError && error.code === "unsupported-version",
    );

    const migrated = migratePolicyIrDocument({
      schemaVersion: "hobo.policy-ir/v0",
      subjectKind: "service",
      subjectId: "svc:planner",
      action: "deployment.plan",
      resourceKind: "deployment",
      resourceId: "dep:checkout",
      lifecycle: "plan",
      context: { provider: "local" },
    });

    assert.equal(migrated.schemaVersion, POLICY_IR_SCHEMA_VERSION);
    assert.equal(migrated.subject.kind, "service");
    assert.equal(migrated.phase, "plan");
    assert.equal(migrated.resource.id, "dep:checkout");
    assert.match(migrated.inputHash, /^sha256:[a-f0-9]{64}$/);
  });

  it("encodes decisions to the WIT-record shape and back", () => {
    const request = validRequest();
    const decision = createDecision(request, {
      effect: "mutate",
      reason: "auth middleware required before public endpoint apply",
      mutations: [{ path: "/graph/middleware", op: "add", value: "auth" }],
      evidence: { policyIds: ["policy:public-endpoint"], engine: "builtin-typescript@0.1.0" },
    });

    const witRecord = toWitDecisionRecord(decision);

    assert.equal(witRecord.schema_version, POLICY_IR_SCHEMA_VERSION);
    assert.equal(witRecord.evidence.input_hash, request.inputHash);
    assert.deepEqual(fromWitDecisionRecord(witRecord, request), decision);
  });
});
