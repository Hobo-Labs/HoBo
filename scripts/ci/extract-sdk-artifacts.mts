#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Copy /sdk/artifacts from a local hobo-sdk candidate image into a host directory. */
export function extractSdkArtifactsFromImage(
	imageRef: string,
	destination?: string,
): string {
	const out = destination ?? mkdtempSync(join(tmpdir(), "hobo-sdk-artifacts-"));
	const container = `hobo-sdk-extract-${process.pid}`;
	const create = spawnSync(
		"docker",
		["create", "--name", container, imageRef],
		{ stdio: "inherit" },
	);
	if (create.status !== 0) {
		throw new Error(`docker create failed for ${imageRef}`);
	}
	try {
		const cp = spawnSync(
			"docker",
			["cp", `${container}:/sdk/artifacts/.`, out],
			{ stdio: "inherit" },
		);
		if (cp.status !== 0) {
			throw new Error(`docker cp failed from ${imageRef}:/sdk/artifacts`);
		}
	} finally {
		spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
	}
	return out;
}

function main(): void {
	const imageRef = process.argv[2];
	const destination = process.argv[3];
	if (!imageRef) {
		console.error(
			"usage: node scripts/ci/extract-sdk-artifacts.mts <image-ref> [destination]",
		);
		process.exit(2);
	}
	const dir = extractSdkArtifactsFromImage(imageRef, destination);
	console.log(dir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
