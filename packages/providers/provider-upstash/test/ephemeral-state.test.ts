/**
 * The ephemeral-state suite through the Upstash REST binding.
 *
 * A local HTTP server stands in for Upstash's REST endpoint and speaks its
 * documented wire contract: a JSON command array in a POST body with a bearer
 * token, answered by `200 {"result": …}` or — for a failed command —
 * `400 {"error": …}`. Every request goes through the real
 * `createUpstashRestExecutor`, its real URL/response guard, and a real HTTP
 * round trip; only the server is local.
 *
 * Behind the HTTP server sits one of two engines:
 * - the in-memory engine from `@hobo/kv-redis-compatible` (always runs), and
 * - a real Valkey/Redis over RESP when a server binary is available
 *   (`HOBO_VALKEY_SERVER_BIN`, or `valkey-server` / `redis-server` on PATH),
 *   which executes the actual Lua scripts — the REST shim then differs from
 *   Upstash only in who runs Redis.
 *
 * It proves the adapter and the scripts, offline. It does not measure Upstash.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer, Socket } from "node:net";

import {
	createManualClock,
	createMemoryRedisExecutor,
	EPHEMERAL_STATE_CONFORMANCE_CASES,
	type EphemeralConformanceContext,
	KvRedisCompatibleError,
	type KvRedisExecutor,
	meterExecutor,
	type RedisCommand,
	type RedisValue,
} from "@hobo/kv-redis-compatible";
import {
	createRespExecutor,
	type RespExecutor,
} from "@hobo/kv-redis-compatible/resp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createUpstashEphemeralState,
	resolveUpstashRestEnv,
	UPSTASH_REST_ENV_PAIRS,
} from "../src/ephemeral-state.js";
import { isProviderError } from "../src/errors.js";
import {
	isJsonArray,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "../src/json.js";
import { createUpstashRestExecutor } from "../src/rest-executor.js";
import {
	createFetchTransport,
	type UpstashTransport,
} from "../src/transport.js";
import { FAKE_REST_TOKEN, FAKE_REST_URL } from "./fixtures/index.js";

const binary =
	process.env.HOBO_VALKEY_SERVER_BIN ??
	(spawnSync("valkey-server", ["--version"]).status === 0
		? "valkey-server"
		: spawnSync("redis-server", ["--version"]).status === 0
			? "redis-server"
			: "");

/** The two bodies the REST contract answers with. */
type RestEnvelope =
	| { readonly result: RedisValue }
	| { readonly error: string };

type FakeRest = {
	readonly transport: UpstashTransport;
	readonly unauthorized: () => number;
	close(): Promise<void>;
};

/** Parse a REST body the way the server must: a non-empty array of strings. */
function parseCommand(body: string): RedisCommand | undefined {
	let decoded: JsonValue;
	try {
		decoded = parseJsonValue(body);
	} catch {
		return undefined;
	}
	if (!isJsonArray(decoded) || decoded.length === 0) return undefined;
	const parts: string[] = [];
	for (const part of decoded) {
		if (!isJsonString(part)) return undefined;
		parts.push(part);
	}
	const [verb, ...args] = parts;
	return verb === undefined ? undefined : [verb, ...args];
}

