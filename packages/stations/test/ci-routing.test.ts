import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	type Account,
	AccountSchema,
	AccountStateSchema,
	ConfigurationSchema,
	route,
} from "@hobo/ci";
import { LeaseStore } from "@hobo/ci/store";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BudgetSignal,
	foldBudgetSignals,
} from "../../broker/src/budget-signals.js";
import {
	type CiBudgetRoutingClient,
	createCiBudgetRoutingBridge,
} from "../src/ci-routing.js";

const NOW = "2026-10-27T12:00:00Z";
const POLICY = {
	accountId: "account-a",
	tenantId: "tenant-a",
	normalOfferIds: ["github"],
	thresholds: [
		{ thresholdFraction: 0.8, offerIds: ["depot"] },
		{ thresholdFraction: 1, offerIds: ["k8"] },
	],
};
const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});
function originalAccount(): Account {
	return create(AccountSchema, {
		id: "account-a",
		budgetMicros: 1000000,
		spentMicros: 100,
		maxRuntimeMinutes: 1,
		startupMinutes: 1,
		offers: [
			["github", "github"],
			["depot", "depot"],
			["k8", "kubernetes"],
		].map(([id = "", provider = ""]) => ({
			id,
			provider,
			backend: provider === "kubernetes" ? "isolated-container" : "",
			providerAccountId: `${provider}-owned`,
			enabled: id === "github",
			runsOn:
				provider === "kubernetes" ? "hobo-isolated-worker" : `${id}-native`,
			freeMinutes: provider === "kubernetes" ? 0 : 20,
			priceMicrosPerMinute: provider === "kubernetes" ? 0 : 100,
			budgetMicros: provider === "kubernetes" ? 0 : 1000000,
			spentMicros: provider === "kubernetes" ? 0 : 20,
			concurrency: 2,
			observedAt: "2026-10-27T10:00:00Z",
			validUntil: "2026-10-28T12:00:00Z",
			sourceUrl: "https://provider.example/usage",
			bridgeAcknowledged: true,
		})),
	});
}
function storedClient(path = ":memory:") {
	const store = new LeaseStore(path);
	if (!store.configuration())
		store.configure(
			create(ConfigurationSchema, { accounts: [originalAccount()] }),
			0,
			NOW,
		);
	let reads = 0;
	let writes = 0;
	const client: CiBudgetRoutingClient = {
		async getPolicy() {
			reads++;
			const current = store.configuration();
			if (!current) throw new Error("missing test policy");
			return create(AccountStateSchema, {
				revision: current.revision,
				account: current.configuration?.accounts[0],
				updatedAt: current.updatedAt,
			});
		},
		async putPolicy(account, { revision }) {
			writes++;
			const saved = store.configure(
				create(ConfigurationSchema, { accounts: [account] }),
				revision,
				NOW,
			);
			return create(AccountStateSchema, {
				revision: saved.revision,
				account: saved.configuration?.accounts[0],
				updatedAt: saved.updatedAt,
			});
		},
	};
	return { store, client, counts: () => ({ reads, writes }) };
}
function brokerSignals() {
	return foldBudgetSignals(
		[
			{
				type: "meter.UsageRecorded",
				data: { tenantId: "tenant-a", costUsd: 80 },
			},
			{
				type: "meter.UsageRecorded",
				data: { tenantId: "tenant-a", costUsd: 20 },
			},
			{
				type: "budget.CreditApplied",
				data: { tenantId: "tenant-a", amountUsd: 200 },
			},
		],
		{ budgetUsd: 100, thresholds: [0.8, 1], tenantId: "tenant-a" },
	).signals;
}
function signalAt(index: number): BudgetSignal {
	const signal = brokerSignals()[index];
	if (!signal) throw new Error("missing Broker signal");
	return signal;
}
async function selected(client: CiBudgetRoutingClient) {
	const account = (await client.getPolicy()).account;
	if (!account) throw new Error("missing test policy");
	return route(account, [], NOW)?.offer.id;
}

