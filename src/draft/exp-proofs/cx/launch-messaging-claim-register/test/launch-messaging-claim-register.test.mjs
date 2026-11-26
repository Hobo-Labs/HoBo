import assert from "node:assert/strict";
import { test } from "vitest";

const CLAIM_STATES = ["implemented", "simulated-reference", "beta-only", "future-roadmap"];

async function loadContract() {
  const module = await import("../src/launch-messaging-claim-register.mjs").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("claim register lists public claims with evidence owner, source, risk, and proof state", async () => {
  const { launchMessagingClaimRegister, validateLaunchMessagingClaimRegister } = await loadContract();
  const result = validateLaunchMessagingClaimRegister(launchMessagingClaimRegister);

  assert.deepEqual(result.errors, []);
  assert.equal(launchMessagingClaimRegister.issue, "HOBO-406");
  assert.equal(launchMessagingClaimRegister.project, "V1 Launch Site, Messaging & Demo Assets");
  assert.equal(launchMessagingClaimRegister.phase, "M0");
  assert.ok(launchMessagingClaimRegister.publicClaims.length >= 5);

  for (const claim of launchMessagingClaimRegister.publicClaims) {
    assert.ok(claim.id);
    assert.ok(claim.claim);
    assert.ok(CLAIM_STATES.includes(claim.state), `${claim.id} has invalid state`);
    assert.ok(claim.evidenceOwner, `${claim.id} missing evidence owner`);
    assert.ok(claim.evidenceSource, `${claim.id} missing evidence source`);
    assert.match(claim.riskRating, /^(low|medium|high)$/);
  }
});

test("claim states distinguish implemented, simulated, beta-only, and roadmap claims", async () => {
  const { launchMessagingClaimRegister } = await loadContract();
  const states = new Set(launchMessagingClaimRegister.publicClaims.map((claim) => claim.state));

  assert.deepEqual([...states].sort(), [...CLAIM_STATES].sort());
});

test("demo assets required for launch are listed with owner and proof mode", async () => {
  const { launchMessagingClaimRegister } = await loadContract();

  assert.deepEqual(
    launchMessagingClaimRegister.demoAssets.map((asset) => asset.kind),
    ["claim-index", "demo-script", "command-transcript", "screenshot-set", "recording-manifest"],
  );
  assert.equal(
    launchMessagingClaimRegister.demoAssets.every((asset) => asset.owner && asset.proofMode && asset.refreshTrigger),
    true,
  );
});

test("unsupported or risky claims are routed to scope-out or follow-up before publication", async () => {
  const { launchMessagingClaimRegister, validateLaunchMessagingClaimRegister } = await loadContract();

  assert.ok(launchMessagingClaimRegister.scopeOut.length >= 3);
  assert.ok(launchMessagingClaimRegister.followUps.length >= 3);
  assert.equal(
    launchMessagingClaimRegister.followUps.every((followUp) => followUp.claimId && followUp.ownerProject && followUp.reason),
    true,
  );

  const invalid = structuredClone(launchMessagingClaimRegister);
  invalid.publicClaims.push({
    id: "claim.unowned-production-readiness",
    claim: "HoBo is production-ready for every customer workload.",
    state: "implemented",
    evidenceOwner: "launch",
    evidenceSource: "docs/design/vision.md#plan-17",
    riskRating: "high",
    publicationDisposition: "publish",
  });

  const result = validateLaunchMessagingClaimRegister(invalid);

  assert.match(result.errors.join("\n"), /high-risk claims require follow-up or scope-out routing/);
});

test("publication guard rejects evidence-less claims and launch-site scope creep", async () => {
  const { launchMessagingClaimRegister, validateLaunchMessagingClaimRegister } = await loadContract();
  const invalid = structuredClone(launchMessagingClaimRegister);

  invalid.publicClaims[0].evidenceSource = "";
  invalid.demoAssets.push({
    kind: "launch-site",
    owner: "marketing",
    proofMode: "published-page",
    refreshTrigger: "ship the public launch site",
  });

  const result = validateLaunchMessagingClaimRegister(invalid);

  assert.match(result.errors.join("\n"), /public claims require evidence owner and source/);
  assert.match(result.errors.join("\n"), /launch site implementation is scope-out/);
});
