import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  BINDLE,
  CLOUD_COMMANDS,
  FIXTURE_ID,
  createCliCloudYardPathRecord,
  createYardGateway,
  formatActionableError,
  rejectCloudPathScopeCreep,
  runFullCloudCommandSurface,
  runHoboDeploy,
  runHoboInspectDeploy,
  runHoboLogin,
  runHoboPlan,
  runJ1HelloBindleJourney,
  validateActionableError,
  validateCliCloudYardPathRecord,
} from "../src/cli-cloud-yard-path.js";

test("J1 journey runs hobo plan → hobo deploy → hobo inspect deploy for examples/hello-bindle", () => {
  const journey = runJ1HelloBindleJourney();

  assert.equal(journey.ok, true);
  assert.equal(journey.bindle, BINDLE);
  assert.equal(journey.fixtureId, FIXTURE_ID);
  assert.deepEqual(
    journey.steps.map((step) => step.command),
    ["hobo login", "hobo plan", "hobo deploy", "hobo inspect deploy"],
  );
  assert.equal(journey.plan.result.deploymentPlanId, "deployment-plan.hello-bindle.v1");
  assert.equal(journey.deploy.result.deploymentId, "deploy-hello-bindle-001");
  assert.equal(journey.inspect.result.state, "ready");
  assert.equal(journey.inspect.result.projectionSeq, 42);
});

test("cloud command surface covers login, plan, deploy, destroy, inspect deploy, and logs through Gateway", () => {
  const surface = runFullCloudCommandSurface();

  assert.deepEqual(surface.commands, [...CLOUD_COMMANDS]);
  assert.equal(surface.login.exitCode, 0);
  assert.equal(surface.logs.exitCode, 0);
  assert.match(surface.logs.stdout, /hello-bindle service ready/);
  assert.equal(surface.destroy.exitCode, 0);
});

test("dev SVID login stub returns scopes needed for deploy and projection reads", () => {
  const gateway = createYardGateway();
  const login = runHoboLogin(gateway);

  assert.equal(login.exitCode, 0);
  assert.equal(login.result.proofMode, "reference-fixture");
  assert.deepEqual(login.result.scopes, ["deploy:write", "projection:read", "logs:read"]);
});

test("plan preview returns DeploymentPlan id and cross-camp warning", () => {
  const gateway = createYardGateway();
  const login = runHoboLogin(gateway);
  const plan = runHoboPlan(gateway, { authorization: `Bearer ${login.result.svid}` });

  assert.equal(plan.exitCode, 0);
  assert.equal(plan.result.warnings.length, 1);
  assert.equal(plan.result.warnings[0]?.code, "plan.cross-camp-hop");
});

test("blocked deploy meets NFR-017 actionable-error bar with cause and remediation steps", () => {
  const gateway = createYardGateway();
  const login = runHoboLogin(gateway);
  const deploy = runHoboDeploy(gateway, {
    authorization: `Bearer ${login.result.svid}`,
    deploymentPlanId: "deployment-plan.gatekeeper-denied",
  });

  assert.equal(deploy.exitCode, 1);
  assert.ok(deploy.error);
  const validation = validateActionableError(deploy.error);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  const formatted = formatActionableError(deploy.error);
  assert.match(formatted.human, /cause:/);
  assert.match(formatted.human, /next:/);
  assert.match(formatted.human, /then:/);
  assert.match(formatted.human, /correlation:/);
});

test("stale inspect deploy returns actionable projection error", () => {
  const gateway = createYardGateway();
  const login = runHoboLogin(gateway);
  const inspect = runHoboInspectDeploy(gateway, {
    authorization: `Bearer ${login.result.svid}`,
    deploymentId: "deploy-stale-evidence",
  });

  assert.equal(inspect.exitCode, 1);
  assert.equal(inspect.error?.code, "projection.stale");
  assert.equal(validateActionableError(inspect.error!).ok, true);
});

test("unauthenticated plan is rejected before command dispatch", () => {
  const gateway = createYardGateway();
  const plan = runHoboPlan(gateway, { authorization: "Bearer missing" });

  assert.equal(plan.exitCode, 1);
  assert.equal(plan.error?.code, "auth.missing-svid");
});

test("scope creep into production CLI or live Yard is rejected", () => {
  const denials = rejectCloudPathScopeCreep([
    "Ship production packages/cli against a live Yard with real cloud apply.",
    "Add a reference fixture for hello-bindle Gateway mocks.",
  ]);

  assert.equal(denials.length, 1);
  assert.match(denials[0]?.reason ?? "", /out of scope/i);
});

test("proof record pins fixture, bindle, gateway routes, and J1 journey", () => {
  const record = createCliCloudYardPathRecord();

  assert.equal(record.issue, "HOBO-625");
  assert.equal(record.fixtureId, FIXTURE_ID);
  assert.equal(record.bindle, BINDLE);
  assert.equal(validateCliCloudYardPathRecord(record).ok, true);
});

test("contract artifacts and proof README exist", () => {
  const proto = readPackageFile("architecture/cli_cloud_yard_path.proto");
  const cue = readPackageFile("architecture/cli_cloud_yard_path.cue");
  const pact = JSON.parse(readPackageFile("architecture/pacts/cli_cloud_yard_path.pact.json"));
  const proofReadme = readRepoFile("docs/design/proofs/cli-cloud-yard-path/README.md");

  assert.match(proto, /message CliCloudYardPathRecord/);
  assert.match(cue, /#CliCloudYardPathRecord/);
  assert.equal(pact.interactions[0].request.path, "/v1/auth/login");
  assert.ok(
    pact.interactions.some(
      (interaction: { request: { path: string } }) =>
        interaction.request.path === "/v1/commands/destroy",
    ),
  );
  assert.ok(
    pact.interactions.some(
      (interaction: { request: { path: string } }) =>
        interaction.request.path === "/v1/streams/logs/deploy-hello-bindle-001",
    ),
  );
  assert.match(proofReadme, /HOBO-625/);
  assert.match(proofReadme, /hello-bindle/);
});

function readPackageFile(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function readRepoFile(path: string) {
  return readFileSync(new URL(`../../../../../../${path}`, import.meta.url), "utf8");
}
