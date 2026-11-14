/**
 * Steps for features/fleet/claims.feature (O8 behaviour): a forged claim is
 * discarded and attributes nothing; a signature-valid claim from outside the
 * fleet is not entitled, and the authority suspends its signer on the
 * dispatcher's report. Also the multi-device enrollment steps other features
 * share.
 */
import assert from "node:assert/strict";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import {
	checkClaim,
	claimOf,
	create,
	enrollDevice,
	MemberState,
	memberCaller,
	offerOf,
	parseFleetId,
	parseWorkDigest,
	Role,
	type SignedEnvelope,
	signOffer,
	ViolationReportSchema,
	type WorkOffer,
	WorkOrigin,
} from "../../../packages/fleet-authority/acceptance/index.js";
import { fleet, world } from "./state.js";

const STEP_MS = 20_000;
const offers = new Map<string, WorkOffer>();
let claim: SignedEnvelope | undefined;

Before({ tags: "@fleet" }, () => {
	offers.clear();
	claim = undefined;
});

export function named(name: string) {
	const found = fleet.devices.get(name);
	if (found === undefined) throw new Error(`no device named ${name} in this scenario`);
	return found;
}

export function offerNamed(key: string): WorkOffer {
	const found = offers.get(key);
	if (found === undefined) throw new Error(`no offer ${key} in this scenario`);
	return found;
}

async function enrolledAs(name: string, id: string, roles: readonly Role[]) {
	const w = world();
	const token = await w.token(id, name, roles);
	const enrolled = await enrollDevice(w, { fleet: id, name, roles, proof: async () => ({ case: "bootstrapToken", value: token }) });
	assert.ok(enrolled.response.ok, enrolled.response.ok ? "" : enrolled.response.error.message);
	fleet.devices.set(name, enrolled);
	await w.runtime.tickOnce();
}

Given("the device {string} enrolled in {string} as a dispatcher", async (name: string, id: string) => {
	await enrolledAs(name, id, [Role.DISPATCHER]);
});

Given("the device {string} enrolled in {string} as an executor", async (name: string, id: string) => {
	await enrolledAs(name, id, [Role.EXECUTOR]);
});

Given("{string} offers the job {string} in {string}", async (dispatcher: string, key: string, id: string) => {
	const keys = await named(dispatcher).keys.open();
	offers.set(key, offerOf(keys, id, world().now(), { workKey: key }));
});

When("{string} offers fork work {string} in {string}", async (dispatcher: string, key: string, id: string) => {
	const keys = await named(dispatcher).keys.open();
	offers.set(key, offerOf(keys, id, world().now(), { workKey: key, origin: WorkOrigin.FORK, author: "github:999" }));
	fleet.notes.set("offer", key);
});

When("{string} signs a claim on {string} that names {string}", async (signer: string, key: string, victim: string) => {
	const forger = await named(signer).keys.open();
	const named_ = await named(victim).keys.open();
	claim = await claimOf(named_, offerNamed(key), forger.sign);
	fleet.notes.set("offer", key);
});

When("{string} signs a claim on {string} in its own name", async (signer: string, key: string) => {
	claim = await claimOf(await named(signer).keys.open(), offerNamed(key));
	fleet.notes.set("offer", key);
});

async function verdict() {
	const w = world();
	const offer = offerNamed(fleet.notes.get("offer") ?? "");
	assert.ok(claim !== undefined);
	return checkClaim(claim, { fleet: parseFleetId(offer.fleet), digest: parseWorkDigest(offer.workDigest) }, offer, {
		registry: w.bus.registry,
		ranked: [],
		nowMs: w.now(),
		stepMs: STEP_MS,
	});
}

Then("the dispatcher's claim rules discard it", async () => {
	assert.equal(await verdict(), "discard");
});

Then("the dispatcher's claim rules find it not-entitled", async () => {
	assert.equal(await verdict(), "not-entitled");
});

async function report() {
	const w = world();
	const hub = await named("hub").keys.open();
	const offer = offerNamed(fleet.notes.get("offer") ?? "");
	assert.ok(claim !== undefined);
	return w.authority.report(
		create(ViolationReportSchema, { kind: "claim-not-entitled", offer: await signOffer(hub, offer), claims: [claim] }),
		memberCaller(hub.memberId, hub.signPublicKey, w.now()),
	);
}

Then("a report of it is refused as evidence-invalid", async () => {
	const answered = await report();
	assert.equal(answered.ok ? "ok" : answered.error.code, "evidence-invalid");
});

When("{string} reports the claim to the authority", async (_reporter: string) => {
	const answered = await report();
	assert.ok(answered.ok, answered.ok ? "" : `${answered.error.code}: ${answered.error.message}`);
	await world().runtime.tickOnce();
});

async function stateOf(name: string) {
	const w = world();
	const self = await named(name).keys.open();
	await w.runtime.tickOnce();
	return w.bus.registry.member(self.memberId);
}

Then("{string} is ACTIVE in the registry", async (name: string) => {
	assert.equal(MemberState[(await stateOf(name))?.state ?? 0], "ACTIVE");
});

Then("{string} is SUSPENDED for claim-not-entitled", async (name: string) => {
	const record = await stateOf(name);
	assert.equal(MemberState[record?.state ?? 0], "SUSPENDED");
	assert.equal(record?.stateReason, "violation:claim-not-entitled");
});