async function startFakeRest(backend: KvRedisExecutor): Promise<FakeRest> {
	let unauthorized = 0;
	const server: Server = createHttpServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const reply = (status: number, body: RestEnvelope) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(body));
			};
			if (request.headers.authorization !== `Bearer ${FAKE_REST_TOKEN}`) {
				unauthorized += 1;
				reply(401, { error: "Unauthorized" });
				return;
			}
			const command = parseCommand(Buffer.concat(chunks).toString("utf8"));
			if (request.method !== "POST" || command === undefined) {
				reply(400, { error: "ERR failed to parse command" });
				return;
			}
			backend.execute(command).then(
				(result) =>
					result.kind === "error"
						? reply(400, { error: result.message })
						: reply(200, { result: result.value }),
				() => reply(500, { error: "backend unavailable" }),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: an HTTP server listening on a host and port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	const http = createFetchTransport({ fetchImpl: globalThis.fetch });
	return {
		// The executor's guard sees the real https://*.upstash.io URL; only the
		// socket underneath is pointed at the local server.
		transport: {
			request: (request) =>
				http.request({
					...request,
					url: `http://127.0.0.1:${port}${new URL(request.url).pathname}`,
				}),
		},
		unauthorized: () => unauthorized,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function restClients(rest: FakeRest) {
	const metered = meterExecutor(
		createUpstashRestExecutor({
			transport: rest.transport,
			restEndpointUrl: FAKE_REST_URL,
			resolveToken: async () => FAKE_REST_TOKEN,
		}),
	);
	const client = (
		wrap: (executor: KvRedisExecutor) => KvRedisExecutor = (executor) =>
			executor,
	) =>
		createUpstashEphemeralState({
			restEndpointUrl: FAKE_REST_URL,
			resolveToken: async () => FAKE_REST_TOKEN,
			network: { transport: rest.transport },
			wrap,
		});
	return {
		clients: [client(() => metered), client(), client(), client()] as const,
		usage: () => metered.usage(),
	};
}

describe("ephemeral-state conformance — Upstash REST over the in-memory engine", () => {
	const clock = createManualClock();
	let rest: FakeRest;

	beforeAll(async () => {
		rest = await startFakeRest(createMemoryRedisExecutor({ now: clock.now }));
	});
	afterAll(async () => {
		await rest.close();
	});

	let run = 0;
	const context = (): EphemeralConformanceContext => {
		run += 1;
		const { clients, usage } = restClients(rest);
		return {
			clients,
			advanceTime: async (ms) => clock.advance(ms),
			usage,
			keyPrefix: `rest-mem-${run}:`,
			ttlMs: 1_000,
		};
	};

	for (const entry of EPHEMERAL_STATE_CONFORMANCE_CASES) {
		it(entry.id, async () => {
			await entry.run(context());
		});
	}

	it("sent every request with the bearer token", () => {
		expect(rest.unauthorized()).toBe(0);
	});
});

const accepts = (port: number) =>
	new Promise<boolean>((resolve) => {
		const socket = new Socket();
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
		socket.connect(port, "127.0.0.1");
	});

describe.skipIf(!binary)(
	"ephemeral-state conformance — Upstash REST over a real Valkey/Redis",
	() => {
		let server: ChildProcess | undefined;
		let backend: RespExecutor | undefined;
		let rest: FakeRest;

		beforeAll(async () => {
			const port = await new Promise<number>((resolve, reject) => {
				const probe = createServer();
				probe.once("error", reject);
				probe.listen(0, "127.0.0.1", () => {
					// SAFETY: a TCP server listening on a host and port reports an AddressInfo.
					const { port: free } = probe.address() as AddressInfo;
					probe.close(() => resolve(free));
				});
			});
			server = spawn(
				binary,
				[
					"--port",
					`${port}`,
					"--bind",
					"127.0.0.1",
					"--save",
					"",
					"--appendonly",
					"no",
				],
				{ stdio: "ignore" },
			);
			const deadline = Date.now() + 10_000;
			while (!(await accepts(port))) {
				if (Date.now() > deadline) throw new Error("server did not start");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			backend = createRespExecutor({ url: `redis://127.0.0.1:${port}` });
			rest = await startFakeRest(backend);
		});

		afterAll(async () => {
			await rest?.close();
			await backend?.close();
			const running = server;
			if (!running) return;
			await new Promise<void>((resolve) => {
				running.once("exit", () => resolve());
				running.kill("SIGKILL");
			});
		});

		let run = 0;
		const context = (): EphemeralConformanceContext => {
			run += 1;
			const { clients, usage } = restClients(rest);
			return {
				clients,
				advanceTime: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
				usage,
				keyPrefix: `rest-resp-${run}:`,
				ttlMs: 300,
			};
		};

		for (const entry of EPHEMERAL_STATE_CONFORMANCE_CASES) {
			it(entry.id, async () => {
				await entry.run(context());
			});
		}
	},
);

describe("the REST executor and a failed command", () => {
	const respond = (status: number, body: string): UpstashTransport => ({
		request: async () => ({
			status,
			headers: { "content-type": "application/json" },
			body,
		}),
	});
	const executorOver = (transport: UpstashTransport) =>
		createUpstashRestExecutor({
			transport,
			restEndpointUrl: FAKE_REST_URL,
			resolveToken: async () => FAKE_REST_TOKEN,
		});

	it("reads Upstash's 400 error envelope as a Redis error reply", async () => {
		const reply = await executorOver(
			respond(
				400,
				JSON.stringify({
					error: "NOSCRIPT No matching script. Please use EVAL.",
				}),
			),
		).execute(["EVALSHA", "0".repeat(40), "0"]);
		expect(reply).toEqual({
			kind: "error",
			message: "NOSCRIPT No matching script. Please use EVAL.",
		});
	});

	it("still treats a 400 without an error envelope as a provider failure", async () => {
		let failure: Error | undefined;
		try {
			await executorOver(respond(400, "<html>bad request</html>")).execute([
				"PING",
			]);
		} catch (error) {
			failure = error instanceof Error ? error : undefined;
		}
		expect(failure !== undefined && isProviderError(failure)).toBe(true);
	});
});

describe("binding from the Marketplace environment", () => {
	const url = FAKE_REST_URL;

	it("reads UPSTASH_REDIS_REST_* first, then KV_REST_API_*, as whole pairs", async () => {
		const both = resolveUpstashRestEnv({
			UPSTASH_REDIS_REST_URL: url,
			UPSTASH_REDIS_REST_TOKEN: "t-upstash",
			KV_REST_API_URL: url,
			KV_REST_API_TOKEN: "t-kv",
		});
		expect(both?.source).toEqual(UPSTASH_REST_ENV_PAIRS[0]);
		expect(await both?.resolveToken()).toBe("t-upstash");

		const kv = resolveUpstashRestEnv({
			KV_REST_API_URL: url,
			KV_REST_API_TOKEN: "t-kv",
		});
		expect(kv?.source).toEqual({
			url: "KV_REST_API_URL",
			token: "KV_REST_API_TOKEN",
		});
		expect(resolveUpstashRestEnv({})).toBeUndefined();
	});

	it("names a missing half of a pair without echoing the half that is set", () => {
		const attempt = () =>
			resolveUpstashRestEnv({ UPSTASH_REDIS_REST_TOKEN: "t-secret-value" });
		expect(attempt).toThrow(KvRedisCompatibleError);
		expect(attempt).toThrow(/UPSTASH_REDIS_REST_URL is not set/u);
		try {
			attempt();
		} catch (error) {
			expect(String(error)).not.toContain("t-secret-value");
		}
	});

	it("refuses a REST URL off the Upstash data plane, without echoing it", () => {
		const attempt = () =>
			resolveUpstashRestEnv({
				KV_REST_API_URL: "http://user:pw@attacker.example",
				KV_REST_API_TOKEN: "t",
			});
		expect(attempt).toThrow(/KV_REST_API_URL is not an https URL/u);
		try {
			attempt();
		} catch (error) {
			expect(String(error)).not.toContain("attacker");
		}
	});

	it("reads the token at call time, so a rotated value is picked up", async () => {
		const env = { KV_REST_API_URL: url, KV_REST_API_TOKEN: "before" };
		const resolved = resolveUpstashRestEnv(env);
		env.KV_REST_API_TOKEN = "after";
		expect(await resolved?.resolveToken()).toBe("after");
	});
});
