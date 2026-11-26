/**
 * Anonymous OpenPouch deploy for the Wasp OpenSaaS server bundle.
 * Default: HTTP Instant Lane (`POST /api/deployments`) — no CLI.
 * Opt-in CLI: `HOBO_OPENPOUCH_TRANSPORT=cli` → `npx openpouch deploy`.
 */
import {
	isJsonObject,
	isJsonString,
	parseJsonTree,
	type JsonObject,
	type JsonValue,
} from "../src/lib/json-inspect.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { provisionOpenpouchHttp } from "./anon-container-hosts/openpouch-http.mts";

function parseExpiresAt(value: JsonValue | undefined): string | undefined {
	if (!isJsonObject(value) || !isJsonString(value.expiresAt)) return undefined;
	return value.expiresAt;
}

export type OpenpouchAnonServerResult = {
	readonly ok: true;
	readonly serverUrl: string;
	readonly claimUrl?: string;
	readonly expiresAt?: string;
	readonly authenticated: false;
	readonly ownership: "anonymous";
	readonly mode: "openpouch-anon";
	readonly mocked: boolean;
};

export class OpenpouchAnonServerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpenpouchAnonServerError";
	}
}

export type ProvisionOpenpouchAnonServerInput = {
	readonly waspAbsRoot: string;
	readonly databaseUrl: string;
	readonly webClientUrl: string;
	readonly mock?: boolean;
	readonly openpouchBin?: string;
};

