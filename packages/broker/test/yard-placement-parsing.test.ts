/**
 * `parseYardShape` is a trust boundary. A YardShape arrives from a deployment
 * request — outside data — and everything downstream treats the parsed result as
 * structurally sound: matching reads its arrays, generation hashes it into an
 * idempotency key, and `contentHashOf` turns it into the identity a placement
 * decision is pinned to. So the parse has two jobs that are easy to get subtly
 * wrong, and neither shows up on a well-formed input.
 *
 * The first is *normalisation*: lists are deduplicated and sorted, maps are
 * key-sorted, non-strings are dropped. That is what makes `contentHashOf` a
 * stable identity — two requests that mean the same thing must hash the same,
 * or an idempotency key stops being idempotent and the same generation runs
 * twice. The second is *rejection*: a hostile or malformed field must not
 * survive into the parsed shape as `undefined`, because the downstream code
 * reads these fields without checking.
 *
 * These tests drive both, plus the generation policy's default-deny ladder and
 * the saga's idempotency lease — the mechanism that stops two concurrent
 * identical requests from provisioning two Yards.
 */
import { describe, expect, test } from "vitest";

import {
	createYardGenerationSaga,
	DEFAULT_YARD_GENERATION_POLICY,
	planYardGeneration,
	type YardGenerationConnector,
} from "../src/yard-placement/generation.js";
import {
	createYardInventory,
	createYardRuntimeCatalog,
	localYardInstance,
} from "../src/yard-placement/inventory.js";
import * as yardPlacementTypes from "../src/yard-placement/types.js";

const contentHashOf = yardPlacementTypes["contentHashOf"];
const emptyYardPlacement = yardPlacementTypes["emptyYardLayout"];
const parseCampPlacement = yardPlacementTypes["parseCampLayout"];
const parseYardPlacement = yardPlacementTypes["parseYardLayout"];
type YardPlacement = ReturnType<typeof parseYardPlacement>;
type YardGenerationPlan = yardPlacementTypes.YardGenerationPlan;
type YardGenerationPolicy = yardPlacementTypes.YardGenerationPolicy;
type YardRuntimeRegistration = yardPlacementTypes.YardRuntimeRegistration;

