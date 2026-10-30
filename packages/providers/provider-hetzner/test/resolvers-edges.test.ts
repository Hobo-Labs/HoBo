/**
 * Hetzner resolver edges — the paths a healthy provider never takes.
 *
 * `resolvers.test.ts` covers the shapes Hetzner actually returns on a good day.
 * This file covers the rest: a credential that is really a secret, a body that
 * is not JSON, a name filter that matched twice, a record with fields missing,
 * a delete that races another delete. Those are the paths that run exactly when
 * something has already gone wrong, which is when a resolver's behaviour matters
 * most and when nobody is watching it.
 *
 * Two properties get most of the attention here:
 *
 * **A secret must never become a locator.** `credentialRef` is written into the
 * event log verbatim. A resolver that accepted a pasted API token there would
 * have leaked it before the first request went out, and the leak would be
 * invisible because everything downstream would work perfectly. So the token
 * shape is refused with its own code, distinct from "missing".
 *
 * **An unknown outcome is refused, never assumed.** A body this code cannot
 * parse means the call's effect is unknown. Treating unparseable as "nothing
 * happened" would let a create that actually succeeded be retried into a
 * duplicate; treating it as success would report a resource that may not exist.
 * Both are worse than a typed refusal.
 *
 * Everything is driven through an injected fake transport. No network, no
 * credential, no Hetzner project.
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
	HETZNER_CLOUD_SERVER_PRODUCT_ID,
	HETZNER_LOAD_BALANCER_PRODUCT_ID,
	HETZNER_OBJECT_STORAGE_PRODUCT_ID,
	HETZNER_STORAGE_BOX_PRODUCT_ID,
	HETZNER_VOLUME_PRODUCT_ID,
	type HetznerResolverOptions,
	hetznerResolverRegistry,
	redactHetznerText,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

type Rec = JsonObject;

const CREDENTIAL_REF = "env://HCLOUD_TOKEN";
const TOKEN = "fakehetznerprojecttoken0123456789abcdefgh";
const NOW_MS = Date.parse("2026-08-19T12:00:00.000Z");
const OBJECT_STORAGE_KEYS = Object.freeze({
	accessKeyId: "FAKEHETZNEROBJACCESSKEY",
	secretAccessKey: "fake-object-storage-secret-key-0123456789",
});

function options(
	overrides: Partial<HetznerResolverOptions> = {},
): HetznerResolverOptions {
	return {
		resolveCredential: async () => TOKEN,
		resolveObjectStorageCredential: async () => OBJECT_STORAGE_KEYS,
		resolveStorageBoxPassword: async () => "fake-storage-box-password",
		nowMs: NOW_MS,
		...overrides,
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<HetznerResolverOptions> = {},
): ResourceResolver {
	const resolver = hetznerResolverRegistry(options(overrides)).get(productId);
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
			slot: "bucket",
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

/** A transport that answers every call with the same canned response. */
function always(response: TransportResponse): HttpTransport {
	return async () => response;
}

/** A transport that answers each call from a queue, in order. */
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

// ---------------------------------------------------------------------------

describe("redaction", () => {
	it("scrubs anything token-shaped", async () => {
		expect(
			redactHetznerText("token abcdefghij0123456789ABCDEFGHIJ0123456789 used"),
		).toContain("[redacted]");
	});

	it("leaves short words alone", async () => {
		// Redacting ordinary prose would make provider errors unreadable, and an
		// unreadable error gets ignored rather than acted on.
		expect(redactHetznerText("volume is full")).toBe("volume is full");
	});

	it("truncates long text with an ellipsis", async () => {
		// Provider text ends up in diagnostics an operator reads in a terminal; a
		// multi-kilobyte echo of a request body would bury the actual failure.
		// Short words, so the scrub leaves the length alone and truncation is
		// what is actually being measured.
		const scrubbed = redactHetznerText("ab cd ".repeat(200), 100);
		expect(scrubbed).toHaveLength(101);
		expect(scrubbed.endsWith("…")).toBe(true);
	});

	it("scrubs before it truncates", async () => {
		// Truncating first would cut the token mid-string and leave the prefix
		// intact — a shorter leak is still a leak. Scrubbing first means the only
		// thing the limit can cut is the redaction marker.
		expect(redactHetznerText("abcdefghij0123456789ABCDEFGHIJ", 5)).toBe(
			"[reda…",
		);
	});

	it("does not append an ellipsis to text that fits", async () => {
		expect(redactHetznerText("short", 100).endsWith("…")).toBe(false);
	});
});

