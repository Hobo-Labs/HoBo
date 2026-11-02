/**
 * The Registry decides which providers Matching is allowed to see. That makes
 * two of its behaviours load-bearing in a way the happy path never shows:
 *
 *   1. **Approval is the gate, registration is not.** A provider that has been
 *      installed but not approved must be visible to remediation (so an error
 *      can say "you have this, approve it") and invisible to Matching (so a
 *      deploy never lands on it). Collapse those two and an unapproved provider
 *      silently starts receiving production workloads.
 *   2. **`parseRegisteredDefinitions` is parse-don't-validate.** A recorded fact
 *      body is untrusted data replayed from a log written by an older version of
 *      the code. A malformed entry has to be *dropped*, never half-trusted — a
 *      definition with an undefined port would match every request or none,
 *      depending on which comparison happened to run first.
 *
 * These tests drive both, plus the catalog hash (which pins a planning decision
 * to the catalog it was made against, so it must be order-independent) and the
 * reconstructed `satisfies` negotiation, which has to work from recorded data
 * alone because a fact body carries no functions.
 */
import { describe, expect, test } from "vitest";

import { CLOUD_EVENTS } from "../src/events.js";
import {
	approveProviderFact,
	createEventBackedRegistry,
	createRegistryFromProviders,
	definitionsFor,
	foldRegistryStream,
	parseRegisteredDefinitions,
	type RegistrableProvider,
	registerProviderFact,
} from "../src/index.js";

/** A minimal provider whose manifest and capabilities can be varied per test. */
function provider(
	overrides: {
		id?: string;
		regions?: string[];
		ports?: string[];
		manifestCapabilities?: Array<Record<string, JsonValue>>;
		costFacts?: Array<Record<string, JsonValue>>;
		published?: Record<string, string>;
	} = {},
): RegistrableProvider {
	const id = overrides.id ?? "acme";
	const ports = overrides.ports ?? ["database"];
	return {
		id,
		regions: overrides.regions ?? ["us-east"],
		capabilities: ports.map((port) => ({
			port,
			satisfies: (req) =>
				req.port === port ? { kind: "full" } : { kind: "none" as const },
			estimateCost: () => ({
				marginalPrice: "0.10",
				sku: `${id}-${port}-estimated`,
				unit: "hour",
			}),
		})),
		capabilityManifest: () => ({
			providerId: id,
			published: overrides.published ?? {
				"/.well-known/capability-manifest/index.json": '{"v":1}',
			},
			capabilities: { capabilities: overrides.manifestCapabilities ?? [] },
			cost: { facts: overrides.costFacts ?? [] },
		}),
	};
}

