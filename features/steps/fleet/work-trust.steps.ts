/**
 * Steps for features/fleet/work-trust.feature (§6.11): own work on a personal
 * device in S1, organisation work on a dedicated device in S3, and untrusted
 * work never on a personal device. The first two run end to end and read the
 * trust class and tier off the device's own receipt; the third asks the
 * device-side derivation, the sandbox table and the dispatcher's claim rules.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	browserApproval,
	checkClaim,
	claimOf,
	createFakeSandboxDriver,
	DeviceClass,
	deriveTrustClass,
	enrollDevice,
	FleetPolicySchema,
	create,
	finalReceipt,
	parseFleetId,
	parseWorkDigest,
	ReceiptStatus,
	Role,
	requiredSandbox,
	SandboxTier,
	submitJob,
	TrustClass,
	type WorkReceipt,
	watchReceipts,
} from "../../../packages/fleet-authority/acceptance/index.js";
import { offerNamed } from "./claims.steps.js";
import { device, fleet, world } from "./state.js";

const BOTH = [Role.DISPATCHER, Role.EXECUTOR];
let receipt: WorkReceipt | undefined;

Given(
	"the developer's personal device {string} with an S1 sandbox enrolled through browser approval",
	async (name: string) => {
		const w = world();
		fleet.device = await enrollDevice(w, {
			fleet: "laptops",
			name,
			roles: BOTH,
			deviceClass: DeviceClass.PERSONAL,
			sandboxes: [createFakeSandboxDriver(SandboxTier.S1_CONTAINER)],
			proof: (keys) => browserApproval(w, "dev", keys),
		});
		assert.ok(fleet.device.response.ok);
	},
);

Given(
	"the developer's dedicated device {string} with an S3 sandbox enrolled with a bootstrap token",
	async (name: string) => {
		const w = world();
		const token = await w.token("laptops", name, BOTH);
		fleet.device = await enrollDevice(w, {
			fleet: "laptops",
			name,
			roles: BOTH,
			deviceClass: DeviceClass.DEDICATED,
			sandboxes: [createFakeSandboxDriver(SandboxTier.S3_MICROVM)],
			proof: async () => ({ case: "bootstrapToken", value: token }),
		});
		assert.ok(fleet.device.response.ok);
	},
);

When("the device starts and alice submits the job {string} to {string}", async (command: string, id: string) => {
	const w = world();
	const receipts = watchReceipts(w);
	await device().agent.start();
	receipt = await finalReceipt(receipts, await submitJob(w, "alice", id, command.split(" ")), 45_000);
	fleet.notes.set("receipt-status", ReceiptStatus[receipt.status] ?? "");
	fleet.notes.set("receipt-member", receipt.memberId);
	fleet.notes.set("receipt-reason", receipt.reason);
	fleet.notes.set("receipt-trust", TrustClass[receipt.trustClass] ?? "");
	fleet.notes.set("receipt-tier", SandboxTier[receipt.sandboxTier] ?? "");
});

Then("the receipt names trust class {word} in sandbox tier {word}", (trust: string, tier: string) => {
	assert.equal(fleet.notes.get("receipt-trust"), trust);
	assert.equal(fleet.notes.get("receipt-tier"), tier);
});

Then("the personal device derives trust class UNTRUSTED for it", async () => {
	const w = world();
	const self = await device().keys.open();
	const record = await w.bus.registry.member(self.memberId);
	assert.ok(record !== undefined);
	assert.equal(TrustClass[deriveTrustClass(offerNamed(fleet.notes.get("offer") ?? ""), record)], "UNTRUSTED");
});

Then("the sandbox table says never for UNTRUSTED work on a PERSONAL device", () => {
	assert.equal(requiredSandbox(TrustClass.UNTRUSTED, DeviceClass.PERSONAL, create(FleetPolicySchema), ""), "never");
	assert.equal(requiredSandbox(TrustClass.UNTRUSTED, DeviceClass.EPHEMERAL, create(FleetPolicySchema), ""), SandboxTier.S3_MICROVM);
});

Then("a claim by the personal device on it is not entitled to an order", async () => {
	const w = world();
	const self = await device().keys.open();
	const offer = offerNamed(fleet.notes.get("offer") ?? "");
	const verdict = await checkClaim(
		await claimOf(self, offer),
		{ fleet: parseFleetId(offer.fleet), digest: parseWorkDigest(offer.workDigest) },
		offer,
		{ registry: w.bus.registry, ranked: [], nowMs: w.now(), stepMs: 20_000 },
	);
	assert.equal(verdict, "not-entitled");
});