describe("the credential boundary", () => {
	it("refuses an empty credentialRef", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({
						productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
						credentialRef: "   ",
					}),
					always(json(200, { servers: [] })),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses a credentialRef that is really a token", async () => {
		// This is the one that matters most: `credentialRef` is recorded in the
		// event log verbatim, so a pasted token has already leaked by the time
		// anything uses it — and every request would still succeed, which is what
		// makes the leak invisible without this check.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({
						productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
						credentialRef: TOKEN,
					}),
					always(json(200, { servers: [] })),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("says the material itself must never be passed", async () => {
		// The refusal that actually fires here is core's, at `parseResolveRequest`
		// — it rejects the token shape before the resolver ever sees the request.
		// That is the right layering (the boundary refuses it once for every
		// provider), and the resolver's own identical check is defence in depth
		// for a caller that skipped the parse. Pinning core's wording here keeps
		// the two from silently diverging into different advice.
		const message = await messageOf(() =>
			resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
				request({
					productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
					credentialRef: TOKEN,
				}),
				always(json(200, { servers: [] })),
			),
		);
		expect(message).toContain("never the material itself");
	});

	it("refuses a ref that is not a locator", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({
						productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
						credentialRef: "just-a-name",
					}),
					always(json(200, { servers: [] })),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("never echoes a rejected ref that contains material", async () => {
		// The refusal explains the rule rather than quoting the value back. That
		// matters most for exactly this input: a token pasted into the field with
		// a stray word in front of it is still a token, and an error message is
		// one of the most widely-copied strings in an incident.
		const leaky = "not a ref abcdefghij0123456789ABCDEFGHIJ";
		const message = await messageOf(() =>
			resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
				request({
					productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
					credentialRef: leaky,
				}),
				always(json(200, { servers: [] })),
			),
		);
		expect(message).not.toContain("abcdefghij0123456789ABCDEFGHIJ");
		expect(message).toContain("whitespace");
	});

	it("refuses when the host's resolver throws", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID, {
					resolveCredential: async () => {
						throw new Error("vault is sealed");
					},
				}).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(json(200, { servers: [] })),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("quotes the host's reason so the operator can fix it", async () => {
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID, {
					resolveCredential: async () => {
						throw new Error("vault is sealed");
					},
				}).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(json(200, { servers: [] })),
				),
			),
		).toContain("vault is sealed");
	});

	it("survives a host that throws a non-Error", async () => {
		// A rejected promise carrying a string is legal and happens in the wild;
		// a resolver that assumed `.message` would crash instead of refusing.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID, {
					resolveCredential: async () => {
						throw "sealed";
					},
				}).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(json(200, { servers: [] })),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses when the host resolves the ref to nothing", async () => {
		// Carrying on unauthenticated would surface at Hetzner as a 401 about
		// permissions, sending the operator to look at their project's API tokens
		// when the real problem is a reference nobody registered.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID, {
					resolveCredential: async () => "   ",
				}).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(json(200, { servers: [] })),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses to build a resolver with no resolveCredential at all", async () => {
		expect(() =>
			hetznerResolverRegistry({
				// SAFETY: deliberately violate the injected port to verify runtime rejection.
				resolveCredential: undefined as never,
			}),
		).toThrow(/never reads an environment variable/u);
	});
});

describe("the object storage credential boundary", () => {
	const desired = { location: "fsn1" };

	it("refuses when no object storage resolver was injected", async () => {
		// The project API token does not authenticate against the S3 origin, so
		// falling back to it would produce a signature failure that points at the
		// wrong credential entirely.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID, {
					resolveObjectStorageCredential: undefined,
				}).read(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses an empty ref", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).read(
					request({
						productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID,
						desired,
						credentialRef: "  ",
					}),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses a ref that is really a key", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).read(
					request({
						productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID,
						desired,
						credentialRef: TOKEN,
					}),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses a ref that is not a locator", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).read(
					request({
						productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID,
						desired,
						credentialRef: "bucket-keys",
					}),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses when the host's key resolver throws", async () => {
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID, {
					resolveObjectStorageCredential: async () => {
						throw new Error("no such secret");
					},
				}).read(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					always(raw(404, "")),
				),
			),
		).toContain("no such secret");
	});

	it.each([
		["a missing access key id", { accessKeyId: "", secretAccessKey: "s" }],
		["a missing secret", { accessKeyId: "a", secretAccessKey: "" }],
	])("refuses a pair with %s", async (_label, pair) => {
		// A half-populated pair produces a valid-looking signature that Hetzner
		// rejects with a message about the signature, not about the custody — so
		// the operator debugs the wrong layer.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID, {
					// SAFETY: malformed host material is deliberate input to the credential boundary.
					resolveObjectStorageCredential: async () => pair as never,
				}).read(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses a pair that is not an object at all", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID, {
					// SAFETY: deliberately omit the injected key pair to test the runtime refusal.
					resolveObjectStorageCredential: async () => undefined as never,
				}).read(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});
});

describe("the signing clock", () => {
	it("accepts a number", async () => {
		const outcome = await resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID, {
			nowMs: NOW_MS,
		}).read(
			request({
				productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID,
				desired: { location: "fsn1" },
			}),
			always(raw(404, "")),
		);
		expect(outcome).toBeUndefined();
	});

	it("accepts a function", async () => {
		const outcome = await resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID, {
			nowMs: () => NOW_MS,
		}).read(
			request({
				productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID,
				desired: { location: "fsn1" },
			}),
			always(raw(404, "")),
		);
		expect(outcome).toBeUndefined();
	});

	it("refuses a missing clock rather than reading the ambient one", async () => {
		// SigV4 signs a timestamp. A resolver that reached for `Date.now()` would
		// be untestable, and the signature would silently depend on when the
		// process happened to run.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID, {
					nowMs: undefined,
				}).read(
					request({
						productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID,
						desired: { location: "fsn1" },
					}),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses a non-finite clock", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID, {
					nowMs: Number.NaN,
				}).read(
					request({
						productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID,
						desired: { location: "fsn1" },
					}),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("does not demand a clock for a Cloud API product", async () => {
		// A registry is a catalog. Building one to reconcile a server must not
		// fail for want of an S3 signing clock that will never be used.
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID, {
			nowMs: undefined,
		}).read(
			request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
			always(json(200, { servers: [] })),
		);
		expect(outcome).toBeUndefined();
	});
});

