import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	type CiDemand,
	FleetEventType,
	FleetRejection,
	FleetRejectionCode,
	type ParsedExecutionKey,
	parseCapacityGroup,
	parseCiDemand,
	parseControllerIncarnation,
	parseEffect,
	parseExecutionKey,
	parseExecutionProfile,
	parseObservation,
	parseOfferAdmission,
	parseOutbox,
	parseRunnerSlot,
	parseStartBindingInput,
	SqliteStrictFleetStore,
	type StrictFleetStore,
	transitionCiDemand,
	transitionRunnerSlot,
} from "../src/fleet-v2/index.js";

const NOW = "2026-11-03T00:00:00Z";
const POLICY_HASH = "a".repeat(64);
const OFFER_HASH = "b".repeat(64);
const QUOTE_HASH = "c".repeat(64);
const CONTENT_HASH = "d".repeat(64);

type StoreHandle = {
	store: StrictFleetStore;
	close: () => Promise<void>;
	setCapacitySequence: (sequence: number) => Promise<void>;
	setEffectFence: (effectId: string, fence: number) => Promise<void>;
	expireEffectDelivery: (effectId: string) => Promise<void>;
};

function githubKey(jobId = "1") {
	return {
		githubJob: {
			kind: "github-job",
			accountId: "hobo-labs",
			engineId: "gh-actions",
			installationId: "10",
			repositoryId: "101",
			runId: "900",
			jobId,
			runAttempt: 1,
		},
	};
}

function parsedKey(jobId = "1"): ParsedExecutionKey {
	return parseExecutionKey(JSON.stringify(githubKey(jobId)));
}

function demand(
	jobId: string,
	source: "webhook" | "pull" | "repair",
	deliveryId: string,
	policyRevision = 1,
): CiDemand {
	return parseCiDemand(
		JSON.stringify({
			key: githubKey(jobId),
			state: "observed",
			firstObservedAt: NOW,
			lastObservedAt: NOW,
			policyRevision,
			requiredProfileId: "trusted-linux-x64",
			source,
			sourceDeliveryIds: [deliveryId],
		}),
	);
}

function reservation(
	key: ParsedExecutionKey,
	suffix: string,
	expectedCapacitySeq: number,
	costUnits = 1,
	effectSequence = 1,
	policyRevision = 1,
) {
	const bindingSecret = randomBytes(32).toString("hex");
	const bindingSecretHash = createHash("sha256")
		.update(bindingSecret)
		.digest("hex");
	const slot = parseRunnerSlot(
		JSON.stringify({
			id: `slot-${suffix}`,
			accountId: "hobo-labs",
			offerId: "local-offer",
			workerBindingId: `worker-binding-${suffix}`,
			profileId: "trusted-linux-x64",
			runnerName: `hobo-slot-${suffix}`,
			state: "reserved",
			capacityGroupId: "device-1",
			capacityCostUnits: costUnits,
			policyHash: POLICY_HASH,
			offerObservationHash: OFFER_HASH,
			quoteHash: QUOTE_HASH,
			bindingSecretHash,
			incarnationId: "incarnation-1",
			createdAt: NOW,
		}),
	);
	const effect = parseEffect(
		JSON.stringify({
			id: `effect-${suffix}`,
			subjectType: "runner-slot",
			subjectId: slot.id,
			kind: "github.provision-runner",
			sequence: effectSequence,
			state: "planned",
			idempotencyKey: `provision-${suffix}`,
			externalLocator: slot.runnerName,
			createdAt: NOW,
			providerScope: "github:10:101",
		}),
	);
	const outbox = parseOutbox(
		JSON.stringify({
			id: `outbox-${suffix}`,
			effectId: effect.id,
			state: "pending",
			availableAt: NOW,
			createdAt: NOW,
		}),
	);
	return {
		input: {
			demandKey: key,
			slot,
			effect,
			outbox,
			expectedCapacitySeq,
			expectedPolicyRevision: policyRevision,
		},
		bindingSecret,
	};
}

async function seed(store: StrictFleetStore, approvedUnits = 1): Promise<void> {
	await store.initialize();
	await store.createIncarnation(
		parseControllerIncarnation(
			JSON.stringify({
				id: "incarnation-1",
				createdAt: NOW,
				reason: "bootstrap",
			}),
		),
	);
	await store.putExecutionProfile(
		parseExecutionProfile(
			JSON.stringify({
				id: "trusted-linux-x64",
				os: "linux",
				architecture: "x64",
				isolation: "trusted-process",
				lifecycle: "persistent-capacity",
				guarantee: "start-fenced",
			}),
		),
	);
	await store.putOfferAdmission(
		parseOfferAdmission(
			JSON.stringify({
				offerId: "local-offer",
				accountId: "hobo-labs",
				observationHash: OFFER_HASH,
				policyRevision: 1,
				state: "active",
			}),
		),
	);
	await store.putCapacityGroup(
		parseCapacityGroup(
			JSON.stringify({
				id: "device-1",
				accountId: "hobo-labs",
				approvedUnits,
				reservedUnits: 0,
				seq: 0,
				state: "active",
			}),
		),
	);
}

