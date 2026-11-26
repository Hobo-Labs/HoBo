/**
 * The verified, content-addressed fetch that every asset pin goes through:
 * bytes are kept only when they hash to the pin, nothing unverified is ever
 * executable, and the cache is keyed by content and re-hashed before it is
 * trusted.
 */
import assert from "node:assert/strict";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { PinsError } from "../lib/pins.ts";
import { cachedPath } from "../lib/pins-assets.ts";
import {
	ensureCached,
	fetchText,
	fetchVerified,
	verifyCached,
} from "../lib/pins-fetch.ts";
import {
	type FileServer,
	scratch,
	sha256Hex,
	startServer,
	waitUntil,
} from "./support/pins-support.ts";

const DIGEST = "a".repeat(64);

describe("fetchVerified", () => {
	let server: FileServer | undefined;
	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	it("writes the file only after its digest matches, executable, with no partial left", async () => {
		server = await startServer();
		const bytes = Buffer.from("#!/bin/sh\necho hi\n");
		server.setFile("/tool", bytes);
		const dir = scratch("fetch-ok");
		const dest = join(dir, "tool");
		await fetchVerified(`${server.origin}/tool`, sha256Hex(bytes), dest, {
			allowLocal: true,
		});
		assert.deepEqual(readFileSync(dest), bytes);
		assert.ok(
			(statSync(dest).mode & 0o111) !== 0,
			"verified file is executable",
		);
		assert.deepEqual(readdirSync(dir), ["tool"]);
	});

	it("deletes the partial file and extracts nothing when the digest differs", async () => {
		server = await startServer();
		server.setFile("/tool", "tampered bytes");
		const dir = scratch("fetch-bad");
		const dest = join(dir, "tool");
		await assert.rejects(
			fetchVerified(
				`${server.origin}/tool`,
				sha256Hex("the pinned bytes"),
				dest,
				{
					allowLocal: true,
				},
			),
			(error: Error) =>
				error instanceof PinsError &&
				error.code === "DIGEST_MISMATCH" &&
				error.message.includes(sha256Hex("tampered bytes")),
		);
		assert.equal(existsSync(dest), false, "nothing is installed");
		assert.equal(
			existsSync(`${dest}.partial`),
			false,
			"no partial file is left",
		);
		assert.deepEqual(readdirSync(dir), []);
	});

	it("leaves no directory it created when the fetch fails", async () => {
		server = await startServer();
		server.setFile("/tool", "tampered bytes");
		const dir = scratch("fetch-dir");
		const dest = join(dir, "a", "b", "tool");
		await assert.rejects(
			fetchVerified(`${server.origin}/tool`, sha256Hex("pinned"), dest, {
				allowLocal: true,
			}),
			PinsError,
		);
		assert.equal(existsSync(join(dir, "a")), false);
		assert.equal(
			existsSync(dir),
			true,
			"a directory that was already there stays",
		);
	});

	it("stops reading at the declared size", async () => {
		server = await startServer();
		server.setFile("/big", Buffer.alloc(5000, 7));
		const dir = scratch("fetch-size");
		const dest = join(dir, "big");
		await assert.rejects(
			fetchVerified(`${server.origin}/big`, DIGEST, dest, {
				allowLocal: true,
				maxBytes: 100,
			}),
			(error: Error) =>
				error instanceof PinsError && error.code === "SIZE_EXCEEDED",
		);
		assert.deepEqual(readdirSync(dir), []);
	});

	it("checks the bytes the open file holds, not only the bytes that arrived", async () => {
		server = await startServer();
		const bytes = Buffer.from("#!/bin/sh\necho the pinned build\n");
		const gate = server.setGate(
			"/tool",
			bytes.subarray(0, 10),
			bytes.subarray(10),
		);
		const dir = scratch("fetch-fd");
		const dest = join(dir, "tool");
		const fetched = fetchVerified(
			`${server.origin}/tool`,
			sha256Hex(bytes),
			dest,
			{
				allowLocal: true,
			},
		);
		const partial = await waitUntil("a partial file with bytes in it", () => {
			const name = readdirSync(dir).find((entry) => entry.endsWith(".partial"));
			return name !== undefined && statSync(join(dir, name)).size > 0
				? join(dir, name)
				: undefined;
		});
		// Someone who can write the cache changes a byte the stream already hashed.
		const fd = openSync(partial, "r+");
		writeSync(fd, Buffer.from("X"), 0, 1, 0);
		closeSync(fd);
		gate.release();
		await assert.rejects(
			fetched,
			(error: Error) =>
				error instanceof PinsError &&
				error.code === "DIGEST_MISMATCH" &&
				/on disk/u.test(error.message),
		);
		assert.deepEqual(readdirSync(dir), [], "nothing was published");
	});

	it("reports an http error status without leaving a file", async () => {
		server = await startServer();
		const dir = scratch("fetch-404");
		await assert.rejects(
			fetchVerified(`${server.origin}/missing`, DIGEST, join(dir, "x"), {
				allowLocal: true,
			}),
			(error: Error) =>
				error instanceof PinsError && error.code === "HTTP_STATUS",
		);
		assert.deepEqual(readdirSync(dir), []);
	});

	it("refuses a redirect to a host that is not loopback before contacting it", async () => {
		server = await startServer();
		server.setRedirect("/go", "http://example.invalid/tool");
		const dir = scratch("fetch-redirect");
		await assert.rejects(
			fetchVerified(`${server.origin}/go`, DIGEST, join(dir, "x"), {
				allowLocal: true,
			}),
			(error: Error) =>
				error instanceof PinsError && error.code === "REDIRECT_REFUSED",
		);
	});

	it("follows five redirects and refuses a sixth", async () => {
		server = await startServer();
		const bytes = Buffer.from("at the end of the chain");
		server.setFile("/final", bytes);
		const chain = (hops: number): string => {
			for (let hop = 1; hop <= hops; hop += 1) {
				const next = hop === hops ? "/final" : `/hop${hop + 1}`;
				server?.setRedirect(`/hop${hop}`, `${server.origin}${next}`);
			}
			return `${server?.origin}/hop1`;
		};
		const dir = scratch("fetch-hops");
		await fetchVerified(chain(5), sha256Hex(bytes), join(dir, "five"), {
			allowLocal: true,
		});
		assert.deepEqual(readFileSync(join(dir, "five")), bytes);
		await assert.rejects(
			fetchVerified(chain(6), sha256Hex(bytes), join(dir, "six"), {
				allowLocal: true,
			}),
			(error: Error) =>
				error instanceof PinsError &&
				error.code === "REDIRECT_REFUSED" &&
				/more than 5 times/u.test(error.message),
		);
		assert.equal(existsSync(join(dir, "six")), false);
	});

	it("refuses a file whose length is not the pinned size even when its digest matches", async () => {
		server = await startServer();
		const bytes = Buffer.from("exactly this long");
		server.setFile("/tool", bytes);
		const dir = scratch("fetch-length");
		const dest = join(dir, "tool");
		await assert.rejects(
			fetchVerified(`${server.origin}/tool`, sha256Hex(bytes), dest, {
				allowLocal: true,
				expectedSize: bytes.byteLength + 1,
			}),
			(error: Error) =>
				error instanceof PinsError &&
				error.code === "SIZE_MISMATCH" &&
				error.message.includes(`${bytes.byteLength} bytes`),
		);
		assert.deepEqual(readdirSync(dir), [], "nothing was kept");
	});

	it("refuses an http url unless local sources are allowed", async () => {
		const dir = scratch("fetch-scheme");
		await assert.rejects(
			fetchVerified("http://127.0.0.1:9/tool", DIGEST, join(dir, "x")),
			(error: Error) =>
				error instanceof PinsError && error.code === "PINS_MALFORMED",
		);
	});
});

