import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@dagger.io/dagger";
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
import { createBoundDaggerBackend, daggerClientPort } from "../src/backend.js";

const port = process.env.DAGGER_SESSION_PORT;
assert.ok(port && /^\d+$/.test(port));
assert.ok(process.env.DAGGER_SESSION_TOKEN);
const endpoint = `tcp://127.0.0.1:${port}`;
const root = await mkdtemp(join(tmpdir(), "hobo-strict-live-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const fleet = new SqliteStrictFleetStore(join(root, "fleet.sqlite"));
const leases = new LeaseStore(join(root, "leases.sqlite"));
const now = new Date().toISOString();
const later = new Date(Date.now() + 86400000).toISOString();
const hash = "a".repeat(64);
const image =
	process.env.HOBO_DAGGER_TEST_IMAGE ??
	"ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8";
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
			id: "live-pipeline",
			accountId: "tenant",
			timeoutSeconds: 90,
			steps: [
				{
					id: "write",
					cwd: ".",
					argv: ["sh", "-c", "printf dagger-live > result.txt; cat result.txt"],
					env: {},
				},
			],
			artifactPaths: ["result.txt"],
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
				sourceDeliveryIds: ["live-delivery"],
			}),
		),
	);
	const input = parseDaggerStartInput({
		claimId: "live-claim",
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
				freeMinutes: 5,
				priceMicrosPerMinute: 1000,
				budgetMicros: 1000000,
				concurrency: 1,
				observedAt: now,
				validUntil: later,
				sourceUrl: "https://example.test/usage",
			}),
		],
	});
	let connections = 0;
	const backend = createBoundDaggerBackend({
		sourceDirectory: workspace,
		image,
		endpoint,
		connect: async (requested, signal) => {
			assert.equal(requested, endpoint);
			signal.throwIfAborted();
			connections++;
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			let publish: (value: {
				client: ReturnType<typeof daggerClientPort>;
				close(): Promise<void>;
			}) => void = () => {};
			let fail: (reason: Error) => void = () => {};
			const ready = new Promise<{
				client: ReturnType<typeof daggerClientPort>;
				close(): Promise<void>;
			}>((resolve, reject) => {
				publish = resolve;
				fail = reject;
			});
			const lifecycle = connect(async (client) => {
				publish({
					client: daggerClientPort(client),
					async close() {
						release();
						await lifecycle;
					},
				});
				await released;
			});
			lifecycle.catch((error) =>
				fail(
					error instanceof Error
						? error
						: new Error("Dagger connection failed"),
				),
			);
			return ready;
		},
	});
	const scheduler = new StrictDaggerScheduler(fleet, leases, "tenant", backend);
	const result = await scheduler.execute(account, pipeline, input);
	assert.equal(result.kind, "finished");
	if (result.kind !== "finished") throw new Error("pipeline did not finish");
	assert.equal(result.result.status, "succeeded", result.result.error);
	assert.equal(result.result.steps[0]?.stdout, "dagger-live");
	assert.equal(
		Buffer.from(result.result.artifacts[0]?.data ?? []).toString(),
		"dagger-live",
	);
	assert.equal(
		(await scheduler.execute(account, pipeline, input)).kind,
		"existing",
	);
	assert.equal(connections, 1);
	assert.equal((await fleet.capacityGroup("device"))?.reservedUnits, 0);
	const events = JSON.stringify(await fleet.events());
	assert.equal(
		events.includes(process.env.DAGGER_SESSION_TOKEN),
		false,
		"session credential appeared in fleet events",
	);
	console.log(
		"strict Dagger real engine: command, artifact, replay and capacity release passed",
	);
} finally {
	fleet.close();
	leases.close();
	await rm(root, { recursive: true, force: true });
}
