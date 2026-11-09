/**
 * Lakebed anonymous Environment Station provision (zero permanent LAKEBED_TOKEN).
 * Mirrors Cloudflare Temporary Accounts: publish first, claim later.
 *
 * Default transport shells `npx lakebed deploy` (anonymous). Tests inject a
 * transport — never requires live Lakebed or static credentials.
 */

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	opendir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TemporaryEnvironmentStationResult } from "@hobo/core";

import { isJsonString, type JsonValue, parseJsonObject } from "./json.js";
import { LAKEBED_PROVIDER_TARGET } from "./options.js";

export const LAKEBED_TEMPORARY_PROVIDER_ID = LAKEBED_PROVIDER_TARGET;
export const supportsAnonymousTemporaryDeploy = true as const;
// public-contract: audited CLI and SDK version used by anonymous capsule deployments.
export const LAKEBED_CLI_VERSION = "0.0.41";
const LAKEBED_STATION_HOST = /(?:^|\.)lakebed\.app$/u;
const LAKEBED_CLAIM_HOSTS = ["lakebed.dev", "api.lakebed.dev"];

function requireLakebedUrl(value: string, kind: "station" | "claim"): string {
	const parsed = new URL(value);
	if (parsed.protocol !== "https:")
		throw new Error(`lakebed ${kind} URL must use https`);
	if (parsed.username || parsed.password || parsed.port) {
		throw new Error(
			`lakebed ${kind} URL must not contain credentials or a custom port`,
		);
	}
	if (kind === "station" && !LAKEBED_STATION_HOST.test(parsed.hostname)) {
		throw new Error("lakebed station URL has an unexpected host");
	}
	if (kind === "claim" && !LAKEBED_CLAIM_HOSTS.includes(parsed.hostname)) {
		throw new Error("lakebed claim URL has an unexpected host");
	}
	if (parsed.search || parsed.hash)
		throw new Error(`lakebed ${kind} URL must not contain a query or fragment`);
	return value;
}

function firstJsonString(...values: Array<JsonValue | undefined>): string {
	for (const value of values) {
		if (isJsonString(value) && value.length > 0) return value;
	}
	return "";
}

export type LakebedAnonymousDeployResult = {
	readonly deployId: string;
	readonly stationUrl: string;
	readonly claimUrl: string;
	/** Native control-plane deadline, never a local one-hour approximation. */
	readonly expiresAt: string;
};

export type LakebedAnonymousTransport = {
	deployAnonymous(input: {
		readonly stationId: string;
		readonly capsuleDir: string;
		readonly signal?: AbortSignal;
	}): Promise<LakebedAnonymousDeployResult>;
};

export type LakebedTemporaryStationInput = {
	readonly stationId: string;
	readonly transport?: LakebedAnonymousTransport;
	/** When set, deploy this capsule directory instead of a scaffold. */
	readonly capsuleDir?: string;
	/** Override capsule server source for the scaffold. */
	readonly capsuleServerSource?: string;
	readonly signal?: AbortSignal;
	readonly clock?: () => number;
};

const DEFAULT_CAPSULE_SERVER = `import { capsule, endpoint, json } from "lakebed/server";

export default capsule({
  schema: {},
  queries: {},
  mutations: {},
  endpoints: {
    health: endpoint({ method: "GET", path: "/health" }, () => json({ ok: true, provider: "lakebed", hobo: "environment-station" })),
  },
});
`;

/**
 * Parse `npx lakebed deploy` stdout for deploy URL / claim material.
 * Accepts JSON lines or plain URL lines — fail closed if neither present.
 */
export function parseLakebedDeployOutput(
	stdout: string,
): LakebedAnonymousDeployResult {
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error("lakebed deploy produced empty output");
	}

	// The pinned CLI emits pretty-printed JSON. Parse the whole document before
	// considering JSON-lines diagnostics, which may contain other API URLs.
	for (const line of [trimmed, ...trimmed.split(/\r?\n/u)]) {
		const candidate = line.trim();
		if (!candidate.startsWith("{")) continue;
		const parsed = parseJsonObject(candidate);
		const stationUrl = firstJsonString(
			parsed.url,
			parsed.deployUrl,
			parsed.primaryUrl,
		);
		const deployId = firstJsonString(parsed.deployId, parsed.id);
		const claimUrl = firstJsonString(parsed.claimUrl);
		if (stationUrl && claimUrl && deployId) {
			requireLakebedUrl(stationUrl, "station");
			requireLakebedUrl(claimUrl, "claim");
			if (
				!new URL(claimUrl).pathname.startsWith(
					`/claim/${encodeURIComponent(deployId)}/`,
				) &&
				new URL(claimUrl).pathname !== `/claim/${encodeURIComponent(deployId)}`
			)
				throw new Error("lakebed claim URL names another deployment");
			const expiresAt = firstJsonString(parsed.expiresAt);
			if (!expiresAt || !Number.isFinite(Date.parse(expiresAt)))
				throw new Error(
					"lakebed anonymous deployment lacks a provider-reported expiry",
				);
			return {
				deployId,
				stationUrl,
				claimUrl,
				expiresAt: new Date(expiresAt).toISOString(),
			};
		}
	}

	throw new Error(
		"lakebed deploy output lacks an explicit deployment id, URL and provider-issued claim URL; outcome remains uncertain",
	);
}

