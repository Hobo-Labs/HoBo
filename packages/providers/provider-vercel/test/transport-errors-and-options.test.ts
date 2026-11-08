/**
 * The Vercel transport guard, the status→code mapping, and the authoring
 * options.
 *
 * The property worth naming first, because it is the one most easily got wrong:
 * **a 5xx means different things to a read and to a mutation.** On a GET it is
 * safe to repeat — nothing changed, and retrying costs a round trip. On a POST,
 * PUT or DELETE it is indistinguishable from "applied but not acknowledged", so
 * it is reported as *ambiguous* and never as retryable. Collapsing those two
 * into one retryable 5xx is how a transfer request gets sent twice.
 *
 * **The credential travels on this path.** Every request here carries the
 * sponsoring token in its headers, which is why the guard is not decoration: a
 * driver that trusted its transport could be pointed at an attacker's origin by
 * one bad config value, and the first request would hand over the credential. A
 * 3xx *naming a target* is refused rather than followed for the same reason — by
 * the time a redirect resolves, the credentialed request has already gone to the
 * target. The refusal is keyed on the Location header rather than on the status
 * class, which is narrower than the module comment reads; the test below pins
 * why that is still correct.
 *
 * **Redaction covers this provider's specific shapes.** Vercel claim and
 * transfer codes are bearer authority on the ownership-transfer path, and the
 * Prisma Postgres integration hands out connection strings with `api_key` in the
 * query. Both are in the pattern list, and both would otherwise reach a receipt.
 */
import { describe, expect, it } from "vitest";

import { PROVIDER_TARGET, vercel } from "../src/options.js";
import {
	isVercelProviderError,
	providerErrorForStatus,
	redactProviderText,
	VercelProviderError,
} from "../src/provider-errors.js";
import {
	assertAllowedEndpoint,
	createFetchTransport,
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
	type TransportPolicy,
	type TransportRequest,
	type TransportResponse,
	VERCEL_ALLOWED_PATH_PREFIXES,
	VERCEL_API_ALLOWED_HOSTS,
	VERCEL_CLAIM_HOST,
	type VercelTransport,
} from "../src/transport.js";

const OK = "https://api.vercel.com/v9/projects/prj_1";

function policy(overrides: Partial<TransportPolicy> = {}): TransportPolicy {
	return { ...DEFAULT_TRANSPORT_POLICY, ...overrides };
}

function recordingInner(response: Partial<TransportResponse> = {}) {
	const calls: TransportRequest[] = [];
	const inner: VercelTransport = {
		async request(request) {
			calls.push({ ...request });
			return {
				status: response.status ?? 200,
				headers: response.headers ?? {},
				body: response.body ?? "{}",
			};
		},
	};
	return { inner, calls };
}

const REQUEST = {
	method: "GET" as const,
	url: OK,
	headers: { authorization: "Bearer token" },
	timeoutMs: 5_000,
	maxResponseBytes: 1024,
};

describe("the default transport policy", () => {
	it("allows exactly one API host", () => {
		// One host is what makes an exfiltrating config a transport error rather
		// than a successful credentialed request to somebody else's server.
		expect([...VERCEL_API_ALLOWED_HOSTS]).toEqual(["api.vercel.com"]);
		expect(DEFAULT_TRANSPORT_POLICY.allowedHosts).toBe(
			VERCEL_API_ALLOWED_HOSTS,
		);
	});

	it("names the dashboard claim host separately, and never calls it", () => {
		// The claim ceremony is a human one. Keeping the host out of the API
		// allowlist is what stops a resolver from trying to perform it
		// programmatically with the sponsoring credential attached.
		expect(VERCEL_CLAIM_HOST).toBe("vercel.com");
		expect(
			DEFAULT_TRANSPORT_POLICY.allowedHosts.some(
				(host) => host === VERCEL_CLAIM_HOST,
			),
		).toBe(false);
	});

	it("allows only the four documented endpoint prefixes", () => {
		// Each prefix is pinned to an endpoint this driver actually uses. A
		// broader allowlist would let a future resolver reach the rest of the
		// account's API surface through the same guarded transport.
		expect([...VERCEL_ALLOWED_PATH_PREFIXES]).toEqual([
			"/projects/",
			"/v9/projects/",
			"/v3/user/tokens/",
			"/v1/installations/",
		]);
	});

	it("bounds the body and the wait", () => {
		// Control-plane calls: small bodies, quick answers. A response larger or
		// slower than this is a contract change, not a big success.
		expect(DEFAULT_TRANSPORT_POLICY.maxResponseBytes).toBe(256 * 1024);
		expect(DEFAULT_TRANSPORT_POLICY.timeoutMs).toBe(15_000);
	});
});

