import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	ENVIRONMENT_STATION_WORKER_MODULE,
	ENVIRONMENT_STATION_WORKER_NAME_PREFIX,
} from "./station-worker-source.js";
import type { TemporaryEnvironmentStationResult } from "./temporary-station.js";
import { TEMPORARY_STATION_TTL_MS } from "./temporary-station.js";

export type WranglerTemporaryDeployInput = {
	readonly stationId: string;
	readonly scriptName?: string;
	readonly workerModule?: string;
	readonly wranglerBin?: string;
	readonly cwd?: string;
};

const URL_RE = /https:\/\/[a-z0-9.-]+\.workers\.dev\/?/giu;
const CLAIM_RE = /https:\/\/[^\s]*claim[^\s]*/giu;

export function parseWranglerTemporaryOutput(stdout: string, stderr: string) {
	const text = `${stdout}\n${stderr}`;
	const workers = [...text.matchAll(URL_RE)].map((match) =>
		match[0].replace(/\/$/u, ""),
	);
	const claims = [...text.matchAll(CLAIM_RE)].map((match) => match[0]);
	const stationUrl = workers.find((url) => !/claim/iu.test(url));
	const claimUrl =
		claims[0] ?? workers.find((url) => /claim/iu.test(url)) ?? "";
	if (!stationUrl) {
		throw new Error(
			"wrangler deploy --temporary succeeded but no workers.dev URL was parsed",
		);
	}
	if (!claimUrl) {
		throw new Error(
			"wrangler deploy --temporary succeeded but no claim URL was parsed",
		);
	}
	return { stationUrl, claimUrl };
}

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

/**
 * Deploy Environment Station via `wrangler deploy --temporary`.
 * Requires Wrangler ≥ 4.102 and **no** Cloudflare credentials in the environment.
 */
export async function deployTemporaryWithWrangler(
	input: WranglerTemporaryDeployInput,
): Promise<TemporaryEnvironmentStationResult> {
	const scriptName =
		input.scriptName ??
		`${ENVIRONMENT_STATION_WORKER_NAME_PREFIX}-${input.stationId
			.replace(/[^a-z0-9]+/giu, "-")
			.slice(0, 32)
			.toLowerCase()}`;
	const work =
		input.cwd ?? path.join(tmpdir(), `hobo-cf-temp-station-${Date.now()}`);
	await mkdir(work, { recursive: true });
	await writeFile(
		path.join(work, "station.js"),
		input.workerModule ?? ENVIRONMENT_STATION_WORKER_MODULE,
		"utf8",
	);
	await writeFile(
		path.join(work, "wrangler.toml"),
		`name = "${scriptName}"\nmain = "station.js"\ncompatibility_date = "2024-11-01"\n`,
		"utf8",
	);

	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	delete env.CLOUDFLARE_API_KEY;
	delete env.CF_API_TOKEN;

	const bin = input.wranglerBin ?? "wrangler";
	const result = await run(bin, ["deploy", "--temporary"], work, env);
	if (result.code !== 0) {
		throw new Error(
			result.stderr.trim() ||
				result.stdout.trim() ||
				"wrangler deploy --temporary failed",
		);
	}
	const parsed = parseWranglerTemporaryOutput(result.stdout, result.stderr);
	return {
		stationId: input.stationId,
		scriptName,
		stationUrl: parsed.stationUrl,
		primaryUrl: parsed.stationUrl,
		claimUrl: parsed.claimUrl,
		accountId: "temporary",
		expiresAt: new Date(Date.now() + TEMPORARY_STATION_TTL_MS).toISOString(),
		providerId: "cloudflare",
		anonymous: true,
		temporary: true,
	};
}
