/**
 * The three places this adapter can leak a credential, and the option block.
 *
 * The Netlify anonymous-site path has exactly one thing that is bearer
 * authority, and it is easy to miss because it looks like a link: **the claim
 * URL**. Anyone who opens it becomes the owner of the site. So there are three
 * layers here, and each is tested in the direction that fails closed:
 *
 * 1. **Custody** deposits the material and hands back only a locator. A custody
 *    implementation that echoed the plaintext back instead of a `SecretRef` has
 *    to fail *at the deposit*, not later in a receipt where the value would
 *    already have been written down.
 * 2. **The credential scanner** is the backstop for everything that gets
 *    serialized — receipts, facts, errors. It reports the *path* that carried a
 *    hit rather than the value, because an error message quoting the secret it
 *    found would be the leak it was trying to prevent.
 * 3. **The transport** caps response size and refuses to report a timed-out
 *    request as a failure, because a dropped request never proves the server
 *    did nothing.
 */
import { describe, expect, it } from "vitest";

import {
	depositSecret,
	resolveSecret,
	type SecretCustodyScope,
} from "../src/custody.js";
import { netlify, PROVIDER_TARGET } from "../src/options.js";
import { NetlifyProviderError } from "../src/provider-errors.js";
import {
	assertNoCredentialMaterial,
	scanForCredentialMaterial,
} from "../src/receipt.js";
import { createFetchTransport } from "../src/transport.js";

const SCOPE: SecretCustodyScope = {
	providerId: "netlify",
	resourceRef: "site/abc123",
	purpose: "anonymous-claim-url",
};

const LOCATOR = "hobo-secret://vault/netlify/site-abc123";

function codeOf(error: unknown): string | undefined {
	return (error as { code?: string }).code;
}

describe("depositSecret", () => {
	it("returns only the parsed locator", async () => {
		const ref = await depositSecret(
			{ deposit: async () => LOCATOR },
			"https://app.netlify.com/claim?token=SECRET",
			SCOPE,
		);
		// A parsed ref, not the raw string — the point of parsing at the deposit
		// is that everything downstream holds a typed locator.
		expect(ref).toBeTypeOf("object");
		expect(JSON.stringify(ref)).toContain("hobo-secret://");
	});

	it("hands the custody port the value and the scope", async () => {
		// The scope is what a custody implementation keys its record on. Losing
		// it would deposit the material under no owner and make revocation
		// impossible.
		const seen: Array<{ value: string; scope: SecretCustodyScope }> = [];
		await depositSecret(
			{
				deposit: async (value, scope) => {
					seen.push({ value, scope });
					return LOCATOR;
				},
			},
			"claim-url",
			SCOPE,
		);
		expect(seen[0]?.value).toBe("claim-url");
		expect(seen[0]?.scope).toEqual(SCOPE);
	});

	it("fails at the deposit when custody echoes the plaintext back", async () => {
		// The case the doc comment calls out. A custody implementation that
		// returned the value instead of a locator would otherwise put the claim
		// URL into every downstream receipt, and the failure would surface as a
		// credential-scan hit far from the cause. `parseSecretRef` already
		// refuses credential-shaped input, so this fails here instead.
		await expect(
			depositSecret(
				{ deposit: async (value) => value },
				"https://app.netlify.com/claim?token=SECRET",
				SCOPE,
			),
		).rejects.toThrow(/not a secret locator/u);
	});

	it("names the resource but never the material in that refusal", async () => {
		// An error that quoted the value it refused would be the leak it exists
		// to prevent.
		try {
			await depositSecret(
				{ deposit: async (value) => value },
				"https://app.netlify.com/claim?token=SUPERSECRET",
				SCOPE,
			);
			expect.unreachable("echoing plaintext must be refused");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("site/abc123");
			expect(message).not.toContain("SUPERSECRET");
			expect(codeOf(error)).toBe("SECRET_CUSTODY_UNAVAILABLE");
		}
	});

	it("wraps a custody failure with the purpose and resource", async () => {
		// Two different failures, one code: custody being unavailable and custody
		// misbehaving both mean "the secret is not safely stored", and neither
		// should let the caller proceed.
		try {
			await depositSecret(
				{
					deposit: async () => {
						throw new Error("vault unreachable");
					},
				},
				"claim-url",
				SCOPE,
			);
			expect.unreachable("a custody failure must propagate");
		} catch (error) {
			expect(codeOf(error)).toBe("SECRET_CUSTODY_UNAVAILABLE");
			expect((error as Error).message).toContain("anonymous-claim-url");
			expect((error as Error).message).toContain("site/abc123");
			expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
		}
	});

	it("keeps the original failure as the cause", async () => {
		// So an operator can see whether the vault was down or the token was
		// rejected, without that detail having to be in the message.
		const original = new Error("HTTP 503");
		try {
			await depositSecret(
				{
					deposit: async () => {
						throw original;
					},
				},
				"claim-url",
				SCOPE,
			);
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect((error as { cause?: unknown }).cause).toBe(original);
		}
	});

	it("carries every declared purpose through", async () => {
		for (const purpose of [
			"anonymous-claim-url",
			"anonymous-session",
			"authenticated-api-token",
		] as const) {
			const seen: SecretCustodyScope[] = [];
			await depositSecret(
				{
					deposit: async (_value, scope) => {
						seen.push(scope);
						return LOCATOR;
					},
				},
				"v",
				{ ...SCOPE, purpose },
			);
			expect(seen[0]?.purpose).toBe(purpose);
		}
	});
});

