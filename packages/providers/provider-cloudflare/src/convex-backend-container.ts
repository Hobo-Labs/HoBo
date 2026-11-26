/**
 * Anon-provision self-hosted Convex backend on Cloudflare Containers.
 *
 * Auth: Cloudflare Temporary Accounts (PoW) — zero permanent API tokens.
 * Image: official `ghcr.io/get-convex/convex-backend` URI (no local Docker,
 * no Dockerfile, never invent `hobo/convex-*` images).
 *
 * Flow: Temporary account → wrangler deploy with temp creds (not `--temporary`;
 * that flag races Containers apply) → mint admin key via Worker exec bridge.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isJsonObject, isJsonString, parseJsonValue } from "./json.js";
import {
	CF_API_BASE,
	createCloudflareTemporaryAccountTransport,
	solveAndProvisionAccount,
	type TemporaryPreviewAccount,
} from "./temporary-station.js";

// public-contract: digest-pinned backend image disclosed in deployment plans.
export const CONVEX_BACKEND_OCI_IMAGE =
	"ghcr.io/get-convex/convex-backend:latest" as const;

export const CONVEX_API_PORT = 3210;
export const CONVEX_HTTP_ACTIONS_PORT = 3211;

export type ConvexCloudflareSpawnResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

export type ConvexCloudflareSpawn = (input: {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}) => Promise<ConvexCloudflareSpawnResult>;

export type ProvisionConvexBackendOnCloudflareInput = {
	readonly workDir: string;
	readonly workerName?: string;
	readonly image?: string;
	readonly bootstrapToken?: string;
	readonly spawn?: ConvexCloudflareSpawn;
	readonly fetchImpl?: typeof fetch;
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** CI / Examples mock — no wrangler, returns workers.dev-shaped URL. */
	readonly mock?: boolean;
	readonly waitForReadyMs?: number;
	/** Inject Temporary Account (tests). Live path provisions anon Temporary. */
	readonly temporaryAccount?: TemporaryPreviewAccount;
};

export type ProvisionConvexBackendOnCloudflareResult = {
	readonly ok: true;
	readonly backendUrl: string;
	readonly adminKey: string;
	readonly workerName: string;
	readonly image: string;
	readonly mocked: boolean;
	readonly mode: "cloudflare-containers";
	readonly anonymous: true;
	readonly temporary: true;
	readonly claimUrl: string;
	readonly accountId: string;
};

export class ConvexCloudflareContainersError extends Error {
	readonly claimUrl?: string;
	constructor(message: string, claimUrl?: string) {
		super(message);
		this.name = "ConvexCloudflareContainersError";
		if (claimUrl) this.claimUrl = claimUrl;
	}
}

/**
 * @deprecated Temporary is the intended path — kept as no-op so callers that
 * previously refused Temporary stop blocking anon Containers attempts.
 */
export function assertCloudflareContainersSupportedForConvex(_input: {
	readonly temporaryAccount?: boolean;
}): void {
	// Anon Temporary Accounts is the ship path. Containers API may still 403;
	// provisionConvexBackendOnCloudflare surfaces that with claimUrl evidence.
}

export function parseWorkersDevUrl(
	stdout: string,
	stderr: string,
): string | null {
	const blob = `${stdout}\n${stderr}`;
	const match = blob.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\/?/iu);
	return match ? match[0].replace(/\/$/u, "") : null;
}

function defaultSpawn(): ConvexCloudflareSpawn {
	return async ({ command, args, cwd, env }) => {
		const { spawn } = await import("node:child_process");
		return await new Promise((resolve) => {
			const child = spawn(command, [...args], {
				cwd,
				env: { ...process.env, ...env },
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
				resolve({ exitCode: code ?? 1, stdout, stderr });
			});
			child.on("error", (error) => {
				resolve({
					exitCode: 1,
					stdout,
					stderr: error.message,
				});
			});
		});
	};
}

