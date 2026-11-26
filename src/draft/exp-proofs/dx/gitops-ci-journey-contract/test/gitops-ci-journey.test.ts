import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  runCanDeploySkewScenario,
  runInvalidOidcScenario,
  runRollbackScenario,
  runScriptedGitOpsCiScenario,
  runWrongRevisionScenario,
  surfaceDriftReconcileEvent,
} from "../src/gitops-ci-journey.js";

describe("GitOps CI journey contract", () => {
  it("posts a read-only PR plan, ships staging, manages preview, and promotes a known-good revision keylessly", async () => {
    const result = await runScriptedGitOpsCiScenario({
      prNumber: 42,
      headSha: "sha-good-20260628",
      baseSha: "sha-base-20260628",
    });

    assert.equal(result.contractVersion, "hobo.gitops-ci-journey/v1");
    assert.deepEqual(result.commandOrder, [
      "hobo plan --camp staging",
      "hobo up --camp staging",
      "hobo up --camp pr-42",
      "hobo down --camp pr-42",
      "hobo up --camp prod --to sha-good-20260628",
    ]);

    assert.equal(result.prPlan.readOnly, true);
    assert.equal(result.prPlan.postedComment.kind, "hobo.plan");
    assert.equal(result.prPlan.sideEffectEvents.length, 0);
    assert.equal(result.prPlan.diff.status, "would-change");

    assert.equal(result.staging.status, "deployed");
    assert.equal(result.staging.revision, "sha-good-20260628");
    assert.equal(result.staging.events.at(-1).type, "deployment.UpCompleted");

    assert.equal(result.preview.opened.campId, "camp:acme:snapshop:pr-42");
    assert.match(result.preview.opened.url, /pr-42/);
    assert.equal(result.preview.teardown.status, "destroyed");
    assert.equal(result.preview.teardown.campId, "camp:acme:snapshop:pr-42");
    assert.equal(result.preview.abandonedSweep.action, "deprovision");
    assert.ok(result.preview.abandonedSweep.eventTypes.includes("deploy.PreviewTeardownRequested"));

    assert.equal(result.production.status, "deployed");
    assert.equal(result.production.revision, "sha-good-20260628");
    assert.equal(result.production.revisionSelector.kind, "explicit");

    assert.equal(result.identity.mode, "keyless-oidc");
    assert.equal(result.identity.persistedSecretCount, 0);
    assert.deepEqual(result.identity.tokenEventTypes, ["token.Granted", "token.Used"]);
    assert.equal(result.scopeOut.progressiveDeliveryHarnessUsed, false);
  });

  it("blocks a can-deploy skew before any prod apply with a machine-readable deploy-order fix", async () => {
    const result = await runCanDeploySkewScenario();

    assert.equal(result.status, "blocked");
    assert.equal(result.reason.code, "can-deploy.skew");
    assert.equal(result.reason.consumers[0], "cart-api");
    assert.match(result.fix.summary, /dual-publish/i);
    assert.equal(result.applied, false);
    assert.deepEqual(result.mutationEvents, []);
    assert.equal(result.events.at(-1).type, "deployment.PlanRejected");
  });

  it("re-realizes the last-good production revision on rollback", async () => {
    const result = await runRollbackScenario({
      failedRevision: "sha-bad-20260628",
      lastGoodRevision: "sha-good-previous",
    });

    assert.equal(result.status, "deployed");
    assert.equal(result.command, "hobo up --camp prod --rollback");
    assert.equal(result.revision, "sha-good-previous");
    assert.equal(result.revisionSelector.kind, "rollback");
    assert.equal(result.lastGoodRevision, "sha-good-previous");
  });

  it("rejects forged or expired OIDC before any GitOps command mutates state", async () => {
    const result = await runInvalidOidcScenario({ reason: "expired" });

    assert.equal(result.status, "blocked");
    assert.equal(result.identity.status, "rejected");
    assert.equal(result.identity.reason, "svid.expired");
    assert.deepEqual(result.executedCommands, []);
    assert.deepEqual(result.mutationEvents, []);
  });

  it("catches a wrong production revision at the promotion gate", async () => {
    const result = await runWrongRevisionScenario({ requestedRevision: "sha-unknown" });

    assert.equal(result.status, "blocked");
    assert.equal(result.reason.code, "revision.not-known-good");
    assert.equal(result.requestedRevision, "sha-unknown");
    assert.equal(result.applied, false);
    assert.equal(result.events.at(-1).type, "deployment.PlanRejected");
  });

  it("surfaces drift as an event and reconcile PR instead of silent apply", () => {
    const result = surfaceDriftReconcileEvent({
      camp: "staging",
      resourceId: "app:frontend",
      actualDigest: "digest-live",
      desiredDigest: "digest-git",
    });

    assert.equal(result.event.type, "resource.DriftDetected");
    assert.equal(result.event.data.resourceId, "app:frontend");
    assert.equal(result.reconcilePr.action, "open");
    assert.match(result.reconcilePr.title, /Reconcile drift/);
    assert.equal(result.silentApply, false);
  });
});
