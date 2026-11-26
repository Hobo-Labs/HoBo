import { describe, expect, it } from "vitest";

import {
	LOCALHOST_PROVIDER_ID,
	LOCALHOST_YARD_NAME,
	type LocalhostCapabilityObservation,
	seedLocalhostYard,
	TOPOLOGY_CONTRACT_VERSION,
	YARD_BINDING_CONTRACT,
	YARD_BINDING_PROFILE_PATTERN,
	yard,
	yardToContract,
} from "../src/index.js";

const NODE: LocalhostCapabilityObservation = {
	capabilityId: "capability:runtime:node",
	present: true,
};
const SQLITE: LocalhostCapabilityObservation = {
	capabilityId: "capability:toolchain:sqlite",
	present: true,
};
const FULL_HOST: readonly LocalhostCapabilityObservation[] = [NODE, SQLITE];

const PRIMITIVE_OF = {
	web: "web.static/v1",
	api: "api.http/v1",
	service: "service.worker/v1",
	data: "data.sqlite/v1",
	kv: "kv.key-value/v1",
	bucket: "bucket.filesystem/v1",
	queue: "queue.at-least-once/v1",
	topic: "topic.ephemeral-pubsub/v1",
	secretRef: "secret-ref.locator/v1",
	webhook: "webhook.inbound-http/v1",
} satisfies Readonly<Record<string, string>>;

describe("seedLocalhostYard() — purity and determinism", () => {
	it("returns a deep-equal seed for the same observations", () => {
		expect(seedLocalhostYard(FULL_HOST)).toEqual(seedLocalhostYard(FULL_HOST));
	});

	it("is independent of observation order", () => {
		expect(seedLocalhostYard([NODE, SQLITE])).toEqual(
			seedLocalhostYard([SQLITE, NODE]),
		);
	});

	it("unions repeated observations instead of last-write-wins", () => {
		const present = { capabilityId: "capability:runtime:node", present: true };
		const absent = { capabilityId: "capability:runtime:node", present: false };
		expect(seedLocalhostYard([present, absent])).toEqual(
			seedLocalhostYard([absent, present]),
		);
	});

	it("orders rows and unavailable entries canonically", () => {
		const seed = seedLocalhostYard(FULL_HOST);
		const profiles = seed.rows.map((r) => r.profile);
		expect(profiles).toEqual([...profiles].sort());
		const unavailable = seed.unavailable.map((u) => u.profile);
		expect(unavailable).toEqual([...unavailable].sort());
	});

	it("freezes the whole seed", () => {
		const seed = seedLocalhostYard(FULL_HOST);
		expect(Object.isFrozen(seed)).toBe(true);
		expect(Object.isFrozen(seed.rows)).toBe(true);
		expect(Object.isFrozen(seed.rows[0])).toBe(true);
		expect(Object.isFrozen(seed.unavailable)).toBe(true);
	});
});

describe("seedLocalhostYard() — fidelity and fail-closed accounting", () => {
	it("stamps the seed contract", () => {
		expect(seedLocalhostYard(FULL_HOST).contract).toBe(
			"hobo.localhost-yard-seed/v1",
		);
	});

	it("accounts for every Bindle catalog primitive as a row or an unavailable entry", () => {
		for (const observations of [FULL_HOST, []]) {
			const seed = seedLocalhostYard(observations);
			const seen = new Set([
				...seed.rows.map((r) => r.profile),
				...seed.unavailable.map((u) => u.profile),
			]);
			for (const profile of Object.values(PRIMITIVE_OF)) {
				expect(seen.has(profile)).toBe(true);
			}
		}
	});

	it("labels every row with a fidelity and a provenance", () => {
		for (const row of seedLocalhostYard(FULL_HOST).rows) {
			expect(["real", "simulated", "mocked", "camp-only"]).toContain(
				row.fidelity,
			);
			expect(["default", "discovered", "declared"]).toContain(row.provenance);
		}
	});

	it("labels in-memory stand-ins simulated, not real", () => {
		const seed = seedLocalhostYard(FULL_HOST);
		const queue = seed.rows.find((r) => r.profile === "queue.at-least-once/v1");
		expect(queue?.fidelity).toBe("simulated");
		expect(queue?.provenance).toBe("default");
	});

	it("marks capability-gated rows as discovered", () => {
		const http = seedLocalhostYard(FULL_HOST).rows.find(
			(r) => r.profile === "api.http/v1",
		);
		expect(http?.provenance).toBe("discovered");
		expect(http?.productId).toBe("local:node-http-server");
	});

	it("moves a primitive to unavailable when its capability is absent, never omitting it", () => {
		const seed = seedLocalhostYard([SQLITE]);
		expect(seed.rows.some((r) => r.profile === "api.http/v1")).toBe(false);
		const entry = seed.unavailable.find((u) => u.profile === "api.http/v1");
		expect(entry?.reason).toMatch(/capability:runtime:node/u);
		expect(entry?.reason).toMatch(/provider Yard/u);
	});

	it("treats an explicitly absent observation the same as no observation", () => {
		expect(
			seedLocalhostYard([
				{ capabilityId: "capability:runtime:node", present: false },
			]),
		).toEqual(seedLocalhostYard([]));
	});

	it("lists profiles with no local implementation at all, whatever the host offers", () => {
		const seed = seedLocalhostYard(FULL_HOST);
		const permanentlyUnavailable = seed.unavailable.map((u) => u.profile);
		expect(permanentlyUnavailable).toContain(
			"secret-ref.dynamic-resolution/v1",
		);
		expect(permanentlyUnavailable).toContain("topic.durable-log/v1");
		for (const entry of seed.unavailable) {
			expect(entry.reason).toMatch(/no local implementation/u);
		}
	});

	it("keeps every reason non-empty and actionable", () => {
		for (const entry of seedLocalhostYard([]).unavailable) {
			expect(entry.reason.length).toBeGreaterThan(0);
		}
	});
});

