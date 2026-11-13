/**
 * The per-order egress proxy (design §6.11 "Egress", §7.3 EgressProxyFactory):
 * exact hosts only, link-local and metadata addresses always refused, one
 * instance per `open`.
 */
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createServer, type Server, connect as tcpConnect } from "node:net";
import type { FleetLog } from "@hobo/fleet";
import { afterEach, describe, expect, it } from "vitest";
import { normaliseHost, refusedAddress } from "../../src/egress/addresses.js";
import { createEgressProxyFactory } from "../../src/egress/index.js";
import {
	createEgressProxyFactoryWith,
	type EgressDeps,
} from "../../src/egress/proxy.js";

type Logged = Readonly<{
	event: string;
	fields: Readonly<Record<string, string | number | boolean>>;
}>;

const logs: Logged[] = [];
const log: FleetLog = (event, fields) => {
	logs.push({ event, fields });
};

const servers: Server[] = [];
afterEach(async () => {
	logs.length = 0;
	for (const server of servers.splice(0))
		await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** An upstream that answers every HTTP request with 200 "upstream <path>". */
async function upstream(): Promise<number> {
	const server = createServer((socket) => {
		socket.once("data", (chunk) => {
			const path = chunk.toString("latin1").split(" ")[1] ?? "";
			const body = `upstream ${path}`;
			socket.end(
				`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
			);
		});
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (
		address === null ||
		Object.prototype.toString.call(address) === "[object String]"
	)
		throw new Error("no port");
	// SAFETY: a TCP server listening on a port answers an AddressInfo.
	return (address as { port: number }).port;
}

/** Deps that resolve names from `table` and connect every vetted address to the local upstream. */
function deps(
	table: Readonly<Record<string, readonly string[]>>,
	upstreamPort: number,
	connected: string[],
): EgressDeps {
	return {
		async lookup(host) {
			const found = table[host];
			if (found === undefined) throw new Error(`ENOTFOUND ${host}`);
			return found;
		},
		connect(address, port) {
			connected.push(`${address}:${port}`);
			return tcpConnect(upstreamPort, "127.0.0.1");
		},
	};
}

/** Sends CONNECT through the proxy; answers the status line. */
async function connectThrough(
	proxyUrl: string,
	target: string,
): Promise<string> {
	const url = new URL(proxyUrl);
	const socket = tcpConnect(Number(url.port), url.hostname);
	await once(socket, "connect");
	socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
	const [chunk] = await once(socket, "data");
	socket.destroy();
	return String(chunk).split("\r\n")[0] ?? "";
}

/** An absolute-form GET through the proxy; answers status and body. */
function getThrough(
	proxyUrl: string,
	target: string,
): Promise<Readonly<{ status: number; body: string }>> {
	const url = new URL(proxyUrl);
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: url.hostname,
				port: Number(url.port),
				path: target,
				method: "GET",
				headers: { host: new URL(target).host },
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("refusedAddress", () => {
	it.each([
		["169.254.169.254", "metadata"],
		["169.254.170.2", "link-local"],
		["100.100.100.200", "metadata"],
		["fd00:ec2::254", "metadata"],
		["fe80::1", "link-local"],
		["::ffff:169.254.169.254", "metadata"],
		["127.0.0.1", "loopback"],
		["::1", "loopback"],
		["0.0.0.0", "unspecified"],
		["224.0.0.1", "multicast"],
	])("refuses %s as %s", (address, reason) => {
		expect(refusedAddress(address)).toBe(reason);
	});

	it.each([
		"93.184.216.34",
		"10.1.2.3",
		"2606:2800:220:1:248:1893:25c8:1946",
	])("allows %s", (address) => {
		expect(refusedAddress(address)).toBeUndefined();
	});

	it("normalises hosts: lower case, no trailing dot, no IPv6 brackets", () => {
		expect(normaliseHost("Example.COM.")).toBe("example.com");
		expect(normaliseHost("[fe80::1]")).toBe("fe80::1");
	});
});

describe("createEgressProxyFactoryWith", () => {
	it("tunnels CONNECT to an allowed host, on its vetted address", async () => {
		const port = await upstream();
		const connected: string[] = [];
		const factory = createEgressProxyFactoryWith({
			fleetAllow: () => [],
			log,
			deps: deps({ "allowed.test": ["93.184.216.34"] }, port, connected),
		});
		const proxy = await factory.open(["allowed.test"]);
		try {
			expect(await connectThrough(proxy.url, "allowed.test:443")).toMatch(
				/^HTTP\/1\.1 200/u,
			);
			expect(connected).toEqual(["93.184.216.34:443"]);
		} finally {
			await proxy.close();
		}
	});

	it("forwards an absolute-form GET to an allowed host", async () => {
		const port = await upstream();
		const factory = createEgressProxyFactoryWith({
			fleetAllow: () => ["fleet.test"],
			log,
			deps: deps({ "fleet.test": ["93.184.216.34"] }, port, []),
		});
		const proxy = await factory.open([]);
		try {
			const answer = await getThrough(proxy.url, "http://fleet.test/hello?x=1");
			expect(answer).toEqual({ status: 200, body: "upstream /hello?x=1" });
		} finally {
			await proxy.close();
		}
	});

	it.each([
		["the metadata address", "169.254.169.254:80", ["169.254.169.254"]],
		["a link-local address", "169.254.170.2:80", ["169.254.170.2"]],
	])("refuses %s even when it is listed", async (_name, target, allow) => {
		const port = await upstream();
		const connected: string[] = [];
		const factory = createEgressProxyFactoryWith({
			fleetAllow: () => [],
			log,
			deps: deps({}, port, connected),
		});
		const proxy = await factory.open(allow);
		try {
			expect(await connectThrough(proxy.url, target)).toMatch(
				/^HTTP\/1\.1 403/u,
			);
			const answer = await getThrough(
				proxy.url,
				`http://${target}/latest/meta-data/`,
			);
			expect(answer.status).toBe(403);
			expect(connected).toEqual([]);
		} finally {
			await proxy.close();
		}
	});

	it("refuses an unlisted host without resolving it", async () => {
		const port = await upstream();
		const connected: string[] = [];
		const looked: string[] = [];
		const base = deps({ "other.test": ["93.184.216.34"] }, port, connected);
		const factory = createEgressProxyFactoryWith({
			fleetAllow: () => ["fleet.test"],
			log,
			deps: {
				lookup(host) {
					looked.push(host);
					return base.lookup(host);
				},
				connect: base.connect,
			},
		});
		const proxy = await factory.open(["allowed.test"]);
		try {
			expect(await connectThrough(proxy.url, "other.test:443")).toMatch(
				/^HTTP\/1\.1 403/u,
			);
			expect((await getThrough(proxy.url, "http://other.test/")).status).toBe(
				403,
			);
			expect(await connectThrough(proxy.url, "sub.allowed.test:443")).toMatch(
				/^HTTP\/1\.1 403/u,
			);
			expect(looked).toEqual([]);
			expect(connected).toEqual([]);
			expect(logs.some((entry) => entry.fields.host === "other.test")).toBe(
				true,
			);
		} finally {
			await proxy.close();
		}
	});

	it("refuses a listed name that resolves to a metadata or link-local address", async () => {
		const port = await upstream();
		const connected: string[] = [];
		const factory = createEgressProxyFactoryWith({
			fleetAllow: () => [],
			log,
			deps: deps(
				{
					"rebind.test": ["93.184.216.34", "169.254.169.254"],
					"local.test": ["127.0.0.1"],
				},
				port,
				connected,
			),
		});
		const proxy = await factory.open(["rebind.test", "local.test"]);
		try {
			expect(await connectThrough(proxy.url, "rebind.test:443")).toMatch(
				/^HTTP\/1\.1 403/u,
			);
			expect(await connectThrough(proxy.url, "local.test:443")).toMatch(
				/^HTTP\/1\.1 403/u,
			);
			expect(connected).toEqual([]);
		} finally {
			await proxy.close();
		}
	});

	it("reads the fleet's allowlist on each request", async () => {
		const port = await upstream();
		let fleet: readonly string[] = ["fleet.test"];
		const factory = createEgressProxyFactoryWith({
			fleetAllow: () => fleet,
			log,
			deps: deps({ "fleet.test": ["93.184.216.34"] }, port, []),
		});
		const proxy = await factory.open([]);
		try {
			expect(await connectThrough(proxy.url, "fleet.test:443")).toMatch(
				/^HTTP\/1\.1 200/u,
			);
			fleet = [];
			expect(await connectThrough(proxy.url, "fleet.test:443")).toMatch(
				/^HTTP\/1\.1 403/u,
			);
		} finally {
			await proxy.close();
		}
	});

	it("opens one proxy per call, each with its own allowlist, and close stops it", async () => {
		const port = await upstream();
		const factory = createEgressProxyFactoryWith({
			fleetAllow: () => [],
			log,
			deps: deps(
				{ "a.test": ["93.184.216.34"], "b.test": ["93.184.216.35"] },
				port,
				[],
			),
		});
		const first = await factory.open(["a.test"]);
		const second = await factory.open(["b.test"]);
		try {
			expect(first.url).not.toBe(second.url);
			expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
			expect(await connectThrough(first.url, "b.test:443")).toMatch(
				/^HTTP\/1\.1 403/u,
			);
			expect(await connectThrough(second.url, "b.test:443")).toMatch(
				/^HTTP\/1\.1 200/u,
			);
		} finally {
			await first.close();
		}
		const url = new URL(first.url);
		const socket = tcpConnect(Number(url.port), url.hostname);
		const [error] = await once(socket, "error");
		expect(String(error)).toMatch(/ECONNREFUSED/u);
		await second.close();
		await second.close();
	});
});

describe("createEgressProxyFactory", () => {
	it("refuses the metadata address and an unlisted host with the real resolver", async () => {
		const proxy = await createEgressProxyFactory({
			fleetAllow: () => [],
			log,
		}).open(["169.254.169.254"]);
		try {
			expect(await connectThrough(proxy.url, "169.254.169.254:80")).toMatch(
				/^HTTP\/1\.1 403/u,
			);
			expect(await connectThrough(proxy.url, "example.invalid:443")).toMatch(
				/^HTTP\/1\.1 403/u,
			);
		} finally {
			await proxy.close();
		}
	});
});
