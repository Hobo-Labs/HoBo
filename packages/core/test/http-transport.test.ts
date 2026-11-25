// The credentialed HTTPS boundary the direct-provider-API deploy path runs
// over. The cases below pin every one of the six refusals, because each is a
// way a single bad config value could send a provider token to an origin
// nobody allowlisted, plus the two normalization decisions that are easy to
// get wrong in the other direction: WHATWG case folding of the request host
// is fine, case folding the policy is not, and a percent-encoded dot segment
// is refused rather than decoded.
import { describe, expect, it } from "vitest";

import {
	assertAllowedEndpoint,
	guardTransport,
	TRANSPORT_GUARD_ERROR_CODES,
	TRANSPORT_METHODS,
	TransportGuardError,
	type TransportGuardPolicy,
	type TransportRequest,
	type TransportResponse,
} from "../src/index.js";

const policy: TransportGuardPolicy = {
	allowedHosts: ["api.example.com"],
	allowedPathPrefixes: ["/v1/", "/v9/projects/"],
	maxTimeoutMs: 15_000,
	maxResponseBytes: 1_024,
};

function request(overrides: Partial<TransportRequest> = {}): TransportRequest {
	return {
		method: "GET",
		url: "https://api.example.com/v1/projects",
		headers: { authorization: "Bearer sponsor-token" },
		timeoutMs: 5_000,
		maxResponseBytes: 512,
		...overrides,
	};
}

function reply(overrides: Partial<TransportResponse> = {}): TransportResponse {
	return { status: 200, headers: {}, body: "{}", ...overrides };
}

function stub(response: TransportResponse = reply()) {
	const calls: TransportRequest[] = [];
	return {
		calls,
		transport: async (sent) => {
			calls.push(sent);
			return response;
		},
	};
}

async function codeOf(run: () => Promise<JsonValue>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof TransportGuardError) return error.code;
		throw error;
	}
	throw new Error("expected the guarded transport to refuse");
}

describe("transport vocabularies", () => {
	it("expose the closed method set, frozen", () => {
		expect([...TRANSPORT_METHODS]).toEqual([
			"GET",
			"HEAD",
			"POST",
			"PUT",
			"PATCH",
			"DELETE",
		]);
		expect(Object.isFrozen(TRANSPORT_METHODS)).toBe(true);
	});

	it("expose every refusal code, frozen", () => {
		expect([...TRANSPORT_GUARD_ERROR_CODES]).toEqual([
			"TRANSPORT_SCHEME_FORBIDDEN",
			"TRANSPORT_HOST_FORBIDDEN",
			"TRANSPORT_PATH_FORBIDDEN",
			"TRANSPORT_TIMEOUT_EXCEEDED",
			"TRANSPORT_BODY_TOO_LARGE",
			"TRANSPORT_REDIRECT_REFUSED",
		]);
		expect(Object.isFrozen(TRANSPORT_GUARD_ERROR_CODES)).toBe(true);
	});
});

describe("guardTransport happy path", () => {
	it("forwards an allowlisted request unchanged and returns the reply", async () => {
		const { transport, calls } = stub(reply({ body: '{"id":"prj_1"}' }));
		const guarded = guardTransport(transport, policy);

		const response = await guarded(request());

		expect(response.body).toBe('{"id":"prj_1"}');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.example.com/v1/projects");
		expect(calls[0]?.headers.authorization).toBe("Bearer sponsor-token");
	});

	it("accepts a request host that differs from the policy only by case, because WHATWG parsing normalizes the authority", async () => {
		const { transport, calls } = stub();
		const guarded = guardTransport(transport, policy);

		await guarded(request({ url: "https://API.Example.COM/v1/projects" }));

		expect(calls[0]?.url).toBe("https://api.example.com/v1/projects");
	});

	it("passes a 3xx without a Location through, because a 304 is a cache answer and not a redirect", async () => {
		const { transport } = stub(reply({ status: 304, body: "" }));
		const guarded = guardTransport(transport, policy);

		await expect(guarded(request())).resolves.toMatchObject({ status: 304 });
	});
});