describe("Station CI budget routing bridge", () => {
	it("routes actual Broker crossings to Depot then Kubernetes and recovers to GitHub", async () => {
		const { client, store } = storedClient();
		try {
			const bridge = createCiBudgetRoutingBridge({ policy: POLICY, client });
			expect(await selected(client)).toBe("github");
			expect(await bridge.accept(JSON.stringify(signalAt(0)))).toEqual({
				changed: true,
				revision: 2,
			});
			expect(await selected(client)).toBe("depot");
			await bridge.accept(JSON.stringify(signalAt(1)));
			expect(await selected(client)).toBe("k8");
			// A credit recovers both thresholds; until the highest recovers, keep its profile.
			await bridge.accept(JSON.stringify(signalAt(2)));
			expect(await selected(client)).toBe("k8");
			await bridge.accept(JSON.stringify(signalAt(3)));
			expect(await selected(client)).toBe("github");
			const account = (await client.getPolicy()).account;
			expect(account?.spentMicros).toBe(100);
			expect(account?.offers.map((offer) => offer.spentMicros)).toEqual([
				20, 20, 0,
			]);
		} finally {
			store.close();
		}
	});
	it("keeps the highest active threshold when lower-threshold delivery arrives late", async () => {
		const { client, store, counts } = storedClient();
		try {
			const bridge = createCiBudgetRoutingBridge({ policy: POLICY, client });
			await bridge.accept(JSON.stringify(signalAt(1)));
			await bridge.accept(JSON.stringify(signalAt(0)));
			expect(await selected(client)).toBe("k8");
			await bridge.accept(JSON.stringify(signalAt(3)));
			expect(await selected(client)).toBe("depot");
			expect(await bridge.accept(JSON.stringify(signalAt(1)))).toMatchObject({
				changed: false,
			});
			expect(counts().writes).toBe(3);
		} finally {
			store.close();
		}
	});
	it("persists ordering across database reopen and audit rebuild so replay cannot undo recovery", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ci-budget-bridge-"));
		paths.push(directory);
		const path = join(directory, "relay.sqlite");
		let fixture = storedClient(path);
		try {
			const bridge = createCiBudgetRoutingBridge({
				policy: POLICY,
				client: fixture.client,
			});
			await bridge.accept(JSON.stringify(signalAt(1)));
			await bridge.accept(JSON.stringify(signalAt(3)));
		} finally {
			fixture.store.close();
		}
		fixture = storedClient(path);
		try {
			fixture.store.rebuild();
			const bridge = createCiBudgetRoutingBridge({
				policy: POLICY,
				client: fixture.client,
			});
			expect(await bridge.accept(JSON.stringify(signalAt(1)))).toEqual({
				changed: false,
				revision: 3,
			});
			expect(await selected(fixture.client)).toBe("github");
			expect(fixture.counts().writes).toBe(0);
		} finally {
			fixture.store.close();
		}
	});
	it("reconciles changed rules from durable signals, allows explicit pause, and is idempotent", async () => {
		const { client, store, counts } = storedClient();
		try {
			await createCiBudgetRoutingBridge({ policy: POLICY, client }).accept(
				JSON.stringify(signalAt(1)),
			);
			const bridge = createCiBudgetRoutingBridge({
				policy: {
					...POLICY,
					thresholds: [{ thresholdFraction: 1, offerIds: [] }],
				},
				client,
			});
			expect(await bridge.reconcile()).toEqual({ changed: true, revision: 3 });
			expect(await selected(client)).toBeUndefined();
			expect(await bridge.reconcile()).toEqual({ changed: false, revision: 3 });
			expect(counts().writes).toBe(2);
			await bridge.accept(JSON.stringify(signalAt(3)));
			expect(await selected(client)).toBe("github");
		} finally {
			store.close();
		}
	});
	it("propagates CAS conflict without retrying or overwriting a concurrent policy change", async () => {
		const fixture = storedClient();
		try {
			const client: CiBudgetRoutingClient = {
				getPolicy: () => fixture.client.getPolicy(),
				async putPolicy(account, options) {
					const latest = await fixture.client.getPolicy();
					if (!latest.account) throw new Error("missing test policy");
					latest.account.budgetMicros += 100;
					await fixture.client.putPolicy(latest.account, {
						revision: latest.revision,
					});
					return fixture.client.putPolicy(account, options);
				},
			};
			await expect(
				createCiBudgetRoutingBridge({ policy: POLICY, client }).accept(
					JSON.stringify(signalAt(0)),
				),
			).rejects.toThrow(/revision conflict/);
			expect(await selected(fixture.client)).toBe("github");
			expect((await fixture.client.getPolicy()).account?.budgetMicros).toBe(
				1000100,
			);
			expect(fixture.counts().writes).toBe(2);
		} finally {
			fixture.store.close();
		}
	});
	it("does not mutate a cached client account and snapshots the caller's policy", async () => {
		const account = originalAccount();
		const before = toJsonString(AccountSchema, account);
		const mutablePolicy = structuredClone(POLICY);
		let saved: Account | undefined;
		const bridge = createCiBudgetRoutingBridge({
			policy: mutablePolicy,
			client: {
				async getPolicy() {
					return create(AccountStateSchema, { revision: 1, account });
				},
				async putPolicy(next) {
					saved = next;
					return create(AccountStateSchema, { revision: 2, account: next });
				},
			},
		});
		mutablePolicy.thresholds[0]?.offerIds.splice(0, 1, "k8");
		await bridge.accept(JSON.stringify(signalAt(0)));
		expect(
			saved?.offers.filter((offer) => offer.enabled).map((offer) => offer.id),
		).toEqual(["depot"]);
		expect(toJsonString(AccountSchema, account)).toBe(before);
	});
	it("retries an unconfirmed committed write by reading its persisted watermark without writing again", async () => {
		const fixture = storedClient();
		try {
			let loseAcknowledgment = true;
			const bridge = createCiBudgetRoutingBridge({
				policy: POLICY,
				client: {
					getPolicy: () => fixture.client.getPolicy(),
					async putPolicy(account, revision) {
						const saved = await fixture.client.putPolicy(account, revision);
						if (loseAcknowledgment) {
							loseAcknowledgment = false;
							throw new Error("transport disconnected after commit");
						}
						return saved;
					},
				},
			});
			await expect(bridge.accept(JSON.stringify(signalAt(0)))).rejects.toThrow(
				/disconnected/,
			);
			expect(await selected(fixture.client)).toBe("depot");
			expect(await bridge.accept(JSON.stringify(signalAt(0)))).toEqual({
				changed: false,
				revision: 2,
			});
			expect(fixture.counts().writes).toBe(1);
		} finally {
			fixture.store.close();
		}
	});
	it("rejects an unknown configured offer or wrong account without writing", async () => {
		const fixture = storedClient();
		try {
			const bridge = createCiBudgetRoutingBridge({
				policy: { ...POLICY, normalOfferIds: ["missing"] },
				client: fixture.client,
			});
			await expect(bridge.accept(JSON.stringify(signalAt(0)))).rejects.toThrow(
				/unknown offer/,
			);
			const wrong = createCiBudgetRoutingBridge({
				policy: { ...POLICY, accountId: "other-account" },
				client: fixture.client,
			});
			await expect(wrong.reconcile()).rejects.toThrow(/does not match/);
			expect(fixture.counts().writes).toBe(0);
		} finally {
			fixture.store.close();
		}
	});
	it("retains a valid unconfigured threshold fact for later policy reconciliation", async () => {
		const fixture = storedClient();
		try {
			const bridge = createCiBudgetRoutingBridge({
				policy: {
					...POLICY,
					thresholds: [{ thresholdFraction: 0.8, offerIds: ["depot"] }],
				},
				client: fixture.client,
			});
			await bridge.accept(JSON.stringify(signalAt(1)));
			expect(await selected(fixture.client)).toBe("github");
			await createCiBudgetRoutingBridge({
				policy: POLICY,
				client: fixture.client,
			}).reconcile();
			expect(await selected(fixture.client)).toBe("k8");
		} finally {
			fixture.store.close();
		}
	});
	it.each([
		["foreign tenant", { data: { ...signalAt(0).data, tenantId: "tenant-b" } }],
		["global tenant", { data: { ...signalAt(0).data, tenantId: null } }],
		["unknown signal", { type: "meter.UsageRecorded" }],
		["unknown outer field", { forged: true }],
		["unknown data field", { data: { ...signalAt(0).data, forged: true } }],
		["wrong identity", { data: { ...signalAt(0).data, signalKey: "forged" } }],
		["wrong amount", { data: { ...signalAt(0).data, thresholdUsd: 79 } }],
		["uncrossed amount", { data: { ...signalAt(0).data, netSpentUsd: 79 } }],
		[
			"nonfinite amount",
			{ data: { ...signalAt(0).data, budgetUsd: "Infinity" } },
		],
		["zero cycle", { data: { ...signalAt(0).data, cycle: 0 } }],
		[
			"fraction above one",
			{ data: { ...signalAt(0).data, thresholdFraction: 1.1 } },
		],
	])("rejects %s before any client request", async (_name, override) => {
		const fixture = storedClient();
		try {
			const bridge = createCiBudgetRoutingBridge({
				policy: POLICY,
				client: fixture.client,
			});
			await expect(
				bridge.accept(JSON.stringify({ ...signalAt(0), ...override })),
			).rejects.toThrow();
			expect(fixture.counts()).toEqual({ reads: 0, writes: 0 });
		} finally {
			fixture.store.close();
		}
	});
	it.each([
		{ ...POLICY, accountId: "" },
		{ ...POLICY, tenantId: "" },
		{ ...POLICY, normalOfferIds: ["github", "github"] },
		{ ...POLICY, thresholds: [] },
		{ ...POLICY, thresholds: [{ thresholdFraction: 0, offerIds: [] }] },
		{ ...POLICY, thresholds: [{ thresholdFraction: 1.1, offerIds: [] }] },
		{
			...POLICY,
			thresholds: [{ thresholdFraction: 1, offerIds: ["k8", "k8"] }],
		},
		{
			...POLICY,
			thresholds: [
				{ thresholdFraction: 0.8, offerIds: ["depot"] },
				{ thresholdFraction: 0.8, offerIds: ["depot"] },
			],
		},
	])("rejects malformed policy before connecting", (policy) => {
		expect(() =>
			createCiBudgetRoutingBridge({
				policy,
				client: {
					async getPolicy() {
						throw new Error("must not connect");
					},
					async putPolicy() {
						throw new Error("must not connect");
					},
				},
			}),
		).toThrow();
	});
});
