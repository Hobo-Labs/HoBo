import { fromJsonString } from "@bufbuild/protobuf";
import { SnapshotSchema } from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { expect, it } from "vitest";
import { relayInstallAssets } from "../src/assets.js";
import { createHostedControlPlane } from "../src/hosted-control.js";
import { HostedRelay } from "../src/hosted-relay.js";
import { config, job, NOW, SECRET } from "./fixtures.js";

it("keeps the account snapshot to lease events, whatever the account's jobs journal", async () => {
	const store = new SqliteCiStore(":memory:");
	try {
		const configuration = config();
		const { revision } = await store.configure(configuration, 0, NOW);
		const [account] = configuration.accounts;
		if (!account) throw new Error("fixture account");
		const github = {
			appRequest: async () => new Response(null, { status: 500 }),
			request: async () => new Response(null, { status: 500 }),
		};
		const control = createHostedControlPlane({
			relay: new HostedRelay({
				config: configuration,
				store,
				github,
				identity: {
					verify: async () => {
						throw new Error("unexpected runner identity request");
					},
				},
				webhookSecret: SECRET,
				now: () => NOW,
			}),
			store,
			github,
			authenticate: () => ({
				accountId: "account-a",
				installationIds: [10],
				scopes: ["policy:read"],
			}),
			publicOrigin: "https://ci.example.test",
			assets: relayInstallAssets(),
		});
		const snapshot = async () => {
			const response = await control(
				new Request("https://ci.example.test/v1/accounts/self/leases", {
					headers: { authorization: "Bearer snapshot-reader" },
				}),
			);
			expect(response?.status).toBe(200);
			return fromJsonString(SnapshotSchema, (await response?.text()) ?? "");
		};

		const lease = await store.reserve(account, job(1), NOW, revision);
		if (!lease) throw new Error("reservation");
		// A busy account: far more job events than the snapshot's window holds.
		for (let id = 2; id < 152; id++) await store.queue(job(id), NOW, revision);
		const completed = job(2);
		completed.action = "completed";
		await store.observe(completed, NOW, revision);
		// The journal records them for the account...
		const journalled = (await store.events()).filter(
			(event) => event.accountId === "account-a",
		);
		expect(
			journalled.filter((event) => event.type === "ci.JobQueued").length,
		).toBe(150);

		// ...and the snapshot is what it was before they named an account: the
		// lease's events, not pushed out of the window by its jobs.
		const first = await snapshot();
		expect(first.leases.map((entry) => entry.id)).toEqual([lease.id]);
		expect(first.events.map((event) => [event.type, event.leaseId])).toEqual([
			["ci.LeaseReserved", lease.id],
		]);

		// The window is still the newest hundred of those events.
		for (let step = 0; step < 120; step++)
			await store.transition(
				lease.id,
				["reserved"],
				() => undefined,
				"ci.DispatchRequested",
				NOW,
				revision,
			);
		const later = await snapshot();
		expect(later.events.length).toBe(100);
		expect(new Set(later.events.map((event) => event.type))).toEqual(
			new Set(["ci.DispatchRequested"]),
		);
	} finally {
		store.close();
	}
});
