/**
 * HTTP transports for remote PAM control planes.
 *
 * These clients mint credentials for privileged access, so the properties that
 * matter are about what leaves the process and what happens when the control
 * plane answers something unexpected.
 *
 * **Each vendor gets its own request shape, not a common one.** Teleport,
 * Boundary and JumpServer each name the same three things differently, and a
 * client that sent one shape everywhere would be rejected by two of them — or
 * worse, accepted with a field silently ignored, minting a session with the
 * wrong TTL or against the wrong target.
 *
 * **Every response field has a fallback, and the id fallback is synthesized.**
 * A control plane that returns no session id still has to yield *something*
 * addressable, or the caller holds a live remote session it cannot revoke.
 *
 * **A revoke treats 404 as success.** Revocation is what runs on the cleanup
 * path, and "already gone" is the outcome it wanted; failing there would leave
 * a caller retrying a session that no longer exists.
 *
 * **`mergeRemoteIntoHandle` takes the earlier of the two expiries.** The local
 * handle and the remote session expire independently, and a handle claiming to
 * outlive its remote session is a caller who thinks they still have access
 * after the control plane has revoked it.
 */

import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";

import {
	createRemoteTransport,
	mergeRemoteIntoHandle,
} from "../../src/pam/remote-transport.js";

type Call = { url: string; init: RequestInit };

function transport(
	kind: string,
	script: { status?: number; body?: unknown; text?: string }[] = [],
	options: JsonObject = {},
) {
	const calls: Call[] = [];
	let n = 0;
	// SAFETY: assertion required at this I/O or test boundary.
	const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
		calls.push({ url: String(url), init });
		const entry = script[n++] ?? { body: {} };
		const status = entry.status ?? 200;
		const text = entry.text ?? JSON.stringify(entry.body ?? {});
		// SAFETY: assertion required at this I/O or test boundary.
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => text,
		} as Response;
	}) as typeof fetch;
	return {
		calls,
		sent: (i = 0) =>
			// SAFETY: assertion required at this I/O or test boundary.
			JSON.parse(String(calls[i]?.init.body)) as JsonObject,
		api: createRemoteTransport({
			// SAFETY: assertion required at this I/O or test boundary.
			kind: kind as never,
			endpoint: "https://pam.example.com",
			authToken: "pam-secret",
			fetchImpl,
			...options,
		}),
	};
}

const request = {
	subject: "alice",
	target: "db-prod",
	// SAFETY: assertion required at this I/O or test boundary.
	isolationClass: "production" as never,
	ttlSeconds: 600,
};

describe("transport construction", () => {
	it("reports the kind it speaks", () => {
		expect(transport("teleport").api.kind).toBe("teleport");
	});

	it("normalizes a trailing slash off the endpoint", () => {
		// A doubled slash 404s against some gateways and works against every
		// mock.
		expect(
			transport("teleport", [], { endpoint: "https://pam.example.com/" }).api
				.endpoint,
		).toBe("https://pam.example.com");
	});

	it("reports the normalized endpoint, not the raw one", () => {
		expect(transport("teleport").api.endpoint).toBe("https://pam.example.com");
	});
});