describe("guardTransport refusals", () => {
	it.each([
		["http://api.example.com/v1/x", "plain http is never a provider origin"],
		["ftp://api.example.com/v1/x", "a non-web scheme"],
		["/v1/relative", "a relative url has no verified origin"],
		["", "an empty url"],
	])("refuses %s on the scheme (%s)", async (url) => {
		const guarded = guardTransport(stub().transport, policy);
		await expect(codeOf(() => guarded(request({ url })))).resolves.toBe(
			"TRANSPORT_SCHEME_FORBIDDEN",
		);
	});

	it.each([
		["https://evil.example.com/v1/x", "a host outside the allowlist"],
		["https://api.example.com.evil.test/v1/x", "a suffix-extended lookalike"],
		["https://api.example.com./v1/x", "a trailing-dot absolute name"],
		["https://api.example.com@evil.test/v1/x", "userinfo hiding the real host"],
		["https://api.example.com:8443/v1/x", "a non-default port"],
	])("refuses %s on the host (%s)", async (url) => {
		const guarded = guardTransport(stub().transport, policy);
		await expect(codeOf(() => guarded(request({ url })))).resolves.toBe(
			"TRANSPORT_HOST_FORBIDDEN",
		);
	});

	it("refuses a policy host that differs only by case, rather than repairing the config", async () => {
		const guarded = guardTransport(stub().transport, {
			...policy,
			allowedHosts: ["API.Example.com"],
		});

		await expect(codeOf(() => guarded(request()))).resolves.toBe(
			"TRANSPORT_HOST_FORBIDDEN",
		);
	});

	it.each([
		["https://api.example.com/admin", "a path outside every prefix"],
		["https://api.example.com/v1/../admin", "a resolved .. escape"],
		["https://api.example.com/v1/%2e%2e/admin", "an encoded .. escape"],
		["https://api.example.com/v1/a%2fb/../../admin", "an encoded separator"],
	])("refuses %s on the path (%s)", async (url) => {
		const guarded = guardTransport(stub().transport, policy);
		await expect(codeOf(() => guarded(request({ url })))).resolves.toBe(
			"TRANSPORT_PATH_FORBIDDEN",
		);
	});

	it.each([
		[15_001, "one millisecond over the cap"],
		[Number.POSITIVE_INFINITY, "an infinite timeout"],
		[0, "a zero timeout"],
		[-1, "a negative timeout"],
	])("refuses timeoutMs %s (%s)", async (timeoutMs) => {
		const guarded = guardTransport(stub().transport, policy);
		await expect(codeOf(() => guarded(request({ timeoutMs })))).resolves.toBe(
			"TRANSPORT_TIMEOUT_EXCEEDED",
		);
	});

	it("never reaches the inner transport when the timeout is over cap", async () => {
		const { transport, calls } = stub();
		const guarded = guardTransport(transport, policy);

		await expect(
			guarded(request({ timeoutMs: 60_000 })),
		).rejects.toBeInstanceOf(TransportGuardError);
		expect(calls).toHaveLength(0);
	});

	it("refuses a request asking for a larger body than the policy cap", async () => {
		const guarded = guardTransport(stub().transport, policy);
		await expect(
			codeOf(() => guarded(request({ maxResponseBytes: 4_096 }))),
		).resolves.toBe("TRANSPORT_BODY_TOO_LARGE");
	});

	it("refuses an oversize response body", async () => {
		const guarded = guardTransport(
			stub(reply({ body: "x".repeat(513) })).transport,
			policy,
		);
		await expect(codeOf(() => guarded(request()))).resolves.toBe(
			"TRANSPORT_BODY_TOO_LARGE",
		);
	});

	it("counts utf-8 bytes rather than code units, so a multibyte body cannot slip under the cap", async () => {
		// 200 four-byte code points = 800 bytes, but only 400 UTF-16 units.
		const guarded = guardTransport(
			stub(reply({ body: "\u{1f600}".repeat(200) })).transport,
			policy,
		);
		await expect(
			codeOf(() => guarded(request({ maxResponseBytes: 512 }))),
		).resolves.toBe("TRANSPORT_BODY_TOO_LARGE");
	});

	it("refuses a declared content-length over the cap before reading the body", async () => {
		const guarded = guardTransport(
			stub(reply({ headers: { "Content-Length": "99999" } })).transport,
			policy,
		);
		await expect(codeOf(() => guarded(request()))).resolves.toBe(
			"TRANSPORT_BODY_TOO_LARGE",
		);
	});

	it.each([
		301, 302, 307, 308,
	])("refuses a %s carrying a Location instead of following it", async (status) => {
		const guarded = guardTransport(
			stub(reply({ status, headers: { Location: "https://evil.test/steal" } }))
				.transport,
			policy,
		);
		await expect(codeOf(() => guarded(request()))).resolves.toBe(
			"TRANSPORT_REDIRECT_REFUSED",
		);
	});

	it("never echoes the redirect target, which is attacker-controlled text", async () => {
		const guarded = guardTransport(
			stub(
				reply({
					status: 302,
					headers: { location: "https://evil.test/steal" },
				}),
			).transport,
			policy,
		);
		const error = await guarded(request()).catch((cause: unknown) => cause);

		// SAFETY: assertion required at this I/O or test boundary.
		expect((error as TransportGuardError).message).toMatch(/never follows/u);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((error as TransportGuardError).message).not.toMatch(/evil\.test/u);
	});

	it("carries the code on a TransportGuardError, named for a caller that branches on it", async () => {
		const guarded = guardTransport(stub().transport, policy);
		const error = await guarded(
			request({ url: "http://api.example.com/v1/x" }),
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(TransportGuardError);
		expect(error).toBeInstanceOf(Error);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((error as TransportGuardError).name).toBe("TransportGuardError");
		// SAFETY: assertion required at this I/O or test boundary.
		expect((error as TransportGuardError).code).toBe(
			"TRANSPORT_SCHEME_FORBIDDEN",
		);
	});

	it("refuses everything when the allowlists are empty, rather than reading empty as permissive", async () => {
		const guarded = guardTransport(stub().transport, {
			...policy,
			allowedHosts: [],
			allowedPathPrefixes: [],
		});

		await expect(codeOf(() => guarded(request()))).resolves.toBe(
			"TRANSPORT_HOST_FORBIDDEN",
		);
	});

	it("calls the injected transport exactly once and never a second origin", async () => {
		const { transport, calls } = stub();
		const guarded = guardTransport(transport, policy);

		await guarded(request());

		expect(calls).toHaveLength(1);
	});
});

/**
 * `allowedHostSuffixes` exists for one shape: a provider whose per-tenant
 * origin is minted at deploy time, so the exact host cannot be written down.
 * Upstash's data plane is the case — `<name>-<id>.upstash.io`.
 *
 * The risk it carries is that a suffix is a *weakening* of the exact-match
 * rule, so what matters is not that the happy path works but that everything
 * around it stays as strict as it was. Hence a table: the same suffix policy,
 * probed against each of the guard's other rules in turn. A suffix match must
 * not waive the scheme, the port, the userinfo ban, the path prefix, or the
 * percent-encoded-separator refusal — and it must not admit the bare parent
 * domain or a sibling that merely ends with the same letters.
 */
describe("allowedHostSuffixes", () => {
	const suffixPolicy: TransportGuardPolicy = {
		allowedHosts: ["upstash.com"],
		allowedHostSuffixes: [".upstash.io"],
		allowedPathPrefixes: ["/get/"],
		maxTimeoutMs: 15_000,
		maxResponseBytes: 1_024,
	};

	function refusalOf(
		url: string,
		p: TransportGuardPolicy,
	): TransportGuardError {
		try {
			assertAllowedEndpoint(url, p);
		} catch (error) {
			if (error instanceof TransportGuardError) return error;
			throw error;
		}
		throw new Error(`expected ${url} to be refused`);
	}

	const admitted = [
		[
			"a per-tenant host under the parent domain",
			"https://fake-mallard-000000.upstash.io/get/key",
		],
		[
			"a deeper label under the parent domain",
			"https://a.b.upstash.io/get/key",
		],
	] as const;

	for (const [label, url] of admitted) {
		it(`admits ${label}`, () => {
			expect(assertAllowedEndpoint(url, suffixPolicy).hostname).toBe(
				new URL(url).hostname,
			);
		});
	}

	/**
	 * Every row states the *specific* refusal, not merely that something threw.
	 * A row that only asserted "throws" would pass whether the suffix arm ran
	 * at all, which is the failure mode this repo has shipped before.
	 */
	const refused = [
		[
			"the bare parent domain, with no label in front of the dot",
			"https://upstash.io/get/key",
			"TRANSPORT_HOST_FORBIDDEN",
			/is not under an allowlisted parent domain \(\.upstash\.io\)$/u,
		],
		[
			"a host that is the parent domain with an empty child label",
			"https://.upstash.io/get/key",
			"TRANSPORT_HOST_FORBIDDEN",
			/^host \.upstash\.io is not exactly one of the allowlisted/u,
		],
		[
			"a host carrying a doubled dot in front of the parent domain",
			"https://..upstash.io/get/key",
			"TRANSPORT_HOST_FORBIDDEN",
			/^host \.\.upstash\.io is not exactly one of the allowlisted/u,
		],
		[
			"a sibling registration that merely ends with the same letters",
			"https://evilupstash.io/get/key",
			"TRANSPORT_HOST_FORBIDDEN",
			/^host evilupstash\.io is not exactly one of the allowlisted/u,
		],
		[
			// The end-anchoring, specifically: this host *contains*
			// `.upstash.io`, so a containment test would admit an origin the
			// attacker owns outright.
			"the parent domain appearing in the middle of an attacker's name",
			"https://db.upstash.io.evil.example/get/key",
			"TRANSPORT_HOST_FORBIDDEN",
			/^host db\.upstash\.io\.evil\.example is not exactly/u,
		],
		[
			"a name that merely begins with the parent domain",
			"https://upstash.io.evil.example/get/key",
			"TRANSPORT_HOST_FORBIDDEN",
			/^host upstash\.io\.evil\.example is not exactly/u,
		],
		[
			"cleartext to a host the suffix does match: a host rule is not a scheme waiver",
			"http://fake-mallard-000000.upstash.io/get/key",
			"TRANSPORT_SCHEME_FORBIDDEN",
			/^request url must use https, got http$/u,
		],
		[
			// The suffix rule widens which *host* is reachable and nothing else;
			// a port this policy never named is still refused. Anchored on the
			// port so it cannot pass on the generic host refusal, and on the
			// allowed set so it cannot pass if the policy silently widens.
			"a non-default port on a host the suffix does match",
			"https://fake-mallard-000000.upstash.io:8443/get/key",
			"TRANSPORT_HOST_FORBIDDEN",
			/^request url must use the default https port or one this policy allows \(443\), got 8443$/u,
		],
		[
			"userinfo on a host the suffix does match",
			"https://user:pw@fake-mallard-000000.upstash.io/get/key",
			"TRANSPORT_HOST_FORBIDDEN",
			/^request url must not embed userinfo/u,
		],
		[
			"a percent-encoded separator on a host the suffix does match",
			"https://fake-mallard-000000.upstash.io/get/%2f%2e%2e%2fadmin",
			"TRANSPORT_PATH_FORBIDDEN",
			/percent-encodes a path separator or dot segment/u,
		],
		[
			"an off-prefix path on a host the suffix does match",
			"https://fake-mallard-000000.upstash.io/admin",
			"TRANSPORT_PATH_FORBIDDEN",
			/^path \/admin is outside the allowlisted prefixes \(\/get\/\)$/u,
		],
	] as const;

	for (const [label, url, code, message] of refused) {
		it(`refuses ${label}`, () => {
			const error = refusalOf(url, suffixPolicy);
			expect(error.code).toBe(code);
			expect(error.message).toMatch(message);
		});
	}

	it("still admits an exact allowlisted host: the suffix list is a union with allowedHosts, never a replacement", () => {
		expect(
			assertAllowedEndpoint("https://upstash.com/get/key", suffixPolicy)
				.hostname,
		).toBe("upstash.com");
	});
});

/**
 * The suffix list is validated before any URL is judged, so an unusable entry
 * refuses every request rather than quietly changing what the policy reaches.
 *
 * Both rejected forms are the ones that were reachable in the per-provider
 * copy this field replaces: written without the leading dot, `endsWith`
 * admits `evilupstash.io`; written as a bare registry level, it admits the
 * registry.
 */
describe("allowedHostSuffixes policy validation", () => {
	const unusable = [
		["a missing leading dot", "upstash.io"],
		["a bare registry level", ".com"],
		["an empty entry", ""],
		["a lone dot", "."],
		["an empty first label", "..com"],
		["a trailing dot", ".upstash.io."],
	] as const;

	for (const [label, suffix] of unusable) {
		it(`refuses a policy carrying ${label}, before judging the URL`, () => {
			const bad: TransportGuardPolicy = {
				allowedHosts: ["api.example.com"],
				allowedHostSuffixes: [suffix],
				allowedPathPrefixes: ["/v1/"],
				maxTimeoutMs: 15_000,
				maxResponseBytes: 1_024,
			};
			// The URL below matches `allowedHosts` exactly and is otherwise
			// entirely legal: it is refused only because the policy is not
			// usable, which is what "fail closed on the policy" means.
			let thrown: unknown;
			try {
				assertAllowedEndpoint("https://api.example.com/v1/projects", bad);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(TransportGuardError);
			// SAFETY: assertion required at this I/O or test boundary.
			expect((thrown as TransportGuardError).code).toBe(
				"TRANSPORT_HOST_FORBIDDEN",
			);
			// SAFETY: assertion required at this I/O or test boundary.
			expect((thrown as TransportGuardError).message).toBe(
				`policy allowedHostSuffixes entry ${JSON.stringify(suffix)} must start with "." and carry at least one further dot: "upstash.io" would also match evilupstash.io, and ".com" would match the registry`,
			);
		});
	}

	it("accepts a usable entry, so the validation is not refusing everything", () => {
		expect(
			assertAllowedEndpoint("https://db.upstash.io/v1/x", {
				allowedHosts: [],
				allowedHostSuffixes: [".upstash.io"],
				allowedPathPrefixes: ["/v1/"],
				maxTimeoutMs: 15_000,
				maxResponseBytes: 1_024,
			}).hostname,
		).toBe("db.upstash.io");
	});
});

/**
 * The field is additive, and "additive" has to be asserted rather than assumed:
 * eight provider policies in this repo omit it, and one of them
 * (`provider-netlify`) pins the host refusal message anchored at both ends.
 */
describe("a policy without allowedHostSuffixes behaves exactly as before", () => {
	const legacy: TransportGuardPolicy = {
		allowedHosts: ["api.netlify.com"],
		allowedPathPrefixes: ["/api/v1/sites/"],
		maxTimeoutMs: 15_000,
		maxResponseBytes: 1_024,
	};

	for (const [label, p] of [
		["the field absent", legacy],
		["the field present but empty", { ...legacy, allowedHostSuffixes: [] }],
	] as const) {
		it(`keeps the exact-match refusal message byte-identical with ${label}`, () => {
			let thrown: unknown;
			try {
				assertAllowedEndpoint(
					"https://api.netlify.com.attacker.example/api/v1/sites/x",
					p,
				);
			} catch (error) {
				thrown = error;
			}
			// SAFETY: assertion required at this I/O or test boundary.
			expect((thrown as TransportGuardError).message).toBe(
				"host api.netlify.com.attacker.example is not exactly one of the allowlisted provider hosts (api.netlify.com)",
			);
		});

		it(`admits the exact host with ${label}`, () => {
			expect(
				assertAllowedEndpoint("https://api.netlify.com/api/v1/sites/abc", p)
					.hostname,
			).toBe("api.netlify.com");
		});
	}
});
