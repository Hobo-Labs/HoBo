import { describe, expect, it } from "vitest";

import {
	ADAPTER_ID,
	CrossplaneApplyError,
	CrossplaneProgramError,
	createCrossplaneIacAdapter,
	createFixtureIacProgram,
	createInMemoryCrossplaneCluster,
	runIacBackendConformance,
	validateIacProgram,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

// HOBO-716: the Kubernetes-substrate adapter over the in-memory cluster
// fixture — the full behavior set promoted from the HOBO-188 draft proof plus
// the shared IaC-backend conformance smoke.

describe("validateIacProgram (parse, don't validate)", () => {
	it("freezes the parsed program and requires composition selectors", () => {
		const parsed = validateIacProgram(createFixtureIacProgram());
		expect(Object.isFrozen(parsed)).toBe(true);

		const program = createFixtureIacProgram();
		expect(() =>
			validateIacProgram({
				...program,
				resources: [
					{ name: "naked", type: "hobo:database/postgres", inputs: {} },
				],
			}),
		).toThrowError(CrossplaneProgramError);
	});

	it("rejects non-crossplane providers and unresolved references", () => {
		expect(() =>
			validateIacProgram(createFixtureIacProgram({ provider: "pulumi" })),
		).toThrowError(CrossplaneProgramError);
		expect(() =>
			validateIacProgram(
				createFixtureIacProgram({
					stackOutputs: { broken: "${resources.database.outputs.nope}" },
				}),
			),
		).toThrowError(CrossplaneProgramError);
	});
});

describe("createCrossplaneIacAdapter over the in-memory cluster", () => {
	it("previews desired claims, applies to Ready, refreshes clean, destroys", async () => {
		const adapter = createCrossplaneIacAdapter();
		const program = createFixtureIacProgram();

		const preview = await adapter.preview(program);
		expect(preview.dirty).toBe(true);
		expect(preview.changes.map((c) => c.op)).toEqual(["create", "create"]);

		const outputs = await adapter.apply(program);
		expect(outputs.resources.database.status).toBe("provisioned");
		expect(outputs.stackOutputs.databaseEndpoint).toBe(
			"postgres.database.svc.cluster.local",
		);
		// Outputs from claim status flow into bindings (resource.Provisioned).
		expect(outputs.bindings["database.endpoint"]).toBe(
			"postgres.database.svc.cluster.local",
		);
		expect(outputs.bindings["stack.cacheEndpoint"]).toBe(
			"redis.cache.svc.cluster.local",
		);

		const refresh = await adapter.refresh(program);
		expect(refresh.drifted).toBe(false);

		const destroy = await adapter.destroy(program);
		expect(destroy.resources.database.status).toBe("destroyed");
	});

	it("bounded ready-timeout: a stuck non-Ready claim fails closed", async () => {
		const cluster = createInMemoryCrossplaneCluster({
			stuckClaims: ["database"],
		});
		const adapter = createCrossplaneIacAdapter({
			cluster,
			readyPollLimit: 2,
		});
		await expect(adapter.apply(createFixtureIacProgram())).rejects.toThrowError(
			CrossplaneApplyError,
		);
	});

	it("composition selector matching zero or multiple Compositions fails closed", async () => {
		const none = createCrossplaneIacAdapter({
			cluster: createInMemoryCrossplaneCluster({ compositions: [] }),
		});
		await expect(none.apply(createFixtureIacProgram())).rejects.toSatisfy(
			(error: JsonValue) =>
				error instanceof CrossplaneProgramError &&
				error.code === "composition-not-found",
		);

		const ambiguous = createCrossplaneIacAdapter({
			cluster: createInMemoryCrossplaneCluster({
				compositions: [
					{ name: "pg-a", labels: { port: "database", class: "postgres" } },
					{ name: "pg-b", labels: { port: "database", class: "postgres" } },
					{ name: "redis", labels: { port: "cache", class: "redis" } },
				],
			}),
		});
		await expect(ambiguous.apply(createFixtureIacProgram())).rejects.toSatisfy(
			(error: JsonValue) =>
				error instanceof CrossplaneProgramError &&
				error.code === "composition-ambiguous",
		);
	});

	it("missing Crossplane CRDs fail before apply", async () => {
		const adapter = createCrossplaneIacAdapter({
			cluster: createInMemoryCrossplaneCluster({
				installedCrds: ["Composition"],
			}),
		});
		await expect(adapter.apply(createFixtureIacProgram())).rejects.toSatisfy(
			(error: JsonValue) =>
				error instanceof CrossplaneProgramError && error.code === "crd-missing",
		);
	});

	it("reports drift when a controller mutates claim spec or status out of band", async () => {
		const cluster = createInMemoryCrossplaneCluster();
		const adapter = createCrossplaneIacAdapter({ cluster });
		const program = createFixtureIacProgram();
		await adapter.apply(program);

		cluster.mutateClaim("database", {
			specPatch: { parameters: { storageGiB: 999 } },
		});
		cluster.mutateClaim("cache", {
			statusPatch: { endpoint: "rogue.cache.svc.cluster.local" },
		});

		const refresh = await adapter.refresh(program);
		expect(refresh.drifted).toBe(true);
		const reasons = refresh.resources.map((r) => `${r.name}:${r.reason}`);
		expect(reasons).toContain("database:spec-drift");
		expect(reasons).toContain("cache:status-output-drift");
	});

	it("flags claims that are no longer desired as extra-claim drift", async () => {
		const cluster = createInMemoryCrossplaneCluster();
		const adapter = createCrossplaneIacAdapter({ cluster });
		const both = createFixtureIacProgram();
		await adapter.apply(both);

		const onlyDatabase = createFixtureIacProgram({
			resources: [both.resources[0]],
			stackOutputs: {
				databaseEndpoint: "${resources.database.outputs.endpoint}",
			},
		});
		const refresh = await adapter.refresh(onlyDatabase);
		expect(refresh.drifted).toBe(true);
		expect(
			refresh.resources.some(
				(r) => r.name === "cache" && r.reason === "extra-claim",
			),
		).toBe(true);
	});

	it("passes the shared @hobo/conformance/iac-backend smoke", async () => {
		const result = await runIacBackendConformance({
			adapter: createCrossplaneIacAdapter(),
			program: createFixtureIacProgram(),
		});
		expect(result.passed).toBe(true);
		expect(result.provider).toBe("crossplane");
		expect(result.assertions).toEqual([
			"preview-diff",
			"apply-outputs",
			"binding-outputs",
			"refresh-clean",
			"destroy-clean",
		]);
	});

	it("reports adapter identity and claim model", () => {
		const adapter = createCrossplaneIacAdapter();
		expect(adapter.id).toBe(ADAPTER_ID);
		expect(adapter.model).toBe("composite-resource-claim");
	});
});
