import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createNodeRelayHandler } from "@hobo/ci-gh-actions/node-http";
import type { Session } from "@vercel/sandbox";
import { defineSandboxProxy, type ProxyHandler } from "@vercel/sandbox/proxy";
import { z } from "zod";
import { streamsBody } from "./relay-streams.js";
import {
	createVerifiedSandboxEgressHandler,
	type SandboxEgressLedger,
} from "./sandbox-egress-proxy.js";
import { ensureSandboxWorkdir } from "./sandbox-workdir.js";

const QUOTA_MIN_BLOCK_BYTES = 64 * 1024;
// Match the durable quota endpoint's maximum for one reservation.
const QUOTA_MAX_BLOCK_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 10_000;
const MAX_ACTIVE = 8;
const MAX_TOKEN_BYTES = 8192;
const Config = z
	.object({
		proxyOrigin: z.string().url(),
		relayOrigin: z.string().url(),
		expectedIssuer: z.string().url(),
		leaseId: z.string().uuid(),
		proxySessionId: z.string().regex(/^sbx_[A-Za-z0-9_-]+$/),
		quotaToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
		teamId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
		projectId: z.string().min(1).max(120),
		hosts: z.array(z.string()).min(1).max(100),
		maxEgressBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		maxControlCalls: z.number().int().positive().max(1_000_000),
		port: z.number().int().min(1024).max(65535),
		maxRequestBytes: z
			.number()
			.int()
			.positive()
			.max(1024 * 1024 * 1024),
		maxResponseBytes: z
			.number()
			.int()
			.positive()
			.max(1024 * 1024 * 1024),
	})
	.strict();
export type ProxyVmConfig = z.infer<typeof Config>;

function origin(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("invalid proxy origin");
	return url.origin;
}
export function parseProxyVmConfig(
	value: z.input<typeof Config>,
): ProxyVmConfig {
	const config = Config.parse(value);
	origin(config.proxyOrigin);
	origin(config.relayOrigin);
	const issuer = new URL(config.expectedIssuer);
	if (
		issuer.protocol !== "https:" ||
		issuer.hostname !== "oidc.vercel.com" ||
		issuer.port ||
		issuer.username ||
		issuer.password ||
		issuer.search ||
		issuer.hash ||
		!/^\/(?:[a-z0-9][a-z0-9-]*)?$/.test(issuer.pathname) ||
		issuer.href.replace(/\/$/, "") !== config.expectedIssuer.replace(/\/$/, "")
	)
		throw new Error("invalid sandbox issuer");
	const bytes = Buffer.from(config.quotaToken, "base64url");
	if (bytes.length !== 32 || bytes.toString("base64url") !== config.quotaToken)
		throw new Error("invalid quota credential");
	return config;
}

/** What the proxy VM itself counted: bytes reserved (every attempted block,
 * granted or lost) and quota calls made. It is the authority settlement
 * reads back (ADR-0179 §10), so a relay that lost its cache can still settle. */
export type ProxyMeter = Readonly<{ bytes: number; calls: number }>;
export type ProxyQuotaLedger = SandboxEgressLedger & { meter(): ProxyMeter };

/** Reserve blocks up front; loss of a quota response never refunds or retries.
 * Shared blocks serialize concurrent streams and cap external invocations. */