describe("fetchText", () => {
	let server: FileServer | undefined;
	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	it("reads a small document", async () => {
		server = await startServer();
		server.setFile("/sums", "abc  file\n");
		assert.equal(
			await fetchText(`${server.origin}/sums`, { allowLocal: true }),
			"abc  file\n",
		);
	});

	it("stops at its size cap and refuses an http error status", async () => {
		server = await startServer();
		server.setFile("/big", Buffer.alloc(5000, 65));
		await assert.rejects(
			fetchText(`${server.origin}/big`, { allowLocal: true, maxBytes: 100 }),
			(error: Error) =>
				error instanceof PinsError && error.code === "SIZE_EXCEEDED",
		);
		await assert.rejects(
			fetchText(`${server.origin}/none`, { allowLocal: true }),
			(error: Error) =>
				error instanceof PinsError && error.code === "HTTP_STATUS",
		);
	});
});

describe("the content-addressed cache", () => {
	let server: FileServer | undefined;
	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	function file(origin: string, path: string, bytes: Buffer) {
		return {
			url: `${origin}${path}`,
			sha256: sha256Hex(bytes),
			size: bytes.byteLength,
			entry: "tool",
		};
	}

	it("the same bytes fetched from two urls occupy one directory and one request", async () => {
		server = await startServer();
		const bytes = Buffer.from("same bytes");
		server.setFile("/one", bytes);
		server.setFile("/two", bytes);
		const cache = scratch("cache");
		const first = await ensureCached(
			cache,
			file(server.origin, "/one", bytes),
			{ allowLocal: true },
		);
		const second = await ensureCached(
			cache,
			file(server.origin, "/two", bytes),
			{ allowLocal: true },
		);
		assert.equal(first.downloaded, true);
		assert.equal(second.downloaded, false);
		assert.equal(first.path, second.path);
		assert.deepEqual(readdirSync(cache), [sha256Hex(bytes)]);
		assert.deepEqual(server.hits, ["GET /one"]);
	});

	it("verifyCached tells absent, ok and a file edited by one byte", async () => {
		server = await startServer();
		const bytes = Buffer.from("verify me");
		server.setFile("/v", bytes);
		const cache = scratch("verify");
		const entry = file(server.origin, "/v", bytes);
		assert.deepEqual(await verifyCached(cache, entry), { state: "absent" });
		await ensureCached(cache, entry, { allowLocal: true });
		assert.deepEqual(await verifyCached(cache, entry), { state: "ok" });
		const path = cachedPath(cache, entry);
		const edited = Buffer.from(readFileSync(path));
		edited[0] = (edited[0] ?? 0) ^ 1;
		writeFileSync(path, edited);
		const state = await verifyCached(cache, entry);
		assert.equal(state.state, "mismatch");
	});

	it("a cached file that no longer matches is replaced, not trusted", async () => {
		server = await startServer();
		const bytes = Buffer.from("heal me");
		server.setFile("/h", bytes);
		const cache = scratch("heal");
		const entry = file(server.origin, "/h", bytes);
		await ensureCached(cache, entry, { allowLocal: true });
		writeFileSync(cachedPath(cache, entry), "corrupt");
		const again = await ensureCached(cache, entry, { allowLocal: true });
		assert.equal(again.downloaded, true);
		assert.deepEqual(readFileSync(again.path), bytes);
	});
});
