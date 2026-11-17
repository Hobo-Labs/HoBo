import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	guardTransport,
	TRANSPORT_GUARD_ERROR_CODES,
	TRANSPORT_METHODS,
	TransportGuardError,
	type TransportGuardPolicy,
	type TransportRequest,
} from "../src/index.js";

const SEED = 20260817;
const RUNS = 300;

const POLICY: TransportGuardPolicy = Object.freeze({
	allowedHosts: Object.freeze(["api.example.com", "api.vendor.test"]),
	allowedPathPrefixes: Object.freeze(["/v1/", "/v2/"]),
	maxTimeoutMs: 5_000,
	maxResponseBytes: 65_536,
});

function makeSpy() {
	const calls: TransportRequest[] = [];
	return {
		calls,
		transport: async (request) => {
			calls.push(request);
			return { status: 200, headers: {}, body: "ok" };
		},
	};
}

const segmentArb = fc.stringMatching(/^[a-z]{1,6}$/u);

const hostileHostArb = fc
	.tuple(
		segmentArb,
		fc.constantFrom(
			"subdomain",
			"suffix",
			"trailingDot",
			"port",
			"userinfo",
			"userinfoAsHost",
			"unicode",
			"ipv4",
			"ipv6",
			"ipDecimal",
			"ipHex",
			"unrelated",
		),
	)
	.map(([label, layout]) => {
		switch (layout) {
			case "subdomain":
				return `${label}.api.example.com`;
			case "suffix":
				return `api.example.com.${label}.test`;
			case "trailingDot":
				return "api.example.com.";
			case "port":
				return "api.example.com:8443";
			case "userinfo":
				return `${label}:pw@api.example.com`;
			case "userinfoAsHost":
				return `api.example.com@${label}.evil.test`;
			case "unicode":
				return "api.exämple.com";
			case "ipv4":
				return "127.0.0.1";
			case "ipv6":
				return "[::1]";
			case "ipDecimal":
				return "2130706433";
			case "ipHex":
				return "0x7f.0.0.1";
			default:
				return `${label}.evil.test`;
		}
	});

const allowedHostArb = fc.constantFrom(
	"api.example.com",
	"API.Example.COM",
	"api.vendor.test",
	"api.example.com:443",
);

const hostilePathArb = fc
	.tuple(
		segmentArb,
		fc.constantFrom(
			"outside",
			"prefixLookalike",
			"dotDot",
			"encodedDotDot",
			"encodedSlash",
			"encodedDotInSegment",
			"backslash",
			"encodedBackslash",
			"root",
			"empty",
			"prefixWithoutSlash",
		),
	)
	.map(([segment, layout]) => {
		switch (layout) {
			case "outside":
				return `/admin/${segment}`;
			case "prefixLookalike":
				return `/v1x/${segment}`;
			case "dotDot":
				return `/v1/../admin/${segment}`;
			case "encodedDotDot":
				return `/v1/%2e%2e/admin/${segment}`;
			case "encodedSlash":
				return `/v1/..%2fadmin${segment}`;
			case "encodedDotInSegment":
				return `/v1/${segment}%2e%2e/x`;
			case "backslash":
				return `/v1\\..\\admin\\${segment}`;
			case "encodedBackslash":
				return `/v1/%5c${segment}`;
			case "root":
				return "/";
			case "empty":
				return "";
			default:
				return "/v1";
		}
	});

const allowedPathArb = fc
	.tuple(segmentArb, fc.constantFrom("plain", "nested", "query", "fragment"))
	.map(([segment, layout]) => {
		switch (layout) {
			case "nested":
				return `/v2/${segment}/${segment}`;
			case "query":
				return `/v1/${segment}?q=${segment}`;
			case "fragment":
				return `/v1/${segment}#${segment}`;
			default:
				return `/v1/${segment}`;
		}
	});

