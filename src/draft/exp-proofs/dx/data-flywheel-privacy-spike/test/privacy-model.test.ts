import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  authorizeRawTrajectoryAccess,
  createOptimizerPayload,
  evaluateTrajectoryPrivacy
} from "../src/privacy-model.js";

const policy = JSON.parse(
  await readFile(new URL("../fixtures/privacy-model.json", import.meta.url), "utf8")
);

function baseRequest(overrides = {}) {
  return {
    run: {
      id: "run-123",
      tenantId: "tenant-a",
      methodId: "support.classify",
      userId: "user-1",
      trace: {
        sampled: true,
        retentionDays: 14
      },
      requestedTrajectoryRetentionDays: 60
    },
    store: {
      tenantId: "tenant-a"
    },
    optimizer: {
      tenantId: "tenant-a",
      providerKind: "external"
    },
    tenantPolicy: {
      maxTrajectoryRetentionDays: 45,
      optOut: {
        tenants: [],
        methods: [],
        users: [],
        fields: []
      }
    },
    payload: [
      {
        path: "input.subject",
        classification: "public",
        value: "refund status"
      },
      {
        path: "input.accountTier",
        classification: "internal",
        value: "enterprise"
      },
      {
        path: "input.email",
        classification: "pii",
        value: "alice@example.com"
      },
      {
        path: "tool.headers.authorization",
        classification: "secret",
        value: "sk-live-123"
      }
    ],
    ...overrides
  };
}

test("Given mixed trajectory payloads when captured then PII and secrets are redacted before storage", () => {
  const decision = evaluateTrajectoryPrivacy(policy, baseRequest());

  assert.equal(decision.capture, true);
  assert.equal(decision.effectiveRetentionDays, 14);

  const subject = decision.fields.find((field) => field.path === "input.subject");
  assert.equal(subject.value, "refund status");

  const internal = decision.fields.find((field) => field.path === "input.accountTier");
  assert.equal(internal.value, undefined);
  assert.match(internal.hashRef, /^hash:/);

  const pii = decision.fields.find((field) => field.path === "input.email");
  assert.equal(pii.value, undefined);
  assert.equal(pii.redaction, "tokenized");
  assert.match(pii.tokenRef, /^tok:/);
  assert.match(pii.encryptedRef, /^enc:\/\//);

  const secret = decision.fields.find((field) => field.path === "tool.headers.authorization");
  assert.equal(secret.value, undefined);
  assert.equal(secret.tokenRef, undefined);
  assert.equal(secret.redaction, "sealed");
  assert.match(secret.encryptedRef, /^enc:\/\//);

  const serialized = JSON.stringify(decision);
  assert.equal(serialized.includes("alice@example.com"), false);
  assert.equal(serialized.includes("sk-live-123"), false);
});

test("Given a cross-tenant trajectory write when evaluated then capture fails closed", () => {
  const decision = evaluateTrajectoryPrivacy(
    policy,
    baseRequest({
      store: {
        tenantId: "tenant-b"
      }
    })
  );

  assert.equal(decision.capture, false);
  assert.deepEqual(
    decision.denials.map((denial) => denial.code),
    ["cross_tenant_trajectory_store"]
  );
  assert.deepEqual(decision.fields, []);
});

test("Given an external optimizer when raw sensitive access is requested then policy denies it", () => {
  const denied = authorizeRawTrajectoryAccess(policy, {
    run: {
      tenantId: "tenant-a"
    },
    requester: {
      tenantId: "tenant-a",
      providerKind: "external",
      purpose: "eval-debug",
      approvalId: "SEC-1"
    },
    classes: ["pii"]
  });

  assert.equal(denied.allowed, false);
  assert.equal(denied.denials[0].code, "external_sensitive_raw_access");

  const allowed = authorizeRawTrajectoryAccess(policy, {
    run: {
      tenantId: "tenant-a"
    },
    requester: {
      tenantId: "tenant-a",
      providerKind: "in-boundary",
      purpose: "eval-debug",
      approvalId: "SEC-1"
    },
    classes: ["pii"]
  });

  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.auditEvents, ["training.RawTrajectoryAccessApproved"]);
});

test("Given trace sampling and opt-out policy when evaluated then trajectories inherit both", () => {
  const sampledOut = evaluateTrajectoryPrivacy(
    policy,
    baseRequest({
      run: {
        ...baseRequest().run,
        trace: {
          sampled: false,
          retentionDays: 14
        }
      }
    })
  );

  assert.equal(sampledOut.capture, false);
  assert.equal(sampledOut.denials[0].code, "trace_sampled_out");

  const optedOut = evaluateTrajectoryPrivacy(
    policy,
    baseRequest({
      tenantPolicy: {
        maxTrajectoryRetentionDays: 45,
        optOut: {
          tenants: [],
          methods: ["support.classify"],
          users: [],
          fields: []
        }
      }
    })
  );

  assert.equal(optedOut.capture, false);
  assert.equal(optedOut.denials[0].code, "method_opted_out");

  const fieldOptOut = evaluateTrajectoryPrivacy(
    policy,
    baseRequest({
      tenantPolicy: {
        maxTrajectoryRetentionDays: 45,
        optOut: {
          tenants: [],
          methods: [],
          users: [],
          fields: ["input.email"]
        }
      }
    })
  );

  assert.equal(fieldOptOut.capture, true);
  assert.equal(
    fieldOptOut.fields.some((field) => field.path === "input.email"),
    false
  );
});

test("Given a cross-tenant optimizer when evaluated then capture fails closed", () => {
  const decision = evaluateTrajectoryPrivacy(
    policy,
    baseRequest({
      optimizer: {
        tenantId: "tenant-b",
        providerKind: "external"
      }
    })
  );

  assert.equal(decision.capture, false);
  assert.deepEqual(
    decision.denials.map((denial) => denial.code),
    ["cross_tenant_optimizer"]
  );
  assert.deepEqual(decision.fields, []);
});

test("Given PII in a prompt trajectory when optimizer payload is built then raw PII cannot be re-emitted", () => {
  const decision = evaluateTrajectoryPrivacy(
    policy,
    baseRequest({
      payload: [
        {
          path: "messages.0.content",
          classification: "pii",
          value: "Alice SSN 123-45-6789 needs help"
        },
        {
          path: "messages.1.content",
          classification: "public",
          value: "summarize support request"
        }
      ]
    })
  );

  const optimizerPayload = createOptimizerPayload(decision);
  const serialized = JSON.stringify(optimizerPayload);

  assert.equal(serialized.includes("Alice SSN 123-45-6789"), false);
  assert.equal(
    optimizerPayload.fields.some((field) => field.path === "messages.0.content"),
    true
  );
  assert.match(optimizerPayload.instructions.join(" "), /must not dereference/i);
});
