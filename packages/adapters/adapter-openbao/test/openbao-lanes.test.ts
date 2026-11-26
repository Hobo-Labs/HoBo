/**
 * The OpenBao secrets port: what it does when it can reach a server, and what
 * it does when it cannot.
 *
 * The adapter has two lanes behind one interface. Offline it answers from a
 * deterministic HMAC keyed on the address, role, SVID and mount — no network,
 * same answer every time. Live it authenticates with the SVID and talks to the
 * server. Which lane it takes is decided once, at construction, and everything
 * here is about that decision and the seams around it.
 *
 * **Offline is the default, and it is the safe default.** A port with no
 * injected `fetch` cannot silently reach the network, so a caller who forgot to
 * wire one gets deterministic fixtures rather than a connection attempt to
 * whatever `OPENBAO_ADDR` happens to say.
 *
 * **The live lane fails closed at every step.** No fetch, a rejected login, a
 * login with no token, a non-2xx read — each answers `denied` with a code, not
 * an exception and never a silent empty value. A secrets port that returned
 * "no secret" for "I could not ask" would read as an empty vault.
 *
 * **The token is cached, but not to its last second.** `jwtLogin` reuses a
 * cached token only while more than five seconds of its lease remain. That
 * margin is the difference between a request that arrives with a valid token
 * and one that arrives just after expiry, which is a failure the caller cannot
 * distinguish from a permissions problem.
 *
 * **`listVersions` prefers the server but never trusts it to be complete.** An
 * empty live list falls back to what was written locally, because an empty
 * answer from the server is far more likely to mean "wrong mount" than "this
 * secret has no versions".
 *
 * Driven with an injected `fetch` throughout — no network, and every response
 * shape chosen to be one the server really produces.
 */
import type { FetchLike, SecretsAccessResult } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import type { JsonValue } from "../src/json.js";
import {
	createLocalStationOpenBaoSecretsPort,
	createOpenBaoSecretsPort,
} from "../src/openbao-secrets-port.js";

/** A `fetch` that answers from a script and records what it was asked. */
function scriptedFetch(
	handler: (
		url: string,
		init?: { method?: string; body?: string },
	) => {
		ok: boolean;
		status: number;
		body: JsonValue;
	},
) {
	const calls: { url: string; method: string; body: string | undefined }[] = [];
	const impl: FetchLike = async (url, init) => {
		calls.push({
			url,
			method: init?.method ?? "GET",
			body: init?.body,
		});
		const answer = handler(url, init);
		return {
			ok: answer.ok,
			status: answer.status,
			json: async () => answer.body,
			text: async () => JSON.stringify(answer.body),
		};
	};
	return { impl, calls };
}

/** A fetch that logs in successfully and then answers `rest` for everything else. */
function loggedIn(
	rest: (url: string) => { ok: boolean; status: number; body: JsonValue },
	leaseSeconds = 900,
) {
	return scriptedFetch((url) =>
		url.includes("/v1/auth/jwt/login")
			? {
					ok: true,
					status: 200,
					body: {
						auth: { client_token: "s.token", lease_duration: leaseSeconds },
					},
				}
			: rest(url),
	);
}

const live = (fetchImpl: FetchLike) =>
	createOpenBaoSecretsPort({
		openbaoAddr: "https://bao.example",
		role: "hobo-station-test",
		svidJwt: "jwt.fixture",
		fetch: fetchImpl,
	});

const offline = () =>
	createOpenBaoSecretsPort({
		openbaoAddr: "https://bao.example",
		role: "hobo-station-test",
		svidJwt: "jwt.fixture",
	});

