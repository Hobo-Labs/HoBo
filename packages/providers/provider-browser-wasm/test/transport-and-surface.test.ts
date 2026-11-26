/**
 * The browser-WASM provider's one wire boundary, its error redaction, and its
 * capability surface.
 *
 * Three properties, each guarding something a browser makes uniquely easy to
 * get wrong.
 *
 * **Same-origin is not a preference, it is the security boundary.** Everything
 * after the fetch is a same-process instantiation, so a component fetched from
 * somewhere else is code from somewhere else running with every capability the
 * host hands its guests. There is no sandbox behind this check to catch a
 * mistake.
 *
 * **Bodies are bytes, not strings.** One of the two routes returns WebAssembly.
 * Decoding it as UTF-8 to satisfy a string-shaped port would corrupt it — and
 * corrupt it silently, since a lossy decode produces a perfectly valid string
 * that simply is not the module.
 *
 * **Host text is never interpolated verbatim.** The strings available to a page
 * — the document URL, a fetch failure, a host fault — routinely carry
 * query-string session tokens, and an error message is the one string that
 * reliably reaches a console, a receipt, and a bug report at once.
 */
import { describe, expect, it } from "vitest";

import {
	BROWSER_WASM_ERROR_CODES,
	BrowserWasmProviderError,
	contractChanged,
	isBrowserWasmProviderError,
	redactHostText,
} from "../src/errors.js";
import { createBrowserWasmProvider } from "../src/provider.js";
import {
	assertSameOriginAsset,
	createFetchTransport,
	createGuardedTransport,
	DEFAULT_MAX_BUNDLE_BYTES,
	decodeText,
	defaultTransportPolicy,
	HOST_ROUTE_PREFIX,
	type HostAssetTransport,
	headerOf,
	type TransportPolicy,
	type TransportResponse,
} from "../src/transport.js";

const ORIGIN = "https://app.example";
const ASSET = `${ORIGIN}${HOST_ROUTE_PREFIX}guest/component.wasm`;

function policy(overrides: Partial<TransportPolicy> = {}): TransportPolicy {
	return { ...defaultTransportPolicy(ORIGIN), ...overrides };
}

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(BrowserWasmProviderError);
		return (error as BrowserWasmProviderError).code;
	}
	throw new Error("expected the guard to refuse this asset url");
}

function recordingInner(response: Partial<TransportResponse> = {}) {
	const calls: Array<Record<string, unknown>> = [];
	const inner: HostAssetTransport = {
		async request(request) {
			calls.push({ ...request });
			return {
				status: response.status ?? 200,
				headers: response.headers ?? {},
				body: response.body ?? new Uint8Array([0, 97, 115, 109]),
			};
		},
	};
	return { inner, calls };
}

const REQUEST = {
	method: "GET" as const,
	url: ASSET,
	headers: {},
	timeoutMs: 5_000,
	maxResponseBytes: 1024,
};

describe("the default transport policy", () => {
	it("pins the host origin it was built for", () => {
		expect(defaultTransportPolicy(ORIGIN).origin).toBe(ORIGIN);
	});

	it("refuses cleartext localhost by default", () => {
		// The dev-server escape is opt-in. Defaulting it on would let a production
		// page fetch a guest bundle over plain HTTP if a policy was ever built
		// from a localhost-shaped origin.
		expect(defaultTransportPolicy(ORIGIN).allowInsecureLocalhost).toBe(false);
	});

	it("caps a bundle at 64 MiB and a fetch at 30 seconds", () => {
		// A guest bundle is large by web standards, so the cap is generous — but
		// it exists, because an unbounded body in a browser tab is an out-of-
		// memory crash of the whole page, not a failed request.
		expect(DEFAULT_MAX_BUNDLE_BYTES).toBe(64 * 1024 * 1024);
		expect(defaultTransportPolicy(ORIGIN).maxResponseBytes).toBe(
			DEFAULT_MAX_BUNDLE_BYTES,
		);
		expect(defaultTransportPolicy(ORIGIN).timeoutMs).toBe(30_000);
	});

	it("reserves a single route prefix for host assets", () => {
		// One prefix, and a deep one. That depth is what makes the traversal case
		// below safe — see the note there.
		expect(HOST_ROUTE_PREFIX).toBe("/_hobo/");
	});
});

