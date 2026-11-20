import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";

/**
 * The world a remote box sees through an enterprise network: every https
 * request goes through a TLS-inspecting proxy the box trusts. Here the
 * proxy answers as the real providers' hosts (`app.infisical.com`,
 * `api.vercel.com`, `neon.new`, ...) with a certificate from a CA only this
 * test trusts, and routes each request to a fake of that provider. Any other
 * host is refused and recorded, so egress that bypasses the proxy or reaches
 * an unexpected host fails the test instead of passing silently.
 *
 * HoBo runs unchanged: no test-only origin, no switch. The binary gets the
 * proxy in HTTPS_PROXY and the CA in NODE_EXTRA_CA_CERTS, as a corporate
 * laptop or an agent sandbox does.
 */

export type ProviderHandler = (
	request: IncomingMessage,
	response: ServerResponse,
) => void | Promise<void>;

export interface TlsWorld {
	/** For HTTPS_PROXY. */
	readonly proxyUrl: string;
	/** For NODE_EXTRA_CA_CERTS: this world's CA (and nothing else). */
	readonly caBundle: string;
	/** Hosts something tried to reach that no fake answers for. */
	readonly blocked: string[];
	/** Every request, as `host METHOD /path`. */
	readonly requests: string[];
	close(): Promise<void>;
}

function certificates(hosts: readonly string[]) {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-tls-world-"));
	const file = (name: string) => path.join(dir, name);
	const openssl = (...args: string[]) =>
		execFileSync("openssl", args, { stdio: "ignore" });
	openssl(
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-days",
		"1",
		"-subj",
		"/CN=HoBo test inspecting proxy CA",
		"-keyout",
		file("ca.key"),
		"-out",
		file("ca.pem"),
	);
	openssl(
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-subj",
		"/CN=hobo-test-providers",
		"-keyout",
		file("leaf.key"),
		"-out",
		file("leaf.csr"),
	);
	writeFileSync(
		file("leaf.ext"),
		`subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\n`,
	);
	openssl(
		"x509",
		"-req",
		"-in",
		file("leaf.csr"),
		"-CA",
		file("ca.pem"),
		"-CAkey",
		file("ca.key"),
		"-CAcreateserial",
		"-days",
		"1",
		"-extfile",
		file("leaf.ext"),
		"-out",
		file("leaf.pem"),
	);
	return {
		caBundle: file("ca.pem"),
		key: readFileSync(file("leaf.key"), "utf8"),
		cert: readFileSync(file("leaf.pem"), "utf8"),
	};
}

/** A request's body, read by the provider that answers it. */
export async function bodyOf(request: IncomingMessage): Promise<string> {
	const parts: Buffer[] = [];
	for await (const part of request) parts.push(Buffer.from(part));
	return Buffer.concat(parts).toString("utf8");
}

export async function startTlsWorld(
	providers: Readonly<Record<string, ProviderHandler>>,
): Promise<TlsWorld> {
	const hosts = Object.keys(providers);
	const tls = certificates(hosts);
	const context = createSecureContext({ key: tls.key, cert: tls.cert });
	const blocked: string[] = [];
	const requests: string[] = [];
	const sockets = new Set<Socket>();

	// What the provider hosts serve, behind the proxy's TLS termination.
	const inner = createServer((request, response) => {
		void (async () => {
			const host = (request.headers.host ?? "").replace(/:\d+$/u, "");
			const handler = providers[host];
			requests.push(`${host} ${request.method ?? "GET"} ${request.url ?? "/"}`);
			if (handler === undefined) {
				response.writeHead(404).end();
				return;
			}
			await handler(request, response);
		})().catch(() => {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});

	const proxy = createServer((request, response) => {
		// Plain-http through the proxy: no provider speaks it here.
		blocked.push(`http ${request.headers.host ?? request.url ?? ""}`);
		response.writeHead(403).end();
	});
	proxy.on("connect", (request: IncomingMessage, socket: Socket) => {
		sockets.add(socket);
		const [host = ""] = (request.url ?? "").split(":");
		if (providers[host] === undefined) {
			blocked.push(host);
			socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		const secure = new TLSSocket(socket, {
			isServer: true,
			secureContext: context,
		});
		inner.emit("connection", secure);
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const { port } = proxy.address() as AddressInfo;
	return {
		proxyUrl: `http://127.0.0.1:${port}`,
		caBundle: tls.caBundle,
		blocked,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				proxy.closeAllConnections();
				proxy.close(() => resolve());
			}),
	};
}

/** Answer JSON. */
export function json(
	response: ServerResponse,
	status: number,
	body: Parameters<typeof JSON.stringify>[0],
): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}
