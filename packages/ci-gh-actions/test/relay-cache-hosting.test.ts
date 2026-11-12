import { describe, expect, it } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { isConfigWriteRoute } from "../src/hosted-control.js";
import {
	githubRelayDiscovery,
	type RelayLeaseChange,
	rebuildInflight,
	relayLeaseId,
} from "../src/relay-cache/index.js";
import {
	configuration,
	job,
	LATER,
	NOW,
	openRelayCache,
} from "./relay-cache-fixtures.js";

// What phase 4b asks of the cache store beyond phase 4a: a hook per lease
// write (the hosted relay's step scheduler), a change ring that keeps only
// what MCP follows, compare-and-set from the record a write just made, and a
// rebuild pass over what GitHub has in flight.

const account = () => {
	const found = configuration().accounts[0];
	if (!found) throw new Error("fixture account");
	return found;
};
const move = (to: string) => (lease: { state: string }) => {
	lease.state = to;
};

describe("the relay cache store as the hosted relay uses it", () => {
	it("tells the host about every lease write, with the state it left", async () => {
		const changes: RelayLeaseChange[] = [];
		const harness = openRelayCache(configuration(), {
			onLeaseChange: (change) => {
				changes.push(change);
			},
		});
		const lease = await harness.store.reserve(account(), job(1), NOW, 1);
		if (!lease) throw new Error("reservation");
		await harness.store.transition(
			lease.id,
			["reserved"],
			move("dispatching"),
			"ci.DispatchRequested",
			NOW,
		);
		await harness.store.transition(
			lease.id,
			["dispatching"],
			(entry) => {
				entry.hostRunId = 77;
			},
			"ci.HostRunFound",
			NOW,
		);
		expect(
			changes.map(({ lease: changed, type, previousState }) => [
				type,
				previousState,
				changed.state,
			]),
		).toEqual([
			["ci.LeaseReserved", undefined, "reserved"],
			["ci.DispatchRequested", "reserved", "dispatching"],
			["ci.HostRunFound", "dispatching", "dispatching"],
		]);
		// The ring keeps the state changes, not the write that left it alone.
		const feed = await harness.store.eventsSince({
			accountId: "hobo-labs",
			limit: 50,
		});
		expect(feed.events.map((entry) => entry.event?.type)).toEqual([
			"ci.LeaseReserved",
			"ci.DispatchRequested",
		]);
	});

	it("a failing hook never undoes the write it follows", async () => {
		const diagnostics: string[] = [];
		const harness = openRelayCache(configuration(), {
			onLeaseChange: () => {
				throw new Error("queue down");
			},
			onDiagnostic: (event) => diagnostics.push(event),
		});
		const lease = await harness.store.reserve(account(), job(1), NOW, 1);
		expect(lease?.state).toBe("reserved");
		expect(diagnostics).toContain("hobo_ci_relay_lease_hook_failed");
	});

	it("writes from the record it just wrote, and redoes the write on a fresh read when another instance wrote in between", async () => {
		const harness = openRelayCache();
		// Load every script once, so the count below is the steady state.
		const warm = await harness.store.reserve(account(), job(99), NOW, 1);
		if (!warm) throw new Error("reservation");
		await harness.store.transition(
			warm.id,
			["reserved"],
			move("dispatching"),
			"ci.DispatchRequested",
			NOW,
		);
		const lease = await harness.store.reserve(account(), job(1), NOW, 1);
		if (!lease) throw new Error("reservation");
		const before = harness.meter.usage().total;
		await harness.store.transition(
			lease.id,
			["reserved"],
			move("dispatching"),
			"ci.DispatchRequested",
			NOW,
		);
		// The routing check's index read, the write and a ring append (two):
		// the lease itself is not read again.
		expect(harness.meter.usage().total - before).toBe(4);
		// Another relay instance moves the lease on.
		const peer = harness.peer();
		await peer.transition(
			lease.id,
			["dispatching"],
			move("dispatched"),
			"ci.Dispatched",
			NOW,
		);
		// This instance's remembered record is stale: its compare-and-set
		// fails, and the transition is decided on what the peer wrote.
		const stale = await harness.store.transition(
			lease.id,
			["dispatching"],
			move("cancelled"),
			"ci.LeaseCancelled",
			LATER,
		);
		expect(stale).toBeUndefined();
		expect((await harness.store.get(lease.id))?.state).toBe("dispatched");
		const claimed = await harness.store.transition(
			lease.id,
			["dispatched"],
			move("claiming"),
			"ci.RunnerClaimed",
			LATER,
		);
		expect(claimed?.state).toBe("claiming");
	});
});

