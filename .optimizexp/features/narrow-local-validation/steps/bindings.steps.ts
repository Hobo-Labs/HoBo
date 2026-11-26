import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { inspectStagedChecks } from "./implementations.ts";
import type { StagedCheckWorld } from "./world.ts";

function result(world: StagedCheckWorld) {
  assert.ok(world.result, "run staged-check selection first");
  return world.result;
}

When("I run staged-check selection for {word}", function (this: StagedCheckWorld, change: string) {
  assert.ok(change === "empty" || change === "package" || change === "skill");
  this.result = inspectStagedChecks(change);
});

When("I run staged-check selection with an invalid base", function (this: StagedCheckWorld) {
  this.result = inspectStagedChecks("skill", "missing-base");
});

Then("the staged gate command exits with {int}", function (this: StagedCheckWorld, status: number) {
  const observed = result(this);
  assert.equal(observed.status, status, observed.stderr);
});

Then("the staged gate output contains {string}", function (this: StagedCheckWorld, expected: string) {
  const observed = result(this);
  assert.ok(`${observed.stdout}\n${observed.stderr}`.includes(expected));
});

Then("the staged gate output excludes {string}", function (this: StagedCheckWorld, unexpected: string) {
  const observed = result(this);
  assert.ok(!`${observed.stdout}\n${observed.stderr}`.includes(unexpected));
});
