/**
 * Steps for features/fleet/one-active.feature (§6.10, local mode): a
 * one-active fleet over per-member assignment-log replicas fails over from an
 * unhealthy active member, and admits a newly configured member through a
 * decided membership epoch.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { createOneActiveWorld, Health, type OneActiveWorld } from "../../../packages/fleet-authority/acceptance/index.js";

let oneActive: OneActiveWorld | undefined;

function fleetOf(): OneActiveWorld {
	if (oneActive === undefined) throw new Error("no one-active fleet in this scenario");
	return oneActive;
}

const names = (list: string) => list.split(",").map((name) => name.trim());

Given("a local one-active fleet {string} of {string}", async (_fleet: string, members: string) => {
	oneActive = await createOneActiveWorld({ names: names(members), membershipEpochs: false });
});

Given("a local one-active fleet {string} of {string} with membership epochs", async (_fleet: string, members: string) => {
	oneActive = await createOneActiveWorld({ names: names(members), membershipEpochs: true });
});

When("the fleet ticks", async () => {
	await fleetOf().tick();
});

When("the fleet ticks twice", async () => {
	await fleetOf().tick();
	await fleetOf().tick();
});

Then("{string} is the active member", async (name: string) => {
	assert.equal((await fleetOf().assignment()).active, name);
});

When("{string} reports QUOTA_EXHAUSTED and the fleet ticks", async (name: string) => {
	fleetOf().setHealth(name, Health.QUOTA_EXHAUSTED);
	await fleetOf().tick();
});

Then("the tick fails over to {string}", (name: string) => {
	const last = fleetOf().ticks.at(-1);
	assert.equal(last?.action, "failover");
	assert.equal(last?.target, name);
});

When("the seal wait passes and the fleet ticks", async () => {
	const world = fleetOf();
	world.advance(world.sealWaitMs + 1);
	await world.tick();
});

Then("the register's member set is {string}", async (members: string) => {
	assert.deepEqual((await fleetOf().assignment()).members, names(members));
});

When("a new deploy configures {string} and the fleet ticks", async (members: string) => {
	await fleetOf().reconfigure(names(members));
	await fleetOf().tick();
});

Then("the tick admits {string} in a decided membership epoch", (name: string) => {
	const last = fleetOf().ticks.at(-1);
	assert.equal(last?.action, "membership");
	assert.deepEqual(last?.reasons, [`admit:${name}`, "proposal-decided"]);
});
