import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	isProviderError,
	providerErrorForStatus,
	redactProviderText,
} from "../src/errors.js";
import {
	assertAllowedEndpoint,
	createGuardedTransport,
	UPSTASH_CONTROL_PLANE_POLICY,
	UPSTASH_DATA_PLANE_HOST_SUFFIX,
	UPSTASH_DATA_PLANE_POLICY,
} from "../src/transport.js";
import {
	createStubTransport,
	FAKE_REST_TOKEN,
	VALID_PAYLOAD,
} from "./fixtures/index.js";

const CONTROL_REQUEST = {
	method: "POST",
	url: "https://upstash.com/start-redis",
	headers: {},
	timeoutMs: 5_000,
	maxResponseBytes: 64 * 1024,
} as const;

describe("assertAllowedEndpoint", () => {
	it("refuses an encoded separator that survives URL parsing", () => {
		// Be precise about the mechanism: WHATWG resolves dot segments during
		// parsing and treats `%2e` as a dot, so `/%2e%2e/x` arrives collapsed
		// and the prefix check already handles it. `%2f` and `%5c` are NOT
		// separators to the parser — they reach the prefix check with the
		// prefix intact, pass it, and are decoded only by the origin.
		assert.throws(
			() =>
				assertAllowedEndpoint(
					"https://fake-mallard-000000.upstash.io/get/%2f%2e%2e%2fadmin",
					UPSTASH_DATA_PLANE_POLICY,
				),
			/percent-encodes/u,
		);
		assert.throws(
			() =>
				assertAllowedEndpoint(
					"https://upstash.com/start-redis/..%5cadmin",
					UPSTASH_CONTROL_PLANE_POLICY,
				),
			/percent-encodes/u,
		);

		// The legitimate path must survive the tightening.
		assert.equal(
			assertAllowedEndpoint(
				"https://fake-mallard-000000.upstash.io/get/key",
				UPSTASH_DATA_PLANE_POLICY,
			).pathname,
			"/get/key",
		);
	});

	it("accepts the documented control-plane URL", () => {
		const url = assertAllowedEndpoint(
			"https://upstash.com/start-redis",
			UPSTASH_CONTROL_PLANE_POLICY,
		);
		assert.equal(url.hostname, "upstash.com");
	});

	it("accepts a per-database data-plane origin", () => {
		const url = assertAllowedEndpoint(
			"https://fake-mallard-000000.upstash.io",
			UPSTASH_DATA_PLANE_POLICY,
		);
		assert.equal(url.hostname, "fake-mallard-000000.upstash.io");
	});

	for (const [reason, url] of [
		["plaintext http", "http://upstash.com/start-redis"],
		["another host entirely", "https://evil.example.com/start-redis"],
		// The control-plane call is unauthenticated, so a lookalike host costs
		// nothing to reach and hands back an attacker's token.
		["a lookalike host", "https://upstash.com.evil.example.com/start-redis"],
		["embedded userinfo", "https://user:pass@upstash.com/start-redis"],
		["an off-policy path", "https://upstash.com/admin"],
		["a non-default port", "https://upstash.com:8443/start-redis"],
	] as const) {
		it(`refuses ${reason}`, () => {
			assert.throws(
				() => assertAllowedEndpoint(url, UPSTASH_CONTROL_PLANE_POLICY),
				(error: Error) =>
					isProviderError(error) && error.code === "PROVIDER_CONTRACT_CHANGED",
			);
		});
	}

	it("refuses a data-plane policy whose suffix was written without the leading dot", () => {
		// Measured before the URL check moved into core: this package applied
		// the suffix with a bare `endsWith` and no shape check, so a policy
		// written `upstash.io` rather than `.upstash.io` admitted
		// `evilupstash.io` — a registration anyone can buy. Core refuses the
		// policy itself now, before it judges any URL, so the hole is not
		// reachable by a one-character authoring slip.
		assert.throws(
			() =>
				assertAllowedEndpoint("https://evilupstash.io/get/key", {
					...UPSTASH_DATA_PLANE_POLICY,
					allowedHostSuffixes: ["upstash.io"],
				}),
			(error: Error) =>
				isProviderError(error) &&
				error.code === "PROVIDER_CONTRACT_CHANGED" &&
				/must start with "\." and carry at least one further dot/u.test(
					error.message,
				),
		);
	});

	it("ships a dot-anchored data-plane suffix, which is what makes the suffix rule safe", () => {
		assert.equal(UPSTASH_DATA_PLANE_HOST_SUFFIX, ".upstash.io");
		assert.deepEqual(UPSTASH_DATA_PLANE_POLICY.allowedHostSuffixes, [
			".upstash.io",
		]);
		// The sibling registration the leading dot is there to exclude.
		assert.throws(
			() =>
				assertAllowedEndpoint(
					"https://evilupstash.io/get/key",
					UPSTASH_DATA_PLANE_POLICY,
				),
			(error: Error) =>
				isProviderError(error) &&
				error.code === "PROVIDER_CONTRACT_CHANGED" &&
				/host evilupstash\.io is not exactly one of the allowlisted/u.test(
					error.message,
				),
		);
	});

	it("refuses the bare data-plane suffix with no database label in front", () => {
		assert.throws(
			() =>
				assertAllowedEndpoint("https://upstash.io", UPSTASH_DATA_PLANE_POLICY),
			(error: Error) => isProviderError(error),
		);
	});
});

