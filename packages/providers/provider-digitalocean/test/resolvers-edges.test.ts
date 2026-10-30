/**
 * DigitalOcean resolver edges — the shared plumbing every product sits on.
 *
 * The per-product tests next door drive the happy shapes. This file drives the
 * wrapper: credentials, the listing budget, name ambiguity, body parsing,
 * provider refusals, and the adopt/noop distinction. Those live in one place
 * and every one of the fourteen resolvers inherits them, so a defect here is a
 * defect fourteen times over — and each of these paths runs only when something
 * has already gone wrong, which is when nobody is watching.
 *
 * Three properties carry most of the weight:
 *
 * **A pasted token must never survive as a locator.** `credentialRef` is
 * written into the event log verbatim. Accepting a token there leaks it before
 * the first request goes out, and every request still succeeds — which is what
 * makes the leak invisible without an explicit shape check.
 *
 * **An exhausted page budget is not "absent".** DigitalOcean does not enforce
 * name uniqueness on Droplets or Load Balancers, and its collections page. If
 * the lookup concluded "not found" after running out of pages, reconcile would
 * create a duplicate of a resource sitting on the page nobody read. So the
 * budget running out is a refusal, and so is a name matching twice.
 *
 * **An unknown outcome is refused, never assumed.** A body this code cannot
 * parse leaves the effect of the call unknown. Guessing either way is worse
 * than a typed refusal.
 *
 * Everything runs through an injected fake transport. No network, no
 * credential, no DigitalOcean team.
 */

import type {
	HttpTransport,
	ResolveRequest,
	ResourceResolver,
	TransportResponse,
} from "@hobo/core";
import { parseResolveRequest, ResolverError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_MAX_LIST_PAGES,
	DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
	DIGITALOCEAN_DROPLET_PRODUCT_ID,
	DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
	DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID,
	DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
	DIGITALOCEAN_SPACES_PRODUCT_ID,
	type DigitalOceanResolverOptions,
	digitaloceanResolverRegistry,
	redactDigitalOceanText,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

type Rec = JsonObject;

const CREDENTIAL_REF = "env://DIGITALOCEAN_TOKEN";
const TOKEN = "dop_v1_fakedigitaloceantoken0123456789abcdefghij";
const NOW_MS = Date.parse("2026-08-19T12:00:00.000Z");
const SPACES_KEYS = Object.freeze({
	accessKeyId: "FAKEDOSPACESACCESSKEY",
	secretAccessKey: "fake-spaces-secret-key-0123456789abcdef",
});

function options(
	overrides: Partial<DigitalOceanResolverOptions> = {},
): DigitalOceanResolverOptions {
	return {
		resolveCredential: async () => TOKEN,
		resolveSpacesCredential: async () => SPACES_KEYS,
		nowMs: NOW_MS,
		...overrides,
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<DigitalOceanResolverOptions> = {},
): ResourceResolver {
	const resolver = digitaloceanResolverRegistry(options(overrides)).get(
		productId,
	);
	if (resolver === undefined) {
		throw new Error(`no resolver registered for ${productId}`);
	}
	return resolver;
}

function request(input: {
	readonly productId: string;
	readonly logicalId?: string;
	readonly physicalId?: string;
	readonly desired?: Rec;
	readonly credentialRef?: string;
}): ResolveRequest {
	return parseResolveRequest({
		ref: {
			slot: "data",
			productId: input.productId,
			logicalId: input.logicalId ?? "thing",
			...(input.physicalId !== undefined
				? { physicalId: input.physicalId }
				: undefined),
		},
		desired: input.desired ?? {},
		credentialRef: input.credentialRef ?? CREDENTIAL_REF,
	});
}

function always(response: TransportResponse): HttpTransport {
	return async () => response;
}

function sequence(...responses: readonly TransportResponse[]): HttpTransport {
	let index = 0;
	return async () => {
		const next = responses[Math.min(index, responses.length - 1)];
		index += 1;
		if (next === undefined) throw new Error("the fake ran out of responses");
		return next;
	};
}

function json(status: number, payload: JsonValue): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	};
}

function raw(status: number, body: string): TransportResponse {
	return { status, headers: {}, body };
}

