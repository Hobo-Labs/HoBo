import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	parseCapacityGroup,
	parseCiDemand,
	parseControllerIncarnation,
	parseEffect,
	parseExecutionKey,
	parseExecutionProfile,
	parseOfferAdmission,
	parseOutbox,
	parseRunnerSlot,
} from "../src/fleet-v2/parse.js";
import { SqliteStrictFleetStore } from "../src/fleet-v2/sqlite-strict-store.js";

const NOW = "2026-11-03T00:00:00Z";
const HASH = {
	policy: "a".repeat(64),
	offer: "b".repeat(64),
	quote: "c".repeat(64),
};

describe("CI fleet capacity generated properties", () => {
	it("admits at most one job from a shared stale capacity revision", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc
					.integer({ min: 2, max: 12 })
					.chain((capacity) =>
						fc.tuple(
							fc.constant(capacity),
							fc.integer({ min: 2, max: capacity }),
						),
					),
				async ([capacity, jobs]) => {
					const store = new SqliteStrictFleetStore(":memory:");
					try {
						await store.initialize();
						await store.createIncarnation(
							parseControllerIncarnation(
								JSON.stringify({
									id: "incarnation",
									createdAt: NOW,
									reason: "bootstrap",
								}),
							),
						);
						await store.putExecutionProfile(
							parseExecutionProfile(
								JSON.stringify({
									id: "linux",
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
									offerId: "offer",
									accountId: "account",
									observationHash: HASH.offer,
									policyRevision: 1,
									state: "active",
								}),
							),
						);
						await store.putCapacityGroup(
							parseCapacityGroup(
								JSON.stringify({
									id: "capacity",
									accountId: "account",
									approvedUnits: capacity,
									reservedUnits: 0,
									seq: 0,
									state: "active",
								}),
							),
						);
						const reservations = [];
						for (let index = 0; index < jobs; index++) {
							const jobId = `${index + 1}`;
							const key = {
								githubJob: {
									kind: "github-job",
									accountId: "account",
									engineId: "gh-actions",
									installationId: "10",
									repositoryId: "101",
									runId: "900",
									jobId,
									runAttempt: 1,
								},
							};
							const demandKey = parseExecutionKey(JSON.stringify(key));
							const demand = parseCiDemand(
								JSON.stringify({
									key,
									state: "observed",
									firstObservedAt: NOW,
									lastObservedAt: NOW,
									policyRevision: 1,
									requiredProfileId: "linux",
									source: "webhook",
									sourceDeliveryIds: [`webhook-${jobId}`],
								}),
							);
							const slot = parseRunnerSlot(
								JSON.stringify({
									id: `slot-${jobId}`,
									accountId: "account",
									offerId: "offer",
									workerBindingId: `worker-${jobId}`,
									profileId: "linux",
									runnerName: `hobo-runner-${jobId}`,
									state: "reserved",
									capacityGroupId: "capacity",
									capacityCostUnits: 1,
									policyHash: HASH.policy,
									offerObservationHash: HASH.offer,
									quoteHash: HASH.quote,
									bindingSecretHash: createHash("sha256")
										.update(`binding-${jobId}`)
										.digest("hex"),
									incarnationId: "incarnation",
									createdAt: NOW,
								}),
							);
							const effect = parseEffect(
								JSON.stringify({
									id: `effect-${jobId}`,
									subjectType: "runner-slot",
									subjectId: slot.id,
									kind: "github.provision-runner",
									sequence: 1,
									state: "planned",
									idempotencyKey: `provision-${jobId}`,
									externalLocator: slot.runnerName,
									createdAt: NOW,
									providerScope: "github:10:101",
								}),
							);
							const outbox = parseOutbox(
								JSON.stringify({
									id: `outbox-${jobId}`,
									effectId: effect.id,
									state: "pending",
									availableAt: NOW,
									createdAt: NOW,
								}),
							);
							await store.intake(demand);
							reservations.push({
								demandKey,
								slot,
								effect,
								outbox,
								expectedCapacitySeq: 0,
								expectedPolicyRevision: 1,
							});
						}
						const results = await Promise.allSettled(
							reservations.map((input) => store.reserveCapacity(input)),
						);
						expect(
							results.filter((result) => result.status === "fulfilled"),
						).toHaveLength(1);
						expect(await store.capacityGroup("capacity")).toMatchObject({
							reservedUnits: 1,
							seq: 1,
						});
					} finally {
						store.close();
					}
				},
			),
			{ seed: 614441, numRuns: 80 },
		);
	});
});
