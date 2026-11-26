/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

/**
 * The Crossplane adapter's parse boundary, claim projection and in-memory
 * cluster.
 *
 * A Crossplane claim is a request the cluster's controller fulfils
 * asynchronously, so the failures worth guarding are the ones where the
 * adapter reports success before the cluster has actually provisioned: a claim
 * that never went Ready reported as provisioned, or an out-of-band status
 * mutation reported as clean drift. Both look like a working deployment until
 * something tries to connect.
 */
import { describe, expect, it } from "vitest";

import {
	CROSSPLANE_CLAIM_API_VERSION,
	claimFor,
	createCrossplaneIacAdapter,
	createFixtureIacProgram,
	createInMemoryCrossplaneCluster,
	IAC_PROGRAM_API_VERSION,
	outputsToBindings,
	validateIacProgram,
} from "../src/index.js";

function program(overrides: Record<string, unknown> = {}) {
	return { ...createFixtureIacProgram(), ...overrides } as never;
}

function codeOf(error: unknown): string | undefined {
	return (error as { code?: string }).code;
}

function expectRejection(run: () => unknown, code: string): void {
	try {
		run();
	} catch (error) {
		// The code is what a caller branches on: an authoring mistake and a
		// cluster failure need different responses.
		expect(codeOf(error), (error as Error).message).toBe(code);
		return;
	}
	expect.unreachable(`expected a ${code} rejection`);
}

describe("validateIacProgram", () => {
	it("accepts and freezes the fixture program", () => {
		const parsed = validateIacProgram(createFixtureIacProgram());
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(parsed.resources.length).toBeGreaterThan(0);
	});

	it("refuses a non-object, a bad apiVersion and a bad kind", () => {
		expectRejection(() => validateIacProgram(null as never), "invalid-program");
		expectRejection(
			() => validateIacProgram(program({ apiVersion: "v0" })),
			"invalid-api-version",
		);
		expectRejection(
			() => validateIacProgram(program({ kind: "not-a-program" })),
			"invalid-kind",
		);
		expect(IAC_PROGRAM_API_VERSION).toBe("hobo.iac-program/v1");
	});

	it("refuses an empty resource list", () => {
		expectRejection(
			() => validateIacProgram(program({ resources: [] })),
			"empty-program",
		);
	});

	it("refuses a resource with no name and a duplicate name", () => {
		expectRejection(
			() => validateIacProgram(program({ resources: [{}] })),
			"invalid-resource",
		);
		const base = createFixtureIacProgram().resources[0];
		expectRejection(
			() =>
				validateIacProgram(
					program({
						stackOutputs: {},
						resources: [base, structuredClone(base)],
					}),
				),
			"duplicate-resource",
		);
	});
});

describe("claimFor", () => {
	const resource = {
		name: "database",
		type: "hobo:data/postgres",
		inputs: { parameters: { size: "small" } },
		outputs: ["endpoint"],
	};
	const composition = { name: "postgres", labels: {} };

	it("builds a claim carrying the composition reference and parameters", () => {
		const claim = claimFor(resource as never, composition as never);
		expect(claim.name).toBe("database");
		expect(claim.spec.apiVersion).toBe(CROSSPLANE_CLAIM_API_VERSION);
		expect(claim.spec.kind).toBe("CompositeResourceClaim");
		// The composition reference is what tells the cluster *how* to satisfy
		// the claim; a claim with the wrong one provisions the wrong thing.
		expect(claim.spec.compositionRef).toBe("postgres");
		expect(claim.spec.parameters).toEqual({ size: "small" });
		expect(claim.spec.resourceType).toBe("hobo:data/postgres");
	});

	it("hashes the spec so drift is detectable", () => {
		const first = claimFor(resource as never, composition as never);
		const changed = claimFor(
			{ ...resource, inputs: { parameters: { size: "large" } } } as never,
			composition as never,
		);
		// The hash is what a refresh compares against; if it ignored parameters,
		// a resized database would never be detected as drifted.
		expect(changed.specHash).not.toBe(first.specHash);
		expect(claimFor(resource as never, composition as never).specHash).toBe(
			first.specHash,
		);
	});

	it("clones parameters rather than aliasing the caller's", () => {
		const inputs = { parameters: { size: "small" } };
		const claim = claimFor(
			{ ...resource, inputs } as never,
			composition as never,
		);
		inputs.parameters.size = "mutated";
		// A claim is submitted asynchronously; a live reference would let the
		// caller change what gets applied after the fact.
		expect(claim.spec.parameters).toEqual({ size: "small" });
	});

	it("defaults absent parameters to an empty object", () => {
		const claim = claimFor(
			{ ...resource, inputs: {} } as never,
			composition as never,
		);
		expect(claim.spec.parameters).toEqual({});
	});
});

