import type { WitnessedEnvelope } from "@hobo/fleet";
import { createTestAuthority } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";

import {
	acceptFederatedTrust,
	deriveConnectivityPlan,
	deriveFederationPlan,
	junction,
	planForYard,
} from "../src/index.js";
import { makeYard } from "./helpers.js";

async function trustOf(): Promise<WitnessedEnvelope> {
	const authority = await createTestAuthority(() => Date.now());
	return authority.trust;
}

describe("deriveFederationPlan()", () => {
	const definition = junction("fed", {
		yards: [makeYard("a", "aws"), makeYard("b", "azure"), makeYard("c", "gcp")],
	});

	it("exchanges each member Yard's fleet trust record with every other member", async () => {
		const trust = { a: await trustOf(), b: await trustOf() };
		const plan = deriveFederationPlan(definition, trust);

		expect(plan.trustExchanges).toHaveLength(6);
		expect(plan.trustExchanges).toContainEqual({
			kind: "trust-anchor-exchange",
			fromYard: "a",
			toYard: "b",
			trust: trust.a,
		});
		expect(
			plan.trustExchanges.every((entry) => entry.fromYard !== entry.toYard),
		).toBe(true);
		expect(
			plan.trustExchanges
				.filter((entry) => entry.fromYard === "b")
				.every((entry) => entry.trust === trust.b),
		).toBe(true);
	});

	it("leaves a Yard's exchanges without trust until it publishes a trust record", () => {
		const plan = deriveFederationPlan(definition);

		expect(plan.trustExchanges).toHaveLength(6);
		expect(plan.trustExchanges.every((entry) => entry.trust === null)).toBe(
			true,
		);
		expect(plan.trustExchanges[0]).not.toHaveProperty("anchorRef");
	});

	it("distributes one signed policy pack per member", () => {
		const plan = deriveFederationPlan(definition);

		expect(plan.policyPacks).toEqual(
			["a", "b", "c"].map((toYard) => ({
				kind: "policy-pack-distribution",
				toYard,
				packRef: "policy-pack://fed/default",
				signed: true,
			})),
		);
	});

	it("distributes signed registry bundles between every ordered member pair", () => {
		const plan = deriveFederationPlan(definition);

		expect(plan.registryBundles).toHaveLength(6);
		expect(
			plan.registryBundles.every(
				(entry) => entry.signed === true && entry.fromYard !== entry.toYard,
			),
		).toBe(true);
		expect(plan.registryBundles).toContainEqual({
			kind: "registry-bundle-distribution",
			fromYard: "c",
			toYard: "a",
			bundleRef: "registry-bundle://c/fed",
			signed: true,
		});
	});

	it("carries the trust records through the connectivity plan and each Yard's half", async () => {
		const trust = { a: await trustOf() };
		const plan = deriveConnectivityPlan(definition, { trust });
		const half = planForYard(plan, "b");
		const fromA = half.trustExchanges.find((entry) => entry.fromYard === "a");

		expect(fromA?.trust).toBe(trust.a);
	});
});

describe("acceptFederatedTrust()", () => {
	const definition = junction("fed", {
		yards: [makeYard("a", "aws"), makeYard("b", "azure")],
	});

	it("pins a peer Yard's witnessed trust record on first sight", async () => {
		const plan = deriveFederationPlan(definition, { a: await trustOf() });
		const exchange = plan.trustExchanges.find(
			(entry) => entry.fromYard === "a",
		);
		if (exchange === undefined) throw new Error("no exchange from a");

		const accepted = acceptFederatedTrust(exchange, undefined);

		expect(accepted.ok).toBe(true);
		if (accepted.ok) {
			expect(accepted.value.tenant).toBe("test");
			expect(accepted.value.sequence).toBe(1);
		}
	});

	it("refuses an exchange whose Yard has not published a trust record", () => {
		const plan = deriveFederationPlan(definition);
		const exchange = plan.trustExchanges[0];
		if (exchange === undefined) throw new Error("no exchange");

		const refused = acceptFederatedTrust(exchange, undefined);

		expect(refused).toMatchObject({
			ok: false,
			error: { code: "invalid-request" },
		});
	});

	it("refuses a record that does not follow the pinned one (same sequence)", async () => {
		const first = await trustOf();
		const plan = deriveFederationPlan(definition, { a: first });
		const exchange = plan.trustExchanges.find(
			(entry) => entry.fromYard === "a",
		);
		if (exchange === undefined) throw new Error("no exchange from a");
		const pinned = acceptFederatedTrust(exchange, undefined);
		if (!pinned.ok) throw new Error("first sight refused");

		const again = acceptFederatedTrust(exchange, pinned.value);

		expect(again).toMatchObject({ ok: false, error: { code: "proof-invalid" } });
	});

	it("refuses a record signed by another authority than the pinned one", async () => {
		const pinnedPlan = deriveFederationPlan(definition, { a: await trustOf() });
		const pinnedExchange = pinnedPlan.trustExchanges.find(
			(entry) => entry.fromYard === "a",
		);
		if (pinnedExchange === undefined) throw new Error("no exchange from a");
		const pinned = acceptFederatedTrust(pinnedExchange, undefined);
		if (!pinned.ok) throw new Error("first sight refused");
		const forged = deriveFederationPlan(definition, { a: await trustOf() });
		const forgedExchange = forged.trustExchanges.find(
			(entry) => entry.fromYard === "a",
		);
		if (forgedExchange === undefined) throw new Error("no exchange from a");

		const refused = acceptFederatedTrust(forgedExchange, {
			...pinned.value,
			sequence: 0,
		});

		expect(refused.ok).toBe(false);
	});
});