async function runLakebedCliDeploy(
	capsuleDir: string,
	signal?: AbortSignal,
	captureOutput?: (result: {
		readonly stdout: string;
		readonly stderr: string;
		readonly exitCode: number | null;
	}) => Promise<void>,
): Promise<LakebedAnonymousDeployResult> {
	// Anonymous means neither ambient tokens nor an existing CLI login can be
	// used. Isolate only the child; never mutate the host's global environment.
	const cliHome = await mkdtemp(path.join(tmpdir(), "hobo-lakebed-anonymous-"));
	const env: Record<string, string> = {};
	for (const key of [
		"PATH",
		"HTTPS_PROXY",
		"HTTP_PROXY",
		"ALL_PROXY",
		"NO_PROXY",
		"https_proxy",
		"http_proxy",
		"all_proxy",
		"no_proxy",
		"NODE_EXTRA_CA_CERTS",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_USE_ENV_PROXY",
		"npm_config_cache",
		"TMPDIR",
		"SystemRoot",
		"COMSPEC",
	]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.HOME = cliHome;
	env.USERPROFILE = cliHome;
	env.XDG_CONFIG_HOME = path.join(cliHome, "config");
	env.XDG_DATA_HOME = path.join(cliHome, "data");

	const stdout = await new Promise<string>((resolve, reject) => {
		const child = spawn(
			"npx",
			["--yes", `lakebed@${LAKEBED_CLI_VERSION}`, "deploy", "--json"],
			{
				cwd: capsuleDir,
				env,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				signal:
					signal === undefined
						? AbortSignal.timeout(120_000)
						: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
			},
		);
		let out = "";
		let err = "";
		const kill = () => {
			if (process.platform !== "win32" && child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			} else child.kill("SIGKILL");
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
			if (Buffer.byteLength(out, "utf8") > 1024 * 1024) {
				kill();
				reject(
					new Error(
						"lakebed deploy exceeded its output bound; remote outcome remains unknown",
					),
				);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
			if (Buffer.byteLength(err, "utf8") > 1024 * 1024) {
				kill();
				reject(
					new Error(
						"lakebed deploy exceeded its diagnostic bound; remote outcome remains unknown",
					),
				);
			}
		});
		child.on("error", (error) => {
			kill();
			reject(
				new Error(
					`lakebed CLI failed to start (anonymous deploy): ${error.message}`,
				),
			);
		});
		child.on("close", (code) => {
			async function finish() {
				await captureOutput?.({ stdout: out, stderr: err, exitCode: code });
				if (code !== 0)
					throw new Error(
						`lakebed deploy exited ${code}; no successful provider outcome was confirmed`,
					);
				resolve(out || err);
			}
			void finish().catch(reject);
		});
	}).finally(() => rm(cliHome, { recursive: true, force: true }));

	return parseLakebedDeployOutput(stdout);
}

/** Give the CLI an owned source snapshot so caller-side ownership metadata
 * cannot redirect an anonymous creation into an update of a claimed project. */
async function snapshotAnonymousCapsule(source: string): Promise<string> {
	const target = await mkdtemp(
		path.join(tmpdir(), "hobo-lakebed-anonymous-source-"),
	);
	let entries = 0,
		bytes = 0;
	const excluded = new Set([
		".git",
		"node_modules",
		".npmrc",
		".yarnrc",
		".yarnrc.yml",
		".pnpmfile.cjs",
	]);
	async function copy(
		directory: string,
		destination: string,
		depth: number,
	): Promise<void> {
		if (depth > 12)
			throw new Error("anonymous capsule exceeds its source depth bound");
		for await (const entry of await opendir(directory)) {
			entries += 1;
			if (entries > 1000)
				throw new Error("anonymous capsule exceeds its source entry bound");
			if (
				depth === 0 &&
				(entry.name === ".lakebed" || entry.name === "lakebed.json")
			)
				throw new Error(
					"anonymous Lakebed deployment refuses existing ownership metadata",
				);
			if (
				excluded.has(entry.name) ||
				entry.name === ".env" ||
				entry.name.startsWith(".env.")
			)
				continue;
			const from = path.join(directory, entry.name),
				to = path.join(destination, entry.name);
			const metadata = await lstat(from);
			if (metadata.isSymbolicLink())
				throw new Error("anonymous capsule source may not contain symlinks");
			if (metadata.isDirectory()) {
				await mkdir(to, { mode: 0o700 });
				await copy(from, to, depth + 1);
			} else if (metadata.isFile()) {
				if (
					bytes + metadata.size > 8 * 1024 * 1024 ||
					metadata.size > 2 * 1024 * 1024
				)
					throw new Error("anonymous capsule exceeds its source size bound");
				const file = await open(
					from,
					fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
				);
				try {
					if (!(await file.stat()).isFile())
						throw new Error("anonymous capsule source changed file type");
					const chunks: Uint8Array[] = [];
					let fileBytes = 0;
					let complete = false;
					for (let read = 0; read < 33; read++) {
						const buffer = Buffer.alloc(64 * 1024);
						const { bytesRead } = await file.read(
							buffer,
							0,
							buffer.length,
							null,
						);
						if (bytesRead === 0) {
							complete = true;
							break;
						}
						fileBytes += bytesRead;
						if (
							fileBytes > 2 * 1024 * 1024 ||
							bytes + fileBytes > 8 * 1024 * 1024
						)
							throw new Error(
								"anonymous capsule grew past its source size bound",
							);
						chunks.push(buffer.subarray(0, bytesRead));
					}
					if (!complete)
						throw new Error("anonymous capsule exceeds its source read bound");
					await writeFile(to, Buffer.concat(chunks), {
						mode: 0o600,
						flag: "wx",
					});
					bytes += fileBytes;
				} finally {
					await file.close();
				}
			} else
				throw new Error(
					"anonymous capsule source must contain regular files and directories",
				);
		}
	}
	try {
		await copy(source, target, 0);
		return target;
	} catch (error) {
		await rm(target, { recursive: true, force: true });
		throw error;
	}
}

export function createLakebedAnonymousCliTransport(
	options: {
		readonly captureOutput?: (result: {
			readonly stdout: string;
			readonly stderr: string;
			readonly exitCode: number | null;
		}) => Promise<void>;
	} = {},
): LakebedAnonymousTransport {
	return {
		async deployAnonymous({ capsuleDir, signal }) {
			const owned = await snapshotAnonymousCapsule(capsuleDir);
			try {
				const result = await runLakebedCliDeploy(
					owned,
					signal,
					options.captureOutput,
				);
				await rm(owned, { recursive: true, force: true });
				return result;
			} catch (cause) {
				// Native claim metadata may be the only recovery evidence after a
				// lost or changed CLI response. Keep it private rather than deleting it.
				throw new Error(
					`Lakebed anonymous outcome is unconfirmed; private CLI recovery state retained at ${owned}`,
					{ cause },
				);
			}
		},
	};
}

export async function materializeEnvironmentStationCapsule(input: {
	readonly stationId: string;
	readonly serverSource?: string;
	readonly rootDir?: string;
}): Promise<string> {
	const root =
		input.rootDir ??
		(await mkdtemp(path.join(tmpdir(), "hobo-lakebed-station-")));
	const serverDir = path.join(root, "server");
	await mkdir(serverDir, { recursive: true });
	const clientDir = path.join(root, "client");
	await mkdir(clientDir, { recursive: true });
	await writeFile(
		path.join(clientDir, "index.tsx"),
		"export function App() { return <main>HoBo environment station</main>; }\n",
		"utf8",
	);
	await writeFile(
		path.join(serverDir, "index.ts"),
		input.serverSource ?? DEFAULT_CAPSULE_SERVER,
		"utf8",
	);
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify(
			{
				name: `hobo-env-station-${input.stationId}`.slice(0, 64),
				private: true,
				type: "module",
			},
			null,
			2,
		),
		"utf8",
	);
	return root;
}

