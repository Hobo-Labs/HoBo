/**
 * The Railway provider's parser boundary, its authoring options, and the
 * refusal it publishes instead of a temporary station.
 *
 * Three properties are worth holding here, and none is obvious from the types.
 *
 * The **parser is the only boundary**. Nothing past `parse.ts` re-checks a port,
 * a name, or a binding value, so anything the parser lets through is treated as
 * realizable for the rest of the package's life. A hole here does not surface as
 * a parse failure — it surfaces as a driver program with an unusable resource
 * name, three frames away from the input that caused it.
 *
 * **Bindings are locators, not documents.** Deploy outputs become environment
 * material. A control character or a multi-kilobyte blob in that map means
 * something upstream handed us a document — possibly with a credential in it —
 * and the printable-single-line rule is what stops it from being pasted into an
 * environment verbatim.
 *
 * **The temporary-station path fails closed.** Railway has no password-free
 * provisioning API, and the refusal is published *as data* so the yard plane can
 * record why a placement was rejected without catching an exception to find out.
 */
import { describe, expect, it } from "vitest";

import {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	railwayNativePorts,
} from "../src/equivalence.js";
import { PROVIDER_TARGET, railway } from "../src/options.js";
import {
	parseRailwayBindings,
	parseRailwayPort,
	parseRailwayResourceName,
	parseRailwayResourcePlan,
	RAILWAY_PORTS,
	RAILWAY_REJECTED_CODE,
	RailwayInputRejectedError,
	railwayPortOrUndefined,
} from "../src/parse.js";
import { createRailwayProvider } from "../src/provider.js";
import {
	provisionTemporaryEnvironmentStation,
	railwayTemporaryStationRefusal,
	supportsAnonymousTemporaryDeploy,
	TEMPORARY_PROVISION_UNAVAILABLE_CODE,
	TemporaryProvisionUnavailableError,
} from "../src/temporary-station.js";

const PLAN = { name: "api", port: "compute", require: [], prefer: [] };

describe("authoring options", () => {
	it("names railway as the provider target on every block", () => {
		// The block is matched against a provider id during placement. A block
		// that named nobody would be dropped silently rather than refused.
		expect(railway.with.service().providerId).toBe(PROVIDER_TARGET);
		expect(railway.with.redis().providerId).toBe(PROVIDER_TARGET);
	});

	it("negotiates by preference, not requirement", () => {
		// `prefer` means placement may pick another provider when Railway cannot
		// serve the port. `require` would turn a routine substitution into a
		// deploy failure, which is not what a typed option block should mean.
		expect(railway.with.service().negotiation).toBe("prefer");
		expect(railway.with.redis().negotiation).toBe("prefer");
	});

	it("targets the compute port for a service and the kv port for redis", () => {
		expect(railway.with.service().port).toBe("compute");
		expect(railway.with.redis().port).toBe("kv");
	});

	it("names the option so two blocks on one port stay distinguishable", () => {
		expect(railway.with.service().optionName).toBe("service");
		expect(railway.with.redis().optionName).toBe("redis");
	});

	it("defaults a service to the container runtime", () => {
		// The default that makes `railway.with.service()` authorable with no
		// arguments at all. Without it the caller would have to know Railway's
		// runtime vocabulary to write the simplest possible block.
		expect(railway.with.service().options).toEqual({ runtime: "container" });
	});

	it("lets caller options override the defaults rather than merging under them", () => {
		// `{ ...defaults, ...options }`. If the spread were the other way round an
		// explicit runtime would be silently discarded, and the block would deploy
		// something the author did not ask for with nothing recording the swap.
		expect(railway.with.service({ runtime: "nixpacks" }).options).toEqual({
			runtime: "nixpacks",
		});
	});

	it("carries extra options through alongside the defaults", () => {
		expect(railway.with.service({ replicas: 3 }).options).toEqual({
			runtime: "container",
			replicas: 3,
		});
	});

	it("gives redis no defaults to override", () => {
		expect(railway.with.redis().options).toEqual({});
		expect(railway.with.redis({ evictionPolicy: "lru" }).options).toEqual({
			evictionPolicy: "lru",
		});
	});

	it("returns a fresh block per call", () => {
		// Blocks are held in authoring code and sometimes mutated by it. A shared
		// object would let one deployment's options leak into another's.
		const first = railway.with.service();
		first.options.runtime = "mutated";
		expect(railway.with.service().options.runtime).toBe("container");
	});
});

