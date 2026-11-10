#!/usr/bin/env node
/** Resolve measured deps-build inode/byte headroom (shared with build-deps.sh and admission). */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	DepsBuildTelemetrySchema,
	type DepsBuildTelemetry,
	depsBuildDockerReserve,
} from "../../packages/ci-gh-actions/src/isolated-worker/deps-build-budget.ts";

function parsePositiveInt(
	name: string,
	value: string | undefined,
): number | undefined {
	if (value === undefined || value === "") return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed))
		throw new Error(`invalid ${name}`);
	return parsed;
}

function telemetryPath(): string {
	return (
		process.env.HOBO_CI_DEPS_BUILD_TELEMETRY_PATH?.trim() ||
		`${process.env.HOBO_HOME ?? `${process.env.HOME ?? ""}/.hobo`}/ci/deps-build-telemetry.json`
	);
}

export function loadDepsBuildTelemetry(): DepsBuildTelemetry {
	const path = telemetryPath();
	if (!existsSync(path)) return {};
	try {
		const parsed = DepsBuildTelemetrySchema.safeParse(
			JSON.parse(readFileSync(path, "utf8")),
		);
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

export function saveDepsBuildTelemetry(telemetry: DepsBuildTelemetry): void {
	const path = telemetryPath();
	writeFileSync(path, `${JSON.stringify(telemetry, null, 2)}\n`);
}

export type DepsBuildHeadroomThresholds = Readonly<{
	inodes: number;
	bytes: number;
}>;

export function depsBuildHeadroomThresholds(
	telemetry = loadDepsBuildTelemetry(),
): DepsBuildHeadroomThresholds {
	const overrideInodes = parsePositiveInt(
		"HOBO_CI_DEPS_BUILD_INODE_HEADROOM",
		process.env.HOBO_CI_DEPS_BUILD_INODE_HEADROOM,
	);
	const overrideBytes = parsePositiveInt(
		"HOBO_CI_DEPS_BUILD_BYTE_HEADROOM",
		process.env.HOBO_CI_DEPS_BUILD_BYTE_HEADROOM,
	);
	const measured = depsBuildDockerReserve(telemetry);
	return {
		inodes: overrideInodes ?? measured.dockerDataRoot,
		bytes: overrideBytes ?? measured.dockerDataRootBytes,
	};
}

export type DockerHeadroomSample = Readonly<{
	iavail: number;
	avail: number;
	itotal: number;
}>;

export function sampleDockerHeadroom(samplePath: string): DockerHeadroomSample {
	const iavail = Number(
		execFileSync("df", ["--output=iavail", samplePath], { encoding: "utf8" })
			.trim()
			.split("\n")
			.at(-1)
			?.trim(),
	);
	const avail = Number(
		execFileSync("df", ["-B1", "--output=avail", samplePath], {
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.at(-1)
			?.trim(),
	);
	const itotal = Number(
		execFileSync("df", ["--output=itotal", samplePath], { encoding: "utf8" })
			.trim()
			.split("\n")
			.at(-1)
			?.trim(),
	);
	if (
		!Number.isFinite(iavail) ||
		!Number.isFinite(avail) ||
		!Number.isFinite(itotal)
	) {
		throw new Error(`invalid Docker data root df sample for ${samplePath}`);
	}
	return { iavail, avail, itotal };
}

export function depsBuildHeadroomSatisfied(samplePath: string): boolean {
	const { inodes, bytes } = depsBuildHeadroomThresholds();
	const sample = sampleDockerHeadroom(samplePath);
	return sample.iavail >= inodes && sample.avail >= bytes;
}

function main(): void {
	const [command, samplePath] = process.argv.slice(2);
	if (command === "--help" || command === undefined) {
		console.log(
			"Usage: node scripts/lib/deps-build-headroom.mts --print [<sample-path>]",
		);
		console.log(
			"       node scripts/lib/deps-build-headroom.mts --check <sample-path>",
		);
		console.log(
			"       node scripts/lib/deps-build-headroom.mts --record <sample-path> <before-inodes> <before-bytes>",
		);
		process.exit(command === "--help" ? 0 : 2);
	}
	const path = samplePath ?? "/";
	if (command === "--print") {
		const { inodes, bytes } = depsBuildHeadroomThresholds();
		const sample = sampleDockerHeadroom(path);
		console.log(
			`required-inodes=${inodes} required-bytes=${bytes} free-inodes=${sample.iavail} free-bytes=${sample.avail} itotal=${sample.itotal}`,
		);
		console.log(`${inodes} ${bytes}`);
		return;
	}
	if (command === "--check") {
		if (!depsBuildHeadroomSatisfied(path)) process.exit(1);
		return;
	}
	if (command === "--record") {
		const beforeInodes = Number(process.argv[4]);
		const beforeBytes = Number(process.argv[5]);
		const after = sampleDockerHeadroom(path);
		const peakInodes = Math.max(0, beforeInodes - after.iavail);
		const peakBytes = Math.max(0, beforeBytes - after.avail);
		const prior = loadDepsBuildTelemetry();
		const next: DepsBuildTelemetry = {
			peakDockerInodes: Math.max(prior.peakDockerInodes ?? 0, peakInodes),
			peakDockerBytes: Math.max(prior.peakDockerBytes ?? 0, peakBytes),
			updatedAtMs: Date.now(),
		};
		saveDepsBuildTelemetry(next);
		console.log(
			`recorded peak inodes=${next.peakDockerInodes} bytes=${next.peakDockerBytes}`,
		);
		return;
	}
	throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