describe("assertSameOriginAsset", () => {
	it("returns the parsed URL for a same-origin asset on the host route", () => {
		expect(assertSameOriginAsset(ASSET, policy())).toBeInstanceOf(URL);
	});

	it("refuses a string that is not a URL", () => {
		for (const url of ["", "not a url", "/_hobo/guest.wasm", "://x"]) {
			expect(codeOf(() => assertSameOriginAsset(url, policy()))).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
		}
	});

	it("refuses a policy whose own origin is not a URL", () => {
		// Both parses share one try block. A malformed policy must fail as a
		// contract error rather than being treated as an origin that matches
		// nothing — which would read identically to a cross-origin refusal.
		expect(
			codeOf(() =>
				assertSameOriginAsset(ASSET, policy({ origin: "nonsense" })),
			),
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("refuses cleartext http to a real host", () => {
		expect(
			codeOf(() =>
				assertSameOriginAsset(
					`http://app.example${HOST_ROUTE_PREFIX}g.wasm`,
					policy({
						origin: "http://app.example",
						allowInsecureLocalhost: true,
					}),
				),
			),
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("permits cleartext localhost only when the host opted in", () => {
		// The dev-server case: nothing crosses a network, so there is nothing to
		// intercept.
		const local = `http://localhost:5173${HOST_ROUTE_PREFIX}g.wasm`;
		const localPolicy = {
			origin: "http://localhost:5173",
			allowInsecureLocalhost: true,
		};
		expect(() =>
			assertSameOriginAsset(local, policy(localPolicy)),
		).not.toThrow();
		expect(
			codeOf(() =>
				assertSameOriginAsset(
					local,
					policy({ ...localPolicy, allowInsecureLocalhost: false }),
				),
			),
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("recognises each spelling of a local host", () => {
		for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
			expect(() =>
				assertSameOriginAsset(`http://${host}:5173${HOST_ROUTE_PREFIX}g.wasm`, {
					...policy(),
					origin: `http://${host}:5173`,
					allowInsecureLocalhost: true,
				}),
			).not.toThrow();
		}
	});

	it("does not treat a lookalike host as local", () => {
		// `localhost.evil.example` resolves to somebody else's server. A substring
		// or suffix test would have let it fetch a guest bundle over cleartext.
		expect(
			codeOf(() =>
				assertSameOriginAsset(
					`http://localhost.evil.example${HOST_ROUTE_PREFIX}g.wasm`,
					{
						...policy(),
						origin: "http://localhost.evil.example",
						allowInsecureLocalhost: true,
					},
				),
			),
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("refuses a cross-origin bundle, as a host-unsupported refusal", () => {
		// The security boundary of the whole package, and a distinct code from a
		// malformed path on purpose: this is not a typo, it is code from
		// somewhere else about to run with every capability the host grants.
		expect(
			codeOf(() =>
				assertSameOriginAsset(
					`https://cdn.evil.example${HOST_ROUTE_PREFIX}g.wasm`,
					policy(),
				),
			),
		).toBe("HOST_UNSUPPORTED");
	});

	it("treats a different port or scheme as a different origin", () => {
		// Origin is scheme + host + port. Comparing hostnames alone would let
		// `https://app.example:8443` serve a bundle to a page from `:443`.
		for (const url of [
			`https://app.example:8443${HOST_ROUTE_PREFIX}g.wasm`,
			`https://sub.app.example${HOST_ROUTE_PREFIX}g.wasm`,
		]) {
			expect(codeOf(() => assertSameOriginAsset(url, policy()))).toBe(
				"HOST_UNSUPPORTED",
			);
		}
	});

	it("names both origins in the refusal detail", () => {
		// So the page author can see which origin they configured against which
		// one the bundle came from, without guessing.
		try {
			assertSameOriginAsset(
				`https://cdn.evil.example${HOST_ROUTE_PREFIX}g.wasm`,
				policy(),
			);
			expect.unreachable("a cross-origin bundle must be refused");
		} catch (error) {
			expect((error as BrowserWasmProviderError).detail).toEqual({
				origin: "https://cdn.evil.example",
				hostOrigin: ORIGIN,
			});
		}
	});

	it("refuses a same-origin path outside the reserved route", () => {
		// The host page serves its own application too. Fetching an arbitrary
		// same-origin path as a guest bundle would let any uploaded file on the
		// origin become executable code.
		for (const path of ["/", "/index.html", "/assets/app.js", "/_hobo"]) {
			expect(
				codeOf(() => assertSameOriginAsset(`${ORIGIN}${path}`, policy())),
			).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("contains a traversal attempt by landing it outside the route", () => {
		// Worth pinning precisely, because the mechanism is not the check it
		// looks like. `new URL()` resolves dot segments *while parsing*, so the
		// literal `/..` test below it never sees one — by then
		// `/_hobo/guest/../../etc/passwd` is already `/etc/passwd`.
		//
		// What actually contains it is the route-prefix check running on that
		// normalized path: the escape lands outside `/_hobo/` and is refused
		// there. A shallower or broader prefix would not have that property —
		// traversal that stays inside the allowed root passes, which is exactly
		// how the same code shape failed in the Kubernetes transport guard, whose
		// `/api/v1/` root was broad enough to swallow `../../nodes`.
		expect(
			codeOf(() =>
				assertSameOriginAsset(
					`${ORIGIN}${HOST_ROUTE_PREFIX}guest/../../etc/passwd`,
					policy(),
				),
			),
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("allows traversal that resolves back inside the route", () => {
		// The other half of the same fact, and it is correct: once the path
		// resolves to something under `/_hobo/`, it is a host asset like any
		// other. Refusing it would break a relative path a bundler emitted.
		expect(
			assertSameOriginAsset(
				`${ORIGIN}${HOST_ROUTE_PREFIX}guest/a/../b.wasm`,
				policy(),
			).pathname,
		).toBe("/_hobo/guest/b.wasm");
	});

	it("refuses a percent-encoded path separator", () => {
		// `%2F` survives URL parsing intact and is decoded only when the asset is
		// fetched — after the origin and route checks have both passed. Refusing
		// rather than decoding keeps this guard's judgement the one that counts.
		expect(
			codeOf(() =>
				assertSameOriginAsset(
					`${ORIGIN}${HOST_ROUTE_PREFIX}guest%2F..%2Fapp.js`,
					policy(),
				),
			),
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("leaves an ordinary query string alone", () => {
		// The guard judges origin and path. Refusing on a cache-busting query
		// would break every bundler that emits one.
		expect(() =>
			assertSameOriginAsset(`${ASSET}?v=abc123`, policy()),
		).not.toThrow();
	});
});

describe("createGuardedTransport", () => {
	it("passes a permitted request through", async () => {
		const { inner, calls } = recordingInner();
		const response = await createGuardedTransport(inner, policy()).request(
			REQUEST,
		);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
	});

	it("refuses a cross-origin bundle before the inner transport is called", async () => {
		// Before, not after. A guard that inspected the response would have
		// already made the cross-origin request.
		const { inner, calls } = recordingInner();
		await expect(
			createGuardedTransport(inner, policy()).request({
				...REQUEST,
				url: `https://cdn.evil.example${HOST_ROUTE_PREFIX}g.wasm`,
			}),
		).rejects.toBeInstanceOf(BrowserWasmProviderError);
		expect(calls).toEqual([]);
	});

	it("clamps the timeout and the byte cap down to the policy, never up", async () => {
		const { inner, calls } = recordingInner();
		await createGuardedTransport(inner, policy()).request({
			...REQUEST,
			timeoutMs: 600_000,
			maxResponseBytes: Number.MAX_SAFE_INTEGER,
		});
		expect(calls[0]?.timeoutMs).toBe(30_000);
		expect(calls[0]?.maxResponseBytes).toBe(DEFAULT_MAX_BUNDLE_BYTES);
	});

	it("leaves a caller's stricter limits alone", async () => {
		const { inner, calls } = recordingInner();
		await createGuardedTransport(inner, policy()).request(REQUEST);
		expect(calls[0]?.timeoutMs).toBe(5_000);
		expect(calls[0]?.maxResponseBytes).toBe(1024);
	});

	it("refuses every 3xx rather than following it", async () => {
		// A redirect on a bundle route is exactly how a same-origin fetch becomes
		// a cross-origin one — and it would arrive already past the origin check,
		// since the check saw the pre-redirect URL.
		for (const status of [301, 302, 303, 307, 308]) {
			const { inner } = recordingInner({ status });
			await expect(
				createGuardedTransport(inner, policy()).request(REQUEST),
			).rejects.toThrow(/never follow redirects/u);
		}
	});

	it("reports a redirect as host-unsupported with its target redacted", async () => {
		// Redacted because a Location header on a hijacked route is
		// attacker-controlled text about to be written to a console.
		const { inner } = recordingInner({
			status: 302,
			headers: { location: "https://cdn.evil.example/g.wasm" },
		});
		try {
			await createGuardedTransport(inner, policy()).request(REQUEST);
			expect.unreachable("a redirect must be refused");
		} catch (error) {
			expect((error as BrowserWasmProviderError).code).toBe("HOST_UNSUPPORTED");
			expect(
				(error as BrowserWasmProviderError).detail as Record<string, unknown>,
			).toMatchObject({ status: 302 });
		}
	});

	it("tolerates a redirect that carried no location header", async () => {
		// The `?? ""` arm. A missing header must not turn the redirect refusal
		// into an unrelated TypeError.
		const { inner } = recordingInner({ status: 307 });
		await expect(
			createGuardedTransport(inner, policy()).request(REQUEST),
		).rejects.toThrow(/never follow redirects/u);
	});

	it("lets 2xx, 4xx and 5xx through to the caller", async () => {
		// Only 3xx is the guard's business. A 404 on a bundle route is a real
		// answer the caller has to interpret.
		for (const status of [200, 206, 404, 500]) {
			const { inner } = recordingInner({ status });
			expect(
				(await createGuardedTransport(inner, policy()).request(REQUEST)).status,
			).toBe(status);
		}
	});

	it("refuses an over-cap body as an unavailable bundle", async () => {
		// Not a contract change: the origin answered, the bundle is simply too
		// large to load into a tab. A caller can act on that.
		const { inner } = recordingInner({ body: new Uint8Array(2048) });
		try {
			await createGuardedTransport(inner, policy()).request(REQUEST);
			expect.unreachable("an over-cap bundle must be refused");
		} catch (error) {
			expect((error as BrowserWasmProviderError).code).toBe(
				"BUNDLE_UNAVAILABLE",
			);
			expect((error as Error).message).toContain("1024 byte cap");
		}
	});

	it("measures the body by byte length, which is what a Uint8Array carries", async () => {
		const { inner } = recordingInner({ body: new Uint8Array(1024) });
		await expect(
			createGuardedTransport(inner, policy()).request(REQUEST),
		).resolves.toBeDefined();
	});
});

describe("createFetchTransport", () => {
	function fakeFetch(
		response: {
			status?: number;
			headers?: Record<string, string>;
			body?: Uint8Array;
		} = {},
	) {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const impl = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return {
				status: response.status ?? 200,
				headers: {
					forEach(fn: (value: string, key: string) => void) {
						for (const [key, value] of Object.entries(response.headers ?? {})) {
							fn(value, key);
						}
					},
				},
				arrayBuffer: async () =>
					(response.body ?? new Uint8Array([0, 97, 115, 109])).buffer,
			};
		}) as unknown as typeof globalThis.fetch;
		return { impl, seen };
	}

	it("returns the status, lowercased headers, and the body as bytes", async () => {
		// Bytes, not a string. One of the two routes returns WebAssembly, and a
		// UTF-8 decode would corrupt it into a valid string that is not the
		// module — a corruption with no error at the point it happens.
		const { impl } = fakeFetch({
			status: 200,
			headers: { "Content-Type": "application/wasm" },
			body: new Uint8Array([0, 97, 115, 109]),
		});
		const response = await createFetchTransport({ fetchImpl: impl }).request(
			REQUEST,
		);
		expect(response.headers["content-type"]).toBe("application/wasm");
		expect(response.body).toBeInstanceOf(Uint8Array);
		expect([...response.body]).toEqual([0, 97, 115, 109]);
	});

	it("never follows redirects at the fetch layer either", async () => {
		// Without `redirect: "manual"` fetch would follow a 302 before the guard
		// ever saw the status, and the guard's refusal would be moot.
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request(REQUEST);
		expect(seen[0]?.init.redirect).toBe("manual");
	});

	it("omits credentials from the bundle fetch", async () => {
		// `credentials: "omit"`. The bundle is public code on the host origin; a
		// fetch carrying the page's session cookie would send it to whatever
		// serves that route, and would make the response vary per user.
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request(REQUEST);
		expect(seen[0]?.init.credentials).toBe("omit");
	});

	it("passes an abort signal so the timeout can actually abort", async () => {
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request(REQUEST);
		expect(seen[0]?.init.signal).toBeDefined();
	});

	it("reports a failed fetch as a retryable unavailable bundle", async () => {
		// Retryable, unlike the Kubernetes writer's ambiguous case, and correctly
		// so: this is a read. Fetching a bundle twice costs a round trip and
		// changes nothing.
		const impl = (async () => {
			throw new Error("network error");
		}) as unknown as typeof globalThis.fetch;
		try {
			await createFetchTransport({ fetchImpl: impl }).request(REQUEST);
			expect.unreachable("a failed fetch must be reported");
		} catch (error) {
			expect((error as BrowserWasmProviderError).code).toBe(
				"BUNDLE_UNAVAILABLE",
			);
			expect((error as BrowserWasmProviderError).retryable).toBe(true);
		}
	});

	it("preserves a BrowserWasmProviderError rather than re-wrapping it", async () => {
		const inner = new BrowserWasmProviderError(
			"BUNDLE_DIGEST_MISMATCH",
			"digest moved",
		);
		const impl = (async () => {
			throw inner;
		}) as unknown as typeof globalThis.fetch;
		await expect(
			createFetchTransport({ fetchImpl: impl }).request(REQUEST),
		).rejects.toBe(inner);
	});
});

describe("decodeText and headerOf", () => {
	it("decodes UTF-8 bytes to text", () => {
		expect(decodeText(new TextEncoder().encode("hello ☃"))).toBe("hello ☃");
	});

	it("decodes non-UTF-8 bytes lossily rather than throwing", () => {
		// `fatal: false`. This is used on the *text* route, where a malformed
		// byte should surface as a parse failure of the document with a
		// replacement character in it — not as an exception from the decoder that
		// says nothing about which route or which asset.
		expect(() => decodeText(new Uint8Array([0xff, 0xfe, 0xfd]))).not.toThrow();
		expect(decodeText(new Uint8Array([0xff]))).toContain("�");
	});

	it("finds a header whatever case it arrived in", () => {
		// HTTP header names are case-insensitive and implementations disagree.
		for (const key of ["Content-Type", "content-type", "CONTENT-TYPE"]) {
			expect(headerOf({ [key]: "application/wasm" }, "content-type")).toBe(
				"application/wasm",
			);
		}
	});

	it("answers undefined for a header that is absent", () => {
		expect(headerOf({}, "content-type")).toBeUndefined();
	});
});

describe("redactHostText", () => {
	it("redacts a bearer token", () => {
		// The single most likely secret in a browser error string.
		expect(redactHostText("failed with Bearer abc.def.ghi")).not.toContain(
			"abc.def.ghi",
		);
	});

	it("redacts a JWT wherever it appears", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K";
		expect(redactHostText(`token=${jwt} failed`)).not.toContain(jwt);
	});

	it("redacts a secret carried in a query string", () => {
		// The usual way a secret reaches a browser: in the URL, which is exactly
		// the string an error message quotes.
		for (const key of [
			"access_token",
			"id_token",
			"session",
			"api_key",
			"api-key",
			"token",
		]) {
			const text = `GET https://app.example/cb?${key}=s3cr3tvalue failed`;
			expect(redactHostText(text)).not.toContain("s3cr3tvalue");
		}
	});

	it("redacts publishable and secret key prefixes", () => {
		for (const key of ["sk_live_abcdefgh12345", "pk-test-abcdefgh12345"]) {
			expect(redactHostText(`key ${key} rejected`)).not.toContain(key);
		}
	});

	it("flattens control characters, because a raw newline in a message is log forging", () => {
		// A CR/LF in host text lets a page write a fake second log line. Flattening
		// to a space keeps the message one line, which is what every consumer of
		// it assumes.
		const flattened = redactHostText("first\nINFO: fake second line\r\tend");
		expect(flattened).not.toMatch(/[\n\r\t]/u);
		expect(flattened).toContain("fake second line");
	});

	it("trims and truncates to the cap, marking that it did", () => {
		// The ellipsis matters: a silently truncated message reads as a complete
		// one, and a reader would not know to go looking for the rest.
		const long = redactHostText(`  ${"a".repeat(400)}  `);
		expect(long.length).toBeLessThanOrEqual(257);
		expect(long.endsWith("…")).toBe(true);
	});

	it("honours a shorter explicit cap", () => {
		expect(redactHostText("a".repeat(50), 10)).toBe(`${"a".repeat(10)}…`);
	});

	it("leaves an ordinary message untouched", () => {
		// Over-redaction costs diagnosability. A message with nothing secret in it
		// must survive intact.
		expect(redactHostText("the bundle was not a component")).toBe(
			"the bundle was not a component",
		);
	});

	it("redacts every occurrence, not just the first", () => {
		// The patterns carry the `g` flag. Redacting only the first would leave
		// the second token in the log, which is no protection at all.
		const redacted = redactHostText("Bearer aaaaaaa then Bearer bbbbbbb");
		expect(redacted).not.toContain("aaaaaaa");
		expect(redacted).not.toContain("bbbbbbb");
	});
});

describe("BrowserWasmProviderError", () => {
	it("redacts the message in the constructor, so no call site can forget", () => {
		expect(
			new BrowserWasmProviderError("HOST_UNSUPPORTED", "Bearer secret123")
				.message,
		).not.toContain("secret123");
	});

	it("defaults to not retryable", () => {
		expect(
			new BrowserWasmProviderError("HOST_UNSUPPORTED", "boom").retryable,
		).toBe(false);
	});

	it("freezes the detail and defaults it to empty", () => {
		expect(
			new BrowserWasmProviderError("HOST_UNSUPPORTED", "boom").detail,
		).toEqual({});
		expect(
			Object.isFrozen(
				new BrowserWasmProviderError("HOST_UNSUPPORTED", "boom", {
					detail: { status: 1 },
				}).detail,
			),
		).toBe(true);
	});

	it("carries a cause when given one", () => {
		const cause = new Error("underlying");
		expect(
			new BrowserWasmProviderError("HOST_UNSUPPORTED", "boom", { cause }).cause,
		).toBe(cause);
	});

	it("is recognisable through the type guard", () => {
		expect(
			isBrowserWasmProviderError(
				new BrowserWasmProviderError("HOST_UNSUPPORTED", "boom"),
			),
		).toBe(true);
		for (const value of [new Error("plain"), null, undefined, "boom", {}]) {
			expect(isBrowserWasmProviderError(value)).toBe(false);
		}
	});

	it("contractChanged always throws, so its call sites need no return", () => {
		expect(() => contractChanged("shape moved")).toThrow(
			BrowserWasmProviderError,
		);
		try {
			contractChanged("shape moved", { field: "status" });
			expect.unreachable("contractChanged must throw");
		} catch (error) {
			expect((error as BrowserWasmProviderError).detail).toEqual({
				field: "status",
			});
		}
	});

	it("names a distinct code for each failure a page can hit", () => {
		// The codes are the contract; callers branch on them rather than on
		// message text. Two failures sharing one code would make them
		// indistinguishable to a handler.
		expect(new Set(BROWSER_WASM_ERROR_CODES).size).toBe(
			BROWSER_WASM_ERROR_CODES.length,
		);
		for (const code of [
			"HOST_UNSUPPORTED",
			"BUNDLE_UNAVAILABLE",
			"BUNDLE_DIGEST_MISMATCH",
			"BUNDLE_NOT_A_COMPONENT",
			"PERSISTENCE_UNAVAILABLE",
			"GUEST_INSTANTIATION_FAILED",
		]) {
			expect(BROWSER_WASM_ERROR_CODES).toContain(code);
		}
	});
});

describe("provider surface", () => {
	const provider = createBrowserWasmProvider();

	it("names itself with the scoped package id", () => {
		expect(provider.id).toBe("@hobo/provider-browser-wasm");
		expect(provider.capabilityManifest().providerId).toBe(provider.id);
	});

	it("reports a single global region, because a tab has no region", () => {
		// Honest rather than empty. A guest runs in whichever tab loaded it, so
		// there is no placement region to report — and an empty list would make
		// the provider unselectable rather than unconstrained.
		expect(provider.regions).toEqual(["global"]);
	});

	it("matches fully when every requested feature is offered", () => {
		const capability = provider.capabilities[0];
		expect(
			capability?.satisfies({
				port: capability.port,
				features: [],
			}),
		).toEqual({ kind: "full" });
	});

	it("matches fully when no features are requested at all", () => {
		// The `?? []` path — the common case, and it must not read as a request
		// for an unknown feature.
		const capability = provider.capabilities[0];
		expect(capability?.satisfies({ port: capability.port })).toEqual({
			kind: "full",
		});
	});

	it("reports a partial match naming exactly what is missing", () => {
		// The missing list is what placement uses to decide between substituting
		// and failing. `none` would hide a near-miss a human could have resolved.
		const capability = provider.capabilities[0];
		expect(
			capability?.satisfies({
				port: capability.port,
				features: ["gpu-compute"],
			}),
		).toEqual({ kind: "partial", missing: ["gpu-compute"] });
	});

	it("reports no match for a port it does not serve", () => {
		expect(
			provider.capabilities[0]?.satisfies({ port: "relational-database" }),
		).toEqual({ kind: "none" });
	});

	it("prices in USD against a provider-qualified SKU", () => {
		const capability = provider.capabilities[0];
		const cost = capability?.estimateCost({ port: capability.port });
		expect(cost?.currency).toBe("USD");
		expect(cost?.sku.startsWith("browser-wasm:")).toBe(true);
	});

	it("publishes a zero marginal price that means unpriced, not free", () => {
		// A guest in a tab costs the *user's* battery and memory, not the
		// operator's money — so there is nothing dated to rank on, and the empty
		// `cost.facts` says so structurally. A ranker reading `"0"` as free would
		// place every workload in a browser.
		const capability = provider.capabilities[0];
		expect(
			capability?.estimateCost({ port: capability.port }).marginalPrice,
		).toBe("0");
		expect(provider.capabilityManifest().cost).toEqual({ facts: [] });
	});

	it("declares brokered token exchange and no static secrets", () => {
		expect(provider.capabilityManifest().auth).toEqual({
			exchange: "hobo:brokered-deploy-token",
			staticSecrets: false,
		});
	});

	it("lists every capability port in the manifest", () => {
		const manifest = provider.capabilityManifest();
		expect(
			manifest.capabilities.capabilities.map((c) => c.port).sort(),
		).toEqual(provider.capabilities.map((c) => c.port).sort());
	});

	it("realizes a plan into a driver program naming the mapped class", () => {
		const port = provider.capabilities[0]?.port as string;
		const { driver } = provider.realize({ name: "guest", port } as never);
		expect(driver.apiVersion).toBe("hobo.driver-program/v1");
		expect(driver.driver).toBe("browser-wasm-deploy");
		expect(driver.resources[0]?.name).toBe("guest");
		expect(driver.resources[0]?.provider).toBe("browser-wasm");
	});

	it("refuses to realize a port it cannot serve, naming the port", () => {
		// Named because a placement that reached here picked the wrong provider,
		// and the reader needs to know which port did it.
		expect(() =>
			provider.realize({ name: "db", port: "relational-database" } as never),
		).toThrow(/cannot realize port relational-database/u);
	});

	it("builds a client carrying the mapped class and service name", () => {
		const port = provider.capabilities[0]?.port as string;
		const client = provider.client(port as never, { bundleUrl: ASSET });
		expect(client.port).toBe(port);
		expect(client.resourceClass.length).toBeGreaterThan(0);
		expect(client.bindings).toEqual({ bundleUrl: ASSET });
	});

	it("refuses a client for a port it has none for", () => {
		expect(() => provider.client("relational-database" as never, {})).toThrow(
			/no client for port relational-database/u,
		);
	});
});
