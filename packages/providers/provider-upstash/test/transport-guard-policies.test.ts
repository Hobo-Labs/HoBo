/**
 * The Upstash HTTP boundary — the guard that makes any supplied transport safe.
 *
 * This matters more here than in most providers, because the control-plane
 * call is **unauthenticated and anonymous**: there is no account and no API
 * key, so nothing would fail if the request went somewhere else. An
 * attacker-controlled origin would simply hand back a document with *their*
 * token in it, and the driver would faithfully bind a workload to a Redis the
 * attacker can read. The allowlist is the entire defence.
 *
 * **A 3xx is refused, not followed.** This API documents no redirects, so one
 * is either a contract change or a hijack — and on the data plane the request
 * carries a bearer token, which a followed redirect would deliver to the
 * redirect target. Refusing is the only option that does not leak.
 *
 * **A caller asking for more time or more bytes than the policy allows is
 * clamped, not refused.** That is a deliberate difference from core's guard,
 * which states the refusal as doctrine. Both behaviours are defensible and the
 * package pins the clamp; reconciling them is a change to argue on its own
 * merits rather than a side effect of sharing code.
 *
 * **The two planes have different policies** because they are different
 * origins with different rules: the control plane is one exact host under one
 * path prefix, the data plane is a per-database suffix match with a much
 * larger body cap. Sharing one policy would either block legitimate reads or
 * widen control-plane egress.
 */
import { describe, expect, it } from "vitest";

import { UpstashProviderError } from "../src/errors.js";
import {
	assertAllowedEndpoint,
	createFetchTransport,
	createGuardedTransport,
	type TransportResponse,
	UPSTASH_CONTROL_PLANE_HOST,
	UPSTASH_CONTROL_PLANE_POLICY,
	UPSTASH_DATA_PLANE_HOST_SUFFIX,
	UPSTASH_DATA_PLANE_POLICY,
	type UpstashTransport,
} from "../src/transport.js";

const CONTROL = "https://upstash.com/start-redis";
const DATA = "https://db-1.upstash.io/get/key";

/** A transport that records what it was handed and replies from a fixture. */
function fakeInner(response: Partial<TransportResponse> = {}) {
	const seen: Array<Record<string, unknown>> = [];
	const transport: UpstashTransport = {
		async request(request) {
			seen.push({ ...request });
			return { status: 200, headers: {}, body: "ok", ...response };
		},
	};
	return { transport, seen };
}

const errorOf = async (run: () => Promise<unknown>) => {
	try {
		await run();
		return undefined;
	} catch (error) {
		expect(error).toBeInstanceOf(UpstashProviderError);
		return error as UpstashProviderError;
	}
};

describe("the published policies", () => {
	it("pins the one documented no-signup control-plane origin", () => {
		// Widening this widens egress from an unauthenticated call — the exact
		// thing the allowlist exists to bound.
		expect(UPSTASH_CONTROL_PLANE_HOST).toBe("upstash.com");
		expect(UPSTASH_CONTROL_PLANE_POLICY.allowedHosts).toEqual(["upstash.com"]);
		expect(UPSTASH_CONTROL_PLANE_POLICY.allowedHostSuffixes).toEqual([]);
		expect(UPSTASH_CONTROL_PLANE_POLICY.allowedPathPrefix).toBe("/start-redis");
	});

	it("anchors the data-plane suffix with a leading dot", () => {
		// A suffix written `upstash.io` rather than `.upstash.io` would admit
		// `evilupstash.io`. Core refuses an unanchored policy outright, and the
		// constant is where that starts.
		expect(UPSTASH_DATA_PLANE_HOST_SUFFIX).toBe(".upstash.io");
		expect(UPSTASH_DATA_PLANE_POLICY.allowedHostSuffixes).toEqual([
			".upstash.io",
		]);
		expect(UPSTASH_DATA_PLANE_POLICY.allowedHosts).toEqual([]);
	});

	it("gives the data plane a much larger body cap than the control plane", () => {
		// A control-plane cap on the data plane would reject a legitimate
		// `LRANGE`; a data-plane cap on the control plane would let a contract
		// change go unnoticed.
		expect(UPSTASH_DATA_PLANE_POLICY.maxResponseBytes).toBeGreaterThan(
			UPSTASH_CONTROL_PLANE_POLICY.maxResponseBytes,
		);
	});
});

