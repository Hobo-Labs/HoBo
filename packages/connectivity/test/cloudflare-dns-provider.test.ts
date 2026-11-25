/**
 * This provider carries an unusually explicit rule in its own comments, and the
 * rule is the reason the file is worth testing carefully:
 *
 *   > A response we could not read is not evidence of absence.
 *
 * `findRecord` returning `null` means one specific thing — *Cloudflare told us
 * there is no such record* — and every caller treats that as licence to create.
 * So any path that reaches `null` without a readable answer turns a bad minute
 * at Cloudflare into a duplicate DNS record on every retry. Two shapes used to
 * do exactly that: a non-2xx whose error envelope has no `result`, and a 200
 * whose truncated body fails `res.json()` and gets softened to `{}`. Both are
 * indistinguishable from "no records" under optional chaining.
 *
 * `list` carries the same rule for the same reason: reporting an unreadable
 * response as an empty zone tells a caller the zone has nothing in it, and some
 * callers act on that.
 *
 * These tests drive both refusals directly, plus the credential handling (the
 * token must reach the Authorization header and appear nowhere else, including
 * in thrown error text) and the zone-id caching that keeps a per-record lookup
 * from becoming a per-record round trip.
 */
import type { DnsRecordType } from "@hobo/core";
import { describe, expect, test } from "vitest";

import { createCloudflareDnsProvider } from "../src/dns/cloudflare-provider.js";

const TOKEN = "cf-token-must-never-leak";
const ZONE = "example.test";

type Call = { url: string; init: RequestInit };

/**
 * A fetch stub driven by a queue of responses, matched in call order. Each
 * entry may set `ok`, `status`, a `json` implementation, or throw.
 */
function stubFetch(
	responses: Array<{
		ok?: boolean;
		status?: number;
		json?: () => Promise<unknown>;
	}>,
) {
	const calls: Call[] = [];
	let index = 0;
	const impl = (async (url: string, init: RequestInit = {}) => {
		calls.push({ url, init });
		const response = responses[Math.min(index, responses.length - 1)];
		index += 1;
		return {
			ok: response?.ok ?? true,
			status: response?.status ?? 200,
			json: response?.json ?? (async () => ({ success: true, result: [] })),
		};
	}) as unknown as typeof fetch;
	return { impl: impl as typeof fetch, calls };
}

function provider(
	responses: Parameters<typeof stubFetch>[0],
	options: { zoneId?: string; apiBase?: string } = {},
) {
	const { impl, calls } = stubFetch(responses);
	return {
		dns: createCloudflareDnsProvider({
			apiToken: TOKEN,
			fetchImpl: impl,
			...options,
		}),
		calls,
	};
}

/** A list response carrying zero records — a genuine, readable "not found". */
const EMPTY_LIST = { json: async () => ({ success: true, result: [] }) };

/** A list response carrying one record. */
function oneRecord(id = "rec-1", overrides: Record<string, unknown> = {}) {
	return {
		json: async () => ({
			success: true,
			result: [
				{
					id,
					name: `app.${ZONE}`,
					type: "A",
					content: "203.0.113.10",
					ttl: 300,
					...overrides,
				},
			],
		}),
	};
}

const RECORD = {
	name: `app.${ZONE}`,
	type: "A" as DnsRecordType,
	content: "203.0.113.10",
};

async function messageOf(fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "<did not throw>";
}