describe("parseYardShape", () => {
	test("absent input yields the empty shape rather than throwing", () => {
		// A request that omits the shape entirely is legal — it means "no
		// constraints", not "malformed".
		expect(parseYardPlacement(undefined)).toEqual(emptyYardPlacement());
		expect(parseYardPlacement(null)).toEqual(emptyYardPlacement());
	});

	test("a non-object is refused", () => {
		// Everything downstream indexes into this value. A string that slipped
		// through would surface as `undefined.map is not a function` somewhere
		// far from the request that caused it.
		for (const bad of ["shape", 42, true]) {
			expect(() => parseYardPlacement(bad)).toThrow(TypeError);
		}
	});

	test("an array is refused even though it is technically an object", () => {
		// `typeof [] === "object"`, so the Array check is the only thing standing
		// between a JSON array and a shape whose every field reads undefined.
		expect(() => parseYardPlacement([])).toThrow(TypeError);
		expect(() => parseYardPlacement([{ regions: ["a"] }])).toThrow(TypeError);
	});

	test("an empty object parses to the empty shape", () => {
		expect(parseYardPlacement({})).toEqual(emptyYardPlacement());
	});

	test("providerId and runtimeId are omitted when blank, not set to an empty string", () => {
		// Generation branches on `if (!providerId)`, and `"" `would take the same
		// path — but a shape carrying `providerId: ""` would also hash differently
		// from one that simply omits it, splitting one logical request into two
		// idempotency keys.
		const parsed = parseYardPlacement({ providerId: "", runtimeId: "" });
		expect("providerId" in parsed).toBe(false);
		expect("runtimeId" in parsed).toBe(false);
	});

	test("a non-string providerId is dropped rather than coerced", () => {
		expect("providerId" in parseYardPlacement({ providerId: 42 })).toBe(false);
		expect("providerId" in parseYardPlacement({ providerId: null })).toBe(
			false,
		);
		expect("providerId" in parseYardPlacement({ providerId: ["aws"] })).toBe(
			false,
		);
	});

	test("a real providerId and runtimeId are preserved", () => {
		const parsed = parseYardPlacement({ providerId: "aws", runtimeId: "rt-1" });
		expect(parsed.providerId).toBe("aws");
		expect(parsed.runtimeId).toBe("rt-1");
	});

	test("list fields are sorted and deduplicated", () => {
		// This is what makes the content hash a stable identity: a client that
		// sends regions in a different order must not produce a different
		// placement decision id.
		const parsed = parseYardPlacement({
			regions: ["us-west", "eu-west", "us-west", "ap-south"],
		});
		expect(parsed.regions).toEqual(["ap-south", "eu-west", "us-west"]);
	});

	test("non-string and empty list entries are dropped", () => {
		// An empty-string requirement would silently match nothing and be very
		// hard to see in a rejected placement.
		const parsed = parseYardPlacement({
			require: ["gpu", "", 42, null, "gpu", { a: 1 }],
		});
		expect(parsed.require).toEqual(["gpu"]);
	});

	test("a non-array list field falls back to the empty default", () => {
		const parsed = parseYardPlacement({
			regions: "us-west",
			require: { a: 1 },
		});
		expect(parsed.regions).toEqual([]);
		expect(parsed.require).toEqual([]);
	});

	test("every list field is normalised, not just the common ones", () => {
		// A field that skipped normalisation would be an ordering-sensitive
		// component of the content hash — the exact bug this rules out.
		const messy = ["b", "a", "b"];
		const parsed = parseYardPlacement({
			regions: messy,
			require: messy,
			prefer: messy,
			residency: messy,
			isolation: messy,
			network: messy,
			componentHosts: messy,
		});
		for (const field of [
			parsed.regions,
			parsed.require,
			parsed.prefer,
			parsed.residency,
			parsed.isolation,
			parsed.network,
			parsed.componentHosts,
		]) {
			expect(field).toEqual(["a", "b"]);
		}
	});

	test("labels keep only string values and are key-sorted", () => {
		const parsed = parseYardPlacement({
			labels: { z: "last", a: "first", bad: 42, alsoBad: null },
		});
		expect(Object.keys(parsed.labels)).toEqual(["a", "z"]);
		expect(parsed.labels).toEqual({ a: "first", z: "last" });
	});

	test("a non-object labels field yields an empty map", () => {
		expect(parseYardPlacement({ labels: "nope" }).labels).toEqual({});
		expect(parseYardPlacement({ labels: ["a"] }).labels).toEqual({});
		expect(parseYardPlacement({ labels: null }).labels).toEqual({});
	});

	test("properties accept nested JSON and are recursively key-sorted", () => {
		// Properties are free-form, so they are the field most likely to arrive
		// with keys in an arbitrary order from a client library.
		const parsed = parseYardPlacement({
			properties: { z: 1, a: { nested: true, deep: [1, "two", null] } },
		});
		expect(Object.keys(parsed.properties)).toEqual(["a", "z"]);
		// SAFETY: the parsed property is an object because the input above supplies a nested JSON object.
		expect(Object.keys(parsed.properties.a as object)).toEqual([
			"deep",
			"nested",
		]);
	});

	test("properties preserve every JSON scalar type", () => {
		// Unlike labels, properties are not string-only — coercing here would
		// change a numeric limit into text downstream.
		const parsed = parseYardPlacement({
			properties: { n: 42, b: false, s: "text", nil: null },
		});
		expect(parsed.properties).toEqual({
			n: 42,
			b: false,
			s: "text",
			nil: null,
		});
	});

	test("a property that is not JSON-safe is rejected", () => {
		// A function or symbol would serialise to nothing in `contentHashOf`,
		// making two different shapes hash identically.
		expect(() => parseYardPlacement({ properties: { fn: () => 1 } })).toThrow(
			TypeError,
		);
		expect(() =>
			parseYardPlacement({ properties: { sym: Symbol("x") } }),
		).toThrow(TypeError);
	});

	test("a non-array camps field yields no camps", () => {
		expect(parseYardPlacement({ camps: "not-an-array" }).camps).toEqual([]);
	});

	test("camps are parsed element-wise", () => {
		const parsed = parseYardPlacement({
			camps: [{ id: "c1", require: ["gpu"] }, { id: "c2" }],
		});
		expect(parsed.camps).toHaveLength(2);
		expect(parsed.camps[0]?.id).toBe("c1");
		expect(parsed.camps[0]?.require).toEqual(["gpu"]);
	});

	test("the parsed shape is frozen", () => {
		// Downstream code holds this object while making a decision; a mutable
		// shape would let one consumer change another's inputs.
		expect(Object.isFrozen(parseYardPlacement({ regions: ["a"] }))).toBe(true);
	});
});

describe("parseCampShape", () => {
	test("a non-object yields an empty camp rather than throwing", () => {
		// Camps are parsed inside a `.map` over untrusted array elements, so one
		// bad element must not abort the whole shape.
		for (const bad of [null, "camp", 42, [], undefined]) {
			const parsed = parseCampPlacement(bad);
			expect(parsed.require).toEqual([]);
			expect(parsed.labels).toEqual({});
		}
	});

	test("optional identity fields are omitted when not strings", () => {
		const parsed = parseCampPlacement({ id: 42, env: null, envType: ["x"] });
		expect("id" in parsed).toBe(false);
		expect("env" in parsed).toBe(false);
		expect("envType" in parsed).toBe(false);
	});

	test("an empty-string id is preserved, unlike on the yard shape", () => {
		// Worth pinning because the two parsers differ: the yard shape requires
		// `length > 0` for providerId, the camp shape only checks the type. A
		// future refactor that "harmonised" them would change the content hash of
		// every camp carrying a blank id.
		expect(parseCampPlacement({ id: "" }).id).toBe("");
	});

	test("lists are normalised the same way as on the yard shape", () => {
		const parsed = parseCampPlacement({
			require: ["b", "a", "b", "", 7],
			runtimeRequirements: ["wasm", "wasm"],
		});
		expect(parsed.require).toEqual(["a", "b"]);
		expect(parsed.runtimeRequirements).toEqual(["wasm"]);
	});

	test("the parsed camp is frozen", () => {
		expect(Object.isFrozen(parseCampPlacement({ id: "c1" }))).toBe(true);
	});
});