describe("resolveSecret", () => {
	it("returns the resolved value", async () => {
		const value = await resolveSecret(
			{ resolve: async () => "the-material" as never },
			LOCATOR as never,
		);
		expect(value).toBe("the-material");
	});

	it("wraps a resolver failure without naming the ref", async () => {
		// The message is deliberately generic. A ref is a locator rather than a
		// credential, but including it would still put a pointer to live bearer
		// authority into every log line that carried the error.
		try {
			await resolveSecret(
				{
					resolve: async () => {
						throw new Error("denied");
					},
				},
				LOCATOR as never,
			);
			expect.unreachable("a resolver failure must propagate");
		} catch (error) {
			expect(codeOf(error)).toBe("SECRET_CUSTODY_UNAVAILABLE");
			expect((error as Error).message).toContain("could not resolve");
			expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
		}
	});
});

describe("scanForCredentialMaterial", () => {
	it("finds nothing in innocuous values", () => {
		for (const value of [
			null,
			undefined,
			7,
			true,
			"just some text",
			{ name: "site", url: "https://example.netlify.app" },
			[],
		]) {
			expect(scanForCredentialMaterial(value)).toEqual([]);
		}
	});

	it("recognises each declared credential shape", () => {
		// Every pattern, because a shape that stopped matching would leave that
		// credential type undetected in receipts with nothing to notice it.
		const cases: Array<[string, string]> = [
			["netlify personal access token", "nfp_abcdefgh12345678"],
			["netlify auth token assignment", "NETLIFY_AUTH_TOKEN=abc123"],
			["connection string", "postgres://user:pw@host/db"],
			["api key assignment", "api_key=abc123"],
			["password assignment", "password: hunter2"],
			["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"],
			["private key", "-----BEGIN RSA PRIVATE KEY-----"],
		];
		for (const [label, sample] of cases) {
			const hits = scanForCredentialMaterial({ field: sample });
			expect(hits.map((hit) => hit.label)).toContain(label);
		}
	});

	it("matches the token assignment with or without AUTH", () => {
		// `NETLIFY_(?:AUTH_)?TOKEN`. Both spellings exist in the wild, and
		// matching one would leave the other undetected.
		expect(scanForCredentialMaterial("NETLIFY_TOKEN=abc")).toHaveLength(1);
		expect(scanForCredentialMaterial("NETLIFY_AUTH_TOKEN=abc")).toHaveLength(1);
	});

	it("matches assignments case-insensitively", () => {
		// The `i` flag. A receipt field named `API_KEY` or `Password` is the same
		// leak as a lowercase one.
		expect(scanForCredentialMaterial("API_KEY = abc")).toHaveLength(1);
		expect(scanForCredentialMaterial("Password: abc")).toHaveLength(1);
	});

	it("reports the path that carried the hit, not the value", () => {
		// The whole point of tracking a path: a failure names the field so an
		// author can find it, without the error itself quoting the secret.
		const hits = scanForCredentialMaterial({
			site: { deploy: { token: "nfp_abcdefgh12345678" } },
		});
		expect(hits[0]?.path).toBe("site.deploy.token");
		expect(JSON.stringify(hits)).not.toContain("nfp_abcdefgh");
	});

	it("indexes into arrays in the reported path", () => {
		const hits = scanForCredentialMaterial({
			deploys: [{ ok: true }, { token: "nfp_abcdefgh12345678" }],
		});
		expect(hits[0]?.path).toBe("deploys[1].token");
	});

	it("reports an empty path for a bare string", () => {
		expect(scanForCredentialMaterial("nfp_abcdefgh12345678")[0]?.path).toBe("");
	});

	it("reports every hit rather than stopping at the first", () => {
		// An author fixing one leak at a time because the scanner reported one at
		// a time would need as many rounds as there are fields.
		const hits = scanForCredentialMaterial({
			a: "nfp_abcdefgh12345678",
			b: "password=hunter2",
		});
		expect(hits).toHaveLength(2);
		expect(hits.map((hit) => hit.path).sort()).toEqual(["a", "b"]);
	});

	it("reports one string matching several shapes once per shape", () => {
		const hits = scanForCredentialMaterial(
			"NETLIFY_AUTH_TOKEN=nfp_abcdefgh12345678",
		);
		expect(hits.length).toBeGreaterThan(1);
	});

	it("judges a custom projection by what it serializes", () => {
		// A `SecretValue` hides its material behind a `toJSON` that returns a
		// locator. Scanning its private fields would flag every correctly-held
		// secret as a leak, and a scanner that cried wolf would be disabled.
		const held = {
			raw: "nfp_abcdefgh12345678",
			toJSON: () => "hobo-secret://vault/x",
		};
		expect(scanForCredentialMaterial({ held })).toEqual([]);
	});

	it("still catches a projection that serializes the material", () => {
		// The other direction, and the one that matters: a class whose `toJSON`
		// leaks is exactly what this backstop is for.
		// The projected value is walked *at the same path*, so the reported path
		// is the projection's own field rather than the holder — which is the
		// more useful of the two, since it names what actually serialized.
		const leaky = { toJSON: () => ({ token: "nfp_abcdefgh12345678" }) };
		expect(scanForCredentialMaterial({ leaky })[0]?.path).toBe("leaky.token");
	});

	it("survives a cycle rather than recursing forever", () => {
		// Receipts get assembled from graphs that can contain back-references. A
		// scanner that hung on one would take the whole deploy with it.
		const node: Record<string, unknown> = { token: "nfp_abcdefgh12345678" };
		node.self = node;
		expect(scanForCredentialMaterial(node)).toHaveLength(1);
	});

	it("visits a shared node once", () => {
		// The `WeakSet` is a cycle guard, so a value referenced twice is reported
		// once. Pinned as the trade: the alternative is duplicate hits for the
		// same field, which would overstate a leak's breadth.
		const shared = { token: "nfp_abcdefgh12345678" };
		expect(scanForCredentialMaterial({ a: shared, b: shared })).toHaveLength(1);
	});
});

