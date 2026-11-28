#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseImageCandidateRef } from "./build-release-oci-image.mts";
import { verifyReleaseOciHandoff } from "./release-oci-handoff.mts";

const root = join(import.meta.dirname, "..", "..");

export type ReleaseOciLayoutLoad = Readonly<{
	ref: string;
	loaded: boolean;
}>;

export type ReleaseOciLayoutExec = (
	command: string,
	args: readonly string[],
) => string;

export type ReleaseOciLayoutLoadSeams = Readonly<{
	imageExists?: (ref: string) => boolean;
	exec?: ReleaseOciLayoutExec;
}>;

function defaultExec(command: string, args: readonly string[]): string {
	const result = spawnSync(command, [...args], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "").trim();
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	return result.stdout ?? "";
}

function dockerImageExists(ref: string): boolean {
	return (
		spawnSync("docker", ["image", "inspect", ref], {
			cwd: root,
			stdio: "ignore",
		}).status === 0
	);
}

export function loadedImageRef(output: string): string {
	const refs = [...output.matchAll(/^Loaded image(?: ID)?: (.+)$/gm)].map(
		(match) => match[1]?.trim() ?? "",
	);
	if (refs.length !== 1 || !refs[0]) {
		throw new Error(
			`docker load did not report exactly one image: ${JSON.stringify(output)}`,
		);
	}
	return refs[0];
}

function releaseIdentity() {
	const version = process.env.HOBO_RELEASE_VERSION?.trim() ?? "";
	const revision = process.env.HOBO_RELEASE_REVISION?.trim() ?? "";
	if (!version) {
		throw new Error(
			"HOBO_RELEASE_VERSION is required to verify the OCI layout",
		);
	}
	if (!/^[0-9a-f]{40}$/u.test(revision)) {
		throw new Error(
			"HOBO_RELEASE_REVISION must be the 40-hex commit the layout was built from",
		);
	}
	return { version, revision };
}

export function loadVerifiedReleaseOciCandidate(
	imageId: string,
	layoutDir: string,
	seams: ReleaseOciLayoutLoadSeams = {},
): ReleaseOciLayoutLoad {
	const ref = releaseImageCandidateRef(imageId);
	const imageExists = seams.imageExists ?? dockerImageExists;
	if (imageExists(ref)) return { ref, loaded: false };
	const { version, revision } = releaseIdentity();
	verifyReleaseOciHandoff(layoutDir, { imageId, revision, version });
	const exec = seams.exec ?? defaultExec;
	const archive = join(
		tmpdir(),
		`hobo-oci-load-${randomBytes(8).toString("hex")}.tar`,
	);
	try {
		exec("tar", ["-cf", archive, "-C", layoutDir, "."]);
		const source = loadedImageRef(exec("docker", ["load", "--input", archive]));
		if (source !== ref) exec("docker", ["tag", source, ref]);
	} finally {
		rmSync(archive, { force: true });
	}
	return { ref, loaded: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [imageId, layoutDir] = process.argv.slice(2);
	if (!imageId || !layoutDir) {
		console.error("usage: load-release-oci-layout.mts <image-id> <layout-dir>");
		process.exit(2);
	}
	const loaded = loadVerifiedReleaseOciCandidate(imageId, layoutDir);
	console.log(loaded.loaded ? `loaded ${loaded.ref}` : `reusing ${loaded.ref}`);
}
