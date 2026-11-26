/**
 * Anonymous Cloudflare Temporary Worker + Neon DATABASE_URL.
 *
 * Fallback when OpenPouch anon is rate-limited or unavailable.
 * Zero project API keys: `wrangler deploy --temporary` + `--secrets-file`.
 *
 * This is a Neon-backed HTTP shim (`/health`, `/db/ping`) — not a full Wasp
 * Express process (Workers cannot run that stack).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseWranglerTemporaryOutput } from "../../packages/providers/provider-cloudflare/src/wrangler-temporary.ts";

export type CloudflareTempNeonServerResult = {
	readonly ok: true;
	readonly serverUrl: string;
	readonly claimUrl?: string;
	readonly expiresAt?: string;
	readonly authenticated: false;
	readonly ownership: "anonymous";
	readonly mode: "cloudflare-temp-neon";
	readonly mocked: boolean;
	readonly realizes: "neon-http-shim";
};

export class CloudflareTempNeonServerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CloudflareTempNeonServerError";
	}
}

export type ProvisionCloudflareTempNeonServerInput = {
	readonly databaseUrl: string;
	readonly mock?: boolean;
	readonly wranglerBin?: string;
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
		child.stdout.on("data", (c) => {
			stdout += String(c);
		});
		child.stderr.on("data", (c) => {
			stderr += String(c);
		});
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
		child.on("error", (error) =>
			resolve({ code: 1, stdout: "", stderr: error.message }),
		);
	});
}

async function stageWorker(): Promise<string> {
	const staging = await mkdtemp(path.join(tmpdir(), "hobo-opensaas-cf-"));
	await mkdir(path.join(staging, "src"), { recursive: true });
	await writeFile(
		path.join(staging, "package.json"),
		`${JSON.stringify(
			{
				name: "hobo-opensaas-api",
				private: true,
				type: "module",
				dependencies: { "@neondatabase/serverless": "^0.10.4" },
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(
		path.join(staging, "wrangler.toml"),
		`name = "hobo-opensaas-api"
main = "src/worker.js"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]
`,
	);
	await writeFile(
		path.join(staging, "src/worker.js"),
		`import { neon } from "@neondatabase/serverless";
export default {
  async fetch(request, env) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json(
        { ok: true, mode: "cloudflare-temp-neon", anonymous: true, hasDb: Boolean(env.DATABASE_URL) },
        { headers: cors },
      );
    }
    if (url.pathname === "/db/ping") {
      if (!env.DATABASE_URL) {
        return Response.json({ ok: false, error: "no DATABASE_URL" }, { status: 500, headers: cors });
      }
      try {
        const sql = neon(env.DATABASE_URL);
        const rows = await sql\`select 1::int as ok\`;
        return Response.json({ ok: true, rows }, { headers: cors });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
      }
    }
    return Response.json({ ok: false, error: "not found" }, { status: 404, headers: cors });
  },
};
`,
	);
	return staging;
}

export async function provisionCloudflareTempNeonServer(
	input: ProvisionCloudflareTempNeonServerInput,
): Promise<CloudflareTempNeonServerResult> {
	if (input.mock) {
		const id = randomBytes(3).toString("hex");
		return {
			ok: true,
			serverUrl: `https://hobo-opensaas-api-${id}.workers.dev`,
			authenticated: false,
			ownership: "anonymous",
			mode: "cloudflare-temp-neon",
			mocked: true,
			realizes: "neon-http-shim",
		};
	}

	if (!input.databaseUrl.trim()) {
		throw new CloudflareTempNeonServerError("DATABASE_URL required");
	}

	const staging = await stageWorker();
	const secretsFile = path.join(staging, "secrets.env");
	try {
		await writeFile(secretsFile, `DATABASE_URL=${input.databaseUrl}\n`);
		const npm = await run("npm", ["install", "--no-audit", "--no-fund"], staging, {
			...process.env,
		});
		if (npm.code !== 0) {
			throw new CloudflareTempNeonServerError(
				npm.stderr.trim() || npm.stdout.trim() || "npm install failed for CF Neon server",
			);
		}

		const bin = input.wranglerBin ?? "npx";
		const args =
			bin === "npx"
				? [
						"--yes",
						"wrangler@4.102.0",
						"deploy",
						"--temporary",
						"--secrets-file",
						secretsFile,
					]
				: ["deploy", "--temporary", "--secrets-file", secretsFile];

		const env = { ...process.env };
		delete env.CLOUDFLARE_API_TOKEN;
		delete env.CLOUDFLARE_API_KEY;
		delete env.CF_API_TOKEN;
		delete env.CLOUDFLARE_ACCOUNT_ID;

		const result = await run(bin, args, staging, env);
		if (result.code !== 0) {
			throw new CloudflareTempNeonServerError(
				result.stderr.trim() ||
					result.stdout.trim() ||
					"wrangler deploy --temporary failed for CF Neon server",
			);
		}
		const parsed = parseWranglerTemporaryOutput(result.stdout, result.stderr);
		return {
			ok: true,
			serverUrl: parsed.stationUrl,
			claimUrl: parsed.claimUrl,
			authenticated: false,
			ownership: "anonymous",
			mode: "cloudflare-temp-neon",
			mocked: false,
			realizes: "neon-http-shim",
		};
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}