describe("the request envelope", () => {
	it("bears the control-plane token", async () => {
		const t = transport("teleport");
		await t.api.authorizeSession(request);
		const call = t.calls[0];
		if (call === undefined) throw new Error("expected a request");
		const headers = call.init.headers;
		expect(
			headers &&
				!Array.isArray(headers) &&
				!(headers instanceof Headers) &&
				headers.authorization,
		).toBe("Bearer pam-secret");
	});

	it("declares and accepts JSON", async () => {
		const t = transport("teleport");
		await t.api.authorizeSession(request);
		// SAFETY: assertion required at this I/O or test boundary.
		const first = t.calls[0];
		if (first === undefined) throw new Error("expected a request");
		const headers = first.init.headers;
		if (!headers || headers instanceof Headers || Array.isArray(headers)) {
			throw new Error("expected header object");
		}
		expect(headers["content-type"]).toBe("application/json");
		expect(headers.accept).toBe("application/json");
	});

	it("keeps the token out of the failure message", async () => {
		// A PAM failure is logged; the control-plane token must not be.
		const t = transport("teleport", [{ status: 403, text: "denied" }]);
		await expect(t.api.authorizeSession(request)).rejects.toThrow(
			expect.objectContaining({
				message: expect.not.stringContaining("pam-secret"),
			}),
		);
	});

	it("names the kind, path and status on failure", async () => {
		const t = transport("teleport", [{ status: 403, text: "denied" }]);
		await expect(t.api.authorizeSession(request)).rejects.toThrow(
			/pam remote teleport .* failed \(403\)/u,
		);
	});

	it("tags the failure with a stable code and the status", async () => {
		// Callers branch on this rather than on the message text.
		const t = transport("teleport", [{ status: 503, text: "down" }]);
		const error = await t.api
			.authorizeSession(request)
			// SAFETY: assertion required at this I/O or test boundary.
			.catch((error: Error) => error);
		expect(error.code).toBe("pam-remote-error");
		expect(error.status).toBe(503);
	});

	it("bounds the failure body it quotes", async () => {
		const t = transport("teleport", [{ status: 500, text: "x".repeat(4000) }]);
		const error = await t.api
			.authorizeSession(request)
			// SAFETY: assertion required at this I/O or test boundary.
			.catch((error: Error) => error);
		expect(error.message.length).toBeLessThan(400);
	});

	it("keeps an unparseable body rather than discarding it", async () => {
		// A control plane answering HTML on success is broken, but throwing away
		// what it said would leave nothing to diagnose with.
		const t = transport("nova", [{ text: "<html>maintenance</html>" }]);
		const result = await t.api.authorizeSession(request);
		expect(result.remoteSessionId).toMatch(/^nv-/u);
	});

	it("treats an empty body as an empty object rather than a parse error", async () => {
		const t = transport("nova", [{ text: "" }]);
		await expect(t.api.authorizeSession(request)).resolves.toBeDefined();
	});
});

describe("Teleport", () => {
	it("posts to the webapi certificate endpoint", async () => {
		const t = transport("teleport");
		await t.api.authorizeSession(request);
		expect(t.calls[0]?.url).toBe("https://pam.example.com/v1/webapi/ssh/certs");
	});

	it("sends the TTL as a seconds object, which is what Teleport reads", async () => {
		// A bare number here is accepted and ignored, minting a session with the
		// control plane's default lifetime instead of the requested one.
		const t = transport("teleport");
		await t.api.authorizeSession(request);
		expect(t.sent().ttl).toEqual({ seconds: 600 });
	});

	it("names the subject as both user and login", async () => {
		const t = transport("teleport");
		await t.api.authorizeSession(request);
		expect(t.sent()).toMatchObject({ user: "alice", login: "alice" });
	});

	it("carries the isolation class and reason for the audit record", async () => {
		// A PAM grant with no recorded reason is a grant nobody can review.
		const t = transport("teleport");
		await t.api.authorizeSession({ ...request, reason: "incident-42" });
		expect(t.sent()).toMatchObject({
			env: "production",
			reason: "incident-42",
		});
	});

	it("prefers the certificate over a token", async () => {
		const t = transport("teleport", [
			{ body: { session_id: "s1", cert: "CERT", token: "TOKEN" } },
		]);
		expect((await t.api.authorizeSession(request)).authorization).toBe("CERT");
	});

	it("accepts the ssh_cert spelling", async () => {
		const t = transport("teleport", [{ body: { ssh_cert: "CERT" } }]);
		expect((await t.api.authorizeSession(request)).authorization).toBe("CERT");
	});

	it("uses the expiry the control plane stated", async () => {
		// The remote clock decides; a locally computed expiry that outlives it
		// would let a caller believe a dead session is live.
		const t = transport("teleport", [
			{ body: { expires_at: "2030-01-01T00:00:00.000Z" } },
		]);
		expect((await t.api.authorizeSession(request)).expiresAt).toBe(
			"2030-01-01T00:00:00.000Z",
		);
	});

	it("computes an expiry from the TTL when none was stated", async () => {
		const t = transport("teleport", [{ body: {} }]);
		const result = await t.api.authorizeSession(request);
		const remaining = Date.parse(result.expiresAt) - Date.now();
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(600_000);
	});

	it("synthesizes a session id when none came back", async () => {
		// Without an id the caller holds a live remote session it cannot revoke.
		const t = transport("teleport", [{ body: { cert: "CERT" } }]);
		expect((await t.api.authorizeSession(request)).remoteSessionId).toMatch(
			/^tp-/u,
		);
	});

	it("revokes through the sessions endpoint", async () => {
		const t = transport("teleport");
		await t.api.revokeSession("s1");
		expect(t.calls[0]?.url).toBe(
			"https://pam.example.com/v1/webapi/sessions/s1",
		);
		expect(t.calls[0]?.init.method).toBe("DELETE");
	});
});

