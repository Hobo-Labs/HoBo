import { spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	unlinkSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

export interface SshAgentProxyOptions {
	readonly socketPath: string;
	readonly upstreamSocket: string;
	readonly expiresAt: string;
	readonly onRedeem?: () => void | Promise<void>;
}

export interface SshAgentProxy {
	readonly socketPath: string;
	readonly done: Promise<void>;
	close(): Promise<void>;
}

const SSH_AGENT_SIGN_REQUEST = 13;
const MAX_AGENT_FRAME_BYTES = 1024 * 1024;

async function forwardAgentFrames(
	client: Socket,
	upstream: Socket,
	onSignature: () => void | Promise<void>,
): Promise<void> {
	let pending = Buffer.alloc(0);
	let observed = false;
	for await (const value of client) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 4) {
			const length = pending.readUInt32BE(0);
			if (length < 1 || length > MAX_AGENT_FRAME_BYTES) {
				throw new Error("invalid SSH agent frame length");
			}
			if (pending.length < length + 4) break;
			const frame = pending.subarray(0, length + 4);
			pending = pending.subarray(length + 4);
			if (!observed && frame[4] === SSH_AGENT_SIGN_REQUEST) {
				await onSignature();
				observed = true;
			}
			await new Promise<void>((resolve, reject) => {
				upstream.write(frame, (error) => (error ? reject(error) : resolve()));
			});
		}
	}
	if (pending.length > 0) throw new Error("truncated SSH agent frame");
	upstream.end();
}

