/**
 * Broker discovery — the document, and the client that goes looking for it.
 *
 * Discovery is mandatory before any remote or anonymous deploy, and it is the
 * only thing standing between `hobo up --broker <uri>` and sending a
 * credential to whatever answers at that address. So it fails closed: a
 * document that does not parse is not a broker.
 *
 * **`supportsAnonymous` is derived only when it is absent.** An explicit
 * `false` alongside `"anonymous"` in `authMethods` means the broker has turned
 * the lane off, and deriving `true` from the method list would send a user
 * into a session the broker will refuse. Absent, it is derived — a broker that
 * lists the method and says nothing else is offering it.
 *
 * **Endpoints are required, trimmed, and non-empty.** A whitespace-only
 * `placeEndpoint` would pass a naive presence check and then be joined into a
 * URL that resolves to the broker's root, posting a deployment to whatever
 * lives there.
 *
 * **The client tries three well-known paths and reports all three failures.**
 * Protected-resource metadata may wrap the HoBo document rather than being it,
 * and a broker that serves none of the three is a different problem from one
 * that serves a malformed one — the accumulated errors are what tell them
 * apart.
 */
import { describe, expect, it } from "vitest";

import {
	BROKER_DISCOVERY_SCHEMA,
	type BrokerDiscoveryDocument,
	BrokerDiscoveryError,
	createBrokerDiscoveryClient,
	defaultMockDiscovery,
	parseBrokerDiscoveryDocument,
} from "../src/broker-discovery.js";

const BROKER = "https://public.example.com";

/** A document that parses, for tests that vary one field at a time. */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: BROKER_DISCOVERY_SCHEMA,
		brokerId: "broker:public.example.com",
		issuer: BROKER,
		authMethods: ["svid", "oidc"],
		claimEndpoint: `${BROKER}/claim`,
		placeEndpoint: `${BROKER}/place`,
		anonymousSessionEndpoint: `${BROKER}/anon`,
		...overrides,
	};
}

/** A fetch stand-in that answers each URL from a table. */
function fetchFrom(
	table: Record<string, { status?: number; body?: unknown; throws?: string }>,
): { impl: typeof fetch; tried: string[] } {
	const tried: string[] = [];
	const impl = (async (url: string) => {
		tried.push(url);
		const answer = table[url];
		if (!answer) throw new Error("connect ECONNREFUSED");
		if (answer.throws) throw new Error(answer.throws);
		return {
			ok: (answer.status ?? 200) < 400,
			status: answer.status ?? 200,
			json: async () => answer.body,
		};
	}) as unknown as typeof fetch;
	return { impl, tried };
}

describe("document shape", () => {
	it("refuses anything that is not an object", () => {
		for (const raw of [null, "broker", 7, undefined]) {
			expect(() => parseBrokerDiscoveryDocument(raw)).toThrow(
				BrokerDiscoveryError,
			);
		}
	});

	it("refuses a schema version it does not know, naming the one it wants", () => {
		// Reading a future document with today's parser would silently ignore
		// fields that change what the broker is offering.
		for (const schemaVersion of [
			undefined,
			"hobo.broker-discovery/v2",
			"",
			1,
		]) {
			expect(() =>
				parseBrokerDiscoveryDocument(doc({ schemaVersion })),
			).toThrow(/schemaVersion/);
		}
	});

	it("uses one code for every invalid document", () => {
		// A caller distinguishes "this is not a broker" from "I could not reach
		// it" — the individual field is in the message, not the code.
		try {
			parseBrokerDiscoveryDocument(doc({ brokerId: "" }));
			expect.unreachable();
		} catch (error) {
			expect((error as BrokerDiscoveryError).code).toBe(
				"HOBO_DISCOVERY_INVALID",
			);
			expect((error as Error).name).toBe("BrokerDiscoveryError");
		}
	});
});

