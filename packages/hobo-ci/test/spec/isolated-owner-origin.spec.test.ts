import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
	egressFetch,
	egressFrom,
	isolatedOwnerEgressFetch,
} from "../../src/egress.js";
import {
	PrivateOwnerDispatchError,
	PrivateOwnerRequestError,
} from "../../src/isolated-owner-errors.js";
import {
	createIsolatedOwnerFetch,
	isolatedOwnerFetch,
} from "../../src/isolated-owner-fetch.js";
import { OWNER_PROXY_CONNECTION_LIMIT } from "../../src/isolated-owner-origin.js";
import { ownerRequest } from "../../src/isolated-owner-wire.js";

const marker = "fixture-private-origin-value";
const address = z.object({ port: z.number().int().positive().max(65535) });

it("constructs ordinary and isolated proxy dispatchers", () => {
	const egress = egressFrom({ HTTPS_PROXY: "http://127.0.0.1:1234" });
	expect(() => egressFetch(egress)).not.toThrow();
	expect(() =>
		isolatedOwnerEgressFetch(egress, [], "https://fixture.invalid"),
	).not.toThrow();
});

it.each([
	{ url: `http://fixture.invalid/${marker}`, allow: false, proxy: false },
	{ url: `http://fixture.invalid/${marker}`, allow: true, proxy: false },
	{ url: `http://127.0.0.1/${marker}`, allow: false, proxy: false },
	{ url: `http://localhost/${marker}`, allow: true, proxy: false },
	{ url: `http://127.0.0.1/${marker}`, allow: true, proxy: true },
])("refuses an unsupported origin before starting a child", async (test) => {
	const launch = vi.fn();
	const send = createIsolatedOwnerFetch(
		test.proxy ? { HTTPS_PROXY: "http://127.0.0.1:8080" } : {},
		launch,
		{ allowInsecureLoopback: test.allow },
	);
	const failure = await send(test.url, {
		method: "POST",
		body: marker,
	}).catch((error) => error);
	expect(failure).toBeInstanceOf(PrivateOwnerRequestError);
	expect(String(failure)).not.toContain(marker);
	expect(launch).not.toHaveBeenCalled();
});

it.each([
	`http://fixture:${marker}@127.0.0.1:8080`,
	`http://fixture@127.0.0.1:8080`,
	`http://:${marker}@127.0.0.1:8080`,
])("refuses an authenticated HTTP proxy before starting a child", async (proxy) => {
	const launch = vi.fn();
	const send = createIsolatedOwnerFetch(
		{ HTTPS_PROXY: proxy, NO_PROXY: "*" },
		launch,
	);
	const failure = await send("https://fixture.invalid/", {
		method: "POST",
		body: marker,
	}).catch((error) => error);
	expect(failure).toBeInstanceOf(PrivateOwnerRequestError);
	expect(String(failure)).not.toContain(marker);
	expect(launch).not.toHaveBeenCalled();
});

