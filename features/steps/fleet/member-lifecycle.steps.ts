/**
 * Steps for features/fleet/member-lifecycle.feature: clone detection and
 * unlock (F7), a lost refresh answer (F19), revocation, and key-bundle
 * rotation, each against the real authority and agent.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	checkClaim,
	claimOf,
	copiedKeyStore,
	CredentialRequestSchema,
	create,
	fromBinary,
	KeyBundleSchema,
	KeyRotationRequestSchema,
	keyBundle,
	LifecycleRequestSchema,
	MemberState,
	memberCaller,
	offerOf,
	parseFleetId,
	parseWorkDigest,
	until,
} from "../../../packages/fleet-authority/acceptance/index.js";
import { device, fleet, world } from "./state.js";

const STEP_MS = 20_000;

async function recordOfDevice() {
	const w = world();
	const self = await device().keys.open();
	await w.runtime.tickOnce();
	return w.bus.registry.member(self.memberId);
}

Then("the device is LOCKED in the registry", async () => {
	assert.equal(MemberState[(await recordOfDevice())?.state ?? 0], "LOCKED");
});

Then("the device is REVOKED in the registry", async () => {
	assert.equal(MemberState[(await recordOfDevice())?.state ?? 0], "REVOKED");
});

Given("a copy of the device's key directory is taken", async () => {
	const state = await device().keys.readState();
	copies.set("copy", copiedKeyStore(device().keys, state));
});

const copies = new Map<string, ReturnType<typeof copiedKeyStore>>();

When("the device and its copy both start and refresh their credentials", async () => {
	const w = world();
	await device().agent.start();
	const copy = copies.get("copy");
	assert.ok(copy !== undefined);
	const clone = w.agent({ keys: copy });
	await clone.agent.start();
	await until(
		async () => (await recordOfDevice())?.state === MemberState.LOCKED,
		10_000,
		"the authority to lock the cloned device",
	);
});

Then("the agent logged that the member was locked", () => {
	assert.ok(world().logged.some((line) => line.event === "hobo_fleet_member_locked"));
});

async function lifecycle(action: "unlock" | "revoke") {
	const w = world();
	const { caller } = await w.person("dev");
	const self = await device().keys.open();
	const answer = await w.authority[action](
		{ memberId: self.memberId, request: create(LifecycleRequestSchema, { reason: "acceptance" }) },
		caller,
	);
	assert.ok(answer.ok, answer.ok ? "" : `${answer.error.code}: ${answer.error.message}`);
	await w.runtime.tickOnce();
}

When("the developer unlocks the device", async () => {
	await lifecycle("unlock");
});

When("the developer revokes the device", async () => {
	await lifecycle("revoke");
});

Given("the authority's answers to the device's next two credential refreshes are lost", () => {
	let drops = 2;
	world().dropAnswers((exchange) => {
		if (!exchange.path.endsWith("/credentials") || drops === 0) return false;
		drops -= 1;
		return true;
	});
});

When("the device starts", async () => {
	await device().agent.start();
});

Then("the device still holds generation 0 and its pending refresh nonce", async () => {
	const state = await device().keys.readState();
	assert.equal(state.generation, 0);
	assert.equal(state.pendingRefreshNonce?.length, 16);
});

When("the device stops and a new agent starts on the same key directory", async () => {
	const w = world();
	await device().agent.stop();
	const again = w.agent({ keys: device().keys });
	fleet.device = { ...device(), agent: again.agent };
	await again.agent.start();
});

Then("the device holds generation 1 with no pending refresh nonce", async () => {
	const state = await device().keys.readState();
	assert.equal(state.generation, 1);
	assert.equal(state.pendingRefreshNonce, undefined);
});

async function claimVerdict(signer: "current" | "retired") {
	const w = world();
	const self = await device().keys.open();
	const retired = fleet.retiredSign;
	const offer = offerOf(self, "laptops", w.now());
	const claim = await claimOf(self, offer, signer === "retired" && retired !== undefined ? retired : self.sign);
	return checkClaim(
		claim,
		{ fleet: parseFleetId("laptops"), digest: parseWorkDigest(offer.workDigest) },
		offer,
		{ registry: w.bus.registry, ranked: [], nowMs: w.now(), stepMs: STEP_MS },
	);
}

Then("a claim the device signs is not entitled to an order", async () => {
	assert.equal(await claimVerdict("current"), "not-entitled");
});

Then("the device's credential refresh is refused as member-revoked, so it gets no bus ticket", async () => {
	const w = world();
	const self = await device().keys.open();
	const state = await device().keys.readState();
	const refreshed = await w.authority.credentials(
		{
			memberId: self.memberId,
			request: create(CredentialRequestSchema, {
				generation: state.generation,
				refreshNonce: new Uint8Array(16).fill(9),
				agentVersion: "1.0.0",
			}),
		},
		memberCaller(self.memberId, self.signPublicKey, w.now()),
	);
	assert.equal(refreshed.ok ? "ok" : refreshed.error.code, "member-revoked");
});

When("the device rotates its operational keys and registers key bundle 2", async () => {
	const w = world();
	const before = await device().keys.open();
	fleet.retiredSign = before.sign;
	const after = await device().keys.rotateOperational();
	const rotated = await w.authority.rotateKeys(
		{
			memberId: after.memberId,
			request: create(KeyRotationRequestSchema, { keyBundle: await keyBundle(after, 2, w.now()) }),
		},
		memberCaller(before.memberId, before.signPublicKey, w.now()),
	);
	assert.ok(rotated.ok, rotated.ok ? "" : `${rotated.error.code}: ${rotated.error.message}`);
	await w.runtime.tickOnce();
});

Then("the registry holds key bundle 2 for the device", async () => {
	const record = await recordOfDevice();
	const bundle = fromBinary(KeyBundleSchema, record?.keyBundle?.payload ?? new Uint8Array());
	assert.equal(bundle.sequence, 2);
});

Then("a claim signed with the device's new SIGN key is valid", async () => {
	assert.equal(await claimVerdict("current"), "valid");
});

Then("a claim signed with the device's retired SIGN key is discarded", async () => {
	assert.equal(await claimVerdict("retired"), "discard");
});