describe("assertAllowedEndpoint", () => {
	it("accepts the control-plane origin under its path prefix", () => {
		expect(
			assertAllowedEndpoint(CONTROL, UPSTASH_CONTROL_PLANE_POLICY).hostname,
		).toBe("upstash.com");
	});

	it("accepts a per-database data-plane origin", () => {
		expect(
			assertAllowedEndpoint(DATA, UPSTASH_DATA_PLANE_POLICY).hostname,
		).toBe("db-1.upstash.io");
	});

	it("refuses a host outside the allowlist under this package's error type", () => {
		// Callers match on `UpstashProviderError` and its
		// `PROVIDER_CONTRACT_CHANGED` code; core throws its own type, so the
		// translation is what keeps every call site working.
		const error = errorOf(async () =>
			assertAllowedEndpoint(
				"https://evil.example/start-redis",
				UPSTASH_CONTROL_PLANE_POLICY,
			),
		);
		return error.then((thrown) => {
			expect(thrown?.code).toBe("PROVIDER_CONTRACT_CHANGED");
			expect(thrown?.detail.guard).toBeTruthy();
		});
	});

	it("refuses a suffix look-alike on the data plane", () => {
		// `evilupstash.io` ends with `upstash.io` but is a different domain.
		// This is the bug the dot-anchored suffix exists to close, and it was
		// measured rather than theorised.
		return errorOf(async () =>
			assertAllowedEndpoint(
				"https://evilupstash.io/get/key",
				UPSTASH_DATA_PLANE_POLICY,
			),
		).then((thrown) => expect(thrown?.code).toBe("PROVIDER_CONTRACT_CHANGED"));
	});

	it("refuses plaintext HTTP", () => {
		// The control-plane response carries a token in its body. Over HTTP it
		// is readable by anyone on the path.
		return errorOf(async () =>
			assertAllowedEndpoint(
				"http://upstash.com/start-redis",
				UPSTASH_CONTROL_PLANE_POLICY,
			),
		).then((thrown) => expect(thrown?.code).toBe("PROVIDER_CONTRACT_CHANGED"));
	});

	it("refuses a path outside the prefix", () => {
		// The control-plane policy grants exactly one endpoint. A different path
		// on the same host is a different API.
		return errorOf(async () =>
			assertAllowedEndpoint(
				"https://upstash.com/admin",
				UPSTASH_CONTROL_PLANE_POLICY,
			),
		).then((thrown) => expect(thrown?.code).toBe("PROVIDER_CONTRACT_CHANGED"));
	});

	it("refuses a value that is not a URL at all", () => {
		return errorOf(async () =>
			assertAllowedEndpoint("not a url", UPSTASH_CONTROL_PLANE_POLICY),
		).then((thrown) => expect(thrown).toBeInstanceOf(UpstashProviderError));
	});

	it("returns the parsed URL so a caller cannot keep the unchecked string", () => {
		// Handing back a URL rather than a boolean is what stops a call site
		// from checking one string and sending another.
		const url = assertAllowedEndpoint(DATA, UPSTASH_DATA_PLANE_POLICY);
		expect(url).toBeInstanceOf(URL);
		expect(url.toString()).toContain("db-1.upstash.io");
	});
});

