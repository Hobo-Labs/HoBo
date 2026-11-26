import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWebhookRepair } from "../src/webhook-repair.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const now = Date.parse("2026-10-27T12:00:00Z");
const delivery = (
	id: number,
	guid: string,
	status_code: number,
	event = "workflow_job",
) => ({ id, guid, status_code, event, delivered_at: "2026-10-27T11:55:00Z" });

function claims(
	claim: (app: string, guid: string, now: number) => Promise<boolean>,
) {
	let cursor: string | undefined;
	const successes = new Set<string>();
	return {
		claim,
		recordSuccesses: async (_app: string, guids: string[]) => {
			for (const guid of guids) successes.add(guid);
		},
		wasSuccessful: async (_app: string, guid: string) => successes.has(guid),
		limited: async () => false,
		startScan: async () => ({
			cursor,
			checkpoint: async (next: string | undefined) => {
				cursor = next;
			},
			close: async () => {},
		}),
	};
}

describe("GitHub App missed delivery repair", () => {
	it("closes the scan with its receiver intact", async () => {
		let closed = false;
		const scan = {
			cursor: undefined,
			checkpoint: async () => {},
			async close() {
				expect(this).toBe(scan);
				closed = true;
			},
		};
		const base = claims(async () => true);
		const repair = createWebhookRepair({
			appId: "123",
			privateKey: pem,
			claims: { ...base, startScan: async () => scan },
			fetch: async () => Response.json([]),
		});
		await repair();
		expect(closed).toBe(true);
	});
	it("reports invalid delivery field names without exposing response data", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const repair = createWebhookRepair({
				appId: "123",
				privateKey: pem,
				claims: claims(async () => true),
				fetch: async () =>
					Response.json([
						{ ...delivery(1, "test", 200), status_code: "secret" },
					]),
			});
			await expect(repair()).rejects.toThrow();
			expect(log).toHaveBeenCalledWith(
				JSON.stringify({
					event: "hobo_ci_webhook_repair_failure",
					phase: "deliveries-shape",
					fields: ["status_code"],
				}),
			);
			expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
		} finally {
			log.mockRestore();
		}
	});
	it("identifies a null status code without reporting delivery content", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const repair = createWebhookRepair({
				appId: "123",
				privateKey: pem,
				claims: claims(async () => true),
				fetch: async () =>
					Response.json([
						{ ...delivery(1, "private-guid", 200), status_code: null },
					]),
			});
			await expect(repair()).rejects.toThrow();
			expect(log).toHaveBeenCalledWith(
				JSON.stringify({
					event: "hobo_ci_webhook_repair_failure",
					phase: "deliveries-shape",
					null_status: true,
					fields: ["status_code"],
				}),
			);
			expect(JSON.stringify(log.mock.calls)).not.toContain("private-guid");
		} finally {
			log.mockRestore();
		}
	});
	it("classifies invalid delivery IDs without logging their values", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const repair = createWebhookRepair({
				appId: "123",
				privateKey: pem,
				claims: claims(async () => true),
				fetch: async () =>
					Response.json([
						{ ...delivery(1, "one", 200), id: "9876543210987654321" },
						{ ...delivery(2, "two", 200), id: "private-value" },
					]),
			});
			await expect(repair()).rejects.toThrow();
			expect(log).toHaveBeenCalledWith(
				JSON.stringify({
					event: "hobo_ci_webhook_repair_failure",
					phase: "deliveries-shape",
					fields: ["id"],
					id_kinds: ["decimal-string", "other-string"],
				}),
			);
			expect(JSON.stringify(log.mock.calls)).not.toContain(
				"9876543210987654321",
			);
		} finally {
			log.mockRestore();
		}
	});
	it("redelivers an int64 ID without losing JSON numeric precision", async () => {
		const calls: string[] = [];
		const numeric = JSON.stringify(delivery(1, "number", 500)).replace(
			'"id":1',
			'"id":9223372036854775807',
		);
		const string = JSON.stringify({
			...delivery(2, "string", 500),
			id: "9007199254740993",
		});
		const repair = createWebhookRepair({
			appId: "123",
			privateKey: pem,
			now: () => now,
			claims: claims(async () => true),
			fetch: async (input, init) => {
				if (init?.method === "POST") {
					calls.push(String(input));
					return new Response(null, { status: 202 });
				}
				return new Response(`[${numeric},${string}]`, {
					headers: { "content-type": "application/json" },
				});
			},
		});
		expect((await repair()).requested).toBe(2);
		expect(calls).toEqual([
			"https://api.github.com/app/hook/deliveries/9223372036854775807/attempts",
			"https://api.github.com/app/hook/deliveries/9007199254740993/attempts",
		]);
	});
	it("fails closed when the runtime cannot expose a numeric JSON source", async () => {
		const originalParse = JSON.parse;
		const parse = vi
			.spyOn(JSON, "parse")
			.mockImplementation((body, reviver) => {
				if (!reviver) return originalParse(body);
				return originalParse(body, (key, value) =>
					reviver.call({}, key, value),
				);
			});
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const repair = createWebhookRepair({
				appId: "123",
				privateKey: pem,
				claims: claims(async () => true),
				fetch: async () => new Response('[{"id":1}]'),
			});
			await expect(repair()).rejects.toThrow(
				"lossless JSON parsing unavailable",
			);
		} finally {
			parse.mockRestore();
			log.mockRestore();
		}
	});
	it("rejects malformed, nonpositive, and overflow IDs before redelivery", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const token of [
				"0",
				"-1",
				"1.5",
				"9007199254740990.5",
				"9007199254740991.1",
				"1e3",
				"1e20",
				"9223372036854775808",
				'"001"',
				'"1e4"',
				'"+1"',
			]) {
				let posts = 0;
				const body = JSON.stringify(delivery(1, "failure", 500)).replace(
					'"id":1',
					`"id":${token}`,
				);
				const repair = createWebhookRepair({
					appId: "123",
					privateKey: pem,
					now: () => now,
					claims: claims(async () => true),
					fetch: async (_input, init) => {
						if (init?.method === "POST") {
							posts++;
							return new Response(null, { status: 202 });
						}
						return new Response(`[${body}]`, {
							headers: { "content-type": "application/json" },
						});
					},
				});
				await expect(repair()).rejects.toThrow();
				expect(posts).toBe(0);
			}
		} finally {
			log.mockRestore();
		}
	});
	it("preserves the original repair failure when the diagnostic sink fails", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {
			throw new Error("log sink failed");
		});
		try {
			const repair = createWebhookRepair({
				appId: "123",
				privateKey: pem,
				claims: claims(async () => true),
				fetch: async () => {
					throw new Error("original repair failure");
				},
			});
			await expect(repair()).rejects.toThrow("original repair failure");
		} finally {
			log.mockRestore();
		}
	});
	it("paginates, authenticates with App JWT, skips successes and unsupported events, and deduplicates", async () => {
		const claimed = new Set<string>();
		const calls: string[] = [];
		const send: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push(`${init?.method ?? "GET"} ${url}`);
			const token =
				new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
			const [header, payload, signature] = token.split(".");
			expect(
				JSON.parse(Buffer.from(payload ?? "", "base64url").toString()).iss,
			).toBe("123");
			expect(
				createVerify("RSA-SHA256")
					.update(`${header}.${payload}`)
					.verify(publicKey, Buffer.from(signature ?? "", "base64url")),
			).toBe(true);
			if (init?.method === "POST") return new Response(null, { status: 202 });
			if (url.includes("cursor="))
				return Response.json([
					delivery(2, "already-ok", 200),
					delivery(3, "ignored", 500, "push"),
				]);
			return Response.json(
				[
					delivery(1, "already-ok", 503),
					delivery(4, "retry", 503),
					delivery(5, "retry", 503),
				],
				{
					headers: {
						link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"',
					},
				},
			);
		};
		const repair = createWebhookRepair({
			appId: "123",
			privateKey: pem,
			now: () => now,
			fetch: send,
			claims: claims(async (_app, guid) => {
				if (claimed.has(guid)) return false;
				claimed.add(guid);
				return true;
			}),
		});
		expect(await repair()).toEqual({
			scanned: 5,
			requested: 1,
			truncated: false,
			more: false,
		});
		expect(calls).toContain(
			"POST https://api.github.com/app/hook/deliveries/4/attempts",
		);
		expect((await repair()).requested).toBe(0);
	});
	it("fails closed on untrusted pagination and on GitHub errors", async () => {
		let writes = 0;
		const repair = createWebhookRepair({
			appId: "123",
			privateKey: pem,
			now: () => now,
			claims: claims(async () => {
				writes++;
				return true;
			}),
			fetch: async () =>
				Response.json([delivery(1, "retry", 500)], {
					headers: {
						link: '<https://evil.example/app/hook/deliveries?cursor=x>; rel="next"',
					},
				}),
		});
		await expect(repair()).rejects.toThrow("invalid GitHub pagination link");
		expect(writes).toBe(0);
	});
	it("claims before POST and leaves ambiguous failures on cooldown", async () => {
		let claimed = false;
		let posts = 0;
		const repair = createWebhookRepair({
			appId: "123",
			privateKey: pem,
			now: () => now,
			claims: claims(async () => {
				if (claimed) return false;
				claimed = true;
				return true;
			}),
			fetch: async (_input, init) => {
				if (init?.method === "POST") {
					posts++;
					throw new Error("network");
				}
				return Response.json([delivery(1, "retry", 500)]);
			},
		});
		await expect(repair()).rejects.toThrow();
		expect((await repair()).requested).toBe(0);
		expect(posts).toBe(1);
	});
	it("continues a large history across invocations using a durable cursor", async () => {
		const requested: number[] = [];
		const repair = createWebhookRepair({
			appId: "123",
			privateKey: pem,
			now: () => now,
			claims: claims(async () => true),
			fetch: async (input, init) => {
				const url = new URL(String(input));
				if (init?.method === "POST") {
					requested.push(Number(url.pathname.split("/").at(-2)));
					return new Response(null, { status: 202 });
				}
				const page = Number(url.searchParams.get("cursor") ?? "1");
				return Response.json(
					[delivery(page, `guid-${page}`, 500)],
					page < 12
						? {
								headers: {
									link: `<https://api.github.com/app/hook/deliveries?cursor=${page + 1}>; rel="next"`,
								},
							}
						: {},
				);
			},
		});
		expect(await repair()).toEqual({
			scanned: 5,
			requested: 5,
			truncated: false,
			more: true,
		});
		expect(await repair()).toEqual({
			scanned: 5,
			requested: 5,
			truncated: false,
			more: true,
		});
		expect(await repair()).toEqual({
			scanned: 2,
			requested: 2,
			truncated: false,
			more: false,
		});
		expect(requested).toEqual(
			Array.from({ length: 12 }, (_, index) => index + 1),
		);
	});
	it("suppresses prior success across page batches and repairs gaps older than a day", async () => {
		const requests: number[] = [];
		const store = claims(async () => true);
		const repair = createWebhookRepair({
			appId: "123",
			privateKey: pem,
			now: () => now,
			claims: store,
			isAccepted: async (guid) => guid === "accepted",
			fetch: async (input, init) => {
				const url = new URL(String(input));
				if (init?.method === "POST") {
					requests.push(Number(url.pathname.split("/").at(-2)));
					return new Response(null, { status: 202 });
				}
				const page = Number(url.searchParams.get("cursor") ?? "1");
				const items =
					page === 1
						? [delivery(1, "ignored-but-succeeded", 202)]
						: page === 6
							? [
									delivery(2, "ignored-but-succeeded", 500),
									delivery(3, "accepted", 500),
									{
										...delivery(4, "old", 500),
										delivered_at: "2026-10-25T11:55:00Z",
									},
								]
							: [];
				return Response.json(
					items,
					page < 6
						? {
								headers: {
									link: `<https://api.github.com/app/hook/deliveries?cursor=${page + 1}>; rel="next"`,
								},
							}
						: {},
				);
			},
		});
		expect((await repair()).more).toBe(true);
		expect((await repair()).requested).toBe(1);
		expect(requests).toEqual([4]);
	});
	it("resumes the same page after the shared minute limit without starving later deliveries", async () => {
		let current = now;
		const attempts = new Map<string, number>();
		const state = claims(async (_app, guid, time) => {
			const previous = attempts.get(guid);
			if (previous !== undefined && time - previous < 15 * 60_000) return false;
			if (
				[...attempts.values()].filter((at) => time - at < 60_000).length >= 20
			)
				return false;
			attempts.set(guid, time);
			return true;
		});
		state.limited = async () =>
			[...attempts.values()].filter((at) => current - at < 60_000).length >= 20;
		const repair = createWebhookRepair({
			appId: "123",
			privateKey: pem,
			now: () => current,
			claims: state,
			fetch: async (_input, init) =>
				init?.method === "POST"
					? new Response(null, { status: 202 })
					: Response.json(
							Array.from({ length: 30 }, (_, index) =>
								delivery(index + 1, `guid-${index}`, 500),
							),
						),
		});
		expect(await repair()).toEqual({
			scanned: 30,
			requested: 20,
			truncated: false,
			more: true,
		});
		current += 61_000;
		expect(await repair()).toEqual({
			scanned: 30,
			requested: 10,
			truncated: false,
			more: false,
		});
	});
});
