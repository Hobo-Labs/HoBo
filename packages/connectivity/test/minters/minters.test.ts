/**
 * L39 / O45: overlay join credentials are single use, short-lived and
 * tag-scoped. Each minter runs against a recording fake `fetch`.
 */

import { parseTenantId } from "@hobo/core";
import { type MemberId, parseMemberId } from "@hobo/fleet";
import { describe, expect, it, vi } from "vitest";
import { type JsonObject, parseJsonObject } from "../../src/json.js";
import {
	createNetbirdCredentialMinter,
	createTailscaleCredentialMinter,
	type OverlayMinterOptions,
} from "../../src/minters/index.js";

const TAILSCALE_KEY = "tskey-auth-kSECRETSECRET-CNTRLsecretsecretsecret";
const NETBIRD_KEY = "A616097E-FCF0-48FA-9354-CA4A61142761";
const API_TOKEN = "operator-api-token-do-not-log";

const tenant = parseTenantId("acme");
const memberId: MemberId = parseMemberId(
	"dev_0123456789abcdef0123456789abcdef",
);

type Recorded = Readonly<{
	url: string;
	method: string;
	headers: Headers;
	body: string;
	redirect: RequestRedirect | undefined;
}>;

type Reply = Readonly<{ status: number; body: string }>;

/** A fake `fetch` and the requests it was given, in order. */
type RecordingFetch = Readonly<{ fetch: typeof fetch; calls: Recorded[] }>;

function recordingFetch(
	reply: (request: Recorded) => Reply | Error,
): RecordingFetch {
	const calls: Recorded[] = [];
	const fake: typeof fetch = async (input, init) => {
		const url =
			input instanceof Request
				? input.url
				: input instanceof URL
					? input.toString()
					: input;
		const body = init?.body;
		const recorded: Recorded = {
			url,
			method: (init?.method ?? "GET").toUpperCase(),
			headers: new Headers(init?.headers),
			body: body === undefined || body === null ? "" : String(body),
			redirect: init?.redirect,
		};
		calls.push(recorded);
		const result = reply(recorded);
		if (result instanceof Error) throw result;
		return new Response(result.body, {
			status: result.status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch: fake, calls };
}

function options(
	fetchImpl: typeof fetch,
	overrides: Partial<OverlayMinterOptions> = {},
): OverlayMinterOptions {
	return {
		apiBase: "https://api.example.test",
		organisation: "example.com",
		credential: async () => API_TOKEN,
		fetch: fetchImpl,
		...overrides,
	};
}

function bodyOf(call: Recorded | undefined): JsonObject {
	expect(call).toBeDefined();
	return parseJsonObject(call?.body ?? "{}");
}

/** Everything written to the console or to stdout/stderr while `run` executes. */
async function captureOutput<T>(
	run: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
	const lines: string[] = [];
	const sink = (...args: readonly unknown[]): void => {
		lines.push(args.map((a) => String(a)).join(" "));
	};
	const spies = [
		vi.spyOn(console, "log").mockImplementation(sink),
		vi.spyOn(console, "info").mockImplementation(sink),
		vi.spyOn(console, "warn").mockImplementation(sink),
		vi.spyOn(console, "error").mockImplementation(sink),
		vi.spyOn(console, "debug").mockImplementation(sink),
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			lines.push(String(chunk));
			return true;
		}),
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			lines.push(String(chunk));
			return true;
		}),
	];
	try {
		const value = await run();
		return { value, lines };
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
}

