import { randomBytes } from "node:crypto";
import type { ProxyHandler } from "@vercel/sandbox/proxy";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createProxyQuotaLedger,
	createSandboxProxyVmHandler,
	launchSandboxProxyVm,
	parseProxyVmConfig,
	type SandboxProxyBootstrapPort,
} from "../src/sandbox-proxy-vm.js";

const config = parseProxyVmConfig({
	proxyOrigin: "https://proxy.example.test",
	relayOrigin: "https://relay.example.test",
	expectedIssuer: "https://oidc.vercel.com/team-example",
	leaseId: "00000000-0000-4000-8000-000000000001",
	proxySessionId: "sbx_proxy",
	quotaToken: Buffer.alloc(32, 7).toString("base64url"),
	teamId: "team_example",
	projectId: "prj_example",
	hosts: ["github.com"],
	maxEgressBytes: 1024 * 1024,
	maxControlCalls: 16,
	port: 8787,
	maxRequestBytes: 64 * 1024 * 1024,
	maxResponseBytes: 256 * 1024 * 1024,
});

describe("proxy VM bootstrap", () => {
	it("restricts configured issuers to the global endpoint or one team path", () => {
		expect(() =>
			parseProxyVmConfig({
				...config,
				expectedIssuer: "https://oidc.vercel.com/team-example/attacker",
			}),
		).toThrow("invalid sandbox issuer");
		expect(() =>
			parseProxyVmConfig({
				...config,
				expectedIssuer: "https://oidc.vercel.com.evil.example/team-example",
			}),
		).toThrow("invalid sandbox issuer");
		for (const teamId of ["team_example/other", "../other", "team?x=y"]) {
			expect(() => parseProxyVmConfig({ ...config, teamId })).toThrow();
		}
	});
	it("creates the fresh VM workdir before uploading credentials or launching", async () => {
		const operations: string[] = [];
		type CommandOptions = { cmd: string; args: string[]; cwd: string };
		function runCommand(
			command: CommandOptions & { detached: true },
		): Promise<{ cmdId: string }>;
		function runCommand(
			command: CommandOptions & { detached: false },
		): Promise<{ exitCode: number }>;
		async function runCommand(command: CommandOptions & { detached: boolean }) {
			operations.push(`${command.cmd}:${command.cwd}`);
			return command.detached ? { cmdId: "proxy-command" } : { exitCode: 0 };
		}
		const session: SandboxProxyBootstrapPort = {
			sessionId: config.proxySessionId,
			status: "running",
			runCommand,
			async writeFiles() {
				operations.push("upload");
			},
		};
		expect(
			await launchSandboxProxyVm(session, Buffer.from("bundle"), config),
		).toMatchObject({
			commandId: "proxy-command",
			readinessNonce: expect.stringMatching(/^[a-f0-9]{32}$/),
		});
		expect(operations).toEqual(["mkdir:/", "upload", "node:/vercel/sandbox"]);
	});
	it("does not upload proxy credentials if the workdir cannot be created", async () => {
		const writeFiles = vi.fn();
		type CommandOptions = { cmd: string; args: string[]; cwd: string };
		function runCommand(
			command: CommandOptions & { detached: true },
		): Promise<{ cmdId: string }>;
		function runCommand(
			command: CommandOptions & { detached: false },
		): Promise<{ exitCode: number }>;
		async function runCommand(command: CommandOptions & { detached: boolean }) {
			return command.detached ? { cmdId: "unused" } : { exitCode: 1 };
		}
		const session: SandboxProxyBootstrapPort = {
			sessionId: config.proxySessionId,
			status: "running",
			runCommand,
			writeFiles,
		};
		await expect(
			launchSandboxProxyVm(session, Buffer.from("bundle"), config),
		).rejects.toThrow("sandbox workdir creation failed");
		expect(writeFiles).not.toHaveBeenCalled();
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function unsignedToken(sandboxId = "sbx_good", issuer = config.expectedIssuer) {
	const payload = Buffer.from(
		JSON.stringify({
			iss: issuer,
			aud: `${config.proxyOrigin}/sandbox/egress`,
			exp: Math.floor(Date.now() / 1000) + 300,
			team_id: config.teamId,
			project_id: config.projectId,
			sandbox_id: sandboxId,
		}),
	).toString("base64url");
	return `e30.${payload}.c2ln`;
}
function request(sandboxId = "sbx_good") {
	return new Request(`${config.proxyOrigin}/sandbox/egress/path`, {
		headers: { "vercel-sandbox-oidc-token": unsignedToken(sandboxId) },
	});
}
async function bind(
	handler: (request: Request) => Promise<Response>,
	sandboxId = "sbx_good",
) {
	return handler(
		new Request(`${config.proxyOrigin}/internal/bind`, {
			method: "POST",
			headers: { authorization: `Bearer ${config.quotaToken}` },
			body: JSON.stringify({ sandboxId }),
		}),
	);
}
describe("per-lease proxy quota", () => {
	it("purchases fixed blocks once and rejects a different same-project Sandbox before cached credit", async () => {
		const calls: { sandboxId: string; bytes: number; requestId: string }[] = [];
		const send: typeof fetch = async (_url, init) => {
			const parsed = JSON.parse(String(init?.body));
			calls.push(parsed);
			return new Response(null, {
				status: parsed.sandboxId === "sbx_good" ? 204 : 403,
			});
		};
		const ledger = createProxyQuotaLedger(config, send);
		const results = await Promise.all([
			ledger.reserveSandboxEgress("sbx_good", 1),
			ledger.reserveSandboxEgress("sbx_bad", 1),
			ledger.reserveSandboxEgress("sbx_good", 1),
		]);
		expect(results).toEqual([true, false, true]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.bytes).toBe(65536);
		expect(calls[0]?.requestId).toMatch(/^[a-f0-9-]{36}$/);
	});
	it("counts what it reserved and the quota calls it made, lost answers included, and reports them only to the lease's token", async () => {
		const send = vi.fn<typeof fetch>();
		send.mockResolvedValueOnce(new Response(null, { status: 204 }));
		send.mockRejectedValueOnce(new Error("answer lost"));
		const ledger = createProxyQuotaLedger(config, send);
		expect(ledger.meter()).toEqual({ bytes: 0, calls: 0 });
		expect(await ledger.reserveSandboxEgress("sbx_good", 100_000)).toBe(true);
		expect(await ledger.reserveSandboxEgress("sbx_good", 200_000)).toBe(false);
		// Two blocks reserved, the second's answer lost: both count.
		const meter = ledger.meter();
		expect(meter.calls).toBe(2);
		expect(meter.bytes).toBeGreaterThanOrEqual(200_000);
		const handler = createSandboxProxyVmHandler(config, {
			ledger,
			meter: ledger.meter,
		});
		const read = (authorization?: string) =>
			handler(
				new Request(`${config.proxyOrigin}/internal/meter`, {
					headers: authorization ? { authorization } : {},
				}),
			);
		expect((await read()).status).toBe(403);
		expect(
			(await read(`Bearer ${Buffer.alloc(32, 8).toString("base64url")}`))
				.status,
		).toBe(403);
		const answer = await read(`Bearer ${config.quotaToken}`);
		expect(answer.status).toBe(200);
		expect(await answer.json()).toEqual({
			leaseId: config.leaseId,
			proxySessionId: config.proxySessionId,
			...meter,
		});
	});
	it("expires local credit after five seconds without refunding the reserved block", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const send = vi.fn<typeof fetch>(
			async () => new Response(null, { status: 204 }),
		);
		const ledger = createProxyQuotaLedger(config, send);
		expect(await ledger.reserveSandboxEgress("sbx_good", 1)).toBe(true);
		vi.advanceTimersByTime(5001);
		expect(await ledger.reserveSandboxEgress("sbx_good", 1)).toBe(true);
		expect(send).toHaveBeenCalledTimes(2);
	});
	it("revalidates cached credit after revocation within five seconds", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const send = vi.fn<typeof fetch>(
			async () => new Response(null, { status: 204 }),
		);
		send.mockResolvedValueOnce(new Response(null, { status: 204 }));
		send.mockResolvedValueOnce(new Response(null, { status: 403 }));
		const ledger = createProxyQuotaLedger(config, send);
		expect(await ledger.reserveSandboxEgress("sbx_good", 1)).toBe(true);
		vi.advanceTimersByTime(5001);
		expect(await ledger.reserveSandboxEgress("sbx_good", 1)).toBe(false);
		expect(send).toHaveBeenCalledTimes(2);
	});
	it("does not retry or refund a reservation whose response is lost", async () => {
		const send = vi.fn<typeof fetch>(async () => {
			throw new Error("lost");
		});
		const ledger = createProxyQuotaLedger(
			{ ...config, maxControlCalls: 1 },
			send,
		);
		expect(await ledger.reserveSandboxEgress("sbx_good", 1)).toBe(false);
		expect(await ledger.reserveSandboxEgress("sbx_good", 1)).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("streams beyond the rolling control-call limit using bounded durable blocks", async () => {
		const reservations: number[] = [];
		const send: typeof fetch = async (_url, init) => {
			reservations.push(JSON.parse(String(init?.body)).bytes);
			return new Response(null, {
				status: reservations.length <= 600 ? 204 : 429,
			});
		};
		const limit = 256 * 1024 * 1024;
		const ledger = createProxyQuotaLedger(
			{ ...config, maxEgressBytes: limit, maxControlCalls: 4096 },
			send,
		);
		// At 64 KiB per control call this 50 MiB transfer would require 800
		// calls and the real 600/minute limit would truncate the response.
		for (let i = 0; i < 800; i++)
			expect(await ledger.reserveSandboxEgress("sbx_good", 64 * 1024)).toBe(
				true,
			);
		expect(reservations.length).toBeLessThan(70);
		expect(Math.max(...reservations)).toBe(4 * 1024 * 1024);
		expect(reservations.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(limit);
	});
	it("splits a large stream chunk into reservations within the endpoint limit", async () => {
		const reservations: number[] = [];
		const send: typeof fetch = async (_url, init) => {
			reservations.push(JSON.parse(String(init?.body)).bytes);
			return new Response(null, { status: 204 });
		};
		const ledger = createProxyQuotaLedger(
			{ ...config, maxEgressBytes: 256 * 1024 * 1024 },
			send,
		);
		expect(await ledger.reserveSandboxEgress("sbx_good", 9 * 1024 * 1024)).toBe(
			true,
		);
		expect(reservations).toHaveLength(3);
		expect(Math.max(...reservations)).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(reservations.reduce((a, b) => a + b, 0)).toBe(9 * 1024 * 1024);
	});
	it("uses only the remaining allowance for a small quota", async () => {
		const reservations: number[] = [];
		const send: typeof fetch = async (_url, init) => {
			reservations.push(JSON.parse(String(init?.body)).bytes);
			return new Response(null, { status: 204 });
		};
		const ledger = createProxyQuotaLedger(
			{ ...config, maxEgressBytes: 150_000 },
			send,
		);
		expect(await ledger.reserveSandboxEgress("sbx_good", 60_000)).toBe(true);
		expect(await ledger.reserveSandboxEgress("sbx_good", 60_000)).toBe(true);
		expect(await ledger.reserveSandboxEgress("sbx_good", 30_000)).toBe(true);
		expect(await ledger.reserveSandboxEgress("sbx_good", 1)).toBe(false);
		expect(reservations).toEqual([65536, 65536, 18928]);
	});
	it("does not forward a large chunk or refund an ambiguous partial reservation", async () => {
		const send = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockRejectedValueOnce(new Error("lost"));
		const ledger = createProxyQuotaLedger(
			{ ...config, maxEgressBytes: 8 * 1024 * 1024 },
			send,
		);
		expect(await ledger.reserveSandboxEgress("sbx_good", 8 * 1024 * 1024)).toBe(
			false,
		);
		// The first successful block remains usable; the ambiguous second one
		// consumes the remainder without being refunded or retried.
		expect(await ledger.reserveSandboxEgress("sbx_good", 4 * 1024 * 1024)).toBe(
			true,
		);
		expect(await ledger.reserveSandboxEgress("sbx_good", 1)).toBe(false);
		expect(send).toHaveBeenCalledTimes(2);
	});
	it("returns to small blocks after idle credit expires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const reservations: number[] = [];
		const send: typeof fetch = async (_url, init) => {
			reservations.push(JSON.parse(String(init?.body)).bytes);
			return new Response(null, { status: 204 });
		};
		const ledger = createProxyQuotaLedger(
			{ ...config, maxEgressBytes: 256 * 1024 * 1024 },
			send,
		);
		expect(await ledger.reserveSandboxEgress("sbx_good", 64 * 1024)).toBe(true);
		expect(await ledger.reserveSandboxEgress("sbx_good", 64 * 1024)).toBe(true);
		vi.advanceTimersByTime(5001);
		expect(await ledger.reserveSandboxEgress("sbx_good", 1)).toBe(true);
		expect(reservations).toEqual([65536, 131072, 65536]);
	});
});
describe("proxy VM binding and streaming", () => {
	it("verifies a signed token issued under the exact Vercel team ID", async () => {
		const signing = await generateKeyPair("RS256", { extractable: true });
		const publicKey = await exportJWK(signing.publicKey);
		publicKey.kid = "team-id-key";
		publicKey.alg = "RS256";
		const lookup = vi.fn(async () => Response.json({ keys: [publicKey] }));
		vi.stubGlobal("fetch", lookup);
		const ledger = { reserveSandboxEgress: vi.fn(async () => false) };
		const handler = createSandboxProxyVmHandler(config, { ledger });
		expect((await bind(handler)).status).toBe(204);
		const token = await new SignJWT({
			team_id: config.teamId,
			project_id: config.projectId,
			sandbox_id: "sbx_good",
		})
			.setProtectedHeader({ alg: "RS256", kid: "team-id-key" })
			.setIssuer(`https://oidc.vercel.com/${config.teamId}`)
			.setAudience(`${config.proxyOrigin}/sandbox/egress`)
			.setExpirationTime("5m")
			.sign(signing.privateKey);
		const response = await handler(
			new Request(`${config.proxyOrigin}/sandbox/egress/path`, {
				headers: {
					"vercel-sandbox-oidc-token": token,
					"vercel-forwarded-host": "github.com",
					"vercel-forwarded-scheme": "https",
					"vercel-forwarded-port": "443",
					"vercel-forwarded-path": "/path",
				},
			}),
		);
		expect(response.status).toBe(429);
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(ledger.reserveSandboxEgress).toHaveBeenCalledOnce();
	});
	it("keeps the SDK denial response if logging fails", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {
			throw new Error("log stream unavailable");
		});
		try {
			const handler = createSandboxProxyVmHandler(config);
			expect((await bind(handler)).status).toBe(204);
			const response = await handler(request());
			expect(response.status).toBe(403);
			expect(await response.text()).toBe("Forbidden");
		} finally {
			log.mockRestore();
		}
	});
	it("records only a fixed SDK denial category once without request data", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const ledger = { reserveSandboxEgress: vi.fn(async () => true) };
			const handler = createSandboxProxyVmHandler(config, { ledger });
			expect((await bind(handler)).status).toBe(204);
			for (let i = 0; i < 2; i++) {
				const response = await handler(request());
				expect(response.status).toBe(403);
				expect(await response.text()).toBe("Forbidden");
			}
			expect(log).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledWith(
				JSON.stringify({ event: "hobo_ci_proxy_denied", stage: "headers" }),
			);
			expect(ledger.reserveSandboxEgress).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});
	it("rejects a forged token through the real SDK signature verifier", async () => {
		const issuer = "https://oidc.vercel.com/team-forged-signature";
		const proxyConfig = parseProxyVmConfig({
			...config,
			expectedIssuer: issuer,
		});
		const signing = await generateKeyPair("RS256");
		const trusted = await generateKeyPair("RS256", { extractable: true });
		const trustedKey = await exportJWK(trusted.publicKey);
		trustedKey.kid = "test-key";
		trustedKey.alg = "RS256";
		const lookup = vi.fn(async () => Response.json({ keys: [trustedKey] }));
		vi.stubGlobal("fetch", lookup);
		const ledger = { reserveSandboxEgress: vi.fn(async () => true) };
		const handler = createSandboxProxyVmHandler(proxyConfig, { ledger });
		expect((await bind(handler)).status).toBe(204);
		const token = await new SignJWT({
			team_id: config.teamId,
			project_id: config.projectId,
			sandbox_id: "sbx_good",
		})
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuer(issuer)
			.setAudience(`${config.proxyOrigin}/sandbox/egress`)
			.setExpirationTime("5m")
			.sign(signing.privateKey);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await handler(
				new Request(`${config.proxyOrigin}/sandbox/egress/path`, {
					headers: {
						"vercel-sandbox-oidc-token": token,
						"vercel-forwarded-host": "github.com",
						"vercel-forwarded-scheme": "https",
						"vercel-forwarded-port": "443",
						"vercel-forwarded-path": "/path",
					},
				}),
			);
			expect(response.status).toBe(403);
			expect(lookup).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalledWith(
				JSON.stringify({
					event: "hobo_ci_proxy_denied",
					stage: "jwt_signature",
				}),
			);
			expect(ledger.reserveSandboxEgress).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});
	it("passes only the exact pinned slug, team ID and global issuers to the signature verifier", async () => {
		// The injected verifier is deliberately a rejection stub: acceptance of an
		// issuer by the prefilter must never itself authorize an unsigned token.
		const verifier = vi.fn(async () => new Response(null, { status: 403 }));
		const handler = createSandboxProxyVmHandler(config, { proxy: verifier });
		expect((await bind(handler)).status).toBe(204);
		for (const issuer of [
			config.expectedIssuer,
			`https://oidc.vercel.com/${config.teamId}`,
			"https://oidc.vercel.com",
		]) {
			const incoming = new Request(
				`${config.proxyOrigin}/sandbox/egress/path`,
				{
					headers: {
						"vercel-sandbox-oidc-token": unsignedToken("sbx_good", issuer),
					},
				},
			);
			expect((await handler(incoming)).status).toBe(403);
		}
		expect(verifier).toHaveBeenCalledTimes(3);
		for (const issuer of [
			"https://oidc.vercel.com/team_other",
			`https://oidc.vercel.com/${config.teamId}/other`,
			`https://oidc.vercel.com/${config.teamId}.attacker`,
		]) {
			const incoming = new Request(
				`${config.proxyOrigin}/sandbox/egress/path`,
				{
					headers: {
						"vercel-sandbox-oidc-token": unsignedToken("sbx_good", issuer),
					},
				},
			);
			expect((await handler(incoming)).status).toBe(403);
		}
		expect(verifier).toHaveBeenCalledTimes(3);
	});
	it("rejects a different team or project before attempting signature verification", async () => {
		const verifier = vi.fn(async () => new Response(null, { status: 403 }));
		const handler = createSandboxProxyVmHandler(config, { proxy: verifier });
		expect((await bind(handler)).status).toBe(204);
		for (const changed of [
			{ team_id: "team_other", project_id: config.projectId },
			{ team_id: config.teamId, project_id: "prj_other" },
		]) {
			const payload = Buffer.from(
				JSON.stringify({
					iss: "https://oidc.vercel.com",
					aud: `${config.proxyOrigin}/sandbox/egress`,
					exp: Math.floor(Date.now() / 1000) + 300,
					...changed,
					sandbox_id: "sbx_good",
				}),
			).toString("base64url");
			const incoming = new Request(
				`${config.proxyOrigin}/sandbox/egress/path`,
				{
					headers: { "vercel-sandbox-oidc-token": `e30.${payload}.c2ln` },
				},
			);
			expect((await handler(incoming)).status).toBe(403);
		}
		expect(verifier).not.toHaveBeenCalled();
	});
	it("requires a nonexpired numeric expiry before attempting verification", async () => {
		const verifier = vi.fn(async () => new Response(null, { status: 403 }));
		const handler = createSandboxProxyVmHandler(config, { proxy: verifier });
		expect((await bind(handler)).status).toBe(204);
		for (const expiration of [
			undefined,
			"later",
			Math.floor(Date.now() / 1000) - 61,
		]) {
			const payload = Buffer.from(
				JSON.stringify({
					iss: config.expectedIssuer,
					aud: `${config.proxyOrigin}/sandbox/egress`,
					team_id: config.teamId,
					project_id: config.projectId,
					sandbox_id: "sbx_good",
					exp: expiration,
				}),
			).toString("base64url");
			const incoming = new Request(
				`${config.proxyOrigin}/sandbox/egress/path`,
				{
					headers: { "vercel-sandbox-oidc-token": `e30.${payload}.c2ln` },
				},
			);
			expect((await handler(incoming)).status).toBe(403);
		}
		expect(verifier).not.toHaveBeenCalled();
	});
	it("rejects forged binding, locks one guest, and rejects other signed Sandbox identities before quota", async () => {
		const ledger = { reserveSandboxEgress: vi.fn(async () => true) };
		let identity = "sbx_good";
		const wrapProxy = (verified: ProxyHandler) => async (_request: Request) =>
			verified(new Request("https://github.com/"), {
				host: "proxy.example.test",
				teamId: config.teamId,
				projectId: config.projectId,
				sandboxId: identity,
				sandboxName: identity,
			});
		const handler = createSandboxProxyVmHandler(config, { ledger, wrapProxy });
		const wrong = await handler(
			new Request(`${config.proxyOrigin}/internal/bind`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
				},
				body: JSON.stringify({ sandboxId: "sbx_bad" }),
			}),
		);
		expect(wrong.status).toBe(403);
		expect((await bind(handler)).status).toBe(204);
		expect((await bind(handler, "sbx_bad")).status).toBe(409);
		identity = "sbx_bad";
		expect((await handler(request("sbx_bad"))).status).toBe(403);
		expect(ledger.reserveSandboxEgress).not.toHaveBeenCalled();
	});
	it("retains concurrency permits until response streams finish or are cancelled", async () => {
		const handler = createSandboxProxyVmHandler(config, {
			proxy: async () =>
				new Response(new ReadableStream<Uint8Array>({ pull() {} })),
		});
		expect((await bind(handler)).status).toBe(204);
		const responses = await Promise.all(
			Array.from({ length: 8 }, () => handler(request())),
		);
		expect(responses.every((response) => response.status === 200)).toBe(true);
		expect((await handler(request())).status).toBe(429);
		await responses[0]?.body?.cancel();
		const later = await handler(request());
		expect(later.status).toBe(200);
		await later.body?.cancel();
		await Promise.all(
			responses.slice(1).map((response) => response.body?.cancel()),
		);
	});
	it("rejects a mismatched unverified issuer before contacting the OIDC verifier or reading body", async () => {
		const proxy = vi.fn(async () => new Response(null, { status: 204 }));
		const handler = createSandboxProxyVmHandler(config, { proxy });
		expect((await bind(handler)).status).toBe(204);
		const incoming = new Request(`${config.proxyOrigin}/sandbox/egress/path`, {
			method: "POST",
			headers: {
				"vercel-sandbox-oidc-token": unsignedToken(
					"sbx_good",
					"https://oidc.vercel.com/attacker",
				),
			},
			body: "do-not-read",
		});
		expect((await handler(incoming)).status).toBe(403);
		expect(incoming.bodyUsed).toBe(false);
		expect(proxy).not.toHaveBeenCalled();
	});
});

