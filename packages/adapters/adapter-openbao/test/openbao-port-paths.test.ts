/**
 * The OpenBao port's offline and live paths.
 *
 * Both are reachable without a server: `fetch` is injected, and `offline` is an
 * explicit flag whose default is derived from whether a transport was supplied
 * at all. That default is the first thing worth pinning — a port that silently
 * went live when someone passed a `fetch` for an unrelated reason, or silently
 * went offline when the transport was there, would be wrong in opposite and
 * equally invisible ways.
 *
 * The rest is about what happens when the server says no:
 *
 * **A denial never falls through to offline material.** Offline mode mints
 * deterministic HMAC material so `hobo dev` works without a server; on the live
 * path, minting that after a 403 would hand out a locally-generated string in
 * place of a secret the caller was not authorized to read.
 *
 * **The token is cached but only while it is comfortably valid.** The cache is
 * checked against a five-second margin, so a token about to expire is renewed
 * rather than used and rejected mid-request.
 *
 * **404 gets its own code.** "Not found" and "the KV backend is broken" call
 * for different responses from a caller, and collapsing them makes a missing
 * secret look like an outage.
 */

import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject, type JsonValue } from "../src/json.js";

import { createOpenBaoSecretsPort } from "../src/openbao-secrets-port.js";

type Reply = { ok?: boolean; status?: number; json?: () => JsonValue };

/** A transport that replays a queue of replies and records what it was asked. */
function transport(...replies: Reply[]) {
	const calls: { url: string; init: JsonObject }[] = [];
	let index = 0;
	const fetchLike = async (url: string, init: JsonObject) => {
		calls.push({ url, init });
		const reply = replies[Math.min(index, replies.length - 1)] ?? {};
		index += 1;
		return {
			ok: reply.ok ?? true,
			status: reply.status ?? (reply.ok === false ? 500 : 200),
			json: async () => (reply.json ? reply.json() : {}),
		};
	};
	// SAFETY: test fetch stand-in is the FetchLike transport at this boundary.
	return { calls, fetchLike: fetchLike as never };
}

const LOGIN_OK = {
	json: () => ({ auth: { client_token: "s.token", lease_duration: 900 } }),
};

function port(options: JsonObject = {}) {
	const input = {
		openbaoAddr: "https://bao.local",
		role: "hobo-station",
		svidJwt: "eyJhbGciOiJFUzI1NiJ9.svid.fixture",
		...options,
	};
	// SAFETY: test options are the OpenBao port constructor bag at this boundary.
	return createOpenBaoSecretsPort(input as never);
}

describe("the offline default", () => {
	it("is offline when no transport is supplied", async () => {
		// Nothing to call: going live would fail every read on a machine with
		// no server, which is the ordinary `hobo dev` case.
		const result = await port().access("db");
		expect(result.status).toBe("ok");
	});

	it("is live when a transport is supplied", async () => {
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({
				data: { data: { value: "live" }, metadata: { version: 3 } },
			}),
		});
		const result = await port({ fetch: fetchLike }).access("db");
		expect(calls.length).toBeGreaterThan(0);
		expect(result.status === "ok" && result.material).toBe("live");
	});

	it("can be forced offline even with a transport present", async () => {
		const { calls, fetchLike } = transport(LOGIN_OK);
		await port({ fetch: fetchLike, offline: true }).access("db");
		expect(calls).toHaveLength(0);
	});

	it("can be forced live even with no transport, and then denies", async () => {
		// Honest: asked to go live with nothing to call, it says so rather than
		// quietly minting material.
		const result = await port({ offline: false }).access("db");
		expect(result).toMatchObject({ code: "openbao-no-fetch" });
	});
});