describe("routing", () => {
	it("refuses a request for another product", async () => {
		// Picking a resolver by hand and handing it the wrong request would
		// otherwise send a volume's desired shape down the server create path.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_VOLUME_PRODUCT_ID }),
					always(json(200, { servers: [] })),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("says to route through the registry", async () => {
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_VOLUME_PRODUCT_ID }),
					always(json(200, { servers: [] })),
				),
			),
		).toContain("route the request through the registry");
	});
});

describe("reading the collection", () => {
	it("refuses a body with no list array", async () => {
		// Concluding "absent" from a body this code cannot search would make the
		// next step a create — duplicating a resource that already exists.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(json(200, { unexpected: "shape" })),
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("says a create would risk a duplicate", async () => {
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(json(200, { unexpected: "shape" })),
				),
			),
		).toContain("risk duplicating an existing resource");
	});

	it("refuses when the exact name filter matched twice", async () => {
		// Hetzner enforces name uniqueness per project, so two matches means the
		// filter did not do what this code believes. Picking one by listing order
		// would make the managed resource depend on the API's answer order.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(
						json(200, {
							servers: [
								{ id: 1, name: "thing" },
								{ id: 2, name: "thing" },
							],
						}),
					),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("refuses malformed entries rather than treating them as absence", async () => {
		await expect(
			resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
				request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
				always(json(200, { servers: [null, "thing", 7] })),
			),
		).rejects.toThrow(/incomplete collection/u);
	});

	it("ignores an entry whose name does not match exactly", async () => {
		// The filter is the provider's; this second check is what stops a fuzzy
		// server-side match from being adopted as an exact one.
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
			always(json(200, { servers: [{ id: 1, name: "thing-2" }] })),
		);
		expect(outcome).toBeUndefined();
	});
});

describe("reading the body", () => {
	it("treats an empty success body as an empty record", async () => {
		// Hetzner answers some deletes with 204 No Content; treating that as
		// unparseable would turn a successful delete into a failure.
		await expect(
			resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).delete(
				request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
				sequence(
					json(200, { servers: [{ id: 5, name: "thing" }] }),
					raw(204, ""),
				),
			),
		).resolves.toBeUndefined();
	});

	it("refuses a success body that is not JSON", async () => {
		// An HTML error page from a proxy is the usual source. The call's effect
		// is unknown, and unknown is refused rather than assumed either way.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(raw(200, "<html>gateway timeout</html>")),
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("says the outcome is unknown rather than guessing", async () => {
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(raw(200, "<html>gateway timeout</html>")),
				),
			),
		).toContain("refused rather than assumed");
	});

	it("refuses JSON that is not an object", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(raw(200, "[1,2,3]")),
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("refuses a record with no usable id", async () => {
		// An unaddressable resource cannot be deleted or updated later; recording
		// it as managed would strand it.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(json(200, { servers: [{ name: "thing" }] })),
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("accepts a string id", async () => {
		// Hetzner sends numbers today; a provider that switched to strings should
		// not break every resolver in this package.
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
			always(json(200, { servers: [{ id: "srv-1", name: "thing" }] })),
		);
		expect(outcome?.physicalId).toBe("srv-1");
	});

	it("refuses a fractional id rather than truncating it", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(json(200, { servers: [{ id: 1.5, name: "thing" }] })),
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});
});

describe("provider refusals", () => {
	it("quotes the provider's code and message", async () => {
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(
						json(422, {
							error: { code: "invalid_input", message: "bad location" },
						}),
					),
				),
			),
		).toContain("invalid_input: bad location");
	});

	it("redacts anything token-shaped in the provider's message", async () => {
		// Hetzner echoes request context in error text, and that context has
		// carried token fragments and private paths before.
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(
						json(401, {
							error: { code: "unauthorized", message: `token ${TOKEN} denied` },
						}),
					),
				),
			),
		).not.toContain(TOKEN);
	});

	it("says so plainly when the provider sent no detail", async () => {
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(json(500, {})),
				),
			),
		).toContain("no error detail was returned");
	});

	it("falls back to a redacted snippet when the error body is not JSON", async () => {
		// A proxy's HTML page still tells the operator something; discarding it
		// entirely would leave them with only a status code.
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(raw(502, "upstream connect error")),
				),
			),
		).toContain("upstream connect error");
	});

	it("still names the status when the error body is empty", async () => {
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(raw(503, "")),
				),
			),
		).toContain("status 503");
	});

	it("carries the typed code, not just a message", async () => {
		// The lane branches on the code; a stringly-typed failure would collapse
		// "provider said no" into "something went wrong".
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
					always(raw(503, "")),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});
});

