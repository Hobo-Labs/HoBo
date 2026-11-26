import { describe, expect, it } from "vitest";

import {
	type CapabilityProfileDescriptor,
	CapabilityProfileError,
	createCapabilityProfileRegistry,
	ProfileIdError,
	parseProfileId,
	STANDARD_CAPABILITY_PROFILES,
} from "../src/index.js";

const standard = () =>
	createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);

function stub(
	id: string,
	primitive: CapabilityProfileDescriptor["primitive"],
	refines: readonly string[] = [],
): CapabilityProfileDescriptor {
	return {
		schemaVersion: "hobo.capability-profile/v1",
		id,
		primitive,
		displayName: id,
		description: id,
		refines,
		requirementSchemaRef: id,
		conformanceSuiteRef: id,
		features: [],
		guarantees: [],
		maturity: "experimental",
		sourceRefs: [
			{ url: "https://example.invalid/spec", checkedAt: "2026-08-08" },
		],
	};
}

describe("profile ids", () => {
	it("parses a canonical id", () => {
		const parsed = parseProfileId("data.postgres/v1");
		expect(parsed.primitive).toBe("data");
		expect(parsed.major).toBe(1);
		expect(parsed.path).toEqual(["data", "postgres"]);
	});

	it("registers durable-object journal refinements under kv", () => {
		const registry = standard();
		for (const id of [
			"kv.durable-object/v1",
			"kv.durable-object.event-journal/v1",
			"kv.durable-object.durable-inbox/v1",
			"kv.durable-object.transactional-outbox/v1",
			"kv.durable-object.exportable-state/v1",
		] as const) {
			expect(parseProfileId(id).primitive).toBe("kv");
			expect(registry.get(id)?.id).toBe(id);
		}
		expect(registry.closureOf("kv.durable-object.durable-inbox/v1")).toEqual(
			expect.arrayContaining([
				"kv.key-value/v1",
				"kv.durable-object/v1",
				"kv.durable-object.event-journal/v1",
			]),
		);
	});

	it("maps the realtime family onto the webhook primitive", () => {
		expect(parseProfileId("realtime.websocket/v1").primitive).toBe("webhook");
	});

	it.each([
		["Data.Postgres/v1", "uppercase is not canonicalized silently"],
		["data.postgres", "missing version"],
		["data.postgres/v0", "major must be >= 1"],
		["postgres/v1", "missing primitive family"],
		["fungus.thing/v1", "unknown primitive family"],
		["data.post gres/v1", "invalid segment"],
	])("rejects %s (%s)", (input) => {
		expect(() => parseProfileId(input)).toThrow(ProfileIdError);
	});
});

describe("registry construction", () => {
	it("loads the standard catalog", () => {
		const registry = standard();
		expect(registry.list().length).toBeGreaterThan(30);
		expect(registry.has("data.postgres/v1")).toBe(true);
	});

	it("produces a stable digest independent of registration order", () => {
		const forward = createCapabilityProfileRegistry(
			STANDARD_CAPABILITY_PROFILES,
		);
		const reversed = createCapabilityProfileRegistry(
			[...STANDARD_CAPABILITY_PROFILES].reverse(),
		);
		expect(reversed.digest).toBe(forward.digest);
	});

	it("changes the digest when a selection-relevant fact changes", () => {
		const mutated = STANDARD_CAPABILITY_PROFILES.map((profile) =>
			profile.id === "data.postgres/v1"
				? { ...profile, conformanceSuiteRef: "conformance.changed" }
				: profile,
		);
		expect(createCapabilityProfileRegistry(mutated).digest).not.toBe(
			standard().digest,
		);
	});

	it("rejects a refinement cycle", () => {
		expect(() =>
			createCapabilityProfileRegistry([
				stub("data.alpha/v1", "data", ["data.beta/v1"]),
				stub("data.beta/v1", "data", ["data.alpha/v1"]),
			]),
		).toThrow(/refinement cycle/u);
	});

	it("rejects a self-refinement", () => {
		expect(() =>
			createCapabilityProfileRegistry([
				stub("data.loop/v1", "data", ["data.loop/v1"]),
			]),
		).toThrow(CapabilityProfileError);
	});

	it("rejects refining an unregistered profile", () => {
		expect(() =>
			createCapabilityProfileRegistry([
				stub("data.child/v1", "data", ["data.ghost/v1"]),
			]),
		).toThrow(/unregistered profile/u);
	});

	it("rejects refining across primitives", () => {
		expect(() =>
			createCapabilityProfileRegistry([
				stub("kv.base/v1", "kv"),
				stub("data.child/v1", "data", ["kv.base/v1"]),
			]),
		).toThrow(/cannot refine/u);
	});

	it("rejects duplicate ids", () => {
		expect(() =>
			createCapabilityProfileRegistry([
				stub("data.dup/v1", "data"),
				stub("data.dup/v1", "data"),
			]),
		).toThrow(/duplicate/u);
	});

	it("requires evidence sources with ISO dates", () => {
		const bad = { ...stub("data.x/v1", "data"), sourceRefs: [] };
		expect(() => createCapabilityProfileRegistry([bad])).toThrow(
			/evidence source/u,
		);
	});
});

