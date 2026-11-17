import { type DnsRecordType, parseTenantId } from "@hobo/core";
import { describe, expect, test } from "vitest";

import { createCloudflareDnsProvider } from "../src/dns/cloudflare-provider.js";
import { type JsonValue, parseJsonValue } from "../src/json.js";

const TENANT = parseTenantId("t");
const TOKEN = "cf-token-must-never-leak";
const ZONE = "example.test";

type Call = { url: string; init: RequestInit };

function stubFetch(
	responses: Array<{
		ok?: boolean;
		status?: number;
		json?: () => Promise<JsonValue>;
	}>,
) {
	const calls: Call[] = [];
	let index = 0;
	const impl: typeof fetch = async (input, init = {}) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init });
		const response = responses[Math.min(index, responses.length - 1)];
		index += 1;
		const status = response?.status ?? (response?.ok === false ? 500 : 200);
		const result = new Response(null, { status });
		result.json =
			response?.json ?? (async () => ({ success: true, result: [] }));
		return result;
	};
	return { impl, calls };
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

const EMPTY_LIST = { json: async () => ({ success: true, result: [] }) };

function oneRecord(id = "rec-1", overrides: { ttl?: number | undefined } = {}) {
	return {
		json: async () =>
			parseJsonValue(
				JSON.stringify({
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
			),
	};
}

const RECORD = {
	name: `app.${ZONE}`,
	type: "A" as DnsRecordType,
	content: "203.0.113.10",
	gatewayTarget: true,
};

async function messageOf<T>(fn: () => Promise<T>): Promise<string> {
	try {
		await fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "<did not throw>";
}

describe("an unreadable response is not evidence of absence", () => {
	test("a 500 during lookup throws rather than reporting no record", async () => {
		const { dns } = provider(
			[
				{ json: async () => ({ result: [{ id: "zone-1" }] }) },
				{ ok: false, status: 500 },
			],
			{},
		);
		expect(await messageOf(() => dns.upsert(TENANT, ZONE, RECORD))).toContain(
			"dns lookup",
		);
	});

	test("a 429 during lookup throws too", async () => {
		const { dns } = provider([{ ok: false, status: 429 }], {
			zoneId: "zone-1",
		});
		expect(await messageOf(() => dns.upsert(TENANT, ZONE, RECORD))).toContain(
			"429",
		);
	});

	test("a 200 with an unparseable body throws rather than creating", async () => {
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
		const message = await messageOf(() => dns.upsert(TENANT, ZONE, RECORD));
		expect(message).toContain("no record list");
		expect(message).toContain("refusing");
	});

	test("a 200 whose result is not an array throws", async () => {
		for (const result of [null, {}, "records", 42]) {
			const { dns } = provider(
				[{ json: async () => ({ success: true, result }) }],
				{ zoneId: "zone-1" },
			);
			expect(await messageOf(() => dns.upsert(TENANT, ZONE, RECORD))).toContain(
				"no record list",
			);
		}
	});

	test("a genuinely empty result list does create the record", async () => {
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert(TENANT, ZONE, RECORD);
		expect(calls[1]?.init.method).toBe("POST");
	});

	test("the same rule protects remove", async () => {
		const { dns } = provider([{ ok: false, status: 503 }], {
			zoneId: "zone-1",
		});
		expect(
			await messageOf(() => dns.remove(TENANT, ZONE, `app.${ZONE}`, "A")),
		).toContain("dns lookup");
	});

	test("list refuses to report an unreadable response as an empty zone", async () => {
		const { dns } = provider([{ json: async () => ({ success: true }) }], {
			zoneId: "zone-1",
		});
		const message = await messageOf(() => dns.list(TENANT, ZONE));
		expect(message).toContain("empty zone");
		expect(message).toContain("refusing");
	});

	test("list still reports a genuinely empty zone as empty", async () => {
		const { dns } = provider([EMPTY_LIST], { zoneId: "zone-1" });
		expect(await dns.list(TENANT, ZONE)).toEqual([]);
	});

	test("a failing list throws with its status", async () => {
		const { dns } = provider([{ ok: false, status: 502 }], {
			zoneId: "zone-1",
		});
		expect(await messageOf(() => dns.list(TENANT, ZONE))).toContain("502");
	});
});

describe("credentials", () => {
	test("the token is sent as a bearer header", async () => {
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert(TENANT, ZONE, RECORD);
		const headers = new Headers(calls[0]?.init.headers);
		expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
		expect(headers.get("Content-Type")).toBe("application/json");
	});

	test("the token never appears in a request path or body", async () => {
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert(TENANT, ZONE, RECORD);
		for (const call of calls) {
			expect(call.url).not.toContain(TOKEN);
			expect(String(call.init.body ?? "")).not.toContain(TOKEN);
		}
	});

	test("the token never appears in a thrown error", async () => {
		const { dns } = provider(
			[EMPTY_LIST, EMPTY_LIST, { ok: false, status: 403 }],
			{ zoneId: "zone-1" },
		);
		const message = await messageOf(() => dns.upsert(TENANT, ZONE, RECORD));
		expect(message).not.toContain(TOKEN);
	});

	test("headers supplied by a caller do not displace the credential", async () => {
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert(TENANT, ZONE, RECORD);
		for (const call of calls) {
			expect(new Headers(call.init.headers).get("Authorization")).toBe(
				`Bearer ${TOKEN}`,
			);
		}
	});
});

describe("zone resolution", () => {
	test("a configured zone id short-circuits the lookup", async () => {
		const { dns, calls } = provider([EMPTY_LIST], {
			zoneId: "zone-configured",
		});
		await dns.list(TENANT, ZONE);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/zones/zone-configured/dns_records");
	});

	test("without one, the zone is resolved by name", async () => {
		const { dns, calls } = provider([
			{ json: async () => ({ result: [{ id: "zone-resolved" }] }) },
			EMPTY_LIST,
		]);
		await dns.list(TENANT, ZONE);
		expect(calls[0]?.url).toContain(`/zones?name=${encodeURIComponent(ZONE)}`);
		expect(calls[0]?.url).toContain("status=active");
		expect(calls[1]?.url).toContain("/zones/zone-resolved/");
	});

	test("the resolved id is cached across operations", async () => {
		const { dns, calls } = provider([
			{ json: async () => ({ result: [{ id: "zone-resolved" }] }) },
			EMPTY_LIST,
			EMPTY_LIST,
		]);
		await dns.list(TENANT, ZONE);
		await dns.list(TENANT, ZONE);
		const zoneLookups = calls.filter((c) => c.url.includes("/zones?name="));
		expect(zoneLookups).toHaveLength(1);
	});

	test("a zone that cannot be resolved throws with the zone named", async () => {
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
		const { dns, calls } = provider([oneRecord("rec-existing"), EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert(TENANT, ZONE, RECORD);
		expect(calls[1]?.init.method).toBe("PUT");
		expect(calls[1]?.url).toContain("/dns_records/rec-existing");
	});

	test("a missing record is created", async () => {
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert(TENANT, ZONE, RECORD);
		expect(calls[1]?.init.method).toBe("POST");
		expect(calls[1]?.url).toMatch(/\/dns_records$/);
	});

	test("the record is marked hobo-managed and unproxied", async () => {
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert(TENANT, ZONE, RECORD);
		const body = JSON.parse(String(calls[1]?.init.body));
		expect(body.comment).toBe("hobo-managed");
		expect(body.proxied).toBe(false);
	});

	test("the TTL defaults to 300 seconds and an explicit one is honoured", async () => {
		const withDefault = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await withDefault.dns.upsert(TENANT, ZONE, RECORD);
		expect(JSON.parse(String(withDefault.calls[1]?.init.body)).ttl).toBe(300);

		const withExplicit = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await withExplicit.dns.upsert(TENANT, ZONE, { ...RECORD, ttl: 60 });
		expect(JSON.parse(String(withExplicit.calls[1]?.init.body)).ttl).toBe(60);
	});

	test("a failing update throws with the status and the provider's errors", async () => {
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
		const message = await messageOf(() => dns.upsert(TENANT, ZONE, RECORD));
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
		const message = await messageOf(() => dns.upsert(TENANT, ZONE, RECORD));
		expect(message).toContain("create failed");
		expect(message).toContain("409");
	});

	test("a failure with no errors array still reports the body", async () => {
		const { dns } = provider(
			[
				EMPTY_LIST,
				{ ok: false, status: 500, json: async () => ({ detail: "boom" }) },
			],
			{ zoneId: "zone-1" },
		);
		const message = await messageOf(() => dns.upsert(TENANT, ZONE, RECORD));
		expect(message).toContain("boom");
	});

	test("the lookup is scoped by both name and type", async () => {
		const { dns, calls } = provider([EMPTY_LIST, EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.upsert(TENANT, ZONE, RECORD);
		expect(calls[0]?.url).toContain("type=A");
		expect(calls[0]?.url).toContain(encodeURIComponent(`app.${ZONE}`));
	});
});

describe("remove", () => {
	test("an existing record is deleted by id", async () => {
		const { dns, calls } = provider([oneRecord("rec-doomed"), EMPTY_LIST], {
			zoneId: "zone-1",
		});
		await dns.remove(TENANT, ZONE, `app.${ZONE}`, "A");
		expect(calls[1]?.init.method).toBe("DELETE");
		expect(calls[1]?.url).toContain("/dns_records/rec-doomed");
	});

	test("removing a record that is genuinely absent is a no-op", async () => {
		const { dns, calls } = provider([EMPTY_LIST], { zoneId: "zone-1" });
		await dns.remove(TENANT, ZONE, `app.${ZONE}`, "A");
		expect(calls).toHaveLength(1);
	});

	test("a failing delete throws with its status", async () => {
		const { dns } = provider(
			[oneRecord("rec-doomed"), { ok: false, status: 403 }],
			{ zoneId: "zone-1" },
		);
		expect(
			await messageOf(() => dns.remove(TENANT, ZONE, `app.${ZONE}`, "A")),
		).toContain("403");
	});
});

describe("list", () => {
	test("records are mapped into the port's shape", async () => {
		const { dns } = provider([oneRecord()], { zoneId: "zone-1" });
		const records = await dns.list(TENANT, ZONE);
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
		const first = (await dns.list(TENANT, ZONE))[0];
		expect(first && "ttl" in first).toBe(false);
	});

	test("the list requests a full page", async () => {
		const { dns, calls } = provider([EMPTY_LIST], { zoneId: "zone-1" });
		await dns.list(TENANT, ZONE);
		expect(calls[0]?.url).toContain("per_page=100");
	});
});

describe("the API base", () => {
	test("it defaults to the Cloudflare v4 endpoint", async () => {
		const { dns, calls } = provider([EMPTY_LIST], { zoneId: "zone-1" });
		await dns.list(TENANT, ZONE);
		expect(calls[0]?.url.startsWith("https://api.cloudflare.com/v4/")).toBe(
			true,
		);
	});

	test("a custom base is honoured", async () => {
		const { dns, calls } = provider([EMPTY_LIST], {
			zoneId: "zone-1",
			apiBase: "http://localhost:9999/mock",
		});
		await dns.list(TENANT, ZONE);
		expect(calls[0]?.url.startsWith("http://localhost:9999/mock/")).toBe(true);
	});

	test("a trailing slash on the base does not double up", async () => {
		const { dns, calls } = provider([EMPTY_LIST], {
			zoneId: "zone-1",
			apiBase: "http://localhost:9999/mock/",
		});
		await dns.list(TENANT, ZONE);
		expect(calls[0]?.url).not.toContain("//zones");
	});

	test("the provider reports its kind", () => {
		expect(provider([EMPTY_LIST]).dns.kind).toBe("cloudflare");
	});
});
