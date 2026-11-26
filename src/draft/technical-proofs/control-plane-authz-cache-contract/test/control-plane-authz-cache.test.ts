import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONTROL_PLANE_AUTHZ_NFR,
  createControlPlaneAuthorizer,
  createCrewOperatorRepairLoopRequest,
  createManualClock,
  runControlPlaneAuthzBenchmark,
} from "../src/control-plane-authz-cache.js";

const PACK_V1 = {
  packVersion: "policy-pack:prod-governance@1",
  packDigest: "sha256:prod-governance-v1",
};

test("benchmark proves hot-path p99 with cache and no management-plane round trip", () => {
  const clock = createManualClock(0);
  let localEvaluations = 0;
  const authorizer = createControlPlaneAuthorizer({
    clock,
    policyEvaluator: () => {
      localEvaluations += 1;
      return {
        effect: "allow",
        reason: "operator dispatch allowed by local policy pack",
        policyIds: ["yard-prod/operator-dispatch"],
      };
    },
  });

  const report = runControlPlaneAuthzBenchmark({
    authorizer,
    request: createCrewOperatorRepairLoopRequest(),
    ...PACK_V1,
    iterations: 1_000,
  });

  assert.equal(report.managementPlaneCalls, 0);
  assert.equal(localEvaluations, 1);
  assert.equal(report.effects.at(0), "allow");
  assert.equal(report.cacheMisses, 1);
  assert.equal(report.cacheHits, 999);
  assert.ok(report.cacheHitRatio >= 0.999);
  assert.ok(report.p99Ms <= CONTROL_PLANE_AUTHZ_NFR.p99TargetMs, `${report.p99Ms}ms`);
  assert.ok(
    report.p99Ms <= CONTROL_PLANE_AUTHZ_NFR.crewOperatorRepairLoopP99TargetMs,
    `${report.p99Ms}ms`,
  );
});

test("revoked role stops being honored within the propagation bound, not at cache TTL expiry", () => {
  const clock = createManualClock(0);
  const authorizer = createControlPlaneAuthorizer({
    clock,
    policyEvaluator: () => ({
      effect: "allow",
      reason: "cached operator dispatch allow",
      policyIds: ["yard-prod/operator-dispatch"],
    }),
  });
  const request = createCrewOperatorRepairLoopRequest();
  const first = authorizer.evaluate({ request, ...PACK_V1 });

  assert.equal(first.decision.effect, "allow");
  assert.equal(first.cacheHit, false);
  assert.equal(first.cacheExpiresAtMs, CONTROL_PLANE_AUTHZ_NFR.decisionCacheTtlMs);

  const revokedAtMs = 1_000;
  const observedAtMs = revokedAtMs + CONTROL_PLANE_AUTHZ_NFR.revocationPropagationBoundMs;
  clock.set(observedAtMs);
  authorizer.observeRoleRevocation({
    subjectId: request.subject.id,
    role: "Operator-Supervisor",
    revokedAtMs,
    observedAtMs,
    sequence: "rbac-revocation-42",
  });

  assert.ok(clock.nowMs() < first.cacheExpiresAtMs, "cache TTL had not expired yet");
  const afterRevocation = authorizer.evaluate({ request, ...PACK_V1 });

  assert.equal(afterRevocation.decision.effect, "deny");
  assert.equal(afterRevocation.revoked, true);
  assert.match(afterRevocation.decision.reason, /revoked within control-plane authz propagation bound/);
  assert.equal(authorizer.cacheSize(), 0);
});

test("late revocation propagation fails closed instead of extending stale cache", () => {
  const authorizer = createControlPlaneAuthorizer({
    policyEvaluator: () => ({
      effect: "allow",
      reason: "not used",
      policyIds: ["unused"],
    }),
  });

  assert.throws(
    () =>
      authorizer.observeRoleRevocation({
        subjectId: "agent:crew-operator/sre-repair",
        role: "Operator-Supervisor",
        revokedAtMs: 0,
        observedAtMs: CONTROL_PLANE_AUTHZ_NFR.revocationPropagationBoundMs + 1,
      }),
    /revocation propagation exceeded bound/,
  );
});