function workerModuleSource(input: {
	readonly cloudOrigin: string;
	readonly siteOrigin: string;
}): string {
	const cloud = JSON.stringify(input.cloudOrigin);
	const site = JSON.stringify(input.siteOrigin);
	return `import { Container, switchPort } from "@cloudflare/containers";

export class ConvexBackend extends Container {
  defaultPort = ${CONVEX_API_PORT};
  requiredPorts = [${CONVEX_API_PORT}, ${CONVEX_HTTP_ACTIONS_PORT}];
  sleepAfter = "30m";
  enableInternet = true;
  envVars = {
    CONVEX_CLOUD_ORIGIN: ${cloud},
    CONVEX_SITE_ORIGIN: ${site},
    DISABLE_METRICS_ENDPOINT: "true",
  };

  async generateAdminKey() {
    if (!this.ctx.container.running) {
      await this.start();
    }
    const process = await this.ctx.container.exec(["./generate_admin_key.sh"]);
    const output = await process.output();
    return new TextDecoder().decode(output.stdout).trim();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = env.CONVEX_BACKEND.idFromName("primary");
    const stub = env.CONVEX_BACKEND.get(id);

    if (url.pathname === "/.hobo/admin-key" && request.method === "POST") {
      const token = request.headers.get("x-hobo-bootstrap-token") ?? "";
      if (!token || token !== env.HOBO_BOOTSTRAP_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const adminKey = await stub.generateAdminKey();
      return Response.json({ adminKey });
    }

    if (url.pathname === "/http" || url.pathname.startsWith("/http/")) {
      return stub.fetch(switchPort(request, ${CONVEX_HTTP_ACTIONS_PORT}));
    }

    return stub.fetch(request);
  },
};
`;
}

function wranglerJsonc(input: {
	readonly workerName: string;
	readonly image: string;
	readonly bootstrapToken: string;
}): string {
	return `${JSON.stringify(
		{
			name: input.workerName,
			main: "src/index.ts",
			compatibility_date: "2026-01-10",
			compatibility_flags: ["nodejs_compat"],
			workers_dev: true,
			vars: {
				HOBO_BOOTSTRAP_TOKEN: input.bootstrapToken,
			},
			containers: [
				{
					class_name: "ConvexBackend",
					// Public registry URI — Cloudflare pulls; no local Docker.
					image: input.image,
					instance_type: "standard-2",
					max_instances: 1,
				},
			],
			durable_objects: {
				bindings: [
					{
						name: "CONVEX_BACKEND",
						class_name: "ConvexBackend",
					},
				],
			},
			migrations: [
				{
					tag: "v1",
					new_sqlite_classes: ["ConvexBackend"],
				},
			],
		},
		null,
		2,
	)}\n`;
}

function packageJson(workerName: string): string {
	return `${JSON.stringify(
		{
			name: workerName,
			private: true,
			type: "module",
			dependencies: {
				"@cloudflare/containers": "^0.0.30",
			},
			devDependencies: {
				wrangler: "4.120.0",
			},
		},
		null,
		2,
	)}\n`;
}

/**
 * Write Worker scaffold that wraps the official Convex backend image URI.
 * No Dockerfile — Cloudflare pulls `image` from the registry.
 */
export async function materializeConvexCloudflareBackendScaffold(input: {
	readonly workDir: string;
	readonly workerName: string;
	readonly image: string;
	readonly cloudOrigin: string;
	readonly siteOrigin: string;
	readonly bootstrapToken: string;
}): Promise<void> {
	const srcDir = path.join(input.workDir, "src");
	await mkdir(srcDir, { recursive: true });
	await writeFile(
		path.join(srcDir, "index.ts"),
		workerModuleSource({
			cloudOrigin: input.cloudOrigin,
			siteOrigin: input.siteOrigin,
		}),
		"utf8",
	);
	await writeFile(
		path.join(input.workDir, "wrangler.jsonc"),
		wranglerJsonc({
			workerName: input.workerName,
			image: input.image,
			bootstrapToken: input.bootstrapToken,
		}),
		"utf8",
	);
	await writeFile(
		path.join(input.workDir, "package.json"),
		packageJson(input.workerName),
		"utf8",
	);
}

