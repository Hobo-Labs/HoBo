import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	PrivateOwnerDispatchError,
	PrivateOwnerRequestError,
} from "../../src/isolated-owner-errors.js";
import { isolatedOwnerFetch } from "../../src/isolated-owner-fetch.js";
import { OWNER_BODY_LIMIT } from "../../src/isolated-owner-wire.js";

const marker = "fixture-private-transport-value";
const socketAddress = z.object({
	port: z.number().int().positive().max(65535),
});

describe("isolated owner fetch", () => {
	it("treats a lost response after dispatch as uncertain without leaking details", async () => {
		let dispatched = false;
		const server = createServer((request) => {
			dispatched = true;
			request.resume();
			request.on("end", () => request.socket.destroy());
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		try {
			const error = await isolatedOwnerFetch({})(
				`http://127.0.0.1:${address.port}/${marker}`,
				{
					method: "POST",
					body: marker,
				},
			).catch((failure) => failure);
			expect(dispatched).toBe(true);
			expect(error).toBeInstanceOf(PrivateOwnerDispatchError);
			expect(String(error)).not.toContain(marker);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);

	it("bounds response bodies and treats an oversized answer as uncertain", async () => {
		const server = createServer((_request, response) => {
			response.end(Buffer.alloc(OWNER_BODY_LIMIT + 1));
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		try {
			await expect(
				isolatedOwnerFetch({})(`http://127.0.0.1:${address.port}/${marker}`),
			).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 60_000);

	it("does not follow a refused redirect or expose a child failure", async () => {
		let redirected = false;
		const server = createServer((request, response) => {
			if (request.url === "/second") redirected = true;
			response.writeHead(302, { location: "/second" });
			response.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		try {
			await expect(
				isolatedOwnerFetch({})(`http://127.0.0.1:${address.port}/${marker}`, {
					redirect: "error",
				}),
			).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
			expect(redirected).toBe(false);
			const failure = await isolatedOwnerFetch({
				SSL_CERT_FILE: `/fixture/${marker}`,
			})(`http://127.0.0.1:${address.port}/`).catch((error) => error);
			expect(failure).toBeInstanceOf(PrivateOwnerDispatchError);
			expect(String(failure)).not.toContain(marker);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);

	it("preserves redirect metadata, cloned bodies, and HEAD responses", async () => {
		const server = createServer((request, response) => {
			if (request.url === "/first") {
				response.writeHead(302, { location: "/second" });
				response.end();
				return;
			}
			response.end(marker);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		const origin = `http://127.0.0.1:${address.port}`;
		try {
			const send = isolatedOwnerFetch({});
			const response = await send(`${origin}/first`);
			const copy = response.clone();
			for (const result of [response, copy]) {
				expect(result.url).toBe(`${origin}/second`);
				expect(result.redirected).toBe(true);
				expect(result.type).toBe("basic");
				expect(await result.text()).toBe(marker);
			}
			const head = await send(`${origin}/first`, { method: "HEAD" });
			expect(head.url).toBe(`${origin}/second`);
			expect(head.redirected).toBe(true);
			expect(head.body).toBeNull();
			expect(await head.text()).toBe("");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);

	it("preserves request integrity and cache behavior", async () => {
		const headers: {
			cacheControl: string | undefined;
			pragma: string | undefined;
		}[] = [];
		const server = createServer((request, response) => {
			headers.push({
				cacheControl: request.headers["cache-control"],
				pragma: request.headers.pragma,
			});
			response.end(marker);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		const url = `http://127.0.0.1:${address.port}/`;
		const integrity = `sha256-${createHash("sha256").update(marker).digest("base64")}`;
		const options: RequestInit = {
			cache: "no-store",
			credentials: "omit",
			integrity,
			keepalive: true,
			mode: "same-origin",
			referrer: "https://fixture.invalid/private",
			referrerPolicy: "no-referrer",
		};
		try {
			const expected = await fetch(url, options);
			const actual = await isolatedOwnerFetch({})(url, options);
			expect(await expected.text()).toBe(marker);
			expect(await actual.text()).toBe(marker);
			expect(headers[0]).toEqual({
				cacheControl: "no-cache",
				pragma: "no-cache",
			});
			expect(headers[1]).toEqual(headers[0]);
			await expect(
				isolatedOwnerFetch({})(url, {
					integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
				}),
			).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);

	it("honors the selected proxy, bypass list, and CA bundle in the child", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-owner-ca-"));
		const key = join(dir, "key.pem");
		const cert = join(dir, "cert.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
				"-keyout",
				key,
				"-out",
				cert,
			],
			{ stdio: "ignore" },
		);
		const server = createHttpsServer(
			{ key: readFileSync(key), cert: readFileSync(cert) },
			(_request, response) => response.end("fixture-ok"),
		);
		const proxy = createServer();
		let connects = 0;
		const proxyAuth: (string | undefined)[] = [];
		proxy.on("connect", (request, socket, head) => {
			connects += 1;
			proxyAuth.push(request.headers["proxy-authorization"]);
			const address = socketAddress.parse(server.address());
			const upstream = connect(address.port, "127.0.0.1", () => {
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) upstream.write(head);
				socket.pipe(upstream).pipe(socket);
			});
			upstream.on("error", () => socket.destroy());
			socket.on("error", () => upstream.destroy());
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const serverAddress = socketAddress.parse(server.address());
		const proxyAddress = socketAddress.parse(proxy.address());
		const url = `https://127.0.0.1:${serverAddress.port}/`;
		const proxyUrl = `http://fixture-user:${marker}@127.0.0.1:${proxyAddress.port}`;
		try {
			for (const env of [
				{ SSL_CERT_FILE: cert },
				{ HTTPS_PROXY: proxyUrl, SSL_CERT_FILE: cert },
				{ HTTPS_PROXY: proxyUrl, NO_PROXY: "127.0.0.1", SSL_CERT_FILE: cert },
			]) {
				const response = await isolatedOwnerFetch(env)(url, {
					signal: AbortSignal.timeout(15_000),
				});
				expect(await response.text()).toBe("fixture-ok");
			}
			expect(connects).toBe(1);
			expect(proxyAuth).toEqual([
				`Basic ${Buffer.from(`fixture-user:${marker}`).toString("base64")}`,
			]);
		} finally {
			server.closeAllConnections();
			proxy.closeAllConnections();
			await Promise.all([
				new Promise<void>((resolve) => server.close(() => resolve())),
				new Promise<void>((resolve) => proxy.close(() => resolve())),
			]);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("rejects oversized request bodies before starting a private request", async () => {
		const send = isolatedOwnerFetch({});
		await expect(
			send("https://fixture.invalid", {
				method: "POST",
				body: new Uint8Array(OWNER_BODY_LIMIT + 1),
			}),
		).rejects.toBeInstanceOf(PrivateOwnerRequestError);
	}, 30_000);

	it("keeps in-flight request and response events out of the parent diagnostics channels", async () => {
		let accept: () => void = () => undefined;
		const entered = new Promise<void>((resolve) => {
			accept = resolve;
		});
		let reply: ServerResponse | undefined;
		let received = "";
		const server = createServer((request, response) => {
			received = `${request.url} ${request.headers.authorization}`;
			request.on("data", (chunk: Buffer) => {
				received += chunk.toString();
			});
			request.on("end", () => {
				reply = response;
				accept();
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		const earlyListener = vi.fn();
		const lateListener = vi.fn();
		const channels = [
			"undici:request:create",
			"undici:client:sendHeaders",
			"undici:request:bodyChunkSent",
			"undici:request:headers",
			"undici:request:bodyChunkReceived",
		];
		try {
			for (const channel of channels) subscribe(channel, earlyListener);
			const pending = isolatedOwnerFetch({})(
				`http://127.0.0.1:${address.port}/${marker}`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${marker}` },
					body: marker,
				},
			);
			await entered;
			subscribe("undici:request:headers", lateListener);
			subscribe("undici:request:bodyChunkReceived", lateListener);
			reply?.writeHead(200, { "x-fixture": marker });
			reply?.end(marker);
			const response = await pending;
			expect(await response.text()).toBe(marker);
			expect(response.headers.get("x-fixture")).toBe(marker);
			expect(received).toContain(marker);
			expect(earlyListener).not.toHaveBeenCalled();
			expect(lateListener).not.toHaveBeenCalled();
		} finally {
			for (const channel of channels) unsubscribe(channel, earlyListener);
			unsubscribe("undici:request:headers", lateListener);
			unsubscribe("undici:request:bodyChunkReceived", lateListener);
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);

	it("does not inherit a Node preload or expose provider text on failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-owner-child-"));
		const preload = join(dir, "preload.cjs");
		const proof = join(dir, "loaded");
		writeFileSync(
			preload,
			`require("node:fs").writeFileSync(${JSON.stringify(proof)}, "loaded")`,
		);
		const prior = process.env.NODE_OPTIONS;
		process.env.NODE_OPTIONS = `--require=${preload}`;
		try {
			const send = isolatedOwnerFetch({});
			const server = createServer((_request, response) => {
				response.statusCode = 401;
				response.end(marker);
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const address = socketAddress.parse(server.address());
			try {
				const response = await send(`http://127.0.0.1:${address.port}/`);
				expect(response.status).toBe(401);
				expect(await response.text()).toBe(marker);
				expect(() => readFileSync(proof)).toThrow();
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			await expect(send(`http://127.0.0.1:1/${marker}`)).rejects.toBeInstanceOf(
				PrivateOwnerDispatchError,
			);
		} finally {
			if (prior === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = prior;
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("treats cancellation after dispatch as uncertain", async () => {
		let accept: () => void = () => undefined;
		const entered = new Promise<void>((resolve) => {
			accept = resolve;
		});
		const server = createServer((_request, _response) => accept());
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		const controller = new AbortController();
		try {
			const pending = isolatedOwnerFetch({})(
				`http://127.0.0.1:${address.port}/${marker}`,
				{
					method: "POST",
					body: marker,
					signal: controller.signal,
				},
			);
			await entered;
			controller.abort();
			await expect(pending).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);
});