describe("required string fields", () => {
	const REQUIRED = [
		"brokerId",
		"issuer",
		"claimEndpoint",
		"placeEndpoint",
		"anonymousSessionEndpoint",
	] as const;

	it("requires each one by name", () => {
		// Which endpoint is missing decides what the user can still do — a
		// broker with no claim endpoint can still place. A generic refusal would
		// lose that.
		for (const field of REQUIRED) {
			expect(() =>
				parseBrokerDiscoveryDocument(doc({ [field]: undefined })),
			).toThrow(new RegExp(field));
		}
	});

	it("refuses an empty or whitespace-only value", () => {
		// A whitespace-only endpoint passes a naive presence check and then
		// resolves to the broker's root — posting a deployment to whatever is
		// there.
		for (const field of REQUIRED) {
			for (const value of ["", "   ", "\t\n"]) {
				expect(() =>
					parseBrokerDiscoveryDocument(doc({ [field]: value })),
				).toThrow(new RegExp(field));
			}
		}
	});

	it("refuses a non-string value", () => {
		for (const field of REQUIRED) {
			expect(() => parseBrokerDiscoveryDocument(doc({ [field]: 7 }))).toThrow(
				new RegExp(field),
			);
		}
	});

	it("trims surrounding whitespace rather than carrying it into a URL", () => {
		// A trailing newline from a hand-edited document would otherwise become
		// part of every request path.
		const parsed = parseBrokerDiscoveryDocument(
			doc({ placeEndpoint: `  ${BROKER}/place\n` }),
		);
		expect(parsed.placeEndpoint).toBe(`${BROKER}/place`);
	});
});

describe("auth methods", () => {
	it("requires a non-empty array", () => {
		// A broker that advertises no way to authenticate is not usable, and
		// discovering that here beats discovering it after a credential is minted.
		for (const authMethods of [undefined, [], "svid", {}]) {
			expect(() => parseBrokerDiscoveryDocument(doc({ authMethods }))).toThrow(
				/authMethods/,
			);
		}
	});

	it("accepts every supported method", () => {
		const methods = ["svid", "oidc", "dpop", "anonymous", "bearer"];
		expect(
			parseBrokerDiscoveryDocument(doc({ authMethods: methods })).authMethods,
		).toEqual(methods);
	});

	it("refuses an unsupported method, naming its index", () => {
		// With a list of five, the index is the only thing that points at the
		// offending entry.
		expect(() =>
			parseBrokerDiscoveryDocument(
				doc({ authMethods: ["svid", "mtls", "oidc"] }),
			),
		).toThrow(/authMethods\[1\].*mtls/);
	});

	it("refuses a non-string entry rather than coercing it", () => {
		expect(() =>
			parseBrokerDiscoveryDocument(doc({ authMethods: [null] })),
		).toThrow(/authMethods\[0\]/);
	});
});

describe("supportsAnonymous", () => {
	it("derives true from the method list when the field is absent", () => {
		// A broker that lists the method and says nothing else is offering it.
		expect(
			parseBrokerDiscoveryDocument(doc({ authMethods: ["svid", "anonymous"] }))
				.supportsAnonymous,
		).toBe(true);
	});

	it("derives false when the method is not listed and the field is absent", () => {
		expect(
			parseBrokerDiscoveryDocument(doc({ authMethods: ["svid"] }))
				.supportsAnonymous,
		).toBe(false);
	});

	it("respects an explicit false even when the method is listed", () => {
		// This is the case that matters: the broker has turned the lane off
		// while leaving the method in its list. Deriving `true` would send the
		// user into a session the broker will refuse.
		expect(
			parseBrokerDiscoveryDocument(
				doc({ authMethods: ["anonymous"], supportsAnonymous: false }),
			).supportsAnonymous,
		).toBe(false);
	});

	it("respects an explicit true even when the method is not listed", () => {
		expect(
			parseBrokerDiscoveryDocument(
				doc({ authMethods: ["svid"], supportsAnonymous: true }),
			).supportsAnonymous,
		).toBe(true);
	});

	it("ignores a non-boolean field and falls back to derivation", () => {
		// `"false"` from a hand-written document is not `false`. Treating the
		// string as authoritative in either direction would be a guess; the
		// method list is the fact that is actually there.
		expect(
			parseBrokerDiscoveryDocument(
				doc({ authMethods: ["anonymous"], supportsAnonymous: "false" }),
			).supportsAnonymous,
		).toBe(true);
	});
});

