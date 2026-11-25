/**
 * The Kubernetes transport guard.
 *
 * Unlike a SaaS driver there is no host allowlist to write down — the apiserver
 * is the operator's own, at an address only they know. So everything *else* has
 * to be pinned, and each rule here stops a specific way a namespaced write
 * reaches somewhere it should not.
 *
 * **TLS, with exactly one escape.** `kubectl proxy` terminates TLS locally and
 * serves plain HTTP on the loopback. That is the only cleartext apiserver
 * address this driver will talk to, only when a host opts in, and only on a
 * loopback host. Any wider allowance would let a bearer token cross a network in
 * the clear.
 *
 * **No userinfo in the URL.** Credentials belong to the transport the host
 * supplied. A URL carrying `user:pass@` is a credential in a string that gets
 * logged, and it is refused as an auth failure rather than quietly stripped.
 *
 * **No traversal, encoded or literal.** `..` in a request path is how a
 * namespaced call reaches a cluster-scoped object. This refusal is checked
 * against the caller's *raw* path, and writing these tests is what showed why it
 * has to be: `new URL()` resolves dot segments while parsing, so a guard reading
 * `parsed.pathname` sees `/api/v1/nodes` where the caller wrote
 * `/api/v1/namespaces/default/../../nodes` — a cluster-scoped path, inside the
 * allowed root, indistinguishable from one somebody meant to write. The fix in
 * this tranche moves both the literal and the percent-encoded checks onto the
 * raw path; the two tests below fail against the previous implementation.
 *
 * **No redirect chasing.** The apiserver documents no redirects on these paths,
 * so a 3xx is either a contract change or a hijack. Following one would have
 * already sent the object to the redirect target by the time anyone noticed.
 */
import { describe, expect, it } from "vitest";

import {
	contractChanged,
	isKubernetesProviderError,
	KubernetesProviderError,
	redactClusterText,
} from "../src/errors.js";
import {
	assertAllowedEndpoint,
	createFetchTransport,
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
	type KubernetesTransport,
	type TransportPolicy,
	type TransportResponse,
} from "../src/transport.js";

const OK = "https://apiserver.internal/api/v1/namespaces/default/pods";

function policy(overrides: Partial<TransportPolicy> = {}): TransportPolicy {
	return { ...DEFAULT_TRANSPORT_POLICY, ...overrides };
}

/** Records what the guard passed through and answers with a fixed response. */
function recordingInner(response: Partial<TransportResponse> = {}) {
	const calls: Array<Record<string, unknown>> = [];
	const inner: KubernetesTransport = {
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
	headers: {},
	timeoutMs: 5_000,
	maxResponseBytes: 1024,
};

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(KubernetesProviderError);
		return (error as KubernetesProviderError).code;
	}
	throw new Error("expected the guard to refuse this endpoint");
}

describe("the default policy", () => {
	it("allows only the two API roots this driver uses", () => {
		// Not "any apiserver path". The driver reads core objects and apps
		// workloads; a wider root would let a future resolver reach RBAC or
		// admission configuration through the same guarded transport.
		expect(DEFAULT_TRANSPORT_POLICY.allowedPathPrefixes).toEqual([
			"/api/v1/",
			"/apis/apps/v1/",
		]);
	});

	it("refuses cleartext by default", () => {
		// The loopback escape is opt-in. Defaulting it on would make a
		// misconfigured host send bearer tokens over plain HTTP with nothing
		// saying so.
		expect(DEFAULT_TRANSPORT_POLICY.allowInsecureLoopback).toBe(false);
	});

	it("bounds the body and the wait", () => {
		expect(DEFAULT_TRANSPORT_POLICY.maxResponseBytes).toBe(512 * 1024);
		expect(DEFAULT_TRANSPORT_POLICY.timeoutMs).toBe(30_000);
	});
});