/** A full page, so the lookup keeps paging instead of stopping short. */
function fullPage(listKey: string): TransportResponse {
	return json(200, {
		[listKey]: Array.from({ length: 200 }, (_unused, index) => ({
			id: `filler-${index}`,
			name: `other-${index}`,
		})),
	});
}

async function codeOf<T>(run: () => Promise<T>): Promise<string> {
	try {
		await run();
	} catch (error) {
		return error instanceof ResolverError ? error.code : "NO_CODE";
	}
	return "NO_ERROR_THROWN";
}

async function messageOf<T>(run: () => Promise<T>): Promise<string> {
	try {
		await run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "NO_ERROR_THROWN";
}

/** A Droplet read against a canned transport — the shortest path to the wrapper. */
function readDroplet(
	transport: HttpTransport,
	overrides: Partial<DigitalOceanResolverOptions> = {},
	input: Partial<Parameters<typeof request>[0]> = {},
) {
	return resolverFor(DIGITALOCEAN_DROPLET_PRODUCT_ID, overrides).read(
		request({ productId: DIGITALOCEAN_DROPLET_PRODUCT_ID, ...input }),
		transport,
	);
}

// ---------------------------------------------------------------------------

describe("redaction", () => {
	it("scrubs anything token-shaped", () => {
		expect(redactDigitalOceanText(`bearer ${TOKEN} rejected`)).not.toContain(
			TOKEN,
		);
	});

	it("leaves short words alone", () => {
		// Redacting ordinary prose makes provider errors unreadable, and an
		// unreadable error gets ignored rather than acted on.
		expect(redactDigitalOceanText("droplet is off")).toBe("droplet is off");
	});

	it("truncates long text with an ellipsis", () => {
		// Provider text lands in diagnostics an operator reads in a terminal; a
		// multi-kilobyte echo of a request body would bury the real failure.
		const scrubbed = redactDigitalOceanText("ab cd ".repeat(200), 100);
		expect(scrubbed).toHaveLength(101);
		expect(scrubbed.endsWith("…")).toBe(true);
	});

	it("does not append an ellipsis to text that fits", () => {
		expect(redactDigitalOceanText("short", 100).endsWith("…")).toBe(false);
	});
});

describe("the credential boundary", () => {
	it("refuses an empty credentialRef", async () => {
		expect(
			await codeOf(() =>
				readDroplet(
					always(json(200, { droplets: [] })),
					{},
					{
						credentialRef: "   ",
					},
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses a credentialRef that is really a token", async () => {
		// The one that matters most: a pasted token in this field has already
		// leaked into the event log, and everything downstream would still work.
		expect(
			await codeOf(() =>
				readDroplet(
					always(json(200, { droplets: [] })),
					{},
					{
						credentialRef: TOKEN,
					},
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses a ref that is not a locator", async () => {
		expect(
			await codeOf(() =>
				readDroplet(
					always(json(200, { droplets: [] })),
					{},
					{
						credentialRef: "my-token",
					},
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("never echoes a rejected ref that contains material", async () => {
		// A token pasted into the field with a stray word in front of it is still
		// a token, and an error message is one of the most widely-copied strings
		// in an incident.
		const message = await messageOf(() =>
			readDroplet(
				always(json(200, { droplets: [] })),
				{},
				{
					credentialRef: `oops ${TOKEN}`,
				},
			),
		);
		expect(message).not.toContain(TOKEN);
	});

	it("refuses when the host's resolver throws", async () => {
		expect(
			await codeOf(() =>
				readDroplet(always(json(200, { droplets: [] })), {
					resolveCredential: async () => {
						throw new Error("vault is sealed");
					},
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("quotes the host's reason so the operator can fix it", async () => {
		expect(
			await messageOf(() =>
				readDroplet(always(json(200, { droplets: [] })), {
					resolveCredential: async () => {
						throw new Error("vault is sealed");
					},
				}),
			),
		).toContain("vault is sealed");
	});

	it("survives a host that throws a non-Error", async () => {
		// A rejected promise carrying a string is legal and happens in the wild.
		expect(
			await codeOf(() =>
				readDroplet(always(json(200, { droplets: [] })), {
					resolveCredential: async () => {
						throw "sealed";
					},
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses when the host resolves the ref to nothing", async () => {
		// Carrying on unauthenticated surfaces at DigitalOcean as a 401 about
		// permissions, which sends the operator to look at their team's API tokens
		// when the real problem is a reference nobody registered.
		expect(
			await codeOf(() =>
				readDroplet(always(json(200, { droplets: [] })), {
					resolveCredential: async () => "  ",
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses to build resolvers with no resolveCredential at all", () => {
		expect(() =>
			digitaloceanResolverRegistry({
				// SAFETY: deliberately violate the injected port to verify runtime rejection.
				resolveCredential: undefined as never,
			}),
		).toThrow(/never reads an environment variable/u);
	});
});

describe("the listing budget", () => {
	it("defaults to a bounded number of pages", () => {
		// The point is that there *is* a bound. An unbounded listing is an
		// unbounded deploy.
		expect(DEFAULT_MAX_LIST_PAGES).toBeGreaterThan(0);
	});

	it.each([
		0,
		-1,
		501,
		1.5,
		Number.NaN,
	])("refuses maxListPages of %s", (pages) => {
		expect(() =>
			digitaloceanResolverRegistry(options({ maxListPages: pages })),
		).toThrow(/bounded maxListPages/u);
	});

	it("accepts a budget at the bottom of the range", () => {
		expect(() =>
			digitaloceanResolverRegistry(options({ maxListPages: 1 })),
		).not.toThrow();
	});

	it("accepts a budget at the top of the range", () => {
		expect(() =>
			digitaloceanResolverRegistry(options({ maxListPages: 500 })),
		).not.toThrow();
	});

	it("refuses rather than concluding absent from an exhausted budget", async () => {
		// This is the failure that would silently create a duplicate: every page
		// is full, the name is on none of them, and the budget runs out. Reporting
		// "not found" here means the next step is a create.
		expect(
			await codeOf(() =>
				readDroplet(always(fullPage("droplets")), { maxListPages: 2 }),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("says how much it read and offers the way out", async () => {
		const message = await messageOf(() =>
			readDroplet(always(fullPage("droplets")), { maxListPages: 2 }),
		);
		expect(message).toContain("read 2 pages");
		expect(message).toContain("raise maxListPages");
	});

	it("stops at a short page rather than spending the whole budget", async () => {
		// A short page is the end of the collection. Paging past it would burn
		// the rate limit on requests that can only return nothing.
		let calls = 0;
		const outcome = await readDroplet(
			async () => {
				calls += 1;
				return json(200, { droplets: [] });
			},
			{ maxListPages: 20 },
		);
		expect(calls).toBe(1);
		expect(outcome).toBeUndefined();
	});

	it("finds a match on a later page", async () => {
		// The budget exists so that paging works, not so that it is avoided.
		const outcome = await readDroplet(
			sequence(
				fullPage("droplets"),
				json(200, { droplets: [{ id: 7, name: "thing" }] }),
			),
			{ maxListPages: 20 },
		);
		expect(outcome?.physicalId).toBe("7");
	});
});

describe("name ambiguity", () => {
	it("refuses when two records share the name", async () => {
		// DigitalOcean does not enforce name uniqueness here. Picking the first
		// would make `physicalId` depend on listing order, which is how a
		// reconcile starts silently managing somebody else's resource.
		expect(
			await codeOf(() =>
				readDroplet(
					always(
						json(200, {
							droplets: [
								{ id: 1, name: "thing" },
								{ id: 2, name: "thing" },
							],
						}),
					),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("offers renaming or a physical id as the way out", async () => {
		expect(
			await messageOf(() =>
				readDroplet(
					always(
						json(200, {
							droplets: [
								{ id: 1, name: "thing" },
								{ id: 2, name: "thing" },
							],
						}),
					),
				),
			),
		).toContain("rename the duplicates or pass ref.physicalId");
	});

	it("refuses ambiguity found across two pages, not just within one", async () => {
		// Matches accumulate across pages; a check that only looked within a page
		// would miss the duplicate that straddles a page boundary.
		const page = [
			...Array.from({ length: 199 }, (_unused, index) => ({
				id: `f-${index}`,
				name: `other-${index}`,
			})),
			{ id: 1, name: "thing" },
		];
		expect(
			await codeOf(() =>
				readDroplet(
					sequence(
						json(200, { droplets: page }),
						json(200, { droplets: [{ id: 2, name: "thing" }] }),
					),
					{ maxListPages: 20 },
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("refuses malformed entries rather than turning them into absence", async () => {
		await expect(
			readDroplet(always(json(200, { droplets: [null, "thing", 7] }))),
		).rejects.toThrow(/incomplete collection/u);
	});

	it("ignores a record whose name does not match", async () => {
		const outcome = await readDroplet(
			always(json(200, { droplets: [{ id: 1, name: "thing-2" }] })),
		);
		expect(outcome).toBeUndefined();
	});
});

describe("reading the body", () => {
	it("refuses a page with no list array", async () => {
		// Concluding "absent" from a body this code cannot search would make the
		// next step a create — duplicating a resource that already exists.
		expect(
			await codeOf(() =>
				readDroplet(always(json(200, { unexpected: "shape" }))),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("says a create would risk a duplicate", async () => {
		expect(
			await messageOf(() =>
				readDroplet(always(json(200, { unexpected: "shape" }))),
			),
		).toContain("risk duplicating an existing resource");
	});

	it("refuses a success body that is not JSON", async () => {
		// An HTML error page from a proxy is the usual source.
		expect(
			await codeOf(() => readDroplet(always(raw(200, "<html>bad gateway")))),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("says the outcome is unknown rather than guessing", async () => {
		expect(
			await messageOf(() => readDroplet(always(raw(200, "<html>bad gateway")))),
		).toContain("refused rather than assumed");
	});

	it("refuses JSON that is not an object", async () => {
		expect(await codeOf(() => readDroplet(always(raw(200, "[1,2,3]"))))).toBe(
			"RESOLVER_OUTPUT_UNPARSEABLE",
		);
	});

	it("refuses a record with no usable id", async () => {
		// An unaddressable resource cannot be deleted or updated later; recording
		// it as managed would strand it.
		expect(
			await codeOf(() =>
				readDroplet(always(json(200, { droplets: [{ name: "thing" }] }))),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("accepts a numeric id, as Droplets carry", async () => {
		const outcome = await readDroplet(
			always(json(200, { droplets: [{ id: 12, name: "thing" }] })),
		);
		expect(outcome?.physicalId).toBe("12");
	});

	it("accepts a string id, as the UUID products carry", async () => {
		const outcome = await readDroplet(
			always(json(200, { droplets: [{ id: "uuid-1", name: "thing" }] })),
		);
		expect(outcome?.physicalId).toBe("uuid-1");
	});

	it("refuses a fractional id rather than truncating it", async () => {
		expect(
			await codeOf(() =>
				readDroplet(
					always(json(200, { droplets: [{ id: 1.5, name: "thing" }] })),
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});
});

describe("provider refusals", () => {
	it("quotes the provider's id and message", async () => {
		expect(
			await messageOf(() =>
				readDroplet(
					always(
						json(422, {
							id: "bad_input",
							message: "size is not available in this region",
						}),
					),
				),
			),
		).toContain("bad_input: size is not available in this region");
	});

	it("scrubs an error id long enough to look like a token", async () => {
		// `unprocessable_entity` is twenty-one characters of `[A-Za-z0-9_-]`, so
		// the conservative scrub takes it. That is the intended trade: the pattern
		// cannot tell a long error slug from a token fragment, and erring toward
		// redaction costs a word of context while erring the other way costs a
		// secret. The message body — the part that actually says what is wrong —
		// survives, so the diagnostic stays actionable.
		const message = await messageOf(() =>
			readDroplet(
				always(
					json(422, {
						id: "unprocessable_entity",
						message: "size is not available in this region",
					}),
				),
			),
		);
		expect(message).toContain("[redacted]");
		expect(message).toContain("size is not available in this region");
	});

	it("redacts anything token-shaped in the provider's message", async () => {
		// DigitalOcean echoes request context in `message`, and that context has
		// carried token fragments before.
		expect(
			await messageOf(() =>
				readDroplet(
					always(json(401, { id: "unauthorized", message: `token ${TOKEN}` })),
				),
			),
		).not.toContain(TOKEN);
	});

	it("says so plainly when the provider sent no detail", async () => {
		expect(await messageOf(() => readDroplet(always(json(500, {}))))).toContain(
			"no error detail was returned",
		);
	});

	it("falls back to a redacted snippet when the error body is not JSON", async () => {
		// A proxy's plain-text page still tells the operator something; discarding
		// it would leave them with only a status code.
		expect(
			await messageOf(() =>
				readDroplet(always(raw(502, "upstream connect error"))),
			),
		).toContain("upstream connect error");
	});

	it("still names the status when the error body is empty", async () => {
		expect(await messageOf(() => readDroplet(always(raw(503, ""))))).toContain(
			"status 503",
		);
	});

	it("carries the typed code, not just a message", async () => {
		// The lane branches on the code; a stringly-typed failure would collapse
		// "provider said no" into "something went wrong".
		expect(await codeOf(() => readDroplet(always(raw(503, ""))))).toBe(
			"RESOLVER_PROVIDER_REJECTED",
		);
	});
});

describe("naming and placement", () => {
	it("prefers desired.name over the logical id", async () => {
		// The name is what makes reconcile convergent; a logical id that shadowed
		// an explicit name would search for the wrong resource.
		const outcome = await readDroplet(
			always(json(200, { droplets: [{ id: 3, name: "explicit" }] })),
			{},
			{ logicalId: "logical", desired: { name: "explicit" } },
		);
		expect(outcome?.physicalId).toBe("3");
	});

	it("refuses a create with no region", async () => {
		// A resource silently created in nyc3 because nobody said otherwise is a
		// residency incident, not a convenience.
		expect(
			await codeOf(() =>
				resolverFor(DIGITALOCEAN_DROPLET_PRODUCT_ID).reconcile(
					request({
						productId: DIGITALOCEAN_DROPLET_PRODUCT_ID,
						desired: { size: "s-1vcpu-1gb", image: "ubuntu-24-04-x64" },
					}),
					always(json(200, { droplets: [] })),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("accepts location as a synonym for region", async () => {
		// Every other provider in this repo calls it one or the other; refusing
		// the synonym would make a portable manifest un-portable for no gain.
		const outcome = await resolverFor(
			DIGITALOCEAN_DROPLET_PRODUCT_ID,
		).reconcile(
			request({
				productId: DIGITALOCEAN_DROPLET_PRODUCT_ID,
				desired: {
					size: "s-1vcpu-1gb",
					image: "ubuntu-24-04-x64",
					location: "nyc3",
				},
			}),
			sequence(
				json(200, { droplets: [] }),
				json(202, { droplet: { id: 9, name: "thing" } }),
			),
		);
		expect(outcome.action).toBe("create");
	});
});

describe("adopt versus noop", () => {
	it("adopts a resource the request did not know about", async () => {
		// Adopting something unmanaged is a fact an operator should see in the
		// audit record, not something folded into "nothing happened".
		const outcome = await readDroplet(
			always(json(200, { droplets: [{ id: 11, name: "thing" }] })),
		);
		expect(outcome?.action).toBe("adopt");
	});

	it("reports noop when the caller already named the physical id", async () => {
		const outcome = await readDroplet(
			always(json(200, { droplet: { id: 11, name: "thing" } })),
			{},
			{ physicalId: "11" },
		);
		expect(outcome?.action).toBe("noop");
	});
});

describe("routing", () => {
	it("refuses a request for another product", async () => {
		// Picking a resolver by hand and handing it the wrong request would send a
		// database's desired shape down the Droplet create path.
		expect(
			await codeOf(() =>
				resolverFor(DIGITALOCEAN_DROPLET_PRODUCT_ID).read(
					request({ productId: DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID }),
					always(json(200, { droplets: [] })),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("says to route through the registry", async () => {
		expect(
			await messageOf(() =>
				resolverFor(DIGITALOCEAN_DROPLET_PRODUCT_ID).read(
					request({ productId: DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID }),
					always(json(200, { droplets: [] })),
				),
			),
		).toContain("route the request through the registry");
	});
});

describe("outputs from a sparse record", () => {
	// Every product maps its provider record into outputs by spreading in only
	// the fields that are present. The alternative — always writing the key with
	// `undefined` — is what makes a binding believe it has an address, an
	// endpoint, or a size when the provider sent none, and it fails downstream
	// in the workload rather than here.

	it.each([
		["droplet", DIGITALOCEAN_DROPLET_PRODUCT_ID, "droplets"],
		["database", DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID, "databases"],
		["load balancer", DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID, "load_balancers"],
		["volume", DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID, "volumes"],
		[
			"cluster",
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
			"kubernetes_clusters",
		],
	])("withholds readiness for a bare %s record", async (_label, productId, listKey) => {
		const outcome = await resolverFor(productId).read(
			request({ productId }),
			always(json(200, { [listKey]: [{ id: "id-1", name: "thing" }] })),
		);
		expect(outcome?.outputs).toEqual({
			name: "thing",
			ready: false,
			operationConfirmed: false,
		});
	});

	it("publishes the droplet's public and private addresses separately", async () => {
		// A binding that reached for "the first v4 address" would hand a workload
		// a private address it cannot be reached on, or a public one it should
		// not be talking to.
		const outcome = await readDroplet(
			always(
				json(200, {
					droplets: [
						{
							id: 30,
							name: "thing",
							status: "active",
							size_slug: "s-1vcpu-1gb",
							region: { slug: "nyc3" },
							networks: {
								v4: [
									{ type: "private", ip_address: "10.0.0.2" },
									{ type: "public", ip_address: "203.0.113.7" },
								],
							},
						},
					],
				}),
			),
		);
		expect(outcome?.outputs).toMatchObject({
			publicIpv4: "203.0.113.7",
			privateIpv4: "10.0.0.2",
			size: "s-1vcpu-1gb",
			region: "nyc3",
		});
	});

	it("omits an address the droplet does not have", async () => {
		// A droplet with no public interface is a legitimate configuration.
		const outcome = await readDroplet(
			always(
				json(200, {
					droplets: [
						{
							id: 30,
							name: "thing",
							networks: {
								v4: [{ type: "private", ip_address: "10.0.0.2" }],
							},
						},
					],
				}),
			),
		);
		expect(outcome?.outputs).not.toHaveProperty("publicIpv4");
	});

	it("ignores a networks block that is not shaped as expected", async () => {
		const outcome = await readDroplet(
			always(
				json(200, {
					droplets: [{ id: 30, name: "thing", networks: { v4: "nope" } }],
				}),
			),
		);
		expect(outcome?.outputs).toEqual({
			name: "thing",
			ready: false,
			operationConfirmed: false,
		});
	});

	it("publishes the database connection fields a binding needs", async () => {
		const outcome = await resolverFor(
			DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
		).read(
			request({ productId: DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID }),
			always(
				json(200, {
					databases: [
						{
							id: "db-1",
							name: "thing",
							status: "online",
							engine: "pg",
							version: "16",
							connection: {
								host: "db.example.com",
								port: 25060,
								database: "defaultdb",
								user: "doadmin",
							},
						},
					],
				}),
			),
		);
		expect(outcome?.outputs).toMatchObject({
			host: "db.example.com",
			port: 25060,
			database: "defaultdb",
			user: "doadmin",
			engine: "pg",
			version: "16",
			status: "online",
		});
	});

	it("publishes the cluster endpoint that hands off to the kubernetes provider", async () => {
		// This resolver allocates the substrate; workload objects are resolved
		// against this apiserver by a different package, and the endpoint is the
		// only handoff between the two.
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).read(
			request({ productId: DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID }),
			always(
				json(200, {
					kubernetes_clusters: [
						{
							id: "k8s-1",
							name: "thing",
							region: "nyc3",
							version: "1.31.1-do.0",
							endpoint: "https://k8s-1.k8s.ondigitalocean.com",
							status: { state: "running" },
						},
					],
				}),
			),
		);
		expect(outcome?.outputs).toMatchObject({
			endpoint: "https://k8s-1.k8s.ondigitalocean.com",
			status: "running",
		});
	});
});

describe("drift is reported, not fixed", () => {
	// Region and engine are fixed at creation on every one of these products.
	// "Converging" them would mean destroying a running machine, a cluster, or
	// the data in a database — so the resolver says what is wrong and stops.

	it("reports a droplet that is not yet active", async () => {
		const outcome = await readDroplet(
			always(
				json(200, { droplets: [{ id: 31, name: "thing", status: "new" }] }),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("accepted, not confirmed");
	});

	it("reports droplet region drift", async () => {
		const outcome = await readDroplet(
			always(
				json(200, {
					droplets: [{ id: 31, name: "thing", region: { slug: "nyc3" } }],
				}),
			),
			{},
			{ desired: { region: "sfo3" } },
		);
		expect(outcome?.diagnostics.join(" ")).toContain("cannot be moved");
	});

	it("says nothing when the droplet matches what was asked for", async () => {
		// A diagnostic on a healthy resource trains operators to ignore them.
		const outcome = await readDroplet(
			always(
				json(200, {
					droplets: [
						{
							id: 31,
							name: "thing",
							status: "active",
							region: { slug: "nyc3" },
						},
					],
				}),
			),
			{},
			{ desired: { region: "nyc3" } },
		);
		expect(outcome?.diagnostics).toEqual([]);
	});

	it("reports a database cluster that is not yet online", async () => {
		const outcome = await resolverFor(
			DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
		).read(
			request({ productId: DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID }),
			always(
				json(200, {
					databases: [{ id: "db-1", name: "thing", status: "creating" }],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("not online");
	});

	it("reports database region drift rather than destroying the data", async () => {
		const outcome = await resolverFor(
			DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
		).read(
			request({
				productId: DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
				desired: { region: "sfo3" },
			}),
			always(
				json(200, {
					databases: [{ id: "db-1", name: "thing", region: "nyc3" }],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("destroying the data");
	});

	it("refuses to adopt a cluster running the wrong engine as the right product", async () => {
		// The Postgres product and the MySQL product address the same collection.
		// Adopting a MySQL cluster under the Postgres product would hand a
		// workload a connection string to a database that does not speak its
		// protocol, and the engine cannot be changed after creation.
		const outcome = await resolverFor(
			DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
		).read(
			request({ productId: DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID }),
			always(
				json(200, {
					databases: [{ id: "db-1", name: "thing", engine: "mysql" }],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("fixed at creation");
	});

	it("reports a load balancer that is not yet active", async () => {
		const outcome = await resolverFor(
			DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID,
		).read(
			request({ productId: DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID }),
			always(
				json(200, {
					load_balancers: [{ id: "lb-1", name: "thing", status: "new" }],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("accepted, not confirmed");
	});

	it("publishes the load balancer's address once it has one", async () => {
		const outcome = await resolverFor(
			DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID,
		).read(
			request({ productId: DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID }),
			always(
				json(200, {
					load_balancers: [
						{
							id: "lb-1",
							name: "thing",
							status: "active",
							ip: "203.0.113.80",
							algorithm: "round_robin",
							region: { slug: "nyc3" },
						},
					],
				}),
			),
		);
		expect(outcome?.outputs).toMatchObject({
			ip: "203.0.113.80",
			algorithm: "round_robin",
			region: "nyc3",
		});
		expect(outcome?.diagnostics).toEqual([]);
	});

	it("reports a volume shrink rather than replacing the volume", async () => {
		// Replacing a volume to make it smaller destroys the data on it.
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(
			request({
				productId: DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
				desired: { sizeGigabytes: 10 },
			}),
			always(
				json(200, {
					volumes: [{ id: "vol-1", name: "thing", size_gigabytes: 50 }],
				}),
			),
		);
		expect(outcome.diagnostics.join(" ")).toContain("only grow");
	});

	it("refuses a volume create with no size", async () => {
		expect(
			await codeOf(() =>
				resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).reconcile(
					request({
						productId: DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
						desired: { region: "nyc3" },
					}),
					always(json(200, { volumes: [] })),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});
});

describe("delete races", () => {
	it.each([
		["droplet", DIGITALOCEAN_DROPLET_PRODUCT_ID, "droplets"],
		["database", DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID, "databases"],
		["load balancer", DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID, "load_balancers"],
		["volume", DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID, "volumes"],
		[
			"cluster",
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
			"kubernetes_clusters",
		],
	])("treats a 404 on the %s delete as already gone", async (_label, productId, listKey) => {
		// Two reconciles racing is normal. The second finds the resource in the
		// list, deletes it, and gets a 404 — which is the goal state, not a
		// failure to retry or escalate.
		await expect(
			resolverFor(productId).delete(
				request({ productId }),
				sequence(
					json(200, { [listKey]: [{ id: "id-1", name: "thing" }] }),
					raw(404, ""),
				),
			),
		).resolves.toBeUndefined();
	});

	it.each([
		["droplet", DIGITALOCEAN_DROPLET_PRODUCT_ID, "droplets"],
		["database", DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID, "databases"],
		["load balancer", DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID, "load_balancers"],
		["volume", DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID, "volumes"],
		[
			"cluster",
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
			"kubernetes_clusters",
		],
	])("deletes nothing when no %s carries the name", async (_label, productId, listKey) => {
		await expect(
			resolverFor(productId).delete(
				request({ productId }),
				always(json(200, { [listKey]: [] })),
			),
		).resolves.toBeUndefined();
	});

	it("still refuses a delete the provider rejected for another reason", async () => {
		// 404 is absence; 409 is "this resource is attached to something".
		// Folding the second into the first would report a successful teardown
		// that left the resource running and billing.
		expect(
			await codeOf(() =>
				resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).delete(
					request({ productId: DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID }),
					sequence(
						json(200, {
							volumes: [{ id: "vol-1", name: "thing" }],
						}),
						json(409, { id: "conflict", message: "still attached" }),
					),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});
});

describe("the spaces credential and clock", () => {
	const desired = { region: "nyc3" };

	function readSpaces(
		transport: HttpTransport,
		overrides: Partial<DigitalOceanResolverOptions> = {},
		credentialRef?: string,
	) {
		return resolverFor(DIGITALOCEAN_SPACES_PRODUCT_ID, overrides).read(
			request({
				productId: DIGITALOCEAN_SPACES_PRODUCT_ID,
				desired,
				...(credentialRef === undefined ? undefined : { credentialRef }),
			}),
			transport,
		);
	}

	it("refuses when no spaces resolver was injected", async () => {
		// The control-plane token does not authenticate against the Spaces origin,
		// so falling back to it would produce a signature failure pointing at the
		// wrong credential entirely.
		expect(
			await codeOf(() =>
				readSpaces(always(raw(404, "")), {
					resolveSpacesCredential: undefined,
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses an empty spaces ref", async () => {
		expect(await codeOf(() => readSpaces(always(raw(404, "")), {}, "  "))).toBe(
			"RESOLVER_CREDENTIAL_MISSING",
		);
	});

	it("refuses a spaces ref that is really a key", async () => {
		expect(
			await codeOf(() => readSpaces(always(raw(404, "")), {}, TOKEN)),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses when the host's key resolver throws", async () => {
		expect(
			await messageOf(() =>
				readSpaces(always(raw(404, "")), {
					resolveSpacesCredential: async () => {
						throw new Error("no such secret");
					},
				}),
			),
		).toContain("no such secret");
	});

	it.each([
		["a missing access key id", { accessKeyId: "", secretAccessKey: "s" }],
		["a missing secret", { accessKeyId: "a", secretAccessKey: "" }],
	])("refuses a pair with %s", async (_label, pair) => {
		// A half-populated pair produces a valid-looking signature that
		// DigitalOcean rejects with a message about the signature rather than
		// about the custody, so the operator debugs the wrong layer.
		expect(
			await codeOf(() =>
				readSpaces(always(raw(404, "")), {
					// SAFETY: malformed host material is deliberate input to the credential boundary.
					resolveSpacesCredential: async () => pair as never,
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("accepts a clock given as a number", async () => {
		expect(await readSpaces(always(raw(404, "")), { nowMs: NOW_MS })).toBe(
			undefined,
		);
	});

	it("accepts a clock given as a function", async () => {
		expect(
			await readSpaces(always(raw(404, "")), { nowMs: () => NOW_MS }),
		).toBe(undefined);
	});

	it("refuses a missing clock rather than reading the ambient one", async () => {
		// SigV4 signs a timestamp. A resolver reaching for `Date.now()` would be
		// untestable, and the signature would silently depend on when it ran.
		expect(
			await codeOf(() =>
				readSpaces(always(raw(404, "")), { nowMs: undefined }),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses a non-finite clock", async () => {
		expect(
			await codeOf(() =>
				readSpaces(always(raw(404, "")), { nowMs: Number.NaN }),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("does not demand spaces prerequisites for a control-plane product", async () => {
		// A registry is a catalog. Building one to reconcile a Postgres cluster
		// must not fail for want of an object-storage key pair never sent.
		const outcome = await readDroplet(always(json(200, { droplets: [] })), {
			nowMs: undefined,
			resolveSpacesCredential: undefined,
		});
		expect(outcome).toBeUndefined();
	});
});