describe("in-memory cluster", () => {
	it("reports the required CRDs as installed by default", () => {
		const cluster = createInMemoryCrossplaneCluster();
		// The CRD probe is the preflight that stops the adapter submitting
		// claims to a cluster with no Crossplane on it — where they would sit
		// unfulfilled forever rather than failing.
		for (const crd of ["CompositeResourceClaim", "Composition"]) {
			expect(cluster.hasCrd(crd), crd).toBe(true);
		}
		expect(cluster.hasCrd("not-a-crd")).toBe(false);
	});

	it("honours an explicit CRD list", () => {
		const cluster = createInMemoryCrossplaneCluster({ installedCrds: [] });
		expect(cluster.hasCrd("CompositeResourceClaim")).toBe(false);
	});

	it("offers the default compositions and copies them out", () => {
		const cluster = createInMemoryCrossplaneCluster();
		const compositions = cluster.compositions();
		expect(compositions.map((c: { name: string }) => c.name).sort()).toEqual([
			"postgres",
			"redis",
		]);
		compositions.push({ name: "injected", labels: {} } as never);
		// Structural copy on the way out: a caller filtering the list must not be
		// able to add a composition the cluster does not have.
		expect(cluster.compositions()).toHaveLength(2);
	});

	it("applies a claim and reads it back Ready", () => {
		const cluster = createInMemoryCrossplaneCluster();
		const claim = claimFor(
			{
				name: "database",
				type: "t",
				inputs: {},
				outputs: ["endpoint"],
			} as never,
			{ name: "postgres", labels: {} } as never,
		);
		const applied = cluster.applyClaim(claim);
		expect(applied.status.phase).toBe("Ready");
		expect(cluster.claimNames()).toEqual(["database"]);
	});

	it("holds a nominated claim in Pending with no outputs", () => {
		const cluster = createInMemoryCrossplaneCluster({
			stuckClaims: ["database"],
		});
		const claim = claimFor(
			{
				name: "database",
				type: "t",
				inputs: {},
				outputs: ["endpoint"],
			} as never,
			{ name: "postgres", labels: {} } as never,
		);
		const applied = cluster.applyClaim(claim);
		// The seam exists so the adapter's timeout path is reachable without a
		// real cluster. Outputs must be cleared too — a Pending claim reporting
		// an endpoint is exactly the lie the adapter must not pass on.
		expect(applied.status.phase).toBe("Pending");
		expect(applied.status.outputs).toEqual({});
		expect(cluster.waitForReady("database", 3)).toBe(false);
	});

	it("waits successfully for a Ready claim and fails for an unknown one", () => {
		const cluster = createInMemoryCrossplaneCluster();
		const claim = claimFor(
			{ name: "cache", type: "t", inputs: {}, outputs: [] } as never,
			{ name: "redis", labels: {} } as never,
		);
		cluster.applyClaim(claim);
		expect(cluster.waitForReady("cache", 3)).toBe(true);
		// False rather than a throw: "not there" and "not ready" are the same
		// answer to the caller, which is going to time out either way.
		expect(cluster.waitForReady("ghost", 3)).toBe(false);
	});

	it("snapshots applied outputs so out-of-band mutation is detectable", () => {
		const cluster = createInMemoryCrossplaneCluster();
		const claim = claimFor(
			{
				name: "database",
				type: "t",
				inputs: {},
				outputs: ["endpoint"],
			} as never,
			{ name: "postgres", labels: {} } as never,
		);
		const applied = cluster.applyClaim(claim);
		// The snapshot is what refresh compares live status against. Without it,
		// a controller that changed an endpoint after apply would go unnoticed
		// and the recorded binding would point at the old one.
		expect(applied.appliedOutputs).toEqual(applied.status.outputs);
	});

	it("deletes a claim", () => {
		const cluster = createInMemoryCrossplaneCluster();
		cluster.applyClaim(
			claimFor(
				{ name: "database", type: "t", inputs: {}, outputs: [] } as never,
				{ name: "postgres", labels: {} } as never,
			),
		);
		cluster.deleteClaim("database");
		expect(cluster.claimNames()).toEqual([]);
		// Deleting twice is a no-op — a destroy retried after a partial failure
		// must not fail on the resources it already removed.
		expect(() => cluster.deleteClaim("database")).not.toThrow();
	});

	it("sorts claim names so two snapshots diff cleanly", () => {
		const cluster = createInMemoryCrossplaneCluster();
		for (const name of ["zeta", "alpha", "mid"]) {
			cluster.applyClaim(
				claimFor(
					{ name, type: "t", inputs: {}, outputs: [] } as never,
					{ name: "postgres", labels: {} } as never,
				),
			);
		}
		expect(cluster.claimNames()).toEqual(["alpha", "mid", "zeta"]);
	});
});