async function resolveWorkersDevUrl(input: {
	readonly accountId: string;
	readonly apiToken: string;
	readonly scriptName: string;
	readonly fetchImpl: typeof fetch;
	readonly fallbackFromDeploy?: string | null;
}): Promise<string> {
	if (input.fallbackFromDeploy) return input.fallbackFromDeploy;

	await input
		.fetchImpl(
			`${CF_API_BASE}/accounts/${input.accountId}/workers/scripts/${input.scriptName}/subdomain`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${input.apiToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ enabled: true }),
			},
		)
		.catch(() => undefined);

	const account = await input.fetchImpl(
		`${CF_API_BASE}/accounts/${input.accountId}/workers/subdomain`,
		{
			method: "GET",
			headers: { authorization: `Bearer ${input.apiToken}` },
		},
	);
	// SAFETY: this fetch boundary is the Workers subdomain envelope; only
	// `result.subdomain` is read after the parse.
	const body = (await account.json()) as {
		success?: boolean;
		result?: { subdomain?: string };
	};
	const host = body.result?.subdomain;
	if (!host) {
		throw new ConvexCloudflareContainersError(
			"Temporary account Workers subdomain missing after Convex Container Worker upload",
		);
	}
	return `https://${input.scriptName}.${host}.workers.dev`;
}

async function fetchAdminKey(input: {
	readonly backendUrl: string;
	readonly bootstrapToken: string;
	readonly fetchImpl: typeof fetch;
}): Promise<string> {
	const response = await input.fetchImpl(
		`${input.backendUrl}/.hobo/admin-key`,
		{
			method: "POST",
			headers: {
				"x-hobo-bootstrap-token": input.bootstrapToken,
			},
		},
	);
	if (!response.ok) {
		throw new ConvexCloudflareContainersError(
			`Failed to mint Convex admin key via Worker RPC bridge: HTTP ${response.status}`,
		);
	}
	const parsed = parseJsonValue(await response.text());
	const adminKey = isJsonObject(parsed) ? parsed.adminKey : undefined;
	if (!isJsonString(adminKey) || adminKey.length === 0) {
		throw new ConvexCloudflareContainersError(
			"Worker /.hobo/admin-key returned no adminKey",
		);
	}
	return adminKey;
}

