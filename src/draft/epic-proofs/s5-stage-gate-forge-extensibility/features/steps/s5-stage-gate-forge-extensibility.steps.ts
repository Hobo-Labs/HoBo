/**
 * Executable step definitions for s5-stage-gate-forge-extensibility.feature.
 *
 * Drives the epic's real reference service (services/s5-stage-gate-reference.ts),
 * which composes the generation, signed-artifact registry, eval-promotion, and
 * live-fix technical-proof contracts into one offline Stage-5 drill. The drill
 * runs once and every scenario asserts against its real slice outputs.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runS5StageGateForgeDrill } from "../../services/s5-stage-gate-reference.js";

type ForgeDrill = Awaited<ReturnType<typeof runS5StageGateForgeDrill>>;

let drillPromise: Promise<ForgeDrill> | undefined;
function drill(): Promise<ForgeDrill> {
  drillPromise ??= runS5StageGateForgeDrill();
  return drillPromise;
}

type ForgeWorld = {
  forge?: ForgeDrill["forge"];
  registry?: ForgeDrill["registry"];
  bindleDeploy?: ForgeDrill["bindleDeploy"];
  stubImpl?: ForgeDrill["stubImpl"];
  liveFix?: ForgeDrill["liveFix"];
  adversarial?: ForgeDrill["adversarial"];
};

const world: ForgeWorld = {};

// --- Scenario: hobo forge yields a signed Registry listing -------------------

Given("the S5 forge drill against the no-egress reference backend", async () => {
  const result = await drill();
  world.forge = result.forge;
  world.registry = result.registry;
  world.adversarial = result.adversarial;
  assert.equal(result.forge.egressAttempts, 0, "the certification loop stays no-egress");
});

When("hobo forge certifies the generated provider", () => {
  const forge = world.forge;
  assert.ok(forge, "the forge slice must have run");
  assert.match(forge.command, /^hobo forge /);
  assert.equal(forge.outcome, "certified");
});

Then("the forged provider passes per-interface conformance and trace replay", () => {
  const forge = world.forge;
  assert.ok(forge);
  assert.equal(forge.conformancePassed, true);
  assert.equal(forge.traceReplayPassed, true);
  assert.ok(forge.provenancePinned, "certification pins SLSA provenance");
});

Then(
  "the Registry records gen.PluginCertified and lists the forged provider without auto-selection",
  () => {
    const registry = world.registry;
    assert.ok(registry, "the registry slice must have run");
    assert.equal(registry.eventType, "gen.PluginCertified");
    assert.equal(registry.installOk, true);
    assert.equal(registry.availableToMatching, true);
    assert.equal(registry.selectedByMatching, false, "Matching never auto-selects the listing");
    assert.equal(registry.assurance, "integrity-and-conformance-verified");
  },
);

Then("tampered or unsigned forged artifacts fail install verification", () => {
  const adversarial = world.adversarial;
  assert.ok(adversarial, "the adversarial slice must have run");
  assert.equal(adversarial.tamperedArtifactRefused, true);
  assert.equal(adversarial.unsignedArtifactRefused, true);
});

// --- Scenario: Forged provider deploys a Bindle resource end-to-end ----------

Given("a certified forged provider installed from the Registry", async () => {
  const result = await drill();
  assert.equal(result.registry.installOk, true, "install verification must have passed");
  world.bindleDeploy = result.bindleDeploy;
});

When("the engineer deploys a Bindle claiming the forged provider capability", () => {
  const bindleDeploy = world.bindleDeploy;
  assert.ok(bindleDeploy, "the bindle deploy slice must have run");
  assert.equal(bindleDeploy.outcome, "succeeded");
});

Then(
  "the forged-provider Bindle resource reaches ready with the provider digest pinned",
  () => {
    const bindleDeploy = world.bindleDeploy;
    assert.ok(bindleDeploy);
    assert.equal(bindleDeploy.resourceStatus, "ready");
    assert.equal(bindleDeploy.providerDigestPinned, true);
    assert.deepEqual(bindleDeploy.events, [
      "deploy.Requested",
      "provider.ResourceProvisioned",
      "deploy.Succeeded",
    ]);
  },
);

// --- Scenario: Stub port implementation promotes through the eval gate -------

Given("recorded stub traces and a conformance-green forge candidate", async () => {
  const result = await drill();
  world.stubImpl = result.stubImpl;
  assert.equal(result.stubImpl.traceReplay, "passed", "recorded traces replay");
});

When("the S5 eval promotion gate evaluates the stub challenger", () => {
  assert.ok(world.stubImpl, "the stub promotion slice must have run");
  assert.equal(world.stubImpl.evalGate, "passed");
});

Then("the stub challenger promotes through conformance, eval, and policy lenses", () => {
  const stubImpl = world.stubImpl;
  assert.ok(stubImpl);
  assert.equal(stubImpl.promotionOutcome, "promoted");
  assert.ok(stubImpl.events.includes("eval.GatePassed"), "promotion emits eval.GatePassed");
  assert.ok(stubImpl.events.includes("impl.Promoted"), "promotion emits impl.Promoted");
  assert.deepEqual(stubImpl.failures, []);
});

// --- Scenario: Gated live-fix auto-rolls back ---------------------------------

Given("a staging SLO incident and a low-risk generated fix candidate", async () => {
  const result = await drill();
  world.liveFix = result.liveFix;
  world.adversarial = result.adversarial;
});

When("the S5 canary observes an SLO regression", () => {
  assert.ok(world.liveFix, "the live-fix slice must have run");
  assert.equal(world.liveFix.status, "rolled-back");
});

Then(
  "the live-fix deployment rolls back and retains the failing trace as a regression test",
  () => {
    const liveFix = world.liveFix;
    assert.ok(liveFix);
    assert.equal(liveFix.autoRollback, true);
    assert.equal(liveFix.regressionTestRetained, true);
    assert.ok(liveFix.regressionTestId, "the retained regression test has an id");
    assert.ok(liveFix.eventTypes.includes("deployment.RolledBack"));
    assert.ok(liveFix.eventTypes.includes("livefix.RegressionTestRetained"));
  },
);

Then("a high-risk production live-fix candidate is held for human approval", () => {
  const adversarial = world.adversarial;
  assert.ok(adversarial);
  assert.equal(adversarial.highRiskNeedsApproval, true);
  assert.equal(adversarial.highRiskStatus, "needs-approval");
});