describe("outputsToBindings", () => {
	it("emits the short and reference forms plus stack outputs", () => {
		const bindings = outputsToBindings({
			resources: { database: { outputs: { endpoint: "db.local" } } },
			stackOutputs: { url: "https://example.invalid" },
		} as never);
		expect(bindings["database.endpoint"]).toBe("db.local");
		expect(bindings["${resources.database.outputs.endpoint}"]).toBe("db.local");
		expect(bindings["stack.url"]).toBe("https://example.invalid");
	});

	it("handles absent sections and returns a frozen map", () => {
		expect(outputsToBindings({} as never)).toEqual({});
		expect(Object.isFrozen(outputsToBindings({} as never))).toBe(true);
	});
});

describe("adapter over the in-memory cluster", () => {
	it("previews dirty, applies, refreshes clean and destroys", async () => {
		const adapter = createCrossplaneIacAdapter({
			cluster: createInMemoryCrossplaneCluster(),
		});
		const p = createFixtureIacProgram();

		const preview = await adapter.preview(p);
		expect(preview.kind).toBe("diff");
		expect(preview.dirty).toBe(true);

		const applied = await adapter.apply(p);
		expect(applied.kind).toBe("outputs");
		// Bindings are the point of an apply: the deploy step downstream reads
		// them, so an apply that produced none would deploy a workload with no
		// connection details.
		expect(Object.keys(applied.bindings).length).toBeGreaterThan(0);

		const refresh = await adapter.refresh(p);
		expect(refresh.drifted).toBe(false);

		const destroyed = await adapter.destroy(p);
		expect(destroyed.kind).toBe("outputs");
	});

	it("previews clean once applied", async () => {
		const adapter = createCrossplaneIacAdapter({
			cluster: createInMemoryCrossplaneCluster(),
		});
		const p = createFixtureIacProgram();
		await adapter.apply(p);
		expect((await adapter.preview(p)).dirty).toBe(false);
	});

	it("fails rather than reporting success when a claim never goes Ready", async () => {
		const names = createFixtureIacProgram().resources.map(
			(resource: { name: string }) => resource.name,
		);
		const adapter = createCrossplaneIacAdapter({
			cluster: createInMemoryCrossplaneCluster({ stuckClaims: names }),
		});
		// The failure this whole suite is about: a claim the controller never
		// fulfilled must not be reported as provisioned, because the binding
		// would then point at nothing.
		await expect(adapter.apply(createFixtureIacProgram())).rejects.toThrow();
	});

	it("refuses to operate against a cluster with no Crossplane CRDs", async () => {
		const adapter = createCrossplaneIacAdapter({
			cluster: createInMemoryCrossplaneCluster({ installedCrds: [] }),
		});
		// Preflight, not post-hoc: submitting claims to a cluster with no
		// controller leaves them pending forever rather than failing.
		await expect(adapter.apply(createFixtureIacProgram())).rejects.toThrow();
	});

	it("refuses an invalid program before touching the cluster", async () => {
		const adapter = createCrossplaneIacAdapter({
			cluster: createInMemoryCrossplaneCluster(),
		});
		await expect(adapter.apply({} as never)).rejects.toThrow();
	});
});