function observation(sequence: number) {
	return parseObservation(
		JSON.stringify({
			workerId: "worker-1",
			accountId: "hobo-labs",
			sequence,
			observedAt: NOW,
			contentHash: CONTENT_HASH,
		}),
	);
}

function storeContract(name: string, open: () => Promise<StoreHandle>): void {
	describe(`${name} strict fleet v2 contract`, () => {
		let handle: StoreHandle | undefined;
		beforeEach(async () => {
			await handle?.close();
			handle = await open();
			await seed(handle.store);
		});
		afterAll(async () => {
			await handle?.close();
		});

		function current(): StrictFleetStore {
			if (!handle) throw new Error("store not initialized");
			return handle.store;
		}

		async function exhaustCapacitySequence(): Promise<void> {
			if (!handle) throw new Error("store not initialized");
			await handle.setCapacitySequence(0xffffffff);
		}

		async function authorizedBinding(store: StrictFleetStore) {
			await store.intake(demand("1", "webhook", "webhook-1"));
			const reserved = reservation(parsedKey("1"), "retry", 0);
			await store.reserveCapacity(reserved.input);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"reserved",
				"provisioning",
			);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"provisioning",
				"registered",
				"runner-1",
			);
			const binding = parseStartBindingInput({
				slotId: reserved.input.slot.id,
				claimId: "claim-1",
				key: githubKey("1"),
				bindingSecret: reserved.bindingSecret,
				assignment: {
					verified: true,
					accountId: "hobo-labs",
					runnerName: reserved.input.slot.runnerName,
					profileId: "trusted-linux-x64",
				},
			});
			await store.bindStart(binding);
			return { binding, reserved };
		}

		it("rechecks the verified runner and revoked offer before returning a retry", async () => {
			const store = current();
			const { binding, reserved } = await authorizedBinding(store);
			expect((await store.bindStart(binding)).idempotent).toBe(true);
			const forged = parseStartBindingInput({
				slotId: reserved.input.slot.id,
				claimId: "claim-1",
				key: githubKey("1"),
				bindingSecret: reserved.bindingSecret,
				assignment: {
					verified: true,
					accountId: "hobo-labs",
					runnerName: "hobo-foreign",
					profileId: "trusted-linux-x64",
				},
			});
			await expect(store.bindStart(forged)).rejects.toMatchObject({
				code: FleetRejectionCode.ASSIGNMENT_MISMATCH,
			});
			await store.putOfferAdmission(
				parseOfferAdmission(
					JSON.stringify({
						offerId: "local-offer",
						accountId: "hobo-labs",
						observationHash: OFFER_HASH,
						policyRevision: 1,
						state: "revoked",
					}),
				),
			);
			await expect(store.bindStart(binding)).rejects.toMatchObject({
				code: FleetRejectionCode.OFFER_REVOKED,
			});
		});

		it("rejects a retry after its worker capacity is revoked", async () => {
			const store = current();
			const { binding } = await authorizedBinding(store);
			const group = await store.capacityGroup("device-1");
			if (!group) throw new Error("capacity group missing");
			await store.putCapacityGroup(
				parseCapacityGroup(
					JSON.stringify({
						id: group.id,
						accountId: group.accountId,
						approvedUnits: group.approvedUnits,
						reservedUnits: group.reservedUnits,
						seq: group.seq,
						state: "revoked",
					}),
				),
			);
			await expect(store.bindStart(binding)).rejects.toMatchObject({
				code: FleetRejectionCode.CAPACITY_INELIGIBLE,
			});
		});

		it("allows exactly one admission to race for one capacity unit", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "webhook-1"));
			await store.intake(demand("2", "webhook", "webhook-2"));
			const first = reservation(parsedKey("1"), "first", 0);
			const second = reservation(parsedKey("2"), "second", 0);
			const results = await Promise.allSettled([
				store.reserveCapacity(first.input),
				store.reserveCapacity(second.input),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				results.filter((result) => result.status === "rejected"),
			).toHaveLength(1);
			expect(await store.capacityGroup("device-1")).toMatchObject({
				approvedUnits: 1,
				reservedUnits: 1,
				seq: 1,
			});
		});

		it("rejects a stale revision even when capacity remains", async () => {
			const store = current();
			await store.putCapacityGroup(
				parseCapacityGroup(
					JSON.stringify({
						id: "device-1",
						accountId: "hobo-labs",
						approvedUnits: 2,
						reservedUnits: 0,
						seq: 0,
						state: "active",
					}),
				),
			);
			await store.intake(demand("1", "webhook", "webhook-1"));
			await store.intake(demand("2", "webhook", "webhook-2"));
			const first = reservation(parsedKey("1"), "stale-first", 1);
			const second = reservation(parsedKey("2"), "stale-second", 1);
			const results = await Promise.allSettled([
				store.reserveCapacity(first.input),
				store.reserveCapacity(second.input),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const rejected = results.filter((result) => result.status === "rejected");
			expect(rejected).toHaveLength(1);
			expect(rejected[0]?.reason).toMatchObject({
				code: FleetRejectionCode.CAPACITY_CONFLICT,
			});
			expect(await store.capacityGroup("device-1")).toMatchObject({
				approvedUnits: 2,
				reservedUnits: 1,
				seq: 2,
			});
		});

		it("supports the unsigned capacity range through reservation and settlement", async () => {
			const store = current();
			await store.putCapacityGroup(
				parseCapacityGroup(
					JSON.stringify({
						id: "device-1",
						accountId: "hobo-labs",
						approvedUnits: 0xffffffff,
						reservedUnits: 0,
						seq: 0,
						state: "active",
					}),
				),
			);
			await store.intake(demand("1", "webhook", "large-capacity"));
			const reserved = reservation(parsedKey("1"), "large", 1, 0x80000000);
			await store.reserveCapacity(reserved.input);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"reserved",
				"provisioning",
			);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"provisioning",
				"registered",
				"large-runner",
			);
			await store.bindStart(
				parseStartBindingInput({
					slotId: reserved.input.slot.id,
					claimId: "large-claim",
					key: githubKey("1"),
					bindingSecret: reserved.bindingSecret,
					assignment: {
						verified: true,
						accountId: "hobo-labs",
						runnerName: reserved.input.slot.runnerName,
						profileId: "trusted-linux-x64",
					},
				}),
			);
			await store.completeExecution({
				claimId: "large-claim",
				state: "completed",
				teardownConfirmed: true,
			});
			expect(await store.capacityGroup("device-1")).toMatchObject({
				approvedUnits: 0xffffffff,
				reservedUnits: 0,
				seq: 3,
			});
		});

		it("refuses an exhausted capacity revision without corrupting the group", async () => {
			const store = current();
			await exhaustCapacitySequence();
			const before = await store.capacityGroup("device-1");
			await expect(
				store.putCapacityGroup(
					parseCapacityGroup(
						JSON.stringify({
							id: "device-1",
							accountId: "hobo-labs",
							approvedUnits: 1,
							reservedUnits: 0,
							seq: 0xffffffff,
							state: "active",
						}),
					),
				),
			).rejects.toMatchObject({ code: FleetRejectionCode.CAPACITY_CONFLICT });
			expect(await store.capacityGroup("device-1")).toEqual(before);
			await store.intake(demand("1", "webhook", "exhausted"));
			const reserved = reservation(parsedKey("1"), "exhausted", 0xffffffff);
			await expect(store.reserveCapacity(reserved.input)).rejects.toMatchObject(
				{ code: FleetRejectionCode.CAPACITY_CONFLICT },
			);
			expect(await store.runnerSlot(reserved.input.slot.id)).toBeUndefined();
			expect(await store.capacityGroup("device-1")).toEqual(before);
		});

		it("rolls back a pre-claim release at an exhausted capacity revision", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "exhausted-release"));
			const reserved = reservation(parsedKey("1"), "exhausted-release", 0);
			await store.reserveCapacity(reserved.input);
			await exhaustCapacitySequence();
			const before = await store.events();
			await expect(
				store.transitionRunnerSlot(
					reserved.input.slot.id,
					"reserved",
					"released",
				),
			).rejects.toMatchObject({ code: FleetRejectionCode.CAPACITY_CONFLICT });
			expect(await store.runnerSlot(reserved.input.slot.id)).toMatchObject({
				state: "reserved",
			});
			expect(await store.capacityGroup("device-1")).toMatchObject({
				reservedUnits: 1,
				seq: 0xffffffff,
			});
			expect(await store.events()).toEqual(before);
		});

		it("rolls back settlement at an exhausted capacity revision", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "exhausted-settlement"));
			const reserved = reservation(parsedKey("1"), "exhausted-settlement", 0);
			await store.reserveCapacity(reserved.input);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"reserved",
				"provisioning",
			);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"provisioning",
				"registered",
				"runner",
			);
			await store.bindStart(
				parseStartBindingInput({
					slotId: reserved.input.slot.id,
					claimId: "exhausted-claim",
					key: githubKey("1"),
					bindingSecret: reserved.bindingSecret,
					assignment: {
						verified: true,
						accountId: "hobo-labs",
						runnerName: reserved.input.slot.runnerName,
						profileId: "trusted-linux-x64",
					},
				}),
			);
			await exhaustCapacitySequence();
			const before = await store.events();
			await expect(
				store.completeExecution({
					claimId: "exhausted-claim",
					state: "completed",
					teardownConfirmed: true,
				}),
			).rejects.toMatchObject({ code: FleetRejectionCode.CAPACITY_CONFLICT });
			expect(await store.executionClaimById("exhausted-claim")).toMatchObject({
				state: "start-authorized",
			});
			expect(await store.runnerSlot(reserved.input.slot.id)).toMatchObject({
				state: "bound",
			});
			expect(await store.capacityGroup("device-1")).toMatchObject({
				reservedUnits: 1,
				seq: 0xffffffff,
			});
			expect(await store.events()).toEqual(before);
		});

		it.each([
			"reserved",
			"provisioning",
			"registered",
		] as const)("retains %s slot capacity while teardown is uncertain", async (phase) => {
			const store = current();
			await store.intake(demand("1", "webhook", `uncertain-${phase}`));
			const reserved = reservation(parsedKey("1"), `uncertain-${phase}`, 0);
			await store.reserveCapacity(reserved.input);
			if (phase !== "reserved")
				await store.transitionRunnerSlot(
					reserved.input.slot.id,
					"reserved",
					"provisioning",
				);
			if (phase === "registered")
				await store.transitionRunnerSlot(
					reserved.input.slot.id,
					"provisioning",
					"registered",
					"runner",
				);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				phase,
				"uncertain",
			);
			expect(await store.capacityGroup("device-1")).toMatchObject({
				reservedUnits: 1,
				seq: 1,
			});
			await expect(
				store.transitionRunnerSlot(
					reserved.input.slot.id,
					"uncertain",
					"released",
				),
			).rejects.toMatchObject({
				code: FleetRejectionCode.TEARDOWN_UNCONFIRMED,
			});
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"uncertain",
				"released",
				undefined,
				{ teardownConfirmed: true },
			);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"uncertain",
				"released",
				undefined,
				{ teardownConfirmed: true },
			);
			expect(await store.capacityGroup("device-1")).toMatchObject({
				reservedUnits: 0,
				seq: 2,
			});
			expect(
				(await store.events()).filter(
					(event) => event.type === FleetEventType.CAPACITY_RELEASED,
				),
			).toHaveLength(1);
		});

		it("settles a claimed uncertain slot only through confirmed teardown", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "claimed-uncertain"));
			const reserved = reservation(parsedKey("1"), "claimed-uncertain", 0);
			await store.reserveCapacity(reserved.input);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"reserved",
				"provisioning",
			);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"provisioning",
				"registered",
				"runner",
			);
			await store.bindStart(
				parseStartBindingInput({
					slotId: reserved.input.slot.id,
					claimId: "uncertain-claim",
					key: githubKey("1"),
					bindingSecret: reserved.bindingSecret,
					assignment: {
						verified: true,
						accountId: "hobo-labs",
						runnerName: reserved.input.slot.runnerName,
						profileId: "trusted-linux-x64",
					},
				}),
			);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"bound",
				"uncertain",
			);
			await store.completeExecution({
				claimId: "uncertain-claim",
				state: "completed",
				teardownConfirmed: false,
			});
			await expect(
				store.transitionRunnerSlot(
					reserved.input.slot.id,
					"uncertain",
					"released",
					undefined,
					{ teardownConfirmed: true },
				),
			).rejects.toMatchObject({ code: FleetRejectionCode.EXECUTION_CONFLICT });
			expect(await store.capacityGroup("device-1")).toMatchObject({
				reservedUnits: 1,
			});
			const first = await store.completeExecution({
				claimId: "uncertain-claim",
				state: "completed",
				teardownConfirmed: true,
			});
			const second = await store.completeExecution({
				claimId: "uncertain-claim",
				state: "completed",
				teardownConfirmed: true,
			});
			expect(first).toMatchObject({ settled: false, capacityReleased: true });
			expect(second).toMatchObject({ settled: false, capacityReleased: false });
			expect(await store.runnerSlot(reserved.input.slot.id)).toMatchObject({
				state: "released",
			});
			expect(await store.capacityGroup("device-1")).toMatchObject({
				reservedUnits: 0,
				seq: 2,
			});
		});

		it("retains an uncertain reservation through generated failed release attempts", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.constantFrom("reserved", "provisioning", "registered"),
					fc.integer({ min: 0, max: 5 }),
					async (phase, attempts) => {
						const instance = await open();
						try {
							const store = instance.store;
							await seed(store);
							await store.intake(
								demand("1", "webhook", "generated-uncertainty"),
							);
							const reserved = reservation(
								parsedKey("1"),
								"generated-uncertainty",
								0,
							);
							await store.reserveCapacity(reserved.input);
							if (phase !== "reserved")
								await store.transitionRunnerSlot(
									reserved.input.slot.id,
									"reserved",
									"provisioning",
								);
							if (phase === "registered")
								await store.transitionRunnerSlot(
									reserved.input.slot.id,
									"provisioning",
									"registered",
									"runner",
								);
							await store.transitionRunnerSlot(
								reserved.input.slot.id,
								phase,
								"uncertain",
							);
							for (let index = 0; index < attempts; index++) {
								await expect(
									store.transitionRunnerSlot(
										reserved.input.slot.id,
										"uncertain",
										"released",
										undefined,
										{ teardownConfirmed: false },
									),
								).rejects.toMatchObject({
									code: FleetRejectionCode.TEARDOWN_UNCONFIRMED,
								});
								expect(await store.capacityGroup("device-1")).toMatchObject({
									reservedUnits: 1,
									seq: 1,
								});
							}
							await store.transitionRunnerSlot(
								reserved.input.slot.id,
								"uncertain",
								"released",
								undefined,
								{ teardownConfirmed: true },
							);
							await store.transitionRunnerSlot(
								reserved.input.slot.id,
								"uncertain",
								"released",
								undefined,
								{ teardownConfirmed: true },
							);
							expect(await store.capacityGroup("device-1")).toMatchObject({
								reservedUnits: 0,
								seq: 2,
							});
							expect(
								(await store.events()).filter(
									(event) => event.type === FleetEventType.CAPACITY_RELEASED,
								),
							).toHaveLength(1);
						} finally {
							await instance.close();
						}
					},
				),
				{ seed: 614452, numRuns: 50 },
			);
		}, 60_000);

		it("deduplicates intake across webhook, pull, and repair", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "webhook-1"));
			await store.intake(demand("1", "pull", "pull-1"));
			const duplicate = await store.intake(demand("1", "repair", "repair-1"));
			expect(duplicate.duplicate).toBe(true);
			expect(duplicate.demand.sourceDeliveryIds).toEqual([
				"pull-1",
				"repair-1",
				"webhook-1",
			]);
			expect(
				(await store.demand(parsedKey("1")))?.sourceDeliveryIds,
			).toHaveLength(3);
		});

		it("allows one active delivery and fence when workers race", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "webhook-1"));
			const reserved = reservation(parsedKey("1"), "delivery", 0);
			await store.reserveCapacity(reserved.input);
			const results = await Promise.allSettled([
				store.claimEffect({
					effectId: reserved.input.effect.id,
					workerId: "worker-1",
					ownerEpoch: 1,
					leaseMs: 60_000,
				}),
				store.claimEffect({
					effectId: reserved.input.effect.id,
					workerId: "worker-2",
					ownerEpoch: 1,
					leaseMs: 60_000,
				}),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const deliveries = await store.deliveries(reserved.input.effect.id);
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]).toMatchObject({ state: "claimed", fence: 1 });
		});

		it("supports unsigned fleet policy, observation, and delivery counters", async () => {
			if (!handle) throw new Error("store not initialized");
			const store = current();
			await store.putOfferAdmission(
				parseOfferAdmission(
					JSON.stringify({
						offerId: "local-offer",
						accountId: "hobo-labs",
						observationHash: OFFER_HASH,
						policyRevision: 0xffffffff,
						state: "active",
					}),
				),
			);
			await store.intake(demand("1", "webhook", "wide-policy", 0xffffffff));
			const reserved = reservation(
				parsedKey("1"),
				"wide-counters",
				0,
				1,
				0xffffffff,
				0xffffffff,
			);
			await store.reserveCapacity(reserved.input);
			await store.observe(observation(0x80000000));
			await store.observe(observation(0xffffffff));
			expect(await store.observationSequence("worker-1")).toBe(0xffffffff);
			await expect(
				store.observe(observation(0x80000000)),
			).rejects.toMatchObject({
				code: FleetRejectionCode.OBSERVATION_SEQUENCE_REGRESSED,
			});
			await handle.setEffectFence(reserved.input.effect.id, 0xfffffffe);
			const delivery = await store.claimEffect({
				effectId: reserved.input.effect.id,
				workerId: "worker-1",
				ownerEpoch: 0xffffffff,
				leaseMs: 60_000,
			});
			expect(delivery).toMatchObject({
				ownerEpoch: 0xffffffff,
				fence: 0xffffffff,
			});
			const fence = {
				effectId: reserved.input.effect.id,
				workerId: "worker-1",
				ownerEpoch: 0xffffffff,
				fence: 0xffffffff,
			};
			await store.markEffectDispatching(fence);
			await store.acknowledgeEffect({ ...fence, outcome: "confirmed" });
			expect(
				(await store.deliveries(reserved.input.effect.id))[0],
			).toMatchObject({ fence: 0xffffffff, state: "acked" });
		});

		it("refuses an exhausted delivery fence without changing the effect", async () => {
			if (!handle) throw new Error("store not initialized");
			const store = current();
			await store.intake(demand("1", "webhook", "exhausted-fence"));
			const reserved = reservation(parsedKey("1"), "exhausted-fence", 0);
			await store.reserveCapacity(reserved.input);
			await handle.setEffectFence(reserved.input.effect.id, 0xffffffff);
			const before = await store.events();
			await expect(
				store.claimEffect({
					effectId: reserved.input.effect.id,
					workerId: "worker-1",
					ownerEpoch: 1,
					leaseMs: 60_000,
				}),
			).rejects.toMatchObject({
				code: FleetRejectionCode.EFFECT_NOT_CLAIMABLE,
			});
			expect(await store.effect(reserved.input.effect.id)).toMatchObject({
				state: "planned",
			});
			expect(await store.deliveries(reserved.input.effect.id)).toHaveLength(0);
			expect(await store.events()).toEqual(before);
		});

		it("rejects stale delivery tokens across generated lease histories", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(fc.integer({ min: 1, max: 3 }), {
						minLength: 2,
						maxLength: 5,
					}),
					async (workers) => {
						const instance = await open();
						try {
							const store = instance.store;
							await seed(store);
							await store.intake(demand("1", "webhook", "generated-delivery"));
							const reserved = reservation(
								parsedKey("1"),
								"generated-delivery",
								0,
							);
							await store.reserveCapacity(reserved.input);
							let prior:
								| { workerId: string; ownerEpoch: number; fence: number }
								| undefined;
							for (const worker of workers) {
								if (prior)
									await instance.expireEffectDelivery(reserved.input.effect.id);
								const delivery = await store.claimEffect({
									effectId: reserved.input.effect.id,
									workerId: `worker-${worker}`,
									ownerEpoch: 1,
									leaseMs: 60_000,
								});
								if (prior) {
									expect(delivery.fence).toBe(prior.fence + 1);
									const stale = {
										effectId: reserved.input.effect.id,
										...prior,
									};
									await expect(
										store.renewEffectDelivery({ ...stale, leaseMs: 60_000 }),
									).rejects.toMatchObject({
										code: FleetRejectionCode.STALE_DELIVERY_FENCE,
									});
									await expect(
										store.acknowledgeEffect({ ...stale, outcome: "confirmed" }),
									).rejects.toMatchObject({
										code: FleetRejectionCode.STALE_DELIVERY_FENCE,
									});
								}
								prior = {
									workerId: delivery.workerId,
									ownerEpoch: delivery.ownerEpoch,
									fence: delivery.fence,
								};
							}
							expect(
								await store.deliveries(reserved.input.effect.id),
							).toHaveLength(workers.length);
						} finally {
							await instance.close();
						}
					},
				),
				{ seed: 614453, numRuns: 25 },
			);
		}, 60_000);

		it("does not reissue a dispatching effect after its delivery expires", async () => {
			if (!handle) throw new Error("store not initialized");
			const store = current();
			await store.intake(demand("1", "webhook", "ambiguous-effect"));
			const reserved = reservation(parsedKey("1"), "ambiguous-effect", 0);
			await store.reserveCapacity(reserved.input);
			const delivery = await store.claimEffect({
				effectId: reserved.input.effect.id,
				workerId: "worker-1",
				ownerEpoch: 1,
				leaseMs: 60_000,
			});
			await store.markEffectDispatching({
				effectId: reserved.input.effect.id,
				workerId: delivery.workerId,
				ownerEpoch: delivery.ownerEpoch,
				fence: delivery.fence,
			});
			await handle.expireEffectDelivery(reserved.input.effect.id);
			const before = await store.events();
			await expect(
				store.claimEffect({
					effectId: reserved.input.effect.id,
					workerId: "worker-2",
					ownerEpoch: 1,
					leaseMs: 60_000,
				}),
			).rejects.toMatchObject({
				code: FleetRejectionCode.EFFECT_NOT_CLAIMABLE,
			});
			expect(await store.deliveries(reserved.input.effect.id)).toHaveLength(1);
			expect(await store.events()).toEqual(before);
		});

		it("does not mutate for stale worker renewal or acknowledgement", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "webhook-1"));
			const reserved = reservation(parsedKey("1"), "stale", 0);
			await store.reserveCapacity(reserved.input);
			const delivery = await store.claimEffect({
				effectId: reserved.input.effect.id,
				workerId: "worker-1",
				ownerEpoch: 1,
				leaseMs: 60_000,
			});
			const stale = {
				effectId: reserved.input.effect.id,
				workerId: "worker-1",
				ownerEpoch: 1,
				fence: delivery.fence + 1,
			};
			await expect(
				store.renewEffectDelivery({ ...stale, leaseMs: 60_000 }),
			).rejects.toMatchObject({
				code: FleetRejectionCode.STALE_DELIVERY_FENCE,
			});
			await expect(
				store.acknowledgeEffect({ ...stale, outcome: "confirmed" }),
			).rejects.toMatchObject({
				code: FleetRejectionCode.STALE_DELIVERY_FENCE,
			});
			expect((await store.effect(reserved.input.effect.id))?.state).toBe(
				"planned",
			);
			expect(
				(await store.deliveries(reserved.input.effect.id))[0]?.expiresAt,
			).toBe(delivery.expiresAt);
		});

		it("rejects observation sequence regression without state change", async () => {
			const store = current();
			await store.observe(observation(2));
			const before = await store.events();
			await expect(store.observe(observation(1))).rejects.toMatchObject({
				code: FleetRejectionCode.OBSERVATION_SEQUENCE_REGRESSED,
			});
			expect(await store.observationSequence("worker-1")).toBe(2);
			expect(await store.events()).toEqual(before);
		});

		it("rejects admission when the capacity sequence changed", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "webhook-1"));
			await store.intake(demand("2", "webhook", "webhook-2"));
			await store.reserveCapacity(
				reservation(parsedKey("1"), "first", 0).input,
			);
			const stale = reservation(parsedKey("2"), "second", 0);
			await expect(store.reserveCapacity(stale.input)).rejects.toMatchObject({
				code: FleetRejectionCode.CAPACITY_CONFLICT,
			});
			expect(await store.runnerSlot(stale.input.slot.id)).toBeUndefined();
			const reevaluated = reservation(parsedKey("2"), "second", 1);
			await expect(
				store.reserveCapacity(reevaluated.input),
			).rejects.toMatchObject({ code: FleetRejectionCode.CAPACITY_EXHAUSTED });
			expect(await store.capacityGroup("device-1")).toMatchObject({
				reservedUnits: 1,
				seq: 1,
			});
		});

		it("rejects an old policy snapshot during admission", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "webhook-1"));
			await store.putOfferAdmission(
				parseOfferAdmission(
					JSON.stringify({
						offerId: "local-offer",
						accountId: "hobo-labs",
						observationHash: OFFER_HASH,
						policyRevision: 2,
						state: "active",
					}),
				),
			);
			const stale = reservation(parsedKey("1"), "policy", 0);
			await expect(store.reserveCapacity(stale.input)).rejects.toMatchObject({
				code: FleetRejectionCode.OFFER_OBSERVATION_CONFLICT,
			});
			expect(await store.capacityGroup("device-1")).toMatchObject({
				reservedUnits: 0,
				seq: 0,
			});
		});

		it("authorizes at most one slot racing for the same actual job", async () => {
			const store = current();
			await store.putCapacityGroup(
				parseCapacityGroup(
					JSON.stringify({
						id: "device-1",
						accountId: "hobo-labs",
						approvedUnits: 2,
						reservedUnits: 0,
						seq: 0,
						state: "active",
					}),
				),
			);
			await store.intake(demand("1", "webhook", "webhook-1"));
			await store.intake(demand("2", "webhook", "webhook-2"));
			const first = reservation(parsedKey("1"), "first-start", 1);
			const second = reservation(parsedKey("2"), "second-start", 2);
			for (const reserved of [first, second]) {
				await store.reserveCapacity(reserved.input);
				await store.transitionRunnerSlot(
					reserved.input.slot.id,
					"reserved",
					"provisioning",
				);
				await store.transitionRunnerSlot(
					reserved.input.slot.id,
					"provisioning",
					"registered",
					`runner-${reserved.input.slot.id}`,
				);
			}
			const attempts = [first, second].map((reserved, index) =>
				parseStartBindingInput({
					slotId: reserved.input.slot.id,
					claimId: `race-claim-${index}`,
					key: githubKey("1"),
					bindingSecret: reserved.bindingSecret,
					assignment: {
						verified: true,
						accountId: "hobo-labs",
						runnerName: reserved.input.slot.runnerName,
						profileId: "trusted-linux-x64",
					},
				}),
			);
			const results = await Promise.allSettled(
				attempts.map((attempt) => store.bindStart(attempt)),
			);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				results.filter((result) => result.status === "rejected"),
			).toHaveLength(1);
			expect(
				(await store.events()).filter(
					(event) => event.type === FleetEventType.EXECUTION_START_AUTHORIZED,
				),
			).toHaveLength(1);
			const winner = results.findIndex(
				(result) => result.status === "fulfilled",
			);
			const winningAttempt = attempts[winner];
			if (!winningAttempt) throw new Error("missing winning attempt");
			expect((await store.bindStart(winningAttempt)).idempotent).toBe(true);
		});

		it("settles duplicate completion and releases capacity once", async () => {
			const store = current();
			await store.intake(demand("1", "webhook", "webhook-1"));
			const reserved = reservation(parsedKey("1"), "complete", 0);
			await store.reserveCapacity(reserved.input);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"reserved",
				"provisioning",
			);
			await store.transitionRunnerSlot(
				reserved.input.slot.id,
				"provisioning",
				"registered",
				"runner-1",
			);
			const binding = parseStartBindingInput({
				slotId: reserved.input.slot.id,
				claimId: "claim-1",
				key: githubKey("1"),
				bindingSecret: reserved.bindingSecret,
				assignment: {
					verified: true,
					accountId: "hobo-labs",
					runnerName: reserved.input.slot.runnerName,
					profileId: "trusted-linux-x64",
				},
			});
			const authorized = await store.bindStart(binding);
			expect(authorized.idempotent).toBe(false);
			expect((await store.bindStart(binding)).idempotent).toBe(true);
			for (const assignment of [
				{ ...binding.assignment, runnerName: "hobo-other-slot" },
				{ ...binding.assignment, profileId: "other-profile" },
			]) {
				await expect(
					store.bindStart(
						parseStartBindingInput({
							...binding,
							key: githubKey("1"),
							assignment,
						}),
					),
				).rejects.toMatchObject({
					code: FleetRejectionCode.ASSIGNMENT_MISMATCH,
				});
			}
			const eventsBeforeRetries = await store.events();
			await fc.assert(
				fc.asyncProperty(
					fc.boolean(),
					fc.boolean(),
					fc.boolean(),
					fc.boolean(),
					async (sameRunner, sameProfile, sameSecret, sameClaim) => {
						const retry = parseStartBindingInput({
							...binding,
							key: githubKey("1"),
							claimId: sameClaim ? binding.claimId : "another-claim",
							bindingSecret: sameSecret
								? binding.bindingSecret
								: "x".repeat(64),
							assignment: {
								...binding.assignment,
								runnerName: sameRunner
									? binding.assignment.runnerName
									: "other-runner",
								profileId: sameProfile
									? binding.assignment.profileId
									: "other-profile",
							},
						});
						const result = store.bindStart(retry);
						if (sameRunner && sameProfile && sameSecret && sameClaim) {
							expect((await result).idempotent).toBe(true);
						} else {
							await expect(result).rejects.toBeInstanceOf(FleetRejection);
						}
					},
				),
				{ seed: 614449, numRuns: 150 },
			);
			expect(await store.events()).toEqual(eventsBeforeRetries);
			const first = await store.completeExecution({
				claimId: "claim-1",
				state: "completed",
				teardownConfirmed: true,
			});
			const second = await store.completeExecution({
				claimId: "claim-1",
				state: "completed",
				teardownConfirmed: true,
			});
			expect(first).toMatchObject({ settled: true, capacityReleased: true });
			expect(second).toMatchObject({ settled: false, capacityReleased: false });
			await expect(store.bindStart(binding)).rejects.toMatchObject({
				code: FleetRejectionCode.EXECUTION_ALREADY_CLAIMED,
			});
			expect(await store.capacityGroup("device-1")).toMatchObject({
				reservedUnits: 0,
				seq: 2,
			});
			expect((await store.runnerSlot(reserved.input.slot.id))?.state).toBe(
				"released",
			);
			const events = await store.events();
			expect(
				events.filter(
					(event) => event.type === FleetEventType.EXECUTION_COMPLETED,
				),
			).toHaveLength(1);
			expect(
				events.filter(
					(event) => event.type === FleetEventType.CAPACITY_RELEASED,
				),
			).toHaveLength(1);
			expect(JSON.stringify(events)).not.toContain(reserved.bindingSecret);
		});
	});
}