describe("contentHashOf", () => {
	test("key order does not change the hash", () => {
		// The whole reason `sortKeys` exists. Without it, two identical requests
		// serialised by different clients would get different placement ids.
		expect(contentHashOf({ a: 1, b: 2 })).toBe(contentHashOf({ b: 2, a: 1 }));
	});

	test("nested key order does not change the hash either", () => {
		expect(contentHashOf({ outer: { a: 1, b: 2 } })).toBe(
			contentHashOf({ outer: { b: 2, a: 1 } }),
		);
	});

	test("array order does change the hash", () => {
		// Arrays are ordered data — `sortKeys` recurses into them but must not
		// reorder them, or `[a, b]` and `[b, a]` would become the same plan.
		expect(contentHashOf([1, 2])).not.toBe(contentHashOf([2, 1]));
	});

	test("different values hash differently", () => {
		expect(contentHashOf({ a: 1 })).not.toBe(contentHashOf({ a: 2 }));
	});

	test("it handles primitives and null", () => {
		expect(contentHashOf(null)).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(contentHashOf("text")).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(contentHashOf(42)).not.toBe(contentHashOf("42"));
	});

	test("two shapes that mean the same thing hash the same", () => {
		// The end-to-end property the normalisation exists for.
		const a = parseYardPlacement({
			regions: ["us-west", "eu-west"],
			labels: { z: "1", a: "2" },
		});
		const b = parseYardPlacement({
			labels: { a: "2", z: "1" },
			regions: ["eu-west", "us-west", "eu-west"],
		});
		expect(contentHashOf(a)).toBe(contentHashOf(b));
	});
});