describe("an unreadable response is not evidence of absence", () => {
	test("a 500 during lookup throws rather than reporting no record", async () => {
		// The core rule. Reading a 500's error envelope as "no records" would
		// make `upsert` create a duplicate on every retry of a transient outage.
		const { dns } = provider(
			[
				{ json: async () => ({ result: [{ id: "zone-1" }] }) },
				{ ok: false, status: 500 },
			],
			{},
		);
		expect(await messageOf(() => dns.upsert("t", ZONE, RECORD))).toContain(
			"dns lookup",
		);
	});

	test("a 429 during lookup throws too", async () => {
		// Rate limiting is the likeliest way to hit this in production, and the
		// likeliest to be retried immediately.
		const { dns } = provider([{ ok: false, status: 429 }], {
			zoneId: "zone-1",
		});
		expect(await messageOf(() => dns.upsert("t", ZONE, RECORD))).toContain(
			"429",
		);
	});

	test("a 200 with an unparseable body throws rather than creating", async () => {
		// `api` softens a `json()` rejection to `{}`, which has no `result` and
		// is indistinguishable from an empty list under optional chaining. This
		// is the second shape the comment calls out.
		const { dns } = provider(
			[
				{
					json: async () => {
						throw new SyntaxError("Unexpected end of JSON input");
					},
				},
			],
			{ zoneId: "zone-1" },
		);
		const message = await messageOf(() => dns.upsert("t", ZONE, RECORD));
		expect(message).toContain("no record list");
		expect(message).toContain("refusing");
	});

	test("a 200 whose result is not an array throws", async () => {
		// A body shaped `{ result: null }` or `{ result: {} }` is a protocol
		// change or a proxy rewriting the response; either way it is unreadable.
		for (const result of [null, {}, "records", 42]) {
			const { dns } = provider(
				[{ json: async () => ({ success: true, result }) }],
				{ zoneId: "zone-1" },
			);
			expect(await messageOf(() => dns.upsert("t", ZONE, RECORD))).toContain(
				"no record list",
			);
		}
	});

	test("a genuinely empty result list does create the record", async () => {
		// The other half: a readable "no such record" must still reach the create
		// path, or the refusal would make the provider unable to create anything.
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert("t", ZONE, RECORD);
		expect(calls[1]?.init.method).toBe("POST");
	});

	test("the same rule protects remove", async () => {
		// `remove` treats a null lookup as "already gone" and returns quietly. An
		// unreadable response reaching that path would silently skip a deletion
		// the caller believes happened.
		const { dns } = provider([{ ok: false, status: 503 }], {
			zoneId: "zone-1",
		});
		expect(
			await messageOf(() => dns.remove("t", ZONE, `app.${ZONE}`, "A")),
		).toContain("dns lookup");
	});

	test("list refuses to report an unreadable response as an empty zone", async () => {
		// Same reasoning one level up: a caller reconciling records against a
		// zone that reported empty would delete or recreate everything.
		const { dns } = provider([{ json: async () => ({ success: true }) }], {
			zoneId: "zone-1",
		});
		const message = await messageOf(() => dns.list("t", ZONE));
		expect(message).toContain("empty zone");
		expect(message).toContain("refusing");
	});

	test("list still reports a genuinely empty zone as empty", async () => {
		const { dns } = provider([EMPTY_LIST], { zoneId: "zone-1" });
		expect(await dns.list("t", ZONE)).toEqual([]);
	});

	test("a failing list throws with its status", async () => {
		const { dns } = provider([{ ok: false, status: 502 }], {
			zoneId: "zone-1",
		});
		expect(await messageOf(() => dns.list("t", ZONE))).toContain("502");
	});
});

describe("credentials", () => {
	test("the token is sent as a bearer header", async () => {
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert("t", ZONE, RECORD);
		const headers = new Headers(calls[0]?.init.headers);
		expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
		expect(headers.get("Content-Type")).toBe("application/json");
	});

	test("the token never appears in a request path or body", async () => {
		// A credential in a URL ends up in proxy logs and browser history; one in
		// a record body ends up published in DNS.
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert("t", ZONE, RECORD);
		for (const call of calls) {
			expect(call.url).not.toContain(TOKEN);
			expect(String(call.init.body ?? "")).not.toContain(TOKEN);
		}
	});

	test("the token never appears in a thrown error", async () => {
		// Errors from this module reach logs and user-facing output. The upsert
		// failure path stringifies the response body, so a provider echoing the
		// request back would be the leak — this pins that the token is not in
		// what we send it in the first place.
		const { dns } = provider(
			[EMPTY_LIST, EMPTY_LIST, { ok: false, status: 403 }],
			{ zoneId: "zone-1" },
		);
		const message = await messageOf(() => dns.upsert("t", ZONE, RECORD));
		expect(message).not.toContain(TOKEN);
	});

	test("headers supplied by a caller do not displace the credential", async () => {
		// `api` sets the Authorization header after copying any caller headers,
		// so an internal call passing its own headers cannot accidentally drop
		// authentication.
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert("t", ZONE, RECORD);
		for (const call of calls) {
			expect(new Headers(call.init.headers).get("Authorization")).toBe(
				`Bearer ${TOKEN}`,
			);
		}
	});
});

