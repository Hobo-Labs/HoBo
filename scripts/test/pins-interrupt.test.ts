/**
 * A download that is interrupted leaves nothing in the cache: the handlers are
 * armed before the first directory or file the fetch makes, they stay until
 * the verified file has been renamed into place, and they clean the partial
 * file and any directory the fetch made on SIGINT, SIGTERM and SIGHUP alike.
 *
 * The script runs as a child of the test and is signalled only once the held
 * server has shown that it is past the point being tested; nothing here waits
 * for a fixed time.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { PinsError } from "../lib/pins.ts";
import { fetchVerified } from "../lib/pins-fetch.ts";
import {
	type FileServer,
	REPO_ROOT,
	scratch,
	sha256Hex,
	spawnBootstrap,
	startServer,
	waitUntil,
	writeManifest,
} from "./support/pins-support.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const BYTES = Buffer.from("#!/bin/sh\necho interrupt\n");
const DIGEST = sha256Hex(BYTES);

let server: FileServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

/** A manifest whose one file is served from `path` of the running server. */
function pinTo(root: string, origin: string, path: string): string {
	const file = {
		url: `${origin}${path}`,
		sha256: DIGEST,
		size: 100_000,
		entry: "tool",
	};
	writeManifest(
		root,
		`{"mirror":{"repo":"${origin}/example/mirror","tag":"v1.0.0","files":{"linux-x64":${JSON.stringify(file)},"linux-arm64":${JSON.stringify(file)}}}}`,
	);
	return join(root, ".cache/siblings", DIGEST);
}

/** The partial file once it holds bytes: the write came after the handlers. */
function partialWithBytes(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	const name = readdirSync(dir).find((entry) => entry.endsWith(".partial"));
	return name !== undefined && statSync(join(dir, name)).size > 0
		? join(dir, name)
		: undefined;
}

describe("a download that is interrupted leaves nothing in the cache", () => {
	for (const signal of SIGNALS) {
		it(`${signal} while the file is being written removes the partial file and the directory`, async () => {
			server = await startServer();
			server.setStall("/stall", Buffer.alloc(3000, 1), 100_000);
			const root = scratch("interrupt-write");
			const digestDir = pinTo(root, server.origin, "/stall");
			const running = spawnBootstrap(root, ["--fetch", "mirror"]);
			await waitUntil("a partial file with bytes in it", () =>
				partialWithBytes(digestDir),
			);
			running.child.kill(signal);
			const ended = await running.done;
			assert.equal(ended.signal, signal, `the script ended by ${signal}`);
			assert.equal(
				existsSync(digestDir),
				false,
				`${digestDir} is gone, not left empty`,
			);
		});

		it(`${signal} while the response is awaited removes the directory the fetch made`, async () => {
			server = await startServer();
			server.setHang("/hang");
			const root = scratch("interrupt-wait");
			const digestDir = pinTo(root, server.origin, "/hang");
			const running = spawnBootstrap(root, ["--fetch", "mirror"]);
			// The request is sent only after the handlers are armed and the
			// directory exists, so the server having it is the handshake.
			await server.requested("/hang");
			assert.equal(existsSync(digestDir), true, "the fetch made its directory");
			running.child.kill(signal);
			const ended = await running.done;
			assert.equal(ended.signal, signal, `the script ended by ${signal}`);
			assert.equal(existsSync(digestDir), false, `${digestDir} is gone`);
		});
	}

	it("the partial file is private while it is being written", async () => {
		server = await startServer();
		server.setStall("/stall", Buffer.alloc(3000, 1), 100_000);
		const root = scratch("interrupt-private");
		const digestDir = pinTo(root, server.origin, "/stall");
		const running = spawnBootstrap(root, ["--fetch", "mirror"]);
		const found = await waitUntil("a partial file with bytes in it", () =>
			partialWithBytes(digestDir),
		);
		const bits = statSync(found).mode & 0o777;
		running.child.kill("SIGTERM");
		await running.done;
		assert.equal(
			bits,
			0o600,
			"not executable, not readable by others, until it is verified",
		);
	});
});

describe("a program that embeds the fetch", () => {
	it("arms its handlers before the directory exists and drops them when it is done", async () => {
		const dir = scratch("interrupt-armed");
		const dest = join(dir, "a", "tool");
		const before = SIGNALS.map((name) => process.listenerCount(name));
		const during: number[] = [];
		let dirExisted = true;
		const ok: typeof fetch = async () => {
			SIGNALS.forEach((name, index) => {
				during.push(process.listenerCount(name) - (before[index] ?? 0));
			});
			dirExisted = existsSync(join(dir, "a"));
			return new Response(BYTES);
		};
		await fetchVerified("https://example.invalid/tool", DIGEST, dest, {
			fetch: ok,
		});
		assert.deepEqual(
			during,
			[1, 1, 1],
			"one handler per signal during the fetch",
		);
		assert.equal(
			dirExisted,
			true,
			"the directory it made already existed then",
		);
		assert.deepEqual(
			SIGNALS.map((name) => process.listenerCount(name)),
			before,
			"every handler is removed once the file is in place",
		);
		const wrong: typeof fetch = async () => new Response("other bytes");
		await assert.rejects(
			fetchVerified(
				"https://example.invalid/tool",
				"b".repeat(64),
				join(dir, "b", "tool"),
				{
					fetch: wrong,
				},
			),
			PinsError,
		);
		assert.deepEqual(
			SIGNALS.map((name) => process.listenerCount(name)),
			before,
			"and when the fetch is refused",
		);
	});

	it("a bad HOBO_PINS_NET_TIMEOUT_MS is refused before any handler is armed", async () => {
		const before = SIGNALS.map((name) => process.listenerCount(name));
		const saved = process.env.HOBO_PINS_NET_TIMEOUT_MS;
		process.env.HOBO_PINS_NET_TIMEOUT_MS = "2m";
		try {
			await assert.rejects(
				fetchVerified(
					"https://example.invalid/tool",
					DIGEST,
					join(scratch("interrupt-badenv"), "a", "tool"),
					{ fetch: async () => new Response(BYTES) },
				),
				(error: Error) => error instanceof PinsError && error.code === "USAGE",
			);
		} finally {
			if (saved === undefined) delete process.env.HOBO_PINS_NET_TIMEOUT_MS;
			else process.env.HOBO_PINS_NET_TIMEOUT_MS = saved;
		}
		assert.deepEqual(
			SIGNALS.map((name) => process.listenerCount(name)),
			before,
			"no handler is left behind",
		);
	});

	it("a signal its own handler also receives reaches that handler once, and the fetch ends", async () => {
		server = await startServer();
		server.setStall("/stall", Buffer.alloc(3000, 1), 100_000);
		const dir = scratch("interrupt-embedded");
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				join(REPO_ROOT, "scripts/test/support/embedded-fetch.mts"),
				server.origin,
				dir,
			],
			{ env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "1" } },
		);
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		let err = "";
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		const closed = new Promise<{ code: number | null; signal: string | null }>(
			(resolve) =>
				child.on("close", (code, signal) => resolve({ code, signal })),
		);
		await waitUntil("a partial file with bytes in it", () =>
			partialWithBytes(join(dir, "d")),
		);
		child.kill("SIGINT");
		const ended = await closed;
		assert.deepEqual(ended, { code: 0, signal: null }, `${out}${err}`);
		assert.match(out, /parent handler calls: 1\b/u);
		assert.match(out, /download: rejected INTERRUPTED/u);
		assert.match(out, /left in the directory: nothing/u);
	});
});