export function createProxyQuotaLedger(
	config: ProxyVmConfig,
	send: typeof fetch = fetch,
): ProxyQuotaLedger {
	// Large transfers need fewer durable control calls. Bound the block relative
	// to the lease quota and start small again after an idle credit expires.
	const maxBlockBytes = Math.max(
		QUOTA_MIN_BLOCK_BYTES,
		Math.min(
			QUOTA_MAX_BLOCK_BYTES,
			Math.floor(config.maxEgressBytes / 16 / QUOTA_MIN_BLOCK_BYTES) *
				QUOTA_MIN_BLOCK_BYTES,
		),
	);
	let credits = 0;
	let blockBytes = QUOTA_MIN_BLOCK_BYTES;
	let boundSandboxId: string | undefined;
	let creditExpiresAt = 0;
	let committed = 0;
	let attempts = 0;
	let tail: Promise<void> = Promise.resolve();
	return {
		meter: () => ({ bytes: committed, calls: attempts }),
		async reserveSandboxEgress(sandboxId, bytes) {
			if (
				!/^sbx_[A-Za-z0-9_-]+$/.test(sandboxId) ||
				!Number.isSafeInteger(bytes) ||
				bytes <= 0
			)
				return false;
			const operation = tail.then(async () => {
				if (boundSandboxId !== undefined && boundSandboxId !== sandboxId)
					return false;
				for (;;) {
					if (Date.now() >= creditExpiresAt) {
						credits = 0;
						blockBytes = QUOTA_MIN_BLOCK_BYTES;
					}
					if (bytes <= credits) {
						credits -= bytes;
						return true;
					}
					const needed = bytes - credits;
					const remaining = config.maxEgressBytes - committed;
					if (needed > remaining || attempts >= config.maxControlCalls)
						return false;
					const rounded =
						Math.ceil(Math.min(needed, QUOTA_MAX_BLOCK_BYTES) / blockBytes) *
						blockBytes;
					const reserve = Math.min(remaining, QUOTA_MAX_BLOCK_BYTES, rounded);
					attempts++;
					try {
						const response = await send(
							`${origin(config.relayOrigin)}/internal/sandbox/quota`,
							{
								method: "POST",
								headers: {
									authorization: `Bearer ${config.quotaToken}`,
									"content-type": "application/json",
								},
								body: JSON.stringify({
									leaseId: config.leaseId,
									proxySessionId: config.proxySessionId,
									sandboxId,
									bytes: reserve,
									requestId: randomUUID(),
								}),
								redirect: "error",
								signal: AbortSignal.timeout(5000),
							},
						);
						// Every attempted reservation is consumed locally even if its result is lost.
						committed += reserve;
						if (response.status !== 204) return false;
						boundSandboxId = sandboxId;
						creditExpiresAt = Date.now() + 5000;
						credits += reserve;
						blockBytes = Math.min(maxBlockBytes, blockBytes * 2);
					} catch {
						committed += reserve;
						return false;
					}
				}
			});
			tail = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation;
		},
	};
}

function authorizedBearer(
	value: string | null | undefined,
	config: ProxyVmConfig,
): boolean {
	const expected = createHash("sha256")
		.update(`Bearer ${config.quotaToken}`)
		.digest();
	const actual = createHash("sha256")
		.update(value ?? "")
		.digest();
	return timingSafeEqual(expected, actual);
}

/** Only fixed categories are logged: SDK exceptions can contain request data. */
function proxyVerificationFailure(error: Error): string {
	if (error.message === "Missing required proxy headers") return "headers";
	if (error.message === "Invalid proxied request URL") return "forwarded_url";
	if (error.message === "Missing OIDC issuer") return "issuer_missing";
	if (error.message === "Invalid OIDC issuer") return "issuer_invalid";
	if (error.message === "Missing required claims in OIDC token")
		return "claims";
	const code = "code" in error ? error.code : undefined;
	switch (code) {
		case "ERR_JWT_CLAIM_VALIDATION_FAILED":
			return "jwt_claim";
		case "ERR_JWT_EXPIRED":
			return "jwt_expired";
		case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
			return "jwt_signature";
		case "ERR_JWKS_TIMEOUT":
			return "jwks_timeout";
		case "ERR_JWKS_NO_MATCHING_KEY":
			return "jwks_no_key";
		case "ERR_JWKS_INVALID":
			return "jwks_invalid";
		default:
			return "other";
	}
}

const UnverifiedToken = z.object({
	iss: z.string(),
	aud: z.union([z.string(), z.array(z.string())]),
	exp: z.number().int().positive().safe(),
	team_id: z.string(),
	project_id: z.string(),
	sandbox_id: z.string(),
});
/** This is only a cheap rejection filter. The SDK verifies the signature,
 * issuer, audience and expiry before using any token claim. */