it("revalidates proxy credentials in the child before connecting", async () => {
	let connects = 0;
	const proxy = createServer();
	proxy.on("connect", (_request, socket) => {
		connects += 1;
		socket.end(
			"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
		);
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	try {
		const childPath = fileURLToPath(
			new URL("../../dist/isolated-owner-fetch-child.js", import.meta.url),
		);
		const run = async (proxyUrl: string) => {
			const packet = ownerRequest.parse({
				run: {
					id: crypto.randomUUID(),
					secret: "A".repeat(43),
				},
				url: "https://fixture.invalid/",
				method: "POST",
				headers: [],
				redirect: "follow",
				cache: "default",
				credentials: "same-origin",
				integrity: "",
				keepalive: false,
				mode: "cors",
				referrer: "about:client",
				referrerPolicy: "",
				body: null,
				maxResponseBytes: 0,
				allowInsecureLoopback: false,
				trustedCertificates: [],
				egress: { proxy: proxyUrl },
			});
			const child = spawn(process.execPath, [childPath], {
				env: {
					HOBO_OWNER_RUN_ID: packet.run.id,
					HOBO_OWNER_RUN_SECRET: packet.run.secret,
				},
				stdio: ["pipe", "pipe", "ignore"],
			});
			const chunks: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			const closed = once(child, "close");
			child.stdin.end(JSON.stringify(packet));
			const [code] = await closed;
			return { code, output: Buffer.concat(chunks).toString() };
		};
		const port = address.parse(proxy.address()).port;
		const refused = await run(`http://fixture:${marker}@127.0.0.1:${port}`);
		expect(refused.code).toBe(1);
		expect(connects).toBe(0);
		expect(refused.output).not.toContain(marker);
		const unauthenticated = await run(`http://127.0.0.1:${port}`);
		expect(unauthenticated.code).toBe(1);
		expect(connects).toBe(1);
	} finally {
		proxy.closeAllConnections();
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
	}
}, 30_000);

it("bounds a proxy that repeatedly drops its CONNECT socket", async () => {
	let connects = 0;
	const proxy = createServer();
	proxy.on("connect", (_request, socket) => {
		connects += 1;
		if (connects > OWNER_PROXY_CONNECTION_LIMIT) {
			socket.end(
				"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
			);
			return;
		}
		socket.destroy();
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	try {
		const signal = AbortSignal.timeout(15_000);
		const failure = await isolatedOwnerFetch({
			HTTPS_PROXY: `http://127.0.0.1:${address.parse(proxy.address()).port}`,
		})("https://fixture.invalid/", {
			method: "POST",
			body: marker,
			signal,
		}).catch((error) => error);
		expect(failure).toBeInstanceOf(PrivateOwnerDispatchError);
		expect(String(failure)).not.toContain(marker);
		expect(connects).toBe(OWNER_PROXY_CONNECTION_LIMIT);
		expect(signal.aborted).toBe(false);
	} finally {
		proxy.closeAllConnections();
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
	}
}, 30_000);

it("keeps opted-in loopback HTTP redirects on their original origin", async () => {
	let destinationRequests = 0;
	const destination = createServer((_request, response) => {
		destinationRequests += 1;
		response.end("unexpected");
	});
	const source = createServer((_request, response) => {
		response.writeHead(307, {
			location: `http://127.0.0.1:${address.parse(destination.address()).port}/`,
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
			isolatedOwnerFetch({}, { allowInsecureLoopback: true })(
				`http://127.0.0.1:${address.parse(source.address()).port}/`,
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
}, 30_000);

it("contains credentials across redirects and permits same-origin HTTPS", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-owner-origin-"));
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
	let crossOriginRequests = 0;
	let plaintextRequests = 0;
	const crossOrigin = createHttpsServer(tls, (_request, response) => {
		crossOriginRequests += 1;
		response.end("unexpected");
	});
	const plaintext = createServer((_request, response) => {
		plaintextRequests += 1;
		response.end("unexpected");
	});
	const seenHeaders: (string | undefined)[] = [];
	const source = createHttpsServer(tls, (request, response) => {
		seenHeaders.push(
			z.string().optional().parse(request.headers["x-fixture-credential"]),
		);
		if (request.url === "/same") {
			response.writeHead(307, { location: "/target" });
		} else if (request.url === "/cross") {
			response.writeHead(307, {
				location: `https://127.0.0.1:${address.parse(crossOrigin.address()).port}/target`,
			});
		} else if (request.url === "/downgrade") {
			response.writeHead(307, {
				location: `http://127.0.0.1:${address.parse(plaintext.address()).port}/target`,
			});
		}
		response.end("fixture-response");
	});
	await Promise.all(
		[source, crossOrigin, plaintext].map(
			(server) =>
				new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
		),
	);
	const origin = `https://127.0.0.1:${address.parse(source.address()).port}`;
	const send = isolatedOwnerFetch(
		{ SSL_CERT_FILE: cert },
		{ allowInsecureLoopback: true },
	);
	const request: RequestInit = {
		method: "POST",
		headers: { "x-fixture-credential": marker },
		body: marker,
	};
	try {
		const same = await send(`${origin}/same`, request);
		expect(await same.text()).toBe("fixture-response");
		expect(same.redirected).toBe(true);
		for (const path of ["cross", "downgrade"]) {
			const failure = await send(`${origin}/${path}`, request).catch(
				(error) => error,
			);
			expect(failure).toBeInstanceOf(PrivateOwnerDispatchError);
			expect(String(failure)).not.toContain(marker);
		}
		const manual = await send(`${origin}/cross`, {
			...request,
			redirect: "manual",
		});
		expect(manual.status).toBe(307);
		expect(manual.redirected).toBe(false);
		expect(crossOriginRequests).toBe(0);
		expect(plaintextRequests).toBe(0);
		expect(seenHeaders).toEqual(Array(5).fill(marker));
	} finally {
		for (const server of [source, crossOrigin, plaintext])
			server.closeAllConnections();
		await Promise.all(
			[source, crossOrigin, plaintext].map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
		);
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
