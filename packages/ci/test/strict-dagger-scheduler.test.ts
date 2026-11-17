import { clone, create, toJsonString } from "@bufbuild/protobuf";
import { stableHash } from "@hobo/dispatcher";
import { afterEach, describe, expect, it } from "vitest";
import {
	AccountSchema,
	ConfigurationSchema,
	OfferSchema,
	PipelineSchema,
	PipelineStepResultSchema,
} from "../src/_generated/ci_pb.js";
import { parsePipeline } from "../src/execution.js";
import {
	type BoundDaggerBackend,
	daggerEndpointHash,
	normalizeDaggerEndpoint,
	parseCapacityGroup,
	parseCiDemand,
	parseControllerIncarnation,
	parseDaggerStartInput,
	parseExecutionProfile,
	parseOfferAdmission,
	SqliteStrictFleetStore,
	StrictDaggerScheduler,
} from "../src/fleet-v2/index.js";
import { LeaseStore } from "../src/store.js";

const NOW = "2026-10-26T12:00:00Z";
const ENDPOINT = "tcp://engine.example:1234";
const HASH = "a".repeat(64);
const stores: { fleet: SqliteStrictFleetStore; leases: LeaseStore }[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.fleet.close();
		store.leases.close();
	}
});

async function setup(
	options: {
		revokeOnOpen?: boolean;
		revokeBudgetOnOpen?: boolean;
		failClose?: boolean;
		disabled?: boolean;
	} = {},
) {
	const fleet = new SqliteStrictFleetStore(":memory:");
	const leases = new LeaseStore(":memory:");
	stores.push({ fleet, leases });
	await fleet.initialize();
	await fleet.createIncarnation(
		parseControllerIncarnation(
			JSON.stringify({
				id: "incarnation-1",
				createdAt: NOW,
				reason: "bootstrap",
			}),
		),
	);
	await fleet.putExecutionProfile(
		parseExecutionProfile(
			JSON.stringify({
				id: "dagger-profile",
				os: "linux",
				architecture: "x64",
				isolation: "operator-engine",
				lifecycle: "persistent-capacity",
				guarantee: "start-fenced",
			}),
		),
	);
	const admission = {
		offerId: "dagger-offer",
		accountId: "tenant",
		observationHash: HASH,
		policyRevision: 1,
	};
	await fleet.putOfferAdmission(
		parseOfferAdmission(JSON.stringify({ ...admission, state: "active" })),
	);
	await fleet.putCapacityGroup(
		parseCapacityGroup(
			JSON.stringify({
				id: "device-1",
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
			id: "build-1",
			accountId: "tenant",
			timeoutSeconds: 30,
			steps: [{ id: "check", argv: ["printf", "done"], cwd: ".", env: {} }],
			artifactPaths: [],
		}),
	);
	const key = {
		daggerPipeline: {
			kind: "dagger-pipeline",
			accountId: "tenant",
			engineId: "dagger",
			pipelineId: pipeline.id,
			pipelineDigest: stableHash(
				JSON.parse(toJsonString(PipelineSchema, pipeline)),
			),
		},
	};
	await fleet.intake(
		parseCiDemand(
			JSON.stringify({
				key,
				state: "observed",
				firstObservedAt: NOW,
				lastObservedAt: NOW,
				policyRevision: 1,
				requiredProfileId: "dagger-profile",
				source: "repair",
				sourceDeliveryIds: ["delivery-1"],
			}),
		),
	);
	const input = parseDaggerStartInput({
		claimId: "claim-1",
		key,
		profileId: "dagger-profile",
		offerId: "dagger-offer",
		capacityGroupId: "device-1",
		capacityCostUnits: 1,
		policyHash: HASH,
		quoteHash: HASH,
		offerObservationHash: HASH,
		engineEndpointHash: daggerEndpointHash(ENDPOINT),
		incarnationId: "incarnation-1",
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
				id: "dagger-offer",
				backend: "dagger",
				provider: "dagger",
				providerAccountId: "dagger-offer",
				enabled: !options.disabled,
				bridgeAcknowledged: true,
				runsOn: "engine",
				freeMinutes: options.revokeBudgetOnOpen ? 0 : 2,
				priceMicrosPerMinute: 1000,
				budgetMicros: 1000000,
				concurrency: 1,
				observedAt: "2026-10-26T00:00:00Z",
				validUntil: "2026-11-01T00:00:00Z",
				sourceUrl: "https://example.test/usage",
			}),
		],
	});
	const calls = { open: 0, run: 0, close: 0 };
	const configuration = create(ConfigurationSchema, { accounts: [account] });
	if (options.revokeBudgetOnOpen) leases.configure(configuration, 0, NOW);
	const backend: BoundDaggerBackend = {
		kind: "dagger",
		endpoint: ENDPOINT,
		capabilities: ["commands", "artifacts", "cancellation"],
		async open() {
			calls.open++;
			if (options.revokeBudgetOnOpen) {
				const revoked = clone(ConfigurationSchema, configuration);
				const current = revoked.accounts[0];
				if (!current) throw new Error("account missing");
				current.budgetMicros = 0;
				leases.configure(revoked, 1, NOW);
			}
			if (options.revokeOnOpen)
				await fleet.putOfferAdmission(
					parseOfferAdmission(
						JSON.stringify({ ...admission, state: "revoked" }),
					),
				);
			return {
				async run(step) {
					calls.run++;
					return create(PipelineStepResultSchema, {
						id: step.id,
						exitCode: 0,
						stdout: "done",
					});
				},
				async artifact() {
					throw new Error("no artifacts requested");
				},
				async close() {
					calls.close++;
					if (options.failClose) throw new Error("stop unconfirmed");
				},
			};
		},
	};
	return {
		fleet,
		leases,
		account,
		pipeline,
		input,
		calls,
		backend,
		scheduler: new StrictDaggerScheduler(
			fleet,
			leases,
			"tenant",
			backend,
			() => NOW,
		),
	};
}