/** Lease-bound transparent proxy for the installed SSH agent protocol. */
export async function startSshAgentProxy(
	options: SshAgentProxyOptions,
): Promise<SshAgentProxy> {
	if (!isAbsolute(options.socketPath) || !isAbsolute(options.upstreamSocket)) {
		throw new TypeError("SSH agent socket paths must be absolute");
	}
	const expiresAt = Date.parse(options.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
		throw new Error("Station authorization is expired or invalid");
	}
	if (
		!existsSync(options.upstreamSocket) ||
		!lstatSync(options.upstreamSocket).isSocket()
	) {
		throw new Error(
			`SSH_AUTH_SOCK is not a Unix socket: ${options.upstreamSocket}`,
		);
	}
	mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });
	chmodSync(dirname(options.socketPath), 0o700);
	if (existsSync(options.socketPath)) {
		if (!lstatSync(options.socketPath).isSocket()) {
			throw new Error(`refusing to replace non-socket ${options.socketPath}`);
		}
		unlinkSync(options.socketPath);
	}

	const connections = new Set<Socket>();
	const server = createServer((client) => {
		connections.add(client);
		client.once("close", () => connections.delete(client));
		if (Date.now() >= expiresAt) {
			client.destroy();
			return;
		}
		const upstream = createConnection(options.upstreamSocket);
		connections.add(upstream);
		upstream.once("close", () => connections.delete(upstream));
		upstream.once("connect", () => {
			void forwardAgentFrames(client, upstream, () =>
				options.onRedeem?.(),
			).catch((error) => {
				client.destroy(
					error instanceof Error ? error : new Error(String(error)),
				);
				upstream.destroy();
			});
			upstream.pipe(client);
		});
		upstream.once("error", (error) => client.destroy(error));
		client.once("error", () => upstream.destroy());
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	chmodSync(options.socketPath, 0o600);

	let closed = false;
	let finish!: () => void;
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const close = (): Promise<void> => {
		if (closed) return done;
		closed = true;
		clearTimeout(expiration);
		for (const socket of connections) socket.destroy();
		server.close(() => {
			if (existsSync(options.socketPath)) unlinkSync(options.socketPath);
			finish();
		});
		return done;
	};
	const expiration = setTimeout(
		close,
		Math.min(expiresAt - Date.now(), 2_147_483_647),
	);
	return { socketPath: options.socketPath, done, close };
}

export interface ResidentProxyPayload extends SshAgentProxyOptions {
	readonly auditPath: string;
	readonly stationId: string;
	readonly tenant: string;
	readonly sessionId: string;
	readonly subject: string;
	readonly target: string;
	readonly isolationClass:
		| "local-dev"
		| "development"
		| "staging"
		| "production"
		| "ephemeral";
	readonly credentialRef: string;
}

export interface ResidentSshAgentProxy {
	readonly socketPath: string;
	stop(): Promise<void>;
}

export function residentProxyEnvironment(): NodeJS.ProcessEnv {
	return {};
}

function parseResidentPayload(encoded: string): ResidentProxyPayload {
	let value: JsonValue;
	try {
		value = parseJsonValue(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		throw new TypeError("invalid resident SSH agent payload");
	}
	if (!value || !isJsonObject(value)) {
		throw new TypeError("invalid resident SSH agent payload");
	}
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	const payload = value as JsonObject;
	for (const field of [
		"socketPath",
		"upstreamSocket",
		"expiresAt",
		"auditPath",
		"stationId",
		"tenant",
		"sessionId",
		"subject",
		"target",
		"isolationClass",
		"credentialRef",
	]) {
		if (!isJsonString(payload[field]) || payload[field] === "") {
			throw new TypeError(`invalid resident SSH agent ${field}`);
		}
	}
	if (!isAbsolute(String(payload.auditPath))) {
		throw new TypeError("resident SSH agent auditPath must be absolute");
	}
	if (
		!new Set([
			"local-dev",
			"development",
			"staging",
			"production",
			"ephemeral",
		]).has(String(payload.isolationClass))
	) {
		throw new TypeError("invalid resident SSH agent isolationClass");
	}
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	return {
		socketPath: String(payload.socketPath),
		upstreamSocket: String(payload.upstreamSocket),
		expiresAt: String(payload.expiresAt),
		auditPath: String(payload.auditPath),
		stationId: String(payload.stationId),
		tenant: String(payload.tenant),
		sessionId: String(payload.sessionId),
		subject: String(payload.subject),
		target: String(payload.target),
		isolationClass:
			// SAFETY: isolationClass was checked against the closed set above.
			payload.isolationClass as ResidentProxyPayload["isolationClass"],
		credentialRef: String(payload.credentialRef),
	};
}

function appendAudit(
	payload: ResidentProxyPayload,
	type: "pam.CredentialRedeemed" | "pam.SessionEnded",
	reason?: string,
): void {
	appendFileSync(
		payload.auditPath,
		`${JSON.stringify({
			type,
			time: new Date().toISOString(),
			stationId: payload.stationId,
			tenant: payload.tenant,
			sessionId: payload.sessionId,
			subject: payload.subject,
			target: payload.target,
			isolationClass: payload.isolationClass,
			kind: "native",
			credentialRef: payload.credentialRef,
			...(reason ? { reason } : undefined),
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

/** Hidden resident-child entry point used by tmux panes. */
export async function runResidentSshAgentProxy(
	encoded: string,
): Promise<number> {
	const payload = parseResidentPayload(encoded);
	let reason = "authorization-expired";
	let signal!: () => void;
	const interrupted = new Promise<void>((resolve) => {
		signal = resolve;
	});
	const onInterrupt = (): void => {
		reason = "interrupted";
		signal();
	};
	const onTerminate = (): void => {
		reason = "launcher-stop";
		signal();
	};
	// Listening before the socket exists: the launcher takes the socket file
	// as the proxy started, and may stop it at once. Listening only once the
	// proxy had started left a stop in between to the signal's default action,
	// with no pam.SessionEnded written.
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onTerminate);
	const proxy = await startSshAgentProxy({
		...payload,
		onRedeem: () => appendAudit(payload, "pam.CredentialRedeemed"),
	});
	await Promise.race([proxy.done, interrupted]);
	process.off("SIGINT", onInterrupt);
	process.off("SIGTERM", onTerminate);
	await proxy.close();
	appendAudit(payload, "pam.SessionEnded", reason);
	return 0;
}

/** Start a proxy child that survives the launcher after tmux detaches. */
export async function startResidentSshAgentProxy(
	payload: ResidentProxyPayload,
): Promise<ResidentSshAgentProxy> {
	const entry = process.argv[1];
	if (!entry) throw new Error("cannot locate hobo-code executable");
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const child = spawn(process.execPath, [entry, "_station-agent", encoded], {
		detached: true,
		env: residentProxyEnvironment(),
		stdio: "ignore",
	});
	let spawnError: Error | undefined;
	child.once("error", (error) => {
		spawnError = error;
	});
	const exit = new Promise<void>((resolve) => child.once("exit", resolve));
	const started = Date.now();
	while (!existsSync(payload.socketPath)) {
		if (spawnError) throw spawnError;
		if (child.exitCode !== null) {
			throw new Error("resident SSH agent exited before opening its socket");
		}
		if (Date.now() - started > 3_000) {
			child.kill("SIGTERM");
			throw new Error("resident SSH agent did not open its socket");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	child.unref();
	return {
		socketPath: payload.socketPath,
		async stop() {
			// Unreferenced so a launcher that keeps it can end; one that stops it
			// waits for its exit (its pam.SessionEnded), which an unreferenced
			// child left to an event loop that could end first.
			child.ref();
			if (child.exitCode === null) child.kill("SIGTERM");
			await exit;
		},
	};
}