it("streams a workload larger than the Function payload limit over the proxy VM port", async () => {
	const { createSandboxProxyVmServer } = await import(
		"../src/sandbox-proxy-vm.js"
	);
	const { once } = await import("node:events");
	const server = createSandboxProxyVmServer(config, {
		proxy: async (incoming) => new Response(incoming.body),
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = z
		.object({ port: z.number().int().positive() })
		.parse(server.address());
	const base = `http://127.0.0.1:${address.port}`;
	try {
		const binding = await fetch(`${base}/internal/bind`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${config.quotaToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ sandboxId: "sbx_good" }),
		});
		expect(binding.status).toBe(204);
		const chunk = new Uint8Array(256 * 1024).fill(42);
		let remaining = 24;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (remaining-- > 0) controller.enqueue(chunk);
				else controller.close();
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: { "vercel-sandbox-oidc-token": unsignedToken() },
			body,
			duplex: "half",
		};
		const result = await fetch(`${base}/sandbox/egress/path`, init);
		expect(result.status).toBe(200);
		let count = 0;
		const reader = result.body?.getReader();
		if (!reader) throw new Error("missing stream");
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			count += next.value.byteLength;
		}
		expect(count).toBe(24 * chunk.byteLength);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

it("rejects an oversized chunked bind body without buffering it", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(2048));
		},
		cancel() {
			cancelled = true;
		},
	});
	const init: RequestInit & { duplex: "half" } = {
		method: "POST",
		headers: { authorization: `Bearer ${config.quotaToken}` },
		body,
		duplex: "half",
	};
	const handler = createSandboxProxyVmHandler(config, {
		proxy: async () => new Response(null, { status: 204 }),
	});
	expect(
		(await handler(new Request(`${config.proxyOrigin}/internal/bind`, init)))
			.status,
	).toBe(413);
	expect(cancelled).toBe(true);
});
