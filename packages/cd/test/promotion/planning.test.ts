// The planning resolver over the real `@hobo/cloud` planner (the same path
// as `yard-client.ts` `pureplan`): I1 across two providers, exact diffs,
// fail-closed declaration identity, teardown and departure.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
	createRegistryFromProviders,
	type RegistrableProvider,
} from "@hobo/cloud";
import { beforeAll, describe, expect, it } from "vitest";
import { ChangeKind } from "../../src/_generated/cd_pb.js";
import {
	type CampPlanning,
	createPlanningResolver,
	type Declaration,
	PLANNING_REASON,
} from "../../src/adapters/planning.js";
import { previewCampIdFor } from "../../src/promotion/index.js";
import { digestOf } from "../../src/promotion/journal.js";
import { FakeDesired, FakeFreight } from "./doubles.js";
import { camp, context, MemoryEventStore, T0, TENANT } from "./store.js";

// The declaration parser lives in @hobo/bindles, which @hobo/cd does not
// depend on; the test loads it through @hobo/cloud's own resolution.
let parseManifest: (raw: unknown) => Declaration;
beforeAll(async () => {
	const cloudEntry = fileURLToPath(import.meta.resolve("@hobo/cloud"));
	const bindles = await import(
		createRequire(cloudEntry).resolve("@hobo/bindles")
	);
	parseManifest = bindles.parseManifest;
});

function provider(id: string, region: string): RegistrableProvider {
	return {
		id,
		regions: [region],
		capabilities: ["compute", "kv"].map((port) => ({
			port,
			satisfies: () => ({ kind: "full" }),
			estimateCost: () => ({
				sku: `${id}-${port}`,
				unit: "hour",
				marginalPrice: "0",
			}),
		})),
		capabilityManifest: () => ({
			providerId: id,
			published: {},
			capabilities: {
				capabilities: [
					{ port: "compute", features: ["http"] },
					{ port: "kv", features: [] },
				],
			},
			cost: { facts: [] },
		}),
	};
}

const RAW = (image: string) => ({
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasm", version: "1" },
	resources: {
		app: {
			type: "component.v1",
			image,
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions"],
		},
		sessions: { type: "data.v1", port: "kv" },
	},
});

function setup(camps: Record<string, CampPlanning>) {
	const desired = new FakeDesired();
	const freights = new FakeFreight();
	const declarations = new Map<string, Declaration>();
	const resolver = createPlanningResolver({
		store: new MemoryEventStore(),
		tenant: TENANT,
		now: () => T0,
		desired,
		registry: createRegistryFromProviders([
			provider("alpha", "us"),
			provider("beta", "eu"),
		]),
		declaration: async (freight) => declarations.get(freight.freightId),
		camp: async (campId) => camps[campId],
	});
	const addFreight = (id: string, image: string) => {
		const declaration = parseManifest(RAW(image));
		declarations.set(id, declaration);
		return freights.add(id, { declarationHash: digestOf(declaration) });
	};
	return { desired, resolver, addFreight, declarations };
}

/** A Yard pins each resource to its provider through placement selectors. */
function pinned(environment: string, providerId: string): CampPlanning {
	const criteria = {
		selectors: [{ key: "provider", op: "eq" as const, values: [providerId] }],
		affinities: [],
	};
	return {
		environment,
		config: { placement: { app: criteria, sessions: criteria } },
	};
}

const CAMPS: Record<string, CampPlanning> = {
	"us-1": pinned("prod-us", "alpha"),
	"eu-1": pinned("prod-eu", "beta"),
};