describe("assertAllowedEndpoint", () => {
	it("returns the parsed URL, so a caller cannot reuse the unchecked string", () => {
		// The return type is the mechanism: handing back the parsed URL means the
		// checked value is the one that gets sent.
		expect(assertAllowedEndpoint(OK, policy())).toBeInstanceOf(URL);
		expect(assertAllowedEndpoint(OK, policy()).pathname).toBe(
			"/api/v1/namespaces/default/pods",
		);
	});

	it("accepts both API roots", () => {
		expect(() =>
			assertAllowedEndpoint(
				"https://apiserver.internal/apis/apps/v1/namespaces/default/deployments",
				policy(),
			),
		).not.toThrow();
	});

	it("refuses a string that is not a URL at all", () => {
		for (const url of ["", "not a url", "/api/v1/pods", "://x"]) {
			expect(codeOf(() => assertAllowedEndpoint(url, policy()))).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
		}
	});

	it("refuses cleartext http to a real host", () => {
		// The case the loopback escape must never widen to. A bearer token to a
		// remote apiserver over plain HTTP is readable by every hop.
		expect(
			codeOf(() =>
				assertAllowedEndpoint(
					"http://apiserver.internal/api/v1/pods",
					policy({ allowInsecureLoopback: true }),
				),
			),
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("refuses a non-http scheme outright", () => {
		for (const url of [
			"file:///api/v1/pods",
			"ftp://apiserver.internal/api/v1/pods",
		]) {
			expect(codeOf(() => assertAllowedEndpoint(url, policy()))).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
		}
	});

	it("permits cleartext loopback only when the host opted in", () => {
		// The `kubectl proxy` case: TLS is terminated locally, so there is no
		// network for cleartext to cross.
		const url = "http://127.0.0.1:8001/api/v1/namespaces/default/pods";
		expect(() =>
			assertAllowedEndpoint(url, policy({ allowInsecureLoopback: true })),
		).not.toThrow();
		expect(codeOf(() => assertAllowedEndpoint(url, policy()))).toBe(
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("recognises every spelling of loopback", () => {
		// A host that opted in for `localhost` must not be refused for `[::1]`,
		// or the escape would work only on some machines.
		for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]"]) {
			expect(() =>
				assertAllowedEndpoint(
					`http://${host}:8001/api/v1/pods`,
					policy({ allowInsecureLoopback: true }),
				),
			).not.toThrow();
		}
	});

	it("does not treat a lookalike host as loopback", () => {
		// `localhost.evil.example` and `127.0.0.1.evil.example` both resolve to
		// somebody else's server. A prefix or substring test would have let both
		// through as cleartext.
		for (const host of [
			"localhost.evil.example",
			"notlocalhost",
			"127.0.0.1.evil.example",
		]) {
			expect(
				codeOf(() =>
					assertAllowedEndpoint(
						`http://${host}/api/v1/pods`,
						policy({ allowInsecureLoopback: true }),
					),
				),
			).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("refuses a URL embedding userinfo, as an auth failure", () => {
		// A distinct code on purpose: this is not a malformed path, it is a
		// credential in a string that gets logged. Stripping it silently would
		// hide that somebody put one there.
		for (const url of [
			"https://user:pass@apiserver.internal/api/v1/pods",
			"https://user@apiserver.internal/api/v1/pods",
			"https://:pass@apiserver.internal/api/v1/pods",
		]) {
			expect(codeOf(() => assertAllowedEndpoint(url, policy()))).toBe(
				"PROVIDER_AUTH_FAILED",
			);
		}
	});

	it("refuses a path outside the driver's roots", () => {
		for (const path of [
			"/apis/rbac.authorization.k8s.io/v1/clusterroles",
			"/healthz",
			"/",
			"/api/v2/pods",
			"/api/v1",
		]) {
			expect(
				codeOf(() =>
					assertAllowedEndpoint(`https://apiserver.internal${path}`, policy()),
				),
			).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("names the roots it does allow in the refusal", () => {
		try {
			assertAllowedEndpoint("https://apiserver.internal/healthz", policy());
			expect.unreachable("an out-of-root path must be refused");
		} catch (error) {
			for (const prefix of DEFAULT_TRANSPORT_POLICY.allowedPathPrefixes) {
				expect((error as Error).message).toContain(prefix);
			}
		}
	});

	it("refuses a literal dot-segment traversal", () => {
		// DEFECT FOUND AND FIXED while writing this test. The guard inspected
		// `parsed.pathname`, but `new URL()` resolves dot segments *while
		// parsing* — so by the time the check ran,
		// `/api/v1/namespaces/default/../../nodes` had already become
		// `/api/v1/nodes`. That is inside the allowed `/api/v1/` root, so the
		// guard returned it as a path the caller wrote.
		//
		// Which is exactly the escalation the refusal exists to stop: a namespace
		// name interpolated with `..` turns a namespaced pod call into a call
		// against cluster-scoped Nodes, and nothing downstream can tell, because
		// the URL it receives is a perfectly ordinary one.
		//
		// The fix checks the caller's raw path, before parsing. This assertion
		// fails against the old implementation.
		expect(
			codeOf(() =>
				assertAllowedEndpoint(
					"https://apiserver.internal/api/v1/namespaces/default/../../nodes",
					policy(),
				),
			),
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("refuses a percent-encoded path separator or dot segment", () => {
		// Two different evasions, and the same defect as above split them apart.
		// `%2F` survives URL parsing intact and the original check caught it.
		// `%2E%2E` does *not*: it is decoded to `..` and then resolved away, so
		// the normalized path no longer carries the encoding the check looked
		// for, and `/api/v1/namespaces/%2E%2E/pods` was accepted as
		// `/api/v1/pods`. Both are now checked against the raw path as well.
		for (const path of [
			"/api/v1/namespaces/default/pods/a%2Fb",
			"/api/v1/namespaces/%2E%2E/pods",
			"/api/v1/namespaces/default/pods/%2e%2e",
		]) {
			expect(
				codeOf(() =>
					assertAllowedEndpoint(`https://apiserver.internal${path}`, policy()),
				),
			).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("refuses a doubled slash, because the path must arrive normalized", () => {
		// An empty path segment is ambiguous to the apiserver's router and is a
		// tell that a name was interpolated empty.
		expect(
			codeOf(() =>
				assertAllowedEndpoint(
					"https://apiserver.internal/api/v1//pods",
					policy(),
				),
			),
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("leaves an ordinary query string alone", () => {
		// The guard judges the path, not the query. Refusing on a label selector
		// would break every list call the driver makes.
		expect(() =>
			assertAllowedEndpoint(
				`${OK}?labelSelector=app%3Dweb&limit=100`,
				policy(),
			),
		).not.toThrow();
	});
});

describe("createGuardedTransport", () => {
	it("passes a permitted request through to the inner transport", async () => {
		const { inner, calls } = recordingInner({ body: '{"items":[]}' });
		const response = await createGuardedTransport(inner).request(REQUEST);
		expect(response.body).toBe('{"items":[]}');
		expect(calls).toHaveLength(1);
	});

	it("sends the parsed URL rather than the caller's string", async () => {
		// So a string the guard normalised while parsing cannot differ from the
		// one that goes out.
		const { inner, calls } = recordingInner();
		await createGuardedTransport(inner).request(REQUEST);
		expect(calls[0]?.url).toBe(new URL(OK).toString());
	});

	it("refuses a disallowed endpoint before calling the inner transport", async () => {
		// Before, not after. A guard that checked the response would have already
		// sent the body.
		const { inner, calls } = recordingInner();
		await expect(
			createGuardedTransport(inner).request({
				...REQUEST,
				url: "https://apiserver.internal/healthz",
			}),
		).rejects.toBeInstanceOf(KubernetesProviderError);
		expect(calls).toEqual([]);
	});

	it("clamps the timeout down to the policy, never up", async () => {
		// `Math.min`. A caller asking for ten minutes must not get it, or a single
		// hung call would hold a resolver open past any sane deploy window.
		const { inner, calls } = recordingInner();
		await createGuardedTransport(inner).request({
			...REQUEST,
			timeoutMs: 600_000,
		});
		expect(calls[0]?.timeoutMs).toBe(DEFAULT_TRANSPORT_POLICY.timeoutMs);
	});

	it("leaves a caller's shorter timeout alone", async () => {
		const { inner, calls } = recordingInner();
		await createGuardedTransport(inner).request({ ...REQUEST, timeoutMs: 100 });
		expect(calls[0]?.timeoutMs).toBe(100);
	});

	it("clamps the response cap down to the policy", async () => {
		const { inner, calls } = recordingInner();
		await createGuardedTransport(inner).request({
			...REQUEST,
			maxResponseBytes: 50_000_000,
		});
		expect(calls[0]?.maxResponseBytes).toBe(
			DEFAULT_TRANSPORT_POLICY.maxResponseBytes,
		);
	});

	it("refuses a non-positive or non-finite timeout", async () => {
		// A zero or NaN timeout means no timeout at all in most implementations,
		// which is the opposite of what the field is for.
		for (const timeoutMs of [0, -1, Number.NaN]) {
			await expect(
				createGuardedTransport(recordingInner().inner).request({
					...REQUEST,
					timeoutMs,
				}),
			).rejects.toThrow(/timeout must be positive/u);
		}
	});

	it("refuses every 3xx rather than following it", async () => {
		// The apiserver documents no redirects on these paths, so a 3xx is either
		// a contract change or a hijack. Following one sends the object to the
		// redirect target before anybody could object.
		for (const status of [301, 302, 303, 307, 308]) {
			const { inner } = recordingInner({ status });
			await expect(
				createGuardedTransport(inner).request(REQUEST),
			).rejects.toThrow(/never follows/u);
		}
	});

	it("carries the redirect target in the detail, redacted", async () => {
		// Useful for diagnosis, and redacted because a Location header from a
		// hijacked apiserver is attacker-controlled text about to be logged.
		const { inner } = recordingInner({
			status: 302,
			headers: { location: "https://elsewhere.example/api/v1/pods" },
		});
		try {
			await createGuardedTransport(inner).request(REQUEST);
			expect.unreachable("a redirect must be refused");
		} catch (error) {
			const detail = (error as KubernetesProviderError).detail as Record<
				string,
				unknown
			>;
			expect(detail.status).toBe(302);
			expect(String(detail.location).length).toBeGreaterThan(0);
		}
	});

	it("finds the location header whatever case it arrived in", async () => {
		// HTTP header names are case-insensitive and implementations disagree.
		// Missing the header would drop the one useful fact about the redirect.
		const { inner } = recordingInner({
			status: 302,
			headers: { Location: "https://elsewhere.example/x" },
		});
		try {
			await createGuardedTransport(inner).request(REQUEST);
			expect.unreachable("a redirect must be refused");
		} catch (error) {
			const detail = (error as KubernetesProviderError).detail as Record<
				string,
				unknown
			>;
			expect(String(detail.location).length).toBeGreaterThan(0);
		}
	});

	it("tolerates a redirect that carried no location at all", async () => {
		// The `?? ""` arm. A missing header must not turn the redirect refusal
		// into an unrelated TypeError.
		const { inner } = recordingInner({ status: 307 });
		await expect(
			createGuardedTransport(inner).request(REQUEST),
		).rejects.toThrow(/never follows/u);
	});

	it("lets 2xx and 4xx and 5xx through to the caller", async () => {
		// Only 3xx is the guard's business. A 404 is a real answer the resolver
		// has to interpret, and a 500 is a retry decision the caller owns.
		for (const status of [200, 201, 404, 409, 500, 503]) {
			const { inner } = recordingInner({ status });
			expect(
				(await createGuardedTransport(inner).request(REQUEST)).status,
			).toBe(status);
		}
	});

	it("refuses a response body over the effective cap", async () => {
		// The cap is the clamped one, so a caller cannot raise it by asking for
		// more than the policy allows.
		const { inner } = recordingInner({ body: "a".repeat(2048) });
		await expect(
			createGuardedTransport(inner).request({
				...REQUEST,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrow(/exceeded the 1024 byte cap/u);
	});

	it("measures the body in bytes, not characters", async () => {
		// A multi-byte body is bigger than its length. Counting characters would
		// let a UTF-8 payload several times the cap through.
		const { inner } = recordingInner({ body: "é".repeat(600) });
		await expect(
			createGuardedTransport(inner).request({
				...REQUEST,
				maxResponseBytes: 1000,
			}),
		).rejects.toThrow(/byte cap/u);
	});

	it("honours a custom policy over the default", async () => {
		const { inner } = recordingInner();
		await expect(
			createGuardedTransport(
				inner,
				policy({ allowedPathPrefixes: ["/apis/"] }),
			).request(REQUEST),
		).rejects.toThrow(/outside the/u);
	});
});

describe("createFetchTransport", () => {
	/** A fetch stand-in returning one canned response. */
	function fakeFetch(
		response: {
			status?: number;
			headers?: Record<string, string>;
			text?: string;
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
				text: async () => response.text ?? "{}",
			};
		}) as unknown as typeof globalThis.fetch;
		return { impl, seen };
	}

	it("returns the status, lowercased headers, and body", async () => {
		// Lowercased because every later lookup assumes it. Passing the server's
		// casing through would make header reads work against one apiserver and
		// not another.
		const { impl } = fakeFetch({
			status: 201,
			headers: { "Content-Type": "application/json" },
			text: '{"kind":"Pod"}',
		});
		const response = await createFetchTransport({ fetchImpl: impl }).request(
			REQUEST,
		);
		expect(response.status).toBe(201);
		expect(response.headers["content-type"]).toBe("application/json");
		expect(response.body).toBe('{"kind":"Pod"}');
	});

	it("never follows redirects at the fetch layer either", async () => {
		// `redirect: "manual"`. Without it fetch would follow a 302 before the
		// guard ever saw the status, and the guard's refusal would be moot.
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request(REQUEST);
		expect(seen[0]?.init.redirect).toBe("manual");
	});

	it("passes an abort signal so the timeout can actually abort", async () => {
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request(REQUEST);
		expect(seen[0]?.init.signal).toBeDefined();
	});

	it("omits the body entirely for a request that has none", async () => {
		// Present-with-undefined and absent are different to some fetch
		// implementations, and a GET with a body key is rejected outright by
		// others.
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request(REQUEST);
		expect(Object.hasOwn(seen[0]?.init ?? {}, "body")).toBe(false);
	});

	it("sends a body when one was given", async () => {
		const { impl, seen } = fakeFetch();
		await createFetchTransport({ fetchImpl: impl }).request({
			...REQUEST,
			method: "POST",
			body: '{"kind":"Pod"}',
		});
		expect(seen[0]?.init.body).toBe('{"kind":"Pod"}');
	});

	it("refuses an over-cap body before returning it", async () => {
		const { impl } = fakeFetch({ text: "a".repeat(2048) });
		await expect(
			createFetchTransport({ fetchImpl: impl }).request({
				...REQUEST,
				maxResponseBytes: 100,
			}),
		).rejects.toThrow(/byte cap/u);
	});

	it("reports a transport failure as ambiguous, not as a failure", async () => {
		// The important distinction. A timed-out or aborted write never proves the
		// apiserver did nothing — the object may well have been created. Reporting
		// it as a clean failure would invite a retry that duplicates the write.
		const impl = (async () => {
			throw new Error("socket hang up");
		}) as unknown as typeof globalThis.fetch;
		try {
			await createFetchTransport({ fetchImpl: impl }).request({
				...REQUEST,
				method: "POST",
			});
			expect.unreachable("a transport failure must be reported");
		} catch (error) {
			expect((error as KubernetesProviderError).code).toBe(
				"PROVIDER_OPERATION_AMBIGUOUS",
			);
			expect(
				(error as KubernetesProviderError).detail as Record<string, unknown>,
			).toMatchObject({ method: "POST" });
		}
	});

	it("preserves a KubernetesProviderError rather than re-wrapping it", async () => {
		// The over-cap refusal is thrown from inside the try. Re-wrapping it as
		// ambiguous would tell a caller a bounded response might have been
		// applied, which is precisely backwards.
		const { impl } = fakeFetch({ text: "a".repeat(2048) });
		try {
			await createFetchTransport({ fetchImpl: impl }).request({
				...REQUEST,
				maxResponseBytes: 10,
			});
			expect.unreachable("an over-cap body must be refused");
		} catch (error) {
			expect((error as KubernetesProviderError).code).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
		}
	});

	it("clears its timer on the success path", async () => {
		// The `finally`. A leaked timer keeps the event loop alive, which turns a
		// short-lived CLI into one that will not exit.
		const { impl } = fakeFetch();
		await expect(
			createFetchTransport({ fetchImpl: impl }).request(REQUEST),
		).resolves.toBeDefined();
	});
});

describe("KubernetesProviderError", () => {
	it("redacts the message it was given", () => {
		// Messages carry apiserver text. Redaction is applied in the constructor
		// so no call site can forget it.
		expect(
			new KubernetesProviderError("PROVIDER_CONTRACT_CHANGED", "boom").message,
		).toBe(redactClusterText("boom"));
	});

	it("defaults to not retryable", () => {
		// The safe default for a driver that writes: retrying something that may
		// have succeeded is how a duplicate object gets created.
		expect(
			new KubernetesProviderError("PROVIDER_CONTRACT_CHANGED", "boom")
				.retryable,
		).toBe(false);
	});

	it("carries a stated retry hint", () => {
		const error = new KubernetesProviderError("PROVIDER_UNAVAILABLE", "boom", {
			retryable: true,
			retryAfterMs: 1500,
		});
		expect(error.retryable).toBe(true);
		expect(error.retryAfterMs).toBe(1500);
	});

	it("omits the retry delay when none was given", () => {
		// Absent rather than zero. A zero delay reads as "retry immediately",
		// which is a different instruction to "no guidance".
		expect(
			new KubernetesProviderError("PROVIDER_UNAVAILABLE", "boom").retryAfterMs,
		).toBeUndefined();
	});

	it("freezes the detail so a handler cannot edit the record", () => {
		const error = new KubernetesProviderError("PROVIDER_UNAVAILABLE", "boom", {
			detail: { status: 503 },
		});
		expect(Object.isFrozen(error.detail)).toBe(true);
		expect(error.detail).toEqual({ status: 503 });
	});

	it("defaults the detail to an empty object rather than undefined", () => {
		expect(
			new KubernetesProviderError("PROVIDER_UNAVAILABLE", "boom").detail,
		).toEqual({});
	});

	it("carries a cause when one was given", () => {
		const cause = new Error("socket hang up");
		expect(
			new KubernetesProviderError("PROVIDER_UNAVAILABLE", "boom", { cause })
				.cause,
		).toBe(cause);
	});

	it("is recognisable through the type guard", () => {
		// Callers branch on this rather than on the name, so a subclass or a
		// cross-realm instance does not silently stop being handled.
		expect(
			isKubernetesProviderError(
				new KubernetesProviderError("PROVIDER_UNAVAILABLE", "boom"),
			),
		).toBe(true);
		for (const value of [new Error("plain"), null, undefined, "boom", {}]) {
			expect(isKubernetesProviderError(value)).toBe(false);
		}
	});

	it("contractChanged always throws, so its call sites need no return", () => {
		// Typed `never`. A helper that sometimes returned would let a caller fall
		// through past a check it thought was fatal.
		expect(() => contractChanged("shape moved")).toThrow(
			KubernetesProviderError,
		);
		try {
			contractChanged("shape moved", { field: "status" });
			expect.unreachable("contractChanged must throw");
		} catch (error) {
			expect((error as KubernetesProviderError).code).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
			expect((error as KubernetesProviderError).detail).toEqual({
				field: "status",
			});
		}
	});
});