describe("zone resolution", () => {
	test("a configured zone id short-circuits the lookup", async () => {
		// One fewer round trip per operation, and it works for a zone the token
		// cannot enumerate.
		const { dns, calls } = provider([EMPTY_LIST], {
			zoneId: "zone-configured",
		});
		await dns.list("t", ZONE);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/zones/zone-configured/dns_records");
	});

	test("without one, the zone is resolved by name", async () => {
		const { dns, calls } = provider([
			{ json: async () => ({ result: [{ id: "zone-resolved" }] }) },
			EMPTY_LIST,
		]);
		await dns.list("t", ZONE);
		expect(calls[0]?.url).toContain(`/zones?name=${encodeURIComponent(ZONE)}`);
		expect(calls[0]?.url).toContain("status=active");
		expect(calls[1]?.url).toContain("/zones/zone-resolved/");
	});

	test("the resolved id is cached across operations", async () => {
		// Otherwise every record write costs an extra zone lookup, which is both
		// slow and a quick route to rate limiting.
		const { dns, calls } = provider([
			{ json: async () => ({ result: [{ id: "zone-resolved" }] }) },
			EMPTY_LIST,
			EMPTY_LIST,
		]);
		await dns.list("t", ZONE);
		await dns.list("t", ZONE);
		const zoneLookups = calls.filter((c) => c.url.includes("/zones?name="));
		expect(zoneLookups).toHaveLength(1);
	});

	test("a zone that cannot be resolved throws with the zone named", async () => {
		// The message has to name the zone, because the usual cause is a token
		// scoped to a different one.
		const { dns } = provider([{ json: async () => ({ result: [] }) }]);
		const message = await messageOf(() => dns.resolveZoneId(ZONE));
		expect(message).toContain(ZONE);
		expect(message).toContain("could not resolve zone id");
	});

	test("a failed zone lookup throws rather than returning undefined", async () => {
		const { dns } = provider([{ ok: false, status: 403 }]);
		expect(await messageOf(() => dns.resolveZoneId(ZONE))).toContain("403");
	});

	test("a failed resolution is not cached", async () => {
		// A transient failure that poisoned the cache would keep failing after
		// the cause was fixed.
		const { impl, calls } = stubFetch([
			{ ok: false, status: 500 },
			{ json: async () => ({ result: [{ id: "zone-later" }] }) },
		]);
		const dns = createCloudflareDnsProvider({
			apiToken: TOKEN,
			fetchImpl: impl,
		});
		await messageOf(() => dns.resolveZoneId(ZONE));
		expect(await dns.resolveZoneId(ZONE)).toBe("zone-later");
		expect(calls).toHaveLength(2);
	});

	test("the zone name is escaped into the query", async () => {
		// An unescaped name with an ampersand would truncate the query and
		// resolve the wrong zone.
		const { dns, calls } = provider([
			{ json: async () => ({ result: [{ id: "z" }] }) },
		]);
		await dns.resolveZoneId("weird zone&status=inactive");
		expect(calls[0]?.url).toContain(
			encodeURIComponent("weird zone&status=inactive"),
		);
		expect(calls[0]?.url).not.toContain("status=inactive&");
	});
});