function requestOf(url: string, overrides: Partial<TransportRequest> = {}) {
	return {
		method: "GET" as const,
		url,
		headers: { authorization: "Bearer provider-token" },
		timeoutMs: 1_000,
		maxResponseBytes: 1_024,
		...overrides,
	};
}

async function refusalOf(
	call: () => Promise<JsonValue>,
): Promise<{ code: string; message: string; instance: boolean }> {
	try {
		await call();
		return { code: "NO_THROW", message: "", instance: false };
	} catch (error) {
		const failure = error as { code?: string; message?: string };
		return {
			code: failure.code ?? "NO_CODE",
			message: failure.message ?? "",
			instance: error instanceof TransportGuardError,
		};
	}
}

function expectRefusal(
	refusal: { code: string; message: string; instance: boolean },
	code: string,
): void {
	expect(refusal.instance).toBe(true);
	expect(refusal.code).toBe(code);
	expect(refusal.message.length).toBeGreaterThan(0);
}

describe("guardTransport never reaches an origin the policy forbids", () => {
	it("never invokes the inner transport for a host off the allowlist", async () => {
		await fc.assert(
			fc.asyncProperty(hostileHostArb, segmentArb, async (host, segment) => {
				const spy = makeSpy();
				const guarded = guardTransport(spy.transport, POLICY);
				const refusal = await refusalOf(() =>
					guarded(requestOf(`https://${host}/v1/${segment}`)),
				);
				expect(spy.calls).toHaveLength(0);
				expect(refusal.instance).toBe(true);
				expect(refusal.message.length).toBeGreaterThan(0);
				expect([
					"TRANSPORT_HOST_FORBIDDEN",
					"TRANSPORT_SCHEME_FORBIDDEN",
				]).toContain(refusal.code);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("never invokes the inner transport for a path outside the prefixes", async () => {
		await fc.assert(
			fc.asyncProperty(hostilePathArb, async (path) => {
				const spy = makeSpy();
				const guarded = guardTransport(spy.transport, POLICY);
				const refusal = await refusalOf(() =>
					guarded(requestOf(`https://api.example.com${path}`)),
				);
				expect(spy.calls).toHaveLength(0);
				expectRefusal(refusal, "TRANSPORT_PATH_FORBIDDEN");
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("refuses every non-https scheme", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom("http", "ftp", "ws", "wss", "file", "gopher"),
				segmentArb,
				async (scheme, segment) => {
					const spy = makeSpy();
					const guarded = guardTransport(spy.transport, POLICY);
					const refusal = await refusalOf(() =>
						guarded(requestOf(`${scheme}://api.example.com/v1/${segment}`)),
					);
					expect(spy.calls).toHaveLength(0);
					expectRefusal(refusal, "TRANSPORT_SCHEME_FORBIDDEN");
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("refuses rather than clamps a timeout over the policy cap", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.integer({ min: POLICY.maxTimeoutMs + 1, max: 2 ** 40 }),
					fc.constantFrom(
						Number.POSITIVE_INFINITY,
						Number.MAX_VALUE,
						Number.NaN,
						0,
						-1,
					),
				),
				segmentArb,
				async (timeoutMs, segment) => {
					const spy = makeSpy();
					const guarded = guardTransport(spy.transport, POLICY);
					const refusal = await refusalOf(() =>
						guarded(
							requestOf(`https://api.example.com/v1/${segment}`, {
								timeoutMs,
							}),
						),
					);
					expect(spy.calls).toHaveLength(0);
					expectRefusal(refusal, "TRANSPORT_TIMEOUT_EXCEEDED");
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("refuses rather than clamps a response cap over the policy cap", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.integer({ min: POLICY.maxResponseBytes + 1, max: 2 ** 40 }),
					fc.constantFrom(
						Number.POSITIVE_INFINITY,
						Number.MAX_VALUE,
						Number.NaN,
						0,
						-1,
					),
				),
				segmentArb,
				async (maxResponseBytes, segment) => {
					const spy = makeSpy();
					const guarded = guardTransport(spy.transport, POLICY);
					const refusal = await refusalOf(() =>
						guarded(
							requestOf(`https://api.example.com/v1/${segment}`, {
								maxResponseBytes,
							}),
						),
					);
					expect(spy.calls).toHaveLength(0);
					expectRefusal(refusal, "TRANSPORT_BODY_TOO_LARGE");
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("never widens: anything it accepts satisfies the whole policy", async () => {
		const urlArb = fc
			.tuple(
				fc.constantFrom("https", "http", "ftp"),
				fc.oneof(allowedHostArb, hostileHostArb),
				fc.oneof(allowedPathArb, hostilePathArb),
			)
			.map(([scheme, host, path]) => `${scheme}://${host}${path}`);
		let acceptedCount = 0;

		await fc.assert(
			fc.asyncProperty(
				urlArb,
				fc.constantFrom(...TRANSPORT_METHODS),
				fc.oneof(
					fc.integer({ min: 1, max: POLICY.maxTimeoutMs }),
					fc.integer({ min: 1, max: 2 ** 20 }),
				),
				fc.oneof(
					fc.integer({ min: 1, max: POLICY.maxResponseBytes }),
					fc.integer({ min: 1, max: 2 ** 24 }),
				),
				async (url, method, timeoutMs, maxResponseBytes) => {
					const spy = makeSpy();
					const guarded = guardTransport(spy.transport, POLICY);
					const request = requestOf(url, {
						method,
						timeoutMs,
						maxResponseBytes,
					});
					let accepted = true;
					try {
						await guarded(request);
					} catch (error) {
						accepted = false;
						expect(error).toBeInstanceOf(TransportGuardError);
						const failure = error as TransportGuardError;
						expect(TRANSPORT_GUARD_ERROR_CODES).toContain(failure.code);
						expect(failure.message.length).toBeGreaterThan(0);
					}
					if (!accepted) {
						expect(spy.calls).toHaveLength(0);
						return;
					}
					acceptedCount += 1;
					expect(spy.calls).toHaveLength(1);
					for (const candidate of [request.url, spy.calls[0]?.url ?? ""]) {
						const parsed = new URL(candidate);
						expect(parsed.protocol).toBe("https:");
						expect(parsed.username).toBe("");
						expect(parsed.password).toBe("");
						expect(POLICY.allowedHosts).toContain(parsed.hostname);
						expect(
							POLICY.allowedPathPrefixes.some((prefix) =>
								parsed.pathname.startsWith(prefix),
							),
						).toBe(true);
					}
					expect(timeoutMs).toBeLessThanOrEqual(POLICY.maxTimeoutMs);
					expect(maxResponseBytes).toBeLessThanOrEqual(POLICY.maxResponseBytes);
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
		expect(acceptedCount).toBeGreaterThan(0);
	});
});

const brokenCapArb = fc.oneof(
	fc.constantFrom(
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	),
	fc.integer({ min: -(2 ** 31), max: 0 }),
	fc.constantFrom("5000", null, undefined, {}).map((value) => value as never),
);

describe("guardTransport screens its own policy", () => {
	it("refuses every request under a malformed timeout cap", async () => {
		await fc.assert(
			fc.asyncProperty(brokenCapArb, segmentArb, async (cap, segment) => {
				const spy = makeSpy();
				const guarded = guardTransport(spy.transport, {
					...POLICY,
					maxTimeoutMs: cap as number,
				});
				const refusal = await refusalOf(() =>
					guarded(requestOf(`https://api.example.com/v1/${segment}`)),
				);
				expect(spy.calls).toHaveLength(0);
				expectRefusal(refusal, "TRANSPORT_TIMEOUT_EXCEEDED");
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("refuses every request under a malformed response cap", async () => {
		await fc.assert(
			fc.asyncProperty(brokenCapArb, segmentArb, async (cap, segment) => {
				const spy = makeSpy();
				const guarded = guardTransport(spy.transport, {
					...POLICY,
					maxResponseBytes: cap as number,
				});
				const refusal = await refusalOf(() =>
					guarded(requestOf(`https://api.example.com/v1/${segment}`)),
				);
				expect(spy.calls).toHaveLength(0);
				expectRefusal(refusal, "TRANSPORT_BODY_TOO_LARGE");
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("fails closed on an empty allowlist rather than allowing everything", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom("hosts", "paths"),
				allowedHostArb,
				allowedPathArb,
				async (emptied, host, path) => {
					const spy = makeSpy();
					const guarded = guardTransport(spy.transport, {
						...POLICY,
						...(emptied === "hosts"
							? { allowedHosts: [] }
							: { allowedPathPrefixes: [] }),
					});
					const refusal = await refusalOf(() =>
						guarded(requestOf(`https://${host}${path}`)),
					);
					expect(spy.calls).toHaveLength(0);
					expectRefusal(
						refusal,
						emptied === "hosts"
							? "TRANSPORT_HOST_FORBIDDEN"
							: "TRANSPORT_PATH_FORBIDDEN",
					);
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});
});

describe("the response cap counts UTF-8 bytes exactly", () => {
	const bodyArb = fc.oneof(
		fc.string(),
		fc.string({ unit: "binary" }),
		fc.string({ unit: "grapheme" }),
		fc.constantFrom(
			"\ud800",
			"\udc00",
			"😀",
			"é",
			"漢字",
			"a\ud800b",
			"😀\ud800",
		),
		fc
			.array(
				fc.constantFrom(
					"a",
					"é",
					"漢",
					"😀",
					"\ud800",
					"\udfff",
					"\u07ff",
					"\u0800",
				),
				{ maxLength: 12 },
			)
			.map((parts) => parts.join("")),
	);

	function transportReturning(body: string) {
		const calls: TransportRequest[] = [];
		return {
			calls,
			transport: async (request) => {
				calls.push(request);
				return { status: 200, headers: {}, body };
			},
		};
	}

	it("accepts a body at exactly its byte length and refuses one byte under", async () => {
		await fc.assert(
			fc.asyncProperty(bodyArb, async (body) => {
				const bytes = Buffer.byteLength(body, "utf8");
				const policy: TransportGuardPolicy = {
					...POLICY,
					maxResponseBytes: 10_000_000,
				};
				const exact = transportReturning(body);
				const atLimit = guardTransport(exact.transport, policy);
				await expect(
					atLimit(
						requestOf("https://api.example.com/v1/x", {
							maxResponseBytes: Math.max(bytes, 1),
						}),
					),
				).resolves.toMatchObject({ status: 200 });

				if (bytes < 2) return;
				const under = transportReturning(body);
				const belowLimit = guardTransport(under.transport, policy);
				const refusal = await refusalOf(() =>
					belowLimit(
						requestOf("https://api.example.com/v1/x", {
							maxResponseBytes: bytes - 1,
						}),
					),
				);
				expectRefusal(refusal, "TRANSPORT_BODY_TOO_LARGE");
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("refuses a body whose declared content-length is over the cap", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 4_096 }),
				fc.integer({ min: 1, max: 4_096 }),
				async (cap, over) => {
					const calls: TransportRequest[] = [];
					const guarded = guardTransport(
						async (request) => {
							calls.push(request);
							return {
								status: 200,
								headers: { "Content-Length": String(cap + over) },
								body: "",
							};
						},
						{ ...POLICY, maxResponseBytes: 1_000_000 },
					);
					const refusal = await refusalOf(() =>
						guarded(
							requestOf("https://api.example.com/v1/x", {
								maxResponseBytes: cap,
							}),
						),
					);
					expect(calls).toHaveLength(1);
					expectRefusal(refusal, "TRANSPORT_BODY_TOO_LARGE");
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});
});