describe("refinement satisfaction", () => {
	it("satisfies ancestors but never descendants", () => {
		const registry = standard();
		expect(registry.satisfies("data.postgres/v1", "data.relational/v1")).toBe(
			true,
		);
		expect(registry.satisfies("data.relational/v1", "data.postgres/v1")).toBe(
			false,
		);
	});

	it("keeps sqlite and postgres siblings, not substitutes", () => {
		const registry = standard();
		expect(registry.satisfies("data.sqlite/v1", "data.relational/v1")).toBe(
			true,
		);
		expect(registry.satisfies("data.sqlite/v1", "data.postgres/v1")).toBe(
			false,
		);
		expect(registry.satisfies("data.postgres/v1", "data.sqlite/v1")).toBe(
			false,
		);
	});

	it("treats convex as a document backend, not a SQL one", () => {
		const registry = standard();
		expect(registry.satisfies("data.convex/v1", "data.document/v1")).toBe(true);
		expect(registry.satisfies("data.convex/v1", "data.postgres/v1")).toBe(
			false,
		);
		expect(registry.satisfies("data.convex/v1", "data.relational/v1")).toBe(
			false,
		);
	});

	it("chains valkey through redis-compatible to key-value", () => {
		const registry = standard();
		expect(registry.satisfies("kv.valkey/v1", "kv.key-value/v1")).toBe(true);
		expect(registry.closureOf("kv.valkey/v1")).toEqual([
			"kv.key-value/v1",
			"kv.redis-compatible/v1",
			"kv.valkey/v1",
		]);
	});

	it("never lets a redis-compatible store imply queue or topic", () => {
		const registry = standard();
		expect(
			registry.satisfies("kv.redis-compatible/v1", "queue.at-least-once/v1"),
		).toBe(false);
		expect(
			registry.satisfies("kv.redis-compatible/v1", "topic.pubsub/v1"),
		).toBe(false);
	});

	it("requires postgres alongside pgvector rather than implying it", () => {
		const registry = standard();
		const pgvector = registry.require("data.vector.pgvector/v1");
		expect(pgvector.requires).toContain("data.postgres/v1");
		expect(
			registry.satisfies("data.vector.pgvector/v1", "data.vector/v1"),
		).toBe(true);
		expect(
			registry.satisfies("data.vector.pgvector/v1", "data.postgres/v1"),
		).toBe(false);
	});

	it("inherits guarantee keys through refinement", () => {
		const registry = standard();
		expect(registry.guaranteeKeys("data.postgres/v1")).toEqual(
			expect.arrayContaining([
				"transactions",
				"constraints",
				"postgresWireProtocol",
			]),
		);
	});

	it("routes websocket through the realtime parent", () => {
		const registry = standard();
		expect(
			registry.satisfies("realtime.websocket/v1", "webhook.realtime/v1"),
		).toBe(true);
		expect(registry.satisfies("realtime.sse/v1", "realtime.websocket/v1")).toBe(
			false,
		);
	});
});
