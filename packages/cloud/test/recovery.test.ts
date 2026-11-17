import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, EventInput, EventStore } from "@hobo/core";
import { createInMemoryActorHost } from "@hobo/data";
import { emit } from "@hobo/events";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	resourceDestroying,
	resourceFailed,
	resourceProvisioned,
	resourceProvisioning,
	resourceReconciled,
} from "../src/events.js";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
} from "../src/executor/executor.js";
import { isJsonObject } from "../src/json.js";
import {
	desiredSpecHash,
	recordedResources,
} from "../src/orchestrator/desired-state.js";
import { resolveResourceReconciliation } from "../src/orchestrator/recovery.js";
import {
	foldResourceActor,
	hasUnresolvedReconciliation,
	reconcileResource,
} from "../src/orchestrator/resource-actor.js";
import type { ResourcePlan } from "../src/plan-types.js";
import { deploymentViewProjection } from "../src/projections/deployment-view.js";
import { topologyViewProjection } from "../src/projections/topology-view.js";

const actor = { kind: "user", id: "operator" } as const;
const directories: string[] = [];
const stores: ReturnType<typeof createRuntimeLocalEventStore>[] = [];
const specHash = `sha256:${"a".repeat(64)}`;
const previousResource: ResourcePlan = {
	name: "web",
	port: "http",
	provider: "p",
	deps: [],
};
const previousSpecHash = desiredSpecHash(previousResource);
const destroyGeneration = "11111111-1111-4111-8111-111111111111";
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

async function history(store: EventStore) {
	const result: EventEnvelope[] = [];
	for await (const event of store.read("deployment:dep")) result.push(event);
	return result;
}

async function fixture(
	operation: "apply" | "destroy" = "apply",
	previouslyProvisioned = false,
) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-recovery-"));
	directories.push(directory);
	const store = createRuntimeLocalEventStore({
		dataDir: directory,
		clock: createManualClock(),
	});
	stores.push(store);
	const events: EventInput[] = [];
	if (previouslyProvisioned) {
		events.push(
			resourceProvisioning({
				deploymentId: "dep",
				resourceId: "web",
				execId: "old",
				programHash: `sha256:${"c".repeat(64)}`,
				specHash: previousSpecHash,
				providerId: "p",
			}),
		);
		events.push(
			resourceProvisioned({
				deploymentId: "dep",
				resourceId: "web",
				execId: "old",
				outputs: { url: "old" },
				specHash: previousSpecHash,
			}),
		);
	}
	if (operation === "apply")
		events.push(
			resourceProvisioning({
				deploymentId: "dep",
				resourceId: "web",
				execId: "exec-web",
				programHash: `sha256:${"b".repeat(64)}`,
				specHash,
				providerId: "p",
			}),
		);
	else
		events.push(
			resourceDestroying({
				deploymentId: "dep",
				resourceId: "web",
				reason: "destroy",
				operationGeneration: destroyGeneration,
				programHash: `sha256:${"d".repeat(64)}`,
				specHash: previousSpecHash,
			}),
		);
	events.push(
		resourceFailed({
			deploymentId: "dep",
			resourceId: "web",
			reason: "outcome unknown",
			classification: "fatal",
			crossedNoGoThreshold: false,
			requiresReconciliation: true,
			reconciliationOperation: operation,
			reservationId: "iac:attempt",
		}),
	);
	const saved = await emit(store, "deployment:dep", events, {
		expectedSeq: 0,
		actor,
		tenant: "tenant",
	});
	const failed = saved.appended.find(
		(event) => event.type === "resource.Failed",
	);
	if (!failed) throw new Error("failure missing");
	const claim = {
		tenant: "tenant",
		deploymentId: "dep",
		resourceId: "web",
		failureEventId: failed.id,
		operation,
		...(operation === "destroy"
			? { operationGeneration: destroyGeneration }
			: undefined),
		evidenceRef: "proof:provider",
		actor,
		financial: {
			disposition: "held" as const,
			reservationId: "iac:attempt",
			evidenceRef: "proof:budget",
		},
	};
	const deps = {
		store,
		actorHost: createInMemoryActorHost(),
		authorize: async () => true,
		verifyOutcome: async () => true,
		verifyFinancial: async () => true,
	};
	return { store, deps, claim };
}