describe("optional fields", () => {
	it("keeps a finite ttl hint and drops anything else", () => {
		// The hint drives how long a temporary deploy is advertised as living.
		// `NaN` or `Infinity` there would render as a nonsense deadline.
		expect(
			parseBrokerDiscoveryDocument(doc({ ttlHintSeconds: 900 })).ttlHintSeconds,
		).toBe(900);
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "900", null]) {
			expect(
				parseBrokerDiscoveryDocument(doc({ ttlHintSeconds: value }))
					.ttlHintSeconds,
			).toBeUndefined();
		}
	});

	it("keeps only the string entries of restrictions", () => {
		// Restrictions are shown to the user before they accept a temporary
		// deploy. A non-string entry rendered into that list would read as a
		// restriction nobody wrote.
		expect(
			parseBrokerDiscoveryDocument(
				doc({ restrictions: ["no-egress", 7, null, "ttl-1h"] }),
			).restrictions,
		).toEqual(["no-egress", "ttl-1h"]);
	});

	it("omits restrictions entirely when the field is not an array", () => {
		for (const restrictions of [undefined, "no-egress", {}]) {
			expect(
				parseBrokerDiscoveryDocument(doc({ restrictions })).restrictions,
			).toBeUndefined();
		}
	});

	it("keeps a string resource metadata url and drops a non-string", () => {
		expect(
			parseBrokerDiscoveryDocument(doc({ resourceMetadataUrl: `${BROKER}/rm` }))
				.resourceMetadataUrl,
		).toBe(`${BROKER}/rm`);
		expect(
			parseBrokerDiscoveryDocument(doc({ resourceMetadataUrl: 7 }))
				.resourceMetadataUrl,
		).toBeUndefined();
	});
});

