import { execFileSync } from "node:child_process";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createTcpServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampManagement, type FeedRequest, type FeedResponse } from "@hobo/cd";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type CdListenerAccess,
	sendCdResponse,
	startCdListener,
} from "../src/cd-listener.js";
import { CD_SVID_SIGNING_KEY } from "../src/cd-svid-issuer.js";
import { campIdOf, staticTopologyReader } from "../src/cd-topology.js";
import { isJsonString } from "../src/json.js";

const origin = "https://cd.example.test";
type TestTls = Readonly<{ cert: string; key: string }>;
let directory: string;
let tls: TestTls;
let issuerKey: string;

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "hobo-cd-listener-"));
	const key = join(directory, "key.pem");
	const cert = join(directory, "cert.pem");
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
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
			"-keyout",
			key,
			"-out",
			cert,
		],
		{ stdio: "ignore" },
	);
	tls = { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
	issuerKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ format: "pem", type: "pkcs8" })
		.toString();
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function fixture() {
	let ready = true;
	const service = {
		start: vi.fn(async () => {}),
		drain: vi.fn(async () => {}),
		ready: () => ready,
		health: () => ({
			ok: ready,
			checks: [{ name: "journal", ok: ready, detail: "internal-detail" }],
		}),
	};
	const api = {
		pathPrefix: "/v1/cd/" as const,
		handle: vi.fn(
			async (
				request: FeedRequest,
				_signal: AbortSignal,
			): Promise<FeedResponse> => ({
				status: request.path.startsWith("/v1/cd/feed") ? 401 : 200,
				headers: { "content-type": "text/plain" },
				body: new TextEncoder().encode(request.path),
			}),
		),
	};
	return {
		service,
		api,
		setReady: (value: boolean) => {
			ready = value;
		},
	};
}

function access(): CdListenerAccess {
	return {
		kind: "authenticated",
		publicOrigin: origin,
		tls,
		async authorizeOperator(request) {
			if (request.headers["x-test-principal"] === "broken")
				throw new Error("internal-detail");
			return request.headers["x-test-principal"] === "allowed";
		},
	};
}

