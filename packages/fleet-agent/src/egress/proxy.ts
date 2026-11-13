/**
 * The egress proxy (design §6.11 "Egress"): an HTTP proxy on the host's
 * loopback that a sandbox reaches as its only network path. It serves
 * `CONNECT host:port` tunnels and absolute-form requests (`GET http://host/…`,
 * `GET https://host/…`), and connects only when:
 *
 * - the host is exactly one of the order's hosts or the fleet's allowlist
 *   (read again on every request, so a host the fleet drops stops at once);
 *   no wildcard, no suffix match;
 * - neither the name nor any address it resolves to is a metadata,
 *   link-local, loopback, unspecified or multicast address (`addresses.ts`).
 *
 * It then connects to the address it vetted, never to a second lookup. A
 * refusal is `403` and a log line naming the host and the reason; request
 * paths, headers and bodies are never logged.
 */
import { once } from "node:events";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv4, isIPv6, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { EgressProxyFactory, FleetLog } from "@hobo/fleet";
import {
	normaliseHost,
	type RefusalReason,
	refusedAddress,
	refusedName,
} from "./addresses.js";

/** How the proxy resolves names and opens upstream connections. */
export type EgressDeps = Readonly<{
	lookup(host: string): Promise<readonly string[]>;
	connect(address: string, port: number): Socket;
}>;

type Verdict = Readonly<
	| { ok: true; address: string }
	| { ok: false; reason: RefusalReason | "not-allowed" | "unresolved" }
>;

/** Hop-by-hop and proxy headers that are not forwarded upstream. */
const HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authorization",
	"proxy-authenticate",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/** The egress proxy factory over `deps`; `createEgressProxyFactory` passes the host's resolver and sockets. */
export function createEgressProxyFactoryWith(
	options: Readonly<{
		fleetAllow: () => readonly string[];
		log: FleetLog;
		deps: EgressDeps;
	}>,
): EgressProxyFactory {
	return {
		async open(allow) {
			const orderAllow = new Set(allow.map(normaliseHost));
			const vet = async (host: string): Promise<Verdict> => {
				const name = normaliseHost(host);
				const named = refusedName(name);
				if (named !== undefined) return { ok: false, reason: named };
				const allowed =
					orderAllow.has(name) ||
					options.fleetAllow().some((entry) => normaliseHost(entry) === name);
				if (!allowed) return { ok: false, reason: "not-allowed" };
				if (isIPv4(name) || isIPv6(name)) return { ok: true, address: name };
				let addresses: readonly string[];
				try {
					addresses = await options.deps.lookup(name);
				} catch {
					return { ok: false, reason: "unresolved" };
				}
				const [first] = addresses;
				if (first === undefined) return { ok: false, reason: "unresolved" };
				for (const address of addresses) {
					const reason = refusedAddress(address);
					if (reason !== undefined) return { ok: false, reason };
				}
				return { ok: true, address: first };
			};
			const refuse = (host: string, reason: string) => {
				options.log("hobo_fleet_sandbox_unavailable", {
					component: "egress",
					host: normaliseHost(host),
					reason,
				});
			};

			const sockets = new Set<Duplex>();
			const track = (socket: Duplex) => {
				sockets.add(socket);
				socket.once("close", () => sockets.delete(socket));
			};

			const server = createServer((req, res) => {
				track(req.socket);
				void forward(req, res, vet, refuse, options.deps, track);
			});
			server.on("connection", track);
			server.on(
				"connect",
				(req: IncomingMessage, client: Duplex, head: Buffer) => {
					track(client);
					void tunnel(req, client, head, vet, refuse, options.deps, track);
				},
			);
			server.on("clientError", (_error, socket) => {
				socket.destroy();
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			const port =
				address === null ||
				Object.prototype.toString.call(address) === "[object String]"
					? 0
					: // SAFETY: a TCP server listening on a port answers an AddressInfo, not a pipe name.
						(address as Readonly<{ port: number }>).port;
			let closed: Promise<void> | undefined;
			return {
				url: `http://127.0.0.1:${port}`,
				close() {
					closed ??= new Promise<void>((resolve) => {
						server.close(() => resolve());
						for (const socket of sockets) socket.destroy();
					});
					return closed;
				},
			};
		},
	};
}

/** Splits a CONNECT target `host:port` or `[v6]:port`. */
function parseAuthority(
	target: string,
): Readonly<{ host: string; port: number }> | undefined {
	const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(target);
	if (match?.[1] === undefined || match[2] === undefined) return undefined;
	const port = Number(match[2]);
	if (port < 1 || port > 65_535) return undefined;
	return { host: normaliseHost(match[1]), port };
}

async function tunnel(
	req: IncomingMessage,
	client: Duplex,
	head: Buffer,
	vet: (host: string) => Promise<Verdict>,
	refuse: (host: string, reason: string) => void,
	deps: EgressDeps,
	track: (socket: Duplex) => void,
): Promise<void> {
	client.on("error", () => client.destroy());
	const target = parseAuthority(req.url ?? "");
	if (target === undefined) {
		client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return;
	}
	const verdict = await vet(target.host);
	if (!verdict.ok) {
		refuse(target.host, verdict.reason);
		client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
		return;
	}
	const upstream = deps.connect(verdict.address, target.port);
	track(upstream);
	upstream.once("error", () => {
		if (upstream.connecting)
			client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
		else client.destroy();
	});
	upstream.once("connect", () => {
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length > 0) upstream.write(head);
		upstream.pipe(client);
		client.pipe(upstream);
	});
	client.once("close", () => upstream.destroy());
	upstream.once("close", () => client.destroy());
}

async function forward(
	req: IncomingMessage,
	res: ServerResponse,
	vet: (host: string) => Promise<Verdict>,
	refuse: (host: string, reason: string) => void,
	deps: EgressDeps,
	track: (socket: Duplex) => void,
): Promise<void> {
	let target: URL;
	try {
		target = new URL(req.url ?? "");
	} catch {
		res.writeHead(400, { connection: "close" }).end();
		return;
	}
	const secure = target.protocol === "https:";
	if (!secure && target.protocol !== "http:") {
		res.writeHead(400, { connection: "close" }).end();
		return;
	}
	const host = normaliseHost(target.hostname);
	const verdict = await vet(host);
	if (!verdict.ok) {
		refuse(host, verdict.reason);
		res.writeHead(403, { connection: "close" }).end();
		return;
	}
	const port = target.port === "" ? (secure ? 443 : 80) : Number(target.port);
	const headers: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(req.headers))
		if (!HOP_HEADERS.has(name) && value !== undefined) headers[name] = value;
	headers.host = target.host;
	headers.connection = "close";
	const createConnection = () => {
		const raw = deps.connect(verdict.address, port);
		track(raw);
		if (!secure) return raw;
		const tls = tlsConnect({
			socket: raw,
			servername: isIPv4(host) || isIPv6(host) ? undefined : host,
		});
		track(tls);
		return tls;
	};
	const send = secure ? httpsRequest : httpRequest;
	const upstream = send(
		{
			method: req.method,
			path: `${target.pathname}${target.search}`,
			headers,
			createConnection,
		},
		(answer) => {
			const forwarded: OutgoingHttpHeaders = {};
			for (const [name, value] of Object.entries(answer.headers))
				if (!HOP_HEADERS.has(name) && value !== undefined)
					forwarded[name] = value;
			res.writeHead(answer.statusCode ?? 502, forwarded);
			answer.pipe(res);
		},
	);
	upstream.on("error", () => {
		if (!res.headersSent) res.writeHead(502, { connection: "close" });
		res.end();
	});
	req.pipe(upstream);
}
