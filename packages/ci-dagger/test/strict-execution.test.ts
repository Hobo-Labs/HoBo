import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AccountSchema, OfferSchema, parsePipeline } from "@hobo/ci";
import {
	daggerEndpointHash,
	daggerPipelineDigest,
	parseCapacityGroup,
	parseCiDemand,
	parseControllerIncarnation,
	parseDaggerStartInput,
	parseExecutionProfile,
	parseOfferAdmission,
	SqliteStrictFleetStore,
	StrictDaggerScheduler,
} from "@hobo/ci/fleet-v2";
import { LeaseStore } from "@hobo/ci/store";
import { expect, it } from "vitest";
import { createBoundDaggerBackend } from "../src/backend.js";
import { createLocalDaggerConnection } from "./fixtures/local-engine.js";

it("runs real commands through the bound Dagger port once under a durable claim", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-strict-dagger-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const fleet = new SqliteStrictFleetStore(join(root, "fleet.sqlite"));
	const leases = new LeaseStore(join(root, "leases.sqlite"));
	const now = "2026-10-26T12:00:00Z";
	const hash = "a".repeat(64);
	const endpoint = "unix:///run/dagger-engine.sock";
	let connections = 0;
	try {
		await fleet.initialize();
		await fleet.createIncarnation(
			parseControllerIncarnation(
				JSON.stringify({
					id: "incarnation",
					createdAt: now,
					reason: "bootstrap",
				}),
			),
		);
		await fleet.putExecutionProfile(
			parseExecutionProfile(
				JSON.stringify({
					id: "operator-engine",
					os: "linux",
					architecture: "x64",
					isolation: "operator-engine",
					lifecycle: "persistent-capacity",
					guarantee: "start-fenced",
				}),
			),
		);
		await fleet.putOfferAdmission(
			parseOfferAdmission(
				JSON.stringify({
					offerId: "dagger",
					accountId: "tenant",
					observationHash: hash,
					policyRevision: 1,
					state: "active",
				}),
			),
		);
		await fleet.putCapacityGroup(
			parseCapacityGroup(
				JSON.stringify({
					id: "device",
					accountId: "tenant",
					approvedUnits: 1,
					reservedUnits: 0,
					seq: 0,
					state: "active",
				}),
			),
		);
		const pipeline = parsePipeline(
			JSON.stringify({
				id: "pipeline",
				accountId: "tenant",
				timeoutSeconds: 30,
				steps: [
					{
						id: "write",
						cwd: ".",
						argv: [
							process.execPath,
							"-e",
							"require('fs').writeFileSync('artifact.bin','proof');console.log('done')",
						],
						env: {},
					},
				],
				artifactPaths: ["artifact.bin"],
			}),
		);
		const key = {
			daggerPipeline: {
				kind: "dagger-pipeline",
				accountId: "tenant",
				engineId: "dagger",
				pipelineId: pipeline.id,
				pipelineDigest: daggerPipelineDigest(pipeline),
			},
		};
		await fleet.intake(
			parseCiDemand(
				JSON.stringify({
					key,
					state: "observed",
					firstObservedAt: now,
					lastObservedAt: now,
					policyRevision: 1,
					requiredProfileId: "operator-engine",
					source: "repair",
					sourceDeliveryIds: ["delivery"],
				}),
			),
		);
		const input = parseDaggerStartInput({
			claimId: "claim",
			key,
			profileId: "operator-engine",
			offerId: "dagger",
			capacityGroupId: "device",
			capacityCostUnits: 1,
			policyHash: hash,
			quoteHash: hash,
			offerObservationHash: hash,
			engineEndpointHash: daggerEndpointHash(endpoint),
			incarnationId: "incarnation",
			expectedCapacitySeq: 0,
			expectedPolicyRevision: 1,
		});
		const account = create(AccountSchema, {
			id: "tenant",
			budgetMicros: 1000000,
			maxRuntimeMinutes: 9,
			startupMinutes: 1,
			offers: [
				create(OfferSchema, {
					id: "dagger",
					backend: "dagger",
					provider: "dagger",
					providerAccountId: "dagger",
					enabled: true,
					bridgeAcknowledged: true,
					runsOn: "engine",
					freeMinutes: 2,
					priceMicrosPerMinute: 1000,
					budgetMicros: 1000000,
					concurrency: 1,
					observedAt: "2026-10-26T00:00:00Z",
					validUntil: "2026-11-01T00:00:00Z",
					sourceUrl: "https://example.test/usage",
				}),
			],
		});
		const backend = createBoundDaggerBackend({
			sourceDirectory: workspace,
			image: `fixture/image@sha256:${hash}`,
			endpoint,
			connect: async (requested) => {
				expect(requested).toBe(endpoint);
				connections++;
				return createLocalDaggerConnection(workspace);
			},
		});
		const scheduler = new StrictDaggerScheduler(
			fleet,
			leases,
			"tenant",
			backend,
			() => now,
		);
		const result = await scheduler.execute(account, pipeline, input);
		expect(result.kind).toBe("finished");
		if (result.kind !== "finished")
			throw new Error("expected a finished result");
		expect(result.result.status).toBe("succeeded");
		expect(result.result.steps[0]?.stdout).toBe("done\n");
		expect(result.result.artifacts[0]?.data).toEqual(
			Uint8Array.from(Buffer.from("proof")),
		);
		expect((await scheduler.execute(account, pipeline, input)).kind).toBe(
			"existing",
		);
		expect(connections).toBe(1);
		expect((await fleet.capacityGroup("device"))?.reservedUnits).toBe(0);
	} finally {
		fleet.close();
		leases.close();
		await rm(root, { recursive: true, force: true });
	}
});
