/**
 * Deploy Convex swaghaus: Temporary frontend on Cloudflare Pages.
 *
 * Live anonymous self-host of official Convex OCI/binary is currently
 * unavailable under zero project API keys (see
 * `provisionConvexBackendAnonymous` rejection matrix). Mock path ships a
 * Temporary-shaped backend URL for CI/Examples. Not localhost docker. Not
 * Convex Cloud unless HOBO_CONVEX_ALLOW_CLOUD=1. Not E2B (credentialed).
 */
import { spawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConvexRoot } from "@hobo/convex";
import {
	applyDriverProgram,
	assertConvexBackendReachableFromFrontend,
	CONVEX_BACKEND_OCI_IMAGE,
	CONVEX_PROVIDER_ID,
	ConvexAnonBackendError,
	createConvexProvider,
	provisionConvexBackendAnonymous,
	requireWorkOsAuthKit,
	type FrontendPlacement,
} from "@hobo/provider-convex";
import { provisionConvexBackendViaClawdship } from "./anon-container-hosts/convex-clawdship.mts";
import { provisionConvexBackendOnCloudflare } from "../../packages/providers/provider-cloudflare/src/convex-backend-container.ts";
import { parseWranglerTemporaryOutput } from "../../packages/providers/provider-cloudflare/src/wrangler-temporary.ts";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

export type SwaghausTemporaryDeployResult = {
	readonly ok: true;
	readonly clientUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly exampleId: "swaghaus";
	readonly convexAbsRoot: string;
	readonly deploymentUrl: string;
	readonly mocked: boolean;
	readonly backendMode:
		| "anon-mock-temporary"
		| "cloudflare-containers"
		| "clawdship-anon"
		| "cloud"
		| "self-hosted"
		| "mock";
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

function isLoopbackOrPrivateUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/iu.test(host)) {
			return true;
		}
		return (
			/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host) ||
			/^192\.168\.\d{1,3}\.\d{1,3}$/u.test(host) ||
			/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/u.test(host) ||
			/^169\.254\.\d{1,3}\.\d{1,3}$/u.test(host)
		);
	} catch {
		return true;
	}
}

