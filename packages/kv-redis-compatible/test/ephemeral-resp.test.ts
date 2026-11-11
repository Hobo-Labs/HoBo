/**
 * The ephemeral-state suite against a real Valkey or Redis over RESP/TCP.
 *
 * Runs when a server binary is available: `HOBO_VALKEY_SERVER_BIN`, or
 * `valkey-server` / `redis-server` on PATH. Skipped otherwise, so the suite
 * does not need the binary; the same cases run on the in-memory engine in
 * `ephemeral-state.test.ts`. This is the lane that checks the Lua scripts
 * themselves — the in-memory engine only mirrors them.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { type AddressInfo, createServer, Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createRedisEphemeralState,
	EPHEMERAL_SCRIPTS,
	EPHEMERAL_STATE_CONFORMANCE_CASES,
	type EphemeralConformanceContext,
	meterExecutor,
	runKvRedisConformance,
	scriptSha1,
} from "../src/index.js";
import {
	createRespExecutor,
	type RespExecutor,
	resolveRedisProtocolEnv,
} from "../src/resp-executor.js";
import { verifyEphemeralPactProvider } from "./fixtures/ephemeral-pact.js";

const binary =
	process.env.HOBO_VALKEY_SERVER_BIN ??
	(spawnSync("valkey-server", ["--version"]).status === 0
		? "valkey-server"
		: spawnSync("redis-server", ["--version"]).status === 0
			? "redis-server"
			: "");

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			// SAFETY: a TCP server listening on a host and port reports an AddressInfo.
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

async function until(check: () => Promise<boolean>, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("condition not reached in time");
}

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

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!binary)(
	"ephemeral-state conformance — Valkey/Redis over RESP",
	() => {
		let server: ChildProcess | undefined;
		let url = "";
		const executors: RespExecutor[] = [];

		const connect = () => {
			const executor = createRespExecutor({ url });
			executors.push(executor);
			return executor;
		};

		beforeAll(async () => {
			const port = await freePort();
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
			await until(() => accepts(port));
			url = `redis://127.0.0.1:${port}`;
		});

		afterAll(async () => {
			await Promise.all(executors.map((executor) => executor.close()));
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
			const metered = meterExecutor(connect());
			const first = createRedisEphemeralState({ executor: metered });
			const others = [1, 2, 3].map(() =>
				createRedisEphemeralState({ executor: connect() }),
			);
			return {
				clients: [first, ...others],
				advanceTime: sleep,
				usage: () => metered.usage(),
				keyPrefix: `resp-${run}:`,
				ttlMs: 300,
			};
		};

		for (const entry of EPHEMERAL_STATE_CONFORMANCE_CASES) {
			it(entry.id, async () => {
				await entry.run(context());
			});
		}

		it("loads each script under the SHA-1 the binding sends as EVALSHA", async () => {
			const executor = connect();
			for (const script of Object.values(EPHEMERAL_SCRIPTS)) {
				const reply = await executor.execute(["SCRIPT", "LOAD", script.body]);
				expect(reply).toEqual({
					kind: "value",
					value: await scriptSha1(script.body),
				});
			}
		});

		it("answers the executor pact as the in-memory engine does", async () => {
			const executor = connect();
			await executor.execute(["SCRIPT", "FLUSH"]);
			await executor.execute(["DEL", "pact:lease:42", "pact:absent"]);
			for (const result of await verifyEphemeralPactProvider(executor)) {
				expect(result.actual, result.description).toEqual(result.expected);
			}
		});

		it("returns command errors as error replies, not throws", async () => {
			const reply = await connect().execute(["NOT-A-COMMAND"]);
			expect(reply.kind).toBe("error");
		});

		it("also passes the command-level kv.redis-compatible suite", async () => {
			const executor = connect();
			const report = await runKvRedisConformance({
				executor: {
					execute: (command) => executor.execute(command),
					advanceTime: sleep,
				},
				transport: "resp",
				keyPrefix: "resp-kv:",
			});
			expect(report.failedCaseIds).toEqual([]);
			expect(report.outcome).not.toBe("fail");
		});
	},
);

describe("binding a self-hosted server from the environment", () => {
	it("prefers VALKEY_URL, then REDIS_URL, and names the source without echoing the value", () => {
		expect(
			resolveRedisProtocolEnv({
				REDIS_URL: "redis://h:1",
				VALKEY_URL: "redis://v:1",
			})?.source,
		).toBe("VALKEY_URL");
		expect(resolveRedisProtocolEnv({ REDIS_URL: "rediss://h:1" })?.source).toBe(
			"REDIS_URL",
		);
		expect(resolveRedisProtocolEnv({})).toBeUndefined();
		const secretish = "https://user:hunter2@example.test";
		expect(() => resolveRedisProtocolEnv({ REDIS_URL: secretish })).toThrow(
			/REDIS_URL must be a redis:\/\/ or rediss:\/\/ URL$/u,
		);
		try {
			resolveRedisProtocolEnv({ REDIS_URL: secretish });
		} catch (error) {
			expect(String(error)).not.toContain("hunter2");
		}
	});
});