describe("createTailscaleCredentialMinter", () => {
	const okReply: Reply = {
		status: 200,
		body: JSON.stringify({
			id: "kABC123CNTRL",
			key: TAILSCALE_KEY,
			created: "2026-11-13T10:00:00Z",
			expires: "2026-11-13T10:10:00Z",
			capabilities: {
				devices: {
					create: {
						reusable: false,
						ephemeral: false,
						preauthorized: true,
						tags: ["tag:fleet-ci", "tag:gpu"],
					},
				},
			},
		}),
	};

	it("asks for one non-reusable, pre-authorised key with the expiry and exactly the tags", async () => {
		const { fetch, calls } = recordingFetch(() => okReply);
		const minter = createTailscaleCredentialMinter(options(fetch));
		expect(minter.provider).toBe("tailscale");

		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: ["tag:fleet-ci", "tag:gpu"],
			ttlMs: 600_000,
		});

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.method).toBe("POST");
		expect(call?.url).toBe(
			"https://api.example.test/api/v2/tailnet/example.com/keys",
		);
		expect(call?.headers.get("authorization")).toBe(`Bearer ${API_TOKEN}`);
		expect(call?.headers.get("content-type")).toContain("application/json");
		expect(call?.redirect).toBe("error");
		const body = bodyOf(call);
		expect(body.expirySeconds).toBe(600);
		expect(body.capabilities).toEqual({
			devices: {
				create: {
					reusable: false,
					ephemeral: false,
					preauthorized: true,
					tags: ["tag:fleet-ci", "tag:gpu"],
				},
			},
		});
		expect(String(body.description)).toMatch(/^[A-Za-z0-9 -]{1,50}$/);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.$typeName).toBe("hobo.fleet.v1.OverlayJoin");
		expect(outcome.value.provider).toBe("tailscale");
		expect(outcome.value.credential).toBe(TAILSCALE_KEY);
		expect(outcome.value.expiresAt).toBe("2026-11-13T10:10:00Z");
		expect(outcome.value.tags).toEqual(["tag:fleet-ci", "tag:gpu"]);
	});

	it("prefixes bare fleet tags with tag: and keeps exactly that set", async () => {
		const { fetch, calls } = recordingFetch(() => okReply);
		const minter = createTailscaleCredentialMinter(options(fetch));
		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: ["fleet-ci", "tag:gpu", "fleet-ci"],
			ttlMs: 600_000,
		});
		expect(bodyOf(calls[0]).capabilities).toEqual({
			devices: {
				create: expect.objectContaining({ tags: ["tag:fleet-ci", "tag:gpu"] }),
			},
		});
		expect(outcome.ok && outcome.value.tags).toEqual([
			"tag:fleet-ci",
			"tag:gpu",
		]);
	});

	it("rounds a sub-second remainder of ttlMs up to whole seconds", async () => {
		const { fetch, calls } = recordingFetch(() => okReply);
		const minter = createTailscaleCredentialMinter(options(fetch));
		await minter.mint({ tenant, memberId, tags: [], ttlMs: 90_500 });
		expect(bodyOf(calls[0]).expirySeconds).toBe(91);
	});

	it("refuses a malformed tag or a non-positive ttl without calling the provider", async () => {
		const { fetch, calls } = recordingFetch(() => okReply);
		const minter = createTailscaleCredentialMinter(options(fetch));
		const badTag = await minter.mint({
			tenant,
			memberId,
			tags: ["tag:Has Space"],
			ttlMs: 600_000,
		});
		const badTtl = await minter.mint({ tenant, memberId, tags: [], ttlMs: 0 });
		expect(badTag.ok).toBe(false);
		expect(!badTag.ok && badTag.error.code).toBe("invalid-request");
		expect(badTtl.ok).toBe(false);
		expect(!badTtl.ok && badTtl.error.code).toBe("invalid-request");
		expect(calls).toHaveLength(0);
	});

	it.each([
		[
			"a 403 from the provider",
			() => ({ status: 403, body: '{"message":"forbidden"}' }),
		],
		["a 500 from the provider", () => ({ status: 500, body: "oops" })],
		["a network failure", () => new TypeError("fetch failed")],
		["a 200 without a key", () => ({ status: 200, body: '{"id":"k1"}' })],
		["a 200 that is not JSON", () => ({ status: 200, body: "<html>" })],
	])("returns unavailable on %s", async (_label, reply) => {
		const { fetch } = recordingFetch(reply);
		const minter = createTailscaleCredentialMinter(options(fetch));
		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: ["tag:fleet-ci"],
			ttlMs: 600_000,
		});
		expect(outcome.ok).toBe(false);
		expect(!outcome.ok && outcome.error.code).toBe("unavailable");
		expect(JSON.stringify(outcome)).not.toContain(API_TOKEN);
	});

	it("returns unavailable when the API token cannot be read", async () => {
		const { fetch, calls } = recordingFetch(() => okReply);
		const minter = createTailscaleCredentialMinter(
			options(fetch, {
				credential: async () => {
					throw new Error("secret store down");
				},
			}),
		);
		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: [],
			ttlMs: 600_000,
		});
		expect(!outcome.ok && outcome.error.code).toBe("unavailable");
		expect(calls).toHaveLength(0);
	});

	it("writes no output line carrying the credential or the API token", async () => {
		const { fetch } = recordingFetch(() => okReply);
		const minter = createTailscaleCredentialMinter(options(fetch));
		const { value, lines } = await captureOutput(() =>
			minter.mint({ tenant, memberId, tags: ["tag:fleet-ci"], ttlMs: 600_000 }),
		);
		expect(value.ok).toBe(true);
		for (const line of lines) {
			expect(line).not.toContain(TAILSCALE_KEY);
			expect(line).not.toContain(API_TOKEN);
		}
	});
});