describe("upsert", () => {
	test("an existing record is updated in place", async () => {
		// Creating a second record for the same name would leave DNS returning
		// two answers and resolution flapping between them.
		const { dns, calls } = provider([oneRecord("rec-existing"), EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert("t", ZONE, RECORD);
		expect(calls[1]?.init.method).toBe("PUT");
		expect(calls[1]?.url).toContain("/dns_records/rec-existing");
	});

	test("a missing record is created", async () => {
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert("t", ZONE, RECORD);
		expect(calls[1]?.init.method).toBe("POST");
		expect(calls[1]?.url).toMatch(/\/dns_records$/);
	});

	test("the record is marked hobo-managed and unproxied", async () => {
		// The comment is how a reconciler tells its own records from ones an
		// operator created by hand; `proxied: false` keeps Cloudflare from
		// terminating TLS in front of a gateway that expects to.
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert("t", ZONE, RECORD);
		const body = JSON.parse(String(calls[1]?.init.body));
		expect(body.comment).toBe("hobo-managed");
		expect(body.proxied).toBe(false);
	});

	test("the TTL defaults to 300 seconds and an explicit one is honoured", async () => {
		const withDefault = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await withDefault.dns.upsert("t", ZONE, RECORD);
		expect(JSON.parse(String(withDefault.calls[1]?.init.body)).ttl).toBe(300);

		const withExplicit = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await withExplicit.dns.upsert("t", ZONE, { ...RECORD, ttl: 60 });
		expect(JSON.parse(String(withExplicit.calls[1]?.init.body)).ttl).toBe(60);
	});

	test("a failing update throws with the status and the provider's errors", async () => {
		// The provider's own error text is the only thing that explains *why*;
		// a bare status leaves the operator guessing.
		const { dns } = provider(
			[
				oneRecord("rec-existing"),
				{
					ok: false,
					status: 400,
					json: async () => ({ errors: [{ message: "invalid content" }] }),
				},
			],
			{ zoneId: "zone-1" },
		);
		const message = await messageOf(() => dns.upsert("t", ZONE, RECORD));
		expect(message).toContain("upsert failed");
		expect(message).toContain("400");
		expect(message).toContain("invalid content");
	});

	test("a failing create throws with the status", async () => {
		const { dns } = provider(
			[
				EMPTY_LIST,
				{
					ok: false,
					status: 409,
					json: async () => ({ errors: [{ message: "already exists" }] }),
				},
			],
			{ zoneId: "zone-1" },
		);
		const message = await messageOf(() => dns.upsert("t", ZONE, RECORD));
		expect(message).toContain("create failed");
		expect(message).toContain("409");
	});

	test("a failure with no errors array still reports the body", async () => {
		// `?? res.body` — a provider that returned an unexpected shape must still
		// produce a diagnosable message rather than "undefined".
		const { dns } = provider(
			[
				EMPTY_LIST,
				{ ok: false, status: 500, json: async () => ({ detail: "boom" }) },
			],
			{ zoneId: "zone-1" },
		);
		const message = await messageOf(() => dns.upsert("t", ZONE, RECORD));
		expect(message).toContain("boom");
	});

	test("the lookup is scoped by both name and type", async () => {
		// An A and an AAAA for the same name are different records; matching on
		// name alone would have one overwrite the other.
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert("t", ZONE, RECORD);
		expect(calls[0]?.url).toContain("type=A");
		expect(calls[0]?.url).toContain(encodeURIComponent(`app.${ZONE}`));
	});
});

describe("remove", () => {
	test("an existing record is deleted by id", async () => {
		const { dns, calls } = provider([oneRecord("rec-doomed"), EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.remove("t", ZONE, `app.${ZONE}`, "A");
		expect(calls[1]?.init.method).toBe("DELETE");
		expect(calls[1]?.url).toContain("/dns_records/rec-doomed");
	});

	test("removing a record that is genuinely absent is a no-op", async () => {
		// Reconciliation runs repeatedly; a delete of something already gone must
		// not fail the run.
		const { dns, calls } = provider([EMPTY_LIST], { zoneId: "zone-1" });
		await dns.remove("t", ZONE, `app.${ZONE}`, "A");
		expect(calls).toHaveLength(1);
	});

	test("a failing delete throws with its status", async () => {
		const { dns } = provider(
			[oneRecord("rec-doomed"), { ok: false, status: 403 }],
			{ zoneId: "zone-1" },
		);
		expect(
			await messageOf(() => dns.remove("t", ZONE, `app.${ZONE}`, "A")),
		).toContain("403");
	});
});

describe("list", () => {
	test("records are mapped into the port's shape", async () => {
		const { dns } = provider([oneRecord()], { zoneId: "zone-1" });
		const records = await dns.list("t", ZONE);
		expect(records).toEqual([
			{
				name: `app.${ZONE}`,
				type: "A",
				content: "203.0.113.10",
				ttl: 300,
				gatewayTarget: true,
			},
		]);
	});

	test("a record with no TTL omits the field rather than emitting undefined", async () => {
		const { dns } = provider([oneRecord("rec-1", { ttl: undefined })], {
			zoneId: "zone-1",
		});
		const first = (await dns.list("t", ZONE))[0];
		expect(first && "ttl" in first).toBe(false);
	});

	test("the list requests a full page", async () => {
		// Cloudflare's default page size is small; a reconciler seeing only the
		// first twenty records would keep recreating the rest.
		const { dns, calls } = provider([EMPTY_LIST], { zoneId: "zone-1" });
		await dns.list("t", ZONE);
		expect(calls[0]?.url).toContain("per_page=100");
	});
});

describe("the API base", () => {
	test("it defaults to the Cloudflare v4 endpoint", async () => {
		const { dns, calls } = provider([EMPTY_LIST], { zoneId: "zone-1" });
		await dns.list("t", ZONE);
		expect(calls[0]?.url.startsWith("https://api.cloudflare.com/v4/")).toBe(
			true,
		);
	});

	test("a custom base is honoured", async () => {
		const { dns, calls } = provider([EMPTY_LIST], {
			zoneId: "zone-1",
			apiBase: "http://localhost:9999/mock",
		});
		await dns.list("t", ZONE);
		expect(calls[0]?.url.startsWith("http://localhost:9999/mock/")).toBe(true);
	});

	test("a trailing slash on the base does not double up", async () => {
		const { dns, calls } = provider([EMPTY_LIST], {
			zoneId: "zone-1",
			apiBase: "http://localhost:9999/mock/",
		});
		await dns.list("t", ZONE);
		expect(calls[0]?.url).not.toContain("//zones");
	});

	test("the provider reports its kind", () => {
		expect(provider([EMPTY_LIST]).dns.kind).toBe("cloudflare");
	});
});
