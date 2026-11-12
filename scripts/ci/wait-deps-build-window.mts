#!/usr/bin/env node
/** Wait until no other isolated job container runs and deps-build headroom is available. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { promisify } from "node:util";
import {
	depsBuildHeadroomSatisfied,
	depsBuildHeadroomThresholds,
} from "../lib/deps-build-headroom.mts";
import {
	busyJobContainers,
	identifySelfContainer,
	parseRunningContainers,
	type RunningContainer,
	type SelfContainer,
	windowDecision,
} from "../lib/deps-build-window.mts";

const exec = promisify(execFile);

const POLL_MS = Number(process.env.HOBO_CI_DEPS_BUILD_WAIT_POLL_MS ?? 10_000);
const MAX_WAIT_MS = Number(process.env.HOBO_CI_DEPS_BUILD_WAIT_MS ?? 900_000);
// How long a caller that cannot identify its own container waits on job containers.
const UNKNOWN_SELF_MAX_WAIT_MS = Number(
	process.env.HOBO_CI_DEPS_BUILD_WAIT_UNKNOWN_SELF_MS ?? 120_000,
);
const { inodes: INODE_HEADROOM, bytes: BYTE_HEADROOM } =
	depsBuildHeadroomThresholds();

function parsePositiveInt(name: string, value: number) {
	if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
		throw new Error(`invalid ${name}`);
	return value;
}

parsePositiveInt("HOBO_CI_DEPS_BUILD_WAIT_POLL_MS", POLL_MS);
parsePositiveInt("HOBO_CI_DEPS_BUILD_WAIT_MS", MAX_WAIT_MS);
parsePositiveInt(
	"HOBO_CI_DEPS_BUILD_WAIT_UNKNOWN_SELF_MS",
	UNKNOWN_SELF_MAX_WAIT_MS,
);

async function listRunningContainers(): Promise<RunningContainer[]> {
	const { stdout } = await exec("docker", [
		"ps",
		"--no-trunc",
		"--format",
		"{{.ID}}\t{{.Names}}",
	]);
	return parseRunningContainers(stdout);
}

async function dockerSamplePath(): Promise<string> {
	let dockerRoot = "";
	try {
		const { stdout } = await exec("docker", [
			"info",
			"--format",
			"{{.DockerRootDir}}",
		]);
		dockerRoot = stdout.trim();
	} catch {
		dockerRoot = "";
	}
	return dockerRoot && existsSync(dockerRoot) ? dockerRoot : "/";
}

function describeSelf(self: SelfContainer): string {
	if (self.kind === "known") return `${self.name} (from ${self.source})`;
	return self.kind === "none" ? "not in a container" : "unidentified container";
}

async function main() {
	const started = Date.now();
	let selfLogged = false;
	for (;;) {
		const containers = await listRunningContainers();
		const self = identifySelfContainer({
			hostJobDirectory: process.env.HOBO_CI_HOST_JOB_DIRECTORY,
			hostName: hostname(),
			inContainer: existsSync("/.dockerenv"),
			containers,
		});
		if (!selfLogged) {
			console.log(`deps build window: this job is ${describeSelf(self)}`);
			selfLogged = true;
		}
		const busy = busyJobContainers(containers, self);
		const headroomOk = depsBuildHeadroomSatisfied(await dockerSamplePath());
		const elapsed = Math.max(0, Date.now() - started);
		const decision = windowDecision({
			busyJobContainers: busy.length,
			headroomOk,
			self,
			elapsedMs: elapsed,
			maxWaitMs: MAX_WAIT_MS,
			unknownSelfMaxWaitMs: UNKNOWN_SELF_MAX_WAIT_MS,
		});
		if (decision === "open") {
			console.log(`deps build window open (waited ${elapsed} ms)`);
			return;
		}
		if (decision === "proceed") {
			console.log(
				`deps build window: proceeding after ${elapsed} ms with job containers still running (${busy.join(", ")}): this job could not identify its own container, so one of them may be this job`,
			);
			return;
		}
		const reason =
			busy.length > 0
				? `isolated job containers: ${busy.join(", ")}`
				: `docker data root below measured deps headroom (need inodes>=${INODE_HEADROOM} bytes>=${BYTE_HEADROOM})`;
		if (decision === "fail") {
			console.error(
				`timed out waiting for deps build window after ${elapsed} ms: ${reason}`,
			);
			process.exit(1);
		}
		console.log(`deps build window blocked: ${reason}; retrying`);
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

main().catch((error) => {
	console.error(
		error instanceof Error ? error.message : "wait-deps-build-window failed",
	);
	process.exit(1);
});
