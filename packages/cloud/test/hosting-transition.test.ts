import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	createEffectSpec,
	createResilienceProfile,
	pureEffects,
} from "@hobo/contracts";
import type { ResourceMutationJournal } from "@hobo/core";
import { ResourceMutationJournalEntrySchema } from "@hobo/core";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	HostingTransitionAction as Action,
	type HostingDestinationLiability,
	HostingTransitionEventSchema,
	HostingTransitionPhase as Phase,
} from "../src/_generated/hosting_transition_pb.js";
import type { SharedHostingBudgetAuthority } from "../src/hosting-transition/budget-authority.js";
import { hostingTransitionContracts } from "../src/hosting-transition/contracts.js";
import {
	createHostingTransitionCoordinator,
	type HostingOperationRequest,
	type HostingTransitionProvider,
	hostingAdapterContractDigest,
} from "../src/hosting-transition/coordinator.js";
import {
	createHostingTransitionPlan,
	foldHostingTransition,
} from "../src/hosting-transition/model.js";
import {
	createHostingPlanningPass,
	type HostingPlanningInput,
} from "../src/planner/hosting-budget.js";

const stores = new Set<RuntimeLocalEventStore>();
const directories: string[] = [];
afterEach(() => {
	for (const store of stores) store.close();
	stores.clear();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** The coordinator tests use an actual SQLite-backed CAS journal, independently
 * of its own transition stream. No provider request/response is stored. */
function mutationJournal() {
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-mutation-resume-"));
	directories.push(dataDir);
	let store = createRuntimeLocalEventStore({ dataDir });
	stores.add(store);
	const stream = (id: string) => `mutation:${encodeURIComponent(id)}`;
	async function head(id: string) {
		const events = [];
		for await (const event of store.read(stream(id))) events.push(event);
		const event = events.at(-1);
		return {
			seq: event?.seq ?? 0,
			entry: event
				? fromJson(
						ResourceMutationJournalEntrySchema,
						JSON.parse(JSON.stringify(event.data)),
					)
				: undefined,
		};
	}
	async function append(
		id: string,
		digest: string,
		status: string,
		seq: number,
	) {
		await store.append(
			stream(id),
			[
				{
					type: "test.MutationJournaled",
					data: toJson(
						ResourceMutationJournalEntrySchema,
						create(ResourceMutationJournalEntrySchema, {
							mutationId: id,
							requestDigest: digest,
							status,
							recordedAtMs: 1000,
						}),
					),
				},
			],
			{
				expectedSeq: seq,
				tenant: "tenant",
				actor: { kind: "service", id: "journal" },
				fenceToken: 1n,
			},
		);
	}
	const journal: ResourceMutationJournal = {
		persistence: "durable-cas",
		async claim(input) {
			const current = await head(input.mutationId);
			if (current.entry) {
				if (current.entry.requestDigest !== input.requestDigest)
					throw new Error("mutation identity conflict");
				return {
					status:
						current.entry.status === "acknowledged"
							? "acknowledged"
							: "uncertain",
				};
			}
			try {
				await append(input.mutationId, input.requestDigest, "claimed", 0);
				return { status: "claimed" };
			} catch {
				const winner = await head(input.mutationId);
				if (!winner.entry || winner.entry.requestDigest !== input.requestDigest)
					throw new Error("mutation claim conflict");
				return {
					status:
						winner.entry.status === "acknowledged"
							? "acknowledged"
							: "uncertain",
				};
			}
		},
		async acknowledge(id, digest) {
			const current = await head(id);
			if (!current.entry || current.entry.requestDigest !== digest)
				throw new Error("unknown mutation");
			if (current.entry.status !== "acknowledged")
				await append(id, digest, "acknowledged", current.seq);
		},
		async uncertain(id, digest) {
			const current = await head(id);
			if (!current.entry || current.entry.requestDigest !== digest)
				throw new Error("unknown mutation");
			if (current.entry.status !== "acknowledged")
				await append(id, digest, "uncertain", current.seq);
		},
	};
	return {
		journal,
		reopen() {
			store.close();
			stores.delete(store);
			store = createRuntimeLocalEventStore({ dataDir });
			stores.add(store);
		},
	};
}

function setup(
	changes: {
		execute?: HostingTransitionProvider["execute"];
		observe?: HostingTransitionProvider["observe"];
		movementClass?: string;
		noRollbackWorkload?: boolean;
		authorize?: (
			request: Omit<HostingOperationRequest, "signal">,
		) => Promise<{ allowed: boolean; reason?: string }>;
		rollbackHoldUntilMs?: number;
		maximumObservationAttempts?: number;
		operationTimeoutMs?: number;
		failCommit?: (eventType: string) => boolean;
		intent?: string;
		maximumMutationResumes?: number;
		mutationJournal?: ResourceMutationJournal;
		executionGuarantee?: HostingTransitionProvider["executionGuarantee"];
		requiresDestinationLiabilityProof?: boolean;
		requiresSourceLiabilityProof?: boolean;
		requiresSourceLiabilityProofFor?: HostingTransitionProvider["requiresSourceLiabilityProofFor"];
		destinationLiabilities?: Omit<HostingDestinationLiability, "$typeName">[];
		sourceLiabilities?: Omit<HostingDestinationLiability, "$typeName">[];
		sourceIncarnationId?: string;
		sourceChargeMicros?: number;
		boundedQuantity?: number;
	} = {},
) {
	let at = 1000;
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-hosting-transition-"));
	directories.push(dataDir);
	const clock = createManualClock(new Date(at).toISOString());
	let store = createRuntimeLocalEventStore({ dataDir, clock });
	stores.add(store);
	const held = new Map<
		string,
		{
			status: "held" | "uncertain" | "settled";
			reservedMicros: number;
			commitmentHash: string;
			financialPlanHash: string;
			executionDigest?: string;
			settledMicros?: number;
		}
	>();
	const mutations: string[] = [];
	const observations: string[] = [];
	let reservationCalls = 0;
	const budget: SharedHostingBudgetAuthority = {
		persistence: "durable-cas",
		async reserve(request) {
			reservationCalls += 1;
			const existing = held.get(request.reservationId);
			if (
				existing &&
				(existing.commitmentHash !== request.commitment.commitmentHash ||
					existing.financialPlanHash !== request.planHash)
			)
				return { ok: false, reason: "changed reservation" };
			held.set(
				request.reservationId,
				existing ?? {
					status: "held",
					reservedMicros: request.commitment.reservedMicros,
					commitmentHash: request.commitment.commitmentHash,
					financialPlanHash: request.planHash,
				},
			);
			return { ok: true, reservationId: request.reservationId };
		},
		async lookup(request) {
			const found = held.get(request.reservationId);
			if (found && request.commitmentHash !== found.commitmentHash)
				throw new Error("wrong reservation digest");
			return found ?? { status: "missing", reservedMicros: 0 };
		},
		async uncertain(request) {
			const found = held.get(request.reservationId);
			if (found) found.status = "uncertain";
		},
		async claimExecution(request) {
			const found = held.get(request.reservationId);
			if (
				!found ||
				found.status === "settled" ||
				found.financialPlanHash !== request.financialPlanHash ||
				found.commitmentHash !== request.commitmentHash ||
				(found.executionDigest &&
					found.executionDigest !== request.executionDigest)
			)
				return {
					ok: false,
					reason: "reservation is bound to another execution",
				};
			found.executionDigest = request.executionDigest;
			return { ok: true };
		},
		async settle(request) {
			const found = held.get(request.reservationId);
			if (!found || !request.evidenceRef || !request.sourceStoppedEvidenceRef)
				return { ok: false, reason: "missing evidence" };
			found.status = "settled";
			found.settledMicros = request.settledMicros;
			return { ok: true };
		},
	};
	const proof = (request: HostingOperationRequest) => ({
		tenantId: "tenant",
		transitionId: request.plan.transitionId,
		operationId: request.operation.operationId,
		operationDigest: request.operation.operationDigest,
		observedAtMs: at,
		outcome: "applied",
		healthyBackends: 2,
		jurisdiction: "US",
		latencyMs: 20,
		capabilityDigest: "capabilities:v1",
		ready: true,
		evidenceRef: `observation:${request.operation.operationId}:${at}`,
		sourceFenced: true,
		sourceFenceToken: "fence:1",
		sourceQuiescentSequence: 5,
		destinationAppliedSequence: 5,
		checksumEqual: true,
		destinationOwnsWrites: false,
		reverseTransferSafe: false,
		writeOwnershipEpoch: 1,
		sourceRetired: request.operation.action === Action.RETIRE,
		targetRetired: true,
		usageFinal: request.operation.action === Action.SETTLE,
		settledMicros: 3,
		destinationLiabilities: changes.destinationLiabilities,
		destinationLiabilityFinalized: true,
		sourcePlanId: request.plan.sourcePlanId,
		targetPlanId: request.plan.targetPlanId,
	});
	const provider: HostingTransitionProvider = {
		contractId: "provider-hosting/v1",
		executionGuarantee: changes.executionGuarantee ?? "idempotent-operation",
		effects: hostingTransitionContracts.mutate.effects,
		resilience: hostingTransitionContracts.mutate.resilience,
		mutationJournal: changes.mutationJournal,
		requiresDestinationLiabilityProof:
			changes.requiresDestinationLiabilityProof,
		requiresSourceLiabilityProof: changes.requiresSourceLiabilityProof,
		requiresSourceLiabilityProofFor: changes.requiresSourceLiabilityProofFor,
		async execute(request) {
			mutations.push(request.operation.operationId);
			await changes.execute?.(request);
		},
		async observe(request) {
			observations.push(request.operation.operationId);
			return changes.observe ? changes.observe(request) : proof(request);
		},
	};
	const input: HostingPlanningInput = {
		nowMs: at,
		horizonEndMs: 50_000,
		maxObservationAgeMs: 1000,
		budget: {
			budgetId: "budget",
			tenantId: "tenant",
			scopeId: "camp:prod",
			periodId: "period",
			policyRevision: "r1",
			ledgerSeq: 0,
			currency: "USD",
			periodStartMs: 0,
			periodEndMs: 100_000,
			capMicros: 100,
			settledMicros: 0,
			committedMicros: 0,
			unresolvedMicros: 0,
			recoveryReserveMicros: 10,
			observedAtMs: at,
			validUntilMs: 100_000,
			providerAccountId: "",
			periodKind: "monthly",
		},
		quotes: [
			{
				id: "quote",
				resourceName: "app",
				definitionId: "platform:b",
				providerId: "b",
				providerAccountId: "account:b",
				currency: "USD",
				rateMicros: 1,
				billingUnit: "request",
				billingPeriodMs: 0,
				source: "https://example.test/quote",
				observedAtMs: at,
				validUntilMs: 100_000,
				liabilityEndsAtMs: 50_000,
				entitlementId: "",
				minimumQuantity: 0,
				roundUpQuantity: false,
				fixedCostMicros: 0,
				transitionCostMicros: 0,
				components:
					changes.sourceChargeMicros === undefined
						? []
						: [
								{
									id: "source-retained",
									providerAccountId: "account:a",
									costClass: "retention",
									expectedMicros: changes.sourceChargeMicros,
									boundedMicros: changes.sourceChargeMicros,
									entitlementId: "",
								},
							],
			},
		],
		usages: [
			{
				resourceName: "app",
				unit: "request",
				expectedQuantity: 2,
				boundedQuantity: changes.boundedQuantity ?? 5,
			},
		],
		entitlements: [],
		providerBudgets: [],
	};
	const pass = createHostingPlanningPass({
		...input,
		providerBudgets:
			changes.sourceChargeMicros === undefined
				? []
				: ["account:a", "account:b"].map((account) => ({
						...input.budget,
						budgetId: `budget:${account}`,
						providerAccountId: account,
					})),
	});
	pass.commit("app", {
		id: "platform:b",
		providerId: "b",
		port: "compute",
		specificity: 1,
		priority: 0,
		regions: ["US"],
		features: [],
		cost: { sku: "b", unit: "request", marginalPrice: "1" },
		satisfies: () => ({ kind: "full" }),
	});
	const commitment = pass.commitment();
	const plan = createHostingTransitionPlan({
		schemaVersion: "hobo.hosting-transition/v1",
		transitionId: "move",
		tenantId: "tenant",
		deploymentId: "deploy",
		sourcePlanId: "source",
		targetPlanId: "target",
		commitment,
		intent: changes.intent ?? "",
		maximumMutationResumes: changes.maximumMutationResumes ?? 0,
		destinationLiabilities: changes.destinationLiabilities,
		sourceLiabilities: changes.sourceLiabilities,
		sourceIncarnationId:
			changes.sourceIncarnationId ??
			(changes.sourceLiabilities?.length ? "source-lifetime" : ""),
		constraints: {
			minimumHealthyBackends: changes.intent === "decommission" ? 0 : 2,
			allowedJurisdictions: ["US"],
			maximumLatencyMs: 100,
			movementClass: changes.movementClass ?? "stateless",
			observationMaxAgeMs: 1000,
			rollbackHoldUntilMs: changes.rollbackHoldUntilMs ?? 0,
			requiredCapabilityDigest: "capabilities:v1",
			interruptionAllowed: true,
			sourceOwnershipEpoch: 1,
		},
		operationTimeoutMs: changes.operationTimeoutMs ?? 100,
		observationBackoffMs: 10,
		maximumObservationAttempts: changes.maximumObservationAttempts ?? 3,
		horizonEndMs: 50_000,
		workloadContractId: "contract:workload/v1",
		workloadEffectsJson: JSON.stringify(
			changes.noRollbackWorkload
				? createEffectSpec({
						purity: "noRollback",
						capabilities: ["decides"],
						domains: ["storage"],
					})
				: pureEffects(),
		),
		workloadResilienceJson: JSON.stringify(
			createResilienceProfile({
				id: "workload",
				strategies: [{ kind: "timeout", deadlineMs: 100 }],
			}),
		),
		adapterContractDigest: hostingAdapterContractDigest(provider),
	});
	const build = (fenceToken = 1n) =>
		createHostingTransitionCoordinator({
			store: changes.failCommit
				? {
						...store,
						commit: async (request) => {
							if (changes.failCommit?.(request.events[0]?.type ?? ""))
								throw new Error("injected durable commit failure");
							return store.commit(request);
						},
					}
				: store,
			budget,
			provider,
			context: {
				tenantId: "tenant",
				actor: { kind: "service", id: "hosting-controller" },
				fenceToken,
			},
			nowMs: () => at,
			authorize: changes.authorize ?? (async () => ({ allowed: true })),
		});
	let coordinator = build();
	return {
		plan,
		budget,
		held,
		mutations,
		observations,
		reservationCalls: () => reservationCalls,
		provider,
		proof,
		build,
		get coordinator() {
			return coordinator;
		},
		get store() {
			return store;
		},
		advance(ms = 10) {
			at += ms;
			clock.advance(ms);
		},
		now() {
			return at;
		},
		async start() {
			await coordinator.propose(plan);
			return coordinator.reserve(plan.transitionId);
		},
		reopen(fence = 1n) {
			store.close();
			stores.delete(store);
			store = createRuntimeLocalEventStore({ dataDir, clock });
			stores.add(store);
			coordinator = build(fence);
			return coordinator;
		},
	};
}

describe("durable budgeted hosting transitions", () => {
	const finiteLiability = {
		resourceName: "app",
		providerId: "b",
		providerAccountId: "account:b",
		artifactDigest: `sha256:${"a".repeat(64)}`,
		mode: "native-finite-term",
		evidenceRef: "provider:prepaid-term:1",
		expiresAtMs: 50_000,
		maximumMicros: 5,
	};
	const sourceLiability = {
		...finiteLiability,
		resourceName: "source-app",
		providerId: "a",
		providerAccountId: "account:a",
		evidenceRef: "provider:source:prepaid-term:1",
		artifactDigest: `sha256:${"b".repeat(64)}`,
		maximumMicros: 3,
	};
	it.each([
		0, 1,
	])("derives the source proof requirement from its immutable catalog with %i source resources", async (sourceCount) => {
		const sourceInventories = new Map([
			[
				"source",
				Object.freeze(
					Array.from(
						{ length: sourceCount },
						(_, index) => `source-resource:${index}`,
					),
				),
			],
		]);
		const f = setup({
			requiresSourceLiabilityProofFor: (plan) => {
				const inventory = sourceInventories.get(plan.sourcePlanId);
				if (!inventory) throw new Error("unknown source artifact");
				return inventory.length > 0;
			},
		});
		if (sourceCount) {
			await expect(f.start()).rejects.toThrow(
				"provider-enforced source liability proof",
			);
			expect(f.reservationCalls()).toBe(0);
		} else {
			expect((await f.start()).phase).toBe(Phase.PREPARING);
		}
		expect(f.mutations).toHaveLength(0);
	});
	it.each([
		"move",
		"decommission",
	])("refuses a production %s with unbounded existing source before reservation or effects", async (intent) => {
		const f = setup({ intent, requiresSourceLiabilityProof: true });
		await expect(f.start()).rejects.toThrow(
			"provider-enforced source liability proof",
		);
		expect(f.reservationCalls()).toBe(0);
		expect(f.mutations).toHaveLength(0);
	});
	it("approves source and target maxima together and binds the source account to immutable approval", () => {
		const f = setup({
			sourceLiabilities: [sourceLiability],
			sourceChargeMicros: 3,
			boundedQuantity: 2,
			destinationLiabilities: [{ ...finiteLiability, maximumMicros: 2 }],
		});
		expect(f.plan.sourceLiabilities[0]?.providerAccountId).toBe("account:a");
		expect(() =>
			createHostingTransitionPlan({
				...f.plan,
				sourceLiabilities: [
					{ ...sourceLiability, providerAccountId: "account:foreign" },
				],
			}),
		).toThrow("provider-account financial reservation");
	});
	it("refuses source charges attributed to another provider account despite sufficient global headroom", () => {
		expect(() =>
			setup({
				sourceLiabilities: [sourceLiability],
				destinationLiabilities: [{ ...finiteLiability, maximumMicros: 2 }],
			}),
		).toThrow("provider-account financial reservation");
		expect(() =>
			setup({
				sourceChargeMicros: 3,
				boundedQuantity: 2,
				sourceLiabilities: [
					{ ...sourceLiability, providerAccountId: "account:foreign" },
				],
				destinationLiabilities: [{ ...finiteLiability, maximumMicros: 2 }],
			}),
		).toThrow("provider-account financial reservation");
	});
	it("requires a source lifetime identity and rejects changing the approved incarnation", () => {
		expect(() =>
			setup({
				sourceChargeMicros: 3,
				boundedQuantity: 2,
				sourceLiabilities: [sourceLiability],
				sourceIncarnationId: "",
			}),
		).toThrow("source incarnation");
		const f = setup({
			sourceChargeMicros: 3,
			boundedQuantity: 2,
			sourceLiabilities: [sourceLiability],
		});
		expect(() =>
			createHostingTransitionPlan({
				...f.plan,
				sourceIncarnationId: "recreated-source-lifetime",
			}),
		).toThrow("digest mismatch");
	});
	it.each([
		{ sourceLiabilities: [{ ...sourceLiability, maximumMicros: 4 }] },
		{ sourceLiabilities: [{ ...sourceLiability, mode: "soft-quota" }] },
		{ sourceLiabilities: [{ ...sourceLiability, expiresAtMs: 50_001 }] },
		{
			sourceLiabilities: [
				sourceLiability,
				{ ...sourceLiability, evidenceRef: "other-proof" },
			],
		},
		{
			sourceLiabilities: [
				{ ...sourceLiability, evidenceRef: finiteLiability.evidenceRef },
			],
		},
	])("refuses unfunded, duplicated or reused source liability %j", ({
		sourceLiabilities,
	}) => {
		expect(() =>
			setup({
				sourceLiabilities,
				destinationLiabilities: [{ ...finiteLiability, maximumMicros: 2 }],
			}),
		).toThrow();
	});
	it("can decommission an explicitly bounded source without declaring a surviving destination", async () => {
		const f = setup({
			intent: "decommission",
			requiresSourceLiabilityProof: true,
			sourceLiabilities: [sourceLiability],
			sourceChargeMicros: 3,
			boundedQuantity: 2,
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SETTLED);
		expect(f.mutations).toEqual(["move:1:RETIRE"]);
	});
	it("refuses a production move without provider-enforced target lifetime before reservation or effects", async () => {
		const f = setup({ requiresDestinationLiabilityProof: true });
		await expect(f.start()).rejects.toThrow(
			"provider-enforced destination liability",
		);
		expect(f.reservationCalls()).toBe(0);
		expect(f.mutations).toHaveLength(0);
	});
	it("refuses omitted final money instead of silently settling protobuf's default zero", async () => {
		const f = setup({
			intent: "decommission",
			observe: async (request) => {
				const observation = f.proof(request);
				if (request.operation.action === Action.SETTLE)
					Reflect.deleteProperty(observation, "settledMicros");
				return observation;
			},
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await expect(f.coordinator.observe("move")).rejects.toThrow(
			"explicit settled monetary amount",
		);
		expect([...f.held.values()][0]?.status).not.toBe("settled");
		expect((await f.coordinator.load("move"))?.phase).toBe(Phase.BLOCKED);
	});
	it.each([
		{ ...finiteLiability, mode: "soft-quota" },
		{ ...finiteLiability, expiresAtMs: 50_001 },
		{ ...finiteLiability, maximumMicros: 6 },
		{ ...finiteLiability, providerAccountId: "account:other" },
		{ ...finiteLiability, providerId: "other-provider" },
		{ ...finiteLiability, artifactDigest: "mutable:latest" },
		{ ...finiteLiability, mode: "provider-funded-zero", maximumMicros: 1 },
	])("rejects a destination liability that cannot bound its funded resource: %j", (liability) => {
		expect(() => setup({ destinationLiabilities: [liability] })).toThrow();
	});
	it("blocks first provider mutation when its native term cannot cover the operation deadline", async () => {
		const f = setup({
			destinationLiabilities: [{ ...finiteLiability, expiresAtMs: 1050 }],
		});
		await f.start();
		expect((await f.coordinator.dispatch("move")).phase).toBe(Phase.BLOCKED);
		expect(f.mutations).toHaveLength(0);
	});
	it("rejects observed native proof for another artifact and preserves the financial hold", async () => {
		const f = setup({
			destinationLiabilities: [finiteLiability],
			observe: async (request) => ({
				...f.proof(request),
				destinationLiabilities: [
					{ ...finiteLiability, artifactDigest: `sha256:${"b".repeat(64)}` },
				],
			}),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		const state = await f.coordinator.observe("move");
		expect(state.phase).toBe(Phase.RESTORING);
		expect([...f.held.values()][0]?.status).not.toBe("settled");
	});
	it("retains the full hold across reopen after source retirement until future destination liability is final", async () => {
		let final = false;
		const f = setup({
			requiresDestinationLiabilityProof: true,
			destinationLiabilities: [finiteLiability],
			observe: async (request) => ({
				...f.proof(request),
				destinationLiabilityFinalized: final,
			}),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		const pending = await f.coordinator.observe("move");
		expect(pending.phase).toBe(Phase.RECONCILING);
		expect(pending.operation?.action).toBe(Action.SETTLE);
		expect(pending.blockedReason).toContain("finalized destination liability");
		expect(f.held.get(pending.reservationId)?.status).toBe("held");
		f.reopen();
		expect((await f.coordinator.load("move"))?.phase).toBe(Phase.RECONCILING);
		final = true;
		f.advance();
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SETTLED);
		expect(f.held.get(pending.reservationId)?.status).toBe("settled");
	});
	it.each([
		"native-finite-term",
		"provider-funded-zero",
	])("settles an expired %s target only after positive absence and final liability evidence without invented health", async (mode) => {
		let expired = false;
		const f = setup({
			destinationLiabilities: [
				{
					...finiteLiability,
					mode,
					maximumMicros: mode === "provider-funded-zero" ? 0 : 5,
				},
			],
			observe: async (request) => {
				const observation = {
					...f.proof(request),
					destinationLiabilityFinalized: expired,
				};
				if (expired) {
					observation.ready = false;
					observation.healthyBackends = 0;
					observation.jurisdiction = "";
					observation.capabilityDigest = "";
					observation.targetRetired = true;
				}
				return observation;
			},
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		expired = true;
		f.advance(49_001);
		const settled = await f.coordinator.observe("move");
		expect(settled.phase).toBe(Phase.SETTLED);
		expect(settled.lastObservation).toMatchObject({
			ready: false,
			healthyBackends: 0,
			targetRetired: true,
		});
		expect(f.held.get(settled.reservationId)?.status).toBe("settled");
	});
	it("decommissions through a separately funded retirement and final settlement without preparing or shifting", async () => {
		const f = setup({
			intent: "decommission",
			observe: async (request) => ({
				...f.proof(request),
				ready: false,
				healthyBackends: 0,
				jurisdiction: "",
				capabilityDigest: "",
			}),
		});
		const reserved = await f.start();
		expect(reserved.operation?.action).toBe(Action.RETIRE);
		await f.coordinator.dispatch("move");
		expect((await f.coordinator.observe("move")).operation?.action).toBe(
			Action.SETTLE,
		);
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SETTLED);
		expect(f.mutations).toHaveLength(1);
		expect(f.mutations[0]).toContain("RETIRE");
	});
	it("only permits the zero availability floor for explicitly interruptible decommissioning", () => {
		const f = setup();
		expect(() =>
			createHostingTransitionPlan({
				...f.plan,
				planDigest: "",
				constraints: { ...f.plan.constraints, minimumHealthyBackends: 0 },
			}),
		).toThrow();
		expect(() =>
			createHostingTransitionPlan({
				...f.plan,
				planDigest: "",
				intent: "decommission",
				constraints: {
					...f.plan.constraints,
					minimumHealthyBackends: 0,
					interruptionAllowed: false,
				},
			}),
		).toThrow();
	});
	it("cancels an undispatched decommission without deleting the source or releasing its hold", async () => {
		const f = setup({ intent: "decommission" });
		await f.start();
		const state = await f.coordinator.cancel("move");
		expect(state).toMatchObject({
			phase: Phase.BLOCKED,
			cancelRequested: true,
			sourceRetirementConfirmed: false,
		});
		expect(f.mutations).toHaveLength(0);
		expect([...f.held.values()][0]?.status).toBe("uncertain");
	});
	it("continues observing and settling already dispatched retirement after cancellation, without restoring", async () => {
		const f = setup({
			intent: "decommission",
			observe: async (request) => ({
				...f.proof(request),
				ready: false,
				healthyBackends: 0,
			}),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.cancel("move");
		f.advance();
		expect((await f.coordinator.observe("move")).operation?.action).toBe(
			Action.SETTLE,
		);
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SETTLED);
		expect(f.mutations).toHaveLength(1);
	});
	it("requires positive source retirement and actual final usage for decommission", async () => {
		const f = setup({
			intent: "decommission",
			observe: async (request) => ({
				...f.proof(request),
				ready: false,
				healthyBackends: 0,
				sourceRetired: false,
				usageFinal: false,
			}),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.BLOCKED);
		expect([...f.held.values()][0]?.status).not.toBe("settled");
		expect((await f.coordinator.restore("move")).blockedReason).toContain(
			"cannot recreate",
		);
	});
	it("resumes an incomplete operation explicitly with the same identity and one durable native POST across restart", async () => {
		const j = mutationJournal();
		let nativeCreates = 0,
			safeUploads = 0,
			complete = false;
		const f = setup({
			mutationJournal: j.journal,
			maximumMutationResumes: 1,
			execute: async (request) => {
				const id = `native-create:${request.operation.operationId}`;
				const permit = await j.journal.claim({
					mutationId: id,
					requestDigest: request.operation.operationDigest,
				});
				if (permit.status === "claimed") {
					nativeCreates++;
					await j.journal.acknowledge(id, request.operation.operationDigest);
					throw {
						failureClass: "transient",
						message: "lost response after durable draft",
					};
				}
				safeUploads++;
				complete = true;
			},
			observe: async (request) => ({
				...f.proof(request),
				outcome: complete ? "applied" : "pending",
			}),
		});
		await f.start();
		const first = await f.coordinator.dispatch("move");
		f.advance(150);
		await f.coordinator.observe("move");
		f.reopen();
		j.reopen();
		const resumed = await f.coordinator.resumeMutation("move");
		expect(resumed.operation).toMatchObject({
			operationId: first.operation?.operationId,
			operationDigest: first.operation?.operationDigest,
			mutationResumes: 1,
		});
		expect(resumed.operation?.deadlineAtMs).toBeGreaterThan(
			first.operation?.deadlineAtMs ?? 0,
		);
		expect(nativeCreates).toBe(1);
		expect(safeUploads).toBe(1);
		expect(f.mutations).toHaveLength(2);
		expect(f.mutations[0]).toBe(f.mutations[1]);
		expect(f.reservationCalls()).toBe(1);
		f.advance();
		expect((await f.coordinator.observe("move")).operation?.action).toBe(
			Action.SHIFT,
		);
	});
	it("refuses mutation resumes without a durable journal or idempotent adapter before admission", async () => {
		for (const options of [
			{ maximumMutationResumes: 1 },
			{
				maximumMutationResumes: 1,
				mutationJournal: {
					...mutationJournal().journal,
					persistence: "memory" as const,
				},
			},
			{
				maximumMutationResumes: 1,
				mutationJournal: mutationJournal().journal,
				executionGuarantee: "fenced-operation" as const,
			},
		]) {
			const f = setup(options);
			await expect(f.start()).rejects.toThrow("durable mutation journal");
			expect(f.reservationCalls()).toBe(0);
			expect(f.mutations).toHaveLength(0);
		}
	});
	it("requires fresh independent pending evidence and obeys the explicitly approved resume bound", async () => {
		const j = mutationJournal();
		const f = setup({
			mutationJournal: j.journal,
			maximumMutationResumes: 1,
			execute: async () => {
				throw { failureClass: "transient" };
			},
			observe: async (request) => ({ ...f.proof(request), outcome: "pending" }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await expect(f.coordinator.resumeMutation("move")).rejects.toThrow(
			"independent pending",
		);
		f.advance();
		await f.coordinator.observe("move");
		await f.coordinator.resumeMutation("move");
		await expect(f.coordinator.resumeMutation("move")).rejects.toThrow(
			"budget exhausted",
		);
		expect(f.mutations).toHaveLength(2);
	});
	it("never automatically replays a journaled resume intent after a crash before dispatch", async () => {
		const j = mutationJournal();
		let crash = false;
		const f = setup({
			mutationJournal: j.journal,
			maximumMutationResumes: 2,
			failCommit: (type) => crash && type === "hosting.TransitionDispatched",
			execute: async () => {
				throw { failureClass: "transient" };
			},
			observe: async (request) => ({ ...f.proof(request), outcome: "pending" }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		f.advance();
		await f.coordinator.observe("move");
		crash = true;
		await expect(f.coordinator.resumeMutation("move")).rejects.toThrow(
			"injected",
		);
		crash = false;
		f.reopen();
		j.reopen();
		f.advance();
		await f.coordinator.dispatch("move");
		expect(f.mutations).toHaveLength(1);
		expect((await f.coordinator.load("move"))?.operation?.mutationResumes).toBe(
			1,
		);
		await f.coordinator.resumeMutation("move");
		expect(f.mutations).toHaveLength(2);
	});
	it("lets only one concurrent explicit resume own the next mutation attempt", async () => {
		const j = mutationJournal();
		const f = setup({
			mutationJournal: j.journal,
			maximumMutationResumes: 1,
			execute: async () => {
				throw { failureClass: "transient" };
			},
			observe: async (request) => ({ ...f.proof(request), outcome: "pending" }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		f.advance();
		await f.coordinator.observe("move");
		await Promise.allSettled([
			f.coordinator.resumeMutation("move"),
			f.coordinator.resumeMutation("move"),
		]);
		expect(f.mutations).toHaveLength(2);
		expect((await f.coordinator.load("move"))?.operation?.mutationResumes).toBe(
			1,
		);
	});
	it("refuses stale evidence, cancellation and expired funding before an explicit mutation resume", async () => {
		for (const failure of ["stale", "cancelled", "expired"]) {
			const j = mutationJournal();
			const f = setup({
				mutationJournal: j.journal,
				maximumMutationResumes: 1,
				execute: async () => {
					throw { failureClass: "transient" };
				},
				observe: async (request) => ({
					...f.proof(request),
					outcome: "pending",
				}),
			});
			await f.start();
			await f.coordinator.dispatch("move");
			f.advance();
			await f.coordinator.observe("move");
			if (failure === "cancelled") await f.coordinator.cancel("move");
			else f.advance(failure === "expired" ? 50_000 : 1001);
			await expect(f.coordinator.resumeMutation("move")).rejects.toThrow();
			expect(f.mutations).toHaveLength(1);
		}
	});
	it("rechecks approval after a resume authorizer waits beyond its funded execution deadline", async () => {
		const j = mutationJournal();
		let authorizationCalls = 0;
		const f = setup({
			mutationJournal: j.journal,
			maximumMutationResumes: 1,
			authorize: async () => {
				authorizationCalls++;
				if (authorizationCalls === 2) f.advance(101);
				return { allowed: true };
			},
			execute: async () => {
				throw { failureClass: "transient" };
			},
			observe: async (request) => ({ ...f.proof(request), outcome: "pending" }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		f.advance();
		await f.coordinator.observe("move");
		expect((await f.coordinator.resumeMutation("move")).phase).toBe(
			Phase.BLOCKED,
		);
		expect(f.mutations).toHaveLength(1);
	});
	it("does not reuse a pending observation that expires during asynchronous resume authorization", async () => {
		const j = mutationJournal();
		let authorizationCalls = 0;
		const f = setup({
			operationTimeoutMs: 10000,
			mutationJournal: j.journal,
			maximumMutationResumes: 1,
			authorize: async () => {
				authorizationCalls++;
				if (authorizationCalls === 2) f.advance(1001);
				return { allowed: true };
			},
			execute: async () => {
				throw { failureClass: "transient" };
			},
			observe: async (request) => ({ ...f.proof(request), outcome: "pending" }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		f.advance();
		await f.coordinator.observe("move");
		expect(
			(await f.coordinator.resumeMutation("move")).blockedReason,
		).toContain("observation expired");
		expect(f.mutations).toHaveLength(1);
	});
	it("rejects replayed journal counters that bypass the approved bound or an explicit resume command", async () => {
		const j = mutationJournal();
		const f = setup({
			mutationJournal: j.journal,
			maximumMutationResumes: 1,
			execute: async () => {
				throw { failureClass: "transient" };
			},
			observe: async (request) => ({ ...f.proof(request), outcome: "pending" }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		f.advance();
		await f.coordinator.observe("move");
		await f.coordinator.resumeMutation("move");
		const events = [];
		for await (const event of f.store.read("hosting-transition:tenant:move"))
			events.push(event);
		const resume = events.find(
			(event) => event.type === "hosting.TransitionMutationResumeRequested",
		);
		if (!resume) throw new Error("resume fact missing");
		expect(() =>
			foldHostingTransition(
				events.map((event) =>
					event === resume
						? { ...event, type: "hosting.TransitionObserved" }
						: event,
				),
			),
		).toThrow("explicit command");
		const corrupt = fromJson(
			HostingTransitionEventSchema,
			JSON.parse(JSON.stringify(resume.data)),
		);
		if (!corrupt.state?.operation) throw new Error("operation missing");
		corrupt.state.operation.mutationResumes = 2;
		expect(() =>
			foldHostingTransition(
				events.map((event) =>
					event === resume
						? { ...event, data: toJson(HostingTransitionEventSchema, corrupt) }
						: event,
				),
			),
		).toThrow("approved mutation resume bound");
	});
	it("advances only on positive evidence, preserves the hold until retirement and final usage, and settles", async () => {
		const f = setup();
		const pact = JSON.parse(
			readFileSync(
				new URL("../contracts/hosting-transition.pact.json", import.meta.url),
				"utf8",
			),
		);
		const observedContract = pact.interactions[1].response;
		await f.start();
		const prepared = await f.coordinator.dispatch("move");
		expect(prepared.phase).toBe(Phase.PREPARING);
		expect(f.held.get(prepared.reservationId)?.status).toBe("held");
		const shifted = await f.coordinator.observe("move");
		expect(shifted.phase).toBe(observedContract.nextPhase);
		expect(shifted.lastObservation).toMatchObject({
			outcome: observedContract.outcome,
			ready: observedContract.ready,
			healthyBackends: observedContract.healthyBackends,
			jurisdiction: observedContract.jurisdiction,
			capabilityDigest: observedContract.capabilityDigest,
		});
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.observe("move");
		expect((await f.coordinator.load("move"))?.phase).toBe(Phase.RETIRING);
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		expect((await f.coordinator.load("move"))?.phase).toBe(Phase.SETTLING);
		const settled = await f.coordinator.observe("move");
		expect(settled.phase).toBe(Phase.SETTLED);
		expect(settled.sourceRetirementConfirmed).toBe(true);
		expect(settled.settledMicros).toBe(3);
		expect(f.held.get(settled.reservationId)?.status).toBe("settled");
		expect(f.mutations).toHaveLength(3);
	});
	it("persists outbox/timer effects and observes an in-flight mutation after real SQLite reopen without executing twice", async () => {
		const f = setup();
		await f.start();
		await f.coordinator.dispatch("move");
		const outbox = f.store.journal().claimOutbox({
			leaseId: "test",
			leaseFence: 1n,
			visibilityTimeoutMs: 1000,
			limit: 100,
		});
		expect(
			outbox.some(
				(message) => message.destination === "hosting.transition.dispatch",
			),
		).toBe(true);
		const before = JSON.stringify(await f.coordinator.load("move"));
		f.reopen();
		expect(JSON.stringify(await f.coordinator.load("move"))).toBe(before);
		expect(f.mutations).toHaveLength(1);
		await f.coordinator.dispatch("move");
		expect(f.mutations).toHaveLength(1);
		expect((await f.coordinator.load("move"))?.phase).toBe(Phase.SHIFTING);
	});
	it("concurrent workers claim at most one provider mutation through durable CAS", async () => {
		const f = setup();
		await f.start();
		const outcomes = await Promise.allSettled([
			f.coordinator.dispatch("move"),
			f.build().dispatch("move"),
		]);
		expect(f.mutations).toHaveLength(1);
		expect(
			outcomes.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
	});
	it("never retries a lost mutation response, retains exposure, and reconciles after the durable backoff", async () => {
		const f = setup({
			execute: async () => {
				throw { failureClass: "transient", message: "response lost" };
			},
		});
		await f.start();
		const unknown = await f.coordinator.dispatch("move");
		expect(unknown.phase).toBe(Phase.RECONCILING);
		expect(f.held.get(unknown.reservationId)?.status).toBe("uncertain");
		await f.coordinator.dispatch("move");
		expect(f.observations).toHaveLength(0);
		f.advance();
		await f.coordinator.dispatch("move");
		expect(f.mutations).toHaveLength(1);
		expect((await f.coordinator.load("move"))?.phase).toBe(Phase.SHIFTING);
	});
	it("cancels between preparation and an unsent shift by compensating without dispatching the shift", async () => {
		const f = setup();
		await f.start();
		await f.coordinator.dispatch("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SHIFTING);
		const cancelled = await f.coordinator.cancel("move");
		expect(cancelled.phase).toBe(Phase.RESTORING);
		expect(cancelled.cancelRequested).toBe(true);
		await f.coordinator.dispatch("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SETTLING);
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SETTLED);
		expect(f.mutations).toHaveLength(2);
		expect(f.mutations.every((id) => !id.endsWith(":SHIFT"))).toBe(true);
	});
	it("continues observation after cancellation during read-only verification and then compensates", async () => {
		const f = setup();
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.VERIFYING);
		expect((await f.coordinator.cancel("move")).phase).toBe(Phase.RECONCILING);
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.RESTORING);
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SETTLED);
		expect(f.mutations).toHaveLength(3);
	});
	it("uses authoritative absence to compensate a lost mutation response without retrying it", async () => {
		let f: ReturnType<typeof setup>;
		f = setup({
			execute: async (request) => {
				if (request.operation.action === Action.PREPARE)
					throw { failureClass: "transient", message: "lost response" };
			},
			observe: async (request) => ({
				...f.proof(request),
				outcome:
					request.operation.action === Action.PREPARE ? "absent" : "applied",
			}),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		f.advance();
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.RESTORING);
		expect(f.mutations).toHaveLength(1);
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SETTLED);
		expect(f.mutations).toHaveLength(2);
	});
	it("enforces mutation deadlines and retains ambiguous liability after cancellation", async () => {
		const f = setup({
			operationTimeoutMs: 5,
			execute: () => new Promise<void>(() => {}),
		});
		await f.start();
		expect((await f.coordinator.dispatch("move")).phase).toBe(
			Phase.RECONCILING,
		);
		await f.coordinator.cancel("move");
		expect([...f.held.values()][0]?.status).toBe("uncertain");
		expect(f.mutations).toHaveLength(1);
	});
	it("bounds transient observation retries and persists failure without releasing funds", async () => {
		const f = setup({
			maximumObservationAttempts: 2,
			observe: async () => {
				throw { failureClass: "transient", message: "provider unavailable" };
			},
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		f.advance();
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.BLOCKED);
		f.advance();
		await f.coordinator.observe("move");
		expect(f.observations).toHaveLength(2);
		expect([...f.held.values()][0]?.status).toBe("held");
	});
	it.each([
		"policy.Decided",
		"terminal",
		"cancellation",
	])("never retries %s observation failures", async (failureClass) => {
		const f = setup({
			observe: async () => {
				throw { failureClass, message: "stop" };
			},
		});
		await f.start();
		await f.coordinator.dispatch("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.BLOCKED);
		f.advance();
		await f.coordinator.observe("move");
		expect(f.observations).toHaveLength(1);
	});
	it("rejects foreign, stale and wrong-operation evidence without advancing", async () => {
		let fixture: ReturnType<typeof setup>;
		fixture = setup({
			observe: async (request) => ({
				...fixture.proof(request),
				tenantId: "other",
			}),
		});
		await fixture.start();
		await fixture.coordinator.dispatch("move");
		await expect(fixture.coordinator.observe("move")).rejects.toThrow(
			"foreign or wrong-operation",
		);
		expect((await fixture.coordinator.load("move"))?.phase).toBe(Phase.BLOCKED);
	});
	it("rejects proposal reuse and stale authoritative policy before an external effect", async () => {
		const f = setup({
			authorize: async () => ({
				allowed: false,
				reason: "policy revision changed",
			}),
		});
		await f.start();
		expect((await f.coordinator.dispatch("move")).blockedReason).toBe(
			"policy revision changed",
		);
		expect(f.mutations).toHaveLength(0);
		await expect(
			f.coordinator.propose({
				...f.plan,
				targetPlanId: "another",
				planDigest: "",
			}),
		).rejects.toThrow("different proposal");
	});
	it("carries availability constraints through every phase and refuses observed degradation", async () => {
		let f: ReturnType<typeof setup>;
		f = setup({
			observe: async (request) => ({ ...f.proof(request), healthyBackends: 1 }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		const recovery = await f.coordinator.observe("move");
		expect(recovery.phase).toBe(Phase.RESTORING);
		expect(recovery.plan?.constraints?.minimumHealthyBackends).toBe(2);
		expect([...f.held.values()][0]?.status).toBe("held");
	});
	it("does not report restoration when the provider cannot realize it", async () => {
		let f: ReturnType<typeof setup>;
		f = setup({
			observe: async (request) => ({
				...f.proof(request),
				outcome:
					request.operation.action === Action.RESTORE ? "failed" : "applied",
				healthyBackends: request.operation.action === Action.PREPARE ? 1 : 2,
			}),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		const failed = await f.coordinator.observe("move");
		expect(failed.phase).toBe(Phase.BLOCKED);
		expect(failed.restorationConfirmed).toBe(false);
		expect([...f.held.values()][0]?.status).toBe("held");
	});
	it("holds the funded source through the rollback retention window", async () => {
		const f = setup({ rollbackHoldUntilMs: 2000 });
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.RECONCILING);
		expect(f.mutations).toHaveLength(2);
		f.advance(1000);
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.RETIRING);
	});
	it("requires stateful fence/checksum evidence and refuses blind reverse after destination writes", async () => {
		let f: ReturnType<typeof setup>;
		f = setup({
			movementClass: "single-writer",
			noRollbackWorkload: true,
			observe: async (request) => ({
				...f.proof(request),
				destinationOwnsWrites: request.operation.action !== Action.PREPARE,
				writeOwnershipEpoch:
					request.operation.action === Action.PREPARE ? 1 : 2,
				healthyBackends: request.operation.action === Action.VERIFY ? 1 : 2,
			}),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		const refused = await f.coordinator.observe("move");
		expect(refused.phase).toBe(Phase.BLOCKED);
		expect(refused.blockedReason).toMatch(/safe reverse/);
		expect(f.mutations).toHaveLength(2);
	});
	it("binds declared effects and rejects contract tampering, money overflow, and unsafe resilience before effects", async () => {
		const f = setup();
		expect(
			createHostingTransitionPlan({
				...f.plan,
				planDigest: "",
				workloadContractDigest: "",
				workloadEffectsJson: JSON.stringify(
					createEffectSpec({ purity: "noRollback", domains: ["network"] }),
				),
			}),
		).toMatchObject({ constraints: { movementClass: "stateless" } });
		expect(() =>
			createHostingTransitionPlan({
				...f.plan,
				planDigest: "",
				workloadContractDigest: "forged",
			}),
		).toThrow(/contract digest/);
		expect(() =>
			createHostingTransitionPlan({
				...f.plan,
				planDigest: "",
				operationTimeoutMs: Number.MAX_SAFE_INTEGER + 1,
			}),
		).toThrow(/safe integer/);
		expect(() =>
			createHostingTransitionCoordinator({
				store: f.store,
				budget: f.budget,
				provider: { ...f.provider, resilience: createResilienceProfile() },
				context: {
					tenantId: "tenant",
					actor: { kind: "service", id: "worker" },
					fenceToken: 1n,
				},
				nowMs: f.now,
				authorize: async () => ({ allowed: true }),
			}),
		).toThrow(/one attempt/);
	});
	it.each([
		"stateless",
		"single-writer",
	])("refuses %s restoration while a shifted write may still be pending", async (movementClass) => {
		const f = setup({
			movementClass,
			noRollbackWorkload: movementClass === "single-writer",
			execute: async (request) => {
				if (request.operation.action === Action.SHIFT)
					throw { failureClass: "transient", message: "shift response lost" };
			},
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		expect((await f.coordinator.dispatch("move")).phase).toBe(
			Phase.RECONCILING,
		);
		await expect(f.coordinator.restore("move")).rejects.toThrow(
			/terminal authoritative/,
		);
		expect(f.mutations).toHaveLength(2);
		expect([...f.held.values()][0]?.status).toBe("uncertain");
	});
	it("rejects a stale owner after a higher writer fence commits", async () => {
		const f = setup();
		await f.start();
		const old = f.coordinator;
		const newer = f.build(2n);
		await newer.dispatch("move");
		await expect(old.observe("move")).rejects.toThrow(/fenc|stale/i);
		expect(f.mutations).toHaveLength(1);
	});
	it("recovers an authority reservation after crashing before the local Reserved event", async () => {
		let injected = false;
		const f = setup({
			failCommit: (kind) => {
				if (kind === "hosting.TransitionScheduled" && !injected) {
					injected = true;
					return true;
				}
				return false;
			},
		});
		await f.coordinator.propose(f.plan);
		await expect(f.coordinator.reserve("move")).rejects.toThrow(
			/commit failure/,
		);
		expect(f.held.size).toBe(1);
		expect((await f.coordinator.load("move"))?.phase).toBe(Phase.RESERVING);
		f.reopen();
		expect((await f.coordinator.reserve("move")).phase).toBe(Phase.PREPARING);
		expect(f.held.size).toBe(1);
		expect(f.mutations).toHaveLength(0);
	});
	it.each([
		{ operationId: "wrong" },
		{ operationDigest: "wrong" },
		{ tenantId: "other" },
		{ sourcePlanId: "wrong" },
		{ observedAtMs: 999 },
		{ observedAtMs: 1001 },
	])("fails closed on stale or mismatched observation %j", async (changes) => {
		let f: ReturnType<typeof setup>;
		f = setup({
			observe: async (request) => ({ ...f.proof(request), ...changes }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await expect(f.coordinator.observe("move")).rejects.toThrow();
		expect((await f.coordinator.load("move"))?.phase).toBe(Phase.BLOCKED);
		expect(f.mutations).toHaveLength(1);
		expect([...f.held.values()][0]?.status).toBe("held");
	});
	it.each([
		{ sourceFenced: false },
		{ sourceFenceToken: "" },
		{ checksumEqual: false },
		{ destinationAppliedSequence: 4 },
	])("requires the complete state-transfer proof %j", async (missing) => {
		let f: ReturnType<typeof setup>;
		f = setup({
			movementClass: "single-writer",
			noRollbackWorkload: true,
			observe: async (request) => ({ ...f.proof(request), ...missing }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.RESTORING);
		expect(f.mutations).toHaveLength(1);
	});
	it("does not settle until the provider confirms final usage after retirement", async () => {
		let f: ReturnType<typeof setup>;
		f = setup({
			observe: async (request) => ({ ...f.proof(request), usageFinal: false }),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		const waiting = await f.coordinator.observe("move");
		expect(waiting.sourceRetirementConfirmed).toBe(true);
		expect(waiting.phase).toBe(Phase.RECONCILING);
		expect([...f.held.values()][0]?.status).toBe("held");
	});
	it("refuses authorization that resolves after the approved deadline", async () => {
		const f: ReturnType<typeof setup> = setup({
			authorize: async () => {
				f.advance(101);
				return { allowed: true };
			},
		});
		await f.start();
		const late = await f.coordinator.dispatch("move");
		expect(late.phase).toBe(Phase.BLOCKED);
		expect(late.blockedReason).toMatch(/authorization outlived/);
		expect(f.mutations).toHaveLength(0);
		expect([...f.held.values()][0]?.status).toBe("held");
	});
	it("refuses an adapter contract changed while authoritative authorization was pending", async () => {
		const f: ReturnType<typeof setup> = setup({
			authorize: async () => {
				Object.assign(f.provider, { effects: pureEffects() });
				return { allowed: true };
			},
		});
		await f.start();
		const changed = await f.coordinator.dispatch("move");
		expect(changed.phase).toBe(Phase.BLOCKED);
		expect(changed.blockedReason).toMatch(/adapter contract changed/);
		expect(f.mutations).toHaveLength(0);
	});
	it("only one delayed authorizer can claim dispatch against the current revision", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = setup({
			authorize: async () => {
				await gate;
				return { allowed: true };
			},
		});
		await f.start();
		const first = f.coordinator.dispatch("move"),
			second = f.build().dispatch("move");
		await Promise.resolve();
		release?.();
		const results = await Promise.allSettled([first, second]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(f.mutations).toHaveLength(1);
	});
	it("recovers cancellation after a reservation crash without reacquiring expired financial evidence", async () => {
		let injected = false;
		const f = setup({
			failCommit: (kind) => {
				if (kind === "hosting.TransitionScheduled" && !injected) {
					injected = true;
					return true;
				}
				return false;
			},
		});
		await f.coordinator.propose(f.plan);
		await expect(f.coordinator.reserve("move")).rejects.toThrow(
			/commit failure/,
		);
		expect(f.held.size).toBe(1);
		expect(f.reservationCalls()).toBe(1);
		f.advance(100_000);
		expect((await f.coordinator.cancel("move")).phase).toBe(Phase.RESERVING);
		f.reopen();
		expect((await f.coordinator.reserve("move")).phase).toBe(Phase.RESTORING);
		expect(f.reservationCalls()).toBe(1);
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		expect((await f.coordinator.observe("move")).phase).toBe(Phase.SETTLED);
		expect(f.mutations).toHaveLength(1);
	});
	it("accepts mixed wire-record initializers without mutating approved caller records", () => {
		const f = setup();
		const before = JSON.stringify(f.plan);
		Object.freeze(f.plan);
		const normalized = createHostingTransitionPlan(f.plan);
		expect(normalized).not.toBe(f.plan);
		expect(normalized.commitment).not.toBe(f.plan.commitment);
		expect(JSON.stringify(f.plan)).toBe(before);
		const commitment = JSON.parse(
			JSON.stringify(f.plan.commitment, (key, value) =>
				key === "$typeName" ? undefined : value,
			),
		);
		const mixed = createHostingTransitionPlan({
			...f.plan,
			transitionId: "mixed",
			planDigest: "",
			commitment,
		});
		expect(mixed.transitionId).toBe("mixed");
		expect(mixed.commitment?.allocations).toHaveLength(1);
	});
	it("never blindly restores a source whose retirement succeeded before a failed response", async () => {
		let f: ReturnType<typeof setup>;
		f = setup({
			observe: async (request) => ({
				...f.proof(request),
				outcome:
					request.operation.action === Action.RETIRE ? "failed" : "applied",
			}),
		});
		await f.start();
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		await f.coordinator.observe("move");
		await f.coordinator.observe("move");
		await f.coordinator.dispatch("move");
		const failed = await f.coordinator.observe("move");
		expect(failed.phase).toBe(Phase.BLOCKED);
		expect(failed.sourceRetirementConfirmed).toBe(true);
		expect((await f.coordinator.restore("move")).blockedReason).toMatch(
			/retired source/,
		);
		expect(f.mutations).toHaveLength(3);
	});
	it("rejects adopting a financial hold for a different destination artifact before claiming or mutating", async () => {
		const f = setup();
		const financialPlanHash = `sha256:${"a".repeat(64)}`;
		expect(() =>
			createHostingTransitionPlan({
				...f.plan,
				planDigest: "",
				existingReservationId: "gateway-hold",
				financialPlanHash,
			}),
		).toThrow(/destination artifact/);
		expect(() =>
			createHostingTransitionPlan({
				...f.plan,
				planDigest: "",
				targetPlanId: "gateway-plan",
				existingReservationId: "gateway-hold",
				financialPlanHash: "gateway-plan",
			}),
		).toThrow(/artifact hash/);
		expect(f.held.size).toBe(0);
		expect(f.mutations).toHaveLength(0);
	});
	it("adopts the existing gateway financial hold once and rejects a different execution claim", async () => {
		const f = setup();
		const financialPlanHash = `sha256:${"a".repeat(64)}`;
		if (!f.plan.commitment?.evidence?.budget)
			throw new Error("fixture financial evidence missing");
		await f.budget.reserve({
			reservationId: "gateway-hold",
			planHash: financialPlanHash,
			commitment: {
				...f.plan.commitment,
				evidence: {
					...f.plan.commitment.evidence,
					budget: f.plan.commitment.evidence.budget,
				},
			},
		});
		const adopted = createHostingTransitionPlan({
			...f.plan,
			planDigest: "",
			existingReservationId: "gateway-hold",
			financialPlanHash,
			targetPlanId: financialPlanHash,
		});
		await f.coordinator.propose(adopted);
		expect((await f.coordinator.reserve("move")).phase).toBe(Phase.PREPARING);
		expect(f.reservationCalls()).toBe(1);
		expect(f.held.size).toBe(1);
		const rival = createHostingTransitionPlan({
			...adopted,
			transitionId: "rival",
			planDigest: "",
		});
		await f.coordinator.propose(rival);
		expect((await f.coordinator.reserve("rival")).phase).toBe(Phase.BLOCKED);
		expect(f.reservationCalls()).toBe(1);
		expect(f.held.size).toBe(1);
		expect(f.mutations).toHaveLength(0);
	});
});
