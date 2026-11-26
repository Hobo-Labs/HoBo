import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { agentSetupHelp, agentSetupMissingName, gbrainWithoutProvider } from "./implementations.ts";
import type { AgentSetupWorld } from "./world.ts";

function result(world: AgentSetupWorld) {
  assert.ok(world.result, "run an agent setup command first");
  return world.result;
}

When("I run agent setup help", function (this: AgentSetupWorld) {
  this.result = agentSetupHelp();
});

When("I run agent setup without an agent name", function (this: AgentSetupWorld) {
  this.result = agentSetupMissingName();
});

When("I run the optional gbrain launcher without a provider", function (this: AgentSetupWorld) {
  this.result = gbrainWithoutProvider();
});

Then("the agent setup command exits with {int}", function (this: AgentSetupWorld, status: number) {
  const observed = result(this);
  assert.equal(observed.status, status, observed.stderr);
});

Then("the agent setup output contains {string}", function (this: AgentSetupWorld, expected: string) {
  const observed = result(this);
  assert.ok(`${observed.stdout}\n${observed.stderr}`.includes(expected));
});

Then("the optional server was not started", function (this: AgentSetupWorld) {
  assert.equal(result(this).serverStarted, false);
});