describe("operator resolution of uncertain infrastructure", () => {
	it("rejects object-shaped evidence references before authorization", async () => {
		const { store, deps, claim } = await fixture();
		const reference = {
			length: 5,
			trim() {
				return this;
			},
			toString() {
				return "proof";
			},
		};
		let calls = 0;
		deps.authorize = async () => {
			calls++;
			return true;
		};
		await expect(
			resolveResourceReconciliation(deps, {
				...claim,
				operation: "apply",
				/* oxlint-disable anti-slop/no-chained-type-assertions -- SAFETY: the test supplies a malformed JavaScript value. */
				evidenceRef: reference as unknown as string,
				/* oxlint-enable anti-slop/no-chained-type-assertions */
				outcome: { kind: "applied", outputs: {} },
			}),
		).rejects.toThrow("RECONCILIATION_INVALID");
		expect(calls).toBe(0);
		expect((await history(store)).at(-1)?.type).toBe("resource.Failed");
	});

	it("validates a single captured outcome when caller accessors change", async () => {
		const { store, deps, claim } = await fixture();
		let reads = 0;
		const input = {
			...claim,
			operation: "apply" as const,
			financial: { ...claim.financial, disposition: "released" as const },
			outcome: {
				get kind() {
					return ++reads <= 4 ? ("no-effect" as const) : ("applied" as const);
				},
				outputs: { url: "not-verified" },
			},
		};
		await expect(resolveResourceReconciliation(deps, input)).rejects.toThrow();
		expect(
			(await history(store)).some(
				(event) => event.type === "resource.Reconciled",
			),
		).toBe(false);
	});

	it("persists the same financial disposition that it validates", async () => {
		const { store, deps, claim } = await fixture();
		let reads = 0;
		await resolveResourceReconciliation(deps, {
			...claim,
			operation: "apply",
			financial: {
				...claim.financial,
				get disposition() {
					return ++reads <= 3 ? "held" : "released";
				},
			},
			outcome: { kind: "applied", outputs: { url: "verified" } },
		});
		expect(reads).toBe(1);
		expect((await history(store)).at(-1)).toMatchObject({
			type: "resource.Reconciled",
			data: { outcome: "applied", financialDisposition: "held" },
		});
	});

	it("authorizes the same captured operator identity that it validates", async () => {
		const { store, deps, claim } = await fixture();
		let reads = 0;
		const seen: string[] = [];
		deps.authorize = async (input) => {
			seen.push(input.actor.kind);
			return true;
		};
		await resolveResourceReconciliation(deps, {
			...claim,
			actor: {
				id: "operator",
				get kind() {
					return ++reads === 1 ? "user" : "system";
				},
			},
			operation: "apply",
			outcome: { kind: "applied", outputs: { url: "verified" } },
		});
		expect(reads).toBe(1);
		expect(seen).toEqual(["user", "user"]);
		expect((await history(store)).at(-1)?.actor).toMatchObject({
			kind: "user",
			id: "operator",
		});
	});
	it("records verified apply outputs and retains the budget hold", async () => {
		const { store, deps, claim } = await fixture();
		const input = {
			...claim,
			operation: "apply" as const,
			outcome: {
				kind: "applied" as const,
				outputs: { url: "https://example.test" },
			},
		};
		const result = await resolveResourceReconciliation(deps, input);
		expect(result.status).toBe("resolved");
		const events = await history(store);
		expect(events.at(-1)).toMatchObject({
			type: "resource.Reconciled",
			data: {
				outcome: "applied",
				outputs: { url: "https://example.test" },
				specHash,
			},
		});
		expect(
			foldResourceActor(events, {
				name: "web",
				port: "http",
				provider: "p",
				deps: [],
			}).state,
		).toBe("Provisioned");
		expect(hasUnresolvedReconciliation(events)).toBe(false);
		expect((await resolveResourceReconciliation(deps, input)).status).toBe(
			"replay",
		);
		expect(await history(store)).toHaveLength(events.length);
	});

	it("preserves the digest and replay of pre-generation apply claims", async () => {
		const { store, deps, claim } = await fixture();
		const input = {
			...claim,
			operation: "apply" as const,
			outcome: { kind: "applied" as const, outputs: { url: "old" } },
		};
		await resolveResourceReconciliation(deps, input);
		const legacyClaim = {
			tenant: input.tenant,
			deploymentId: input.deploymentId,
			resourceId: input.resourceId,
			failureEventId: input.failureEventId,
			operation: input.operation,
			evidenceRef: input.evidenceRef,
			financial: input.financial,
			outcome: input.outcome,
		};
		const digest = `sha256:${createHash("sha256").update(JSON.stringify(legacyClaim)).digest("hex")}`;
		expect((await history(store)).at(-1)?.data).toMatchObject({
			claimDigest: digest,
		});
		expect((await resolveResourceReconciliation(deps, input)).status).toBe(
			"replay",
		);
	});

	it("does not interpret a no-effect apply as a destroyed resource", async () => {
		const { store, deps, claim } = await fixture();
		const input = {
			...claim,
			operation: "apply" as const,
			outcome: { kind: "no-effect" as const, baseline: "absent" as const },
			financial: { ...claim.financial, disposition: "settled" as const },
		};
		await resolveResourceReconciliation(deps, input);
		const events = await history(store);
		expect(events.at(-1)?.type).toBe("resource.Reconciled");
		expect(
			foldResourceActor(events, {
				name: "web",
				port: "http",
				provider: "p",
				deps: [],
			}).state,
		).toBe("Failed");
		expect(hasUnresolvedReconciliation(events)).toBe(false);
		const deployment = deploymentViewProjection.fold(events).rows.dep;
		expect(deployment?.resources.web).toBe("failed");
		const topology = topologyViewProjection.fold(events).rows.dep;
		expect(
			topology?.nodes.find((node) => node.label === "web")?.lifecycle,
		).toBe("failed");
	});

	it.each([
		"apply",
		"destroy",
	] as const)("restores the prior provisioned state after a no-effect %s", async (operation) => {
		const { store, deps, claim } = await fixture(operation, true);
		await resolveResourceReconciliation(deps, {
			...claim,
			operation,
			outcome: { kind: "no-effect" },
			financial: { ...claim.financial, disposition: "settled" },
		});
		const events = await history(store);
		const snapshot = foldResourceActor(events, previousResource);
		expect(snapshot).toMatchObject({
			state: "Provisioned",
			outputs: { url: "old" },
			specHash: previousSpecHash,
		});
		expect(recordedResources(events).get("web")).toMatchObject({
			state: "Provisioned",
			specHash: previousSpecHash,
			providerId: "p",
		});
		expect(deploymentViewProjection.fold(events).rows.dep?.resources.web).toBe(
			"provisioned",
		);
		expect(
			topologyViewProjection
				.fold(events)
				.rows.dep?.nodes.find((node) => node.label === "web")?.lifecycle,
		).toBe("provisioned");
		let calls = 0;
		const iac = {
			id: "p",
			preview: async () => ({ summary: "update", changes: 1 }),
			apply: async () => {
				calls++;
				return { url: "new" };
			},
			destroy: async () => {},
			refresh: async () => ({ drift: false, observed: {} }),
		};
		const executor = createInProcessExecutor({ iac });
		const resource =
			operation === "apply"
				? { ...previousResource, region: "new-region" }
				: previousResource;
		const result = await reconcileResource(
			{
				store,
				actorHost: deps.actorHost,
				executor,
				broker: createInProcessCredentialBroker(),
			},
			resource,
			{ deploymentId: "dep", tenant: "tenant", actor },
		);
		expect(result.kind).toBe(operation === "apply" ? "updated" : "converged");
		expect(calls).toBe(operation === "apply" ? 1 : 0);
	});

	it("records a verified destroy separately from an apply", async () => {
		const { store, deps, claim } = await fixture("destroy");
		const outcomeStarts: EventEnvelope[] = [];
		const financialStarts: EventEnvelope[] = [];
		deps.verifyOutcome = async (input) => {
			if (input.destroying !== undefined) outcomeStarts.push(input.destroying);
			return true;
		};
		deps.verifyFinancial = async (input) => {
			if (input.destroying !== undefined)
				financialStarts.push(input.destroying);
			return true;
		};
		await resolveResourceReconciliation(deps, {
			...claim,
			operation: "destroy",
			operationGeneration: destroyGeneration,
			outcome: { kind: "destroyed", finalStateHash: "sha256:destroyed" },
		});
		const events = await history(store);
		const destroyStart = events.find(
			(event) => event.type === "resource.Destroying",
		);
		expect(outcomeStarts).toEqual([destroyStart]);
		expect(financialStarts).toEqual([destroyStart]);
		expect(events.at(-1)).toMatchObject({
			type: "resource.Reconciled",
			data: { outcome: "destroyed", finalStateHash: "sha256:destroyed" },
		});
		expect(hasUnresolvedReconciliation(events)).toBe(false);
	});

	it.each([
		"missing-start",
		"missing-generation",
		"start-missing-generation",
		"malformed-generation",
		"missing-program-hash",
		"missing-spec-hash",
		"different-generation",
		"different-resource",
		"different-tenant",
		"different-deployment",
	] as const)("rejects unbound destroy recovery: %s", async (variant) => {
		const { store, deps, claim } = await fixture("destroy");
		let calls = 0;
		deps.verifyOutcome = async () => {
			calls++;
			return true;
		};
		const wrapped: EventStore = {
			...store,
			async *read(streamId, fromSeq) {
				for await (const event of store.read(streamId, fromSeq)) {
					if (event.type !== "resource.Destroying") {
						yield event;
						continue;
					}
					if (variant === "missing-start") continue;
					if (!isJsonObject(event.data)) throw new Error("invalid fixture");
					if (variant === "start-missing-generation") {
						const data = { ...event.data };
						delete data.operationGeneration;
						yield { ...event, data };
					} else if (variant === "missing-program-hash") {
						const data = { ...event.data };
						delete data.programHash;
						yield { ...event, data };
					} else if (variant === "missing-spec-hash") {
						const data = { ...event.data };
						delete data.specHash;
						yield { ...event, data };
					} else if (variant === "malformed-generation")
						yield {
							...event,
							data: { ...event.data, operationGeneration: "bad" },
						};
					else if (variant === "different-resource")
						yield { ...event, data: { ...event.data, resourceId: "other" } };
					else if (variant === "different-tenant")
						yield { ...event, tenant: "other" };
					else if (variant === "different-deployment")
						yield { ...event, data: { ...event.data, deploymentId: "other" } };
					else yield event;
				}
			},
		};
		await expect(
			resolveResourceReconciliation(
				{ ...deps, store: wrapped },
				{
					...claim,
					operation: "destroy",
					operationGeneration:
						variant === "missing-generation"
							? undefined
							: variant === "different-generation"
								? "22222222-2222-4222-8222-222222222222"
								: destroyGeneration,
					outcome: { kind: "destroyed", finalStateHash: "sha256:destroyed" },
				},
			),
		).rejects.toThrow(
			variant === "different-tenant" || variant === "different-deployment"
				? "RECONCILIATION_SCOPE_MISMATCH"
				: variant === "missing-generation"
					? "RECONCILIATION_INVALID"
					: "RECONCILIATION_PROVENANCE",
		);
		expect(calls).toBe(0);
	});

	it.each([
		"scope",
		"authorization",
		"failure",
		"operation",
		"reservation",
		"held-no-effect",
		"outcome-proof",
		"financial-proof",
	] as const)("rejects %s without clearing the uncertainty", async (kind) => {
		const { store, deps, claim } = await fixture();
		const input = {
			...claim,
			operation:
				kind === "operation" ? ("destroy" as const) : ("apply" as const),
			outcome: { kind: "applied" as const, outputs: {} },
		};
		if (kind === "scope") input.tenant = "other";
		if (kind === "authorization") deps.authorize = async () => false;
		if (kind === "failure") input.failureEventId = "other";
		if (kind === "reservation")
			input.financial = { ...input.financial, reservationId: "other" };
		if (kind === "outcome-proof") deps.verifyOutcome = async () => false;
		if (kind === "financial-proof") deps.verifyFinancial = async () => false;
		const changed =
			kind === "held-no-effect"
				? { ...input, outcome: { kind: "no-effect" as const } }
				: input;
		await expect(
			resolveResourceReconciliation(deps, changed),
		).rejects.toThrow();
		expect(hasUnresolvedReconciliation(await history(store))).toBe(true);
	});

	it("recognizes an append committed before an acknowledgement was lost", async () => {
		const { store, deps, claim } = await fixture();
		const wrapped: EventStore = {
			...store,
			append: async (...args) => {
				await store.append(...args);
				throw new Error("lost acknowledgement");
			},
		};
		const input = {
			...claim,
			operation: "apply" as const,
			outcome: { kind: "applied" as const, outputs: {} },
		};
		const result = await resolveResourceReconciliation(
			{ ...deps, store: wrapped },
			input,
		);
		expect(result.status).toBe("replay");
		expect(hasUnresolvedReconciliation(await history(store))).toBe(false);
	});

	it("requires a verified absence claim when the prior resource state is unknown", async () => {
		const { store, deps, claim } = await fixture();
		await expect(
			resolveResourceReconciliation(deps, {
				...claim,
				operation: "apply",
				outcome: { kind: "no-effect" },
				financial: { ...claim.financial, disposition: "settled" },
			}),
		).rejects.toThrow("RECONCILIATION_BASELINE_UNKNOWN");
		expect(hasUnresolvedReconciliation(await history(store))).toBe(true);
	});

	it("does not accept an unrelated append receipt as a committed recovery", async () => {
		const { store, deps, claim } = await fixture();
		const unrelated = (await history(store))[0];
		if (unrelated === undefined) throw new Error("event missing");
		const wrapped: EventStore = {
			...store,
			append: async () => ({
				streamId: "deployment:dep",
				appended: [unrelated],
				deduped: [],
			}),
		};
		await expect(
			resolveResourceReconciliation(
				{ ...deps, store: wrapped },
				{
					...claim,
					operation: "apply",
					outcome: { kind: "applied", outputs: {} },
				},
			),
		).rejects.toThrow("RECONCILIATION_OUTCOME_UNKNOWN");
		expect(hasUnresolvedReconciliation(await history(store))).toBe(true);
	});

	it("does not let a stale recovery fact clear a newer uncertain failure", async () => {
		const { store, claim } = await fixture();
		await emit(
			store,
			"deployment:dep",
			[
				resourceReconciled({
					deploymentId: "dep",
					resourceId: "web",
					failureEventId: "older-failure",
					operation: "apply",
					outcome: "no-effect",
					restoredState: "failed",
					evidenceRef: "proof:old",
					financialEvidenceRef: "proof:old-budget",
					financialDisposition: "settled",
					reservationId: "iac:attempt",
					claimDigest: `sha256:${"1".repeat(64)}`,
				}),
			],
			{ expectedSeq: (await history(store)).length, actor, tenant: "tenant" },
		);
		const events = await history(store);
		expect(hasUnresolvedReconciliation(events)).toBe(true);
		expect(
			foldResourceActor(events, {
				name: "web",
				port: "http",
				provider: "p",
				deps: [],
			}).state,
		).toBe("ReconciliationRequired");
		expect(
			deploymentViewProjection.fold(events).rows.dep?.reconciliations?.web
				?.failureEventId,
		).toBe(claim.failureEventId);
		expect(
			topologyViewProjection
				.fold(events)
				.rows.dep?.nodes.find((node) => node.label === "web")?.lifecycle,
		).toBe("reconciliation-required");
	});

	it("does not record a terminal outcome while another failure is unresolved", async () => {
		const { store, deps, claim } = await fixture();
		await emit(
			store,
			"deployment:dep",
			[
				resourceFailed({
					deploymentId: "dep",
					resourceId: "web",
					reason: "new uncertain effect",
					classification: "fatal",
					crossedNoGoThreshold: false,
					requiresReconciliation: true,
					reconciliationOperation: "apply",
					reservationId: "iac:attempt",
				}),
			],
			{ expectedSeq: (await history(store)).length, actor, tenant: "tenant" },
		);
		await expect(
			resolveResourceReconciliation(deps, {
				...claim,
				operation: "apply",
				outcome: { kind: "applied", outputs: {} },
			}),
		).rejects.toThrow("RECONCILIATION_MULTIPLE_UNRESOLVED");
		expect(hasUnresolvedReconciliation(await history(store))).toBe(true);
	});

	it("resolves multiple no-effect failures independently without clearing the others", async () => {
		const { store, deps, claim } = await fixture();
		const appended = await emit(
			store,
			"deployment:dep",
			[
				resourceFailed({
					deploymentId: "dep",
					resourceId: "web",
					reason: "second uncertain effect",
					classification: "fatal",
					crossedNoGoThreshold: false,
					requiresReconciliation: true,
					reconciliationOperation: "apply",
					reservationId: "iac:second",
				}),
			],
			{ expectedSeq: (await history(store)).length, actor, tenant: "tenant" },
		);
		const second = appended.appended[0];
		if (second === undefined) throw new Error("failure missing");
		const firstClaim = {
			...claim,
			operation: "apply" as const,
			outcome: { kind: "no-effect" as const, baseline: "absent" as const },
			financial: { ...claim.financial, disposition: "settled" as const },
		};
		await resolveResourceReconciliation(deps, firstClaim);
		let events = await history(store);
		expect(hasUnresolvedReconciliation(events)).toBe(true);
		expect(
			foldResourceActor(events, {
				name: "web",
				port: "http",
				provider: "p",
				deps: [],
			}).state,
		).toBe("ReconciliationRequired");
		expect(
			deploymentViewProjection.fold(events).rows.dep?.reconciliations?.web
				?.failureEventId,
		).toBe(second.id);
		expect(
			topologyViewProjection
				.fold(events)
				.rows.dep?.nodes.find((node) => node.label === "web")
				?.reconciliationEventId,
		).toBe(second.id);
		await resolveResourceReconciliation(deps, {
			...firstClaim,
			failureEventId: second.id,
			financial: { ...firstClaim.financial, reservationId: "iac:second" },
		});
		events = await history(store);
		expect(hasUnresolvedReconciliation(events)).toBe(false);
		expect(
			foldResourceActor(events, {
				name: "web",
				port: "http",
				provider: "p",
				deps: [],
			}).state,
		).toBe("Failed");
		expect(deploymentViewProjection.fold(events).rows.dep?.resources.web).toBe(
			"failed",
		);
		expect(
			topologyViewProjection
				.fold(events)
				.rows.dep?.nodes.find((node) => node.label === "web")?.lifecycle,
		).toBe("failed");
	});

	it("does not use an earlier completed apply as provenance for a later failure", async () => {
		const { store, deps, claim } = await fixture();
		await resolveResourceReconciliation(deps, {
			...claim,
			operation: "apply",
			outcome: { kind: "no-effect", baseline: "absent" },
			financial: { ...claim.financial, disposition: "settled" },
		});
		const appended = await emit(
			store,
			"deployment:dep",
			[
				resourceProvisioned({
					deploymentId: "dep",
					resourceId: "web",
					execId: "old",
					outputs: {},
					specHash,
				}),
				resourceFailed({
					deploymentId: "dep",
					resourceId: "web",
					reason: "new effect",
					classification: "fatal",
					crossedNoGoThreshold: false,
					requiresReconciliation: true,
					reconciliationOperation: "apply",
					reservationId: "iac:attempt",
				}),
			],
			{ expectedSeq: (await history(store)).length, actor, tenant: "tenant" },
		);
		const failure = appended.appended.at(-1);
		if (failure === undefined) throw new Error("failure missing");
		await expect(
			resolveResourceReconciliation(deps, {
				...claim,
				failureEventId: failure.id,
				operation: "apply",
				outcome: { kind: "applied", outputs: {} },
			}),
		).rejects.toThrow("RECONCILIATION_PROVENANCE_MISSING");
	});

	it("leaves the failure unresolved when the stream changes during verification", async () => {
		const { store, deps, claim } = await fixture();
		deps.verifyOutcome = async () => {
			await emit(
				store,
				"deployment:dep",
				[
					resourceProvisioning({
						deploymentId: "dep",
						resourceId: "other",
						execId: "other",
						programHash: `sha256:${"2".repeat(64)}`,
						specHash,
					}),
				],
				{ expectedSeq: (await history(store)).length, actor, tenant: "tenant" },
			);
			return true;
		};
		const input = {
			...claim,
			operation: "apply" as const,
			outcome: { kind: "applied" as const, outputs: {} },
		};
		await expect(resolveResourceReconciliation(deps, input)).rejects.toThrow(
			"RECONCILIATION_OUTCOME_UNKNOWN",
		);
		expect(hasUnresolvedReconciliation(await history(store))).toBe(true);
		deps.verifyOutcome = async () => true;
		expect((await resolveResourceReconciliation(deps, input)).status).toBe(
			"resolved",
		);
	});

	it("rejects altered evidence after a successful resolution", async () => {
		const { store, deps, claim } = await fixture();
		const input = {
			...claim,
			operation: "apply" as const,
			outcome: { kind: "applied" as const, outputs: { url: "one" } },
		};
		await resolveResourceReconciliation(deps, input);
		await expect(
			resolveResourceReconciliation(deps, {
				...input,
				outcome: { kind: "applied", outputs: { url: "two" } },
			}),
		).rejects.toThrow("RECONCILIATION_CONFLICT");
		expect(
			(await history(store)).filter(
				(event) => event.type === "resource.Reconciled",
			),
		).toHaveLength(1);
	});

	it("rechecks operator authorization after verifying external evidence", async () => {
		const { store, deps, claim } = await fixture();
		let checks = 0;
		deps.authorize = async () => ++checks === 1;
		await expect(
			resolveResourceReconciliation(deps, {
				...claim,
				operation: "apply",
				outcome: { kind: "applied", outputs: {} },
			}),
		).rejects.toThrow("RECONCILIATION_UNAUTHORIZED");
		expect(checks).toBe(2);
		expect(hasUnresolvedReconciliation(await history(store))).toBe(true);
	});

	it("does not acknowledge a replay with different recorded outputs", async () => {
		const { store, deps, claim } = await fixture();
		const input = {
			...claim,
			operation: "apply" as const,
			outcome: { kind: "applied" as const, outputs: { url: "one" } },
		};
		await resolveResourceReconciliation(deps, input);
		const wrapped: EventStore = {
			...store,
			async *read(streamId, fromSeq) {
				for await (const event of store.read(streamId, fromSeq)) {
					if (event.type === "resource.Reconciled" && isJsonObject(event.data))
						yield {
							...event,
							data: { ...event.data, outputs: { url: "two" } },
						};
					else yield event;
				}
			},
		};
		await expect(
			resolveResourceReconciliation({ ...deps, store: wrapped }, input),
		).rejects.toThrow("RECONCILIATION_OUTCOME_UNKNOWN");
	});

	it("checks tenant scope of historical resource facts even on replay", async () => {
		const { store, deps, claim } = await fixture();
		const input = {
			...claim,
			operation: "apply" as const,
			outcome: { kind: "applied" as const, outputs: {} },
		};
		await resolveResourceReconciliation(deps, input);
		const wrapped: EventStore = {
			...store,
			async *read(streamId, fromSeq) {
				for await (const event of store.read(streamId, fromSeq)) {
					if (event.type === "resource.Provisioning")
						yield { ...event, tenant: "other" };
					else yield event;
				}
			},
		};
		await expect(
			resolveResourceReconciliation({ ...deps, store: wrapped }, input),
		).rejects.toThrow("RECONCILIATION_SCOPE_MISMATCH");
	});

	it("does not clear uncertainty when a delayed unverified terminal fact arrives", async () => {
		const { store } = await fixture();
		await emit(
			store,
			"deployment:dep",
			[
				resourceProvisioned({
					deploymentId: "dep",
					resourceId: "web",
					execId: "stale",
					outputs: {},
					specHash,
				}),
			],
			{ expectedSeq: (await history(store)).length, actor, tenant: "tenant" },
		);
		const events = await history(store);
		expect(hasUnresolvedReconciliation(events)).toBe(true);
		expect(
			foldResourceActor(events, {
				name: "web",
				port: "http",
				provider: "p",
				deps: [],
			}).state,
		).toBe("ReconciliationRequired");
		expect(deploymentViewProjection.fold(events).rows.dep?.resources.web).toBe(
			"reconciliation-required",
		);
		expect(
			topologyViewProjection
				.fold(events)
				.rows.dep?.nodes.find((node) => node.label === "web")?.lifecycle,
		).toBe("reconciliation-required");
	});
});