describe("createGuardedTransport — request side", () => {
	const guarded = (
		response: Partial<TransportResponse> = {},
		policy = UPSTASH_CONTROL_PLANE_POLICY,
	) => {
		const inner = fakeInner(response);
		return {
			...inner,
			transport: createGuardedTransport(inner.transport, policy),
		};
	};

	const request = (overrides: Record<string, unknown> = {}) => ({
		method: "GET" as const,
		url: CONTROL,
		headers: {},
		timeoutMs: 5_000,
		maxResponseBytes: 1_000,
		...overrides,
	});

	it("checks the URL before calling the inner transport", () => {
		// A guard that checked afterwards would have already sent the request —
		// and, on the data plane, the bearer token.
		const { transport, seen } = guarded();
		return expect(
			transport.request(request({ url: "https://evil.example/start-redis" })),
		)
			.rejects.toThrow(UpstashProviderError)
			.then(() => expect(seen).toHaveLength(0));
	});

	it("passes the parsed URL down rather than the caller's string", async () => {
		const { transport, seen } = guarded();
		await transport.request(
			request({ url: "https://upstash.com/start-redis" }),
		);
		expect(seen[0]?.url).toBe("https://upstash.com/start-redis");
	});

	it("clamps a timeout above the policy's rather than refusing it", async () => {
		// The deliberate difference from core's guard. Pinned so a later
		// consolidation is a decision rather than an accident.
		const { transport, seen } = guarded();
		await transport.request(request({ timeoutMs: 999_999 }));
		expect(seen[0]?.timeoutMs).toBe(UPSTASH_CONTROL_PLANE_POLICY.timeoutMs);
	});

	it("leaves a shorter timeout alone", async () => {
		// The clamp is a ceiling, not a floor — a caller asking for less patience
		// than the policy allows gets what it asked for.
		const { transport, seen } = guarded();
		await transport.request(request({ timeoutMs: 100 }));
		expect(seen[0]?.timeoutMs).toBe(100);
	});

	it("clamps the byte cap the same way", async () => {
		const { transport, seen } = guarded();
		await transport.request(request({ maxResponseBytes: 99_999_999 }));
		expect(seen[0]?.maxResponseBytes).toBe(
			UPSTASH_CONTROL_PLANE_POLICY.maxResponseBytes,
		);
	});

	it("refuses a non-positive or non-finite timeout", async () => {
		// A zero or `NaN` timeout would either abort instantly or never — both
		// silently, and both far from the call site that supplied it.
		const { transport } = guarded();
		for (const timeoutMs of [0, -1, Number.NaN]) {
			const error = await errorOf(() =>
				transport.request(request({ timeoutMs })),
			);
			expect(error?.message, String(timeoutMs)).toContain(
				"timeout must be positive",
			);
		}
	});
});

