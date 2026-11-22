import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	PrivateOwnerDispatchError,
	PrivateOwnerRequestError,
} from "../../src/isolated-owner-errors.js";
import { isolatedOwnerFetch } from "../../src/isolated-owner-fetch.js";
import {
	OWNER_BODY_LIMIT,
	OWNER_DEFAULT_RESPONSE_LIMIT,
	ownerTrustCertificates,
} from "../../src/isolated-owner-wire.js";

const marker = "fixture-private-transport-value";
const fixtureOwnerFetch: typeof isolatedOwnerFetch = (env, options) =>
	isolatedOwnerFetch(env, { ...options, allowInsecureLoopback: true });
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
			const error = await fixtureOwnerFetch({})(
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
		let closed: () => void = () => undefined;
		const disconnected = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const server = createServer((_request, response) => {
			response.on("close", closed);
			response.writeHead(200);
			response.write(Buffer.alloc(OWNER_DEFAULT_RESPONSE_LIMIT + 1));
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		try {
			await expect(
				fixtureOwnerFetch({})(`http://127.0.0.1:${address.port}/${marker}`, {
					signal: AbortSignal.timeout(15_000),
				}),
			).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
			await disconnected;
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 60_000);

	it("enforces a consumer's configured response limit before returning a body", async () => {
		let requests = 0;
		const server = createServer((request, response) => {
			requests += 1;
			if (request.url === "/compressed") {
				const body = gzipSync("fixture-body");
				response.writeHead(200, {
					"content-encoding": "gzip",
					"content-length": body.byteLength,
				});
				response.end(body);
				return;
			}
			response.end("fixture-body");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		const url = `http://127.0.0.1:${address.port}/`;
		try {
			await expect(
				fixtureOwnerFetch({}, { maxResponseBytes: 4 })(url),
			).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
			expect(
				await (
					await fixtureOwnerFetch({}, { maxResponseBytes: 12 })(url)
				).text(),
			).toBe("fixture-body");
			expect(
				await (
					await fixtureOwnerFetch(
						{},
						{ maxResponseBytes: 12 },
					)(`${url}compressed`)
				).text(),
			).toBe("fixture-body");
			await expect(
				fixtureOwnerFetch({}, { maxResponseBytes: -1 })(url),
			).rejects.toBeInstanceOf(PrivateOwnerRequestError);
			expect(requests).toBe(3);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);

	it("cancels a slow partial response before its body finishes", async () => {
		let started: () => void = () => undefined;
		let closed: () => void = () => undefined;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const disconnected = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const server = createServer((_request, response) => {
			response.on("close", closed);
			response.writeHead(200);
			response.write("partial");
			started();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		const controller = new AbortController();
		try {
			const pending = fixtureOwnerFetch({})(
				`http://127.0.0.1:${address.port}/`,
				{
					signal: controller.signal,
				},
			);
			await entered;
			controller.abort();
			await expect(pending).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
			await disconnected;
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);

	it("bounds the total encoded trust snapshot", () => {
		const certificate = "fixture-certificate".repeat(1800);
		expect(
			ownerTrustCertificates.safeParse(Array(60).fill(certificate)).success,
		).toBe(true);
		expect(
			ownerTrustCertificates.safeParse(Array(250).fill(certificate)).success,
		).toBe(false);
	});

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
				fixtureOwnerFetch({})(`http://127.0.0.1:${address.port}/${marker}`, {
					redirect: "error",
				}),
			).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
			expect(redirected).toBe(false);
			const failure = await fixtureOwnerFetch({
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
			const send = fixtureOwnerFetch({});
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
			const actual = await fixtureOwnerFetch({})(url, options);
			expect(await expected.text()).toBe(marker);
			expect(await actual.text()).toBe(marker);
			expect(headers[0]).toEqual({
				cacheControl: "no-cache",
				pragma: "no-cache",
			});
			expect(headers[1]).toEqual(headers[0]);
			await expect(
				fixtureOwnerFetch({})(url, {
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
		const tls = { key: readFileSync(key), cert: readFileSync(cert) };
		const server = createHttpsServer(tls, (request, response) => {
			if (request.url === "/redirect") {
				response.writeHead(307, { location: "https://127.0.0.1:1/" });
				response.end();
				return;
			}
			response.end("fixture-ok");
		});
		const proxy = createServer();
		const secureProxy = createHttpsServer(tls);
		let connects = 0;
		const proxyAuth: (string | undefined)[] = [];
		for (const proxyServer of [proxy, secureProxy])
			proxyServer.on("connect", (request, socket, head) => {
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
		await new Promise<void>((resolve) =>
			secureProxy.listen(0, "127.0.0.1", resolve),
		);
		const serverAddress = socketAddress.parse(server.address());
		const proxyAddress = socketAddress.parse(proxy.address());
		const url = `https://127.0.0.1:${serverAddress.port}/`;
		const secureProxyAddress = socketAddress.parse(secureProxy.address());
		const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
		const secureProxyUrl = `https://fixture-user:${marker}@127.0.0.1:${secureProxyAddress.port}`;
		try {
			for (const env of [
				{ SSL_CERT_FILE: cert },
				{ HTTPS_PROXY: proxyUrl, SSL_CERT_FILE: cert },
				{ HTTPS_PROXY: secureProxyUrl, SSL_CERT_FILE: cert },
				{
					HTTPS_PROXY: secureProxyUrl,
					NO_PROXY: "127.0.0.1",
					SSL_CERT_FILE: cert,
				},
			]) {
				const response = await fixtureOwnerFetch(env)(url, {
					signal: AbortSignal.timeout(15_000),
				});
				expect(await response.text()).toBe("fixture-ok");
			}
			await expect(
				fixtureOwnerFetch({ HTTPS_PROXY: proxyUrl, SSL_CERT_FILE: cert })(
					`${url}redirect`,
					{ headers: { "x-fixture-credential": marker } },
				),
			).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
			expect(connects).toBe(3);
			expect(proxyAuth).toEqual([
				undefined,
				`Basic ${Buffer.from(`fixture-user:${marker}`).toString("base64")}`,
				undefined,
			]);
		} finally {
			server.closeAllConnections();
			proxy.closeAllConnections();
			secureProxy.closeAllConnections();
			await Promise.all([
				new Promise<void>((resolve) => server.close(() => resolve())),
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => secureProxy.close(() => resolve())),
			]);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("rejects oversized request bodies before starting a private request", async () => {
		const send = fixtureOwnerFetch({});
		await expect(
			send("https://fixture.invalid", {
				method: "POST",
				body: new Uint8Array(OWNER_BODY_LIMIT + 1),
			}),
		).rejects.toBeInstanceOf(PrivateOwnerRequestError);
	}, 30_000);

	it("preserves the parent's effective system trust without inheriting Node options", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-owner-system-ca-"));
		const key = join(dir, "key.pem");
		const cert = join(dir, "cert.pem");
		const bundle = join(dir, "many-roots.pem");
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
		const hash = execFileSync(
			"openssl",
			["x509", "-hash", "-noout", "-in", cert],
			{
				encoding: "utf8",
			},
		).trim();
		copyFileSync(cert, join(dir, `${hash}.0`));
		writeFileSync(bundle, readFileSync(cert, "utf8").repeat(1200));
		let requests = 0;
		const server = createHttpsServer(
			{ key: readFileSync(key), cert: readFileSync(cert) },
			(_request, response) => {
				requests += 1;
				response.end("fixture-ok");
			},
		);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = socketAddress.parse(server.address());
		const moduleUrl = new URL(
			"../../dist/isolated-owner-fetch.js",
			import.meta.url,
		).href;
		const errorUrl = new URL(
			"../../dist/isolated-owner-errors.js",
			import.meta.url,
		).href;
		const script = `import { isolatedOwnerFetch } from ${JSON.stringify(moduleUrl)}; const result = await isolatedOwnerFetch({})(${JSON.stringify(`https://127.0.0.1:${address.port}/`)}, { signal: AbortSignal.timeout(15000) }); if (await result.text() !== "fixture-ok") process.exitCode = 1;`;
		const refusal = `import { isolatedOwnerFetch } from ${JSON.stringify(moduleUrl)}; import { PrivateOwnerRequestError } from ${JSON.stringify(errorUrl)}; delete process.env.NODE_EXTRA_CA_CERTS; const failure = await isolatedOwnerFetch({})(${JSON.stringify(`https://127.0.0.1:${address.port}/`)}).catch((error) => error); if (!(failure instanceof PrivateOwnerRequestError)) throw new Error("Fixture trust refusal failed.");`;
		try {
			for (const mode of [
				{
					args: [],
					env: { NODE_USE_SYSTEM_CA: "1" },
					many: false,
					deleted: false,
				},
				{ args: ["--use-system-ca"], env: {}, many: false, deleted: false },
				{
					args: [],
					env: { NODE_OPTIONS: "--use-system-ca" },
					many: false,
					deleted: false,
				},
				{
					args: [],
					env: { NODE_EXTRA_CA_CERTS: bundle },
					many: true,
					deleted: false,
				},
				{
					args: [],
					env: { NODE_EXTRA_CA_CERTS: bundle },
					many: false,
					deleted: true,
				},
			]) {
				const childEnv: NodeJS.ProcessEnv = { SSL_CERT_DIR: dir, ...mode.env };
				if (process.platform === "win32" && process.env.SystemRoot)
					childEnv.SystemRoot = process.env.SystemRoot;
				const check = mode.many
					? 'import { getCACertificates } from "node:tls"; if (Buffer.byteLength(JSON.stringify(getCACertificates("default"))) <= 1024 * 1024) throw new Error("Fixture trust snapshot was too small."); '
					: "";
				await promisify(execFile)(
					process.execPath,
					[
						...mode.args,
						"--input-type=module",
						"-e",
						mode.deleted ? refusal : check + script,
					],
					{
						env: childEnv,
						timeout: 20_000,
					},
				);
			}
			expect(requests).toBe(4);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

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
			const pending = fixtureOwnerFetch({})(
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
			const send = fixtureOwnerFetch({});
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
			const pending = fixtureOwnerFetch({})(
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

	it("refuses a redirect outside the approved origin before connecting", async () => {
		let destinationRequests = 0;
		const destination = createServer((_request, response) => {
			destinationRequests += 1;
			response.end("unexpected");
		});
		const source = createServer((_request, response) => {
			response.writeHead(307, {
				location: `http://127.0.0.1:${socketAddress.parse(destination.address()).port}/`,
			});
			response.end();
		});
		await Promise.all(
			[source, destination].map(
				(server) =>
					new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
			),
		);
		try {
			await expect(
				fixtureOwnerFetch({})(
					`http://127.0.0.1:${socketAddress.parse(source.address()).port}/`,
					{ headers: { "x-fixture-credential": marker } },
				),
			).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
			expect(destinationRequests).toBe(0);
		} finally {
			for (const server of [source, destination]) server.closeAllConnections();
			await Promise.all(
				[source, destination].map(
					(server) =>
						new Promise<void>((resolve) => server.close(() => resolve())),
				),
			);
		}
	});

});
