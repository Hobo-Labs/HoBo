// The resolver contract for the direct-provider-API deploy path. The cases
// below pin the credential law first — a request may name where material
// lives and may never carry it, at any depth — then the parse boundaries on
// both directions of the contract, then the registry's two determinism
// promises: id-sorted listing and a refused duplicate rather than a silently
// shadowed resolver.

import { describe, expect, it } from "vitest";
import {
	createResolverRegistry,
	type HttpTransport,
	parseResolveOutcome,
	parseResolveRequest,
	parseResolverDirectives,
	RESOLVER_ACTIONS,
	RESOLVER_CONTRACT,
	RESOLVER_ERROR_CODES,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

const transport: HttpTransport = async () => ({
	status: 200,
	headers: {},
	body: "{}",
});

function requestInput(overrides: JsonObject = {}): JsonObject {
	return {
		ref: {
			slot: "data",
			productId: "vercel.postgres",
			logicalId: "orders-db",
		},
		desired: { region: "iad1", size: "small" },
		credentialRef: "secretref://vault/hobo/prod/vercel",
		...overrides,
	};
}

function outcomeInput(overrides: JsonObject = {}): JsonObject {
	return {
		contract: RESOLVER_CONTRACT,
		action: "create",
		physicalId: "prj_9wKm",
		outputs: { host: "db.vercel-storage.com" },
		diagnostics: ["created in iad1"],
		...overrides,
	};
}

function resolver(overrides: Partial<ResourceResolver> = {}): ResourceResolver {
	return {
		providerId: "vercel",
		productId: "vercel.postgres",
		reconcile: async (): Promise<ResolveOutcome> =>
			parseResolveOutcome(outcomeInput()),
		delete: async (): Promise<void> => undefined,
		...overrides,
	};
}

function codeOf(run: () => JsonValue): string {
	try {
		run();
	} catch (error) {
		if (error instanceof ResolverError) return error.code;
		throw error;
	}
	throw new Error("expected the parse boundary to refuse");
}

describe("resolver vocabularies", () => {
	it("pin the contract id", () => {
		expect(RESOLVER_CONTRACT).toBe("hobo.resource-resolver/v1");
	});

	it("expose the closed action set, frozen", () => {
		expect([...RESOLVER_ACTIONS]).toEqual([
			"create",
			"update",
			"replace",
			"delete",
			"adopt",
			"noop",
		]);
		expect(Object.isFrozen(RESOLVER_ACTIONS)).toBe(true);
	});

	it("expose every refusal code, frozen", () => {
		expect([...RESOLVER_ERROR_CODES]).toEqual([
			"RESOLVER_CREDENTIAL_MISSING",
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"RESOLVER_PROVIDER_REJECTED",
			"RESOLVER_OUTPUT_UNPARSEABLE",
		]);
		expect(Object.isFrozen(RESOLVER_ERROR_CODES)).toBe(true);
	});
});

describe("ResolverError", () => {
	it.each([
		...RESOLVER_ERROR_CODES,
	])("carries %s and its product so remediation names the resolver to fix", (code) => {
		const error = new ResolverError(code, "refused", "vercel.postgres");

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("ResolverError");
		expect(error.code).toBe(code);
		expect(error.productId).toBe("vercel.postgres");
	});

	it("omits productId when the refusal came before the product was known", () => {
		expect(
			new ResolverError("RESOLVER_OUTPUT_UNPARSEABLE", "refused").productId,
		).toBeUndefined();
	});
});

describe("parseResolveRequest", () => {
	it("returns a deep-frozen record with sorted property keys", () => {
		const parsed = parseResolveRequest(
			requestInput({ desired: { size: "small", region: "iad1" } }),
		);

		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.desired)).toBe(true);
		expect(Object.keys(parsed.desired)).toEqual(["region", "size"]);
	});

	it("is order-insensitive: two authorings of the same request are deep-equal", () => {
		const left = parseResolveRequest(
			requestInput({ desired: { region: "iad1", size: "small" } }),
		);
		const right = parseResolveRequest(
			requestInput({ desired: { size: "small", region: "iad1" } }),
		);

		expect(left).toEqual(right);
	});

	it("keeps an optional observed bag absent rather than undefined", () => {
		const parsed: ResolveRequest = parseResolveRequest(requestInput());

		expect("observed" in parsed).toBe(false);
	});

	it("accepts a last-known observed bag when one is supplied", () => {
		const parsed = parseResolveRequest(
			requestInput({ observed: { host: "old.example.com" } }),
		);

		expect(parsed.observed).toEqual({ host: "old.example.com" });
	});

	it.each([
		["secretref://vault/hobo/prod/vercel-token", "a vault path naming a token"],
		["aws-secretsmanager://prod/hobo/vercel", "an aws locator"],
		["env://HOBO_VERCEL_TOKEN", "an env locator"],
		["file://var/run/secrets/hobo/vercel", "a mounted-file locator"],
	])("accepts the locator %s (%s)", (credentialRef) => {
		expect(
			parseResolveRequest(requestInput({ credentialRef })).credentialRef,
		).toBe(credentialRef);
	});

	it.each([
		[undefined, "an absent ref"],
		[null, "a null ref"],
		["", "an empty ref"],
		["   ", "a blank ref"],
		[42, "a non-string ref"],
	])("refuses %s as missing (%s)", (credentialRef) => {
		expect(
			codeOf(() => parseResolveRequest(requestInput({ credentialRef }))),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it.each([
		[
			"postgres://hobo:hunter2@db.example.com:5432/orders",
			"a connection string with an inline password",
		],
		["Bearer sk_live_9wKmQ2Zx", "an Authorization header value"],
		[
			"-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA-----END RSA PRIVATE KEY-----",
			"a PEM block",
		],
		["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJob2JvIn0.9wKmQ2ZxAAAA", "a JWT"],
		["sk_live_9wKmQ2ZxAAAA", "a bare provider key with no scheme"],
		[
			"secretref://vault/hobo?token=sk_live_9wKm",
			"a locator with the material inlined in its query",
		],
		["secretref://vault/hobo prod", "a value with whitespace"],
		[`secretref://vault/${"a".repeat(600)}`, "a locator past the length bound"],
	])("refuses %s as a value, not a ref (%s)", (credentialRef) => {
		expect(
			codeOf(() => parseResolveRequest(requestInput({ credentialRef }))),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("never echoes the refused credential, because the refusal exists precisely because it is material", () => {
		try {
			parseResolveRequest(
				requestInput({ credentialRef: "Bearer sk_live_9wKmQ2Zx" }),
			);
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ResolverError);
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as ResolverError).message).not.toMatch(/sk_live/u);
		}
	});

	it.each([
		[{ apiKey: "sk_live_9wKm" }, "a credential-shaped key at the root"],
		[
			{ connection: { password: "hunter2" } },
			"a credential-shaped key one level down",
		],
		[
			{ auth: [{ accessToken: "abc" }] },
			"a credential-shaped key inside an array",
		],
	])("refuses %o in desired (%s)", (desired) => {
		expect(codeOf(() => parseResolveRequest(requestInput({ desired })))).toBe(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
		);
	});

	it("refuses a credential-shaped key in observed too", () => {
		expect(
			codeOf(() =>
				parseResolveRequest(
					requestInput({ observed: { privateKey: "-----BEGIN" } }),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it.each([
		[undefined, "an absent request"],
		["a string", "a non-object request"],
		[[], "an array"],
	])("refuses %o as unroutable (%s)", (input) => {
		expect(codeOf(() => parseResolveRequest(input))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it.each([
		[
			{ slot: "nope", productId: "vercel.postgres", logicalId: "db" },
			"an unknown slot",
		],
		[{ slot: "data", logicalId: "db" }, "a missing productId"],
		[
			{ slot: "data", productId: "Vercel.Postgres", logicalId: "db" },
			"an uppercase productId",
		],
		[{ slot: "data", productId: "vercel.postgres" }, "a missing logicalId"],
		[
			{ slot: "data", productId: "vercel.postgres", logicalId: "../escape" },
			"a logicalId that escapes a path segment",
		],
		[
			{
				slot: "data",
				productId: "vercel.postgres",
				logicalId: "db",
				physicalId: "",
			},
			"an empty physicalId",
		],
	])("refuses ref %o (%s)", (ref) => {
		expect(codeOf(() => parseResolveRequest(requestInput({ ref })))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it.each([
		[{ retries: Number.POSITIVE_INFINITY }, "a non-finite number"],
		[{ created: new Date(0) }, "a class instance"],
		["not an object", "a non-object bag"],
	])("refuses desired %o as unrealizable (%s)", (desired) => {
		expect(codeOf(() => parseResolveRequest(requestInput({ desired })))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("refuses a cyclic desired bag, which has no JSON representation", () => {
		const desired: JsonObject = { name: "orders" };
		desired.self = desired;

		expect(codeOf(() => parseResolveRequest(requestInput({ desired })))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});
});

describe("parseResolveOutcome", () => {
	it("returns a deep-frozen outcome", () => {
		const parsed = parseResolveOutcome(outcomeInput());

		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.outputs)).toBe(true);
		expect(Object.isFrozen(parsed.diagnostics)).toBe(true);
	});

	it.each([...RESOLVER_ACTIONS])("accepts the %s action", (action) => {
		expect(parseResolveOutcome(outcomeInput({ action })).action).toBe(action);
	});

	it("preserves diagnostic order, because diagnostics narrate a sequence", () => {
		const parsed = parseResolveOutcome(
			outcomeInput({ diagnostics: ["zeta happened", "alpha happened"] }),
		);

		expect([...parsed.diagnostics]).toEqual([
			"zeta happened",
			"alpha happened",
		]);
	});

	it("defaults an absent diagnostics list to empty rather than undefined", () => {
		expect(
			parseResolveOutcome(outcomeInput({ diagnostics: undefined })).diagnostics,
		).toEqual([]);
	});

	it.each([
		[{ contract: "hobo.resource-resolver/v2" }, "a contract version drift"],
		[{ action: "provision" }, "an action outside the closed set"],
		[{ action: undefined }, "a missing action"],
		[{ physicalId: "" }, "an empty physicalId"],
		[{ physicalId: undefined }, "a missing physicalId"],
		[{ outputs: "host=db" }, "a non-object outputs bag"],
		[{ outputs: { at: Number.NaN } }, "a non-finite output value"],
		[{ diagnostics: "created" }, "a non-array diagnostics list"],
		[{ diagnostics: [""] }, "an empty diagnostic"],
	])("refuses %o as unparseable (%s)", (overrides) => {
		expect(codeOf(() => parseResolveOutcome(outcomeInput(overrides)))).toBe(
			"RESOLVER_OUTPUT_UNPARSEABLE",
		);
	});

	it.each([
		[undefined, "an absent outcome"],
		[null, "a null outcome"],
		["outcome", "a non-object outcome"],
		[[], "an array"],
	])("refuses %o as unparseable (%s)", (input) => {
		expect(codeOf(() => parseResolveOutcome(input))).toBe(
			"RESOLVER_OUTPUT_UNPARSEABLE",
		);
	});

	it("refuses a credential-shaped output key, so material cannot ride back up on the outcome", () => {
		expect(
			codeOf(() =>
				parseResolveOutcome(
					outcomeInput({ outputs: { connectionSecret: "postgres://…" } }),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});
});

describe("createResolverRegistry", () => {
	it("lists id-sorted, never in registration order", () => {
		const registry = createResolverRegistry([
			resolver({ productId: "vercel.postgres" }),
			resolver({ productId: "aws.rds-postgres", providerId: "aws" }),
			resolver({ productId: "neon.postgres", providerId: "neon" }),
		]);

		expect(registry.list().map((entry) => entry.productId)).toEqual([
			"aws.rds-postgres",
			"neon.postgres",
			"vercel.postgres",
		]);
	});

	it("returns a frozen listing", () => {
		const registry = createResolverRegistry([resolver()]);

		expect(Object.isFrozen(registry.list())).toBe(true);
	});

	it("resolves a registered product and returns undefined for an unregistered one", () => {
		const registry = createResolverRegistry([resolver()]);

		expect(registry.get("vercel.postgres")?.providerId).toBe("vercel");
		expect(registry.get("aws.rds-postgres")).toBeUndefined();
	});

	it("refuses a duplicate productId rather than shadowing a resolver nobody reviewed", () => {
		expect(
			codeOf(() =>
				createResolverRegistry([
					resolver({ providerId: "vercel" }),
					resolver({ providerId: "neon" }),
				]),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("names both providers in the duplicate refusal", () => {
		expect(() =>
			createResolverRegistry([
				resolver({ providerId: "vercel" }),
				resolver({ providerId: "neon" }),
			]),
		).toThrow(/vercel.*neon|neon.*vercel/u);
	});

	it.each([
		[{ productId: "" }, "an empty productId"],
		[{ providerId: "Vercel" }, "an uppercase providerId"],
	])("refuses a malformed registration %o (%s)", (overrides) => {
		expect(codeOf(() => createResolverRegistry([resolver(overrides)]))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("keeps the directives a resolver declares", () => {
		const registry = createResolverRegistry([
			resolver({ directives: ["forceDelete", "restoreScheduled"] }),
		]);

		expect(registry.get("vercel.postgres")?.directives).toEqual([
			"forceDelete",
			"restoreScheduled",
		]);
	});

	it.each([
		[["forceDelete", "forceDelete"], "a directive named twice"],
		[[""], "an empty name"],
		[["force delete"], "a name that is not a parameter key"],
	])("refuses a malformed directive list %o (%s)", (directives) => {
		expect(
			codeOf(() => createResolverRegistry([resolver({ directives })])),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("registers a frozen copy of the directives, so changing the original changes nothing", async () => {
		const directives = ["forceDelete"];
		const registry = createResolverRegistry([resolver({ directives })]);
		directives.push("restoreScheduled");

		const entry = registry.get("vercel.postgres");
		expect(entry?.directives).toEqual(["forceDelete"]);
		expect(Object.isFrozen(entry?.directives)).toBe(true);
		expect(Object.isFrozen(entry)).toBe(true);
		await expect(
			entry?.reconcile(parseResolveRequest(requestInput()), transport),
		).resolves.toMatchObject({ action: "create", physicalId: "prj_9wKm" });
		expect(entry?.read).toBeUndefined();
	});

	it("keeps read() on a registered resolver with directives", async () => {
		const outcome = parseResolveOutcome(outcomeInput({ action: "noop" }));
		const registry = createResolverRegistry([
			resolver({ directives: ["forceDelete"], read: async () => outcome }),
		]);

		await expect(
			registry
				.get("vercel.postgres")
				?.read?.(parseResolveRequest(requestInput()), transport),
		).resolves.toBe(outcome);
	});

	it("parses a resolver's directives the same way outside a registry", () => {
		expect(parseResolverDirectives(resolver())).toEqual([]);
		expect(
			parseResolverDirectives(resolver({ directives: ["forceDelete"] })),
		).toEqual(["forceDelete"]);
		expect(
			codeOf(() =>
				parseResolverDirectives(Object.assign(resolver(), { directives: 5 })),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("reads a resolver's directives once, and hands out a frozen view that keeps them", () => {
		let reads = 0;
		const lists = [["forceDelete"], ["forceDelete", "restoreScheduled"]];
		const registry = createResolverRegistry([
			Object.defineProperty(resolver(), "directives", {
				enumerable: true,
				get: () => lists[Math.min(reads++, 1)],
			}),
		]);

		expect(reads).toBe(1);
		const view = registry.get("vercel.postgres");
		expect(view?.directives).toEqual(["forceDelete"]);
		expect(registry.list()[0]).toBe(view);
		expect(Object.isFrozen(view)).toBe(true);
		expect(reads).toBe(1);
	});

	it("hands out the registered object itself when it declares no directives", () => {
		const plain = resolver();

		expect(createResolverRegistry([plain]).get("vercel.postgres")).toBe(plain);
	});

	it("refuses a sparse directive list, which names nothing in its hole", () => {
		const holes: string[] = [];
		holes[1] = "size";

		expect(
			codeOf(() => parseResolverDirectives(resolver({ directives: holes }))),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(
			codeOf(() => createResolverRegistry([resolver({ directives: holes })])),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("parses a directive list to one that parses to itself", () => {
		const parsed = parseResolverDirectives(
			resolver({ directives: ["forceDelete", "restoreScheduled"] }),
		);

		expect(parseResolverDirectives(resolver({ directives: parsed }))).toEqual(
			parsed,
		);
		expect(Object.keys(parsed)).toEqual(["0", "1"]);
	});

	it("refuses directives that are not a list", () => {
		const malformed = Object.assign(resolver(), { directives: "forceDelete" });

		expect(codeOf(() => createResolverRegistry([malformed]))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("refuses a registration missing a required method", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const incomplete = {
			providerId: "vercel",
			productId: "vercel.postgres",
			delete: async (): Promise<void> => undefined,
		} as ResourceResolver;

		expect(codeOf(() => createResolverRegistry([incomplete]))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("accepts a resolver without the optional read(), since adoption is a capability and not a requirement", async () => {
		const registry = createResolverRegistry([resolver()]);
		const entry = registry.get("vercel.postgres");

		expect(entry?.read).toBeUndefined();
		await expect(
			entry?.reconcile(parseResolveRequest(requestInput()), transport),
		).resolves.toMatchObject({ action: "create", physicalId: "prj_9wKm" });
	});

	it("is convergent by contract: a resolver invoked twice reports one resource", async () => {
		const entry = resolver();
		const request = parseResolveRequest(requestInput());

		const first = await entry.reconcile(request, transport);
		const second = await entry.reconcile(request, transport);

		expect(first).toEqual(second);
		expect(second.physicalId).toBe(first.physicalId);
	});
});