describe("createGuardedTransport", () => {
	it("passes an allowlisted request through", async () => {
		const stub = createStubTransport({
			script: [{ status: 200, body: VALID_PAYLOAD }],
		});
		const guarded = createGuardedTransport(stub, UPSTASH_CONTROL_PLANE_POLICY);

		const response = await guarded.request(CONTROL_REQUEST);

		assert.equal(response.status, 200);
		assert.equal(stub.requests.length, 1);
	});

	it("refuses to follow a redirect", async () => {
		const stub = createStubTransport({
			script: [
				{
					status: 302,
					headers: { location: "https://evil.example.com/start-redis" },
					body: "",
				},
			],
		});
		const guarded = createGuardedTransport(stub, UPSTASH_CONTROL_PLANE_POLICY);

		await assert.rejects(
			guarded.request(CONTROL_REQUEST),
			(error: Error) =>
				isProviderError(error) &&
				error.code === "PROVIDER_CONTRACT_CHANGED" &&
				/never follows/u.test(error.message),
		);
	});

	it("refuses a response past the byte cap", async () => {
		const stub = createStubTransport({
			script: [
				{
					status: 200,
					body: "x".repeat(UPSTASH_CONTROL_PLANE_POLICY.maxResponseBytes + 1),
				},
			],
		});
		const guarded = createGuardedTransport(stub, UPSTASH_CONTROL_PLANE_POLICY);

		await assert.rejects(guarded.request(CONTROL_REQUEST), (error: Error) =>
			isProviderError(error),
		);
	});

	it("clamps a caller's timeout and byte budget down to the policy", async () => {
		const stub = createStubTransport({});
		const guarded = createGuardedTransport(stub, UPSTASH_CONTROL_PLANE_POLICY);

		await guarded.request({
			...CONTROL_REQUEST,
			timeoutMs: 10 * 60_000,
			maxResponseBytes: 100 * 1024 * 1024,
		});

		const sent = stub.requests[0];
		assert.ok(sent !== undefined);
		assert.equal(sent.timeoutMs, UPSTASH_CONTROL_PLANE_POLICY.timeoutMs);
		assert.equal(
			sent.maxResponseBytes,
			UPSTASH_CONTROL_PLANE_POLICY.maxResponseBytes,
		);
	});
});

describe("redactProviderText", () => {
	it("removes a markdown token field", () => {
		const redacted = redactProviderText(`**Token:** ${FAKE_REST_TOKEN}`);
		assert.ok(!redacted.includes(FAKE_REST_TOKEN));
		assert.match(redacted, /\[redacted\]/u);
	});

	it("removes a bearer header value", () => {
		const redacted = redactProviderText(
			`authorization: Bearer ${FAKE_REST_TOKEN}`,
		);
		assert.ok(!redacted.includes(FAKE_REST_TOKEN));
	});

	it("removes a long opaque blob with no recognizable prefix", () => {
		const blob = "A".repeat(64);
		assert.ok(!redactProviderText(`value ${blob}`).includes(blob));
	});

	it("flattens control characters so provider text cannot forge a log line", () => {
		const redacted = redactProviderText("first\n\rINFO fake second");
		assert.ok(!redacted.includes("\n"));
	});

	it("keeps a hostname, which is not a credential", () => {
		assert.match(
			redactProviderText("endpoint fake-mallard-000000.upstash.io"),
			/fake-mallard-000000\.upstash\.io/u,
		);
	});
});

describe("providerErrorForStatus", () => {
	it("maps 429 to a retryable rate limit", () => {
		const error = providerErrorForStatus(429, {
			method: "POST",
			retryAfterMs: 30_000,
		});
		assert.equal(error.code, "PROVIDER_RATE_LIMITED");
		assert.equal(error.retryable, true);
		assert.equal(error.retryAfterMs, 30_000);
	});

	it("maps 401 to an auth failure", () => {
		assert.equal(
			providerErrorForStatus(401, { method: "POST" }).code,
			"PROVIDER_AUTH_FAILED",
		);
	});

	it("maps a 5xx on a create to ambiguous, never retryable", () => {
		const error = providerErrorForStatus(503, { method: "POST" });
		assert.equal(error.code, "PROVIDER_OPERATION_AMBIGUOUS");
		// "Unknown" must not be presented as "safe to redo blindly".
		assert.equal(error.retryable, false);
	});

	it("redacts a credential-bearing error body", () => {
		const error = providerErrorForStatus(400, {
			method: "POST",
			body: `**Token:** ${FAKE_REST_TOKEN}`,
		});
		assert.ok(!JSON.stringify(error.toJSON()).includes(FAKE_REST_TOKEN));
	});
});
