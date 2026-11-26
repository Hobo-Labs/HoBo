import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { redactProviderText, ttlShErrorForStatus } from "../src/errors.js";
import {
	assertAllowedEndpoint,
	assertNoCredentialHeaders,
	createGuardedTransport,
	TTL_SH_REGISTRY_POLICY,
} from "../src/transport.js";
import {
	createStubTransport,
	expectTtlShCode,
	FAKE_DIGEST,
	FAKE_UUID_NAME,
	LEAKED_TOKEN,
	rejectTtlShCode,
} from "./fixtures/index.js";

const MANIFEST_URL = `https://ttl.sh/v2/${FAKE_UUID_NAME}/manifests/1h`;

const REQUEST = {
	method: "GET",
	url: MANIFEST_URL,
	headers: { accept: "application/vnd.oci.image.manifest.v1+json" },
	timeoutMs: 5_000,
	maxResponseBytes: 64 * 1024,
} as const;

describe("assertAllowedEndpoint", () => {
	it("accepts a manifest read on the registry API surface", () => {
		assert.equal(
			assertAllowedEndpoint(MANIFEST_URL, TTL_SH_REGISTRY_POLICY).hostname,
			"ttl.sh",
		);
	});

	for (const [reason, url] of [
		["plaintext http", `http://ttl.sh/v2/${FAKE_UUID_NAME}/manifests/1h`],
		[
			"another host entirely",
			`https://evil.example.com/v2/${FAKE_UUID_NAME}/manifests/1h`,
		],
		[
			"a lookalike host",
			`https://ttl.sh.evil.example.com/v2/${FAKE_UUID_NAME}/manifests/1h`,
		],
		// ttl.sh is one origin, not a namespace, so no subdomain is allowed
		// even though a suffix match would have admitted this.
		[
			"a subdomain",
			`https://registry.ttl.sh/v2/${FAKE_UUID_NAME}/manifests/1h`,
		],
		[
			"a non-default port",
			`https://ttl.sh:8443/v2/${FAKE_UUID_NAME}/manifests/1h`,
		],
		["a path outside the /v2/ API", "https://ttl.sh/admin"],
		["a malformed URL", "not-a-url"],
	] as const) {
		it(`refuses ${reason}`, () => {
			expectTtlShCode(
				() => assertAllowedEndpoint(url, TTL_SH_REGISTRY_POLICY),
				"TRANSPORT_NOT_ALLOWED",
			);
		});
	}

	it("refuses userinfo as a credential rather than as a bad URL", () => {
		expectTtlShCode(
			() =>
				assertAllowedEndpoint(
					`https://user:${LEAKED_TOKEN}@ttl.sh/v2/`,
					TTL_SH_REGISTRY_POLICY,
				),
			"CREDENTIAL_REFUSED",
		);
	});
});

describe("assertNoCredentialHeaders", () => {
	for (const header of [
		"authorization",
		"Authorization",
		"proxy-authorization",
		"cookie",
		"x-registry-auth",
	]) {
		it(`refuses a ${header} header`, () => {
			expectTtlShCode(
				() => assertNoCredentialHeaders({ [header]: `Bearer ${LEAKED_TOKEN}` }),
				"CREDENTIAL_REFUSED",
			);
		});
	}

	it("allows the ordinary registry headers", () => {
		assert.doesNotThrow(() =>
			assertNoCredentialHeaders({
				accept: "application/vnd.oci.image.manifest.v1+json",
				"user-agent": "hobo-provider-ttl-sh/0.0.1",
			}),
		);
	});
});