describe("Boundary", () => {
	it("posts to the target's authorize-session action", async () => {
		const t = transport("boundary");
		await t.api.authorizeSession(request);
		expect(t.calls[0]?.url).toBe(
			"https://pam.example.com/v1/targets/db-prod:authorize-session",
		);
	});

	it("percent-encodes the target in the path", async () => {
		// Boundary target ids are opaque and can contain a slash, which would
		// otherwise change the path segment.
		const t = transport("boundary");
		await t.api.authorizeSession({ ...request, target: "org/db prod" });
		expect(t.calls[0]?.url).toContain("org%2Fdb%20prod");
	});

	it("sends the TTL in Boundary's duration spelling", async () => {
		const t = transport("boundary");
		await t.api.authorizeSession(request);
		expect(t.sent().ttl).toBe("600s");
	});

	it("unwraps the item envelope Boundary wraps results in", async () => {
		const t = transport("boundary", [
			{ body: { item: { id: "b1", authorization_token: "TOK" } } },
		]);
		expect(await t.api.authorizeSession(request)).toMatchObject({
			remoteSessionId: "b1",
			authorization: "TOK",
		});
	});

	it("reads a flat response too, since not every version wraps", async () => {
		const t = transport("boundary", [
			{ body: { id: "b1", authorization_token: "TOK" } },
		]);
		expect((await t.api.authorizeSession(request)).authorization).toBe("TOK");
	});

	it("prefers the token id over the generic id", async () => {
		// They address different things; the token id is what revokes the grant.
		const t = transport("boundary", [
			{ body: { item: { id: "b1", authorization_token_id: "at-1" } } },
		]);
		expect((await t.api.authorizeSession(request)).remoteSessionId).toBe(
			"at-1",
		);
	});

	it("synthesizes an id when the response carries none", async () => {
		const t = transport("boundary", [{ body: { item: {} } }]);
		expect((await t.api.authorizeSession(request)).remoteSessionId).toMatch(
			/^bd-/u,
		);
	});

	it("uses Boundary's expiration_time field", async () => {
		const t = transport("boundary", [
			{ body: { item: { expiration_time: "2030-01-01T00:00:00.000Z" } } },
		]);
		expect((await t.api.authorizeSession(request)).expiresAt).toBe(
			"2030-01-01T00:00:00.000Z",
		);
	});

	it("revokes through the generic sessions endpoint", async () => {
		const t = transport("boundary");
		await t.api.revokeSession("b1");
		expect(t.calls[0]?.url).toBe("https://pam.example.com/v1/sessions/b1");
	});
});