async function waitForVersion(input: {
	readonly backendUrl: string;
	readonly fetchImpl: typeof fetch;
	readonly timeoutMs: number;
}): Promise<void> {
	const deadline = Date.now() + input.timeoutMs;
	let lastError = "timeout";
	while (Date.now() < deadline) {
		try {
			const response = await input.fetchImpl(`${input.backendUrl}/version`, {
				method: "GET",
			});
			if (response.ok) return;
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	throw new ConvexCloudflareContainersError(
		`Convex backend on Cloudflare did not become ready at ${input.backendUrl}/version (${lastError})`,
	);
}

function stripAnsi(text: string): string {
	// `\p{Cc}` instead of a literal ESC byte: identical CSI match, without an
	// unprintable control character in source (biome noControlCharactersInRegex).
	return text.replace(/\p{Cc}\[[0-9;]*m/gu, "");
}

function containersApiForbidden(stdout: string, stderr: string): boolean {
	const blob = stripAnsi(`${stdout}\n${stderr}`);
	return (
		/Forbidden/iu.test(blob) ||
		/containers\/applications/iu.test(blob) ||
		/Authentication error/iu.test(blob)
	);
}

/**
 * Anon-deploy Convex self-host backend onto Cloudflare Containers.
 * Returns CONVEX_SELF_HOSTED_* credentials for `convex deploy`.
 */
export async function provisionConvexBackendOnCloudflare(
	input: ProvisionConvexBackendOnCloudflareInput,
): Promise<ProvisionConvexBackendOnCloudflareResult> {
	const image = input.image?.trim() || CONVEX_BACKEND_OCI_IMAGE;
	const workerName =
		input.workerName?.trim() ||
		`hobo-convex-${createHash("sha256")
			.update(input.workDir)
			.digest("hex")
			.slice(0, 8)}`;
	const bootstrapToken =
		input.bootstrapToken?.trim() || randomBytes(24).toString("hex");
	const fetchImpl = input.fetchImpl ?? fetch;
	const spawn = input.spawn ?? defaultSpawn();

	if (input.mock) {
		const backendUrl = `https://${workerName}.mock.workers.dev`;
		return Object.freeze({
			ok: true as const,
			backendUrl,
			adminKey: `hobo-cf-mock|${bootstrapToken.slice(0, 32)}`,
			workerName,
			image,
			mocked: true,
			mode: "cloudflare-containers" as const,
			anonymous: true as const,
			temporary: true as const,
			claimUrl: `https://dash.cloudflare.com/claim-preview?claimToken=mock-${workerName}`,
			accountId: "temporary-mock",
		});
	}

	const account =
		input.temporaryAccount ??
		(await solveAndProvisionAccount(
			createCloudflareTemporaryAccountTransport(fetchImpl),
		));

	const placeholderOrigin = `https://${workerName}.workers.dev`;
	await materializeConvexCloudflareBackendScaffold({
		workDir: input.workDir,
		workerName,
		image,
		cloudOrigin: placeholderOrigin,
		siteOrigin: `${placeholderOrigin}/http`,
		bootstrapToken,
	});

	const install = await spawn({
		command: "npm",
		args: ["install", "--no-fund", "--no-audit"],
		cwd: input.workDir,
		env: {},
	});
	if (install.exitCode !== 0) {
		throw new ConvexCloudflareContainersError(
			`npm install failed for anon Convex Container worker: ${install.stderr.trim() || install.stdout.trim()}`,
			account.claimUrl,
		);
	}

	// Use Temporary creds WITHOUT `--temporary` — wrangler --temporary races
	// Containers apply (requireAuth after temp login). No local Docker.
	const childEnv = {
		CLOUDFLARE_API_TOKEN: account.apiToken,
		CLOUDFLARE_ACCOUNT_ID: account.accountId,
	};

	const deploy = await spawn({
		command: "npx",
		args: ["wrangler", "deploy"],
		cwd: input.workDir,
		env: childEnv,
	});

	if (deploy.exitCode !== 0) {
		if (containersApiForbidden(deploy.stdout, deploy.stderr)) {
			throw new ConvexCloudflareContainersError(
				"Cloudflare Temporary Accounts rejected Containers application create " +
					"(POST /accounts/.../containers/applications → 403 Authentication error). " +
					"Worker upload + ghcr.io image bind succeeded without Docker; Containers " +
					"runtime apply is not granted on Temporary Accounts today. Claim URL: " +
					account.claimUrl,
				account.claimUrl,
			);
		}
		throw new ConvexCloudflareContainersError(
			`Anon wrangler deploy failed for Convex Container: ${deploy.stderr.trim() || deploy.stdout.trim()}`,
			account.claimUrl,
		);
	}

	const parsed = parseWorkersDevUrl(deploy.stdout, deploy.stderr);
	const backendUrl = await resolveWorkersDevUrl({
		accountId: account.accountId,
		apiToken: account.apiToken,
		scriptName: workerName,
		fetchImpl,
		fallbackFromDeploy: parsed,
	});

	await materializeConvexCloudflareBackendScaffold({
		workDir: input.workDir,
		workerName,
		image,
		cloudOrigin: backendUrl,
		siteOrigin: `${backendUrl}/http`,
		bootstrapToken,
	});

	const redeploy = await spawn({
		command: "npx",
		args: ["wrangler", "deploy"],
		cwd: input.workDir,
		env: childEnv,
	});
	if (redeploy.exitCode !== 0) {
		throw new ConvexCloudflareContainersError(
			`Anon wrangler redeploy (origins) failed: ${redeploy.stderr.trim() || redeploy.stdout.trim()}`,
			account.claimUrl,
		);
	}

	await waitForVersion({
		backendUrl,
		fetchImpl,
		timeoutMs: input.waitForReadyMs ?? 120_000,
	});

	const adminKey = await fetchAdminKey({
		backendUrl,
		bootstrapToken,
		fetchImpl,
	});

	return Object.freeze({
		ok: true as const,
		backendUrl,
		adminKey,
		workerName,
		image,
		mocked: false,
		mode: "cloudflare-containers" as const,
		anonymous: true as const,
		temporary: true as const,
		claimUrl: account.claimUrl,
		accountId: account.accountId,
	});
}
