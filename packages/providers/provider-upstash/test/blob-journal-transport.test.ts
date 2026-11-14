import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	request as nodeHttpRequest,
	type ServerResponse,
} from "node:http";
import {
	createServer as createHttpsServer,
	Agent as HttpsAgent,
	request as nodeHttpsRequest,
} from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import type { JournalHttpRequest } from "../src/blob-journal-http.js";
import {
	assertUpstashBlobJournalTransport,
	createUnenrolledUpstashBlobJournalTransport,
	createUpstashBlobJournalTransport,
} from "../src/blob-journal-transport.js";

const scope = {
	r2AccountId: "0123456789abcdef0123456789abcdef",
	bucketId: "hobo-journal",
	namespace: "fleet/generation",
	maxObjectBytes: 4096,
};
const r2 = `https://${scope.r2AccountId}.r2.cloudflarestorage.com`;
const object: TransportRequest = {
	method: "GET",
	url: `${r2}/${scope.bucketId}/${scope.namespace}/assignments`,
	headers: { authorization: "test-signature" },
	timeoutMs: 5_000,
	maxResponseBytes: 1024,
};

/** The real Node HTTP client goes to a loopback server; only this unbranded
 * test transport redirects its socket there. The production brand requires the
 * separately imported Node HTTPS implementation. */