describe("offline material", () => {
	it("is deterministic for one name", async () => {
		// A local run has to be reproducible across restarts.
		const p = port();
		const first = await p.access("db");
		const second = await p.access("db");
		expect(first.status === "ok" && first.material).toBe(
			second.status === "ok" ? second.material : undefined,
		);
	});

	it("differs between names", async () => {
		const p = port();
		const a = await p.access("one");
		const b = await p.access("two");
		expect(a.status === "ok" && a.material).not.toBe(
			b.status === "ok" ? b.material : undefined,
		);
	});

	it("differs between addresses, so two servers are not confused", async () => {
		const a = await port({ openbaoAddr: "https://a.local" }).access("db");
		const b = await port({ openbaoAddr: "https://b.local" }).access("db");
		expect(a.status === "ok" && a.material).not.toBe(
			b.status === "ok" ? b.material : undefined,
		);
	});

	it("differs between roles", async () => {
		const a = await port({ role: "role-a" }).access("db");
		const b = await port({ role: "role-b" }).access("db");
		expect(a.status === "ok" && a.material).not.toBe(
			b.status === "ok" ? b.material : undefined,
		);
	});

	it("labels an unwritten secret's version as dynamic", async () => {
		expect((await port().access("db")).status === "ok").toBe(true);
		const result = await port().access("db");
		expect(result.status === "ok" && result.versionId).toBe("ob-dynamic");
	});

	it("returns a stored version after a put", async () => {
		const p = port();
		const { versionId } = await p.put("db", "value");
		const result = await p.access("db");
		expect(result.status === "ok" && result.versionId).toBe(versionId);
	});

	it("returns distinct material per version", async () => {
		const p = port();
		const first = await p.put("db", "v1");
		await p.put("db", "v2");
		const older = await p.accessVersion("db", first.versionId);
		const current = await p.access("db");
		expect(older.status === "ok" && older.material).not.toBe(
			current.status === "ok" ? current.material : undefined,
		);
	});

	it("derives material for a version it never stored rather than returning undefined", async () => {
		// The parallel-array invariant could break; handing back the string
		// "undefined" as a secret would be far worse than deriving one.
		const result = await port().accessVersion("db", "obv99");
		expect(result.status).toBe("ok");
		expect(result.status === "ok" && result.material).toBeTruthy();
	});

	it("gives every access an expiry", async () => {
		const result = await port().access("db");
		expect(result.status === "ok" && result.expiresAt).toBeTruthy();
	});

	it("builds a namespaced value reference when a namespace is set", async () => {
		const result = await port({ namespace: "team-a" }).access("db");
		expect(result.status === "ok" && result.valueRef).toContain("team-a/");
	});

	it("strips a trailing slash from the address", async () => {
		const result = await port({ openbaoAddr: "https://bao.local/" }).access(
			"db",
		);
		expect(result.status === "ok" && result.valueRef).toContain(
			"openbao://https://bao.local/",
		);
	});
});

describe("the live read path", () => {
	it("sends the JWT login before the read", async () => {
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { value: "live" } } }),
		});
		await port({ fetch: fetchLike }).access("db");
		expect(calls[0]?.url).toContain("/v1/auth/jwt/login");
		expect(calls[1]?.url).toContain("/v1/secret/data/db");
	});

	it("presents the token on the read, not the JWT", async () => {
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { value: "live" } } }),
		});
		await port({ fetch: fetchLike }).access("db");
		const tokenHeaders = calls[1]?.init.headers;
		expect(
			isJsonObject(tokenHeaders) ? tokenHeaders["X-Vault-Token"] : undefined,
		).toBe("s.token");
	});

	it("denies rather than falling back when login fails", async () => {
		// The load-bearing one. Minting offline material after a rejected login
		// would hand out a locally-generated string in place of a secret.
		const { fetchLike } = transport({ ok: false, status: 403 });
		expect(await port({ fetch: fetchLike }).access("db")).toMatchObject({
			code: "openbao-auth-failed",
		});
	});

	it("denies when login succeeds but returns no token", async () => {
		const { fetchLike } = transport({ json: () => ({ auth: {} }) });
		expect(await port({ fetch: fetchLike }).access("db")).toMatchObject({
			code: "openbao-auth-missing-token",
		});
	});

	it("gives a missing secret its own code, distinct from a broken backend", async () => {
		// "Not found" and "the KV backend is broken" call for different caller
		// responses; collapsing them makes a missing secret look like an outage.
		const { fetchLike } = transport(LOGIN_OK, { ok: false, status: 404 });
		expect(await port({ fetch: fetchLike }).access("db")).toMatchObject({
			code: "openbao-secret-not-found",
		});
	});

	it("reports another KV failure as a backend error", async () => {
		const { fetchLike } = transport(LOGIN_OK, { ok: false, status: 500 });
		expect(await port({ fetch: fetchLike }).access("db")).toMatchObject({
			code: "openbao-kv-http-error",
		});
	});

	it("denies an empty secret rather than returning undefined material", async () => {
		const { fetchLike } = transport(LOGIN_OK, { json: () => ({ data: {} }) });
		expect(await port({ fetch: fetchLike }).access("db")).toMatchObject({
			code: "openbao-secret-empty",
		});
	});

	it("serializes a structured secret that has no value field", async () => {
		// KV v2 holds arbitrary maps; a caller asking for a whole map gets it as
		// JSON rather than a denial.
		const { fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { user: "u", pass: "p" } } }),
		});
		const result = await port({ fetch: fetchLike }).access("db");
		expect(result.status === "ok" && result.material).toContain("user");
	});

	it("derives the version id from KV metadata", async () => {
		const { fetchLike } = transport(LOGIN_OK, {
			json: () => ({
				data: { data: { value: "v" }, metadata: { version: 7 } },
			}),
		});
		const result = await port({ fetch: fetchLike }).access("db");
		expect(result.status === "ok" && result.versionId).toBe("obv7");
	});

	it("falls back to a current marker when metadata carries no version", async () => {
		const { fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { value: "v" } } }),
		});
		const result = await port({ fetch: fetchLike }).access("db");
		expect(result.status === "ok" && result.versionId).toBe("ob-current");
	});

	it("passes a requested version as a query parameter", async () => {
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { value: "v" } } }),
		});
		await port({ fetch: fetchLike }).accessVersion("db", "3");
		expect(calls[1]?.url).toContain("version=3");
	});

	it("strips a leading slash from the secret name", async () => {
		// Otherwise the path doubles its separator and the server 404s.
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { value: "v" } } }),
		});
		await port({ fetch: fetchLike }).access("/db");
		expect(calls[1]?.url).not.toContain("data//");
	});

	it("honours a custom mount path", async () => {
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { value: "v" } } }),
		});
		await port({ fetch: fetchLike, mountPath: "kv2" }).access("db");
		expect(calls[1]?.url).toContain("/v1/kv2/data/db");
	});

	it("sends the namespace header when one is configured", async () => {
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { value: "v" } } }),
		});
		await port({ fetch: fetchLike, namespace: "team-a" }).access("db");
		const namespaceHeaders = calls[0]?.init.headers;
		expect(
			isJsonObject(namespaceHeaders)
				? namespaceHeaders["X-Vault-Namespace"]
				: undefined,
		).toBe("team-a");
	});

	it("omits the namespace header when none is configured", async () => {
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { value: "v" } } }),
		});
		await port({ fetch: fetchLike }).access("db");
		const omittedHeaders = calls[0]?.init.headers;
		expect(
			isJsonObject(omittedHeaders)
				? omittedHeaders["X-Vault-Namespace"]
				: undefined,
		).toBeUndefined();
	});
});