describe("seedLocalhostYard() — the seeded Yard is a real Yard", () => {
	it("is the product of yard()'s own parse", () => {
		const seed = seedLocalhostYard(FULL_HOST);
		expect(seed.yard.kind).toBe("yard");
		expect(seed.yard.contract).toBe(TOPOLOGY_CONTRACT_VERSION);
		expect(seed.yard.name).toBe(LOCALHOST_YARD_NAME);
		expect(seed.yard.providerId).toBe(LOCALHOST_PROVIDER_ID);
		expect(seed.yard.camps).toEqual([]);
		expect(Object.isFrozen(seed.yard)).toBe(true);
	});

	it("survives re-parsing its own rows through yard()", () => {
		const seed = seedLocalhostYard(FULL_HOST);
		const rebuilt = yard(LOCALHOST_YARD_NAME, {
			provider: LOCALHOST_PROVIDER_ID,
			bindings: seed.yard.bindings.map((b) => ({
				profile: b.profile,
				...(b.productId !== undefined ? { productId: b.productId } : undefined),
				properties: b.properties,
			})),
		});
		expect(rebuilt.bindings).toEqual(seed.yard.bindings);
	});

	it("carries one parsed binding row per seed row, with fidelity attested", () => {
		const seed = seedLocalhostYard(FULL_HOST);
		expect(seed.yard.bindings).toHaveLength(seed.rows.length);
		for (const binding of seed.yard.bindings) {
			expect(binding.contract).toBe(YARD_BINDING_CONTRACT);
			expect(YARD_BINDING_PROFILE_PATTERN.test(binding.profile)).toBe(true);
			expect(binding.properties["local.fidelity"]).toBeTypeOf("string");
			expect(binding.properties["local.provenance"]).toBeTypeOf("string");
		}
	});

	it("surfaces the seeded rows through yardToContract", () => {
		const seed = seedLocalhostYard(FULL_HOST);
		expect(yardToContract(seed.yard).bindings).toEqual(seed.yard.bindings);
	});
});

describe("seedLocalhostYard() — observation parse boundary", () => {
	it.each([
		["runtime:node", "missing capability: prefix"],
		["capability:Runtime:node", "uppercase kind"],
		["capability:runtime:", "empty slug"],
		["capability::node", "empty kind"],
	])("rejects the malformed capability id %s (%s)", (capabilityId) => {
		expect(() => seedLocalhostYard([{ capabilityId, present: true }])).toThrow(
			TypeError,
		);
	});

	it.each([
		[{ capabilityId: "capability:runtime:node" }, "missing present"],
		[
			{ capabilityId: "capability:runtime:node", present: "yes" },
			"non-boolean present",
		],
		[null, "not an object"],
	])("rejects a malformed observation (%#: %s)", (observation) => {
		expect(() =>
			seedLocalhostYard([
				// SAFETY: `observation` is deliberately malformed; the parse
				// boundary must refuse it, so the typed signature is bypassed
				// on purpose.
				observation as never,
			]),
		).toThrow(TypeError);
	});

	it("rejects a non-array observation set", () => {
		expect(() =>
			seedLocalhostYard(
				// SAFETY: a string is deliberately not an observation set; the
				// parse boundary must refuse it, so the typed signature is
				// bypassed on purpose.
				"capability:runtime:node" as never,
			),
		).toThrow(TypeError);
	});
});
