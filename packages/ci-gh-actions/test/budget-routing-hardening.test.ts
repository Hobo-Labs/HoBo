import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create, type JsonObject } from "@bufbuild/protobuf";
import {
	BudgetLedgerSnapshotSchema,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "@hobo/broker";
import {
	ACTIVE_STATES,
	type CiSharedBudgetHooks,
	ConfigurationSchema,
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiSharedBudgetHooks,
	OfferSchema,
} from "@hobo/ci";
import { afterEach, describe, expect, it } from "vitest";
import { HostedRelay, type HostedRelayStore } from "../src/hosted-relay.js";
import { commonBudget } from "./fixtures/common-budget.js";
import { harness, job, NOW, queued, SECRET, signed } from "./fixtures.js";

const fixtures: ReturnType<typeof harness>[] = [];
const financialCleanup: (() => void)[] = [];
afterEach(() => {
	for (const h of fixtures.splice(0)) {
		h.store.close();
		expect(h.api.violations).toEqual([]);
	}
	for (const close of financialCleanup.splice(0).reverse()) close();
});

function setup(
	hosted: boolean,
	strategy = "min-cost",
	common?: { budgetPolicy: JsonObject; hooks: CiSharedBudgetHooks },
) {
	const h = harness(undefined, common?.hooks);
	fixtures.push(h);
	const account = h.configuration.accounts[0];
	if (!account?.offers[0]) throw new Error("missing fixture account");
	account.routingStrategy = strategy;
	account.offers[0].freeMinutes = 0;
	account.offers[0].priceMicrosPerMinute = 1;
	if (common) {
		account.budgetPolicy = common.budgetPolicy;
		const other = clone(OfferSchema, account.offers[0]);
		other.id = "other-provider";
		other.providerAccountId = "other-account";
		other.priceMicrosPerMinute = 100;
		account.offers.push(other);
	}
	const connection = h.configuration.connections[0];
	if (!connection) throw new Error("missing fixture connection");
	connection.allowedRefs = ["refs/heads/main", "refs/heads/locked"];
	h.store.configure(h.configuration, 0, NOW);
	const revision = (expected?: number) => {
		if (
			expected !== undefined &&
			expected !== h.store.configuration()?.revision
		)
			throw new Error("configuration revision conflict");
	};
	const store: HostedRelayStore = {
		configuration: async () => h.store.configuration(),
		policySnapshot: async () => ({
			state: h.store.configuration(),
			policies: [],
		}),
		get: async (id) => h.store.get(id),
		all: async () => h.store.all(),
		activeLeases: async () =>
			h.store.all().filter((lease) => ACTIVE_STATES.has(lease.state)),
		accountLeases: async (id) =>
			h.store.all().filter((lease) => lease.accountId === id),
		pendingJobs: async () => h.store.pendingJobs(),
		observe: async (value, at, expected) => {
			revision(expected);
			h.store.observe(value, at);
		},
		queue: async (value, at, expected) => {
			revision(expected);
			h.store.queue(value, at);
		},
		expireQueued: async (value, at, expected) => {
			revision(expected);
			return h.store.expireQueued(value, at);
		},
		reserve: async (current, value, at, expected) => {
			revision(expected);
			return h.store.reserve(current, value, at);
		},
		transition: async (id, expected, update, event, at, expectedRevision) => {
			revision(expectedRevision);
			return h.store.transition(id, expected, update, event, at);
		},
		cancelAndRequeue: async (id, value, at) =>
			h.store.cancelAndRequeue(id, value, at),
		settleObserved: async () => {
			throw new Error("unexpected financial settlement");
		},
	};
	const relay = hosted
		? new HostedRelay({
				config: h.configuration,
				store,
				github: h.api,
				identity: h.relay.options.identity,
				webhookSecret: SECRET,
				now: () => h.clock.now,
			})
		: h.relay;
	function reserve(deadline = "") {
		const demand = job();
		demand.queueDeadlineAt = deadline;
		const lease = h.store.reserve(account, demand, NOW);
		if (!lease) throw new Error("fixture reservation refused");
		h.api.leaseId = lease.id;
		h.api.host.display_title = `HoBo lease ${lease.id}`;
		return lease;
	}
	function addCostlierFreeHost() {
		const config = clone(ConfigurationSchema, h.configuration);
		const current = config.accounts[0];
		const paid = current?.offers[0];
		if (!current || !paid) throw new Error("missing fixture offer");
		const free = clone(OfferSchema, paid);
		free.id = "costlier-free";
		free.providerAccountId = "separate-provider-account";
		free.freeMinutes = 1;
		free.priceMicrosPerMinute = 1000;
		current.offers.push(free);
		h.store.configure(config, 1, NOW);
	}
	return { ...h, relay, reserve, addCostlierFreeHost };
}

function sharedSetup(hosted: boolean) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-relay-shared-policy-"));
	financialCleanup.push(() =>
		rmSync(directory, { recursive: true, force: true }),
	);
	const policy = {
		...commonBudget(),
		enforcement: "strict",
		constraints: [
			{ key: "ci.attempts", workload: "ci", unit: "count", maximum: 1 },
			{ key: "ci.queue.duration", workload: "ci", unit: "ms", maximum: 60000 },
			{
				key: "provider.cost",
				workload: "ci",
				unit: "USD.micros",
				target: "other-account",
				maximum: 0,
			},
		],
	};
	const parent = createSqliteBudgetAdmissionAuthority({
		path: join(directory, "parent.sqlite"),
		now: () => NOW,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: policy.tenantId,
				budgetId: policy.budgetId,
				periodId: policy.periodId,
				policyRevision: policy.revision,
			},
			limitMicros: policy.limitMicros,
			observedAt: NOW,
			validUntil: "2026-10-27T00:00:00Z",
			providerAccounts: [
				{
					providerAccountId: "owned-blacksmith-account",
					limitMicros: policy.limitMicros,
				},
				{ providerAccountId: "other-account", limitMicros: policy.limitMicros },
			],
		}),
	});
	financialCleanup.push(() => parent.close());
	const proof = { valid: true };
	const hooks = createCiSharedBudgetHooks({
		authority: parent,
		now: () => NOW,
		verifyProviderLiabilityBound: () => proof.valid,
		quoteLease: (lease) =>
			create(HostingQuoteSchema, {
				quoteId: `quote:${ciReservationId(lease)}`,
				yardId: `ci:${lease.accountId}`,
				providerId: lease.provider,
				ownerTenantId: lease.budgetTenantId,
				currency: "USD",
				totalMicros: lease.reservedPaidMicros,
				liabilityBoundMicros: lease.reservedPaidMicros,
				observedAt: NOW,
				validUntil: "2026-10-27T00:00:00Z",
				components: [
					{
						name: "complete-native-liability",
						costMicros: lease.reservedPaidMicros,
					},
				],
				requestDigest: ciRequestDigest(lease),
				financialPlanHash: ciFinancialPlanHash(lease),
				providerAccounts: [
					{
						providerAccountId: lease.providerAccountId,
						liabilityMicros: lease.reservedPaidMicros,
					},
				],
			}),
	});
	return {
		...setup(hosted, "min-cost", { budgetPolicy: policy, hooks }),
		parent,
		proof,
	};
}