describe("assertNoCredentialMaterial", () => {
	it("passes clean values", () => {
		expect(() =>
			assertNoCredentialMaterial({ site: "example" }, "receipt"),
		).not.toThrow();
	});

	it("throws naming the label, the paths and the count", () => {
		// Enough to locate the leak; nothing that reproduces it. The count goes
		// in `detail` so a metric can be taken without parsing the message.
		try {
			assertNoCredentialMaterial(
				{ deploy: { token: "nfp_abcdefgh12345678" } },
				"deploy receipt",
			);
			expect.unreachable("credential material must be refused");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("deploy receipt");
			expect(message).toContain("deploy.token");
			expect(message).not.toContain("nfp_abcdefgh");
			expect(codeOf(error)).toBe("PROVIDER_CONTRACT_CHANGED");
			expect((error as { detail?: { hits?: number } }).detail?.hits).toBe(1);
		}
	});

	it("lists every offending path", () => {
		try {
			assertNoCredentialMaterial(
				{ a: "nfp_abcdefgh12345678", b: "password=x" },
				"receipt",
			);
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect((error as Error).message).toContain("a");
			expect((error as Error).message).toContain("b");
		}
	});
});

describe("createFetchTransport", () => {
	function respond(
		body: string,
		init: { status?: number; headers?: Record<string, string> } = {},
	) {
		return new Response(body, {
			status: init.status ?? 200,
			headers: init.headers,
		});
	}

	const REQUEST = {
		method: "GET" as const,
		url: "https://api.netlify.com/api/v1/sites",
		headers: { accept: "application/json" },
		timeoutMs: 1000,
		maxResponseBytes: 1024,
	};

	it("returns the status, lowercased headers and body", async () => {
		// Headers are lowercased because HTTP header names are case-insensitive
		// but a plain object lookup is not — a caller reading `content-type`
		// would miss a server that sent `Content-Type`.
		const transport = createFetchTransport({
			fetchImpl: async () =>
				respond('{"ok":true}', {
					headers: { "Content-Type": "application/json" },
				}),
		});
		const response = await transport.request(REQUEST);
		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toBe("application/json");
		expect(response.body).toBe('{"ok":true}');
	});

	it("refuses a response over the byte cap", async () => {
		// The cap is a memory bound on a response this package does not control.
		// It is measured in *bytes*, not characters, so a multi-byte body cannot
		// slip past a length check.
		const transport = createFetchTransport({
			fetchImpl: async () => respond("x".repeat(2048)),
		});
		await expect(
			transport.request({ ...REQUEST, maxResponseBytes: 100 }),
		).rejects.toThrow(/exceeded the 100 byte cap/u);
	});

	it("counts multi-byte characters by their byte length", async () => {
		// Ten "é" is ten characters but twenty bytes. A `String.length` check
		// would let a body twice the intended size through.
		const transport = createFetchTransport({
			fetchImpl: async () => respond("é".repeat(10)),
		});
		await expect(
			transport.request({ ...REQUEST, maxResponseBytes: 15 }),
		).rejects.toThrow(/byte cap/u);
	});

	it("allows a body exactly at the cap", async () => {
		// `>` not `>=`, so a body of exactly the permitted size is permitted.
		const transport = createFetchTransport({
			fetchImpl: async () => respond("x".repeat(100)),
		});
		await expect(
			transport.request({ ...REQUEST, maxResponseBytes: 100 }),
		).resolves.toMatchObject({ status: 200 });
	});

	it("reports a dropped request as ambiguous rather than failed", async () => {
		// The distinction that matters for a non-idempotent call. A timed-out or
		// dropped request never proves the server did nothing, so reporting it as
		// a failure would invite a retry that double-creates.
		const transport = createFetchTransport({
			fetchImpl: async () => {
				throw new Error("ECONNRESET");
			},
		});
		try {
			await transport.request(REQUEST);
			expect.unreachable("a dropped request must be reported");
		} catch (error) {
			expect(codeOf(error)).toBe("PROVIDER_OPERATION_AMBIGUOUS");
			expect((error as { detail?: { method?: string } }).detail?.method).toBe(
				"GET",
			);
		}
	});

	it("does not relabel a NetlifyProviderError it raised itself", async () => {
		// The `instanceof` re-throw. Wrapping the byte-cap refusal as ambiguous
		// would tell a caller the request might have succeeded when the adapter
		// knows it read a complete, oversized response.
		const transport = createFetchTransport({
			fetchImpl: async () => respond("x".repeat(2048)),
		});
		try {
			await transport.request({ ...REQUEST, maxResponseBytes: 10 });
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(NetlifyProviderError);
			expect(codeOf(error)).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("sends a body only when one was given", async () => {
		// The conditional spread. Passing `body: undefined` to `fetch` on a GET
		// is not the same as omitting it in every runtime.
		const seen: RequestInit[] = [];
		const transport = createFetchTransport({
			fetchImpl: async (_url, init) => {
				seen.push(init as RequestInit);
				return respond("{}");
			},
		});
		await transport.request(REQUEST);
		expect(Object.hasOwn(seen[0] ?? {}, "body")).toBe(false);

		await transport.request({ ...REQUEST, method: "POST", body: '{"a":1}' });
		expect(seen[1]?.body).toBe('{"a":1}');
	});

	it("never follows a redirect automatically", async () => {
		// `redirect: "manual"`. A followed redirect would forward the request's
		// Authorization header to wherever the redirect pointed — the classic
		// credential-exfiltration path through an API that starts returning 302.
		const seen: RequestInit[] = [];
		const transport = createFetchTransport({
			fetchImpl: async (_url, init) => {
				seen.push(init as RequestInit);
				return respond("{}");
			},
		});
		await transport.request(REQUEST);
		expect(seen[0]?.redirect).toBe("manual");
	});

	it("passes an abort signal so the timeout can cancel the request", async () => {
		const seen: RequestInit[] = [];
		const transport = createFetchTransport({
			fetchImpl: async (_url, init) => {
				seen.push(init as RequestInit);
				return respond("{}");
			},
		});
		await transport.request(REQUEST);
		expect(seen[0]?.signal).toBeDefined();
	});

	it("copies the request headers rather than passing the caller's object", async () => {
		// `{ ...request.headers }`. Handing the caller's object to `fetch` would
		// let a runtime that mutates it write back into the request record.
		const headers = { accept: "application/json" };
		const seen: RequestInit[] = [];
		const transport = createFetchTransport({
			fetchImpl: async (_url, init) => {
				seen.push(init as RequestInit);
				return respond("{}");
			},
		});
		await transport.request({ ...REQUEST, headers });
		expect(seen[0]?.headers).not.toBe(headers);
		expect(seen[0]?.headers).toEqual(headers);
	});
});

describe("typed option block", () => {
	it("tags the block with the provider target and its port", () => {
		// The target is what makes the annotation inert for other providers —
		// one Bindle targeting many clouds unedited.
		const block = netlify.with.site();
		expect(block.providerId).toBe(PROVIDER_TARGET);
		expect(block.port).toBe("compute");
		expect(block.optionName).toBe("site");
	});

	it("negotiates as prefer", () => {
		// So a provider that cannot honour it degrades rather than failing the
		// deploy, which is what makes a provider-specific option additive.
		expect(netlify.with.site().negotiation).toBe("prefer");
	});

	it("defaults the framework to static", () => {
		expect(netlify.with.site().options).toEqual({ framework: "static" });
	});

	it("lets a caller override the default and add keys", () => {
		const block = netlify.with.site({ framework: "next", edge: true });
		expect(block.options.framework).toBe("next");
		expect(block.options.edge).toBe(true);
	});

	it("gives each call its own options object", () => {
		const first = netlify.with.site();
		first.options.framework = "mutated";
		expect(netlify.with.site().options.framework).toBe("static");
	});
});