async function call(
	port: number,
	path: string,
	headers: Record<string, string> = {},
	method = "GET",
) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = httpsRequest(
			{ host: "127.0.0.1", port, path, method, ca: tls.cert, headers },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("error", reject);
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString(),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

async function unusedPort(): Promise<number> {
	const server = createTcpServer();
	await new Promise<void>((resolve, reject) =>
		server.once("error", reject).listen(0, "127.0.0.1", resolve),
	);
	const address = server.address();
	if (!address || isJsonString(address)) throw new Error("no test port");
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

describe("CD listener", () => {
	it("requires authenticated TLS and an origin bound to the runtime for public access", async () => {
		const { service, api } = fixture();
		await expect(
			startCdListener({
				host: "0.0.0.0",
				port: 0,
				access: { kind: "loopback" },
				service,
				api,
				simulated: false,
				refusals: [],
			}),
		).rejects.toThrow(/loopback/);
		await expect(
			startCdListener({
				host: "127.0.0.1",
				port: 0,
				access: access(),
				runtimeOrigin: "https://other.example.test",
				service,
				api,
				simulated: false,
				refusals: [],
			}),
		).rejects.toThrow(/origin/);
		expect(service.start).not.toHaveBeenCalled();
	});

	it("requires a separate owner-backed agent signing key", async () => {
		const { service, api } = fixture();
		const input = {
			host: "127.0.0.1",
			port: 0,
			access: access(),
			runtimeOrigin: origin,
			service,
			api,
			simulated: false,
			refusals: [],
		};
		await expect(startCdListener(input)).rejects.toThrow(/owner-backed/);
		const tlsKey = createPublicKey(createPrivateKey(tls.key));
		const issuerKeyId = createHash("sha256")
			.update(tlsKey.export({ format: "der", type: "spki" }))
			.digest("hex");
		await expect(startCdListener({ ...input, issuerKeyId })).rejects.toThrow(
			/distinct/,
		);
		expect(service.start).not.toHaveBeenCalled();
	});

	it("protects operator routes while leaving the authenticated feed to its own verifier", async () => {
		const f = fixture();
		const server = await startCdListener({
			host: "127.0.0.1",
			port: 0,
			access: access(),
			runtimeOrigin: origin,
			issuerKeyId: "a".repeat(64),
			service: f.service,
			api: f.api,
			simulated: false,
			refusals: [],
		});
		try {
			for (const path of [
				"/v1/cd/camps",
				"/v1/cd/stream",
				"/v1/cd/feed/../camps",
				"/v1/cd/%65nrollments",
				"/v1/cd/blobs/sha256%252f../camps",
			])
				expect((await call(server.port, path)).status, path).toBe(401);
			expect(f.api.handle).not.toHaveBeenCalled();
			expect(
				(
					await call(server.port, "/v1/cd/camps", {
						"x-test-principal": "broken",
					})
				).status,
			).toBe(401);
			expect(
				(
					await call(server.port, "/v1/cd/camps", {
						"x-test-principal": "allowed",
					})
				).status,
			).toBe(200);
			expect((await call(server.port, "/v1/cd/feed")).status).toBe(401);
			expect(f.api.handle).toHaveBeenCalledTimes(2);
			f.setReady(false);
			expect((await call(server.port, "/v1/cd/feed")).status).toBe(503);
			expect(
				(
					await call(server.port, "/v1/cd/camps", {
						"x-test-principal": "allowed",
					})
				).status,
			).toBe(200);
		} finally {
			await server.close();
		}
	});

	it("keeps a simulated public listener unready and prevents agent-feed dispatch", async () => {
		const f = fixture();
		const server = await startCdListener({
			host: "127.0.0.1",
			port: 0,
			access: access(),
			runtimeOrigin: origin,
			issuerKeyId: "a".repeat(64),
			service: f.service,
			api: f.api,
			simulated: true,
			refusals: [],
		});
		try {
			expect(await call(server.port, "/healthz")).toEqual({
				status: 200,
				body: '{"ok":true}',
			});
			expect(await call(server.port, "/readyz")).toEqual({
				status: 503,
				body: '{"ok":false}',
			});
			expect(await call(server.port, "/v1/cd/feed")).toEqual({
				status: 503,
				body: '{"ok":false,"code":"feed-unavailable"}',
			});
			for (const [path, method] of [
				["/v1/cd/enrollments", "POST"],
				["/v1/cd/svid/refresh", "POST"],
				["/v1/cd/feed/../feed", "GET"],
			] as const)
				expect(
					(
						await call(
							server.port,
							path,
							{ "x-test-principal": "allowed" },
							method,
						)
					).status,
				).toBe(503);
			expect(f.api.handle).not.toHaveBeenCalled();
			for (const path of ["/v1/cd/ready", "/v1/cd/feed/../ready"]) {
				expect((await call(server.port, path)).status).toBe(401);
				const readiness = await call(server.port, path, {
					"x-test-principal": "allowed",
				});
				expect(readiness.status).toBe(503);
				expect(readiness.body).toContain("simulated");
			}
			expect(f.api.handle).not.toHaveBeenCalled();
			expect(
				(
					await call(server.port, "/v1/cd/camps", {
						"x-test-principal": "allowed",
					})
				).status,
			).toBe(200);
		} finally {
			await server.close();
		}
	});

	it("keeps local simulated readiness labeled and available", async () => {
		const f = fixture();
		const server = await startCdListener({
			host: "127.0.0.1",
			port: 0,
			access: { kind: "loopback" },
			service: f.service,
			api: f.api,
			simulated: true,
			refusals: [],
		});
		try {
			const response = await fetch(`${server.url}/readyz`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				simulated: true,
			});
			const feed = await fetch(`${server.url}/v1/cd/feed`);
			expect(feed.status).toBe(401);
			expect(f.api.handle).toHaveBeenCalledOnce();
		} finally {
			await server.close();
		}
	});

	it("returns only aggregate readiness publicly and fails readiness for conductor refusals", async () => {
		const f = fixture();
		const server = await startCdListener({
			host: "127.0.0.1",
			port: 0,
			access: access(),
			runtimeOrigin: origin,
			issuerKeyId: "a".repeat(64),
			service: f.service,
			api: f.api,
			simulated: false,
			refusals: ["internal-detail"],
		});
		try {
			expect(await call(server.port, "/healthz")).toEqual({
				status: 200,
				body: '{"ok":true}',
			});
			expect(await call(server.port, "/readyz")).toEqual({
				status: 503,
				body: '{"ok":false}',
			});
		} finally {
			await server.close();
		}
	});

	it("sanitizes local readiness check names and failure details", async () => {
		const f = fixture();
		f.setReady(false);
		f.service.health = () => ({
			ok: false,
			checks: [
				{
					name: "reconciler:synthetic-private-id",
					ok: false,
					detail: "synthetic private-fixture.invalid",
				},
			],
		});
		const server = await startCdListener({
			host: "127.0.0.1",
			port: 0,
			access: { kind: "loopback" },
			service: f.service,
			api: f.api,
			simulated: false,
			refusals: ["synthetic private-fixture.invalid"],
		});
		try {
			const response = await fetch(`${server.url}/readyz`);
			const body = await response.text();
			expect(response.status).toBe(503);
			expect(body).not.toContain("synthetic-private-id");
			expect(body).not.toContain("private-fixture.invalid");
			expect(body).toContain("reconcilers");
		} finally {
			await server.close();
		}
	});

	it("stops pulling a stream while the response is backpressured and closes on disconnect", async () => {
		const response = new ServerResponse(new IncomingMessage(new Socket()));
		vi.spyOn(response, "writeHead").mockReturnThis();
		let notifyFirst: () => void = () => {};
		const firstWrite = new Promise<void>((resolve) => {
			notifyFirst = resolve;
		});
		vi.spyOn(response, "write").mockImplementation(() => {
			notifyFirst();
			return false;
		});
		let produced = 0;
		let released = false;
		const writing = sendCdResponse(
			response,
			{
				status: 200,
				headers: {},
				body: (async function* () {
					try {
						for (let index = 0; index < 100; index += 1) {
							produced += 1;
							yield new Uint8Array([index]);
						}
					} finally {
						released = true;
					}
				})(),
			},
			1000,
		);
		await firstWrite;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(produced).toBe(1);
		response.emit("close");
		await writing;
		expect(released).toBe(true);
		expect(produced).toBe(1);
	});

	it("destroys a response when a backpressured client never drains", async () => {
		const response = new ServerResponse(new IncomingMessage(new Socket()));
		vi.spyOn(response, "writeHead").mockReturnThis();
		vi.spyOn(response, "write").mockReturnValue(false);
		const destroy = vi.spyOn(response, "destroy").mockReturnThis();
		let released = false;
		await sendCdResponse(
			response,
			{
				status: 200,
				headers: {},
				body: (async function* () {
					try {
						yield new Uint8Array([1]);
					} finally {
						released = true;
					}
				})(),
			},
			10,
		);
		expect(destroy).toHaveBeenCalledOnce();
		expect(released).toBe(true);
	});

	it("resumes pulling after a backpressured response drains", async () => {
		const response = new ServerResponse(new IncomingMessage(new Socket()));
		vi.spyOn(response, "writeHead").mockReturnThis();
		let notifyFirst: () => void = () => {};
		const firstWrite = new Promise<void>((resolve) => {
			notifyFirst = resolve;
		});
		vi.spyOn(response, "write")
			.mockImplementationOnce(() => {
				notifyFirst();
				return false;
			})
			.mockReturnValue(true);
		const end = vi.spyOn(response, "end").mockReturnThis();
		let produced = 0;
		const writing = sendCdResponse(
			response,
			{
				status: 200,
				headers: {},
				body: (async function* () {
					produced += 1;
					yield new Uint8Array([1]);
					produced += 1;
					yield new Uint8Array([2]);
				})(),
			},
			1000,
		);
		await firstWrite;
		expect(produced).toBe(1);
		response.emit("drain");
		await writing;
		expect(produced).toBe(2);
		expect(end).toHaveBeenCalledOnce();
	});

	it("cleans up a listener after service startup fails", async () => {
		const f = fixture();
		f.service.start.mockRejectedValueOnce(
			new Error("synthetic startup failure"),
		);
		const port = await unusedPort();
		await expect(
			startCdListener({
				host: "127.0.0.1",
				port,
				access: { kind: "loopback" },
				service: f.service,
				api: f.api,
				simulated: false,
				refusals: [],
			}),
		).rejects.toThrow("synthetic startup failure");
		expect(f.service.drain).toHaveBeenCalledOnce();
		const replacement = createTcpServer();
		await new Promise<void>((resolve, reject) =>
			replacement.once("error", reject).listen(port, "127.0.0.1", resolve),
		);
		await new Promise<void>((resolve) => replacement.close(() => resolve()));
	});

	it("drains once and aborts a live response during shutdown", async () => {
		const f = fixture();
		let aborted = false;
		f.api.handle.mockImplementation(
			async (_request, signal): Promise<FeedResponse> => ({
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: (async function* () {
					yield new TextEncoder().encode("event: ready\n\n");
					await new Promise<void>((resolve) => {
						if (signal.aborted) resolve();
						else
							signal.addEventListener("abort", () => resolve(), { once: true });
					});
					aborted = signal.aborted;
				})(),
			}),
		);
		const server = await startCdListener({
			host: "127.0.0.1",
			port: 0,
			access: access(),
			runtimeOrigin: origin,
			issuerKeyId: "a".repeat(64),
			service: f.service,
			api: f.api,
			simulated: false,
			refusals: [],
		});
		const response = new Promise<void>((resolve, reject) => {
			const req = httpsRequest(
				{
					host: "127.0.0.1",
					port: server.port,
					path: "/v1/cd/stream",
					ca: tls.cert,
					headers: { "x-test-principal": "allowed" },
				},
				(res) => {
					res.once("data", () => resolve());
					res.on("error", () => {});
				},
			);
			req.on("error", reject);
			req.end();
		});
		await response;
		await Promise.all([server.close(), server.close()]);
		expect(f.service.drain).toHaveBeenCalledOnce();
		expect(aborted).toBe(true);
	});
});

describe("composed CD server", () => {
	it("starts the non-simulated runtime with authenticated reads and closes its journal", async () => {
		const { openCdRuntime } = await import("../src/cd-runtime.js");
		const { startCdServer } = await import("../src/cd-serve.js");
		const home = mkdtempSync(join(tmpdir(), "hobo-cd-runtime-real-"));
		const opened = await openCdRuntime({
			env: {},
			home,
			cwd: home,
			simulate: false,
			publicOrigin: origin,
			readSecret: async (name) =>
				name === CD_SVID_SIGNING_KEY ? issuerKey : undefined,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const close = vi.fn(() => opened.value.close());
		const server = await startCdServer({
			runtime: { ...opened.value, close },
			host: "127.0.0.1",
			port: 0,
			log: () => {},
			access: access(),
		});
		try {
			expect((await call(server.port, "/v1/cd/camps")).status).toBe(401);
			expect(
				(
					await call(server.port, "/v1/cd/camps", {
						"x-test-principal": "allowed",
					})
				).status,
			).toBe(200);
			expect((await call(server.port, "/v1/cd/feed")).status).toBe(401);
			expect((await call(server.port, "/readyz")).status).toBe(200);
		} finally {
			await Promise.all([server.close(), server.close()]);
			rmSync(home, { recursive: true, force: true });
		}
		expect(close).toHaveBeenCalledOnce();
	});

	it("serves a simulated runtime over authenticated TLS without advertising readiness", async () => {
		const { openCdRuntime } = await import("../src/cd-runtime.js");
		const { startCdServer } = await import("../src/cd-serve.js");
		const home = mkdtempSync(join(tmpdir(), "hobo-cd-runtime-"));
		const opened = await openCdRuntime({
			env: {},
			home,
			cwd: home,
			simulate: true,
			publicOrigin: origin,
			readSecret: async (name) =>
				name === CD_SVID_SIGNING_KEY ? issuerKey : undefined,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const close = vi.fn(() => opened.value.close());
		const runtime = { ...opened.value, close };
		const server = await startCdServer({
			runtime,
			host: "127.0.0.1",
			port: 0,
			log: () => {},
			access: access(),
		});
		try {
			expect((await call(server.port, "/v1/cd/camps")).status).toBe(401);
			expect(
				(
					await call(server.port, "/v1/cd/camps", {
						"x-test-principal": "allowed",
					})
				).status,
			).toBe(200);
			expect((await call(server.port, "/v1/cd/feed")).status).toBe(503);
			expect((await call(server.port, "/readyz")).status).toBe(503);
			const controlReadiness = await call(server.port, "/v1/cd/ready", {
				"x-test-principal": "allowed",
			});
			expect(controlReadiness.status).toBe(503);
			expect(controlReadiness.body).toContain("simulated");
		} finally {
			await Promise.all([server.close(), server.close()]);
			rmSync(home, { recursive: true, force: true });
		}
		expect(close).toHaveBeenCalledOnce();
	});

	it("closes the real runtime when listener startup is refused", async () => {
		const { openCdRuntime } = await import("../src/cd-runtime.js");
		const { startCdServer } = await import("../src/cd-serve.js");
		const home = mkdtempSync(join(tmpdir(), "hobo-cd-refused-"));
		const opened = await openCdRuntime({
			env: {},
			home,
			cwd: home,
			simulate: true,
			publicOrigin: origin,
			readSecret: async (name) =>
				name === CD_SVID_SIGNING_KEY ? issuerKey : undefined,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const close = vi.fn(() => opened.value.close());
		await expect(
			startCdServer({
				runtime: { ...opened.value, close },
				host: "0.0.0.0",
				port: 0,
				log: () => {},
			}),
		).rejects.toThrow(/loopback/);
		expect(close).toHaveBeenCalledOnce();
		rmSync(home, { recursive: true, force: true });
	});

	it("reports a refused conductor as unready on both readiness surfaces", async () => {
		const { openCdRuntime } = await import("../src/cd-runtime.js");
		const { startCdServer } = await import("../src/cd-serve.js");
		const home = mkdtempSync(join(tmpdir(), "hobo-cd-conductor-"));
		const opened = await openCdRuntime({
			env: {},
			home,
			cwd: home,
			simulate: true,
			publicOrigin: origin,
			readSecret: async (name) =>
				name === CD_SVID_SIGNING_KEY ? issuerKey : undefined,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const topology = staticTopologyReader([
			{
				campId: campIdOf("fixture", "prod"),
				yardId: "fixture",
				stationId: "fixture",
				provider: "fixture",
				regions: [],
				envType: "production",
				labels: {},
				management: CampManagement.MANAGED,
			},
		]);
		const runtime = {
			...opened.value,
			cd: { ...opened.value.cd, topology },
			conductor() {
				throw new Error("synthetic conductor refusal");
			},
		};
		const server = await startCdServer({
			runtime,
			host: "127.0.0.1",
			port: 0,
			log: () => {},
			access: access(),
		});
		try {
			expect((await call(server.port, "/readyz")).status).toBe(503);
			expect(
				(
					await call(server.port, "/v1/cd/ready", {
						"x-test-principal": "allowed",
					})
				).status,
			).toBe(503);
			expect((await call(server.port, "/v1/cd/feed")).status).toBe(503);
		} finally {
			await server.close();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("keeps conductor failure details out of local readiness and server results", async () => {
		const { openCdRuntime } = await import("../src/cd-runtime.js");
		const { startCdServer } = await import("../src/cd-serve.js");
		const home = mkdtempSync(join(tmpdir(), "hobo-cd-private-refusal-"));
		const opened = await openCdRuntime({
			env: {
				HOBO_TENANT: "synthetic-private-tenant",
				HOBO_STATION: "synthetic-private-station",
			},
			home,
			cwd: home,
			simulate: true,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const topology = staticTopologyReader([
			{
				campId: campIdOf("fixture", "prod"),
				yardId: "fixture",
				stationId: "fixture",
				provider: "fixture",
				regions: [],
				envType: "production",
				labels: {},
				management: CampManagement.MANAGED,
			},
		]);
		const runtime = {
			...opened.value,
			cd: {
				...opened.value.cd,
				topology,
				sources: {
					...opened.value.cd.sources,
					async tick() {
						throw new Error("synthetic private-fixture.invalid source failure");
					},
				},
			},
			conductor() {
				throw new Error("synthetic private-fixture.invalid provider failure");
			},
		};
		const logs: string[] = [];
		const server = await startCdServer({
			runtime,
			host: "127.0.0.1",
			port: 0,
			log: (line) => logs.push(line),
		});
		try {
			const response = await fetch(`${server.url}/readyz`);
			const body = await response.text();
			const control = await fetch(`${server.url}/v1/cd/ready`);
			const controlBody = await control.text();
			expect(response.status).toBe(503);
			expect(control.status).toBe(503);
			expect(body).not.toContain("private-fixture.invalid");
			expect(controlBody).not.toContain("private-fixture.invalid");
			expect(JSON.stringify(server.refusals)).not.toContain(
				"private-fixture.invalid",
			);
			expect(logs.join("\n")).not.toContain("private-fixture.invalid");
			expect(logs.join("\n")).not.toContain("synthetic-private-tenant");
			expect(logs.join("\n")).not.toContain("synthetic-private-station");
			expect(logs.join("\n")).not.toContain(server.url);
			expect(server.refusals).toEqual(["conductor-unavailable"]);
		} finally {
			await server.close();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("rejects public origins that are not bare HTTPS origins", async () => {
		const { openCdRuntime } = await import("../src/cd-runtime.js");
		for (const publicOrigin of [
			"http://cd.example.test",
			"https://cd.example.test/path",
			"https://cd.example.test?x=1",
			"https://user:pass@cd.example.test",
		]) {
			const opened = await openCdRuntime({
				env: {},
				home: "/unused",
				cwd: "/unused",
				simulate: true,
				publicOrigin,
			});
			expect(opened.ok, publicOrigin).toBe(false);
		}
	});
});