/**
 * Provision an anonymous Lakebed Environment Station — no LAKEBED_TOKEN.
 */
export async function provisionTemporaryEnvironmentStation(
	input: LakebedTemporaryStationInput,
): Promise<TemporaryEnvironmentStationResult> {
	const capsuleDir =
		input.capsuleDir ??
		(await materializeEnvironmentStationCapsule({
			stationId: input.stationId,
			...(input.capsuleServerSource
				? { serverSource: input.capsuleServerSource }
				: undefined),
		}));
	const transport = input.transport ?? createLakebedAnonymousCliTransport();
	const deployed = await transport.deployAnonymous({
		stationId: input.stationId,
		capsuleDir,
		...(input.signal === undefined ? undefined : { signal: input.signal }),
	});

	const expiresAt = deployed.expiresAt;
	const ttlSeconds = Math.max(
		0,
		Math.floor((Date.parse(expiresAt) - (input.clock ?? Date.now)()) / 1000),
	);
	return {
		stationId: input.stationId,
		stationUrl: deployed.stationUrl,
		primaryUrl: deployed.stationUrl,
		claimUrl: deployed.claimUrl,
		expiresAt,
		ttlSeconds,
		providerId: LAKEBED_TEMPORARY_PROVIDER_ID,
		accountId: deployed.deployId,
		anonymous: true,
		temporary: true,
	};
}
