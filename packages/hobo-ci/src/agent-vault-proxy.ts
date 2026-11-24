import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, ProxyAgent } from "undici";

import { childEgressEnv, egressFrom, fetchWithDispatcher } from "./egress.js";

const LOOPBACK = "127.0.0.1";
const PROXY_USER = "x-agent-vault";
const HEALTH_PATH = "/_agent-vault/ca";
const PROXY_TOKEN_VARIABLE = "INFISICAL_AGENT_VAULT_PROXY_TOKEN";

export type AgentVaultProxyLaunch = Readonly<{
	command: string;
	siteUrl: string;
	proxyToken: string;
}>;

export interface AgentVaultProxyProcess {
	readonly port: number;
	stop(): Promise<void>;
}

export type LaunchAgentVaultProxy = (
	launch: AgentVaultProxyLaunch,
) => Promise<AgentVaultProxyProcess>;

export class AgentVaultProxyStartError extends Error {
	constructor(
		readonly reason: "exited" | "unhealthy" | "spawn-failed",
		message: string,
	) {
		super(message);
		this.name = "AgentVaultProxyStartError";
	}
}

export function agentVaultProxyArguments(input: {
	readonly port: number;
	readonly dataDir: string;
	readonly siteUrl: string;
}): readonly string[] {
	return Object.freeze([
		"agent-vault",
		"proxy",
		"--listen-host",
		LOOPBACK,
		"--port",
		String(input.port),
		"--data-dir",
		input.dataDir,
		"--domain",
		`${new URL(input.siteUrl).origin}/api`,
		"--silent",
		"--telemetry=false",
	]);
}

function isAddressInfo(
	value: string | AddressInfo | null,
): value is AddressInfo {
	return (
		value !== null &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

async function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, LOOPBACK, () => {
			const address = server.address();
			const port = isAddressInfo(address) ? address.port : 0;
			server.close(() =>
				port > 0
					? resolve(port)
					: reject(new Error("no loopback port was free")),
			);
		});
	});
}

async function answersHealth(
	port: number,
	direct: Agent,
	timeoutMs: number,
): Promise<boolean> {
	try {
		const response = await fetchWithDispatcher(direct)(
			`http://${LOOPBACK}:${port}${HEALTH_PATH}`,
			{ signal: AbortSignal.timeout(timeoutMs), redirect: "error" },
		);
		await response.body?.cancel().catch(() => undefined);
		return response.status === 200;
	} catch {
		return false;
	}
}

function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve();
	return new Promise((resolve) => {
		const force = setTimeout(() => child.kill("SIGKILL"), graceMs);
		child.once("exit", () => {
			clearTimeout(force);
			resolve();
		});
		child.kill("SIGTERM");
	});
}

export function agentVaultProxyLauncher(
	options: {
		readonly env?: Readonly<Record<string, string | undefined>>;
		readonly startTimeoutMs?: number;
		readonly pollMs?: number;
		readonly stopGraceMs?: number;
	} = {},
): LaunchAgentVaultProxy {
	const env = options.env ?? process.env;
	const startTimeoutMs = options.startTimeoutMs ?? 30_000;
	const pollMs = options.pollMs ?? 200;
	const stopGraceMs = options.stopGraceMs ?? 5_000;
	return async (launch) => {
		const port = await freeLoopbackPort();
		const dataDir = await mkdtemp(path.join(tmpdir(), "hobo-agent-vault-"));
		const childEnv: NodeJS.ProcessEnv = {
			...childEgressEnv(env, egressFrom(env)),
			INFISICAL_DISABLE_TELEMETRY: "1",
		};
		childEnv[PROXY_TOKEN_VARIABLE] = launch.proxyToken;
		let child: ChildProcess;
		try {
			child = spawn(
				launch.command,
				[
					...agentVaultProxyArguments({
						port,
						dataDir,
						siteUrl: launch.siteUrl,
					}),
				],
				{ env: childEnv, stdio: "ignore" },
			);
		} catch {
			await rm(dataDir, { recursive: true, force: true });
			throw new AgentVaultProxyStartError(
				"spawn-failed",
				"The Infisical CLI could not be started for the Agent Vault proxy.",
			);
		}
		const removeOnExit = () => {
			child.kill("SIGKILL");
			rmSync(dataDir, { recursive: true, force: true });
		};
		process.once("exit", removeOnExit);
		let stopped: Promise<void> | undefined;
		const stop = () => {
			stopped ??= (async () => {
				process.removeListener("exit", removeOnExit);
				await stopChild(child, stopGraceMs);
				await rm(dataDir, { recursive: true, force: true });
			})();
			return stopped;
		};
		let failedToSpawn = false;
		child.once("error", () => {
			failedToSpawn = true;
		});
		const direct = new Agent();
		try {
			const deadline = Date.now() + startTimeoutMs;
			for (;;) {
				if (failedToSpawn)
					throw new AgentVaultProxyStartError(
						"spawn-failed",
						"The Infisical CLI could not be started for the Agent Vault proxy.",
					);
				if (child.exitCode !== null || child.signalCode !== null)
					throw new AgentVaultProxyStartError(
						"exited",
						"The Agent Vault proxy exited while starting: Infisical refused its token or settings.",
					);
				if (await answersHealth(port, direct, pollMs * 5)) break;
				if (Date.now() >= deadline)
					throw new AgentVaultProxyStartError(
						"unhealthy",
						`The Agent Vault proxy did not answer on ${LOOPBACK}:${port} within ${Math.round(startTimeoutMs / 1000)} s.`,
					);
				await new Promise((resolve) => setTimeout(resolve, pollMs));
			}
		} catch (error) {
			await stop();
			throw error;
		} finally {
			await direct.close().catch(() => undefined);
		}
		return Object.freeze({ port, stop });
	};
}

export type AgentVaultProxyRoute = Readonly<{
	port: number;
	sessionToken: string;
	certificateAuthority: string;
}>;

export function agentVaultProxyAgentOptions(
	route: AgentVaultProxyRoute,
): ProxyAgent.Options {
	return {
		uri: `http://${LOOPBACK}:${route.port}`,
		token: `Basic ${Buffer.from(`${PROXY_USER}:${route.sessionToken}`).toString("base64")}`,
		requestTls: { ca: [route.certificateAuthority] },
	};
}

export function agentVaultProxyFetch(route: AgentVaultProxyRoute): Readonly<{
	fetch: typeof fetch;
	close: () => Promise<void>;
}> {
	const dispatcher = new ProxyAgent(agentVaultProxyAgentOptions(route));
	return Object.freeze({
		fetch: fetchWithDispatcher(dispatcher),
		close: () => dispatcher.close().catch(() => undefined),
	});
}
