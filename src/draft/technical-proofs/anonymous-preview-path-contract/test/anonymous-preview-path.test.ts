import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  authorizeAnonymousPreviewAccess,
  createAnonymousPreviewPlan,
  createClaimHandoff,
  expireAnonymousPreview,
} from "../src/anonymous-preview-path.js";

describe("anonymous npx hobo up preview path contract", () => {
  it("routes no-identity/no-Camp npx hobo up to a 24h hosted anonymous preview with a live URL", () => {
    const plan = createAnonymousPreviewPlan(baseRequest(), deterministicOptions());

    assert.equal(plan.status, "ready");
    assert.equal(plan.route, "hosted-anonymous-preview");
    assert.deepEqual(plan.invocation, {
      executable: "npx",
      package: "hobo",
      args: ["up"],
      priorInstallRequired: false,
    });
    assert.equal(plan.deployment.ownerAccountId, null);
    assert.equal(plan.deployment.ownership, "unowned");
    assert.equal(plan.deployment.claimable, true);
    assert.equal(plan.deployment.camp.envType, "ephemeral");
    assert.equal(plan.deployment.camp.inferred, true);
    assert.equal(plan.deployment.camp.approval, "auto-approved");
    assert.equal(plan.deployment.url, "https://snapshop-nonce0123456789abcdef012345.preview.hobo.dev");
    assert.equal(plan.deployment.ttl.hours, 24);
    assert.equal(plan.deployment.ttl.expiresAt, "2026-06-27T10:00:00.000Z");
    assert.match(plan.message, /24h TTL/);
    assert.match(plan.message, /hobo claim claim:/);
    assert.deepEqual(
      plan.events.map((event) => event.type),
      [
        "anonymousPreview.Requested",
        "anonymousPreview.InferredCampApproved",
        "anonymousPreview.DeploymentRecorded",
        "anonymousPreview.TtlScheduled",
      ],
    );
  });

  it("records an unowned claimable deployment handoff that preserves URL and state for hobo claim", () => {
    const plan = createAnonymousPreviewPlan(baseRequest(), deterministicOptions());

    assert.equal(plan.record.kind, "hobo.anonymous-preview-record.v1");
    assert.equal(plan.record.ownerAccountId, null);
    assert.equal(plan.record.claimable, true);
    assert.equal(plan.record.url, plan.deployment.url);
    assert.equal(plan.record.stateDigest, plan.deployment.stateDigest);

    const handoff = createClaimHandoff(plan.record);
    assert.equal(handoff.implementedBy, "HOBO-136");
    assert.equal(handoff.claimCommand, `hobo claim ${plan.record.claimRef}`);
    assert.equal(handoff.preserves.url, plan.deployment.url);
    assert.equal(handoff.preserves.stateDigest, plan.deployment.stateDigest);
    assert.equal(handoff.preserves.deploymentId, plan.deployment.id);
  });

  it("auto-expires the anonymous deployment and requests teardown even when the client never returns", () => {
    const plan = createAnonymousPreviewPlan(baseRequest(), deterministicOptions());

    const beforeTtl = expireAnonymousPreview(plan.record, {
      now: "2026-06-27T09:59:59.000Z",
    });
    assert.equal(beforeTtl.action, "none");
    assert.equal(beforeTtl.record.state, "active");

    const expired = expireAnonymousPreview(plan.record, {
      now: "2026-06-27T10:00:01.000Z",
    });
    assert.equal(expired.action, "teardown");
    assert.equal(expired.record.state, "expired");
    assert.equal(expired.record.url, plan.deployment.url);
    assert.deepEqual(
      expired.events.map((event) => event.type),
      ["anonymousPreview.TtlExpired", "anonymousPreview.TeardownRequested"],
    );
  });

  it("honors abuse and rate caps before policy/provisioning and returns no public URL", () => {
    const plan = createAnonymousPreviewPlan({
      ...baseRequest(),
      abuseGate: {
        status: "denied",
        code: "anonymous.rate-limit",
        reason: "anonymous preview rate cap reached",
        retryAfterSeconds: 600,
      },
    }, deterministicOptions());

    assert.equal(plan.status, "blocked");
    assert.equal(plan.code, "anonymous.rate-limit");
    assert.equal(plan.url, null);
    assert.equal(plan.deployment, null);
    assert.match(plan.reason, /rate cap/);
    assert.equal(plan.events.at(-1).type, "anonymousPreview.Blocked");
    assert.equal(plan.events.some((event) => event.type === "anonymousPreview.DeploymentRecorded"), false);
  });

  it("denies anonymous cross-tenant read/write attempts", () => {
    const plan = createAnonymousPreviewPlan(baseRequest(), deterministicOptions());

    const ownRead = authorizeAnonymousPreviewAccess(plan.deployment, {
      tenantId: plan.deployment.tenantId,
      operation: "read",
    });
    assert.equal(ownRead.decision, "allow");

    const foreignWrite = authorizeAnonymousPreviewAccess(plan.deployment, {
      tenantId: "tenant:acme-prod",
      operation: "write",
    });
    assert.equal(foreignWrite.decision, "deny");
    assert.equal(foreignWrite.code, "anonymous.cross-tenant-denied");
    assert.match(foreignWrite.reason, /cannot write tenant:acme-prod/);
  });

  it("fails hosted policy gate as a clean no-op with a reason and no partial public URL", () => {
    const plan = createAnonymousPreviewPlan({
      ...baseRequest(),
      hostedPolicyGate: {
        status: "denied",
        code: "hosted.inferred-camp-disabled",
        reason: "hosted anonymous inferred Camps are temporarily disabled",
      },
    }, deterministicOptions());

    assert.equal(plan.status, "blocked");
    assert.equal(plan.code, "hosted.inferred-camp-disabled");
    assert.equal(plan.url, null);
    assert.equal(plan.deployment, null);
    assert.match(plan.reason, /disabled/);
    assert.equal(plan.events.at(-1).type, "anonymousPreview.Blocked");
    assert.equal(plan.events.some((event) => event.type === "anonymousPreview.InferredCampApproved"), false);
  });

  it("rejects guessable anonymous preview URLs", () => {
    assert.throws(
      () => createAnonymousPreviewPlan(baseRequest(), {
        ...deterministicOptions(),
        nonceFactory: () => "wandering-otter-7",
      }),
      /anonymous preview nonce must be at least 128 bits/,
    );
  });
});

function baseRequest(overrides = {}) {
  return {
    command: "npx hobo up",
    identity: null,
    camp: null,
    project: {
      name: "snapshop",
      directory: "C:/tmp/snapshop",
      bindleDigest: "sha256:bindle-snapshop",
    },
    hostedCloud: {
      name: "hobo-hosted",
      previewDomain: "preview.hobo.dev",
      autoApproveInferredCamp: true,
    },
    hostedPolicyGate: {
      status: "approved",
      policyId: "hosted-anonymous-preview-default",
    },
    abuseGate: {
      status: "approved",
      budgetId: "anonymous-preview-budget",
    },
    ...overrides,
  };
}

function deterministicOptions() {
  return {
    now: "2026-06-26T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}-001`,
    nonceFactory: () => "nonce0123456789abcdef012345",
  };
}
