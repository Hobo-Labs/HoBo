/**
 * The Turso environment helper: names only, never values, and an HTTP client
 * that opens no connection until a port call.
 */
import { parseEphemeralKey } from "@hobo/core";
import { KvRedisCompatibleError } from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";

import {
	createTursoEphemeralState,
	resolveTursoEnv,
	TURSO_ENV_NAMES,
} from "../src/index.js";

const SECRET_TOKEN = "not-a-real-token-but-must-never-be-echoed";
const URL_VALUE = "libsql://relay-cache-example.turso.io";

function caught(run: () => void): Error {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error;
	}
	throw new Error("expected a throw");
}

describe("resolveTursoEnv", () => {
	it("is undefined when neither variable is set", () => {
		expect(resolveTursoEnv({})).toBeUndefined();
	});

	it("reads the Marketplace pair and reports the names it used", () => {
		expect(
			resolveTursoEnv({
				TURSO_DATABASE_URL: URL_VALUE,
				TURSO_AUTH_TOKEN: SECRET_TOKEN,
			}),
		).toEqual({
			source: TURSO_ENV_NAMES,
			url: URL_VALUE,
			authToken: SECRET_TOKEN,
		});
	});

	it("prepends a prefix verbatim to both names", () => {
		const resolved = resolveTursoEnv(
			{
				CACHE_TURSO_DATABASE_URL: URL_VALUE,
				CACHE_TURSO_AUTH_TOKEN: SECRET_TOKEN,
				TURSO_DATABASE_URL: "libsql://other.turso.io",
			},
			{ prefix: "CACHE_" },
		);
		expect(resolved?.source).toEqual({
			url: "CACHE_TURSO_DATABASE_URL",
			token: "CACHE_TURSO_AUTH_TOKEN",
		});
		expect(resolved?.url).toBe(URL_VALUE);
	});

	it("names the missing half of a pair and never quotes a value", () => {
		const error = caught(() =>
			resolveTursoEnv({ TURSO_AUTH_TOKEN: SECRET_TOKEN }),
		);
		expect(error).toBeInstanceOf(KvRedisCompatibleError);
		expect(error.message).toContain("TURSO_DATABASE_URL is not set");
		expect(error.message).not.toContain(SECRET_TOKEN);
	});

	it.each([
		["a file: URL", "file:/var/data/cache.db"],
		["plain http to a remote host", "http://relay-cache.turso.io"],
		["credentials in the URL", `https://user:${SECRET_TOKEN}@relay.turso.io`],
		["not a URL", "relay cache"],
	])("refuses %s without echoing it", (_name, url) => {
		const error = caught(() =>
			resolveTursoEnv({
				TURSO_DATABASE_URL: url,
				TURSO_AUTH_TOKEN: SECRET_TOKEN,
			}),
		);
		expect(error.message).toContain("TURSO_DATABASE_URL is not a libsql:");
		expect(error.message).not.toContain(url);
		expect(error.message).not.toContain(SECRET_TOKEN);
	});

	it("refuses a prefix that is not an environment-variable name", () => {
		expect(() => resolveTursoEnv({}, { prefix: "cache-" })).toThrow(
			KvRedisCompatibleError,
		);
	});
});

describe("createTursoEphemeralState", () => {
	it("is undefined without a configured database", () => {
		expect(createTursoEphemeralState({ env: {} })).toBeUndefined();
	});

	it("sends a libsql: URL over HTTPS fetch with the token as a bearer header, and nothing before a call", async () => {
		const requests: { url: string; authorization: string | null }[] = [];
		const fetchImpl: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			requests.push({
				url: request.url,
				authorization: request.headers.get("authorization"),
			});
			return new Response("unavailable", { status: 503 });
		};
		const binding = createTursoEphemeralState({
			env: { TURSO_DATABASE_URL: URL_VALUE, TURSO_AUTH_TOKEN: SECRET_TOKEN },
			fetch: fetchImpl,
		});
		expect(binding?.source).toEqual(TURSO_ENV_NAMES);
		expect(requests).toEqual([]);

		await expect(
			binding?.port.get(parseEphemeralKey("env:probe")),
		).rejects.toBeDefined();
		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) {
			expect(new URL(request.url).protocol).toBe("https:");
			expect(new URL(request.url).hostname).toBe(
				"relay-cache-example.turso.io",
			);
			expect(request.authorization).toBe(`Bearer ${SECRET_TOKEN}`);
		}
		binding?.close();
	});
});