describe("createGuardedTransport", () => {
	it("passes an allowlisted anonymous request through", async () => {
		const stub = createStubTransport({ script: [{ status: 200, body: "{}" }] });

		const response = await createGuardedTransport(stub).request(REQUEST);

		assert.equal(response.status, 200);
		assert.equal(stub.requests.length, 1);
	});

	it("refuses to send a credential even when the URL is allowlisted", async () => {
		const stub = createStubTransport({});

		await rejectTtlShCode(
			() =>
				createGuardedTransport(stub).request({
					...REQUEST,
					headers: { authorization: `Bearer ${LEAKED_TOKEN}` },
				}),
			"CREDENTIAL_REFUSED",
		);
		// Refused before the request left the process.
		assert.equal(stub.requests.length, 0);
	});

	it("refuses to follow a redirect off the allowlisted host", async () => {
		const stub = createStubTransport({
			script: [
				{
					status: 302,
					headers: { location: "https://mirror.example.com/v2/" },
					body: "",
				},
			],
		});

		const error = await rejectTtlShCode(
			() => createGuardedTransport(stub).request(REQUEST),
			"PROVIDER_CONTRACT_CHANGED",
		);
		assert.match(error.message, /never follows/u);
	});

	it("treats an authentication challenge as a contract change", async () => {
		const stub = createStubTransport({
			script: [
				{
					status: 401,
					headers: {
						"www-authenticate": 'Bearer realm="https://ttl.sh/token"',
					},
					body: "{}",
				},
			],
		});

		await rejectTtlShCode(
			() => createGuardedTransport(stub).request(REQUEST),
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("refuses a response past the byte cap", async () => {
		const stub = createStubTransport({
			script: [
				{
					status: 200,
					body: "x".repeat(TTL_SH_REGISTRY_POLICY.maxResponseBytes + 1),
				},
			],
		});

		await rejectTtlShCode(
			() =>
				createGuardedTransport(stub).request({
					...REQUEST,
					maxResponseBytes: TTL_SH_REGISTRY_POLICY.maxResponseBytes,
				}),
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("refuses a response that declares an oversized content-length", async () => {
		const stub = createStubTransport({
			script: [
				{ status: 200, headers: { "content-length": "99999999" }, body: "{}" },
			],
		});

		await rejectTtlShCode(
			() => createGuardedTransport(stub).request(REQUEST),
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("refuses a caller's over-policy timeout and byte budget rather than clamping", async () => {
		// This used to rewrite a ten-minute, hundred-megabyte request down to
		// the policy and send it anyway. Quietly honouring something other than
		// what was asked for hides the misconfiguration that produced it; the
		// shared guard refuses and names the bound instead.
		const stub = createStubTransport({});

		const error = await rejectTtlShCode(
			() =>
				createGuardedTransport(stub).request({
					...REQUEST,
					timeoutMs: 10 * 60_000,
					maxResponseBytes: 100 * 1024 * 1024,
				}),
			"PROVIDER_CONTRACT_CHANGED",
		);
		assert.match(error.message, /exceeds the policy cap/u);
		assert.equal(stub.requests.length, 0);
	});

	it("sends a within-policy timeout and byte budget through untouched", async () => {
		const stub = createStubTransport({});

		await createGuardedTransport(stub).request({
			...REQUEST,
			timeoutMs: TTL_SH_REGISTRY_POLICY.timeoutMs,
			maxResponseBytes: TTL_SH_REGISTRY_POLICY.maxResponseBytes,
		});

		const sent = stub.requests[0];
		assert.ok(sent !== undefined);
		assert.equal(sent.timeoutMs, TTL_SH_REGISTRY_POLICY.timeoutMs);
		assert.equal(
			sent.maxResponseBytes,
			TTL_SH_REGISTRY_POLICY.maxResponseBytes,
		);
	});
});

describe("ttlShErrorForStatus", () => {
	it("maps 429 to a retryable rate limit", () => {
		const error = ttlShErrorForStatus(429, {
			method: "GET",
			retryAfterMs: 30_000,
		});
		assert.equal(error.code, "PROVIDER_RATE_LIMITED");
		assert.equal(error.retryable, true);
		assert.equal(error.retryAfterMs, 30_000);
	});

	it("maps 404 to an expired lease, the only teardown this registry has", () => {
		assert.equal(
			ttlShErrorForStatus(404, { method: "GET" }).code,
			"LEASE_EXPIRED",
		);
	});

	it("maps an authorization challenge to a contract change, never to a credential prompt", () => {
		const error = ttlShErrorForStatus(401, { method: "GET" });
		assert.equal(error.code, "PROVIDER_CONTRACT_CHANGED");
		assert.match(error.message, /anonymous/u);
	});

	it("maps 5xx to a retryable outage", () => {
		const error = ttlShErrorForStatus(503, { method: "GET" });
		assert.equal(error.code, "PROVIDER_UNAVAILABLE");
		assert.equal(error.retryable, true);
	});
});

describe("redactProviderText", () => {
	it("removes a bearer header value", () => {
		const redacted = redactProviderText(
			`authorization: Bearer ${LEAKED_TOKEN}`,
		);
		assert.ok(!redacted.includes(LEAKED_TOKEN));
		assert.match(redacted, /\[redacted\]/u);
	});

	it("removes a docker-style basic credential", () => {
		const redacted = redactProviderText(
			`Authorization: Basic ${"QUJD".repeat(12)}`,
		);
		assert.ok(!redacted.includes("QUJDQUJD"));
	});

	it("removes a long opaque blob with no recognizable prefix", () => {
		const blob = "Z".repeat(64);
		assert.ok(!redactProviderText(`value ${blob}`).includes(blob));
	});

	it("keeps a digest, which is the artifact's identity and not a secret", () => {
		// The generic long-blob rule would eat this, which is why digests are
		// masked out before the credential rules run.
		assert.match(redactProviderText(`pushed ${FAKE_DIGEST}`), /sha256:a1a1/u);
	});

	it("flattens control characters so tool output cannot forge a log line", () => {
		assert.ok(!redactProviderText("first\n\rINFO fake second").includes("\n"));
	});
});