describe("equivalence table", () => {
	it("lists every class key as an initial capability port", () => {
		expect([...INITIAL_CAPABILITY_PORTS].sort()).toEqual(
			Object.keys(EQUIVALENCE_CLASSES).sort(),
		);
	});

	it("returns the mapping for a class key", () => {
		expect(equivalenceForPort("kv").resourceClass).toBe("railway:redis");
		expect(equivalenceForPort("web/service").port).toBe("compute");
		expect(equivalenceForPort("queue").providerService).toBe("Railway Queue");
	});

	it("reports native ports de-duplicated", () => {
		// The class keys and the ports are different vocabularies — `web/service`
		// maps to `compute`. A native-ports list that repeated a port would make a
		// provider look like it served the same port twice during ranking.
		const ports = railwayNativePorts();
		expect(new Set(ports).size).toBe(ports.length);
		expect([...ports].sort()).toEqual(["compute", "kv", "queue"]);
	});

	it("freezes the table, so a consumer cannot repoint a resource class", () => {
		// Read on every realize. A mutated entry would silently change what every
		// later deploy provisions.
		expect(Object.isFrozen(EQUIVALENCE_CLASSES)).toBe(true);
		expect(Object.isFrozen(INITIAL_CAPABILITY_PORTS)).toBe(true);
	});

	it("derives the parser's port union from the same table", () => {
		// The derivation is what makes `equivalenceFor` total in provider.ts: a
		// parsed port cannot fail to have a class, because the union has no member
		// the table lacks.
		expect([...RAILWAY_PORTS].sort()).toEqual([...railwayNativePorts()].sort());
	});
});

describe("railwayPortOrUndefined", () => {
	it("accepts each realizable port", () => {
		for (const port of RAILWAY_PORTS) {
			expect(railwayPortOrUndefined(port)).toBe(port);
		}
	});

	it("answers undefined rather than throwing for a port that is not ours", () => {
		// Matching asks every provider about every port, so "not mine" is the
		// common case. An exception here would make the normal path cost a throw
		// and would tempt callers to wrap it in a try/catch that swallowed real
		// parse failures too.
		expect(railwayPortOrUndefined("blob")).toBeUndefined();
		expect(railwayPortOrUndefined("web/service")).toBeUndefined();
	});

	it("answers undefined for a non-string", () => {
		for (const value of [undefined, null, 7, {}, [], Symbol("compute")]) {
			expect(railwayPortOrUndefined(value)).toBeUndefined();
		}
	});

	it("is case-sensitive", () => {
		// The port vocabulary is exact. Accepting `COMPUTE` would let one manifest
		// spell a port two ways and make an equality comparison elsewhere fail.
		expect(railwayPortOrUndefined("Compute")).toBeUndefined();
	});
});

describe("parseRailwayPort", () => {
	it("returns the port when it is realizable", () => {
		expect(parseRailwayPort("kv")).toBe("kv");
	});

	it("refuses a port this provider does not realize", () => {
		expect(() => parseRailwayPort("blob")).toThrow(RailwayInputRejectedError);
	});

	it("names the ports it does realize in the message", () => {
		// So the caller can fix the input from the error alone rather than reading
		// the equivalence table.
		try {
			parseRailwayPort("blob");
			expect.unreachable("an unrealizable port must be refused");
		} catch (error) {
			const message = (error as Error).message;
			for (const port of RAILWAY_PORTS) expect(message).toContain(port);
			expect(message).toContain('"blob"');
		}
	});

	it("carries the stable code and the field it rejected", () => {
		// The code is what a caller branches on; the field is what an operator
		// looks at. A message-only error would force string matching on prose.
		try {
			parseRailwayPort(undefined, "client.port");
			expect.unreachable("undefined is not a port");
		} catch (error) {
			expect((error as RailwayInputRejectedError).code).toBe(
				RAILWAY_REJECTED_CODE,
			);
			expect((error as RailwayInputRejectedError).field).toBe("client.port");
			expect((error as Error).name).toBe("RailwayInputRejectedError");
		}
	});

	it("defaults the field name to port", () => {
		try {
			parseRailwayPort(1);
			expect.unreachable("a number is not a port");
		} catch (error) {
			expect((error as RailwayInputRejectedError).field).toBe("port");
		}
	});
});