function plausibleToken(token: string | null, config: ProxyVmConfig): boolean {
	if (!token || token.length > MAX_TOKEN_BYTES) return false;
	const parts = token.split(".");
	const payload = parts[1];
	if (parts.length !== 3 || !payload || !/^[A-Za-z0-9_-]+$/.test(payload))
		return false;
	try {
		const parsed = UnverifiedToken.safeParse(
			JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
		);
		if (!parsed.success) return false;
		const claim = parsed.data;
		const audience = `${origin(config.proxyOrigin)}/sandbox/egress`;
		return (
			// Vercel can issue tokens under either the configured team slug or
			// its immutable team ID. Both remain bound to the exact team claim;
			// the SDK still verifies issuer, audience, signature and lifetime.
			(claim.iss === config.expectedIssuer ||
				claim.iss === `https://oidc.vercel.com/${config.teamId}` ||
				claim.iss === "https://oidc.vercel.com") &&
			// The SDK validates exp when present but does not require it.
			// Apply its documented 60-second clock tolerance before verification;
			// the SDK subsequently verifies the signed claim and its lifetime.
			claim.exp > Math.floor(Date.now() / 1000) - 60 &&
			claim.team_id === config.teamId &&
			claim.project_id === config.projectId &&
			/^sbx_[A-Za-z0-9_-]+$/.test(claim.sandbox_id) &&
			(Array.isArray(claim.aud)
				? claim.aud.includes(audience)
				: claim.aud === audience)
		);
	} catch {
		return false;
	}
}

/** Limit allocation before parsing even when a caller omits Content-Length. */
async function readBindBody(request: Request): Promise<string | undefined> {
	if (!request.body) return undefined;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > 1024) {
				await reader.cancel().catch(() => undefined);
				return undefined;
			}
			chunks.push(part.value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		reader.releaseLock();
	}
}

/** A private-process handler, exposed through the Sandbox port gateway. It
 * limits anonymous requests before authentication and never reads their body. */