describe("JumpServer", () => {
	it("posts to the connection-token endpoint, trailing slash and all", async () => {
		// JumpServer's REST API redirects without the trailing slash, which drops
		// the POST body.
		const t = transport("jumpserver");
		await t.api.authorizeSession(request);
		expect(t.calls[0]?.url).toBe(
			"https://pam.example.com/api/v1/authentication/connection-token/",
		);
	});

	it("names the target as an asset, in JumpServer's vocabulary", async () => {
		const t = transport("jumpserver");
		await t.api.authorizeSession(request);
		expect(t.sent()).toMatchObject({ asset: "db-prod", user: "alice" });
	});

	it("sends the TTL as a bare number", async () => {
		const t = transport("jumpserver");
		await t.api.authorizeSession(request);
		expect(t.sent().ttl).toBe(600);
	});

	it("records the reason as a comment, which is where JumpServer audits it", async () => {
		const t = transport("jumpserver");
		await t.api.authorizeSession({ ...request, reason: "incident-42" });
		expect(t.sent().comment).toBe("incident-42");
	});

	it("prefers the token value over the token id as the authorization", async () => {
		// The value is the credential; the id merely names it.
		const t = transport("jumpserver", [
			{ body: { id: "j1", value: "VALUE", token: "TOKEN" } },
		]);
		expect((await t.api.authorizeSession(request)).authorization).toBe("VALUE");
	});

	it("falls back to the id as the authorization when nothing else came back", async () => {
		const t = transport("jumpserver", [{ body: { id: "j1" } }]);
		expect((await t.api.authorizeSession(request)).authorization).toBe("j1");
	});

	it("uses JumpServer's date_expired field", async () => {
		const t = transport("jumpserver", [
			{ body: { id: "j1", date_expired: "2030-01-01T00:00:00.000Z" } },
		]);
		expect((await t.api.authorizeSession(request)).expiresAt).toBe(
			"2030-01-01T00:00:00.000Z",
		);
	});

	it("synthesizes an id when none came back", async () => {
		const t = transport("jumpserver", [{ body: {} }]);
		expect((await t.api.authorizeSession(request)).remoteSessionId).toMatch(
			/^js-/u,
		);
	});

	it("revokes through the connection-token path with its trailing slash", async () => {
		const t = transport("jumpserver");
		await t.api.revokeSession("j1");
		expect(t.calls[0]?.url).toBe(
			"https://pam.example.com/api/v1/authentication/connection-token/j1/",
		);
	});
});

describe("the generic control plane", () => {
	it("posts to a plain sessions endpoint", async () => {
		const t = transport("nova");
		await t.api.authorizeSession(request);
		expect(t.calls[0]?.url).toBe("https://pam.example.com/v1/sessions");
	});

	it("sends the request in snake_case", async () => {
		const t = transport("nova");
		await t.api.authorizeSession(request);
		expect(t.sent()).toMatchObject({
			subject: "alice",
			target: "db-prod",
			ttl_seconds: 600,
			isolation_class: "production",
		});
	});

	it("prefers the token field over authorization", async () => {
		const t = transport("nova", [{ body: { token: "T", authorization: "A" } }]);
		expect((await t.api.authorizeSession(request)).authorization).toBe("T");
	});

	it("reports an empty authorization rather than the string undefined", async () => {
		// Every field is stringified; an absent one must not become the literal
		// text "undefined" in a credential field.
		const t = transport("nova", [{ body: {} }]);
		expect((await t.api.authorizeSession(request)).authorization).toBe("");
	});

	it("synthesizes an id when none came back", async () => {
		const t = transport("nova", [{ body: {} }]);
		expect((await t.api.authorizeSession(request)).remoteSessionId).toMatch(
			/^nv-/u,
		);
	});

	it("revokes through the sessions endpoint", async () => {
		const t = transport("nova");
		await t.api.revokeSession("n1");
		expect(t.calls[0]?.url).toBe("https://pam.example.com/v1/sessions/n1");
	});
});

describe("revocation", () => {
	it("percent-encodes the session id in the path", async () => {
		const t = transport("nova");
		await t.api.revokeSession("a/b c");
		expect(t.calls[0]?.url).toContain("a%2Fb%20c");
	});

	it("sends no content type, since it sends no body", async () => {
		const t = transport("nova");
		await t.api.revokeSession("n1");
		const first = t.calls[0];
		if (first === undefined) throw new Error("expected a request");
		const headers = first.init.headers;
		expect(
			headers &&
				!Array.isArray(headers) &&
				!(headers instanceof Headers) &&
				headers["content-type"],
		).toBeUndefined();
	});

	it("treats a 404 as success, because already-gone is the goal", async () => {
		// Revocation runs on the cleanup path; failing on "not there" would have
		// a caller retrying a session that no longer exists.
		const t = transport("nova", [{ status: 404, text: "not found" }]);
		await expect(t.api.revokeSession("n1")).resolves.toBeUndefined();
	});

	it("raises any other failure, since the session may still be live", async () => {
		const t = transport("nova", [{ status: 500, text: "boom" }]);
		await expect(t.api.revokeSession("n1")).rejects.toThrow(
			/DELETE .* failed \(500\)/u,
		);
	});

	it("tags a revocation failure with the same code as an authorize failure", async () => {
		const t = transport("nova", [{ status: 500 }]);
		const error = await t.api
			.revokeSession("n1")
			// SAFETY: assertion required at this I/O or test boundary.
			.catch((error: Error) => error);
		expect(error.code).toBe("pam-remote-error");
	});

	it("still fails usefully when the failure body cannot be read", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const fetchImpl = (async () =>
			// SAFETY: assertion required at this I/O or test boundary.
			({
				ok: false,
				status: 502,
				text: async () => {
					throw new Error("stream closed");
				},
			}) as Response) as typeof fetch;
		const api = createRemoteTransport({
			// SAFETY: assertion required at this I/O or test boundary.
			kind: "nova" as never,
			endpoint: "https://pam.example.com",
			authToken: "t",
			fetchImpl,
		});
		await expect(api.revokeSession("n1")).rejects.toThrow(/502/u);
	});
});