describe("parseRailwayResourceName", () => {
	it("accepts a DNS label", () => {
		for (const name of ["api", "a", "web-01", "x9", "a-b-c"]) {
			expect(parseRailwayResourceName(name)).toBe(name);
		}
	});

	it("accepts a 63-character label and refuses a 64-character one", () => {
		// The boundary is the DNS label limit. One character over produces a name
		// that resolvers truncate or reject, and the failure would appear as an
		// unreachable endpoint rather than as a rejected deploy.
		expect(() => parseRailwayResourceName("a".repeat(63))).not.toThrow();
		expect(() => parseRailwayResourceName("a".repeat(64))).toThrow(
			RailwayInputRejectedError,
		);
	});

	it("refuses a name that starts or ends with a hyphen", () => {
		// Both are invalid DNS labels. A leading hyphen in particular is also how
		// a value gets mistaken for a flag by anything that shells out.
		expect(() => parseRailwayResourceName("-api")).toThrow();
		expect(() => parseRailwayResourceName("api-")).toThrow();
	});

	it("refuses uppercase, underscores, dots, and spaces", () => {
		for (const name of ["API", "my_api", "api.example", "my api", "api/v1"]) {
			expect(() => parseRailwayResourceName(name)).toThrow(
				RailwayInputRejectedError,
			);
		}
	});

	it("refuses an empty name", () => {
		// An empty name would produce a resource the driver program cannot address
		// and an endpoint nothing can reach.
		expect(() => parseRailwayResourceName("")).toThrow();
	});

	it("refuses a non-string", () => {
		for (const value of [undefined, null, 7, {}, ["api"]]) {
			expect(() => parseRailwayResourceName(value)).toThrow(
				RailwayInputRejectedError,
			);
		}
	});

	it("reports the field it was given", () => {
		try {
			parseRailwayResourceName("BAD", "plan.name");
			expect.unreachable("uppercase is not a DNS label");
		} catch (error) {
			expect((error as RailwayInputRejectedError).field).toBe("plan.name");
		}
	});
});

describe("parseRailwayResourcePlan", () => {
	it("returns a frozen plan", () => {
		// Held past the parser and read by the driver builder. Freezing is what
		// makes "nothing past the parser re-checks this" safe to rely on.
		expect(Object.isFrozen(parseRailwayResourcePlan(PLAN))).toBe(true);
	});

	it("carries the name and port through", () => {
		const parsed = parseRailwayResourcePlan(PLAN);
		expect(parsed.name).toBe("api");
		expect(parsed.port).toBe("compute");
	});

	it("treats absent feature lists as empty rather than undefined", () => {
		// So downstream code can iterate unconditionally. An undefined here would
		// make every consumer write the same nullish guard, and one of them would
		// eventually forget.
		const parsed = parseRailwayResourcePlan({ name: "api", port: "compute" });
		expect(parsed.require).toEqual([]);
		expect(parsed.prefer).toEqual([]);
		expect(Object.isFrozen(parsed.require)).toBe(true);
	});

	it("parses feature names on both lists", () => {
		const parsed = parseRailwayResourcePlan({
			name: "api",
			port: "compute",
			require: ["http"],
			prefer: ["managed", "auto-scale"],
		});
		expect(parsed.require).toEqual(["http"]);
		expect(parsed.prefer).toEqual(["managed", "auto-scale"]);
	});

	it("refuses a feature list that is not an array", () => {
		// A string would otherwise be iterated character by character, producing a
		// requirement list of single letters that matched nothing.
		expect(() =>
			parseRailwayResourcePlan({ ...PLAN, require: "http" }),
		).toThrow(RailwayInputRejectedError);
	});

	it("refuses a feature name that is not lowercase and hyphenated", () => {
		// Matching compares feature strings exactly. `HTTP` and `http` would be
		// two different features, and a requirement spelled the wrong way would
		// quietly match nothing rather than failing.
		for (const feature of ["HTTP", "http_2", "http 2", "2fast", "", " http"]) {
			expect(() =>
				parseRailwayResourcePlan({ ...PLAN, prefer: [feature] }),
			).toThrow(RailwayInputRejectedError);
		}
	});

	it("names which list a bad feature came from", () => {
		try {
			parseRailwayResourcePlan({ ...PLAN, prefer: ["BAD"] });
			expect.unreachable("an uppercase feature must be refused");
		} catch (error) {
			expect((error as RailwayInputRejectedError).field).toBe("plan.prefer");
		}
	});

	it("refuses a non-object plan, including an array", () => {
		// An array passes a naive `typeof value === "object"` check and would then
		// read `undefined` for every field, producing a name error that pointed at
		// the wrong problem.
		for (const value of [undefined, null, "api", 7, ["api"]]) {
			expect(() => parseRailwayResourcePlan(value)).toThrow(
				RailwayInputRejectedError,
			);
		}
	});

	it("reports the plan field when the plan itself is the wrong shape", () => {
		try {
			parseRailwayResourcePlan([]);
			expect.unreachable("an array is not a plan");
		} catch (error) {
			expect((error as RailwayInputRejectedError).field).toBe("plan");
		}
	});
});