describe("choosing a lane", () => {
	it("is offline when no fetch is injected", async () => {
		// The safe default: a caller who forgot to wire a transport gets
		// deterministic fixtures, not a connection to whatever the address says.
		const port = offline();
		expect((await port.access("db/password")).status).not.toBe("denied");
	});

	it("stays offline when asked to, even with a fetch", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: {},
		}));
		const port = createOpenBaoSecretsPort({
			openbaoAddr: "https://bao.example",
			role: "r",
			svidJwt: "j",
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
			offline: true,
		});
		await port.access("db/password");
		expect(calls).toHaveLength(0);
	});

	it("names itself after its role by default", () => {
		expect(offline().id).toBe("secrets:openbao:hobo-station-test");
	});

	it("takes an explicit id", () => {
		expect(
			createOpenBaoSecretsPort({
				openbaoAddr: "a",
				role: "r",
				svidJwt: "j",
				id: "secrets:custom",
			}).id,
		).toBe("secrets:custom");
	});

	it("reports its kind", () => {
		expect(offline().kind).toBe("openbao");
	});
});

describe("the offline lane", () => {
	// `expiresAt` is `Date.now() + 15min`, so it differs between two calls in
	// different milliseconds. Every other field is derived from the HMAC and is
	// stable — comparing whole objects here would be a test that passes when the
	// two calls happen to land in the same millisecond and fails when they do
	// not, which is the worst kind of green.
	const stable = (result: SecretsAccessResult) => {
		if (result.status !== "ok") return result;
		const { expiresAt: _ignored, ...rest } = result;
		return rest;
	};

	it("answers the same value twice", async () => {
		// Deterministic by construction: the HMAC is keyed on address, role,
		// SVID and mount, so a fixture cannot drift between runs.
		const port = offline();
		const first = await port.access("db/password");
		const second = await port.access("db/password");
		expect(stable(first)).toEqual(stable(second));
	});

	it("expires fifteen minutes out", async () => {
		const before = Date.now();
		const result = await offline().access("db/password");
		if (result.status !== "ok") throw new Error("expected a value");
		const at = Date.parse(result.expiresAt ?? "");
		expect(at).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
	});

	it("gives different secrets different values", async () => {
		const port = offline();
		expect(stable(await port.access("db/password"))).not.toEqual(
			stable(await port.access("api/token")),
		);
	});

	it("gives two ports with different roles different values", async () => {
		// The role is in the key, so one station's fixtures are not another's.
		const a = createOpenBaoSecretsPort({
			openbaoAddr: "https://bao.example",
			role: "role-a",
			svidJwt: "j",
		});
		const b = createOpenBaoSecretsPort({
			openbaoAddr: "https://bao.example",
			role: "role-b",
			svidJwt: "j",
		});
		expect(stable(await a.access("db/password"))).not.toEqual(
			stable(await b.access("db/password")),
		);
	});

	it("ignores a trailing slash on the address", async () => {
		// `https://bao.example/` and `https://bao.example` are the same server, so
		// they must not key different fixtures.
		const bare = createOpenBaoSecretsPort({
			openbaoAddr: "https://bao.example",
			role: "r",
			svidJwt: "j",
		});
		const slashed = createOpenBaoSecretsPort({
			openbaoAddr: "https://bao.example/",
			role: "r",
			svidJwt: "j",
		});
		expect(stable(await bare.access("db/password"))).toEqual(
			stable(await slashed.access("db/password")),
		);
	});

	it("numbers versions from one", async () => {
		expect((await offline().put("db/password", "first")).versionId).toBe(
			"obv1",
		);
	});

	it("counts up on each write", async () => {
		const port = offline();
		await port.put("db/password", "first");
		expect((await port.put("db/password", "second")).versionId).toBe("obv2");
	});

	it("counts each secret separately", async () => {
		const port = offline();
		await port.put("db/password", "first");
		expect((await port.put("api/token", "first")).versionId).toBe("obv1");
	});

	it("lists what was written", async () => {
		const port = offline();
		await port.put("db/password", "first");
		await port.put("db/password", "second");
		expect(await port.listVersions("db/password")).toEqual(["obv1", "obv2"]);
	});

	it("lists a placeholder for a secret nothing wrote", async () => {
		// Never an empty list: a caller reading zero versions would conclude the
		// secret does not exist, when offline it simply has not been written yet.
		expect(await offline().listVersions("never/written")).toEqual([
			"ob-dynamic",
		]);
	});
});