describe("naming and placement", () => {
	it("prefers desired.name over the logical id", async () => {
		// The name is what makes reconcile convergent; a logical id that shadowed
		// an explicit name would search for the wrong resource.
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				logicalId: "logical",
				desired: { name: "explicit" },
			}),
			always(json(200, { servers: [{ id: 3, name: "explicit" }] })),
		);
		expect(outcome?.outputs.name).toBe("explicit");
	});

	it("refuses a create with no location", async () => {
		// Hetzner's locations span jurisdictions — `fsn1` and `ash` are on
		// different continents under different law — so defaulting one is a
		// residency decision the resolver may not take.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).reconcile(
					request({
						productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
						desired: { serverType: "cx22", image: "ubuntu-24.04" },
					}),
					always(json(200, { servers: [] })),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("accepts region as a synonym for location", async () => {
		// Every other provider in this repo calls it a region; refusing the
		// synonym would make a portable manifest un-portable for no gain.
		const outcome = await resolverFor(
			HETZNER_CLOUD_SERVER_PRODUCT_ID,
		).reconcile(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				desired: { serverType: "cx22", image: "ubuntu-24.04", region: "fsn1" },
			}),
			sequence(
				json(200, { servers: [] }),
				json(201, { server: { id: 9, name: "thing" } }),
			),
		);
		expect(outcome.action).toBe("create");
	});

	it.each([
		"serverType",
		"image",
	])("refuses a create with no %s", async (missing) => {
		// A machine billed at a size nobody asked for is a cost incident, and
		// an image nobody asked for is an unknown OS in production.
		const desired = {
			location: "fsn1",
			...(missing === "serverType"
				? { image: "ubuntu-24.04" }
				: { serverType: "cx22" }),
		};
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).reconcile(
					request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID, desired }),
					always(json(200, { servers: [] })),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});
});

describe("adopt versus noop", () => {
	it("adopts a resource the request did not know about", async () => {
		// Adopting something unmanaged is a fact an operator should see in the
		// audit record, not something folded into "nothing happened".
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
			always(json(200, { servers: [{ id: 11, name: "thing" }] })),
		);
		expect(outcome?.action).toBe("adopt");
	});

	it("reports noop when the caller already named the physical id", async () => {
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				physicalId: "11",
			}),
			always(json(200, { server: { id: 11, name: "thing" } })),
		);
		expect(outcome?.action).toBe("noop");
	});

	it("refuses a blank physical id at the parse boundary", async () => {
		// A whitespace physicalId is neither present nor absent. Core rejects it
		// outright rather than letting each resolver decide, which is why the
		// resolver's own emptiness check never has to disambiguate — it would
		// otherwise be the difference between reporting `noop` and `adopt` for
		// the same resource, and the audit record depends on that distinction.
		expect(
			await messageOf(async () =>
				request({
					productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
					physicalId: " ",
				}),
			),
		).toContain("non-empty provider id");
	});
});