describe("mergeRemoteIntoHandle", () => {
	// SAFETY: assertion required at this I/O or test boundary.
	const local = {
		credentialRef: "hobo-pam://session/local-1",
		expiresAt: "2030-01-01T00:00:00.000Z",
		sessionToken: "signed-locally",
	} as never;

	const remote = (expiresAt: string, remoteSessionId = "r1") => ({
		remoteSessionId,
		authorization: "TOK",
		expiresAt,
	});

	it("binds the remote id into the credential reference", async () => {
		expect(
			mergeRemoteIntoHandle({
				local,
				remote: remote("2030-01-01T00:00:00.000Z"),
			}).credentialRef,
		).toBe("hobo-pam://session/local-1?remote=r1");
	});

	it("percent-encodes the remote id it binds in", () => {
		// The reference is parsed as a URL downstream; an unencoded `&` would
		// split it into two parameters.
		expect(
			mergeRemoteIntoHandle({
				local,
				remote: remote("2030-01-01T00:00:00.000Z", "a&b=c"),
			}).credentialRef,
		).toContain("a%26b%3Dc");
	});

	it("keeps the locally signed session token", () => {
		// The local signature is what HoBo verifies; replacing it with a remote
		// credential would make the handle unverifiable.
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(
				mergeRemoteIntoHandle({
					local,
					remote: remote("2030-01-01T00:00:00.000Z"),
				}) as JsonObject
			).sessionToken,
		).toBe("signed-locally");
	});

	it("takes the remote expiry when it is the earlier one", () => {
		// A handle outliving its remote session is a caller who believes they
		// still have access after the control plane revoked it.
		expect(
			mergeRemoteIntoHandle({
				local,
				remote: remote("2029-01-01T00:00:00.000Z"),
			}).expiresAt,
		).toBe("2029-01-01T00:00:00.000Z");
	});

	it("keeps the local expiry when it is the earlier one", () => {
		expect(
			mergeRemoteIntoHandle({
				local,
				remote: remote("2031-01-01T00:00:00.000Z"),
			}).expiresAt,
		).toBe("2030-01-01T00:00:00.000Z");
	});

	it("keeps the local expiry when the two are equal", () => {
		expect(
			mergeRemoteIntoHandle({
				local,
				remote: remote("2030-01-01T00:00:00.000Z"),
			}).expiresAt,
		).toBe("2030-01-01T00:00:00.000Z");
	});

	it("freezes the merged handle", () => {
		// It is passed across the connectivity boundary; a mutable expiry is an
		// access window somebody downstream can extend.
		expect(
			Object.isFrozen(
				mergeRemoteIntoHandle({
					local,
					remote: remote("2030-01-01T00:00:00.000Z"),
				}),
			),
		).toBe(true);
	});

	it("leaves the local handle unchanged", () => {
		mergeRemoteIntoHandle({
			local,
			remote: remote("2029-01-01T00:00:00.000Z"),
		});
		// SAFETY: assertion required at this I/O or test boundary.
		expect(local.expiresAt).toBe("2030-01-01T00:00:00.000Z");
	});
});