export function createSandboxProxyVmHandler(
	config: ProxyVmConfig,
	options: {
		ledger?: SandboxEgressLedger;
		/** The VM's own meter; the default ledger's when none is given. */
		meter?: () => ProxyMeter;
		proxy?: (request: Request) => Promise<Response>;
		wrapProxy?: (
			handler: ProxyHandler,
		) => (request: Request) => Promise<Response>;
	} = {},
) {
	const quota = options.ledger ? undefined : createProxyQuotaLedger(config);
	const ledger = options.ledger ?? quota;
	const readMeter = options.meter ?? quota?.meter;
	if (!ledger) throw new Error("proxy quota ledger missing");
	let verifiedRequests = 0;
	let boundSandboxId: string | undefined;
	const reportedFailures = new Set<string>();
	const verified = createVerifiedSandboxEgressHandler({
		teamId: config.teamId,
		projectId: config.projectId,
		hosts: config.hosts,
		ledger,
		transportMode: "sandbox-vm",
		maxRequestBytes: config.maxRequestBytes,
		maxResponseBytes: config.maxResponseBytes,
	});
	const verifiedHandler: ProxyHandler = async (request, meta) => {
		if (!boundSandboxId || meta.sandboxId !== boundSandboxId)
			return new Response(null, { status: 403 });
		verifiedRequests++;
		if (verifiedRequests > MAX_REQUESTS)
			return new Response(null, { status: 429 });
		return verified(request, meta);
	};
	const proxy =
		options.proxy ??
		(options.wrapProxy
			? options.wrapProxy(verifiedHandler)
			: defineSandboxProxy(verifiedHandler, (_request, error) => {
					const stage = proxyVerificationFailure(error);
					// At most one message per fixed category, even for hostile traffic.
					if (!reportedFailures.has(stage)) {
						reportedFailures.add(stage);
						try {
							console.error(
								JSON.stringify({ event: "hobo_ci_proxy_denied", stage }),
							);
						} catch {
							// Telemetry must not affect the denial response.
						}
					}
					return new Response("Forbidden", { status: 403 });
				}));
	let windowStarted = Date.now();
	let preAuthRequests = 0;
	let active = 0;
	return async (request: Request): Promise<Response> => {
		const now = Date.now();
		if (now - windowStarted >= 60_000) {
			windowStarted = now;
			preAuthRequests = 0;
		}
		preAuthRequests++;
		if (preAuthRequests > 2000 || active >= MAX_ACTIVE)
			return new Response(null, { status: 429 });
		const url = new URL(request.url);
		if (url.origin !== origin(config.proxyOrigin))
			return new Response(null, { status: 403 });
		if (url.pathname === "/healthz" && request.method === "GET")
			return new Response(null, { status: 204 });
		if (url.pathname === "/internal/meter" && request.method === "GET") {
			// The relay reads the VM's own counts before it stops the VM, with
			// the lease's derived token: the same credential the VM holds.
			if (
				!authorizedBearer(request.headers.get("authorization"), config) ||
				!readMeter
			)
				return new Response(null, { status: 403 });
			const meter = readMeter();
			return Response.json(
				{
					leaseId: config.leaseId,
					proxySessionId: config.proxySessionId,
					bytes: meter.bytes,
					calls: meter.calls,
				},
				{ headers: { "cache-control": "no-store" } },
			);
		}
		if (url.pathname === "/internal/bind" && request.method === "POST") {
			if (!authorizedBearer(request.headers.get("authorization"), config))
				return new Response(null, { status: 403 });
			const text = await readBindBody(request);
			if (text === undefined) return new Response(null, { status: 413 });
			let input: unknown;
			try {
				input = JSON.parse(text);
			} catch {
				return new Response(null, { status: 400 });
			}
			const parsed = z
				.object({ sandboxId: z.string().regex(/^sbx_[A-Za-z0-9_-]+$/) })
				.strict()
				.safeParse(input);
			if (!parsed.success) return new Response(null, { status: 400 });
			if (boundSandboxId !== undefined)
				return new Response(null, { status: 409 });
			boundSandboxId = parsed.data.sandboxId;
			return new Response(null, { status: 204 });
		}
		if (
			!(
				url.pathname === "/sandbox/egress" ||
				url.pathname.startsWith("/sandbox/egress/")
			) ||
			!boundSandboxId ||
			!plausibleToken(request.headers.get("vercel-sandbox-oidc-token"), config)
		)
			return new Response(null, { status: 403 });
		active++;
		let released = false;
		const release = () => {
			if (!released) {
				released = true;
				active--;
			}
		};
		try {
			const response = await proxy(request);
			if (!response.body) {
				release();
				return response;
			}
			const reader = response.body.getReader();
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const next = await reader.read();
						if (next.done) {
							release();
							controller.close();
						} else controller.enqueue(next.value);
					} catch (error) {
						release();
						controller.error(error);
					}
				},
				async cancel(reason) {
					release();
					await reader.cancel(reason);
				},
			});
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (error) {
			release();
			throw error;
		}
	};
}