describe("outputs from a sparse record", () => {
	it("omits server fields Hetzner did not send", async () => {
		// A record carrying only an id is what a partially-provisioned server
		// looks like. Publishing `ipv4: undefined` would make a binding think it
		// has an address.
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
			always(json(200, { servers: [{ id: 12, name: "thing" }] })),
		);
		expect(outcome?.outputs).toEqual({
			name: "thing",
			ready: false,
			operationConfirmed: false,
		});
	});

	it("publishes every server field when Hetzner sends them", async () => {
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
			always(
				json(200, {
					servers: [
						{
							id: 12,
							name: "thing",
							status: "running",
							server_type: { name: "cx22" },
							datacenter: { location: { name: "fsn1" } },
							public_net: {
								ipv4: { ip: "203.0.113.1" },
								ipv6: { ip: "2001:db8::1" },
							},
						},
					],
				}),
			),
		);
		expect(outcome?.outputs).toMatchObject({
			status: "running",
			ipv4: "203.0.113.1",
			ipv6: "2001:db8::1",
			serverType: "cx22",
			location: "fsn1",
		});
	});

	it("omits load balancer fields Hetzner did not send", async () => {
		const outcome = await resolverFor(HETZNER_LOAD_BALANCER_PRODUCT_ID).read(
			request({ productId: HETZNER_LOAD_BALANCER_PRODUCT_ID }),
			always(json(200, { load_balancers: [{ id: 13, name: "thing" }] })),
		);
		expect(outcome?.outputs).toEqual({
			name: "thing",
			ready: false,
			operationConfirmed: false,
		});
	});

	it("omits volume fields Hetzner did not send", async () => {
		const outcome = await resolverFor(HETZNER_VOLUME_PRODUCT_ID).read(
			request({ productId: HETZNER_VOLUME_PRODUCT_ID }),
			always(json(200, { volumes: [{ id: 14, name: "thing" }] })),
		);
		expect(outcome?.outputs).toEqual({
			name: "thing",
			ready: false,
			operationConfirmed: false,
		});
	});

	it("publishes the linux device when a volume is attached", async () => {
		// This is the path a workload mounts; reconstructing it from the id in a
		// binding would be guessing at a provider convention.
		const outcome = await resolverFor(HETZNER_VOLUME_PRODUCT_ID).read(
			request({ productId: HETZNER_VOLUME_PRODUCT_ID }),
			always(
				json(200, {
					volumes: [
						{
							id: 14,
							name: "thing",
							status: "available",
							size: 10,
							location: { name: "fsn1" },
							linux_device: "/dev/disk/by-id/scsi-0HC_Volume_14",
						},
					],
				}),
			),
		);
		expect(outcome?.outputs).toMatchObject({
			sizeGb: 10,
			location: "fsn1",
			linuxDevice: "/dev/disk/by-id/scsi-0HC_Volume_14",
		});
	});

	it("reports an empty status rather than omitting it for a sparse storage box", async () => {
		// Unlike the others, the Storage Box shape always carries `name` and
		// `status`; a binding reads them unconditionally, so an absent key would
		// be a schema change rather than a missing value.
		const outcome = await resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID).read(
			request({ productId: HETZNER_STORAGE_BOX_PRODUCT_ID }),
			always(json(200, { storage_boxes: [{ id: 15, name: "thing" }] })),
		);
		expect(outcome?.outputs).toEqual({
			name: "thing",
			status: "",
			ready: false,
			operationConfirmed: false,
		});
	});

	it("derives the mount endpoints from the server name", async () => {
		// A binding should not have to reconstruct a hostname from the record.
		const outcome = await resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID).read(
			request({ productId: HETZNER_STORAGE_BOX_PRODUCT_ID }),
			always(
				json(200, {
					storage_boxes: [
						{
							id: 15,
							name: "thing",
							status: "active",
							username: "u1",
							server: "u1.your-storagebox.de",
							storage_box_type: { name: "bx11" },
							location: { name: "fsn1" },
						},
					],
				}),
			),
		);
		expect(outcome?.outputs).toMatchObject({
			sftpEndpoint: "sftp://u1.your-storagebox.de",
			sambaEndpoint: "//u1.your-storagebox.de/backup",
		});
	});

	it("accepts a storage box type given as a bare string", async () => {
		// Hetzner's unified API has answered with both a nested object and a bare
		// string for these references; a resolver that handled only one would
		// report the type as absent for half the responses.
		const outcome = await resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID).read(
			request({ productId: HETZNER_STORAGE_BOX_PRODUCT_ID }),
			always(
				json(200, {
					storage_boxes: [{ id: 15, name: "thing", storage_box_type: "bx11" }],
				}),
			),
		);
		expect(outcome?.outputs.storageBoxType).toBe("bx11");
	});

	it("ignores a type reference that is neither a string nor an object", async () => {
		const outcome = await resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID).read(
			request({ productId: HETZNER_STORAGE_BOX_PRODUCT_ID }),
			always(
				json(200, {
					storage_boxes: [{ id: 15, name: "thing", storage_box_type: 7 }],
				}),
			),
		);
		expect(outcome?.outputs.storageBoxType).toBeUndefined();
	});
});