async function fixture(
	handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
	const paths: string[] = [];
	const sent: string[] = [];
	const server = createServer((request, response) => {
		paths.push(request.url ?? "");
		handle(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!(address instanceof Object)) throw new Error("no loopback port");
	const send: JournalHttpRequest = (url, options, onResponse) => {
		sent.push(url.toString());
		const loopback = new URL(url.pathname, `http://127.0.0.1:${address.port}`);
		return nodeHttpRequest(loopback, options, onResponse);
	};
	return {
		transport: createUnenrolledUpstashBlobJournalTransport(scope, send),
		paths,
		sent,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

describe("Upstash journal transport", () => {
	it("requires the native HTTPS brand and pins the immutable bucket scope", async () => {
		const f = await fixture((_request, response) => response.end("ok"));
		try {
			const input = { ...scope };
			const native = createUpstashBlobJournalTransport(input);
			Object.assign(input, {
				bucketId: "foreign-bucket",
				maxObjectBytes: 8_000_000,
			});
			assertUpstashBlobJournalTransport(native, scope);
			expect(() =>
				assertUpstashBlobJournalTransport(native, {
					...scope,
					bucketId: "foreign-bucket",
				}),
			).toThrow(/not enrolled/u);
			expect(() =>
				assertUpstashBlobJournalTransport(f.transport, scope),
			).toThrow(/not enrolled/u);
			await expect(
				f.transport({
					...object,
					url: `${r2}/foreign/fleet/generation/assignments`,
				}),
			).rejects.toThrow(/scope/u);
			await expect(
				f.transport({
					...object,
					url: "https://blob.upstash.io/v1/credentials?redirect=elsewhere",
					method: "POST",
				}),
			).rejects.toThrow(/scope/u);
			expect(f.sent).toHaveLength(0);
		} finally {
			await f.close();
		}
	});

	it("refuses a native HTTP redirect without sending to the destination", async () => {
		const f = await fixture((_request, response) => {
			response.writeHead(302, { location: "/stolen" });
			response.end();
		});
		try {
			await expect(f.transport(object)).rejects.toThrow(/redirect/u);
			expect(f.sent).toEqual([object.url]);
			expect(f.paths).toEqual([
				`/${scope.bucketId}/${scope.namespace}/assignments`,
			]);
		} finally {
			await f.close();
		}
	});

	it("verifies TLS on the real Node HTTPS client", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-upstash-tls-"));
		try {
			const keyPath = join(directory, "server.key"),
				certificatePath = join(directory, "server.crt");
			execFileSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-keyout",
					keyPath,
					"-out",
					certificatePath,
					"-days",
					"1",
					"-subj",
					"/CN=localhost",
					"-addext",
					"subjectAltName=IP:127.0.0.1",
				],
				{ stdio: "ignore" },
			);
			const certificate = readFileSync(certificatePath);
			const server = createHttpsServer(
				{ key: readFileSync(keyPath), cert: certificate },
				(_request, response) => response.end("verified"),
			);
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (!(address instanceof Object)) throw new Error("no loopback port");
			const trusted = new HttpsAgent({
				ca: certificate,
				rejectUnauthorized: true,
			});
			const untrusted = new HttpsAgent({ rejectUnauthorized: true });
			const sender =
				(agent: HttpsAgent): JournalHttpRequest =>
				(url, options, onResponse) =>
					nodeHttpsRequest(
						new URL(url.pathname, `https://127.0.0.1:${address.port}`),
						{ ...options, agent },
						onResponse,
					);
			const tlsRequest = { ...object, timeoutMs: 5_000 };
			try {
				expect(
					(
						await createUnenrolledUpstashBlobJournalTransport(
							scope,
							sender(trusted),
						)(tlsRequest)
					).body,
				).toBe("verified");
				await expect(
					createUnenrolledUpstashBlobJournalTransport(
						scope,
						sender(untrusted),
					)(tlsRequest),
				).rejects.toThrow(/request failed/u);
			} finally {
				trusted.destroy();
				untrusted.destroy();
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 15_000);

	it("aborts oversized streaming responses and rejects compressed responses", async () => {
		let signalClosed = () => {};
		const closed = new Promise<void>((resolve) => {
			signalClosed = resolve;
		});
		const oversized = await fixture((_request, response) => {
			response.once("close", signalClosed);
			response.write(Buffer.alloc(600));
			response.write(Buffer.alloc(600));
		});
		try {
			await expect(oversized.transport(object)).rejects.toThrow(/byte cap/u);
			await closed;
		} finally {
			await oversized.close();
		}
		const compressed = await fixture((_request, response) => {
			response.writeHead(200, { "content-encoding": "gzip" });
			response.end("payload");
		});
		try {
			await expect(compressed.transport(object)).rejects.toThrow(/encoding/u);
		} finally {
			await compressed.close();
		}
	});

	it("allows only the pinned credential exchange and bounded object requests", async () => {
		const f = await fixture((_request, response) => response.end("ok"));
		try {
			const mint: TransportRequest = {
				method: "POST",
				url: "https://blob.upstash.io/v1/credentials",
				headers: { authorization: "Bearer test-token" },
				timeoutMs: 5_000,
				maxResponseBytes: 16_384,
			};
			expect((await f.transport(mint)).body).toBe("ok");
			await expect(f.transport({ ...mint, method: "GET" })).rejects.toThrow(
				/scope/u,
			);
			await expect(
				f.transport({ ...object, headers: { host: "foreign.example" } }),
			).rejects.toThrow(/scope/u);
			await expect(
				f.transport({ ...object, method: "PUT", body: "x".repeat(4097) }),
			).rejects.toThrow(/scope/u);
			await expect(
				f.transport({ ...object, maxResponseBytes: 4097 }),
			).rejects.toThrow(/scope/u);
			await expect(
				f.transport({
					...object,
					headers: { authorization: "x".repeat(16_384) },
				}),
			).rejects.toThrow(/headers exceed/u);
			expect(f.sent).toEqual([mint.url]);
		} finally {
			await f.close();
		}
	});

	it("preserves a UTF-8 byte order mark in stored content", async () => {
		const body = "\uFEFFstored";
		const f = await fixture((_request, response) => response.end(body));
		try {
			expect((await f.transport(object)).body).toBe(body);
		} finally {
			await f.close();
		}
	});

	it("refuses invalid UTF-8 instead of changing journal bytes", async () => {
		const f = await fixture((_request, response) =>
			response.end(Buffer.from([0xc3, 0x28])),
		);
		try {
			await expect(f.transport(object)).rejects.toThrow(/response is invalid/u);
		} finally {
			await f.close();
		}
	});

	it("aborts a stalled native request at the deadline without a retry", async () => {
		const f = await fixture(() => {});
		try {
			await expect(f.transport({ ...object, timeoutMs: 25 })).rejects.toThrow(
				/timed out/u,
			);
			expect(f.sent).toEqual([object.url]);
		} finally {
			await f.close();
		}
	});
});