describe("strict Dagger scheduler", () => {
	it("runs a claimed pipeline once and releases confirmed capacity", async () => {
		const h = await setup();
		const results = await Promise.all([
			h.scheduler.execute(h.account, h.pipeline, h.input),
			h.scheduler.execute(h.account, h.pipeline, h.input),
		]);
		expect(results.map((result) => result.kind).sort()).toEqual([
			"existing",
			"finished",
		]);
		const finished = results.find((result) => result.kind === "finished");
		expect(finished?.result.status).toBe("succeeded");
		expect(h.calls).toEqual({ open: 1, run: 1, close: 1 });
		expect((await h.fleet.capacityGroup("device-1"))?.reservedUnits).toBe(0);
		expect((await h.fleet.executionClaimById("claim-1"))?.state).toBe(
			"completed",
		);
	});

	it("does not run commands when an offer is revoked while connecting", async () => {
		const h = await setup({ revokeOnOpen: true });
		const result = await h.scheduler.execute(h.account, h.pipeline, h.input);
		expect(result.kind).toBe("finished");
		if (result.kind !== "finished")
			throw new Error("expected a finished result");
		expect(result.result.status).toBe("failed");
		expect(h.calls).toEqual({ open: 1, run: 0, close: 1 });
		expect((await h.fleet.capacityGroup("device-1"))?.reservedUnits).toBe(0);
	});

	it("rechecks the budget policy after connecting", async () => {
		const h = await setup({ revokeBudgetOnOpen: true });
		const result = await h.scheduler.execute(h.account, h.pipeline, h.input);
		expect(result.kind).toBe("finished");
		if (result.kind !== "finished")
			throw new Error("expected a finished result");
		expect(result.result.status).toBe("failed");
		expect(h.calls).toEqual({ open: 1, run: 0, close: 1 });
		expect((await h.fleet.capacityGroup("device-1"))?.reservedUnits).toBe(0);
	});

	it("releases capacity when an offer is revoked before connecting", async () => {
		const h = await setup();
		const pending = h.scheduler.execute(h.account, h.pipeline, h.input);
		await h.fleet.putOfferAdmission(
			parseOfferAdmission(
				JSON.stringify({
					offerId: "dagger-offer",
					accountId: "tenant",
					observationHash: HASH,
					policyRevision: 1,
					state: "revoked",
				}),
			),
		);
		const result = await pending;
		expect(result.kind).toBe("finished");
		if (result.kind !== "finished")
			throw new Error("expected a finished result");
		expect(result.result.status).toBe("blocked");
		expect(h.calls).toEqual({ open: 0, run: 0, close: 0 });
		expect((await h.fleet.capacityGroup("device-1"))?.reservedUnits).toBe(0);
	});

	it("holds uncertain execution capacity and refuses a second run", async () => {
		const h = await setup({ failClose: true });
		const first = await h.scheduler.execute(h.account, h.pipeline, h.input);
		expect(first.kind).toBe("finished");
		if (first.kind !== "finished")
			throw new Error("expected a finished result");
		expect(first.result.status).toBe("uncertain");
		expect(
			(await h.scheduler.execute(h.account, h.pipeline, h.input)).kind,
		).toBe("existing");
		expect(h.calls).toEqual({ open: 1, run: 1, close: 1 });
		expect((await h.fleet.capacityGroup("device-1"))?.reservedUnits).toBe(1);
	});

	it("releases a claim when no eligible backend can start", async () => {
		const h = await setup({ disabled: true });
		const result = await h.scheduler.execute(h.account, h.pipeline, h.input);
		expect(result.kind).toBe("finished");
		if (result.kind !== "finished")
			throw new Error("expected a finished result");
		expect(result.result.status).toBe("blocked");
		expect(h.calls.open).toBe(0);
		expect((await h.fleet.capacityGroup("device-1"))?.reservedUnits).toBe(0);
	});

	it("rejects a different engine or pipeline before reserving capacity", async () => {
		const h = await setup();
		const other = new StrictDaggerScheduler(
			h.fleet,
			h.leases,
			"tenant",
			{ ...h.backend, endpoint: "tcp://other.example:1234" },
			() => NOW,
		);
		await expect(other.execute(h.account, h.pipeline, h.input)).rejects.toThrow(
			"pipeline does not match",
		);
		const changed = parsePipeline(
			JSON.stringify({
				id: h.pipeline.id,
				accountId: "tenant",
				timeoutSeconds: 30,
				steps: [{ id: "check", argv: ["false"], cwd: ".", env: {} }],
			}),
		);
		await expect(
			h.scheduler.execute(h.account, changed, h.input),
		).rejects.toThrow("pipeline does not match");
		expect((await h.fleet.capacityGroup("device-1"))?.reservedUnits).toBe(0);
	});

	it("rejects credentials and unsupported schemes in engine identities", () => {
		expect(() =>
			normalizeDaggerEndpoint("https://user:secret@engine.example"),
		).toThrow();
		expect(() => normalizeDaggerEndpoint("http://engine.example")).toThrow();
		expect(normalizeDaggerEndpoint("unix:///run/dagger.sock")).toBe(
			"unix:///run/dagger.sock",
		);
	});
});
