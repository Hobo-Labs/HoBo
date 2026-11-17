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

function recordingInner(response: Partial<TransportResponse> = {}) {
	const calls: Array<Parameters<KubernetesTransport["request"]>[0]> = [];
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

function codeOf(run: () => URL): string {
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
		expect(DEFAULT_TRANSPORT_POLICY.allowedPathPrefixes).toEqual([
			"/api/v1/",
			"/apis/apps/v1/",
		]);
	});

	it("refuses cleartext by default", () => {
		expect(DEFAULT_TRANSPORT_POLICY.allowInsecureLoopback).toBe(false);
	});

	it("bounds the body and the wait", () => {
		expect(DEFAULT_TRANSPORT_POLICY.maxResponseBytes).toBe(512 * 1024);
		expect(DEFAULT_TRANSPORT_POLICY.timeoutMs).toBe(30_000);
	});
});

describe("assertAllowedEndpoint", () => {
	it("returns the parsed URL, so a caller cannot reuse the unchecked string", () => {
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
		const url = "http://127.0.0.1:8001/api/v1/namespaces/default/pods";
		expect(() =>
			assertAllowedEndpoint(url, policy({ allowInsecureLoopback: true })),
		).not.toThrow();
		expect(codeOf(() => assertAllowedEndpoint(url, policy()))).toBe(
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("recognises every spelling of loopback", () => {
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
		const { inner, calls } = recordingInner();
		await createGuardedTransport(inner).request(REQUEST);
		expect(calls[0]?.url).toBe(new URL(OK).toString());
	});

	it("refuses a disallowed endpoint before calling the inner transport", async () => {
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
		for (const status of [301, 302, 303, 307, 308]) {
			const { inner } = recordingInner({ status });
			await expect(
				createGuardedTransport(inner).request(REQUEST),
			).rejects.toThrow(/never follows/u);
		}
	});

	it("carries the redirect target in the detail, redacted", async () => {
		const { inner } = recordingInner({
			status: 302,
			headers: { location: "https://elsewhere.example/api/v1/pods" },
		});
		try {
			await createGuardedTransport(inner).request(REQUEST);
			expect.unreachable("a redirect must be refused");
		} catch (error) {
			const detail = (error as KubernetesProviderError).detail;
			expect(detail.status).toBe(302);
			expect(String(detail.location).length).toBeGreaterThan(0);
		}
	});

	it("finds the location header whatever case it arrived in", async () => {
		const { inner } = recordingInner({
			status: 302,
			headers: { Location: "https://elsewhere.example/x" },
		});
		try {
			await createGuardedTransport(inner).request(REQUEST);
			expect.unreachable("a redirect must be refused");
		} catch (error) {
			const detail = (error as KubernetesProviderError).detail;
			expect(String(detail.location).length).toBeGreaterThan(0);
		}
	});

	it("tolerates a redirect that carried no location at all", async () => {
		const { inner } = recordingInner({ status: 307 });
		await expect(
			createGuardedTransport(inner).request(REQUEST),
		).rejects.toThrow(/never follows/u);
	});

	it("lets 2xx and 4xx and 5xx through to the caller", async () => {
		for (const status of [200, 201, 404, 409, 500, 503]) {
			const { inner } = recordingInner({ status });
			expect(
				(await createGuardedTransport(inner).request(REQUEST)).status,
			).toBe(status);
		}
	});

	it("refuses a response body over the effective cap", async () => {
		const { inner } = recordingInner({ body: "a".repeat(2048) });
		await expect(
			createGuardedTransport(inner).request({
				...REQUEST,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrow(/exceeded the 1024 byte cap/u);
	});

	it("measures the body in bytes, not characters", async () => {
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
	function fakeFetch(
		response: {
			status?: number;
			headers?: Record<string, string>;
			text?: string;
		} = {},
	) {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const impl: typeof globalThis.fetch = async (url, init) => {
			seen.push({
				url: url instanceof Request ? url.url : String(url),
				init: init ?? {},
			});
			return new Response(response.text ?? "{}", {
				status: response.status ?? 200,
				headers: response.headers,
			});
		};
		return { impl, seen };
	}

	it("returns the status, lowercased headers, and body", async () => {
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
		const impl: typeof globalThis.fetch = async () => {
			throw new Error("socket hang up");
		};
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
			expect((error as KubernetesProviderError).detail).toMatchObject({
				method: "POST",
			});
		}
	});

	it("preserves a KubernetesProviderError rather than re-wrapping it", async () => {
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
		const { impl } = fakeFetch();
		await expect(
			createFetchTransport({ fetchImpl: impl }).request(REQUEST),
		).resolves.toBeDefined();
	});
});

describe("KubernetesProviderError", () => {
	it("redacts the message it was given", () => {
		expect(
			new KubernetesProviderError("PROVIDER_CONTRACT_CHANGED", "boom").message,
		).toBe(redactClusterText("boom"));
	});

	it("defaults to not retryable", () => {
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