test("cache key includes policy-pack version and digest so changed packs cannot reuse stale allows", () => {
  const decisionsByPack = new Map([
    ["policy-pack:prod-governance@1", "allow"],
    ["policy-pack:prod-governance@2", "deny"],
  ]);
  let localEvaluations = 0;
  const authorizer = createControlPlaneAuthorizer({
    policyEvaluator: ({ packVersion }) => {
      localEvaluations += 1;
      const effect = decisionsByPack.get(packVersion);
      return {
        effect,
        reason: `${packVersion} returned ${effect}`,
        policyIds: [`${packVersion}/operator-dispatch`],
      };
    },
  });
  const request = createCrewOperatorRepairLoopRequest();

  const first = authorizer.evaluate({ request, ...PACK_V1 });
  const second = authorizer.evaluate({
    request: createCrewOperatorRepairLoopRequest({
      context: {
        policyPackVersion: "policy-pack:prod-governance@2",
        policyPackDigest: "sha256:prod-governance-v2",
      },
    }),
    packVersion: "policy-pack:prod-governance@2",
    packDigest: "sha256:prod-governance-v2",
  });

  assert.equal(first.decision.effect, "allow");
  assert.equal(second.decision.effect, "deny");
  assert.equal(second.cacheHit, false);
  assert.equal(localEvaluations, 2);
});

test("cached decisions still async-ship policy.Decided audit events", async () => {
  const shipped = [];
  const authorizer = createControlPlaneAuthorizer({
    auditSink: async (event) => shipped.push(event),
    policyEvaluator: () => ({
      effect: "allow",
      reason: "operator dispatch allowed",
      policyIds: ["yard-prod/operator-dispatch"],
    }),
  });
  const request = createCrewOperatorRepairLoopRequest();

  authorizer.evaluate({ request, ...PACK_V1 });
  const cached = authorizer.evaluate({ request, ...PACK_V1 });
  const flushed = await authorizer.flushAuditEvents();

  assert.equal(cached.cacheHit, true);
  assert.equal(flushed.length, 2);
  assert.equal(shipped.length, 2);
  assert.deepEqual(
    shipped.map((event) => event.type),
    ["policy.Decided", "policy.Decided"],
  );
  assert.equal(shipped[0].metadata.async, true);
  assert.equal(shipped[0].metadata.controlPlaneAuthz.cacheHit, false);
  assert.equal(shipped[1].metadata.controlPlaneAuthz.cacheHit, true);
  assert.equal(shipped[1].data.evidence.inputHash, cached.decision.evidence.inputHash);
});

test("high-frequency Crew operator cannot evade revocation by staying inside cache window", () => {
  const clock = createManualClock(0);
  const authorizer = createControlPlaneAuthorizer({
    clock,
    policyEvaluator: () => ({
      effect: "allow",
      reason: "operator repair loop allowed",
      policyIds: ["yard-prod/operator-dispatch"],
    }),
  });
  const request = createCrewOperatorRepairLoopRequest();

  for (let index = 0; index < 100; index += 1) {
    assert.equal(authorizer.evaluate({ request, ...PACK_V1 }).decision.effect, "allow");
    clock.advance(10);
  }

  const revokedAtMs = clock.nowMs();
  const observedAtMs = revokedAtMs + CONTROL_PLANE_AUTHZ_NFR.revocationPropagationBoundMs - 1;
  clock.set(observedAtMs);
  authorizer.observeRoleRevocation({
    subjectId: request.subject.id,
    role: "Operator-Supervisor",
    revokedAtMs,
    observedAtMs,
  });

  for (let index = 0; index < 100; index += 1) {
    const result = authorizer.evaluate({ request, ...PACK_V1 });
    assert.equal(result.decision.effect, "deny");
    assert.equal(result.revoked, true);
    assert.ok(clock.nowMs() < CONTROL_PLANE_AUTHZ_NFR.decisionCacheTtlMs);
  }

  const metrics = authorizer.getMetrics();
  assert.equal(metrics.localEvaluations, 1);
  assert.equal(metrics.cacheHits, 99);
  assert.equal(metrics.revocationsApplied, 1);
});