describe("diagnostics", () => {
	it("reports a server that is not yet running", async () => {
		// The resolver does not poll, so an accepted create is not a confirmed
		// one, and saying otherwise would let a lane proceed to a machine that
		// has no SSH daemon yet.
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID }),
			always(
				json(200, {
					servers: [{ id: 16, name: "thing", status: "initializing" }],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("not running");
	});

	it("reports location drift rather than replacing the machine", async () => {
		// A server cannot be moved between locations, so "converging" would mean
		// destroying a running machine to satisfy a manifest edit.
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				desired: { location: "ash" },
			}),
			always(
				json(200, {
					servers: [
						{
							id: 16,
							name: "thing",
							status: "running",
							datacenter: { location: { name: "fsn1" } },
						},
					],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("cannot be moved");
	});

	it("reports server type drift rather than power-cycling", async () => {
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				desired: { serverType: "cx32" },
			}),
			always(
				json(200, {
					servers: [
						{
							id: 16,
							name: "thing",
							status: "running",
							server_type: { name: "cx22" },
						},
					],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("rescaling requires");
	});

	it("says nothing when the server matches what was asked for", async () => {
		// A diagnostic on a healthy resource trains operators to ignore them.
		const outcome = await resolverFor(HETZNER_CLOUD_SERVER_PRODUCT_ID).read(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				desired: { location: "fsn1", serverType: "cx22" },
			}),
			always(
				json(200, {
					servers: [
						{
							id: 16,
							name: "thing",
							status: "running",
							server_type: { name: "cx22" },
							datacenter: { location: { name: "fsn1" } },
						},
					],
				}),
			),
		);
		expect(outcome?.diagnostics).toEqual([]);
	});

	it("reports a volume shrink rather than replacing the volume", async () => {
		// Replacing a volume to make it smaller destroys the data on it.
		const outcome = await resolverFor(HETZNER_VOLUME_PRODUCT_ID).read(
			request({
				productId: HETZNER_VOLUME_PRODUCT_ID,
				desired: { sizeGb: 10 },
			}),
			always(json(200, { volumes: [{ id: 17, name: "thing", size: 50 }] })),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("only grow");
	});

	it("reports volume location drift", async () => {
		const outcome = await resolverFor(HETZNER_VOLUME_PRODUCT_ID).read(
			request({
				productId: HETZNER_VOLUME_PRODUCT_ID,
				desired: { location: "ash" },
			}),
			always(
				json(200, {
					volumes: [{ id: 17, name: "thing", location: { name: "fsn1" } }],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("immutable");
	});

	it("reports a storage box that is still initializing", async () => {
		const outcome = await resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID).read(
			request({ productId: HETZNER_STORAGE_BOX_PRODUCT_ID }),
			always(
				json(200, {
					storage_boxes: [{ id: 18, name: "thing", status: "initializing" }],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("not mountable");
	});

	it("reports a locked storage box as unfixable from here", async () => {
		// Hetzner locks a box for non-payment or suspension; presenting that as a
		// transient error would send an operator hunting through code.
		const outcome = await resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID).read(
			request({ productId: HETZNER_STORAGE_BOX_PRODUCT_ID }),
			always(
				json(200, {
					storage_boxes: [{ id: 18, name: "thing", status: "locked" }],
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain(
			"no code change here can fix",
		);
	});
});

describe("delete races", () => {
	it.each([
		["server", HETZNER_CLOUD_SERVER_PRODUCT_ID, "servers"],
		["load balancer", HETZNER_LOAD_BALANCER_PRODUCT_ID, "load_balancers"],
		["volume", HETZNER_VOLUME_PRODUCT_ID, "volumes"],
		["storage box", HETZNER_STORAGE_BOX_PRODUCT_ID, "storage_boxes"],
	])("treats a 404 on the %s delete as already gone", async (_label, productId, listKey) => {
		// Two reconciles racing is normal. The second one finds the resource in
		// the list, deletes it, and gets a 404 — which is the goal state, not a
		// failure to be retried or escalated.
		await expect(
			resolverFor(productId).delete(
				request({ productId }),
				sequence(
					json(200, { [listKey]: [{ id: 19, name: "thing" }] }),
					raw(404, ""),
				),
			),
		).resolves.toBeUndefined();
	});

	it.each([
		["server", HETZNER_CLOUD_SERVER_PRODUCT_ID, "servers"],
		["load balancer", HETZNER_LOAD_BALANCER_PRODUCT_ID, "load_balancers"],
		["volume", HETZNER_VOLUME_PRODUCT_ID, "volumes"],
		["storage box", HETZNER_STORAGE_BOX_PRODUCT_ID, "storage_boxes"],
	])("deletes nothing when no %s carries the name", async (_label, productId, listKey) => {
		await expect(
			resolverFor(productId).delete(
				request({ productId }),
				always(json(200, { [listKey]: [] })),
			),
		).resolves.toBeUndefined();
	});

	it("still refuses a delete the provider rejected for another reason", async () => {
		// 404 is absence; 409 is "this resource is attached to something". Folding
		// the second into the first would report a successful teardown that left
		// the resource running and billing.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_VOLUME_PRODUCT_ID).delete(
					request({ productId: HETZNER_VOLUME_PRODUCT_ID }),
					sequence(
						json(200, { volumes: [{ id: 20, name: "thing" }] }),
						json(409, {
							error: { code: "resource_in_use", message: "still attached" },
						}),
					),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});
});

describe("update paths", () => {
	it("falls back to the pre-change record when the refresh finds nothing", async () => {
		// A refresh that races a rename returns nothing. Publishing empty outputs
		// for a resource that was just successfully changed would look like the
		// change destroyed it.
		const outcome = await resolverFor(
			HETZNER_LOAD_BALANCER_PRODUCT_ID,
		).reconcile(
			request({
				productId: HETZNER_LOAD_BALANCER_PRODUCT_ID,
				desired: { algorithm: "least_connections" },
			}),
			sequence(
				json(200, {
					load_balancers: [
						{ id: 21, name: "thing", algorithm: { type: "round_robin" } },
					],
				}),
				json(201, { action: { id: 99, status: "success" } }),
				json(200, { load_balancers: [] }),
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.algorithm).toBe("round_robin");
	});

	it("leaves a matching algorithm alone", async () => {
		// An update call that changes nothing still shows up in an audit log as a
		// mutation, and still costs a request against the rate limit.
		const outcome = await resolverFor(
			HETZNER_LOAD_BALANCER_PRODUCT_ID,
		).reconcile(
			request({
				productId: HETZNER_LOAD_BALANCER_PRODUCT_ID,
				desired: { algorithm: "round_robin" },
			}),
			always(
				json(200, {
					load_balancers: [
						{ id: 21, name: "thing", algorithm: { type: "round_robin" } },
					],
				}),
			),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("leaves the algorithm alone when the request does not name one", async () => {
		const outcome = await resolverFor(
			HETZNER_LOAD_BALANCER_PRODUCT_ID,
		).reconcile(
			request({ productId: HETZNER_LOAD_BALANCER_PRODUCT_ID }),
			always(
				json(200, {
					load_balancers: [
						{ id: 21, name: "thing", algorithm: { type: "round_robin" } },
					],
				}),
			),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("does not resize a volume that is already large enough", async () => {
		// Hetzner volumes only grow; a request for a smaller size is drift to
		// report, never a resize to send.
		const outcome = await resolverFor(HETZNER_VOLUME_PRODUCT_ID).reconcile(
			request({
				productId: HETZNER_VOLUME_PRODUCT_ID,
				desired: { sizeGb: 10 },
			}),
			always(json(200, { volumes: [{ id: 22, name: "thing", size: 50 }] })),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("says the filesystem still needs extending after a grow", async () => {
		// The resolver does not run commands on a machine, so a volume that grew
		// at the provider is still the old size to the workload until someone
		// extends it. Silence here would look like the job was finished.
		const outcome = await resolverFor(HETZNER_VOLUME_PRODUCT_ID).reconcile(
			request({
				productId: HETZNER_VOLUME_PRODUCT_ID,
				desired: { sizeGb: 50 },
			}),
			sequence(
				json(200, { volumes: [{ id: 22, name: "thing", size: 10 }] }),
				json(201, { action: { id: 98, status: "success" } }),
				json(200, { volumes: [{ id: 22, name: "thing", size: 50 }] }),
			),
		);
		expect(outcome.diagnostics.join(" ")).toContain("filesystem extended");
	});

	it("refuses a volume create with no size", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_VOLUME_PRODUCT_ID).reconcile(
					request({
						productId: HETZNER_VOLUME_PRODUCT_ID,
						desired: { location: "fsn1" },
					}),
					always(json(200, { volumes: [] })),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});
});

describe("asynchronous actions", () => {
	it("reports an action that is still running", async () => {
		// Hetzner provisions asynchronously. Reporting a running action as done
		// would let the next lane step act on a machine that does not exist yet.
		const outcome = await resolverFor(
			HETZNER_CLOUD_SERVER_PRODUCT_ID,
		).reconcile(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				desired: {
					serverType: "cx22",
					image: "ubuntu-24.04",
					location: "fsn1",
				},
			}),
			sequence(
				json(200, { servers: [] }),
				json(201, {
					server: { id: 23, name: "thing" },
					action: { id: 900, status: "running" },
				}),
			),
		);
		expect(outcome.diagnostics.join(" ")).toContain("accepted, not confirmed");
	});

	it("says nothing about an action that already succeeded", async () => {
		const outcome = await resolverFor(
			HETZNER_CLOUD_SERVER_PRODUCT_ID,
		).reconcile(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				desired: {
					serverType: "cx22",
					image: "ubuntu-24.04",
					location: "fsn1",
				},
			}),
			sequence(
				json(200, { servers: [] }),
				json(201, {
					server: { id: 23, name: "thing", status: "running" },
					action: { id: 900, status: "success" },
				}),
			),
		);
		expect(outcome.diagnostics).toEqual([]);
	});

	it("publishes the action id so a caller can wait on it", async () => {
		const outcome = await resolverFor(
			HETZNER_CLOUD_SERVER_PRODUCT_ID,
		).reconcile(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				desired: {
					serverType: "cx22",
					image: "ubuntu-24.04",
					location: "fsn1",
				},
			}),
			sequence(
				json(200, { servers: [] }),
				json(201, {
					server: { id: 23, name: "thing" },
					action: { id: 900, status: "running" },
				}),
			),
		);
		expect(outcome.outputs.actionId).toBe(900);
	});

	it("omits the action id when the provider sent none", async () => {
		// Publishing `actionId: undefined` would give a caller something to poll
		// that resolves to nothing.
		const outcome = await resolverFor(
			HETZNER_CLOUD_SERVER_PRODUCT_ID,
		).reconcile(
			request({
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				desired: {
					serverType: "cx22",
					image: "ubuntu-24.04",
					location: "fsn1",
				},
			}),
			sequence(
				json(200, { servers: [] }),
				json(201, { server: { id: 23, name: "thing", status: "running" } }),
			),
		);
		expect(outcome.outputs).not.toHaveProperty("actionId");
	});
});

describe("the storage box password", () => {
	it("refuses a create with no password resolver injected", async () => {
		// A password nobody chose is a credential nobody can rotate.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID, {
					resolveStorageBoxPassword: undefined,
				}).reconcile(
					request({
						productId: HETZNER_STORAGE_BOX_PRODUCT_ID,
						desired: { storageBoxType: "bx11", location: "fsn1" },
					}),
					always(json(200, { storage_boxes: [] })),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses a create when the resolver produces nothing", async () => {
		// An empty password would either be refused by Hetzner or, worse,
		// accepted.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID, {
					resolveStorageBoxPassword: async () => "",
				}).reconcile(
					request({
						productId: HETZNER_STORAGE_BOX_PRODUCT_ID,
						desired: { storageBoxType: "bx11", location: "fsn1" },
					}),
					always(json(200, { storage_boxes: [] })),
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("keeps the password out of the outputs and the diagnostics", async () => {
		// The whole reason the password arrives through an injected function is
		// that `desired` is written to the event log. Echoing it into an output
		// would undo that in one line.
		const password = "s3cret-storage-box-password";
		const outcome = await resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID, {
			resolveStorageBoxPassword: async () => password,
		}).reconcile(
			request({
				productId: HETZNER_STORAGE_BOX_PRODUCT_ID,
				desired: { storageBoxType: "bx11", location: "fsn1" },
			}),
			sequence(
				json(200, { storage_boxes: [] }),
				json(201, {
					storage_box: { id: 24, name: "thing", status: "active" },
					action: { id: 97, status: "success" },
				}),
			),
		);
		expect(JSON.stringify(outcome)).not.toContain(password);
	});

	it("says where to rotate the password instead", async () => {
		const outcome = await resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID).reconcile(
			request({
				productId: HETZNER_STORAGE_BOX_PRODUCT_ID,
				desired: { storageBoxType: "bx11", location: "fsn1" },
			}),
			sequence(
				json(200, { storage_boxes: [] }),
				json(201, {
					storage_box: { id: 24, name: "thing", status: "active" },
					action: { id: 97, status: "success" },
				}),
			),
		);
		expect(outcome.diagnostics.join(" ")).toContain("reset_password");
	});

	it("re-reads the box when the create answered with only an action", async () => {
		// The unified API has answered a create with an action and no box. The
		// caller needs the box, so the resolver looks it up rather than reporting
		// an empty record as the created resource.
		const outcome = await resolverFor(HETZNER_STORAGE_BOX_PRODUCT_ID).reconcile(
			request({
				productId: HETZNER_STORAGE_BOX_PRODUCT_ID,
				desired: { storageBoxType: "bx11", location: "fsn1" },
			}),
			sequence(
				json(200, { storage_boxes: [] }),
				json(201, { action: { id: 97, status: "success" } }),
				json(200, {
					storage_boxes: [{ id: 24, name: "thing", status: "active" }],
				}),
			),
		);
		expect(outcome.physicalId).toBe("24");
	});
});

describe("object storage", () => {
	const desired = { location: "fsn1" };

	it("reports a missing bucket as absent", async () => {
		expect(
			await resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).read(
				request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
				always(raw(404, "")),
			),
		).toBeUndefined();
	});

	it("refuses a read the provider rejected", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).read(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					always(raw(403, "")),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("adopts an existing bucket", async () => {
		const outcome = await resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).read(
			request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
			always(raw(200, "")),
		);
		expect(outcome?.action).toBe("adopt");
	});

	it("derives the bucket endpoints from the name and location", async () => {
		const outcome = await resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).read(
			request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
			always(raw(200, "")),
		);
		expect(outcome?.outputs).toMatchObject({
			endpoint: "https://thing.fsn1.your-objectstorage.com",
			s3Endpoint: "https://fsn1.your-objectstorage.com",
		});
	});

	it("refuses a reconcile the provider rejected on the existence check", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).reconcile(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					always(raw(500, "")),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("does not adopt a bucket somebody else owns", async () => {
		// S3 bucket names are global within a location, so a 409 on create means
		// the name belongs to another account. Adopting it would be worse than
		// failing: the deployment would appear to own storage it cannot write to.
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).reconcile(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					sequence(raw(404, ""), raw(409, "")),
				),
			),
		).toContain("somebody else's bucket");
	});

	it("refuses a create the provider rejected for another reason", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).reconcile(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					sequence(raw(404, ""), raw(403, "")),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("says the new bucket has no ACL applied", async () => {
		// A bucket meant to be public is private until somebody says otherwise,
		// and the failure mode of silence here is a deployment that looks broken.
		const outcome = await resolverFor(
			HETZNER_OBJECT_STORAGE_PRODUCT_ID,
		).reconcile(
			request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
			sequence(raw(404, ""), raw(200, "")),
		);
		expect(outcome.diagnostics.join(" ")).toContain("sets no ACL");
	});

	it("treats a 404 on delete as already gone", async () => {
		await expect(
			resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).delete(
				request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
				always(raw(404, "")),
			),
		).resolves.toBeUndefined();
	});

	it("refuses to empty a bucket to make a delete succeed", async () => {
		// Enumerating and deleting objects is unbounded data loss dressed as
		// cleanup, and it would run without anyone asking for it.
		expect(
			await messageOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).delete(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					always(raw(409, "")),
				),
			),
		).toContain("unbounded data loss dressed as cleanup");
	});

	it("refuses a delete the provider rejected for another reason", async () => {
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).delete(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
					always(raw(403, "")),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("succeeds on a clean delete", async () => {
		await expect(
			resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).delete(
				request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID, desired }),
				always(raw(204, "")),
			),
		).resolves.toBeUndefined();
	});

	it("refuses every verb with no location", async () => {
		// The bucket's host *is* the location, so there is nothing to sign
		// against without one.
		expect(
			await codeOf(() =>
				resolverFor(HETZNER_OBJECT_STORAGE_PRODUCT_ID).delete(
					request({ productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID }),
					always(raw(204, "")),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});
});