export function createSandboxProxyVmServer(
	config: ProxyVmConfig,
	options: {
		ledger?: SandboxEgressLedger;
		proxy?: (request: Request) => Promise<Response>;
	} = {},
) {
	const handler = createSandboxProxyVmHandler(config, options);
	const adapt = createNodeRelayHandler({
		origin: origin(config.proxyOrigin),
		handle: handler,
		streams: streamsBody,
	});
	let ingressWindow = Date.now();
	let ingressCount = 0;
	const server = createServer(
		(request: IncomingMessage, response: ServerResponse) => {
			const now = Date.now();
			if (now - ingressWindow >= 60_000) {
				ingressWindow = now;
				ingressCount = 0;
			}
			if (++ingressCount > 2000) {
				response.writeHead(429, { connection: "close" }).end();
				return;
			}
			const path = request.url?.split("?", 1)[0] ?? "";
			const method = request.method ?? "GET";
			const health = path === "/healthz" && method === "GET";
			const bind = path === "/internal/bind" && method === "POST";
			const meter = path === "/internal/meter" && method === "GET";
			if (meter) {
				if (
					!authorizedBearer(request.headers.authorization, config) ||
					request.headers["transfer-encoding"] ||
					(request.headers["content-length"] &&
						request.headers["content-length"] !== "0")
				) {
					response.writeHead(403, { connection: "close" }).end();
					return;
				}
			} else if (bind) {
				if (
					!authorizedBearer(request.headers.authorization, config) ||
					request.headers["transfer-encoding"] ||
					!/^\d+$/.test(request.headers["content-length"] ?? "") ||
					Number(request.headers["content-length"]) > 1024
				) {
					response.writeHead(403, { connection: "close" }).end();
					return;
				}
			} else if (health) {
				if (
					request.headers["transfer-encoding"] ||
					(request.headers["content-length"] &&
						request.headers["content-length"] !== "0")
				) {
					response.writeHead(400, { connection: "close" }).end();
					return;
				}
			} else {
				const token = z
					.string()
					.safeParse(request.headers["vercel-sandbox-oidc-token"]);
				if (
					!(
						path === "/sandbox/egress" || path.startsWith("/sandbox/egress/")
					) ||
					![
						"GET",
						"HEAD",
						"POST",
						"PUT",
						"PATCH",
						"DELETE",
						"OPTIONS",
					].includes(method) ||
					!token.success ||
					!plausibleToken(token.data, config)
				) {
					response.writeHead(403, { connection: "close" }).end();
					return;
				}
			}
			void adapt(request, response);
		},
	);
	server.maxHeadersCount = 128;
	server.headersTimeout = 10_000;
	server.requestTimeout = 120_000;
	server.keepAliveTimeout = 5000;
	server.maxConnections = 32;
	return server;
}

/** The limited session operations needed to bootstrap a proxy. */
export interface SandboxProxyBootstrapPort {
	readonly sessionId: string;
	readonly status: string;
	writeFiles(
		files: { path: string; content: Uint8Array; mode: number }[],
	): Promise<void>;
	runCommand(options: {
		cmd: string;
		args: string[];
		cwd: string;
		detached: false;
	}): Promise<{ exitCode: number }>;
	runCommand(options: {
		cmd: string;
		args: string[];
		cwd: string;
		detached: true;
	}): Promise<{ cmdId: string }>;
}

/** The VM has no repository credentials. Its fixed command reads and unlinks
 * the mode-0600 config; the quota token is absent from argv and environment. */
export async function launchSandboxProxyVm(
	session: SandboxProxyBootstrapPort,
	bundle: Uint8Array,
	config: ProxyVmConfig,
) {
	const parsed = parseProxyVmConfig(config);
	if (
		session.sessionId !== parsed.proxySessionId ||
		session.status !== "running"
	)
		throw new Error("proxy session mismatch");
	if (bundle.byteLength < 1 || bundle.byteLength > 5 * 1024 * 1024)
		throw new Error("invalid proxy bundle");
	const readinessNonce = randomBytes(16).toString("hex");
	await ensureSandboxWorkdir(session);
	await session.writeFiles([
		{ path: "/vercel/sandbox/hobo-ci-proxy.mjs", content: bundle, mode: 0o700 },
		{
			path: "/vercel/sandbox/.hobo-ci-proxy-config.json",
			content: Buffer.from(JSON.stringify(parsed)),
			mode: 0o600,
		},
		{
			path: "/vercel/sandbox/.hobo-ci-proxy-nonce",
			content: Buffer.from(readinessNonce),
			mode: 0o600,
		},
	]);
	const command = await session.runCommand({
		cmd: "node",
		args: ["/vercel/sandbox/hobo-ci-proxy.mjs"],
		cwd: "/vercel/sandbox",
		detached: true,
	});
	if (!command.cmdId) throw new Error("proxy command identity missing");
	return { commandId: command.cmdId, readinessNonce };
}
export type ProxyStartupFailure =
	| "marker"
	| "read_config"
	| "parse_config"
	| "listen"
	| "timeout"
	| "process_exit";