let sqliteRoot = "";
beforeAll(() => {
	sqliteRoot = mkdtempSync(join(tmpdir(), "hobo-fleet-v2-contract-"));
});
afterAll(() => {
	rmSync(sqliteRoot, { recursive: true, force: true });
});

storeContract("SQLite", async () => {
	const path = join(sqliteRoot, `${randomUUID()}.sqlite`);
	const store = new SqliteStrictFleetStore(path);
	return {
		store,
		close: async () => store.close(),
		setCapacitySequence: async (sequence) => {
			const database = new DatabaseSync(path);
			try {
				database
					.prepare(
						"UPDATE fleet_v2_capacity_groups SET seq=?,body=json_set(body, '$.seq', ?) WHERE id=?",
					)
					.run(sequence, sequence, "device-1");
			} finally {
				database.close();
			}
		},
		setEffectFence: async (effectId, fence) => {
			const database = new DatabaseSync(path);
			try {
				database
					.prepare("UPDATE fleet_v2_effects SET next_fence=? WHERE id=?")
					.run(fence, effectId);
			} finally {
				database.close();
			}
		},
		expireEffectDelivery: async (effectId) => {
			const database = new DatabaseSync(path);
			try {
				const expired = "2000-01-01T00:00:00.000Z";
				database
					.prepare(
						"UPDATE fleet_v2_deliveries SET expires_at=?,body=json_set(body, '$.expiresAt', ?) WHERE effect_id=? AND state='claimed'",
					)
					.run(expired, expired, effectId);
			} finally {
				database.close();
			}
		},
	};
});

describe("strict fleet v2 state machine", () => {
	it("never returns post-start or uncertain states to runnable states", () => {
		expect(() => transitionCiDemand("satisfied", "eligible")).toThrow(
			FleetRejection,
		);
		expect(() => transitionRunnerSlot("uncertain", "reserved")).toThrow(
			FleetRejection,
		);
		expect(() => transitionRunnerSlot("registered", "reserved")).toThrow(
			FleetRejection,
		);
	});
});
