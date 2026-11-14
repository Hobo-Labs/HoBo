/**
 * Steps for features/fleet/degradation.feature (F4): with the bus down, a
 * device finishes the order it holds, keeps the receipt in
 * `AgentState.pendingReceipts`, takes no new work, and publishes the receipt
 * exactly once when the bus is back.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	enrollDevice,
	heldRunner,
	ReceiptStatus,
	Role,
	submitJob,
	until,
	type WorkReceipt,
	watchReceipts,
} from "../../../packages/fleet-authority/acceptance/index.js";
import { device, fleet, world } from "./state.js";

let run: ReturnType<typeof heldRunner> | undefined;
let receipts: WorkReceipt[] = [];

function runner() {
	if (run === undefined) throw new Error("no held runner in this scenario");
	return run;
}

const succeeded = () => receipts.filter((receipt) => receipt.status === ReceiptStatus.SUCCEEDED);

function connector() {
	const memory = world().opened.memory;
	if (memory === undefined) throw new Error("the outage switch needs the memory bus");
	return memory.connector;
}

Given("the developer's device {string} runs held jobs in {string}", async (name: string, id: string) => {
	const w = world();
	run = heldRunner();
	const roles = [Role.DISPATCHER, Role.EXECUTOR];
	const token = await w.token(id, name, roles);
	fleet.device = await enrollDevice(w, {
		fleet: id,
		name,
		roles,
		runners: [run.runner],
		proof: async () => ({ case: "bootstrapToken", value: token }),
	});
	assert.ok(fleet.device.response.ok);
	receipts = watchReceipts(w);
});

When("the developer submits the job {string} to {string} and the device starts running it", async (command: string, id: string) => {
	runner().hold();
	await device().agent.start();
	await submitJob(world(), "dev", id, [command]);
	await until(() => runner().ran.length === 1, 45_000, "the device to start the job");
});

When("the bus goes down", () => {
	connector().down(true);
});

When("the developer submits the job {string} to {string}", async (command: string, id: string) => {
	await submitJob(world(), "dev", id, [command]);
});

When("the running job finishes", async () => {
	runner().release();
	await until(async () => (await device().keys.readState()).pendingReceipts.length > 0, 10_000, "the receipt to queue");
});

Then("the job's SUCCEEDED receipt waits in the device's pending receipts", async () => {
	const state = await device().keys.readState();
	assert.equal(state.pendingReceipts.length, 1);
	assert.equal(succeeded().length, 0);
});

Then("the device has not started {string}", async (command: string) => {
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	assert.deepEqual(runner().ran, [JSON.stringify(["first"])]);
	assert.ok(!runner().ran.includes(JSON.stringify([command])));
});

When("the bus comes back", () => {
	connector().down(false);
});

Then("the pending receipt is published exactly once", async () => {
	await until(() => succeeded().length > 0, 30_000, "the queued receipt to be published");
	await until(async () => (await device().keys.readState()).pendingReceipts.length === 0, 10_000, "the queue to drain");
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	const self = await device().keys.open();
	const first = succeeded().filter((receipt) => receipt.memberId === self.memberId);
	assert.ok(first.length >= 1);
	const byOrder = new Map<string, number>();
	for (const receipt of first) byOrder.set(receipt.orderId, (byOrder.get(receipt.orderId) ?? 0) + 1);
	for (const [order, count] of byOrder) assert.equal(count, 1, `order ${order} has ${count} SUCCEEDED receipts`);
});