describe("token caching", () => {
	it("reuses a token across reads rather than logging in each time", async () => {
		// One login per token lifetime; re-authenticating per read would triple
		// the request count against a server that rate-limits auth.
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { data: { value: "v" } } }),
		});
		const p = port({ fetch: fetchLike });
		await p.access("a");
		await p.access("b");
		const logins = calls.filter((c) => c.url.includes("jwt/login"));
		expect(logins).toHaveLength(1);
	});

	it("logs in again when the lease is too short to be worth caching", async () => {
		// A token with a second left is renewed rather than used and rejected
		// mid-request.
		const { calls, fetchLike } = transport(
			{ json: () => ({ auth: { client_token: "s.t", lease_duration: 1 } }) },
			{ json: () => ({ data: { data: { value: "v" } } }) },
		);
		const p = port({ fetch: fetchLike });
		await p.access("a");
		await p.access("b");
		expect(calls.filter((c) => c.url.includes("jwt/login")).length).toBe(2);
	});

	it("defaults the lease when the server does not state one", async () => {
		const { calls, fetchLike } = transport(
			{ json: () => ({ auth: { client_token: "s.t" } }) },
			{ json: () => ({ data: { data: { value: "v" } } }) },
		);
		const p = port({ fetch: fetchLike });
		await p.access("a");
		await p.access("b");
		expect(calls.filter((c) => c.url.includes("jwt/login")).length).toBe(1);
	});
});

describe("the live write path", () => {
	it("posts the value and reads back the version", async () => {
		const { calls, fetchLike } = transport(LOGIN_OK, {
			json: () => ({ data: { version: 4 } }),
		});
		const result = await port({ fetch: fetchLike }).put("db", "value");
		expect(result.versionId).toBe("obv4");
		expect(calls[1]?.init.method).toBe("POST");
	});

	it("derives a version from the value when the server states none", async () => {
		// A put that reports no version still has to produce a stable id, or the
		// caller cannot reference what it just wrote.
		const { fetchLike } = transport(LOGIN_OK, { json: () => ({ data: {} }) });
		const result = await port({ fetch: fetchLike }).put("db", "value");
		expect(result.versionId).toMatch(/^obv-/u);
	});
});

describe("the port's identity", () => {
	it("reports the openbao kind", () => {
		expect(port().kind).toBe("openbao");
	});

	it("takes an explicit id", () => {
		expect(port({ id: "custom" }).id).toBe("custom");
	});
});