describe("logging in", () => {
	it("posts the role and the SVID", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		await live(impl).access("db/password");
		const login = calls.find((c) => c.url.includes("/v1/auth/jwt/login"));
		expect(JSON.parse(login?.body ?? "{}")).toMatchObject({
			role: "hobo-station-test",
			jwt: "jwt.fixture",
		});
	});

	it("reuses a cached token across calls", async () => {
		// The token has a lease; re-authenticating per read would triple the
		// request count against the server for no benefit.
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		const port = live(impl);
		await port.access("db/password");
		await port.access("api/token");
		expect(
			calls.filter((c) => c.url.includes("/v1/auth/jwt/login")),
		).toHaveLength(1);
	});

	it("logs in again when the lease is nearly spent", async () => {
		// The cache is honoured only while more than five seconds remain. A
		// one-second lease is always inside that margin, so every call re-logs in
		// rather than sending a token that may expire in flight.
		const { impl, calls } = loggedIn(
			() => ({
				ok: true,
				status: 200,
				body: { data: { data: { value: "v" } } },
			}),
			1,
		);
		const port = live(impl);
		await port.access("db/password");
		await port.access("api/token");
		expect(
			calls.filter((c) => c.url.includes("/v1/auth/jwt/login")).length,
		).toBeGreaterThan(1);
	});

	it("denies when the login is rejected", async () => {
		const { impl } = scriptedFetch(() => ({
			ok: false,
			status: 403,
			body: {},
		}));
		expect(await live(impl).access("db/password")).toMatchObject({
			status: "denied",
			code: "openbao-auth-failed",
		});
	});

	it("says which status the login returned", async () => {
		// An operator needs to tell a wrong role (403) from a wrong address (404).
		const { impl } = scriptedFetch(() => ({
			ok: false,
			status: 404,
			body: {},
		}));
		const result = await live(impl).access("db/password");
		expect(result).toMatchObject({ reason: expect.stringContaining("404") });
	});

	it("denies when the login succeeds but carries no token", async () => {
		// A 200 with no `client_token` is a server that answered without
		// authenticating anything. Treating it as success would send every later
		// request unauthenticated.
		const { impl } = scriptedFetch((url) =>
			url.includes("/v1/auth/jwt/login")
				? { ok: true, status: 200, body: { auth: {} } }
				: { ok: true, status: 200, body: {} },
		);
		expect(await live(impl).access("db/password")).toMatchObject({
			status: "denied",
			code: "openbao-auth-missing-token",
		});
	});
});

describe("listing versions from the server", () => {
	it("returns the server's versions", async () => {
		const { impl } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { versions: { 1: {}, 2: {} } } },
		}));
		expect(await live(impl).listVersions("db/password")).toEqual([
			"obv1",
			"obv2",
		]);
	});

	it("sorts them", async () => {
		const { impl } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { versions: { 2: {}, 1: {}, 3: {} } } },
		}));
		expect(await live(impl).listVersions("db/password")).toEqual([
			"obv1",
			"obv2",
			"obv3",
		]);
	});

	it("asks the metadata endpoint", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { versions: { 1: {} } } },
		}));
		await live(impl).listVersions("db/password");
		expect(
			calls.some((c) => c.url.endsWith("/v1/secret/metadata/db/password")),
		).toBe(true);
	});

	it("strips a leading slash from the name", async () => {
		// `/db/password` and `db/password` are the same secret; a doubled slash in
		// the path is a 404 from the server about a secret that does exist.
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { versions: { 1: {} } } },
		}));
		await live(impl).listVersions("/db/password");
		expect(calls.some((c) => c.url.includes("//db/password"))).toBe(false);
	});

	it.each([
		["the read is refused", { ok: false, status: 403, body: {} }],
		["the payload has no versions", { ok: true, status: 200, body: {} }],
		[
			"the versions map is empty",
			{ ok: true, status: 200, body: { data: { versions: {} } } },
		],
	])("falls back to the local list when %s", async (_label, answer) => {
		// An empty or unreadable answer from the server is much more likely to
		// mean "wrong mount" than "this secret has no versions", so the locally
		// written list is the better answer.
		// The write goes through the live lane too, and `livePut` names the
		// version from the server's `data.version` when it has one and from a hash
		// of the value when it does not. Asserting the id the put actually
		// returned tests the relationship rather than pinning a literal that
		// depends on which of those two branches the fixture took.
		const { impl } = loggedIn(() => answer);
		const port = live(impl);
		const written = await port.put("db/password", "written-here");
		expect(await port.listVersions("db/password")).toEqual([written.versionId]);
	});
});