describe("parseRailwayBindings", () => {
	it("returns a frozen map of the bindings", () => {
		const bindings = parseRailwayBindings({ DATABASE_URL: "postgres://host" });
		expect(bindings).toEqual({ DATABASE_URL: "postgres://host" });
		expect(Object.isFrozen(bindings)).toBe(true);
	});

	it("accepts an empty map", () => {
		// A deploy that produced no outputs is a legitimate result, not an error.
		expect(parseRailwayBindings({})).toEqual({});
	});

	it("accepts identifier-shaped keys", () => {
		for (const key of ["A", "_a", "PORT", "DB_URL_2", "_"]) {
			expect(parseRailwayBindings({ [key]: "v" })).toHaveProperty(key);
		}
	});

	it("refuses a key that is not an identifier", () => {
		// These become environment variables. A key with a hyphen, a dot, or a
		// newline in it is either unexportable or, worse, a way to smuggle a
		// second assignment into a generated env file.
		for (const key of ["9LEAD", "my-key", "my.key", "a b", "", "K\nEY"]) {
			expect(() => parseRailwayBindings({ [key]: "v" })).toThrow(
				RailwayInputRejectedError,
			);
		}
	});

	it("accepts a 128-character key and refuses 129", () => {
		// `[A-Za-z_][A-Za-z0-9_]{0,127}` — a leading character plus 127, so 128
		// total. Pinned at the boundary because an off-by-one in the other
		// direction would silently reject a legitimate long output name.
		expect(() =>
			parseRailwayBindings({ ["A".repeat(128)]: "v" }),
		).not.toThrow();
		expect(() => parseRailwayBindings({ ["A".repeat(129)]: "v" })).toThrow(
			RailwayInputRejectedError,
		);
	});

	it("refuses a non-string binding value", () => {
		// Numbers and objects reach here from JSON deploy outputs. Accepting one
		// would put `[object Object]` into an environment variable.
		for (const value of [7, null, undefined, {}, ["a"], true]) {
			expect(() => parseRailwayBindings({ KEY: value })).toThrow(
				RailwayInputRejectedError,
			);
		}
	});

	it("refuses a value carrying a control character", () => {
		// The document-not-a-locator guard. A newline in a binding is how a
		// multi-line blob — a private key, a certificate, a log — ends up pasted
		// into an environment as if it were a hostname.
		for (const value of ["a\nb", "a\rb", "a\tb", "a b", "[31m"]) {
			expect(() => parseRailwayBindings({ KEY: value })).toThrow(
				RailwayInputRejectedError,
			);
		}
	});

	it("accepts a 2048-character value and refuses 2049", () => {
		// The size boundary, pinned exactly. One character over is the difference
		// between a long locator and a document.
		expect(() => parseRailwayBindings({ KEY: "a".repeat(2048) })).not.toThrow();
		expect(() => parseRailwayBindings({ KEY: "a".repeat(2049) })).toThrow(
			RailwayInputRejectedError,
		);
	});

	it("names the offending binding in the field, not just the map", () => {
		// So an operator looking at ten outputs knows which one to fix.
		try {
			parseRailwayBindings({ GOOD: "ok", LEAKY: "a\nb" });
			expect.unreachable("a control character must be refused");
		} catch (error) {
			expect((error as RailwayInputRejectedError).field).toBe("bindings.LEAKY");
		}
	});

	it("refuses a non-object bindings map, including an array", () => {
		for (const value of [undefined, null, "KEY=v", 7, []]) {
			expect(() => parseRailwayBindings(value)).toThrow(
				RailwayInputRejectedError,
			);
		}
	});

	it("does not copy inherited keys onto the parsed map", () => {
		// `Object.entries` is own-keys-only. An inherited property that leaked
		// through would become an environment variable nobody wrote.
		const inherited = Object.create({ INHERITED: "leaked" }) as Record<
			string,
			string
		>;
		inherited.OWN = "kept";
		expect(parseRailwayBindings(inherited)).toEqual({ OWN: "kept" });
	});
});