describe("discovery client", () => {
	it("serves an injected fixed document without any fetch", async () => {
		// The in-process mock broker and the tests both rely on this seam; a
		// fetch slipping through would make them depend on the network.
		const { impl, tried } = fetchFrom({});
		const client = createBrokerDiscoveryClient({
			fetchImpl: impl,
			fixed: new Map([[BROKER, defaultMockDiscovery(BROKER)]]),
		});
		const document = await client.discover(BROKER);
		expect(document.issuer).toBe(BROKER);
		expect(tried).toEqual([]);
	});

	it("normalizes trailing slashes before looking anything up", async () => {
		// `https://b/` and `https://b` are the same broker. Keying on the raw
		// string would miss the fixed entry and fall through to the network.
		const client = createBrokerDiscoveryClient({
			fixed: new Map([[BROKER, defaultMockDiscovery(BROKER)]]),
		});
		expect((await client.discover(`${BROKER}///`)).issuer).toBe(BROKER);
	});

	it("parses a fixed document rather than trusting it", async () => {
		// The fixed map is typed loosely on purpose — an embedder can put
		// anything there, and it has to meet the same bar as a fetched one.
		const client = createBrokerDiscoveryClient({
			fixed: new Map([[BROKER, { schemaVersion: "wrong" }]]),
		});
		await expect(client.discover(BROKER)).rejects.toThrow(/schemaVersion/);
	});

	it("takes the HoBo well-known path first", async () => {
		const { impl, tried } = fetchFrom({
			[`${BROKER}/.well-known/hobo-broker`]: { body: doc() },
		});
		const client = createBrokerDiscoveryClient({ fetchImpl: impl });
		expect((await client.discover(BROKER)).brokerId).toBe(
			"broker:public.example.com",
		);
		expect(tried).toEqual([`${BROKER}/.well-known/hobo-broker`]);
	});

	it("falls through to protected-resource metadata, then /discovery", async () => {
		// A broker that only serves the OAuth path is still a broker, and one
		// that serves neither may still answer at /discovery. Stopping at the
		// first miss would refuse both.
		const { impl, tried } = fetchFrom({
			[`${BROKER}/.well-known/hobo-broker`]: { status: 404 },
			[`${BROKER}/.well-known/oauth-protected-resource`]: { status: 404 },
			[`${BROKER}/discovery`]: { body: doc() },
		});
		const client = createBrokerDiscoveryClient({ fetchImpl: impl });
		expect((await client.discover(BROKER)).issuer).toBe(BROKER);
		expect(tried).toHaveLength(3);
	});

	it("unwraps a document nested under hobo_broker", async () => {
		// Protected-resource metadata carries its own top-level fields and may
		// embed ours. Parsing the wrapper would refuse a perfectly good broker.
		const { impl } = fetchFrom({
			[`${BROKER}/.well-known/hobo-broker`]: {
				body: { resource: BROKER, hobo_broker: doc() },
			},
		});
		const client = createBrokerDiscoveryClient({ fetchImpl: impl });
		expect((await client.discover(BROKER)).brokerId).toBe(
			"broker:public.example.com",
		);
	});

	it("keeps looking when one path serves a malformed document", async () => {
		// A broker mid-deploy can serve a half-written file on one path and a
		// good one on another. Failing on the first parse error would refuse it.
		const { impl } = fetchFrom({
			[`${BROKER}/.well-known/hobo-broker`]: { body: { nope: true } },
			[`${BROKER}/.well-known/oauth-protected-resource`]: { body: doc() },
		});
		const client = createBrokerDiscoveryClient({ fetchImpl: impl });
		expect((await client.discover(BROKER)).issuer).toBe(BROKER);
	});

	it("reports every attempt when none of the three answers", async () => {
		// "Discovery failed" alone cannot distinguish a typo in the URI from a
		// broker that is up but not serving the document. The per-path outcomes
		// can.
		const { impl } = fetchFrom({
			[`${BROKER}/.well-known/hobo-broker`]: { status: 503 },
			[`${BROKER}/.well-known/oauth-protected-resource`]: {
				throws: "socket hang up",
			},
		});
		const client = createBrokerDiscoveryClient({ fetchImpl: impl });
		try {
			await client.discover(BROKER);
			expect.unreachable();
		} catch (error) {
			expect((error as BrokerDiscoveryError).code).toBe(
				"HOBO_DISCOVERY_UNREACHABLE",
			);
			const message = (error as Error).message;
			expect(message).toContain("HTTP 503");
			expect(message).toContain("socket hang up");
			expect(message).toContain("/discovery");
		}
	});
});

describe("defaultMockDiscovery", () => {
	it("derives a broker id from the host and offers the anonymous lane", async () => {
		const document = defaultMockDiscovery(BROKER);
		expect(document.brokerId).toBe("broker:public.example.com");
		expect(document.supportsAnonymous).toBe(true);
		expect(document.authMethods).toContain("anonymous");
	});

	it("normalizes a trailing slash into the issuer", () => {
		// The issuer is the audience a credential is bound to. A trailing slash
		// there and not in the request would make every proof fail to verify.
		expect(defaultMockDiscovery(`${BROKER}//`).issuer).toBe(BROKER);
	});

	it("accepts overrides and still produces a parseable document", () => {
		const overridden: BrokerDiscoveryDocument = defaultMockDiscovery(BROKER, {
			supportsAnonymous: false,
			authMethods: ["svid"],
		});
		expect(overridden.supportsAnonymous).toBe(false);
		expect(parseBrokerDiscoveryDocument(overridden)).toEqual(overridden);
	});
});
