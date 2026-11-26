/**
 * Real Convex function deploy executor (ADR-0144 thin adapter).
 * Live paths:
 * - Cloud: broker-minted CONVEX_DEPLOY_KEY
 * - Self-host: CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY
 * Default CI uses an injected runner — no live network. Mock is explicit only.
 */
import path from "node:path";

import { ConvexCredentialsError } from "./management-api.js";

export type ConvexSpawnResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

export type ConvexSpawn = (input: {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}) => Promise<ConvexSpawnResult>;

export type DeployConvexAppInput = {
	readonly root: string;
	readonly deployKey?: string;
	readonly selfHostedUrl?: string;
	readonly selfHostedAdminKey?: string;
	readonly deploymentName?: string;
	readonly spawn?: ConvexSpawn;
	/** When true, skip spawn and return a deterministic mock URL (CI only). */
	readonly mock?: boolean;
};

export type DeployConvexAppResult = {
	readonly ok: true;
	readonly deploymentUrl: string;
	readonly deploymentName: string;
	readonly mocked: boolean;
	readonly mode: "cloud" | "self-hosted" | "mock";
};

export class ConvexDeployError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConvexDeployError";
	}
}

export function hasConvexCloudCredentials(input: {
	readonly deployKey?: string;
}): boolean {
	return Boolean(input.deployKey?.trim());
}

export function hasConvexSelfHostedCredentials(input: {
	readonly selfHostedUrl?: string;
	readonly selfHostedAdminKey?: string;
}): boolean {
	return Boolean(
		input.selfHostedUrl?.trim() && input.selfHostedAdminKey?.trim(),
	);
}

/**
 * Fail-closed when neither Cloud deploy key nor self-host URL+admin key.
 * Mock lane (`mock: true`) is explicit CI only — never silent success.
 */
export async function deployConvexApp(
	input: DeployConvexAppInput,
): Promise<DeployConvexAppResult> {
	const root = path.resolve(input.root);
	const deployKey = input.deployKey?.trim();
	const selfHostedUrl = input.selfHostedUrl?.trim();
	const selfHostedAdminKey = input.selfHostedAdminKey?.trim();
	const cloud = hasConvexCloudCredentials(deployKey ? { deployKey } : {});
	const selfHosted = hasConvexSelfHostedCredentials(
		selfHostedUrl && selfHostedAdminKey
			? { selfHostedUrl, selfHostedAdminKey }
			: {},
	);

	if (!cloud && !selfHosted && !input.mock) {
		throw new ConvexCredentialsError();
	}

	const deploymentName = input.deploymentName?.trim() || "hobo-swaghaus";

	if (input.mock) {
		return Object.freeze({
			ok: true as const,
			deploymentUrl: selfHostedUrl || `https://${deploymentName}.convex.cloud`,
			deploymentName,
			mocked: true,
			mode: "mock" as const,
		});
	}

	const spawn = input.spawn;
	if (!spawn) {
		throw new ConvexDeployError(
			"convex deploy requires an injected spawn runner (or mock: true for CI)",
		);
	}

	const childEnv: Record<string, string> = {};
	if (cloud && deployKey) {
		childEnv.CONVEX_DEPLOY_KEY = deployKey;
	}
	if (selfHosted && selfHostedUrl && selfHostedAdminKey) {
		childEnv.CONVEX_SELF_HOSTED_URL = selfHostedUrl;
		childEnv.CONVEX_SELF_HOSTED_ADMIN_KEY = selfHostedAdminKey;
	}

	const localConvexBin = path.join(root, "node_modules", ".bin", "convex");
	const useLocalBin = await fileExists(localConvexBin);
	const result = await spawn({
		command: useLocalBin ? localConvexBin : "npx",
		args: useLocalBin
			? ["deploy", "--yes", "--cmd-url-env-var-name", "VITE_CONVEX_URL"]
			: [
					"--yes",
					"convex",
					"deploy",
					"--yes",
					"--cmd-url-env-var-name",
					"VITE_CONVEX_URL",
				],
		cwd: root,
		env: childEnv,
	});

	if (result.exitCode !== 0) {
		throw new ConvexDeployError(
			`convex deploy failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
		);
	}

	const url =
		extractConvexUrl(result.stdout) ??
		extractConvexUrl(result.stderr) ??
		selfHostedUrl ??
		`https://${deploymentName}.convex.cloud`;

	const mode =
		selfHosted && !cloud ? ("self-hosted" as const) : ("cloud" as const);

	return Object.freeze({
		ok: true as const,
		deploymentUrl: url,
		deploymentName,
		mocked: false,
		mode,
	});
}

function extractConvexUrl(text: string): string | undefined {
	const cloud = text.match(/https:\/\/[a-z0-9-]+\.convex\.cloud\b/iu);
	if (cloud?.[0]) return cloud[0];
	const local = text.match(
		/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\b/iu,
	);
	if (local?.[0]) return local[0];
	const anyHttp = text.match(/https?:\/\/[^\s"'<>]+/iu);
	return anyHttp?.[0];
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const { access } = await import("node:fs/promises");
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}
