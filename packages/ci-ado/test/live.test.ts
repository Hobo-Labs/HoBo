import { afterEach, describe, expect, it } from "vitest";
import {
	adoExpectedPlan,
	adoPrelude,
	adoSuccess,
	adoTarget,
	createAdoPactBroker,
} from "../contracts/fixtures/pact-broker.js";
import {
	adoPlanDigest,
	loadAdoProject,
	parseAdoLiveTarget,
	verifyLiveAdoPipeline,
} from "../src/index.js";

const brokers: ReturnType<typeof createAdoPactBroker>[] = [];
afterEach(() => {
	// A request mismatch cannot masquerade as an expected client rejection.
	for (const broker of brokers.splice(0)) broker.assertComplete();
});
async function fixture(sequence: readonly string[] = adoSuccess) {
	const broker = createAdoPactBroker(sequence);
	brokers.push(broker);
	const { project, pipeline } = await loadAdoProject(
		new URL("../../..", import.meta.url).pathname,
		"packages/ci-ado/examples/ci.json",
	);
	return {
		broker,
		project,
		pipeline,
		run: (fetchImpl = broker.fetch, signal?: AbortSignal) => {
			const options: NonNullable<Parameters<typeof verifyLiveAdoPipeline>[3]> =
				{
					fetch: fetchImpl,
					hostEnvironment: { ADO_TEST_PAT: "fixture-pat" },
					pollMilliseconds: 1,
				};
			if (signal) options.signal = signal;
			return verifyLiveAdoPipeline(
				parseAdoLiveTarget(JSON.stringify(adoTarget)),
				project,
				pipeline,
				options,
			);
		},
	};
}

describe("Pact-brokered Azure acceptance connections", () => {
	it("consumes pinned pool/revision/preview/run/status/timeline/artifact contracts", async () => {
		const f = await fixture();
		expect(adoPlanDigest(f.project, f.pipeline)).toBe(adoExpectedPlan);
		await expect(f.run()).resolves.toMatchObject({
			runId: 42,
			result: "succeeded",
			pool: "hobo-local",
			sourceVersion: adoTarget.sourceVersion,
			artifactNames: ["hobo-producer-1"],
		});
		expect(f.broker.served).toEqual(adoSuccess);
	});
	it.each([
		"reject hosted pool",
		"reject unconfirmed pool",
		"reject malformed pool response",
		"deny unauthorized pool read",
	])("brokers %s before allocating a run", async (interaction) => {
		const f = await fixture([interaction]);
		await expect(f.run()).rejects.toThrow();
		expect(f.broker.calls).toHaveLength(1);
	});
	it("brokers Azure's unexpanded Bash shortcut preview", async () => {
		const f = await fixture([
			...adoPrelude.slice(0, 2),
			"preview shortcut pipeline",
			...adoSuccess.slice(3),
		]);
		await expect(f.run()).resolves.toMatchObject({ runId: 42 });
	});
	it.each([
		"reject hosted preview",
		"reject stale preview",
		"reject extra preview job",
	])("brokers %s without queueing", async (interaction) => {
		const f = await fixture([...adoPrelude.slice(0, 2), interaction]);
		await expect(f.run()).rejects.toThrow();
		expect(f.broker.calls).toHaveLength(3);
	});
	it("sanitizes malformed vendor values without echoing credentials", async () => {
		const f = await fixture(["reject malformed pool response"]);
		await expect(f.run()).rejects.toThrow(/^invalid Azure REST response$/);
	});
	it("requires successful native task evidence", async () => {
		const f = await fixture([
			...adoPrelude,
			"observe successful pipeline",
			"reject incomplete timeline",
		]);
		await expect(f.run()).rejects.toThrow(/acceptance step/);
	});
	it("requires a retained native Pipeline Artifact", async () => {
		const f = await fixture([
			...adoPrelude,
			"observe successful pipeline",
			"inspect native pipeline timeline",
			"reject missing artifact",
		]);
		await expect(f.run()).rejects.toThrow(/retain.*Pipeline Artifact/);
	});
	it("preserves the provider's failed run status", async () => {
		const f = await fixture([...adoPrelude, "observe failed pipeline"]);
		await expect(f.run()).rejects.toThrow(/did not succeed/);
	});
	it.each([
		"observe wrong source",
		"observe wrong pool",
	])("brokers cancellation and reconciliation after %s", async (interaction) => {
		const f = await fixture([
			...adoPrelude,
			interaction,
			"cancel unfinished pipeline",
			"observe cancelled pipeline",
		]);
		await expect(f.run()).rejects.toThrow(/provenance/);
	});
	it("brokers cancellation and confirms terminal state on interruption", async () => {
		const f = await fixture([
			...adoPrelude,
			"observe running pipeline",
			"cancel unfinished pipeline",
			"observe cancelled pipeline",
		]);
		const stop = new AbortController();
		const interrupted: typeof fetch = async (input, init) => {
			const response = await f.broker.fetch(input, init);
			if (f.broker.served.at(-1) === "observe running pipeline") stop.abort();
			return response;
		};
		await expect(f.run(interrupted, stop.signal)).rejects.toThrow();
	});
	it("reports cancellation that Azure does not acknowledge", async () => {
		const f = await fixture([
			...adoPrelude,
			"observe wrong source",
			"deny cancellation",
		]);
		await expect(f.run()).rejects.toThrow(
			/cancellation could not be confirmed/,
		);
	});
	it("never retries an ambiguous queue POST", async () => {
		const f = await fixture(adoPrelude);
		const disconnected: typeof fetch = async (input, init) => {
			const response = await f.broker.fetch(input, init);
			if (f.broker.served.at(-1) === "queue pinned pipeline once")
				throw new Error("modelled response loss after accepted POST");
			return response;
		};
		await expect(f.run(disconnected)).rejects.toThrow(/no automatic retry/);
		expect(
			f.broker.served.filter((name) => name === "queue pinned pipeline once"),
		).toHaveLength(1);
	});
	it("requires configured authentication before broker requests", async () => {
		const f = await fixture([]);
		await expect(
			verifyLiveAdoPipeline(
				parseAdoLiveTarget(JSON.stringify(adoTarget)),
				f.project,
				f.pipeline,
				{ fetch: f.broker.fetch, hostEnvironment: {} },
			),
		).rejects.toThrow(/authentication is not configured/);
	});
	it.each([
		{ organizationUrl: "https://dev.azure.com.attacker.test/org" },
		{ organizationUrl: "http://dev.azure.com/org" },
		{ sourceVersion: "main" },
		{ tokenEnv: "BAD-NAME" },
		{ timeoutSeconds: 0 },
		{ project: "../other" },
	])("rejects unsafe target %j before opening a connection", (fields) => {
		expect(() =>
			parseAdoLiveTarget(JSON.stringify({ ...adoTarget, ...fields })),
		).toThrow();
	});
});