describe("planning resolver (planning.ts)", () => {
	it("I1 across two providers: one declaration, Matching per Camp, provider difference as infrastructure_diff", async () => {
		const s = setup(CAMPS);
		const freight = s.addFreight(
			"f1",
			"oci://registry.example/app@sha256:aaaa",
		);
		const us = await s.resolver.resolve(
			{ freight, campId: camp("us-1"), intent: "promote" },
			context(() => T0),
		);
		expect(us.ok).toBe(true);
		if (!us.ok) return;
		s.desired.seed("us-1", "f1", us.value.resolved);
		const eu = await s.resolver.resolve(
			{
				freight,
				campId: camp("eu-1"),
				intent: "promote",
				sourceCampId: camp("us-1"),
			},
			context(() => T0),
		);
		expect(eu.ok).toBe(true);
		if (!eu.ok) return;
		expect(us.value.resolved.matches.map((m) => m.providerId).sort()).toEqual([
			"alpha",
			"alpha",
		]);
		expect(eu.value.resolved.matches.map((m) => m.providerId).sort()).toEqual([
			"beta",
			"beta",
		]);
		// Promote, never rebuild: identical resource graph and ports, only the Matching differs.
		expect(
			eu.value.resolved.plan.resources.map((r) => [r.name, r.port]),
		).toEqual(us.value.resolved.plan.resources.map((r) => [r.name, r.port]));
		expect(
			eu.value.delta.infrastructureDiff.map((c) => [
				c.resource,
				c.kind,
				c.provider,
			]),
		).toEqual([
			["app", ChangeKind.UPDATE, "beta"],
			["sessions", ChangeKind.UPDATE, "beta"],
		]);
		expect(eu.value.delta.changes.map((c) => [c.resource, c.kind])).toEqual([
			["app", ChangeKind.ADD],
			["sessions", ChangeKind.ADD],
		]);
		expect(eu.value.delta.freightId).toBe("f1");
		expect(eu.value.resolved.gatekeeper.gatekeeperDecisionId).toMatch(
			/^pending:sha256:/,
		);
	});

	it("the diff against the base Set is exact: only the resource whose node changed", async () => {
		const s = setup(CAMPS);
		const f1 = s.addFreight("f1", "oci://registry.example/app@sha256:aaaa");
		const f2 = s.addFreight("f2", "oci://registry.example/app@sha256:bbbb");
		const first = await s.resolver.resolve(
			{ freight: f1, campId: camp("us-1"), intent: "promote" },
			context(() => T0),
		);
		if (!first.ok) throw new Error("expected plan");
		s.desired.seed("us-1", "f1", first.value.resolved);
		const second = await s.resolver.resolve(
			{ freight: f2, campId: camp("us-1"), intent: "promote" },
			context(() => T0),
		);
		if (!second.ok) throw new Error("expected plan");
		expect(second.value.delta.changes.map((c) => [c.resource, c.kind])).toEqual(
			[],
		);
		expect(second.value.delta.baseSetId).toBe("set_1");
		// Same plan graph: a re-resolve is deterministic (same Delta id).
		const again = await s.resolver.resolve(
			{ freight: f2, campId: camp("us-1"), intent: "promote" },
			context(() => T0),
		);
		expect(again.ok && again.value.delta.deltaId).toBe(
			second.value.delta.deltaId,
		);
	});

	it("fails closed when the declaration is missing or does not hash to the Freight's", async () => {
		const s = setup(CAMPS);
		const freight = s.addFreight(
			"f1",
			"oci://registry.example/app@sha256:aaaa",
		);
		s.declarations.set(
			"f1",
			parseManifest(RAW("oci://registry.example/app@sha256:tampered")),
		);
		const mismatch = await s.resolver.resolve(
			{ freight, campId: camp("us-1"), intent: "promote" },
			context(() => T0),
		);
		expect(mismatch.ok).toBe(false);
		if (!mismatch.ok)
			expect(mismatch.reasons[0]?.code).toBe(
				PLANNING_REASON.declarationMismatch,
			);
		s.declarations.delete("f1");
		const missing = await s.resolver.resolve(
			{ freight, campId: camp("us-1"), intent: "promote" },
			context(() => T0),
		);
		if (!missing.ok)
			expect(missing.reasons[0]?.code).toBe(PLANNING_REASON.declarationMissing);
		const unknown = await s.resolver.resolve(
			{ freight, campId: camp("mars-1"), intent: "promote" },
			context(() => T0),
		);
		if (!unknown.ok)
			expect(unknown.reasons[0]?.code).toBe(PLANNING_REASON.campUnknown);
	});

	it("refuses a Camp Matching cannot satisfy", async () => {
		const s = setup({ "ap-1": pinned("prod-ap", "gamma") });
		const freight = s.addFreight(
			"f1",
			"oci://registry.example/app@sha256:aaaa",
		);
		const result = await s.resolver.resolve(
			{ freight, campId: camp("ap-1"), intent: "promote" },
			context(() => T0),
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reasons[0]?.code).toBe(PLANNING_REASON.planRejected);
	});

	it("plans a preview Camp with its source Camp's inputs", async () => {
		const s = setup(CAMPS);
		const freight = s.addFreight(
			"f1",
			"oci://registry.example/app@sha256:aaaa",
		);
		const base = await s.resolver.resolve(
			{ freight, campId: camp("us-1"), intent: "promote" },
			context(() => T0),
		);
		if (!base.ok) throw new Error("expected plan");
		s.desired.seed("us-1", "f1", base.value.resolved);
		const preview = previewCampIdFor(TENANT, "us-1", "pr-7");
		const result = await s.resolver.resolve(
			{
				freight,
				campId: preview,
				intent: "preview",
				sourceCampId: camp("us-1"),
			},
			context(() => T0),
		);
		expect(result.ok && result.value.resolved.environment).toBe(
			"prod-us-preview",
		);
		expect(result.ok && result.value.delta.infrastructureDiff).toEqual([]);
	});

	it("down removes everything; depart keeps data resources (ORPHAN_DATA)", async () => {
		const s = setup(CAMPS);
		const freight = s.addFreight(
			"f1",
			"oci://registry.example/app@sha256:aaaa",
		);
		const first = await s.resolver.resolve(
			{ freight, campId: camp("us-1"), intent: "promote" },
			context(() => T0),
		);
		if (!first.ok) throw new Error("expected plan");
		s.desired.seed("us-1", "f1", first.value.resolved);
		const down = await s.resolver.resolve(
			{ freight, campId: camp("us-1"), intent: "down" },
			context(() => T0),
		);
		expect(
			down.ok && down.value.delta.changes.map((c) => [c.resource, c.kind]),
		).toEqual([
			["app", ChangeKind.REMOVE],
			["sessions", ChangeKind.REMOVE],
		]);
		const depart = await s.resolver.resolve(
			{ freight, campId: camp("us-1"), intent: "depart" },
			context(() => T0),
		);
		expect(
			depart.ok && depart.value.resolved.plan.resources.map((r) => r.name),
		).toEqual(["sessions"]);
	});
});