export async function deploySwaghausTemporary(input: {
	readonly root: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly frontendPlacement?: FrontendPlacement;
}): Promise<SwaghausTemporaryDeployResult> {
	const env = { ...process.env, ...input.env };
	const mock = env.HOBO_CONVEX_SWAGHAUS_MOCK === "1";
	const frontendPlacement = input.frontendPlacement ?? "remote-public";
	const allowCloud = env.HOBO_CONVEX_ALLOW_CLOUD === "1";
	const convexAbsRoot = resolveConvexRoot(REPO_ROOT, input.root);

	if (!mock) {
		requireWorkOsAuthKit(env);
	}

	let selfHostedUrl = env.CONVEX_SELF_HOSTED_URL?.trim();
	let selfHostedAdminKey = env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim();
	let deployKey = allowCloud ? env.CONVEX_DEPLOY_KEY?.trim() : undefined;
	let backendMode:
		| "anon-mock-temporary"
		| "cloudflare-containers"
		| "clawdship-anon"
		| "cloud"
		| "self-hosted"
		| "mock" = "mock";

	if (
		frontendPlacement === "remote-public" &&
		selfHostedUrl &&
		isLoopbackOrPrivateUrl(selfHostedUrl)
	) {
		selfHostedUrl = undefined;
		selfHostedAdminKey = undefined;
	}

	const needEphemeralOci =
		frontendPlacement === "remote-public" &&
		!deployKey &&
		!(selfHostedUrl && selfHostedAdminKey);

	const ociHost = (
		env.HOBO_CONVEX_OCI_HOST?.trim() || "anon-unavailable"
	).toLowerCase();

	if (needEphemeralOci) {
		if (ociHost === "cloudflare") {
			const workDir = await mkdtemp(path.join(tmpdir(), "hobo-convex-cf-"));
			const provisioned = await provisionConvexBackendOnCloudflare({
				workDir,
				workerName: "hobo-convex-swaghaus",
				image: CONVEX_BACKEND_OCI_IMAGE,
				env,
				mock,
				spawn: async ({ command, args, cwd, env: childEnv }) => {
					const result = await run(command, args, cwd, {
						...env,
						...childEnv,
					});
					return {
						exitCode: result.code,
						stdout: result.stdout,
						stderr: result.stderr,
					};
				},
			});
			selfHostedUrl = provisioned.backendUrl;
			selfHostedAdminKey = provisioned.adminKey;
			backendMode = "cloudflare-containers";
		} else if (ociHost === "clawdship") {
			const provisioned = await provisionConvexBackendViaClawdship({
				image: CONVEX_BACKEND_OCI_IMAGE,
				mock,
			});
			selfHostedUrl = provisioned.backendUrl;
			selfHostedAdminKey = provisioned.adminKey;
			backendMode = "clawdship-anon";
		} else if (ociHost === "e2b" || ociHost === "instanode" || ociHost === "openpouch") {
			throw new ConvexAnonBackendError(
				`HOBO_CONVEX_OCI_HOST=${ociHost} rejected for Examples Temporary. ` +
					"Instanode: dead/no anon containers (do not re-probe). OpenPouch anon: 256MiB cgroup < Convex binary. " +
					"E2B: requires API key. Try HOBO_CONVEX_OCI_HOST=clawdship (competitor), " +
					"HOBO_CONVEX_OCI_HOST=cloudflare (often 403), HOBO_CONVEX_SWAGHAUS_MOCK=1, or HOBO_CONVEX_ALLOW_CLOUD=1.",
			);
		} else {
			const provisioned = await provisionConvexBackendAnonymous({
				image: CONVEX_BACKEND_OCI_IMAGE,
				mock,
			});
			selfHostedUrl = provisioned.backendUrl;
			selfHostedAdminKey = provisioned.adminKey;
			backendMode = "anon-mock-temporary";
		}
	} else if (deployKey) {
		backendMode = "cloud";
	} else if (selfHostedUrl && selfHostedAdminKey) {
		backendMode = "self-hosted";
	}

	if (
		!mock &&
		frontendPlacement === "remote-public" &&
		backendMode === "cloud" &&
		!allowCloud
	) {
		throw new ConvexAnonBackendError(
			"Convex Cloud deploy key ignored for Examples remote ship. " +
				"No anon Temporary Convex self-host host is available under zero " +
				"project API keys. Set HOBO_CONVEX_SWAGHAUS_MOCK=1, or " +
				"HOBO_CONVEX_ALLOW_CLOUD=1, or HOBO_CONVEX_OCI_HOST=cloudflare " +
				"(Temporary Containers often 403).",
		);
	}

	const provider = createConvexProvider();
	const realized = provider.realize({
		name: "backend",
		port: "database",
		provider: CONVEX_PROVIDER_ID,
		region: "us",
		deploymentId: "hobo-swaghaus",
	});

	const deployed = await applyDriverProgram({
		program: realized.driver,
		root: convexAbsRoot,
		mock,
		deployKey,
		selfHostedUrl,
		selfHostedAdminKey,
		spawn: async ({ command, args, cwd, env: childEnv }) => {
			const result = await run(command, args, cwd, {
				...env,
				...childEnv,
			});
			return {
				exitCode: result.code,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		},
	});

	assertConvexBackendReachableFromFrontend({
		frontendPlacement,
		deploymentUrl: deployed.deploymentUrl,
		mode: deployed.mode,
	});

	const distIndex = path.join(convexAbsRoot, "dist/index.html");
	try {
		await access(distIndex);
	} catch {
		const build = await run("npx", ["vite", "build"], convexAbsRoot, {
			...env,
			VITE_CONVEX_URL: deployed.deploymentUrl,
		});
		if (build.code !== 0 && !mock) {
			throw new Error(
				`vite build failed: ${build.stderr.trim() || build.stdout.trim()}`,
			);
		}
	}

	if (mock) {
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		return {
			ok: true,
			clientUrl: `https://mock.swaghaus.hobo.test/`,
			claimUrl: `https://mock.swaghaus.hobo.test/#claim`,
			expiresAt,
			anonymous: true,
			temporary: true,
			exampleId: "swaghaus",
			convexAbsRoot,
			deploymentUrl: deployed.deploymentUrl,
			mocked: true,
			backendMode:
				backendMode === "anon-mock-temporary"
					? "anon-mock-temporary"
					: backendMode === "cloudflare-containers"
						? "cloudflare-containers"
						: "mock",
		};
	}

	const wrangler = await run(
		"wrangler",
		["pages", "deploy", "dist", "--project-name", "hobo-swaghaus", "--temporary"],
		convexAbsRoot,
		env,
	);
	if (wrangler.code !== 0) {
		throw new Error(
			`wrangler pages deploy failed: ${wrangler.stderr.trim() || wrangler.stdout.trim()}`,
		);
	}
	const parsed = parseWranglerTemporaryOutput(wrangler.stdout, wrangler.stderr);
	return {
		ok: true,
		clientUrl: parsed.stationUrl,
		claimUrl: parsed.claimUrl,
		expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		anonymous: true,
		temporary: true,
		exampleId: "swaghaus",
		convexAbsRoot,
		deploymentUrl: deployed.deploymentUrl,
		mocked: false,
		backendMode,
	};
}
