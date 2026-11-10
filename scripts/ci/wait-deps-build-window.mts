#!/usr/bin/env node
/** Wait until no isolated job containers run and deps-build inode headroom is available. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	depsBuildHeadroomSatisfied,
	depsBuildHeadroomThresholds,
} from "../lib/deps-build-headroom.mts";

const exec = promisify(execFile);

const ISOLATED_JOB =
	/^hobo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const POLL_MS = Number(process.env.HOBO_CI_DEPS_BUILD_WAIT_POLL_MS ?? 10_000);
const MAX_WAIT_MS = Number(process.env.HOBO_CI_DEPS_BUILD_WAIT_MS ?? 900_000);
const { inodes: INODE_HEADROOM, bytes: BYTE_HEADROOM } =
	depsBuildHeadroomThresholds();

function parsePositiveInt(name: string, value: number) {
	if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
		throw new Error(`invalid ${name}`);
	return value;
}

parsePositiveInt("HOBO_CI_DEPS_BUILD_WAIT_POLL_MS", POLL_MS);
parsePositiveInt("HOBO_CI_DEPS_BUILD_WAIT_MS", MAX_WAIT_MS);

async function listIsolatedJobContainers(): Promise<string[]> {
	const { stdout } = await exec("docker", ["ps", "--format", "{{.Names}}"]);
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((name) => ISOLATED_JOB.test(name));
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
	return dockerRoot && (await fileExists(dockerRoot)) ? dockerRoot : "/";
}

async function fileExists(path: string): Promise<boolean> {
	try {
		const { access } = await import("node:fs/promises");
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function ready(): Promise<{ ok: true } | { ok: false; reason: string }> {
	const running = await listIsolatedJobContainers();
	if (running.length > 0)
		return {
			ok: false,
			reason: `isolated job containers: ${running.join(", ")}`,
		};
	const samplePath = await dockerSamplePath();
	if (!depsBuildHeadroomSatisfied(samplePath))
		return {
			ok: false,
			reason: `docker data root below measured deps headroom (need inodes>=${INODE_HEADROOM} bytes>=${BYTE_HEADROOM})`,
		};
	return { ok: true };
}

async function main() {
	const started = Date.now();
	for (;;) {
		const state = await ready();
		if (state.ok) {
			console.log(
				`deps build window open (waited ${Math.max(0, Date.now() - started)} ms)`,
			);
			return;
		}
		const elapsed = Date.now() - started;
		if (elapsed >= MAX_WAIT_MS) {
			console.error(
				`timed out waiting for deps build window after ${elapsed} ms: ${state.reason}`,
			);
			process.exit(1);
		}
		console.log(`deps build window blocked: ${state.reason}; retrying`);
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

main().catch((error) => {
	console.error(
		error instanceof Error ? error.message : "wait-deps-build-window failed",
	);
	process.exit(1);
});
