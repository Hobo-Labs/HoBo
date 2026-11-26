import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertLaunchSitePrivateBetaEvidence,
  launchSitePrivateBetaEvidence,
  validateLaunchSitePrivateBetaEvidence
} from "../src/launch-site-private-beta-evidence.ts";

test("private beta launch messaging evidence maps required evidence, owners, blockers, risks, and dependencies", () => {
  const result = validateLaunchSitePrivateBetaEvidence(launchSitePrivateBetaEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(launchSitePrivateBetaEvidence.issue, "HOBO-465");
  assert.equal(launchSitePrivateBetaEvidence.phase, "M2");
  assert.equal(launchSitePrivateBetaEvidence.project, "V1 Launch Site, Messaging & Demo Assets");
  assert.ok(launchSitePrivateBetaEvidence.requiredEvidence.length >= 5);
  assert.ok(launchSitePrivateBetaEvidence.requiredEvidence.every((item) => item.ownerProject && item.evidenceSource));
  assert.ok(launchSitePrivateBetaEvidence.blockers.length >= 2);
  assert.ok(launchSitePrivateBetaEvidence.acceptedRisks.length >= 2);
  assert.ok(launchSitePrivateBetaEvidence.crossProjectDependencies.length >= 4);
  assert.equal(launchSitePrivateBetaEvidence.parentInitiativeSync.statusUpdated, true);
});

test("private beta gate preserves proof-mode labels and launch asset refresh ownership", () => {
  const assetsByKind = new Map(launchSitePrivateBetaEvidence.demoAssets.map((asset) => [asset.kind, asset]));

  for (const kind of ["claim-index", "demo-script", "command-transcript", "screenshot-set", "recording-manifest"]) {
    assert.ok(assetsByKind.has(kind), `missing ${kind}`);
    const asset = assetsByKind.get(kind);
    assert.ok(asset?.ownerProject, `${kind} missing owner project`);
    assert.ok(asset?.proofMode, `${kind} missing proof mode`);
    assert.ok(asset?.refreshTrigger, `${kind} missing refresh trigger`);
    assert.ok(asset?.sourceEvidenceId, `${kind} missing source evidence`);
  }

  assert.ok(
    launchSitePrivateBetaEvidence.demoAssets.some(
      (asset) => asset.proofMode === "live-recording" && asset.privateBetaOnly === true
    )
  );
});

test("follow-up execution issues are allowed only for missing private beta evidence", () => {
  for (const followUp of launchSitePrivateBetaEvidence.followUpIssues) {
    assert.ok(
      launchSitePrivateBetaEvidence.missingEvidence.some((missing) => missing.id === followUp.missingEvidenceId),
      `${followUp.id} does not reference missing evidence`
    );
  }
});

test("guard rejects public promotion, speculative follow-ups, missing owners, and unsynced launch risk", () => {
  const invalid = structuredClone(launchSitePrivateBetaEvidence);
  invalid.requiredEvidence.find((item) => item.id === "launch-asset-manifest")!.status = "pending";
  invalid.demoAssets.find((asset) => asset.kind === "recording-manifest")!.ownerProject = "";
  invalid.blockers = [];
  invalid.crossProjectDependencies[0]!.ownerProject = "";
  invalid.publicationGate.publicOrGaPromotionAllowed = true;
  invalid.followUpIssues.push({
    id: "speculative-public-site-build",
    ownerProject: "V1 Launch Site, Messaging & Demo Assets",
    missingEvidenceId: "claim-register",
    allowedReason: "Build the launch site even though claim-register evidence is accepted"
  });
  invalid.parentInitiativeSync.statusUpdated = false;

  const result = validateLaunchSitePrivateBetaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /launch-asset-manifest must be accepted/);
  assert.match(result.errors.join("\n"), /demo assets require owner project/);
  assert.match(result.errors.join("\n"), /blockers must be recorded/);
  assert.match(result.errors.join("\n"), /cross-project dependencies require owner project/);
  assert.match(result.errors.join("\n"), /private beta evidence cannot promote public or GA launch claims/);
  assert.match(result.errors.join("\n"), /follow-up is allowed only for missing evidence/);
  assert.match(result.errors.join("\n"), /parent initiative status must be updated/);
  assert.throws(() => assertLaunchSitePrivateBetaEvidence(invalid), /launch site private beta evidence invalid/);
});