it("retains accounting context while limiting hosted repricing to the reserved host family", async () => {
	const h = sharedSetup(true);
	const lease = h.reserve();
	const config = clone(ConfigurationSchema, h.configuration);
	const account = config.accounts[0];
	const current = account?.offers[0];
	if (!account || !current) throw new Error("missing fixture offer");
	const isolated = clone(OfferSchema, current);
	isolated.id = "isolated-cheaper";
	isolated.provider = "hobo-box-worker";
	isolated.backend = "isolated-container";
	isolated.providerAccountId = "isolated-account";
	isolated.runsOn = "hobo-isolated-worker";
	isolated.priceMicrosPerMinute = 0;
	isolated.budgetMicros = 0;
	account.offers.push(isolated);
	h.store.configure(config, 1, NOW);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(1);
	expect(h.store.get(lease.id)?.state).toBe("dispatched");
});

// Both arms run the one relay core. They differ in the store it writes through:
// the SQLite store of the Node host (`hosted=false`), or an adapter over the
// lease journal alone (`hosted=true`).
describe.each([false, true])("CI budget lifecycle (hosted=%s)", (hosted) => {
	it("dispatches a strict common policy with attempt, queue and other-provider guards after the real parent claim", async () => {
		const h = sharedSetup(hosted);
		const lease = h.reserve();
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(1);
		expect(h.store.get(lease.id)?.state).toBe("dispatched");
		expect(h.parent.lookup(ciReservationId(lease))).toMatchObject({
			status: "held",
			reservedMicros: 10,
		});
		expect(h.parent.lookup(ciReservationId(lease))?.executionDigest).not.toBe(
			"",
		);
	});
	it("does not mistake strict planning feasibility for native proof when the provider bound is revoked", async () => {
		const h = sharedSetup(hosted);
		const lease = h.reserve();
		h.proof.valid = false;
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(0);
		expect(h.parent.lookup(ciReservationId(lease))).toMatchObject({
			status: "held",
			reservedMicros: 10,
			executionDigest: "",
		});
	});
	it("attributes a different shared-label job without treating demand attempt limits as execution isolation", async () => {
		const h = setup(hosted);
		const lease = h.reserve();
		await h.relay.dispatchPending();
		const request = h.api.request.bind(h.api);
		h.api.request = async (...args) => {
			if (args[1] === "/repos/org/repo/actions/runs/33")
				return Response.json({
					...h.api.original,
					id: 33,
					run_attempt: 2,
					event: "pull_request",
					head_repository: { id: 999 },
				});
			if (args[1] === "/repos/org/repo/actions/jobs/99")
				return Response.json({
					id: 99,
					run_id: 33,
					run_attempt: 2,
					status: "completed",
					labels: ["hobo"],
					runner_name: lease.runnerName,
				});
			return request(...args);
		};
		const assignment = queued(99);
		assignment.action = "completed";
		assignment.workflow_job.run_id = 33;
		assignment.workflow_job.run_attempt = 2;
		assignment.workflow_job.runner_name = lease.runnerName;
		const delivery = signed(assignment);
		await h.relay.webhook(delivery.body, delivery.signature, "workflow_job");
		expect(h.store.get(lease.id)).toMatchObject({
			jobId: 1,
			originalRunId: 11,
			runAttempt: 1,
			actualJobId: 99,
			state: "dispatched",
			reservedPaidMicros: 10,
		});
	});
	it("keeps a cheaper paid reservation when a more expensive partial-free host appears", async () => {
		const h = setup(hosted);
		const lease = h.reserve();
		h.addCostlierFreeHost();
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(1);
		expect(h.store.get(lease.id)?.state).toBe("dispatched");
	});

	it("uses credit-first relocation only when the objective explicitly requests it", async () => {
		const h = setup(hosted, "maximize-credits");
		const lease = h.reserve();
		h.addCostlierFreeHost();
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(0);
		expect(h.store.get(lease.id)?.state).toBe("cancelled");
		expect(h.store.pendingJobs()).toHaveLength(1);
	});

	it("expires durable queued demand without launching a host", async () => {
		const h = setup(hosted);
		const demand = job();
		demand.queueDeadlineAt = new Date(Date.parse(NOW) - 1).toISOString();
		h.store.queue(demand, NOW);
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(0);
		expect(h.store.pendingJobs()).toHaveLength(0);
		expect(h.store.all()).toHaveLength(0);
		expect(
			h.store.events().some((event) => event.type === "ci.JobExpired"),
		).toBe(true);
	});

	it("rechecks queue expiry after provider reads complete", async () => {
		const h = setup(hosted);
		const lease = h.reserve(new Date(Date.parse(NOW) + 1000).toISOString());
		const request = h.api.request.bind(h.api);
		h.api.request = async (...args) => {
			const response = await request(...args);
			h.clock.now = new Date(Date.parse(NOW) + 2000).toISOString();
			return response;
		};
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(0);
		expect(h.store.get(lease.id)?.state).toBe("cancelled");
	});

	it("retains an already-dispatched liability when its original queue deadline passes", async () => {
		const h = setup(hosted);
		const lease = h.reserve(new Date(Date.parse(NOW) + 1000).toISOString());
		await h.relay.dispatchPending();
		h.clock.now = new Date(Date.parse(NOW) + 2000).toISOString();
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(1);
		expect(h.store.get(lease.id)).toMatchObject({
			state: "dispatched",
			reservedPaidMicros: 10,
		});
	});

	it("does not dispatch if financial claim or durable intent crosses the queue deadline", async () => {
		const h = setup(hosted);
		const lease = h.reserve(new Date(Date.parse(NOW) + 1000).toISOString());
		const crossDeadline = (event: string) => {
			if (event === "ci.DispatchRequested")
				h.clock.now = new Date(Date.parse(NOW) + 2000).toISOString();
		};
		// The intent is written through whichever store this relay holds.
		const transition = h.store.transition.bind(h.store);
		h.store.transition = (...args) => {
			const result = transition(...args);
			crossDeadline(args[3]);
			return result;
		};
		const ledgerTransition = h.ledger.transition.bind(h.ledger);
		h.ledger.transition = async (...args) => {
			const result = await ledgerTransition(...args);
			crossDeadline(args[3]);
			return result;
		};
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(0);
		expect(h.store.get(lease.id)).toMatchObject({
			state: "uncertain",
			reservedPaidMicros: 10,
		});
	});

	it("does not launch an old reservation after its workflow is rerun", async () => {
		const h = setup(hosted);
		const lease = h.reserve();
		h.api.original.run_attempt = 2;
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(0);
		expect(h.store.get(lease.id)?.state).toBe("cancelled");
	});

	it("rejects a provider readback naming a different workflow run", async () => {
		const h = setup(hosted);
		const lease = h.reserve();
		h.api.original.id = 999;
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(0);
		expect(h.store.get(lease.id)?.state).toBe("cancelled");
	});

	it("rechecks current branch trust after an awaited provider read", async () => {
		const h = setup(hosted);
		const lease = h.reserve();
		const request = h.api.request.bind(h.api);
		let narrowed = false;
		h.api.request = async (...args) => {
			const response = await request(...args);
			if (!narrowed) {
				narrowed = true;
				const state = h.store.configuration();
				if (!state?.configuration?.connections[0])
					throw new Error("missing connection");
				state.configuration.connections[0].allowedRefs = ["refs/heads/locked"];
				h.store.configure(state.configuration, state.revision, NOW);
			}
			return response;
		};
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(0);
		expect(h.store.get(lease.id)?.state).toBe("cancelled");
	});
});
