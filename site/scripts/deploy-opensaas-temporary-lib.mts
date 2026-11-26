/**
 * Full Temporary OpenSaaS ship (anon, zero project API keys):
 * 1) Neon Claimable Postgres (Bindle `db`)
 * 2) Anon server host chain: OpenPouch HTTP → Clawdship Docker → CF Temporary Neon shim
 * 3) Cloudflare Temporary Pages client (REACT_APP_API_URL → server)
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseWranglerTemporaryOutput } from "../../packages/providers/provider-cloudflare/src/wrangler-temporary.ts";
import { resolveWaspRoot } from "@hobo/wasp";
import {
	provisionAnonOpenSaasServer,
	type AnonServerHostMode,
} from "./anon-server-host-chain.mts";
import { provisionNeonClaimablePostgres } from "./neon-claimable-postgres.mts";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

export type OpenSaasTemporaryDeployResult = {
	readonly ok: true;
	readonly clientUrl: string;
	readonly serverUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly exampleId: "opensaas";
	readonly waspAbsRoot: string;
	readonly databaseUrl: string;
	readonly databaseClaimUrl: string;
	readonly databaseMode: "neon-claimable";
	readonly databaseMocked: boolean;
	readonly serverMode: AnonServerHostMode;
	readonly serverMocked: boolean;
	readonly serverFallbackFrom?: string;
};

function run(
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
		child.on("error", (error) => {
			resolve({ code: 1, stdout, stderr: error.message });
		});
	});
}

async function ensureClientBuild(
	waspAbsRoot: string,
	env: NodeJS.ProcessEnv,
	force: boolean,
): Promise<void> {
	const clientBuild = path.join(
		waspAbsRoot,
		".wasp/out/web-app/build/index.html",
	);
	if (!force) {
		try {
			await access(clientBuild);
			return;
		} catch {
			/* build missing */
		}
	}

	const waspOk = (await run("wasp", ["version"], waspAbsRoot, env)).code === 0;
	if (!waspOk) {
		throw new Error(
			"wasp CLI not found. Install: npm i -g @wasp.sh/wasp-cli@^0.25",
		);
	}

	const buildEnv = {
		...env,
		DATABASE_URL:
			env.DATABASE_URL ?? "postgresql://user:pass@127.0.0.1:5432/opensaas",
		SMTP_HOST: env.SMTP_HOST ?? "127.0.0.1",
		SMTP_PORT: env.SMTP_PORT ?? "1025",
		SMTP_USERNAME: env.SMTP_USERNAME ?? "x",
		SMTP_PASSWORD: env.SMTP_PASSWORD ?? "x",
	};
	const waspBuild = await run("wasp", ["build"], waspAbsRoot, buildEnv);
	if (waspBuild.code !== 0) {
		throw new Error(
			waspBuild.stderr.trim() ||
				waspBuild.stdout.trim() ||
				"wasp build failed for OpenSaaS",
		);
	}

	const vite = await run("npx", ["vite", "build"], waspAbsRoot, {
		...buildEnv,
		REACT_APP_API_URL: env.REACT_APP_API_URL ?? "https://example.com",
	});
	if (vite.code !== 0) {
		throw new Error(
			vite.stderr.trim() || vite.stdout.trim() || "vite build failed for OpenSaaS",
		);
	}
	await access(clientBuild);
}

/**
 * Full anon Temporary OpenSaaS: Neon db + anon server chain + CF Temporary client.
 */
export async function deployOpenSaasTemporaryClient(input: {
	readonly root: string;
	readonly wranglerBin?: string;
	readonly skipBuild?: boolean;
	readonly mockDatabase?: boolean;
	readonly mockServer?: boolean;
}): Promise<OpenSaasTemporaryDeployResult> {
	const waspAbsRoot = resolveWaspRoot(REPO_ROOT, input.root);
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	delete env.CLOUDFLARE_API_KEY;
	delete env.CF_API_TOKEN;
	delete env.CLOUDFLARE_ACCOUNT_ID;

	const mockDatabase =
		input.mockDatabase === true || env.HOBO_OPENSAAS_DB_MOCK === "1";
	const mockServer =
		input.mockServer === true || env.HOBO_OPENSAAS_SERVER_MOCK === "1";

	const database = await provisionNeonClaimablePostgres({
		ref: "hobo-opensaas",
		mock: mockDatabase,
	});
	env.DATABASE_URL = database.databaseUrl;

	// Placeholder client URL for server boot (dev CORS is open).
	const placeholderClient = "https://hobo-opensaas-client.workers.dev";
	const server = await provisionAnonOpenSaasServer({
		waspAbsRoot,
		databaseUrl: database.databaseUrl,
		webClientUrl: placeholderClient,
		mock: mockServer,
	});
	// #region agent log
	fetch("http://127.0.0.1:7655/ingest/eac23247-0462-43c4-8e6e-14b2a6cecba6", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Debug-Session-Id": "2dc295",
		},
		body: JSON.stringify({
			sessionId: "2dc295",
			runId: process.env.HOBO_DEBUG_RUN_ID ?? "pre-fix",
			hypothesisId: "E",
			location: "deploy-opensaas-temporary-lib.mts:server",
			message: "anon server provisioned for OpenSaaS Temporary",
			data: {
				mode: server.mode,
				mocked: server.mocked,
				fallbackFrom:
					"fallbackFrom" in server ? server.fallbackFrom ?? null : null,
				host: (() => {
					try {
						return new URL(server.serverUrl).hostname;
					} catch {
						return "invalid";
					}
				})(),
			},
			timestamp: Date.now(),
		}),
	}).catch(() => {});
	// #endregion
	env.REACT_APP_API_URL = server.serverUrl;
	env.WASP_SERVER_URL = server.serverUrl;
	env.WASP_WEB_CLIENT_URL = placeholderClient;

	const forceClientRebuild = !mockServer;
	if (!input.skipBuild || forceClientRebuild) {
		await ensureClientBuild(waspAbsRoot, env, forceClientRebuild);
	} else {
		await access(
			path.join(waspAbsRoot, ".wasp/out/web-app/build/index.html"),
		);
	}

	const bin = input.wranglerBin ?? "npx";
	const args =
		bin === "npx"
			? ["--yes", "wrangler@4.102.0", "deploy", "--temporary"]
			: ["deploy", "--temporary"];
	const result = await run(bin, args, waspAbsRoot, env);
	if (result.code !== 0) {
		throw new Error(
			result.stderr.trim() ||
				result.stdout.trim() ||
				"wrangler deploy --temporary failed for OpenSaaS",
		);
	}
	const parsed = parseWranglerTemporaryOutput(result.stdout, result.stderr);

	return {
		ok: true,
		clientUrl: parsed.stationUrl,
		serverUrl: server.serverUrl,
		claimUrl: parsed.claimUrl,
		expiresAt: database.expiresAt,
		anonymous: true,
		temporary: true,
		exampleId: "opensaas",
		waspAbsRoot,
		databaseUrl: database.databaseUrl,
		databaseClaimUrl: database.claimUrl,
		databaseMode: "neon-claimable",
		databaseMocked: database.mocked,
		serverMode: server.mode,
		serverMocked: server.mocked,
		serverFallbackFrom:
			"fallbackFrom" in server ? server.fallbackFrom : undefined,
	};
}
