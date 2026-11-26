#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type DockerCommandResult,
	executeRunnerJobDiskPrune,
	parseDfAvailBytes,
} from "../lib/runner-job-disk-prune.mts";

function sampleAvailBytes(samplePath: string): number {
	const result = spawnSync("df", ["-B1", "--output=avail", "--", samplePath], {
		encoding: "utf8",
	});
	if (result.error) throw new Error(result.error.message);
	if (result.status !== 0) {
		const detail = result.stderr?.trim() || "no stderr";
		throw new Error(
			`df failed for ${samplePath} (${result.status ?? "unknown"}): ${detail}`,
		);
	}
	return parseDfAvailBytes(result.stdout);
}

function dockerReachable(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	const sock = env.HOBO_CI_DOCKER_SOCK?.trim() || "/var/run/docker.sock";
	try {
		return statSync(sock).isSocket();
	} catch {
		return false;
	}
}

function runDocker(args: readonly string[]): DockerCommandResult {
	const capture = args[0] === "info";
	const result = spawnSync("docker", [...args], {
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	const status = result.status;
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (result.error !== undefined) {
		return { status, stdout, stderr, error: result.error.message };
	}
	return { status, stdout, stderr };
}

function main(): void {
	const code = executeRunnerJobDiskPrune(process.env, process.cwd(), {
		sample: sampleAvailBytes,
		docker: runDocker,
		dockerAvailable: dockerReachable(process.env),
		log: (message) => {
			process.stdout.write(`${message}\n`);
		},
		warn: (message) => {
			process.stderr.write(`::warning::${message}\n`);
		},
	});
	if (code !== 0) process.exit(code);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main();
}