describe("the rebuild pass", () => {
	const lease = relayLeaseId({ repositoryId: 101, jobId: 5, runAttempt: 1 });
	const github = (inProgress: boolean): GithubTransport => ({
		async request(_installation, path) {
			if (path.includes("/actions/runs?status=in_progress"))
				return Response.json({
					workflow_runs: inProgress ? [{ id: 900 }] : [],
				});
			if (path.includes("/actions/runs?status=queued"))
				return Response.json({ workflow_runs: [] });
			if (path.includes("/actions/runs/900/jobs"))
				return Response.json({
					jobs: [
						{
							id: 5,
							run_id: 900,
							run_attempt: 1,
							status: "in_progress",
							labels: ["hobo"],
							runner_name: `hobo-${lease}`,
						},
						// Another runner's job is not the relay's to rebuild.
						{
							id: 6,
							run_id: 900,
							run_attempt: 1,
							status: "in_progress",
							labels: ["ubuntu-latest"],
							runner_name: "GitHub Actions 12",
						},
					],
				});
			if (path.endsWith("/actions/jobs/5"))
				return Response.json({
					id: 5,
					run_id: 900,
					run_attempt: 1,
					status: "in_progress",
					labels: ["hobo"],
					runner_name: `hobo-${lease}`,
					created_at: NOW,
				});
			if (path.includes("/actions/runners?"))
				return Response.json({ runners: [] });
			return new Response(null, { status: 404 });
		},
	});
	const discovery = (transport: GithubTransport) =>
		githubRelayDiscovery(transport, {
			bridgeWorkflow: () => undefined,
			sandbox: async (name) =>
				name === `hobo-${lease}` ? { sessionId: "sbx_found" } : undefined,
		});

	it("costs one read when no account lost its holds", async () => {
		const harness = openRelayCache();
		await harness.store.markHoldsKnown("hobo-labs", NOW);
		// Load the read script once, so the count below is the steady state.
		await harness.store.accountsAwaitingRebuild();
		const transport = github(true);
		const before = harness.meter.usage().total;
		const result = await rebuildInflight(
			harness.store,
			discovery(transport),
			transport,
			NOW,
		);
		expect(result).toEqual({ accounts: [], marked: [], outcomes: {} });
		expect(harness.meter.usage().total - before).toBe(1);
	});

	it("rebuilds what GitHub has in flight and marks the account's holds known", async () => {
		const harness = openRelayCache();
		expect(await harness.store.accountsAwaitingRebuild()).toEqual([
			"hobo-labs",
		]);
		const transport = github(true);
		const result = await rebuildInflight(
			harness.store,
			discovery(transport),
			transport,
			NOW,
		);
		expect(result).toEqual({
			accounts: ["hobo-labs"],
			marked: ["hobo-labs"],
			outcomes: { rebuilt: 1 },
		});
		const rebuilt = await harness.store.get(lease);
		expect(rebuilt).toMatchObject({
			state: "uncertain",
			sandboxName: `hobo-${lease}`,
			sandboxSessionId: "sbx_found",
			actualJobId: 5,
		});
		expect(await harness.store.accountsAwaitingRebuild()).toEqual([]);
	});

	it("leaves the account paused when GitHub did not answer", async () => {
		const harness = openRelayCache();
		const transport: GithubTransport = {
			request: async () => new Response(null, { status: 502 }),
		};
		const result = await rebuildInflight(
			harness.store,
			discovery(transport),
			transport,
			NOW,
		);
		expect(result.marked).toEqual([]);
		expect(await harness.store.accountsAwaitingRebuild()).toEqual([
			"hobo-labs",
		]);
	});
});

describe("configuration writes on a relay that reads its config service", () => {
	it("names each write route, and leaves the reads alone", () => {
		for (const [method, path] of [
			["PUT", "/v1/accounts/self/policy"],
			["PUT", "/v2/accounts/self/policy"],
			["PUT", "/v2/accounts/self/providers"],
			["POST", "/v2/accounts/self/signals"],
			["POST", "/v2/accounts/self/observations"],
			["POST", "/v2/accounts/self/rate-observations"],
			["GET", "/v2/accounts/self/inbox/quarantined"],
			["POST", "/v2/accounts/self/inbox/d-1/retry"],
			["POST", "/v1/accounts/self/repositories/prepare"],
			["POST", "/v1/accounts/self/repositories/isolated-connect"],
			["GET", `/v1/accounts/self/repositories/${"0".repeat(36)}`],
		] as const)
			expect(isConfigWriteRoute(method, path), `${method} ${path}`).toBe(true);
		for (const [method, path] of [
			["GET", "/v1/accounts/self/policy"],
			["GET", "/v2/accounts/self/signals"],
			["GET", "/v1/accounts/self/leases"],
			["POST", `/v1/accounts/self/leases/${"0".repeat(36)}/reconcile`],
			["GET", "/v2/accounts/self/runtime"],
		] as const)
			expect(isConfigWriteRoute(method, path), `${method} ${path}`).toBe(false);
	});
});
