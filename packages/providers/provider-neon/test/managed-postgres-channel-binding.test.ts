import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Authentication = "plain-scram" | "md5" | "plus" | "trust";

function int32(value: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeInt32BE(value);
	return buffer;
}

function message(type: string, body: Buffer): Buffer {
	return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
}

describe("managed Neon channel binding", () => {
	let directory: string;
	let certificate: string;
	let key: string;

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "hobo-neon-tls-test-"));
		certificate = join(directory, "test-cert.pem");
		key = join(directory, "test-key.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				key,
				"-out",
				certificate,
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=DNS:localhost,IP:127.0.0.1",
			],
			{ stdio: "ignore" },
		);
	}, 30_000);

	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	async function runServer(authentication: Authentication): Promise<Buffer> {
		const context = createSecureContext({
			cert: readFileSync(certificate),
			key: readFileSync(key),
		});
		const sockets = new Set<Socket>();
		let received = Buffer.alloc(0);
		let authSent = false;
		let sawRequest = false;
		let tlsReady = false;
		let tlsError = "";
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.once("data", () => {
				sawRequest = true;
				socket.write("S");
				const secure = new TLSSocket(socket, {
					isServer: true,
					secureContext: context,
				});
				secure.on("secure", () => {
					tlsReady = true;
				});
				secure.on("error", (error) => {
					tlsError = error.message;
				});
				let startup = Buffer.alloc(0);
				let sent = false;
				secure.on("data", (data: Buffer) => {
					if (sent) {
						received = Buffer.concat([received, data]);
						if (authentication === "plus") secure.destroy();
						return;
					}
					startup = Buffer.concat([startup, data]);
					if (startup.length < 4 || startup.length < startup.readInt32BE())
						return;
					sent = true;
					authSent = true;
					if (authentication === "trust") {
						secure.write(
							Buffer.concat([
								message("R", int32(0)),
								message("Z", Buffer.from("I")),
							]),
						);
					} else if (authentication === "md5") {
						secure.write(
							message("R", Buffer.concat([int32(5), Buffer.alloc(4)])),
						);
					} else {
						const mechanisms =
							authentication === "plus"
								? "SCRAM-SHA-256\0SCRAM-SHA-256-PLUS\0\0"
								: "SCRAM-SHA-256\0\0";
						secure.write(
							message("R", Buffer.concat([int32(10), Buffer.from(mechanisms)])),
						);
					}
				});
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		// SAFETY: listen succeeded on a TCP host and the server is still open.
		const address = server.address() as AddressInfo;
		const source = pathToFileURL(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../src/managed-postgres.ts",
			),
		).href;
		const script = `import {probeNeonManagedSession} from ${JSON.stringify(source)};
try { await probeNeonManagedSession({host:"127.0.0.1",port:${address.port},database:"postgres",username:"test",password:"test-only"}); process.exitCode=1; }
catch { process.exitCode=0; }`;
		try {
			const child = spawn(
				process.execPath,
				["--import", "tsx", "--input-type=module", "--eval", script],
				{
					env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
					stdio: "ignore",
					timeout: 20_000,
				},
			);
			const status = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", resolve);
			});
			expect(status).toBe(0);
			expect({ sawRequest, tlsReady, tlsError, authSent }).toEqual({
				sawRequest: true,
				tlsReady: true,
				tlsError: "",
				authSent: true,
			});
			return received;
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	it.each([
		"plain-scram",
		"md5",
		"trust",
	] as const)("refuses %s without sending a password or a query", async (authentication) => {
		const sent = await runServer(authentication);
		// A clean close after a trust response sends only PostgreSQL Terminate.
		expect(
			sent.length === 0 || sent.equals(Buffer.from([88, 0, 0, 0, 4])),
		).toBe(true);
	}, 30_000);

	it("selects SCRAM-PLUS even when ordinary SCRAM is offered first", async () => {
		const sent = await runServer("plus");
		expect(sent[0]).toBe("p".charCodeAt(0));
		expect(sent.subarray(5).toString("utf8")).toMatch(/^SCRAM-SHA-256-PLUS\0/u);
	}, 30_000);
});