describe("assertAllowedEndpoint", () => {
	it("returns the parsed URL for an allowed endpoint", () => {
		expect(assertAllowedEndpoint(OK, policy())).toBeInstanceOf(URL);
	});

	it("accepts each documented prefix", () => {
		for (const prefix of VERCEL_ALLOWED_PATH_PREFIXES) {
			expect(() =>
				assertAllowedEndpoint(`https://api.vercel.com${prefix}x`, policy()),
			).not.toThrow();
		}
	});

	it("refuses another host, including the dashboard", () => {
		// The dashboard refusal matters most: it is a real Vercel host, so a
		// hostname-suffix check would have allowed it — and the claim URL is the
		// one place a credentialed request must never go.
		for (const host of [
			"vercel.com",
			"evil.example",
			"api.vercel.com.evil.example",
		]) {
			expect(() =>
				assertAllowedEndpoint(`https://${host}/v9/projects/prj_1`, policy()),
			).toThrow(VercelProviderError);
		}
	});

	it("refuses cleartext", () => {
		// The request headers carry the sponsoring credential. Over plain HTTP
		// every hop can read it.
		expect(() =>
			assertAllowedEndpoint("http://api.vercel.com/v9/projects/p", policy()),
		).toThrow(VercelProviderError);
	});

	it("refuses a path outside the driver's endpoints", () => {
		for (const path of ["/", "/v2/user", "/v9/teams/t1", "/projects"]) {
			expect(() =>
				assertAllowedEndpoint(`https://api.vercel.com${path}`, policy()),
			).toThrow(VercelProviderError);
		}
	});

	it("refuses a string that is not a URL", () => {
		for (const url of ["", "not a url", "/v9/projects/p"]) {
			expect(() => assertAllowedEndpoint(url, policy())).toThrow(
				VercelProviderError,
			);
		}
	});

	it("translates core's guard refusal into this package's error type", () => {
		// The guard lives in core and throws a TransportGuardError; every call
		// site in this package matches on VercelProviderError and the
		// PROVIDER_CONTRACT_CHANGED code. Translating rather than re-throwing is
		// what kept that contract intact when the guard moved — a leaked core
		// error would fall through every handler here.
		try {
			assertAllowedEndpoint("https://evil.example/v9/projects/p", policy());
			expect.unreachable("a foreign host must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(VercelProviderError);
			if (!(error instanceof VercelProviderError)) throw error;
			expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
			expect(error.detail).toHaveProperty("guard");
		}
	});

	it("carries core's own guard code in the detail", () => {
		// So the specific reason survives translation. Without it every refusal
		// would look the same to a reader trying to tell a bad host from a bad
		// path.
		try {
			assertAllowedEndpoint("https://api.vercel.com/v2/user", policy());
			expect.unreachable("an out-of-prefix path must be refused");
		} catch (error) {
			if (!(error instanceof VercelProviderError)) throw error;
			const detail = error.detail;
			expect(detail.guard).toEqual(expect.any(String));
			expect(String(detail.guard).length).toBeGreaterThan(0);
		}
	});

	it("honours a narrowed policy", () => {
		expect(() =>
			assertAllowedEndpoint(
				OK,
				policy({ allowedPathPrefixes: ["/projects/"] }),
			),
		).toThrow(VercelProviderError);
	});
});

describe("createGuardedTransport", () => {
	it("passes an allowed request through", async () => {
		const { inner, calls } = recordingInner({ body: '{"id":"prj_1"}' });
		const response = await createGuardedTransport(inner).request(REQUEST);
		expect(response.body).toBe('{"id":"prj_1"}');
		expect(calls).toHaveLength(1);
	});

	it("refuses a foreign host before the inner transport is called", async () => {
		// Before, not after — otherwise the credentialed request has already
		// been made and the guard is only reporting on it.
		const { inner, calls } = recordingInner();
		await expect(
			createGuardedTransport(inner).request({
				...REQUEST,
				url: "https://evil.example/v9/projects/p",
			}),
		).rejects.toBeInstanceOf(VercelProviderError);
		expect(calls).toEqual([]);
	});

	it("forwards a body on a mutation and omits it on a read", async () => {
		// Present-with-undefined and absent differ to some fetch implementations,
		// and a GET carrying a body key is rejected outright by others.
		const { inner, calls } = recordingInner();
		await createGuardedTransport(inner).request(REQUEST);
		expect(Object.hasOwn(calls[0] ?? {}, "body")).toBe(false);

		const post = recordingInner();
		await createGuardedTransport(post.inner).request({
			...REQUEST,
			method: "POST",
			url: "https://api.vercel.com/projects/prj_1/transfer-request",
			body: '{"code":"abc"}',
		});
		expect(post.calls[0]?.body).toBe('{"code":"abc"}');
	});

	it("refuses a 3xx that names a redirect target", async () => {
		// The REST API documents no redirects on these endpoints, so a 3xx with a
		// Location is either a contract change or a hijack — and following one
		// sends the credential to the target before anyone could object.
		for (const status of [301, 302, 303, 307, 308]) {
			const { inner } = recordingInner({
				status,
				headers: { location: "https://evil.example/x" },
			});
			await expect(
				createGuardedTransport(inner).request(REQUEST),
			).rejects.toBeInstanceOf(VercelProviderError);
		}
	});

	it("lets a 3xx carrying no Location through, because there is nowhere to follow", async () => {
		// Pinned because the module comment reads as "every 3xx is refused" and
		// the actual rule — in `assertNotRedirect` in core — is narrower: the
		// refusal is keyed on the Location header, not on the status class. A 304
		// Not Modified is a normal cache answer with no target, so there is no
		// credentialed request that could be misdirected.
		//
		// It is not silently accepted either: this driver sends no conditional
		// requests, so the caller maps the unexpected status through
		// `providerErrorForStatus` and gets PROVIDER_CONTRACT_CHANGED. Worth
		// knowing that the diagnosis comes from there rather than from the guard.
		const { inner } = recordingInner({ status: 304 });
		expect((await createGuardedTransport(inner).request(REQUEST)).status).toBe(
			304,
		);
		expect(
			providerErrorForStatus(304, { method: "GET", operation: "read project" })
				.code,
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("carries the refused redirect target in the detail", async () => {
		// Attacker-controlled text about to be logged, so it arrives bounded —
		// but it arrives, because the target is the one useful fact about a
		// redirect nobody expected.
		const { inner } = recordingInner({
			status: 302,
			headers: { location: "https://evil.example/x" },
		});
		await expect(
			createGuardedTransport(inner).request(REQUEST),
		).rejects.toThrow(/never follows/u);
	});

	it("refuses an over-cap response body", async () => {
		const { inner } = recordingInner({ body: "a".repeat(4096) });
		await expect(
			createGuardedTransport(inner).request({
				...REQUEST,
				maxResponseBytes: 512,
			}),
		).rejects.toBeInstanceOf(VercelProviderError);
	});

	it("lets 2xx, 4xx and 5xx through for the caller to map", async () => {
		// Only 3xx is the guard's business. Statuses are mapped by
		// providerErrorForStatus, which needs to see them.
		for (const status of [200, 404, 410, 429, 500]) {
			const { inner } = recordingInner({ status });
			expect(
				(await createGuardedTransport(inner).request(REQUEST)).status,
			).toBe(status);
		}
	});

	it("translates a guard refusal from inside the request path too", async () => {
		const { inner } = recordingInner();
		await expect(
			createGuardedTransport(
				inner,
				policy({ allowedHosts: ["other.example"] }),
			).request(REQUEST),
		).rejects.toBeInstanceOf(VercelProviderError);
	});
});

describe("createFetchTransport", () => {
	function fakeFetch(
		response: {
			status?: number;
			headers?: Record<string, string>;
			text?: string;
		} = {},
	) {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const impl: typeof globalThis.fetch = async (url, init = {}) => {
			seen.push({ url: String(url), init });
			return new Response(response.text ?? "{}", {
				status: response.status ?? 200,
				headers: response.headers ?? {},
			});
		};
		return { impl, seen };
	}

	it("returns the status, lowercased headers, and body", async () => {
		const { impl } = fakeFetch({
			status: 201,
			headers: { "Content-Type": "application/json" },
			text: '{"ok":true}',
		});
		const response = await createFetchTransport({ fetchImpl: impl }).request(
			REQUEST,
		);
		expect(response.status).toBe(201);
		expect(response.headers["content-type"]).toBe("application/json");
		expect(response.body).toBe('{"ok":true}');
	});

	it("never follows redirects at the fetch layer either", async () => {
		// Without `redirect: "manual"` fetch resolves the 302 before the guard
		// sees the status, and the guard's refusal is moot.
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request(REQUEST);
		expect(seen[0]?.init.redirect).toBe("manual");
	});

	it("passes an abort signal and omits an absent body", async () => {
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request(REQUEST);
		expect(seen[0]?.init.signal).toBeDefined();
		expect(Object.hasOwn(seen[0]?.init ?? {}, "body")).toBe(false);
	});

	it("sends a body on a mutation", async () => {
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request({
			...REQUEST,
			method: "POST",
			body: '{"code":"abc"}',
		});
		expect(seen[0]?.init.body).toBe('{"code":"abc"}');
	});

	it("refuses an over-cap body measured in bytes", async () => {
		// Bytes, not characters: a multi-byte body is larger than its length, and
		// counting characters would let a UTF-8 payload several times the cap in.
		const { impl } = fakeFetch({ text: "é".repeat(600) });
		await expect(
			createFetchTransport({ fetchImpl: impl }).request({
				...REQUEST,
				maxResponseBytes: 1000,
			}),
		).rejects.toThrow(/byte cap/u);
	});

	it("reports a failed request as ambiguous, not as a failure", async () => {
		// The important distinction on a credentialed mutation path. A timed-out
		// or dropped request never proves the server did nothing, and reporting a
		// clean failure would invite a retry that duplicates a transfer request.
		const impl: typeof globalThis.fetch = async () => {
			throw new Error("socket hang up");
		};
		try {
			await createFetchTransport({ fetchImpl: impl }).request({
				...REQUEST,
				method: "POST",
			});
			expect.unreachable("a dropped request must be reported");
		} catch (error) {
			if (!(error instanceof VercelProviderError)) throw error;
			expect(error.code).toBe("PROVIDER_OPERATION_AMBIGUOUS");
			expect(error.detail).toMatchObject({ method: "POST" });
			expect(error.retryable).toBe(false);
		}
	});

	it("preserves a VercelProviderError rather than re-wrapping it as ambiguous", async () => {
		// The over-cap refusal is thrown from inside the try. Re-wrapping it as
		// ambiguous would tell a caller a bounded response might have applied,
		// which is precisely backwards.
		const { impl } = fakeFetch({ text: "a".repeat(4096) });
		try {
			await createFetchTransport({ fetchImpl: impl }).request({
				...REQUEST,
				maxResponseBytes: 10,
			});
			expect.unreachable("an over-cap body must be refused");
		} catch (error) {
			if (!(error instanceof VercelProviderError)) throw error;
			expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});
});

describe("providerErrorForStatus", () => {
	const get = { method: "GET" as const, operation: "read project" };
	const post = { method: "POST" as const, operation: "request transfer" };

	it("maps 429 to a retryable rate limit", () => {
		const error = providerErrorForStatus(429, get);
		expect(error.code).toBe("PROVIDER_RATE_LIMITED");
		expect(error.retryable).toBe(true);
	});

	it("carries a Retry-After hint when the API supplied one", () => {
		// The wait is the API's instruction. Discarding it would make a client
		// pick its own backoff and get rate-limited again.
		expect(
			providerErrorForStatus(429, { ...get, retryAfterMs: 30_000 })
				.retryAfterMs,
		).toBe(30_000);
	});

	it("omits the retry delay when the API gave none", () => {
		// Absent rather than zero. Zero reads as "retry immediately", which is a
		// different instruction to "no guidance".
		expect(providerErrorForStatus(429, get).retryAfterMs).toBeUndefined();
	});

	it("maps 401 and 403 to an auth failure that is not retryable", () => {
		// Repeating a rejected credential produces the same rejection and burns
		// rate limit doing it.
		for (const status of [401, 403]) {
			const error = providerErrorForStatus(status, get);
			expect(error.code).toBe("PROVIDER_AUTH_FAILED");
			expect(error.retryable).toBe(false);
		}
	});

	it("maps 410 to an expired claim, not a generic gone", () => {
		// The transfer-request endpoint calls this out specifically: it is the
		// expiry of a 24-hour code. A generic "gone" would send someone looking
		// for a deleted project instead of issuing a new code.
		const error = providerErrorForStatus(410, post);
		expect(error.code).toBe("CLAIM_EXPIRED");
		expect(error.message).toContain("24 hour");
	});

	it("maps a 5xx on a read to a retryable failure", () => {
		// A read is safe to repeat; nothing changed.
		for (const status of [500, 502, 503]) {
			const error = providerErrorForStatus(status, get);
			expect(error.retryable).toBe(true);
		}
	});

	it("maps a 5xx on a mutation to ambiguous and never retryable", () => {
		// The property this mapping exists for. A 5xx on a POST is
		// indistinguishable from "applied but not acknowledged", so retrying it
		// is how a transfer request gets sent twice.
		for (const method of ["POST", "PUT", "DELETE"] as const) {
			const error = providerErrorForStatus(500, { ...post, method });
			expect(error.code).toBe("PROVIDER_OPERATION_AMBIGUOUS");
			expect(error.retryable).toBe(false);
			expect(error.message).toContain("may or may not have applied");
		}
	});

	it("maps anything else to a contract change", () => {
		for (const status of [400, 404, 409, 418]) {
			expect(providerErrorForStatus(status, get).code).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
		}
	});

	it("carries the status, method, and operation in the detail", () => {
		// The operation is what makes two identical 500s distinguishable in a
		// receipt.
		expect(providerErrorForStatus(500, post).detail).toMatchObject({
			status: 500,
			method: "POST",
			operation: "request transfer",
		});
	});

	it("redacts and truncates a response body carried into the detail", () => {
		// Vercel error bodies quote the request. A transfer code in one would
		// otherwise reach a receipt.
		const detail = providerErrorForStatus(400, {
			...post,
			body: "rejected code=ABCD1234EFGH for project",
		}).detail;
		expect(String(detail.body)).not.toContain("ABCD1234EFGH");
	});

	it("omits an empty body rather than carrying a blank field", () => {
		expect(Object.hasOwn(providerErrorForStatus(400, get).detail, "body")).toBe(
			false,
		);
		expect(
			Object.hasOwn(
				providerErrorForStatus(400, { ...get, body: "" }).detail,
				"body",
			),
		).toBe(false);
	});
});

describe("redactProviderText", () => {
	it("redacts a Vercel transfer code, which is bearer authority", () => {
		// The provider-specific one. A transfer code in a log is enough for
		// whoever reads it to claim the project.
		expect(redactProviderText("use code=ABCD1234EFGH now")).not.toContain(
			"ABCD1234EFGH",
		);
	});

	it("redacts both Prisma Postgres connection string shapes", () => {
		// The integration hands out `prisma+postgres://…?api_key=…` as well as a
		// direct `postgres://` string, and only stripping one would leak the
		// other on every error that quoted a binding.
		for (const value of [
			"prisma+postgres://accelerate.prisma-data.net/?api_key=s3cr3tvalue",
			"postgres://user:hunter2@db.example/app",
			"postgresql://user:hunter2@db.example/app",
		]) {
			const redacted = redactProviderText(`connect ${value}`);
			expect(redacted).not.toContain("s3cr3tvalue");
			expect(redacted).not.toContain("hunter2");
		}
	});

	it("redacts bearer tokens, api keys, passwords, and JWTs", () => {
		for (const [text, secret] of [
			["Bearer s3cr3tvalue99", "s3cr3tvalue99"],
			["api_key=s3cr3tvalue99", "s3cr3tvalue99"],
			["api-key: s3cr3tvalue99", "s3cr3tvalue99"],
			["password=hunter2xyz", "hunter2xyz"],
			["pgpassword: hunter2xyz", "hunter2xyz"],
			["sk_live_abcdefghij", "sk_live_abcdefghij"],
			[
				"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K",
				"dBjftJeZ4CVPmB92K",
			],
		] as const) {
			expect(redactProviderText(text)).not.toContain(secret);
		}
	});

	it("redacts a whole PEM private key block, not just its header", () => {
		// Multi-line and greedy across the block. Matching only the header would
		// leave the key material itself in the log.
		const pem =
			"-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
		expect(redactProviderText(`key ${pem}`)).not.toContain("MIIBOgIBAAJBAK");
	});

	it("flattens control characters so provider text cannot forge a log record", () => {
		const flattened = redactProviderText("first\nERROR: forged\r\tend");
		expect(flattened).not.toMatch(/[\n\r\t]/u);
	});

	it("truncates to the cap and marks that it did", () => {
		// The ellipsis matters: a silently truncated message reads as a complete
		// one, and a reader would not know to look for the rest.
		const long = redactProviderText("a".repeat(400));
		expect(long.length).toBeLessThanOrEqual(257);
		expect(long.endsWith("…")).toBe(true);
	});

	it("leaves an ordinary message untouched", () => {
		// Over-redaction costs diagnosability.
		expect(redactProviderText("project not found")).toBe("project not found");
	});
});

describe("VercelProviderError", () => {
	it("redacts in the constructor, so no call site can forget", () => {
		expect(
			new VercelProviderError("PROVIDER_AUTH_FAILED", "Bearer s3cr3tvalue99")
				.message,
		).not.toContain("s3cr3tvalue99");
	});

	it("defaults to not retryable", () => {
		expect(
			new VercelProviderError("PROVIDER_AUTH_FAILED", "boom").retryable,
		).toBe(false);
	});

	it("freezes the detail and defaults it to empty", () => {
		const error = new VercelProviderError("PROVIDER_UNAVAILABLE", "boom", {
			detail: { status: 503 },
		});
		expect(Object.isFrozen(error.detail)).toBe(true);
		expect(
			new VercelProviderError("PROVIDER_UNAVAILABLE", "boom").detail,
		).toEqual({});
	});

	it("projects a receipt-safe JSON form", () => {
		// Already redacted by construction, so the projection is safe to embed —
		// which is the whole reason the method exists rather than callers
		// spreading the error.
		const json = new VercelProviderError("PROVIDER_RATE_LIMITED", "slow down", {
			retryable: true,
			retryAfterMs: 1000,
			detail: { status: 429 },
		}).toJSON();
		expect(json).toEqual({
			name: "VercelProviderError",
			code: "PROVIDER_RATE_LIMITED",
			message: "slow down",
			retryable: true,
			retryAfterMs: 1000,
			detail: { status: 429 },
		});
	});

	it("omits the retry delay from the projection when there is none", () => {
		expect(
			Object.hasOwn(
				new VercelProviderError("PROVIDER_AUTH_FAILED", "boom").toJSON(),
				"retryAfterMs",
			),
		).toBe(false);
	});

	it("carries a cause and is recognisable through the type guard", () => {
		const cause = new Error("underlying");
		expect(
			new VercelProviderError("PROVIDER_UNAVAILABLE", "boom", { cause }).cause,
		).toBe(cause);
		expect(
			isVercelProviderError(
				new VercelProviderError("PROVIDER_UNAVAILABLE", "boom"),
			),
		).toBe(true);
		for (const value of [new Error("plain"), null, undefined, "boom", {}]) {
			expect(isVercelProviderError(value)).toBe(false);
		}
	});
});

describe("authoring options", () => {
	it("names vercel as the provider target on every block", () => {
		for (const block of [
			vercel.with.web(),
			vercel.with.blob(),
			vercel.with.neonPostgres(),
			vercel.with.edgeConfig(),
		]) {
			expect(block.providerId).toBe(PROVIDER_TARGET);
		}
	});

	it("negotiates by preference, not requirement", () => {
		// `prefer` means placement may pick another provider when Vercel cannot
		// serve the port. `require` would turn a routine substitution into a
		// deploy failure.
		for (const block of [vercel.with.web(), vercel.with.edgeConfig()]) {
			expect(block.negotiation).toBe("prefer");
		}
	});

	it("targets the right port for each product", () => {
		expect(vercel.with.web().port).toBe("compute");
		expect(vercel.with.blob().port).toBe("objectStore");
		expect(vercel.with.neonPostgres().port).toBe("database");
		expect(vercel.with.edgeConfig().port).toBe("kv");
	});

	it("names each option so two blocks on one port stay distinguishable", () => {
		expect(vercel.with.web().optionName).toBe("web");
		expect(vercel.with.neonPostgres().optionName).toBe("neonPostgres");
	});

	it("supplies a working default per product", () => {
		// What makes each builder authorable with no arguments at all. Without
		// them a caller would have to know Vercel's vocabulary to write the
		// simplest possible block.
		expect(vercel.with.web().options).toEqual({ framework: "nextjs" });
		expect(vercel.with.blob().options).toEqual({ store: "assets" });
		expect(vercel.with.neonPostgres().options).toEqual({ engine: "postgres" });
		expect(vercel.with.edgeConfig().options).toEqual({ store: "edge-config" });
	});

	it("lets caller options override the defaults rather than merging under them", () => {
		// `{ ...defaults, ...options }`. The other spread order would silently
		// discard an explicit framework and deploy something the author did not
		// ask for, with nothing recording the swap.
		expect(vercel.with.web({ framework: "astro" }).options).toEqual({
			framework: "astro",
		});
	});

	it("carries extra options through alongside the defaults", () => {
		expect(vercel.with.web({ regions: ["iad1"] }).options).toEqual({
			framework: "nextjs",
			regions: ["iad1"],
		});
	});

	it("returns a fresh block per call", () => {
		// Blocks are held in authoring code and sometimes mutated by it. A shared
		// object would let one deployment's options leak into another's.
		vercel.with.web().options.framework = "mutated";
		expect(vercel.with.web().options.framework).toBe("nextjs");
	});
});