describe("definitionsFor", () => {
	test("it produces one definition per capability, id-scoped to the provider", () => {
		const defs = definitionsFor(provider({ ports: ["database", "queue"] }));
		expect(defs.map((d) => d.id)).toEqual(["acme:database", "acme:queue"]);
		expect(defs.every((d) => d.providerId === "acme")).toBe(true);
	});

	test("features come from the manifest entry when it declares them", () => {
		const defs = definitionsFor(
			provider({
				manifestCapabilities: [{ port: "database", features: ["sql", "tx"] }],
			}),
		);
		expect(defs[0]?.features).toEqual(["sql", "tx"]);
	});

	test("features default to empty when the manifest says nothing", () => {
		// An absent feature list must not become "supports everything" — the
		// negotiation below reads this array to decide what is missing.
		expect(definitionsFor(provider())[0]?.features).toEqual([]);
	});

	test("a non-array features field is ignored rather than trusted", () => {
		const defs = definitionsFor(
			provider({
				manifestCapabilities: [{ port: "database", features: "sql" }],
			}),
		);
		expect(defs[0]?.features).toEqual([]);
	});

	test("regions fall back to the provider's own regions", () => {
		// A capability that does not narrow regions inherits the provider's.
		// Defaulting to empty instead would make the definition match nowhere.
		expect(
			definitionsFor(provider({ regions: ["eu-west"] }))[0]?.regions,
		).toEqual(["eu-west"]);
	});

	test("a manifest entry's regions override the provider's", () => {
		const defs = definitionsFor(
			provider({
				regions: ["us-east"],
				manifestCapabilities: [{ port: "database", regions: ["ap-south"] }],
			}),
		);
		expect(defs[0]?.regions).toEqual(["ap-south"]);
	});

	test("cost comes from the cost fact when published, and from the estimate otherwise", () => {
		// The published fact is authoritative pricing; the estimate is the
		// provider's guess. Preferring the guess would put wrong numbers into a
		// plan a user approves.
		const withFact = definitionsFor(
			provider({
				costFacts: [
					{
						port: "database",
						sku: "db-standard",
						unit: "month",
						marginalPrice: "9.99",
					},
				],
			}),
		);
		expect(withFact[0]?.cost).toEqual({
			sku: "db-standard",
			unit: "month",
			marginalPrice: "9.99",
		});

		const withoutFact = definitionsFor(provider());
		expect(withoutFact[0]?.cost.sku).toBe("acme-database-estimated");
		expect(withoutFact[0]?.cost.marginalPrice).toBe("0.10");
	});

	test("a partial cost fact falls back per-field", () => {
		// Publishing only a SKU must not blank out the unit and price.
		const defs = definitionsFor(
			provider({ costFacts: [{ port: "database", sku: "db-standard" }] }),
		);
		expect(defs[0]?.cost.sku).toBe("db-standard");
		expect(defs[0]?.cost.unit).toBe("hour");
		expect(defs[0]?.cost.marginalPrice).toBe("0.10");
	});

	test("a cost fact for another port is not applied", () => {
		const defs = definitionsFor(
			provider({ costFacts: [{ port: "queue", sku: "wrong" }] }),
		);
		expect(defs[0]?.cost.sku).toBe("acme-database-estimated");
	});

	test("default provider definitions share a base specificity", () => {
		// Explicit platform definitions are meant to outscore these; a higher
		// default here would make a provider default beat an operator's override.
		const defs = definitionsFor(provider());
		expect(defs[0]?.specificity).toBe(10);
		expect(defs[0]?.priority).toBe(0);
	});

	test("satisfies delegates to the live capability and is normalised", () => {
		const defs = definitionsFor(provider());
		expect(defs[0]?.satisfies({ port: "database" })).toEqual({ kind: "full" });
		expect(defs[0]?.satisfies({ port: "other" })).toEqual({ kind: "none" });
	});

	test("a partial verdict with no missing list is normalised to an empty one", () => {
		// Downstream reads `.missing` unconditionally; leaving it undefined would
		// crash the remediation that explains what is missing.
		const p = provider();
		const capability = p.capabilities[0];
		if (!capability) throw new Error("fixture should have a capability");
		const partial: RegistrableProvider = {
			...p,
			capabilities: [{ ...capability, satisfies: () => ({ kind: "partial" }) }],
		};
		expect(definitionsFor(partial)[0]?.satisfies({ port: "database" })).toEqual(
			{
				kind: "partial",
				missing: [],
			},
		);
	});

	test("an unrecognised verdict kind is normalised to none", () => {
		// Fail closed: a verdict the registry does not understand must not be
		// treated as a match.
		const p = provider();
		const capability = p.capabilities[0];
		if (!capability) throw new Error("fixture should have a capability");
		const weird: RegistrableProvider = {
			...p,
			capabilities: [
				{ ...capability, satisfies: () => ({ kind: "something-else" }) },
			],
		};
		expect(definitionsFor(weird)[0]?.satisfies({ port: "database" })).toEqual({
			kind: "none",
		});
	});
});