describe("the yard inventory read model", () => {
	function registration(yardId: string) {
		return localYardInstance({
			yardId,
			ownerTenantId: "t1",
			providerId: "local",
		});
	}

	test("a registration becomes visible and gets a sequence number", () => {
		const inv = createYardInventory("broker-1");
		inv.apply({
			type: "yard.Registered",
			yard: { ...registration("yard:a"), registrationSeq: 0 },
		});
		expect(inv.get("yard:a")?.yardId).toBe("yard:a");
		// A zero registrationSeq is treated as absent and filled from the event
		// counter — otherwise every yard registered without one would tie at 0
		// and the inventory would have no stable ordering.
		expect(inv.get("yard:a")?.registrationSeq).toBe(1);
	});

	test("an explicit registration sequence is preserved", () => {
		const inv = createYardInventory("broker-1");
		inv.apply({
			type: "yard.Registered",
			yard: { ...registration("yard:a"), registrationSeq: 99 },
		});
		expect(inv.get("yard:a")?.registrationSeq).toBe(99);
	});

	test("events for an unknown yard are ignored rather than creating one", () => {
		// A status update must never conjure a Yard the broker has not seen
		// registered — placement would then select a Yard that does not exist.
		const inv = createYardInventory("broker-1");
		inv.apply({
			type: "yard.StatusChanged",
			yardId: "yard:ghost",
			status: "draining",
			observedAt: "2026-01-01T00:00:00.000Z",
		});
		inv.apply({
			type: "yard.CapacityUpdated",
			yardId: "yard:ghost",
			capacity: { classes: { default: 1 }, reservations: {} },
		});
		expect(inv.get("yard:ghost")).toBeUndefined();
		expect(inv.snapshot().yards).toHaveLength(0);
	});

	test("a status change bumps the health generation", () => {
		// The generation is how a consumer tells a fresh observation from a
		// replayed one; a status change that left it alone would look stale.
		const inv = createYardInventory("broker-1");
		inv.apply({ type: "yard.Registered", yard: registration("yard:a") });
		const before = inv.get("yard:a")?.health.generation ?? 0;
		inv.apply({
			type: "yard.StatusChanged",
			yardId: "yard:a",
			status: "draining",
			observedAt: "2026-02-02T00:00:00.000Z",
		});
		expect(inv.get("yard:a")?.status).toBe("draining");
		expect(inv.get("yard:a")?.health.generation).toBe(before + 1);
		expect(inv.get("yard:a")?.health.observedAt).toBe(
			"2026-02-02T00:00:00.000Z",
		);
	});

	test("a capacity update replaces capacity and leaves status alone", () => {
		const inv = createYardInventory("broker-1");
		inv.apply({ type: "yard.Registered", yard: registration("yard:a") });
		inv.apply({
			type: "yard.CapacityUpdated",
			yardId: "yard:a",
			capacity: { classes: { gpu: 4 }, reservations: { held: 1 } },
		});
		expect(inv.get("yard:a")?.capacity.classes).toEqual({ gpu: 4 });
		expect(inv.get("yard:a")?.status).toBe("ready");
	});

	test("re-registering the same id replaces rather than duplicating", () => {
		const inv = createYardInventory("broker-1");
		inv.apply({ type: "yard.Registered", yard: registration("yard:a") });
		inv.apply({
			type: "yard.Registered",
			yard: { ...registration("yard:a"), ownerTenantId: "t2" },
		});
		expect(inv.snapshot().yards).toHaveLength(1);
		expect(inv.get("yard:a")?.ownerTenantId).toBe("t2");
	});

	test("the snapshot is sorted by yard id regardless of arrival order", () => {
		// Selection pins the snapshot hash, so arrival order must not change it.
		const inv = createYardInventory("broker-1");
		for (const id of ["yard:c", "yard:a", "yard:b"]) {
			inv.apply({ type: "yard.Registered", yard: registration(id) });
		}
		expect(inv.snapshot().yards.map((y) => y.yardId)).toEqual([
			"yard:a",
			"yard:b",
			"yard:c",
		]);
	});

	test("two inventories built in different orders hash identically", () => {
		// This is the property the sort exists for: the pinned snapshot hash has
		// to be a function of the state, not of the event arrival order.
		const forward = createYardInventory("broker-1");
		const reverse = createYardInventory("broker-1");
		const ids = ["yard:a", "yard:b", "yard:c"];
		for (const id of ids) {
			forward.apply({ type: "yard.Registered", yard: registration(id) });
		}
		for (const id of [...ids].reverse()) {
			reverse.apply({ type: "yard.Registered", yard: registration(id) });
		}
		// The seq differs by arrival, so compare the yard list rather than the
		// whole snapshot — that is the part placement actually selects over.
		expect(forward.snapshot().yards.map((y) => y.yardId)).toEqual(
			reverse.snapshot().yards.map((y) => y.yardId),
		);
	});

	test("the snapshot sequence counts every applied event, including ignored ones", () => {
		// The counter is bumped before the unknown-yard guard. Pinning this
		// because it means seq is an event count, not a state-change count — a
		// consumer treating it as the latter would see phantom gaps.
		const inv = createYardInventory("broker-1");
		inv.apply({
			type: "yard.StatusChanged",
			yardId: "yard:ghost",
			status: "draining",
			observedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(inv.snapshot().seq).toBe(1);
	});

	test("the snapshot and its yard list are frozen", () => {
		const inv = createYardInventory("broker-1");
		inv.apply({ type: "yard.Registered", yard: registration("yard:a") });
		const snap = inv.snapshot();
		expect(Object.isFrozen(snap)).toBe(true);
		expect(Object.isFrozen(snap.yards)).toBe(true);
	});

	test("an empty inventory still produces a hashable snapshot", () => {
		const snap = createYardInventory("broker-1").snapshot();
		expect(snap.yards).toHaveLength(0);
		expect(snap.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe("the runtime catalog", () => {
	function runtime(
		overrides: Partial<YardRuntimeRegistration> & { runtimeId: string },
	): YardRuntimeRegistration {
		// SAFETY: the fixture supplies every required runtime registration field.
		return {
			schemaVersion: "hobo.yard-runtime/v1",
			providerId: "aws",
			version: "1.0.0",
			status: "approved",
			priority: 0,
			default: false,
			generatorConnectorId: "conn-1",
			requiredPermissions: [],
			...overrides,
		} as YardRuntimeRegistration;
	}

	test("the snapshot orders by descending priority then id", () => {
		const cat = createYardRuntimeCatalog();
		cat.register(runtime({ runtimeId: "b", priority: 1 }));
		cat.register(runtime({ runtimeId: "a", priority: 1 }));
		cat.register(runtime({ runtimeId: "c", priority: 9 }));
		expect(cat.snapshot().runtimes.map((r) => r.runtimeId)).toEqual([
			"c",
			"a",
			"b",
		]);
	});

	test("registering the same id twice replaces it", () => {
		const cat = createYardRuntimeCatalog();
		cat.register(runtime({ runtimeId: "a", version: "1.0.0" }));
		cat.register(runtime({ runtimeId: "a", version: "2.0.0" }));
		expect(cat.snapshot().runtimes).toHaveLength(1);
		expect(cat.snapshot().runtimes[0]?.version).toBe("2.0.0");
	});

	test("approvedForProvider excludes other providers", () => {
		const cat = createYardRuntimeCatalog();
		cat.register(runtime({ runtimeId: "a", providerId: "aws" }));
		cat.register(runtime({ runtimeId: "b", providerId: "gcp" }));
		expect(cat.approvedForProvider("aws").map((r) => r.runtimeId)).toEqual([
			"a",
		]);
	});

	test("approvedForProvider excludes runtimes that are not approved", () => {
		// A pending or revoked runtime must never be selected for generation —
		// that is what the approval step is for.
		const cat = createYardRuntimeCatalog();
		cat.register(runtime({ runtimeId: "pending", status: "pending" }));
		cat.register(runtime({ runtimeId: "revoked", status: "revoked" }));
		cat.register(runtime({ runtimeId: "ok" }));
		expect(cat.approvedForProvider("aws").map((r) => r.runtimeId)).toEqual([
			"ok",
		]);
	});

	test("approvedForProvider excludes runtimes with no generator connector", () => {
		// Without a connector there is nothing to provision with; selecting one
		// would produce a plan that can only fail.
		const cat = createYardRuntimeCatalog();
		cat.register(runtime({ runtimeId: "nogen", generatorConnectorId: "" }));
		cat.register(runtime({ runtimeId: "ok" }));
		expect(cat.approvedForProvider("aws").map((r) => r.runtimeId)).toEqual([
			"ok",
		]);
	});

	test("a default runtime outranks a higher-priority non-default one", () => {
		// The `default` flag is the operator's explicit choice and must beat a
		// numeric priority that happens to be larger.
		const cat = createYardRuntimeCatalog();
		cat.register(runtime({ runtimeId: "high", priority: 100 }));
		cat.register(runtime({ runtimeId: "chosen", priority: 0, default: true }));
		expect(cat.approvedForProvider("aws")[0]?.runtimeId).toBe("chosen");
	});

	test("an unknown provider yields nothing rather than everything", () => {
		const cat = createYardRuntimeCatalog();
		cat.register(runtime({ runtimeId: "a" }));
		expect(cat.approvedForProvider("nobody")).toEqual([]);
	});
});

describe("planYardGeneration", () => {
	const REQUESTED_PLACEMENT: YardPlacement = parseYardPlacement({
		providerId: "aws",
	});

	function policy(
		overrides: Partial<YardGenerationPolicy> = {},
	): YardGenerationPolicy {
		return { ...DEFAULT_YARD_GENERATION_POLICY, effect: "allow", ...overrides };
	}

	function catalogWith(
		...runtimes: readonly Partial<YardRuntimeRegistration>[]
	) {
		const cat = createYardRuntimeCatalog();
		for (const [i, r] of runtimes.entries()) {
			// SAFETY: the fixture supplies every required runtime registration field.
			cat.register({
				schemaVersion: "hobo.yard-runtime/v1",
				runtimeId: `rt-${i}`,
				providerId: "aws",
				version: "1.0.0",
				status: "approved",
				priority: 0,
				default: false,
				generatorConnectorId: "conn-1",
				requiredPermissions: [],
				...r,
			} as YardRuntimeRegistration);
		}
		return cat.snapshot();
	}

	function plan(
		overrides: Partial<Parameters<typeof planYardGeneration>[0]> = {},
	) {
		return planYardGeneration({
			ownerTenantId: "t1",
			requestedLayout: REQUESTED_PLACEMENT,
			runtimeCatalog: catalogWith({}),
			policy: policy(),
			allowGenerationRequested: true,
			attemptId: "attempt-1",
			...overrides,
		});
	}

	test("the shipped default policy denies", () => {
		// Generating infrastructure is the most consequential thing this broker
		// can do, so the default has to be deny — an operator opts in.
		expect(DEFAULT_YARD_GENERATION_POLICY.effect).toBe("deny");
		expect(DEFAULT_YARD_GENERATION_POLICY.requireApproval).toBe(true);
		expect(DEFAULT_YARD_GENERATION_POLICY.requireAttestation).toBe(true);
	});

	test("generation is refused unless the request asked for it", () => {
		// Policy allowing generation is not the same as the request wanting it;
		// provisioning a Yard nobody asked for costs real money.
		const result = plan({ allowGenerationRequested: false });
		expect(result.allowed).toBe(false);
		expect(result.allowed === false && result.reason).toContain(
			"not requested",
		);
	});

	test("a deny policy refuses even when the request asks", () => {
		const result = plan({ policy: policy({ effect: "deny" }) });
		expect(result.allowed).toBe(false);
		expect(result.allowed === false && result.reason).toContain("denies");
	});

	test("a shape with no provider is refused", () => {
		// There is nothing to generate against, and a plan built without one
		// would carry an empty credential scope.
		const result = plan({ requestedLayout: parseYardPlacement({}) });
		expect(result.allowed).toBe(false);
		expect(result.allowed === false && result.reason).toContain("providerId");
	});

	test("an explicitly denied provider is refused", () => {
		const result = plan({ policy: policy({ deniedProviderIds: ["aws"] }) });
		expect(result.allowed).toBe(false);
		expect(result.allowed === false && result.reason).toContain("aws");
	});

	test("an allow-list excludes providers not on it", () => {
		expect(
			plan({ policy: policy({ allowedProviderIds: ["gcp"] }) }).allowed,
		).toBe(false);
		expect(
			plan({ policy: policy({ allowedProviderIds: ["aws"] }) }).allowed,
		).toBe(true);
	});

	test("an empty allow-list is not a deny-all", () => {
		// The default policy ships with empty lists, so reading empty as
		// "nothing allowed" would make an opted-in policy still refuse
		// everything.
		expect(plan({ policy: policy({ allowedProviderIds: [] }) }).allowed).toBe(
			true,
		);
	});

	test("a denied runtime is excluded from candidates", () => {
		const result = plan({
			runtimeCatalog: catalogWith({ runtimeId: "banned" }),
			policy: policy({ deniedRuntimeIds: ["banned"] }),
		});
		expect(result.allowed).toBe(false);
	});

	test("a connector allow-list excludes runtimes using other connectors", () => {
		// The connector is what holds the provisioning credentials, so the
		// allow-list is a credential boundary, not a preference.
		const denied = plan({
			runtimeCatalog: catalogWith({ generatorConnectorId: "conn-other" }),
			policy: policy({ allowedConnectorIds: ["conn-1"] }),
		});
		expect(denied.allowed).toBe(false);

		const allowed = plan({
			policy: policy({ allowedConnectorIds: ["conn-1"] }),
		});
		expect(allowed.allowed).toBe(true);
	});

	test("an empty catalog is refused with an actionable reason", () => {
		const result = plan({ runtimeCatalog: catalogWith() });
		expect(result.allowed).toBe(false);
		expect(result.allowed === false && result.reason).toContain("aws");
	});

	test("a catalog with only unapproved runtimes is refused", () => {
		const result = plan({
			runtimeCatalog: catalogWith({ status: "pending" }),
		});
		expect(result.allowed).toBe(false);
	});

	test("an allowed plan names the winning runtime and its connector", () => {
		const result = plan();
		expect(result.allowed).toBe(true);
		if (!result.allowed) return;
		expect(result.plan.providerId).toBe("aws");
		expect(result.plan.generatorConnectorId).toBe("conn-1");
		expect(result.plan.credentialScopeRef).toBe("scope://conn-1/aws");
	});

	test("the default runtime wins over a higher-priority one", () => {
		const result = plan({
			runtimeCatalog: catalogWith(
				{ runtimeId: "high", priority: 100 },
				{ runtimeId: "chosen", default: true },
			),
		});
		expect(result.allowed === true && result.runtime.runtimeId).toBe("chosen");
	});

	test("the idempotency key is stable for identical inputs", () => {
		// This key is what stops a retried request from provisioning a second
		// Yard. If it moved between two identical calls, a client retry would
		// double-spend.
		const a = plan();
		const b = plan();
		expect(a.allowed && b.allowed && a.plan.idempotencyKey).toBe(
			b.allowed ? b.plan.idempotencyKey : "different",
		);
	});

	test("the idempotency key ignores the attempt id", () => {
		// Two attempts at the same generation are the same generation — keying on
		// the attempt id would defeat the whole mechanism.
		const a = plan({ attemptId: "attempt-1" });
		const b = plan({ attemptId: "attempt-2" });
		expect(a.allowed && b.allowed && a.plan.idempotencyKey).toBe(
			b.allowed ? b.plan.idempotencyKey : "different",
		);
	});

	test("a different tenant gets a different idempotency key", () => {
		// Otherwise two tenants asking for the same shape would share one Yard.
		const a = plan({ ownerTenantId: "t1" });
		const b = plan({ ownerTenantId: "t2" });
		expect(a.allowed && b.allowed && a.plan.idempotencyKey).not.toBe(
			b.allowed ? b.plan.idempotencyKey : undefined,
		);
	});

	test("a different broker environment gets a different key", () => {
		// Staging and production must not collapse onto one Yard.
		const a = plan({ brokerEnvironmentId: "staging" });
		const b = plan({ brokerEnvironmentId: "production" });
		expect(a.allowed && b.allowed && a.plan.idempotencyKey).not.toBe(
			b.allowed ? b.plan.idempotencyKey : undefined,
		);
	});

	test("omitting the broker environment is equivalent to 'default'", () => {
		const a = plan();
		const b = plan({ brokerEnvironmentId: "default" });
		expect(a.allowed && b.allowed && a.plan.idempotencyKey).toBe(
			b.allowed ? b.plan.idempotencyKey : "different",
		);
	});

	test("a different runtime version gets a different key", () => {
		// A runtime upgrade should produce a new Yard, not silently reuse one
		// built by the previous version.
		const a = plan({ runtimeCatalog: catalogWith({ version: "1.0.0" }) });
		const b = plan({ runtimeCatalog: catalogWith({ version: "2.0.0" }) });
		expect(a.allowed && b.allowed && a.plan.idempotencyKey).not.toBe(
			b.allowed ? b.plan.idempotencyKey : undefined,
		);
	});

	test("the expected yard id is derived from the idempotency key", () => {
		const result = plan();
		expect(result.allowed).toBe(true);
		if (!result.allowed) return;
		expect(result.plan.expectedYardId).toBe(
			`yard:gen-${result.plan.idempotencyKey.slice(7, 23)}`,
		);
	});

	test("the plan hash covers the plan body", () => {
		const result = plan();
		expect(result.allowed === true && result.plan.planHash).toMatch(
			/^sha256:[0-9a-f]{64}$/,
		);
	});

	test("every refusal reports the policy that made it", () => {
		// Without the policy id an operator cannot tell which of several stacked
		// policies refused, and so cannot fix it.
		const named = policy({ id: "policy-under-test", effect: "deny" });
		const result = plan({ policy: named });
		expect(result.policyId).toBe("policy-under-test");
	});
});

describe("the generation saga", () => {
	function planFor(key: string, connectorId = "conn-1"): YardGenerationPlan {
		// SAFETY: this fixture supplies the complete generation plan contract.
		return Object.freeze({
			schemaVersion: "hobo.yard-generation-plan/v1",
			attemptId: `attempt-${key}`,
			idempotencyKey: `sha256:${key.padEnd(64, "0")}`,
			requestedLayout: parseYardPlacement({ providerId: "aws" }),
			requestedLayoutHash: contentHashOf({ providerId: "aws" }),
			runtimeId: "rt-0",
			providerId: "aws",
			generatorConnectorId: connectorId,
			expectedYardId: "yard:gen-test",
			requiredPermissions: [],
			credentialScopeRef: "scope://conn-1/aws",
			inputs: { ownerTenantId: "t1", providerId: "aws", runtimeId: "rt-0" },
			planHash: contentHashOf({ key }),
			// SAFETY: this fixture supplies the complete generation plan contract.
		}) as YardGenerationPlan;
	}

	function connector(
		overrides: Partial<YardGenerationConnector> = {},
	): YardGenerationConnector & { provisionCalls: number } {
		const impl = {
			id: "conn-1",
			kind: "test",
			provisionCalls: 0,
			plan: () => planFor("a"),
			async provision(p: YardGenerationPlan) {
				impl.provisionCalls += 1;
				return Object.freeze({
					attemptId: p.attemptId,
					status: "ready" as const,
					externalRefs: Object.freeze({}),
					outputHash: contentHashOf({ a: 1 }),
				});
			},
			async inspect(attemptId: string) {
				return Object.freeze({
					attemptId,
					status: "ready" as const,
					externalRefs: Object.freeze({}),
					outputHash: contentHashOf({ inspected: true }),
				});
			},
			...overrides,
		};
		// SAFETY: the fixture implements the connector contract and adds its call counter.
		return impl as YardGenerationConnector & {
			provisionCalls: number;
		};
	}

	function saga(c: YardGenerationConnector) {
		return createYardGenerationSaga({
			connectors: new Map([[c.id, c]]),
		});
	}

	test("a missing connector fails rather than throwing", () => {
		// The saga runs during a deployment; an unregistered connector is a
		// configuration error that has to surface as a failed attempt with a
		// code, not as an exception through the request path.
		const s = createYardGenerationSaga({ connectors: new Map() });
		return s.run(planFor("a")).then((result) => {
			expect(result.status).toBe("failed");
			expect(result.failure?.code).toBe("connector-missing");
			expect(result.failure?.retryable).toBe(false);
		});
	});

	test("a successful run provisions once and records the result", async () => {
		const c = connector();
		const s = saga(c);
		const result = await s.run(planFor("a"));
		expect(result.status).toBe("ready");
		expect(c.provisionCalls).toBe(1);
		expect(s.inspect(planFor("a").idempotencyKey)?.status).toBe("ready");
	});

	test("a repeated run with the same key does not provision again", async () => {
		// This is the lease. Provisioning twice for one idempotency key means two
		// Yards billed for one request.
		const c = connector();
		const s = saga(c);
		await s.run(planFor("a"));
		await s.run(planFor("a"));
		expect(c.provisionCalls).toBe(1);
	});

	test("a different key does provision again", async () => {
		const c = connector();
		const s = saga(c);
		await s.run(planFor("a"));
		await s.run(planFor("b"));
		expect(c.provisionCalls).toBe(2);
	});

	test("a terminal failure is returned from the lease without retrying", async () => {
		// Failed is terminal here: re-running the same plan must not silently
		// retry a provisioning that already failed.
		let calls = 0;
		const c = connector({
			async provision(p: YardGenerationPlan) {
				calls += 1;
				return Object.freeze({
					attemptId: p.attemptId,
					status: "failed" as const,
					externalRefs: Object.freeze({}),
					outputHash: contentHashOf({ f: 1 }),
					failure: Object.freeze({
						code: "quota",
						message: "no capacity",
						retryable: true,
					}),
				});
			},
		});
		const s = saga(c);
		expect((await s.run(planFor("a"))).status).toBe("failed");
		expect((await s.run(planFor("a"))).status).toBe("failed");
		expect(calls).toBe(1);
	});

	test("an in-flight attempt is resumed through inspect, not re-provisioned", async () => {
		// A crash mid-provision leaves a `started` record. Re-running must ask
		// the provider what happened rather than starting a second provision.
		let provisions = 0;
		let inspects = 0;
		const c = connector({
			async provision(p: YardGenerationPlan) {
				provisions += 1;
				return Object.freeze({
					attemptId: p.attemptId,
					status: "started" as const,
					externalRefs: Object.freeze({}),
					outputHash: contentHashOf({ s: 1 }),
				});
			},
			async inspect(attemptId: string) {
				inspects += 1;
				return Object.freeze({
					attemptId,
					status: "ready" as const,
					externalRefs: Object.freeze({}),
					outputHash: contentHashOf({ i: 1 }),
				});
			},
		});
		const s = saga(c);
		expect((await s.run(planFor("a"))).status).toBe("started");
		expect((await s.run(planFor("a"))).status).toBe("ready");
		expect(provisions).toBe(1);
		expect(inspects).toBe(1);
	});

	test("a provisioned result is normalised to registered, never to ready", () => {
		// The comment in the source is explicit: provisioned is not ready,
		// because a Yard is only usable once it has been registered with the
		// broker. Letting it read as ready would route traffic to a Yard the
		// inventory has never seen.
		const c = connector({
			async provision(p: YardGenerationPlan) {
				return Object.freeze({
					attemptId: p.attemptId,
					status: "provisioned" as const,
					externalRefs: Object.freeze({}),
					outputHash: contentHashOf({ p: 1 }),
				});
			},
		});
		return saga(c)
			.run(planFor("a"))
			.then((result) => {
				expect(result.status).toBe("registered");
			});
	});

	test("inspect returns undefined for a key that was never run", () => {
		expect(
			createYardGenerationSaga({ connectors: new Map() }).inspect("nope"),
		).toBeUndefined();
	});

	test("resuming an in-flight attempt whose connector vanished fails cleanly", async () => {
		// A connector can be deregistered between the start and the resume; the
		// saga must report that rather than throwing on the undefined lookup.
		const c = connector({
			async provision(p: YardGenerationPlan) {
				return Object.freeze({
					attemptId: p.attemptId,
					status: "started" as const,
					externalRefs: Object.freeze({}),
					outputHash: contentHashOf({ s: 1 }),
				});
			},
		});
		const connectors = new Map([[c.id, c]]);
		const s = createYardGenerationSaga({ connectors });
		await s.run(planFor("a"));
		connectors.delete(c.id);
		const result = await s.run(planFor("a"));
		expect(result.status).toBe("failed");
		expect(result.failure?.code).toBe("connector-missing");
	});
});

describe("localYardInstance", () => {
	test("it produces a ready yard with local defaults", () => {
		// This is the offline/dev Yard; if it were not `ready` the local host
		// path would have nothing to place onto.
		const yard = localYardInstance({
			yardId: "yard:local",
			ownerTenantId: "t1",
			providerId: "local",
		});
		expect(yard.status).toBe("ready");
		expect(yard.runtimeId).toBe("local-runtime");
		expect(yard["layout"].regions).toEqual(["local"]);
		expect(yard["layout"].componentHosts).toEqual(["local", "wasm", "oci"]);
	});

	test("explicit options override each default", () => {
		const yard = localYardInstance({
			yardId: "yard:local",
			ownerTenantId: "t1",
			providerId: "local",
			runtimeId: "custom-rt",
			regions: ["eu-west"],
			residency: ["eu"],
			componentHosts: ["wasm"],
			capabilities: ["host:wasm"],
		});
		expect(yard.runtimeId).toBe("custom-rt");
		expect(yard["layout"].regions).toEqual(["eu-west"]);
		expect(yard["layout"].residency).toEqual(["eu"]);
		expect(yard["layout"].componentHosts).toEqual(["wasm"]);
		expect(yard.capabilities).toEqual(["host:wasm"]);
	});

	test("residency defaults to empty rather than to a placeholder region", () => {
		// A residency claim the operator never made would let a jurisdiction
		// check pass on evidence that does not exist.
		const yard = localYardInstance({
			yardId: "yard:local",
			ownerTenantId: "t1",
			providerId: "local",
		});
		expect(yard["layout"].residency).toEqual([]);
	});

	test("the instance and its nested shape are frozen", () => {
		const yard = localYardInstance({
			yardId: "yard:local",
			ownerTenantId: "t1",
			providerId: "local",
		});
		expect(Object.isFrozen(yard)).toBe(true);
		expect(Object.isFrozen(yard["layout"])).toBe(true);
		expect(Object.isFrozen(yard.capacity)).toBe(true);
	});
});