describe("provider surface", () => {
	const provider = createRailwayProvider();

	it("names itself with the scoped package id", () => {
		expect(provider.id).toBe("@hobo/provider-railway");
		expect(provider.capabilityManifest().providerId).toBe(provider.id);
	});

	it("declares one capability per equivalence class", () => {
		expect(provider.capabilities).toHaveLength(INITIAL_CAPABILITY_PORTS.length);
	});

	it("matches fully when every requested feature is offered", () => {
		const compute = provider.capabilities.find((c) => c.port === "compute");
		expect(
			compute?.satisfies({ port: "compute", features: ["http", "container"] }),
		).toEqual({ kind: "full" });
	});

	it("matches fully when no features are requested at all", () => {
		// The `?? []` path. A request with no feature list is the common case and
		// must not be treated as a request for an unknown feature.
		const compute = provider.capabilities.find((c) => c.port === "compute");
		expect(compute?.satisfies({ port: "compute" })).toEqual({ kind: "full" });
	});

	it("reports a partial match naming exactly what is missing", () => {
		// The missing list is what placement uses to decide whether to substitute
		// or to fail. Reporting `none` instead would hide a near-miss that a human
		// could have resolved by dropping one feature.
		const compute = provider.capabilities.find((c) => c.port === "compute");
		expect(
			compute?.satisfies({ port: "compute", features: ["http", "gpu"] }),
		).toEqual({ kind: "partial", missing: ["gpu"] });
	});

	it("reports no match for a different port", () => {
		const compute = provider.capabilities.find((c) => c.port === "compute");
		expect(compute?.satisfies({ port: "kv" })).toEqual({ kind: "none" });
	});

	it("prices in USD against the resource class, unprefixed twice", () => {
		// The resource class already carries the `railway:` prefix. A SKU of
		// `railway:railway:service` would not join to any published price.
		const kv = provider.capabilities.find((c) => c.port === "kv");
		const cost = kv?.estimateCost({ port: "kv" });
		expect(cost?.currency).toBe("USD");
		expect(cost?.sku).toBe("railway:redis");
		expect(cost?.sku.startsWith("railway:railway")).toBe(false);
	});

	it("publishes a zero marginal price that means unpriced, not free", () => {
		// Pinned deliberately. This package publishes no cost facts, so there is
		// nothing dated to rank on — and a ranker that read `"0"` as free would
		// place every workload here. The empty `cost.facts` in the manifest is the
		// structural half of the same statement.
		const kv = provider.capabilities.find((c) => c.port === "kv");
		expect(kv?.estimateCost({ port: "kv" }).marginalPrice).toBe("0");
		expect(provider.capabilityManifest().cost).toEqual({ facts: [] });
	});

	it("declares brokered token exchange and no static secrets", () => {
		// Secretless-first. `staticSecrets: true` would be a claim that this
		// provider holds long-lived material, which it does not.
		expect(provider.capabilityManifest().auth).toEqual({
			exchange: "hobo:brokered-deploy-token",
			staticSecrets: false,
		});
	});

	it("lists every capability port in the manifest", () => {
		const manifest = provider.capabilityManifest();
		expect(
			manifest.capabilities.capabilities.map((c) => c.port).sort(),
		).toEqual([...railwayNativePorts()].sort());
	});

	it("realizes a plan into a driver program naming the mapped resource class", () => {
		const { driver } = provider.realize(PLAN);
		expect(driver.apiVersion).toBe("hobo.driver-program/v1");
		expect(driver.driver).toBe("railway-deploy");
		expect(driver.resources).toEqual([
			{ name: "api", type: "railway:service", provider: "railway" },
		]);
	});

	it("realizes each port to its own resource class", () => {
		expect(
			provider.realize({ ...PLAN, port: "kv" }).driver.resources[0]?.type,
		).toBe("railway:redis");
		expect(
			provider.realize({ ...PLAN, port: "queue" }).driver.resources[0]?.type,
		).toBe("railway:queue");
	});

	it("refuses an unrealizable plan at realize rather than emitting a driver", () => {
		// The parse boundary in anger. A driver program built from a bad plan
		// would fail inside whatever executed it, far from the input.
		expect(() => provider.realize({ ...PLAN, name: "BAD NAME" })).toThrow(
			RailwayInputRejectedError,
		);
		expect(() => provider.realize({ ...PLAN, port: "blob" })).toThrow(
			RailwayInputRejectedError,
		);
	});

	it("builds a client carrying the mapped class and service name", () => {
		const client = provider.client("kv", { REDIS_URL: "redis://host" });
		expect(client.port).toBe("kv");
		expect(client.resourceClass).toBe("railway:redis");
		expect(client.providerService).toBe("Railway Redis");
		expect(client.bindings).toEqual({ REDIS_URL: "redis://host" });
	});

	it("refuses a client for a port this provider does not realize", () => {
		expect(() => provider.client("blob", {})).toThrow(
			RailwayInputRejectedError,
		);
	});

	it("refuses client outputs that are not bindings", () => {
		expect(() => provider.client("kv", { BAD: "a\nb" })).toThrow(
			RailwayInputRejectedError,
		);
	});
});