describe("createRegistryFromProviders", () => {
	test("it exposes every provider's definitions", () => {
		const registry = createRegistryFromProviders([
			provider({ id: "a" }),
			provider({ id: "b" }),
		]);
		expect(registry.providers()).toEqual(["a", "b"]);
		expect(registry.definitions()).toHaveLength(2);
	});

	test("duplicate provider ids are listed once", () => {
		const registry = createRegistryFromProviders([
			provider({ id: "a" }),
			provider({ id: "a", ports: ["queue"] }),
		]);
		expect(registry.providers()).toEqual(["a"]);
	});

	test("definitions are handed out as copies", () => {
		// The registry is consulted repeatedly during planning; a caller that
		// mutated a definition would change what every later plan sees.
		const registry = createRegistryFromProviders([provider()]);
		const first = registry.definitions();
		const firstDef = first[0];
		if (!firstDef) throw new Error("expected a definition");
		firstDef.specificity = 999;
		expect(registry.definitions()[0]?.specificity).toBe(10);
	});

	test("the catalog hash is stable and order-independent", () => {
		// A plan pins the hash of the catalog it was made against. If provider
		// ordering changed it, every replan would look like the catalog moved.
		const forward = createRegistryFromProviders([
			provider({ id: "a" }),
			provider({ id: "b" }),
		]);
		const reverse = createRegistryFromProviders([
			provider({ id: "b" }),
			provider({ id: "a" }),
		]);
		expect(forward.catalogHash).toBe(reverse.catalogHash);
		expect(forward.catalogHash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("feature order does not change the hash", () => {
		const a = createRegistryFromProviders([
			provider({
				manifestCapabilities: [{ port: "database", features: ["tx", "sql"] }],
			}),
		]);
		const b = createRegistryFromProviders([
			provider({
				manifestCapabilities: [{ port: "database", features: ["sql", "tx"] }],
			}),
		]);
		expect(a.catalogHash).toBe(b.catalogHash);
	});

	test("a different price does change the hash", () => {
		// Price is part of the catalog identity, because a plan approved at one
		// price must not silently be executed at another.
		const a = createRegistryFromProviders([
			provider({ costFacts: [{ port: "database", marginalPrice: "1.00" }] }),
		]);
		const b = createRegistryFromProviders([
			provider({ costFacts: [{ port: "database", marginalPrice: "2.00" }] }),
		]);
		expect(a.catalogHash).not.toBe(b.catalogHash);
	});

	test("an empty registry still produces a hash", () => {
		expect(createRegistryFromProviders([]).catalogHash).toMatch(
			/^sha256:[0-9a-f]{64}$/,
		);
	});
});

describe("parseRegisteredDefinitions", () => {
	function fact(definitions: JsonValue, providerId: JsonValue = "acme") {
		return { providerId, definitions };
	}

	test("a well-formed body parses every entry", () => {
		const defs = parseRegisteredDefinitions(
			fact([
				{ id: "acme:db", port: "database", features: ["sql"], regions: ["eu"] },
			]),
		);
		expect(defs).toHaveLength(1);
		expect(defs[0]?.port).toBe("database");
		expect(defs[0]?.features).toEqual(["sql"]);
	});

	test("a non-object body yields nothing rather than throwing", () => {
		// This runs over replayed log data; a throw here would make one bad
		// record unrecoverable for the whole registry.
		for (const bad of [null, undefined, "text", 42, true]) {
			expect(parseRegisteredDefinitions(bad)).toEqual([]);
		}
	});

	test("a body with no provider id yields nothing", () => {
		// Every definition is scoped by provider; without one they would be
		// unattributable and could not be approved or held.
		//
		// The absent case is built literally rather than via `fact(..., undefined)`
		// — passing undefined to the helper would just trigger its default and
		// test nothing.
		expect(
			parseRegisteredDefinitions({ definitions: [{ port: "db" }] }),
		).toEqual([]);
		expect(parseRegisteredDefinitions(fact([{ port: "db" }], ""))).toEqual([]);
		expect(parseRegisteredDefinitions(fact([{ port: "db" }], 42))).toEqual([]);
	});

	test("a non-array definitions field yields nothing", () => {
		expect(parseRegisteredDefinitions(fact("not-an-array"))).toEqual([]);
		expect(parseRegisteredDefinitions(fact(undefined))).toEqual([]);
	});

	test("an entry with no usable port is dropped, not half-trusted", () => {
		// The core parse-don't-validate rule. A definition whose port is
		// undefined would compare unequal to every request — or equal to another
		// undefined — and either outcome is a silent mismatch.
		const defs = parseRegisteredDefinitions(
			fact([
				{ port: "" },
				{ port: 42 },
				{ port: null },
				{},
				null,
				"string-entry",
				{ port: "good" },
			]),
		);
		expect(defs.map((d) => d.port)).toEqual(["good"]);
	});

	test("non-string features and regions are filtered out element-wise", () => {
		// One bad element must not discard the good ones alongside it.
		const defs = parseRegisteredDefinitions(
			fact([{ port: "db", features: ["sql", 42, null], regions: ["eu", {}] }]),
		);
		expect(defs[0]?.features).toEqual(["sql"]);
		expect(defs[0]?.regions).toEqual(["eu"]);
	});

	test("a missing id is synthesised from the provider and port", () => {
		const defs = parseRegisteredDefinitions(fact([{ port: "database" }]));
		expect(defs[0]?.id).toBe("acme:database");
	});

	test("an empty-string id is replaced rather than kept", () => {
		expect(
			parseRegisteredDefinitions(fact([{ id: "", port: "database" }]))[0]?.id,
		).toBe("acme:database");
	});

	test("specificity and priority fall back to the defaults when not numbers", () => {
		const defs = parseRegisteredDefinitions(
			fact([{ port: "db", specificity: "high", priority: null }]),
		);
		expect(defs[0]?.specificity).toBe(10);
		expect(defs[0]?.priority).toBe(0);
	});

	test("a zero specificity is preserved, not treated as absent", () => {
		// `typeof === "number"` rather than truthiness — a deliberately
		// deprioritised definition must stay deprioritised.
		const defs = parseRegisteredDefinitions(
			fact([{ port: "db", specificity: 0, priority: 0 }]),
		);
		expect(defs[0]?.specificity).toBe(0);
	});

	test("missing cost fields fall back to derived defaults", () => {
		const defs = parseRegisteredDefinitions(fact([{ port: "database" }]));
		expect(defs[0]?.cost).toEqual({
			sku: "acme-database",
			unit: "hour",
			marginalPrice: "0",
		});
	});

	test("a non-object cost field does not crash the parse", () => {
		const defs = parseRegisteredDefinitions(
			fact([{ port: "db", cost: "free" }]),
		);
		expect(defs[0]?.cost.unit).toBe("hour");
	});

	test("the reconstructed satisfies negotiates from recorded features alone", () => {
		// A fact body carries data, never functions, so the negotiation has to be
		// rebuilt. Getting this wrong would make every replayed provider either
		// match everything or nothing.
		const defs = parseRegisteredDefinitions(
			fact([{ port: "database", features: ["sql", "tx"] }]),
		);
		const satisfies = defs[0]?.satisfies;
		if (!satisfies) throw new Error("expected a definition");
		expect(satisfies({ port: "database" })).toEqual({ kind: "full" });
		expect(satisfies({ port: "database", features: ["sql"] })).toEqual({
			kind: "full",
		});
		expect(
			satisfies({ port: "database", features: ["sql", "vector"] }),
		).toEqual({ kind: "partial", missing: ["vector"] });
		expect(satisfies({ port: "queue" })).toEqual({ kind: "none" });
	});

	test("a port mismatch outranks a feature match", () => {
		// Otherwise a request for the queue port could be satisfied by the
		// database definition purely because the feature names lined up.
		const defs = parseRegisteredDefinitions(
			fact([{ port: "database", features: ["sql"] }]),
		);
		expect(defs[0]?.satisfies({ port: "queue", features: ["sql"] })).toEqual({
			kind: "none",
		});
	});
});

describe("foldRegistryStream", () => {
	function registered(providerId: string, ports: string[] = ["database"]) {
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		return {
			type: CLOUD_EVENTS.ProviderRegistered,
			data: {
				providerId,
				definitions: ports.map((port) => ({ port })),
			},
		};
	}
	function approved(providerId: JsonValue) {
		return { type: CLOUD_EVENTS.ProviderApproved, data: { providerId } };
	}

	test("registration installs and approval approves, separately", () => {
		const fold = foldRegistryStream([registered("a"), approved("a")]);
		expect([...fold.installed.keys()]).toEqual(["a"]);
		expect([...fold.approved]).toEqual(["a"]);
	});

	test("registering without approving leaves the provider unapproved", () => {
		// The whole gate: installed is not matchable.
		const fold = foldRegistryStream([registered("a")]);
		expect(fold.installed.has("a")).toBe(true);
		expect(fold.approved.has("a")).toBe(false);
	});

	test("re-registration is last-write-wins", () => {
		const fold = foldRegistryStream([
			registered("a", ["database"]),
			registered("a", ["queue", "cache"]),
		]);
		expect(fold.installed.get("a")?.map((d) => d.port)).toEqual([
			"queue",
			"cache",
		]);
	});

	test("a registration whose body parses to nothing installs nothing", () => {
		// The provider id is read off the parsed definitions, so a body that
		// parsed to zero entries has no id to key on — and must not create an
		// empty installed row that `held()` would then report as a real provider.
		const fold = foldRegistryStream([
			{ type: CLOUD_EVENTS.ProviderRegistered, data: { providerId: "a" } },
			{ type: CLOUD_EVENTS.ProviderRegistered, data: null },
		]);
		expect(fold.installed.size).toBe(0);
	});

	test("an approval with no usable provider id is ignored", () => {
		// A malformed approval must never widen the approved set — that set is
		// the security gate.
		const fold = foldRegistryStream([
			approved(undefined),
			approved(""),
			approved(42),
			approved(null),
		]);
		expect(fold.approved.size).toBe(0);
	});

	test("approving a provider that was never registered is recorded but installs nothing", () => {
		// Order is not guaranteed on a replayed log; the approval has to survive
		// so a later registration is immediately matchable.
		const fold = foldRegistryStream([approved("a")]);
		expect(fold.approved.has("a")).toBe(true);
		expect(fold.installed.size).toBe(0);
	});

	test("approval before registration still ends approved", () => {
		const fold = foldRegistryStream([approved("a"), registered("a")]);
		expect(fold.approved.has("a")).toBe(true);
		expect(fold.installed.has("a")).toBe(true);
	});

	test("unrelated event types are ignored", () => {
		const fold = foldRegistryStream([
			{ type: "deploy.Started", data: { providerId: "a" } },
		]);
		expect(fold.installed.size).toBe(0);
		expect(fold.approved.size).toBe(0);
	});

	test("an empty stream folds to an empty snapshot", () => {
		const fold = foldRegistryStream([]);
		expect(fold.installed.size).toBe(0);
		expect(fold.approved.size).toBe(0);
	});
});

describe("the event-backed registry", () => {
	function storeOf(events: Array<{ type: string; data?: unknown }>) {
		// SAFETY: this fixture implements the store read contract used by the event-backed registry.
		return {
			async *read() {
				let seq = 0;
				for (const event of events) {
					seq += 1;
					yield {
						id: `e-${seq}`,
						type: event.type,
						v: 1,
						streamId: "registry",
						seq,
						ts: "2026-01-01T00:00:00.000Z",
						actor: { kind: "service" as const, id: "registry" },
						tenant: "t",
						data: event.data,
					};
				}
			},
		} as Parameters<typeof createEventBackedRegistry>[0]["store"];
	}

	function registryOver(
		events: Array<{ type: string; data?: unknown }>,
		base?: ReturnType<typeof createRegistryFromProviders>,
	) {
		return createEventBackedRegistry({
			store: storeOf(events),
			streamId: "registry",
			...(base !== undefined && { base }),
		});
	}

	const REGISTERED_A = {
		type: CLOUD_EVENTS.ProviderRegistered,
		data: {
			providerId: "installed-a",
			definitions: [{ port: "database" }, { port: "queue" }],
		},
	};
	const APPROVED_A = {
		type: CLOUD_EVENTS.ProviderApproved,
		data: { providerId: "installed-a" },
	};

	test("before a refresh it exposes only the base providers", () => {
		// The stream read is async; the Planner's view is sync. Exposing stream
		// data before it has been folded would be a lie about what was read.
		const registry = registryOver(
			[REGISTERED_A, APPROVED_A],
			createRegistryFromProviders([provider({ id: "base-a" })]),
		);
		expect(registry.providers()).toEqual(["base-a"]);
		expect(registry.held()).toEqual([]);
	});

	test("after a refresh an approved installed provider is matchable", async () => {
		const registry = registryOver([REGISTERED_A, APPROVED_A]);
		await registry.refresh();
		expect(registry.providers()).toEqual(["installed-a"]);
		expect(registry.definitions()).toHaveLength(2);
	});

	test("an unapproved installed provider is held, not matchable", async () => {
		// The central rule. It must appear in `held()` so a remediation can name
		// it, and be absent from `providers()` so Matching cannot select it.
		const registry = registryOver([REGISTERED_A]);
		await registry.refresh();
		expect(registry.providers()).toEqual([]);
		expect(registry.definitions()).toEqual([]);
		expect(registry.held()).toEqual([
			{ providerId: "installed-a", ports: ["database", "queue"] },
		]);
	});

	test("held ports are deduplicated and sorted", () => {
		// A remediation message reads these; unstable ordering would make the
		// same advice render differently run to run.
		const registry = registryOver([
			{
				type: CLOUD_EVENTS.ProviderRegistered,
				data: {
					providerId: "p",
					definitions: [
						{ port: "queue" },
						{ port: "database" },
						{ port: "queue" },
					],
				},
			},
		]);
		return registry.refresh().then(() => {
			expect(registry.held()[0]?.ports).toEqual(["database", "queue"]);
		});
	});

	test("held rows are sorted by provider id", async () => {
		const registry = registryOver([
			{
				type: CLOUD_EVENTS.ProviderRegistered,
				data: { providerId: "z", definitions: [{ port: "a" }] },
			},
			{
				type: CLOUD_EVENTS.ProviderRegistered,
				data: { providerId: "a", definitions: [{ port: "a" }] },
			},
		]);
		await registry.refresh();
		expect(registry.held().map((h) => h.providerId)).toEqual(["a", "z"]);
	});

	test("held rows are handed out as copies", async () => {
		const registry = registryOver([REGISTERED_A]);
		await registry.refresh();
		const rows = registry.held();
		rows[0]?.ports.push("injected");
		expect(registry.held()[0]?.ports).toEqual(["database", "queue"]);
	});

	test("a base provider wins over an installed one with the same id", async () => {
		// A compiled-in provider is the live implementation; the recorded
		// definitions are a snapshot that may be stale. Preferring the snapshot
		// would plan against capabilities the running code no longer has.
		const registry = registryOver(
			[
				{
					type: CLOUD_EVENTS.ProviderRegistered,
					data: {
						providerId: "acme",
						definitions: [{ port: "stale-port" }],
					},
				},
				{ type: CLOUD_EVENTS.ProviderApproved, data: { providerId: "acme" } },
			],
			createRegistryFromProviders([provider({ id: "acme", ports: ["live"] })]),
		);
		await registry.refresh();
		expect(registry.definitions().map((d) => d.port)).toEqual(["live"]);
	});

	test("base and installed providers with different ids both appear", async () => {
		const registry = registryOver(
			[REGISTERED_A, APPROVED_A],
			createRegistryFromProviders([provider({ id: "base-a" })]),
		);
		await registry.refresh();
		expect(registry.providers().sort()).toEqual(["base-a", "installed-a"]);
	});

	test("the catalog hash moves when a refresh brings in new definitions", async () => {
		// The hash is what pins a plan to a catalog. If it did not move, a plan
		// made before the approval would look valid against the wider catalog.
		const registry = registryOver([REGISTERED_A, APPROVED_A]);
		const before = registry.catalogHash;
		await registry.refresh();
		expect(registry.catalogHash).not.toBe(before);
	});

	test("a refresh that changes nothing leaves the hash alone", async () => {
		const registry = registryOver([REGISTERED_A, APPROVED_A]);
		await registry.refresh();
		const after = registry.catalogHash;
		await registry.refresh();
		expect(registry.catalogHash).toBe(after);
	});

	test("definitions are handed out as copies here too", async () => {
		const registry = registryOver([REGISTERED_A, APPROVED_A]);
		await registry.refresh();
		const defs = registry.definitions();
		const first = defs[0];
		if (!first) throw new Error("expected a definition");
		first.port = "mutated";
		expect(registry.definitions()[0]?.port).not.toBe("mutated");
	});

	test("an empty stream refreshes to an empty registry", async () => {
		const registry = registryOver([]);
		await registry.refresh();
		expect(registry.providers()).toEqual([]);
		expect(registry.held()).toEqual([]);
	});
});

describe("the registration and approval facts", () => {
	test("a registration fact carries the definitions and a manifest digest", () => {
		// The digest is how a later reader confirms the recorded definitions came
		// from the manifest the provider actually published.
		const fact = registerProviderFact(provider({ ports: ["database"] }));
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const data = fact.data as {
			providerId: string;
			definitions: Array<{ port: string }>;
			manifestIndexDigest: string;
		};
		expect(data.providerId).toBe("acme");
		expect(data.definitions.map((d) => d.port)).toEqual(["database"]);
		expect(data.manifestIndexDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("the recorded definitions carry data only, never the satisfies function", () => {
		// A fact body is serialised to a log. A function on it would be dropped
		// silently on the way out and be undefined on the way back in — which is
		// exactly why the parse rebuilds the negotiation.
		const fact = registerProviderFact(provider());
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const first = (fact.data as { definitions: Array<Record<string, JsonValue>> })
			.definitions[0];
		expect(first && "satisfies" in first).toBe(false);
	});

	test("a provider publishing no manifest index still digests deterministically", () => {
		// The lookup falls back to the empty string; two such providers must not
		// produce differing digests run to run.
		const a = registerProviderFact(provider({ published: {} }));
		const b = registerProviderFact(provider({ published: {} }));
		// SAFETY: registerProviderFact emits manifestIndexDigest in its event body.
		expect(
			(a.data as { manifestIndexDigest: string }).manifestIndexDigest,
		).toBe((b.data as { manifestIndexDigest: string }).manifestIndexDigest);
	});

	test("a different manifest yields a different digest", () => {
		const a = registerProviderFact(
			provider({
				published: { "/.well-known/capability-manifest/index.json": '{"v":1}' },
			}),
		);
		const b = registerProviderFact(
			provider({
				published: { "/.well-known/capability-manifest/index.json": '{"v":2}' },
			}),
		);
		// SAFETY: registerProviderFact emits manifestIndexDigest in its event body.
		expect(
			(a.data as { manifestIndexDigest: string }).manifestIndexDigest,
		).not.toBe((b.data as { manifestIndexDigest: string }).manifestIndexDigest);
	});

	test("an approval fact records the approver when one is named", () => {
		// Approval is a security decision; who made it is the audit trail.
		const withApprover = approveProviderFact("acme", "user:alice");
		expect(withApprover.data).toEqual({
			providerId: "acme",
			approvedBy: "user:alice",
		});
	});

	test("an approval fact omits the approver rather than storing undefined", () => {
		const anonymous = approveProviderFact("acme");
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		expect("approvedBy" in (anonymous.data as object)).toBe(false);
	});

	test("a registration fact round-trips through the parse", () => {
		// The end-to-end property: what the registry writes, the registry can
		// read back into equivalent definitions.
		const fact = registerProviderFact(
			provider({
				manifestCapabilities: [{ port: "database", features: ["sql"] }],
			}),
		);
		const parsed = parseRegisteredDefinitions(fact.data);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.port).toBe("database");
		expect(parsed[0]?.features).toEqual(["sql"]);
		expect(
			parsed[0]?.satisfies({ port: "database", features: ["sql"] }),
		).toEqual({ kind: "full" });
	});
});
import type { JsonValue } from "../src/plan-types.js";