/** Bounded in-VM readiness loop: a detached Node process may not be listening
 * when the sandbox command API first returns. Only fixed failure stages leave
 * the sandbox; the marker never contains configuration or exception text. */
export function proxyReadinessScript(
	port: number,
	nonce: string,
	timeoutMs = 10_000,
	paths = {
		ready: "/vercel/sandbox/.hobo-ci-proxy-ready",
		failure: "/vercel/sandbox/.hobo-ci-proxy-failure",
	},
): string {
	if (
		!Number.isInteger(port) ||
		port < 1024 ||
		port > 65535 ||
		!/^[a-f0-9]{32}$/.test(nonce) ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 100 ||
		timeoutMs > 30_000
	)
		throw new Error("invalid proxy readiness parameters");
	return `
const fs = require('node:fs/promises');
(async () => {
  const end = Date.now() + ${timeoutMs};
  while (Date.now() < end) {
    try {
      const stage = (await fs.readFile(${JSON.stringify(paths.failure)}, 'utf8')).trim();
      if (['marker', 'read_config', 'parse_config', 'listen'].includes(stage)) {
        console.log(stage);
        process.exit(1);
      }
    } catch {}
    try {
      const marker = (await fs.readFile(${JSON.stringify(paths.ready)}, 'utf8')).trim();
      if (marker === '${nonce}') {
        const remaining = Math.max(1, end - Date.now());
        const r = await fetch('http://127.0.0.1:${port}/healthz', { signal: AbortSignal.timeout(Math.min(500, remaining)) });
        if (r.status === 204) process.exit(0);
        await r.body?.cancel();
      }
    } catch {}
    const remaining = end - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(200, remaining)));
  }
  console.log('timeout');
  process.exit(1);
})().catch(() => process.exit(1));
`;
}

export class ProxyStartupError extends Error {
	constructor(readonly reason: ProxyStartupFailure) {
		super("proxy service not ready");
	}
}

export function proxyCommandExited(code: number | null | undefined): boolean {
	return z.number().int().safeParse(code).success;
}

/** A proxy error is fatal even after the listener has begun accepting traffic. */
export function installProxyFatalErrorHandler(
	server: ReturnType<typeof createServer>,
	report: () => Promise<void>,
): void {
	server.once("error", () => {
		void Promise.resolve()
			.then(report)
			.finally(() => process.exit(1));
	});
}

export async function probeSandboxProxyVm(
	session: Session,
	port: number,
	commandId: string,
	readinessNonce: string,
): Promise<{ ready: true } | { ready: false; reason: ProxyStartupFailure }> {
	if (
		!Number.isInteger(port) ||
		port < 1024 ||
		port > 65535 ||
		session.status !== "running"
	)
		return { ready: false, reason: "timeout" };
	const response = await session.runCommand({
		cmd: "node",
		args: ["-e", proxyReadinessScript(port, readinessNonce)],
		cwd: "/vercel/sandbox",
		detached: false,
	});
	if (response.exitCode === 0) return { ready: true };
	const output = await response.stdout().catch(() => "");
	const stage = z
		.enum(["marker", "read_config", "parse_config", "listen"])
		.safeParse(output.trim());
	if (stage.success) return { ready: false, reason: stage.data };
	try {
		const command = await session.getCommand(commandId);
		if (proxyCommandExited(command.exitCode))
			return { ready: false, reason: "process_exit" };
	} catch {
		// Missing process metadata does not prove that a process stopped.
	}
	return { ready: false, reason: "timeout" };
}