describe("temporary station", () => {
	it("states plainly that anonymous temporary deploy is unsupported", () => {
		// A literal `false`, not a runtime check. The type itself forbids a
		// refusal that claims support.
		expect(supportsAnonymousTemporaryDeploy).toBe(false);
		expect(
			railwayTemporaryStationRefusal().supportsAnonymousTemporaryDeploy,
		).toBe(false);
	});

	it("publishes the refusal as data the yard plane can record", () => {
		// The point of the data form: a placement can be rejected and *explained*
		// without anyone catching an exception to find out why.
		const refusal = railwayTemporaryStationRefusal();
		expect(refusal.providerId).toBe(PROVIDER_TARGET);
		expect(refusal.code).toBe(TEMPORARY_PROVISION_UNAVAILABLE_CODE);
		expect(refusal.reason).toContain("Temporary Accounts");
		expect(Object.isFrozen(refusal)).toBe(true);
	});

	it("says why in terms an operator can act on", () => {
		// Not "unsupported" alone — the reason names the missing upstream API and
		// the fail-closed rule, so a reader knows this is a Railway limitation and
		// not a missing implementation here.
		const reason = railwayTemporaryStationRefusal().reason;
		expect(reason).toContain("Railway");
		expect(reason).toContain("fail closed");
		expect(reason).toContain("no permanent tokens");
	});

	it("rejects a provision attempt with the typed error", async () => {
		// Fail closed. Returning a degraded station would hand back something that
		// looked provisioned and was not.
		await expect(
			provisionTemporaryEnvironmentStation({ stationId: "s-1" }),
		).rejects.toBeInstanceOf(TemporaryProvisionUnavailableError);
	});

	it("carries the refusal and its code on the thrown error", async () => {
		// So a caller that did catch it gets the same data the non-throwing path
		// publishes, rather than a message it would have to parse.
		try {
			await provisionTemporaryEnvironmentStation({ stationId: "s-1" });
			expect.unreachable("railway cannot provision anonymously");
		} catch (error) {
			const typed = error as TemporaryProvisionUnavailableError;
			expect(typed.code).toBe(TEMPORARY_PROVISION_UNAVAILABLE_CODE);
			expect(typed.name).toBe("TemporaryProvisionUnavailableError");
			expect(typed.refusal).toEqual(railwayTemporaryStationRefusal());
			expect(typed.message).toBe(typed.refusal.reason);
		}
	});
});
