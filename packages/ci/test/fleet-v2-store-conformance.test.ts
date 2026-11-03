import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	type CiDemand,
	FleetEventType,
	FleetRejection,
	FleetRejectionCode,
	type ParsedExecutionKey,
	PostgresStrictFleetStore,
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
const POSTGRES_IMAGE =
	"postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b";

function dockerAvailable(): boolean {
	if (process.env.HOBO_FUZZ_DOCKER === "0") return false;
	if (!existsSync("/var/run/docker.sock")) return false;
	return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

type StoreHandle = {
	store: StrictFleetStore;
	close: () => Promise<void>;
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
): CiDemand {
	return parseCiDemand(
		JSON.stringify({
			key: githubKey(jobId),
			state: "observed",
			firstObservedAt: NOW,
			lastObservedAt: NOW,
			policyRevision: 1,
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
			capacityCostUnits: 1,
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
			sequence: 1,
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
			expectedPolicyRevision: 1,
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
	const store = new SqliteStrictFleetStore(
		join(sqliteRoot, `${randomUUID()}.sqlite`),
	);
	return { store, close: async () => store.close() };
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

let container: StartedTestContainer | undefined;
let pool: pg.Pool | undefined;
const externalPostgres = process.env.HOBO_CI_TEST_POSTGRES;
const postgresEnabled =
	!!externalPostgres ||
	!!process.env.TESTCONTAINERS ||
	process.env.HOBO_FLEET_ENROLLMENT_CI === "1";

describe.runIf(postgresEnabled)(
	"PostgreSQL strict fleet v2 contract (Testcontainers)",
	() => {
		beforeAll(async () => {
			let connectionString = externalPostgres;
			if (!connectionString) {
				if (!dockerAvailable()) {
					throw new Error(
						"PostgreSQL store conformance requires Docker (/var/run/docker.sock + docker info) or HOBO_CI_TEST_POSTGRES; fleet-enrollment CI must not skip these cases.",
					);
				}
				const password = randomUUID();
				container = await new GenericContainer(POSTGRES_IMAGE)
					.withEnvironment({
						POSTGRES_DB: "contract",
						POSTGRES_USER: "contract",
						POSTGRES_PASSWORD: password,
					})
					.withWaitStrategy(
						Wait.forLogMessage(
							/database system is ready to accept connections/,
							2,
						),
					)
					.withExposedPorts(5432)
					.start();
				connectionString = `postgresql://contract:${password}@${container.getHost()}:${container.getMappedPort(5432)}/contract`;
			}
			pool = new pg.Pool({ connectionString, max: 8 });
		}, 180_000);
		afterAll(async () => {
			await pool?.end();
			await container?.stop();
		});

		storeContract("PostgreSQL", async () => {
			if (!pool) throw new Error("postgres pool unavailable");
			return {
				store: new PostgresStrictFleetStore(pool, `contract-${randomUUID()}`),
				close: async () => undefined,
			};
		});
	},
);