async function run(
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

/** Stage slim Wasp server bundle for anon hosts (OpenPouch / Clawdship). */
export async function stageOpenSaasAnonServerBundle(
	waspAbsRoot: string,
): Promise<string> {
	const out = path.join(waspAbsRoot, ".wasp/out");
	const bundleJs = path.join(out, "server/bundle/server.js");
	const schema = path.join(out, "db/schema.prisma");
	const authTgz = path.join(
		out,
		"libs/auth/wasp.sh-lib-auth-0.25.0.tgz",
	);
	for (const p of [bundleJs, schema, authTgz]) {
		try {
			await readFile(p);
		} catch {
			throw new OpenpouchAnonServerError(
				`Missing ${p} — run wasp build + server bundle first`,
			);
		}
	}

	const staging = await mkdtemp(path.join(tmpdir(), "hobo-opensaas-op-"));
	await mkdir(path.join(staging, "bundle"), { recursive: true });
	await cp(bundleJs, path.join(staging, "bundle/server.js"));
	await cp(schema, path.join(staging, "schema.prisma"));
	await cp(authTgz, path.join(staging, "wasp.sh-lib-auth-0.25.0.tgz"));

	const pkg = {
		name: "hobo-opensaas-anon-server",
		version: "1.0.0",
		private: true,
		type: "module",
		scripts: {
			postinstall: "prisma generate --schema=./schema.prisma",
			start: "node start.mjs",
		},
		dependencies: {
			express: "5.1.0",
			cors: "2.8.6",
			"cookie-parser": "1.4.7",
			helmet: "6.2.0",
			morgan: "1.10.1",
			dotenv: "16.6.1",
			superjson: "2.2.6",
			zod: "4.4.3",
			lucia: "3.2.2",
			"@lucia-auth/adapter-prisma": "4.0.1",
			"@prisma/client": "5.19.1",
			prisma: "5.19.1",
			"pg-boss": "8.4.2",
			nodemailer: "8.0.11",
			openai: "6.49.0",
			stripe: "18.1.0",
			"@aws-sdk/client-s3": "3.1098.0",
			"@aws-sdk/s3-presigned-post": "3.1098.0",
			"@aws-sdk/s3-request-presigner": "3.1098.0",
			"@wasp.sh/lib-auth": "file:./wasp.sh-lib-auth-0.25.0.tgz",
			react: "19.2.8",
			"react-router": "8.3.0",
		},
	};
	await writeFile(
		path.join(staging, "package.json"),
		`${JSON.stringify(pkg, null, 2)}\n`,
	);

	const startSrc = `import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.PORT = process.env.PORT || "8080";
process.env.JWT_SECRET = process.env.JWT_SECRET || ("hobo-temp-" + randomBytes(24).toString("hex"));
process.env.SMTP_HOST = process.env.SMTP_HOST || "127.0.0.1";
process.env.SMTP_PORT = process.env.SMTP_PORT || "1025";
process.env.SMTP_USERNAME = process.env.SMTP_USERNAME || "temp";
process.env.SMTP_PASSWORD = process.env.SMTP_PASSWORD || "temp";
process.env.SKIP_EMAIL_VERIFICATION_IN_DEV = process.env.SKIP_EMAIL_VERIFICATION_IN_DEV || "true";
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || "";
const placeholders = {
  STRIPE_API_KEY: "sk_test_hobo_temp",
  STRIPE_WEBHOOK_SECRET: "whsec_hobo_temp",
  LEMONSQUEEZY_API_KEY: "lemon_hobo_temp",
  LEMONSQUEEZY_WEBHOOK_SECRET: "lemon_whsec_hobo_temp",
  LEMONSQUEEZY_STORE_ID: "0",
  POLAR_ORGANIZATION_ACCESS_TOKEN: "polar_hobo_temp",
  POLAR_SANDBOX_MODE: "true",
  POLAR_WEBHOOK_SECRET: "polar_whsec_hobo_temp",
  PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID: "hobby_temp",
  PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID: "pro_temp",
  PAYMENTS_CREDITS_10_PLAN_ID: "credits_temp",
  OPENAI_API_KEY: "sk-hobo-temp",
  AWS_S3_REGION: "us-east-1",
  AWS_S3_IAM_ACCESS_KEY: "AKIATEMP",
  AWS_S3_IAM_SECRET_KEY: "tempsecret",
  AWS_S3_FILES_BUCKET: "hobo-temp",
  PLAUSIBLE_API_KEY: "plausible_temp",
  PLAUSIBLE_SITE_ID: "hobo.temp",
  PLAUSIBLE_BASE_URL: "https://plausible.io",
  GOOGLE_ANALYTICS_CLIENT_EMAIL: "temp@hobo.test",
  GOOGLE_ANALYTICS_PRIVATE_KEY: "temp",
  GOOGLE_ANALYTICS_PROPERTY_ID: "0",
};
for (const [k, v] of Object.entries(placeholders)) {
  if (!process.env[k]) process.env[k] = v;
}
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }
if (!process.env.WASP_SERVER_URL) process.env.WASP_SERVER_URL = "http://127.0.0.1:" + process.env.PORT;
if (!process.env.WASP_WEB_CLIENT_URL) process.env.WASP_WEB_CLIENT_URL = "http://127.0.0.1:3000";
console.log("[hobo] starting wasp server", { NODE_ENV: process.env.NODE_ENV, PORT: process.env.PORT });
function start() {
  import("./bundle/server.js").catch((err) => { console.error(err); process.exit(1); });
}
const migrate = spawn("npx", ["prisma", "migrate", "deploy", "--schema=./schema.prisma"], { stdio: "inherit", env: process.env });
migrate.on("exit", (code) => {
  if (code === 0) return start();
  const push = spawn("npx", ["prisma", "db", "push", "--schema=./schema.prisma", "--accept-data-loss"], { stdio: "inherit", env: process.env });
  push.on("exit", (c2) => { if (c2 !== 0) process.exit(c2 || 1); start(); });
});
`;
	await writeFile(path.join(staging, "start.mjs"), startSrc);
	return staging;
}

/** Dockerfile so Clawdship (and similar) can build the same slim server. */
export async function writeOpenSaasAnonDockerfile(
	stagingDir: string,
	port = 8080,
): Promise<void> {
	const dockerfile = `FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY wasp.sh-lib-auth-0.25.0.tgz ./
COPY schema.prisma ./
COPY start.mjs ./
COPY bundle ./bundle
RUN npm install --omit=dev
ENV PORT=${port}
ENV NODE_ENV=development
EXPOSE ${port}
CMD ["npm", "start"]
`;
	await writeFile(path.join(stagingDir, "Dockerfile"), dockerfile);
}

export async function provisionOpenpouchAnonServer(
	input: ProvisionOpenpouchAnonServerInput,
): Promise<OpenpouchAnonServerResult> {
	if (input.mock) {
		const id = randomBytes(3).toString("hex");
		return {
			ok: true,
			serverUrl: `https://hobo-opensaas-${id}.openpouch.sh`,
			authenticated: false,
			ownership: "anonymous",
			mode: "openpouch-anon",
			mocked: true,
		};
	}

	const staging = await stageOpenSaasAnonServerBundle(input.waspAbsRoot);
	const transport =
		process.env.HOBO_OPENPOUCH_TRANSPORT?.trim().toLowerCase() || "http";
	try {
		if (transport !== "cli") {
			const deployed = await provisionOpenpouchHttp({
				workDir: staging,
				projectHint: `hobo-opensaas-${randomBytes(2).toString("hex")}`,
				port: 8080,
				env: {
					DATABASE_URL: input.databaseUrl,
					WASP_WEB_CLIENT_URL: input.webClientUrl,
					WASP_SERVER_URL: "https://placeholder.openpouch.sh",
					PORT: "8080",
					NODE_ENV: "development",
				},
			});
			return {
				ok: true,
				serverUrl: deployed.url,
				claimUrl: deployed.claimUrl,
				expiresAt: deployed.expiresAt,
				authenticated: false,
				ownership: "anonymous",
				mode: "openpouch-anon",
				mocked: false,
			};
		}

		const bin = input.openpouchBin ?? "npx";
		const args =
			bin === "npx"
				? [
						"--yes",
						"openpouch",
						"deploy",
						".",
						"--json",
						"--redact-secrets",
						"--var",
						`DATABASE_URL=${input.databaseUrl}`,
						"--var",
						`WASP_WEB_CLIENT_URL=${input.webClientUrl}`,
						"--var",
						`WASP_SERVER_URL=https://placeholder.openpouch.sh`,
						"--health-path",
						"/",
					]
				: [
						"deploy",
						".",
						"--json",
						"--redact-secrets",
						"--var",
						`DATABASE_URL=${input.databaseUrl}`,
						"--var",
						`WASP_WEB_CLIENT_URL=${input.webClientUrl}`,
						"--health-path",
						"/",
					];

		const result = await run(bin, args, staging, {
			...process.env,
			// Ensure anonymous — no account key for Examples Temporary.
			OPENPOUCH_API_KEY: "",
		});
		const combined = `${result.stdout}\n${result.stderr}`;
		const jsonMatch = combined.match(/\{[\s\S]*\}\s*$/m);
		let parsed: JsonObject = {};
		try {
			if (jsonMatch) {
				const tree = parseJsonTree(jsonMatch[0]);
				if (isJsonObject(tree)) parsed = tree;
			}
		} catch {
			parsed = {};
		}
		if (result.code !== 0 || parsed.ok !== true || Object.prototype.toString.call(parsed.url) !== "[object String]") {
			const errValue = parsed.error;
			const errObj = isJsonObject(errValue) ? errValue : undefined;
			const err =
				(errObj && isJsonString(errObj.message) ? errObj.message : "") ||
				(Object.prototype.toString.call(parsed.summary) === "[object String]" ? parsed.summary : "") ||
				result.stderr.trim() ||
				result.stdout.trim() ||
				"openpouch deploy failed";
			throw new OpenpouchAnonServerError(
				errObj && isJsonString(errObj.category)
					? `${errObj.category}: ${err}`
					: err,
			);
		}

		return {
			ok: true,
			serverUrl: parsed.url,
			claimUrl:
				Object.prototype.toString.call(parsed.claimUrl) === "[object String]" ? parsed.claimUrl : undefined,
			expiresAt: parseExpiresAt(parsed.deployment),
			authenticated: false,
			ownership: "anonymous",
			mode: "openpouch-anon",
			mocked: false,
		};
	} catch (error) {
		if (error instanceof OpenpouchAnonServerError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new OpenpouchAnonServerError(message);
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}