describe("createGuardedTransport — response side", () => {
	const guarded = (response: Partial<TransportResponse>) =>
		createGuardedTransport(
			fakeInner(response).transport,
			UPSTASH_CONTROL_PLANE_POLICY,
		);

	const request = {
		method: "GET" as const,
		url: CONTROL,
		headers: {},
		timeoutMs: 5_000,
		maxResponseBytes: 1_000,
	};

	it("refuses every 3xx, including one with no Location", async () => {
		// A stricter rule than core's, which lets a `Location`-less 304 through
		// as a cache answer. This API documents no redirects at all, so any 3xx
		// is a contract change — and following one would deliver the data-plane
		// bearer token to the target.
		for (const status of [301, 302, 303, 304, 307, 308]) {
			const error = await errorOf(() => guarded({ status }).request(request));
			expect(error?.code, String(status)).toBe("PROVIDER_CONTRACT_CHANGED");
			expect(error?.message).toContain("never follows");
		}
	});

	it("records the status and a redacted location in the detail", async () => {
		// The location says where the provider tried to send the request, which
		// is the whole diagnostic — but it is provider-controlled text landing
		// in a structured field.
		const error = await errorOf(() =>
			guarded({
				status: 302,
				headers: { location: "https://evil.example/steal" },
			}).request(request),
		);
		expect(error?.detail.status).toBe(302);
		expect(String(error?.detail.location)).toContain("evil.example");
	});

	it("reads the location header case-insensitively", async () => {
		// HTTP header names are case-insensitive and transports differ on how
		// they normalize; missing the header would report an empty location.
		const error = await errorOf(() =>
			guarded({
				status: 302,
				headers: { Location: "https://x.example/" },
			}).request(request),
		);
		expect(String(error?.detail.location)).toContain("x.example");
	});

	it("reports an empty location when the redirect carried none", async () => {
		const error = await errorOf(() =>
			guarded({ status: 302 }).request(request),
		);
		expect(error?.detail.location).toBe("");
	});

	it("refuses a response whose declared length is over the cap", async () => {
		// Refusing on the declared length avoids buffering a body the transport
		// has already been told is too large.
		const error = await errorOf(() =>
			guarded({ headers: { "content-length": "5000" } }).request(request),
		);
		expect(error?.message).toContain("5000 byte response");
		expect(error?.message).toContain("1000 byte cap");
	});

	it("ignores a content-length that is not a number", async () => {
		// A malformed header is not evidence of an oversized body, and refusing
		// on it would reject a legitimate response over a header typo.
		await expect(
			guarded({ headers: { "content-length": "lots" } }).request(request),
		).resolves.toMatchObject({ status: 200 });
	});

	it("refuses an actual body over the cap even when the header lied", async () => {
		// The declared length is the provider's claim; the body is the fact.
		// Checking only the header would let an oversized body through by
		// omitting it.
		const error = await errorOf(() =>
			guarded({ body: "x".repeat(1_001) }).request(request),
		);
		expect(error?.message).toContain("exceeded the 1000 byte cap");
	});

	it("measures the body in bytes rather than characters", async () => {
		// A multi-byte character counts once as a character and several times as
		// bytes. Measuring characters would let a body several times the cap
		// through.
		const error = await errorOf(() =>
			guarded({ body: "€".repeat(400) }).request(request),
		);
		expect(error?.code).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("passes a compliant response straight through", async () => {
		await expect(
			guarded({ status: 200, body: "ok" }).request(request),
		).resolves.toEqual({ status: 200, headers: {}, body: "ok" });
	});

	it("passes a 4xx or 5xx through for the caller to interpret", async () => {
		// Status mapping belongs to the caller; the guard's job is egress and
		// size, not error semantics.
		for (const status of [404, 429, 500]) {
			await expect(guarded({ status }).request(request)).resolves.toMatchObject(
				{ status },
			);
		}
	});
});

describe("createFetchTransport", () => {
	const request = {
		method: "GET" as const,
		url: CONTROL,
		headers: { "x-test": "1" },
		timeoutMs: 1_000,
		maxResponseBytes: 1_000,
	};

	it("never follows redirects at the fetch layer either", async () => {
		// Belt and braces: the guard refuses a 3xx, but only if fetch hands one
		// back rather than transparently following it.
		let init: RequestInit | undefined;
		const transport = createFetchTransport({
			fetchImpl: (async (_url: string, options: RequestInit) => {
				init = options;
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch,
		});
		await transport.request(request);
		expect(init?.redirect).toBe("manual");
		expect(init?.signal).toBeDefined();
	});

	it("lowercases response header names", async () => {
		// The guard reads `content-length` and `location`; a transport that
		// preserved the server's casing would make those lookups miss.
		const transport = createFetchTransport({
			fetchImpl: (async () =>
				new Response("ok", {
					status: 200,
					headers: { "Content-Type": "text/plain" },
				})) as unknown as typeof fetch,
		});
		const response = await transport.request(request);
		expect(response.headers["content-type"]).toBe("text/plain");
	});

	it("refuses a body over the caller's cap", async () => {
		const transport = createFetchTransport({
			fetchImpl: (async () =>
				new Response("x".repeat(2_000), {
					status: 200,
				})) as unknown as typeof fetch,
		});
		const error = await errorOf(() => transport.request(request));
		expect(error?.code).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("reports a failed request as ambiguous, not failed", async () => {
		// A timed-out or dropped request never proves the server did nothing.
		// Reporting it as a clean failure would invite a retry that provisions
		// a second database.
		const transport = createFetchTransport({
			fetchImpl: (async () => {
				throw new Error("ECONNRESET");
			}) as unknown as typeof fetch,
		});
		const error = await errorOf(() => transport.request(request));
		expect(error?.code).toBe("PROVIDER_OPERATION_AMBIGUOUS");
		expect(error?.detail.method).toBe("GET");
		expect(error?.cause).toBeInstanceOf(Error);
	});

	it("lets its own cap refusal through rather than relabelling it ambiguous", async () => {
		// An oversized body is a definite contract change, not an unknown
		// outcome — the request completed.
		const transport = createFetchTransport({
			fetchImpl: (async () =>
				new Response("x".repeat(2_000), {
					status: 200,
				})) as unknown as typeof fetch,
		});
		expect((await errorOf(() => transport.request(request)))?.code).toBe(
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("sends a body only when the caller supplied one", async () => {
		// A `body: undefined` on a GET is rejected by some fetch implementations
		// outright.
		let init: RequestInit | undefined;
		const transport = createFetchTransport({
			fetchImpl: (async (_url: string, options: RequestInit) => {
				init = options;
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch,
		});
		await transport.request(request);
		expect("body" in (init ?? {})).toBe(false);

		await transport.request({ ...request, method: "POST", body: "{}" });
		expect(init?.body).toBe("{}");
	});
});