describe("createNetbirdCredentialMinter", () => {
	const groups = [
		{ id: "grp-ci-0001", name: "fleet-ci" },
		{ id: "grp-gpu-0002", name: "gpu" },
		{ id: "grp-all-0003", name: "All" },
	];

	function netbirdReply(request: Recorded): Reply {
		if (request.method === "GET" && request.url.endsWith("/api/groups")) {
			return { status: 200, body: JSON.stringify(groups) };
		}
		if (request.method === "POST" && request.url.endsWith("/api/setup-keys")) {
			const sent = parseJsonObject(request.body);
			return {
				status: 200,
				body: JSON.stringify({
					id: 2531583362,
					key: NETBIRD_KEY,
					name: sent.name,
					expires: "2026-11-14T10:00:00Z",
					type: "one-off",
					valid: true,
					revoked: false,
					used_times: 0,
					state: "valid",
					auto_groups: sent.auto_groups,
					usage_limit: 1,
					ephemeral: false,
				}),
			};
		}
		return { status: 404, body: "{}" };
	}

	it("asks for a one-off setup key with usage limit 1, the expiry and exactly the tags' groups", async () => {
		const { fetch, calls } = recordingFetch(netbirdReply);
		const minter = createNetbirdCredentialMinter(options(fetch));
		expect(minter.provider).toBe("netbird");

		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: ["fleet-ci", "gpu"],
			ttlMs: 600_000,
		});

		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET https://api.example.test/api/groups",
			"POST https://api.example.test/api/setup-keys",
		]);
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe(`Token ${API_TOKEN}`);
			expect(call.redirect).toBe("error");
		}
		const body = bodyOf(calls[1]);
		expect(body.type).toBe("one-off");
		expect(body.usage_limit).toBe(1);
		expect(body.ephemeral).toBe(false);
		expect(body.auto_groups).toEqual(["grp-ci-0001", "grp-gpu-0002"]);
		// NetBird refuses an expiry under one day (A13): the shortest it allows is asked for.
		expect(body.expires_in).toBe(86_400);
		expect(String(body.name)).toContain("hobo-fleet");

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.$typeName).toBe("hobo.fleet.v1.OverlayJoin");
		expect(outcome.value.provider).toBe("netbird");
		expect(outcome.value.credential).toBe(NETBIRD_KEY);
		expect(outcome.value.expiresAt).toBe("2026-11-14T10:00:00Z");
		expect(outcome.value.tags).toEqual(["fleet-ci", "gpu"]);
	});

	it("asks for exactly ttlMs when it is at least a day", async () => {
		const { fetch, calls } = recordingFetch(netbirdReply);
		const minter = createNetbirdCredentialMinter(options(fetch));
		await minter.mint({ tenant, memberId, tags: [], ttlMs: 2 * 86_400_000 });
		// No tags: no group lookup, and the key joins no group.
		expect(calls).toHaveLength(1);
		expect(bodyOf(calls[0]).expires_in).toBe(172_800);
		expect(bodyOf(calls[0]).auto_groups).toEqual([]);
	});

	it("refuses a tag with no NetBird group and mints nothing", async () => {
		const { fetch, calls } = recordingFetch(netbirdReply);
		const minter = createNetbirdCredentialMinter(options(fetch));
		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: ["fleet-ci", "no-such-group"],
			ttlMs: 600_000,
		});
		expect(!outcome.ok && outcome.error.code).toBe("invalid-request");
		expect(!outcome.ok && outcome.error.detail?.tag).toBe("no-such-group");
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
	});

	it.each([
		[
			"the group lookup fails",
			(r: Recorded) =>
				r.method === "GET" ? { status: 401, body: "{}" } : netbirdReply(r),
		],
		[
			"the setup-key request fails",
			(r: Recorded) =>
				r.method === "POST"
					? { status: 422, body: '{"message":"bad"}' }
					: netbirdReply(r),
		],
		["the network fails", () => new TypeError("fetch failed")],
		[
			"the reply has no key",
			(r: Recorded) =>
				r.method === "POST"
					? { status: 200, body: '{"id":1}' }
					: netbirdReply(r),
		],
	])("returns unavailable when %s", async (_label, reply) => {
		const { fetch } = recordingFetch(reply);
		const minter = createNetbirdCredentialMinter(options(fetch));
		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: ["fleet-ci"],
			ttlMs: 600_000,
		});
		expect(!outcome.ok && outcome.error.code).toBe("unavailable");
		expect(JSON.stringify(outcome)).not.toContain(API_TOKEN);
	});

	it("writes no output line carrying the credential or the API token", async () => {
		const { fetch } = recordingFetch(netbirdReply);
		const minter = createNetbirdCredentialMinter(options(fetch));
		const { value, lines } = await captureOutput(() =>
			minter.mint({ tenant, memberId, tags: ["gpu"], ttlMs: 600_000 }),
		);
		expect(value.ok).toBe(true);
		for (const line of lines) {
			expect(line).not.toContain(NETBIRD_KEY);
			expect(line).not.toContain(API_TOKEN);
		}
	});
});

describe("minter construction", () => {
	it("does not throw and makes no request until mint is called", () => {
		const { fetch, calls } = recordingFetch(() => ({ status: 500, body: "" }));
		createTailscaleCredentialMinter(options(fetch));
		createNetbirdCredentialMinter(options(fetch));
		expect(calls).toHaveLength(0);
	});
});