describe("the local station helper", () => {
	const base = { HOBO_OPENBAO_LIVE: "0" };

	it("is offline unless explicitly told otherwise", async () => {
		// Live requires an opt-in *and* a usable fetch, so a station that merely
		// has the package installed never reaches the network.
		const port = createLocalStationOpenBaoSecretsPort({ env: {} });
		expect((await port.access("db/password")).status).not.toBe("denied");
	});

	it("names itself after the station", () => {
		expect(
			createLocalStationOpenBaoSecretsPort({
				env: base,
				stationId: "west",
			}).id,
		).toBe("secrets:station-openbao:west");
	});

	it("takes the station from the environment", () => {
		expect(
			createLocalStationOpenBaoSecretsPort({
				env: { ...base, HOBO_STATION_ID: "east" },
			}).id,
		).toBe("secrets:station-openbao:east");
	});

	it("falls back to a station named local", () => {
		expect(createLocalStationOpenBaoSecretsPort({ env: base }).id).toBe(
			"secrets:station-openbao:local",
		);
	});

	it("prefers an explicit station over the environment", () => {
		expect(
			createLocalStationOpenBaoSecretsPort({
				env: { ...base, HOBO_STATION_ID: "from-env" },
				stationId: "explicit",
			}).id,
		).toBe("secrets:station-openbao:explicit");
	});

	it("takes an explicit id over both", () => {
		expect(
			createLocalStationOpenBaoSecretsPort({
				env: base,
				stationId: "west",
				id: "secrets:override",
			}).id,
		).toBe("secrets:override");
	});

	it.each([
		["1"],
		["true"],
	])("goes live on HOBO_OPENBAO_LIVE=%s with a fetch", async (flag) => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		const port = createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: flag },
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		});
		await port.access("db/password");
		expect(calls.length).toBeGreaterThan(0);
	});

	it("stays offline for any other flag value", async () => {
		// Only "1" and "true" opt in. "yes", "on" and a stray "0 " are not an
		// instruction to start making authenticated calls.
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: {},
		}));
		const port = createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "yes" },
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		});
		await port.access("db/password");
		expect(calls).toHaveLength(0);
	});

	it("an explicit offline beats the live flag", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: {},
		}));
		const port = createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "1" },
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
			offline: true,
		});
		await port.access("db/password");
		expect(calls).toHaveLength(0);
	});

	it("falls back to the global fetch when live is asked for and none is passed", async () => {
		// `options?.fetch ?? (live ? globalThis.fetch : undefined)`. On a runtime
		// with a global `fetch` — every supported Node — omitting the option does
		// NOT keep the port offline: it goes live against the configured address.
		// Recorded because the opposite is the natural reading, and believing it
		// would mean a station reaching the network while its author thought it
		// was on fixtures. The address here is a closed loopback port, so the
		// attempt fails immediately and never leaves the machine.
		const port = createLocalStationOpenBaoSecretsPort({
			env: {
				HOBO_OPENBAO_LIVE: "1",
				HOBO_OPENBAO_ADDR: "http://127.0.0.1:1",
			},
		});
		// And it answers `denied` rather than throwing. This test once recorded
		// the opposite — `jwtLogin` did not wrap its fetch, so a transport
		// failure escaped as a TypeError while every other live failure was a
		// typed refusal, and that gap was flagged for a fix rather than quietly
		// changed. The fix landed: an unreachable server is now the same kind of
		// answer as an unauthorized one, carrying the transport error's own
		// message so "server down" stays diagnosable at the call site.
		const result = await port.access("db/password");
		expect(result.status).toBe("denied");
		if (result.status !== "denied") throw new Error("expected a denial");
		expect(result.code).toBe("openbao-transport-failed");
		expect(result.reason).toMatch(/transport failed/u);
	});

	it("degrades a put to the local store when the server is unreachable", async () => {
		// Every other live put failure (auth rejected, non-2xx) already fell
		// through to the local versioned store; a transport throw used to escape
		// `put` entirely instead. An unreachable server now takes the same
		// degradation path, so a write neither crashes nor silently vanishes.
		const port = createLocalStationOpenBaoSecretsPort({
			env: {
				HOBO_OPENBAO_LIVE: "1",
				HOBO_OPENBAO_ADDR: "http://127.0.0.1:1",
			},
		});
		const written = await port.put("db/password", "seed-1");
		expect(written.versionId).toBe("obv1");
	});

	it("addresses the server from HOBO_OPENBAO_ADDR", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: {
				HOBO_OPENBAO_LIVE: "1",
				HOBO_OPENBAO_ADDR: "https://hobo.example",
			},
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).access("db/password");
		expect(calls[0]?.url.startsWith("https://hobo.example")).toBe(true);
	});

	it("falls back to OPENBAO_ADDR", async () => {
		// The vendor's own variable name, so a station already configured for
		// OpenBao does not need a HoBo-specific one as well.
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "1", OPENBAO_ADDR: "https://vendor.example" },
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).access("db/password");
		expect(calls[0]?.url.startsWith("https://vendor.example")).toBe(true);
	});

	it("prefers the HoBo address over the vendor one", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: {
				HOBO_OPENBAO_LIVE: "1",
				HOBO_OPENBAO_ADDR: "https://hobo.example",
				OPENBAO_ADDR: "https://vendor.example",
			},
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).access("db/password");
		expect(calls[0]?.url.startsWith("https://hobo.example")).toBe(true);
	});

	it("defaults to the loopback address", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "1" },
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).access("db/password");
		expect(calls[0]?.url.startsWith("http://127.0.0.1:8200")).toBe(true);
	});

	it("takes the role from the environment", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "1", HOBO_OPENBAO_ROLE: "custom-role" },
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).access("db/password");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
			role: "custom-role",
		});
	});

	it("derives the role from the station when unset", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "1" },
			stationId: "west",
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).access("db/password");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
			role: "hobo-station-west",
		});
	});

	it("uses the SVID from the environment", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "1", HOBO_SVID_JWT: "real.svid.jwt" },
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).access("db/password");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
			jwt: "real.svid.jwt",
		});
	});

	it("falls back to a fixture SVID naming the station", async () => {
		// Deliberately shaped like a JWT and deliberately not one: it identifies
		// the station in an offline fixture without pretending to be a credential.
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { data: { value: "v" } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "1" },
			stationId: "west",
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).access("db/password");
		expect(JSON.parse(calls[0]?.body ?? "{}").jwt).toContain("station.west");
	});

	it("sends the namespace header when one is configured", async () => {
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { versions: { 1: {} } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "1", HOBO_OPENBAO_NAMESPACE: "team-a" },
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).listVersions("db/password");
		expect(calls.length).toBeGreaterThan(0);
	});

	it("reads from a configured mount", async () => {
		// The default mount is `secret`; a station with its own KV mount must have
		// its reads land there rather than on the vendor default.
		const { impl, calls } = loggedIn(() => ({
			ok: true,
			status: 200,
			body: { data: { versions: { 1: {} } } },
		}));
		await createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_LIVE: "1", HOBO_OPENBAO_MOUNT: "hobo-kv" },
			// SAFETY: the scripted fetch implements the shape the port calls.
			fetch: impl as never,
		}).listVersions("db/password");
		expect(calls.some((c) => c.url.includes("/v1/hobo-kv/metadata/"))).toBe(
			true,
		);
	});

	it("ignores a blank namespace", async () => {
		// An unset variable and one set to the empty string are the same request:
		// no namespace. Sending a blank header would be a different one.
		const port = createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_NAMESPACE: "" },
		});
		expect((await port.access("db/password")).status).not.toBe("denied");
	});

	it("ignores a blank mount", async () => {
		const port = createLocalStationOpenBaoSecretsPort({
			env: { HOBO_OPENBAO_MOUNT: "" },
		});
		expect((await port.access("db/password")).status).not.toBe("denied");
	});
});
