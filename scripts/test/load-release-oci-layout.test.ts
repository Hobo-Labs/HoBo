import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadedImageRef,
	loadVerifiedReleaseOciCandidate,
	type ReleaseOciLayoutExec,
} from "../ci/load-release-oci-layout.mts";

const IMAGE = "hobo-sdk";
const VERSION = "0.0.0-alpha.149";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const OTHER_REVISION = "fedcba9876543210fedcba9876543210fedcba98";
const MANIFEST_MEDIA = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_MEDIA = "application/vnd.oci.image.config.v1+json";

const dirs: string[] = [];
const prior = {
	version: process.env.HOBO_RELEASE_VERSION,
	revision: process.env.HOBO_RELEASE_REVISION,
	suffix: process.env.HOBO_RELEASE_CANDIDATE_SUFFIX,
};

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	restore("HOBO_RELEASE_VERSION", prior.version);
	restore("HOBO_RELEASE_REVISION", prior.revision);
	restore("HOBO_RELEASE_CANDIDATE_SUFFIX", prior.suffix);
});

function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function sha256(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function writeBlob(dir: string, bytes: Buffer) {
	const digest = sha256(bytes);
	const path = join(dir, "blobs", "sha256", digest.slice("sha256:".length));
	mkdirSync(join(dir, "blobs", "sha256"), { recursive: true });
	writeFileSync(path, bytes);
	return { digest, size: bytes.byteLength };
}

function layout(revision: string): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-oci-layout-"));
	dirs.push(dir);
	writeFileSync(join(dir, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}\n');
	const config = writeBlob(
		dir,
		Buffer.from(
			JSON.stringify({
				architecture: "amd64",
				os: "linux",
				config: {
					Labels: {
						"io.hobo.release.image": IMAGE,
						"org.opencontainers.image.revision": revision,
						"org.opencontainers.image.version": VERSION,
					},
				},
				rootfs: { type: "layers", diff_ids: [] },
			}),
		),
	);
	const manifest = writeBlob(
		dir,
		Buffer.from(
			JSON.stringify({
				schemaVersion: 2,
				mediaType: MANIFEST_MEDIA,
				config: {
					mediaType: CONFIG_MEDIA,
					digest: config.digest,
					size: config.size,
				},
				layers: [],
			}),
		),
	);
	writeFileSync(
		join(dir, "index.json"),
		JSON.stringify({
			schemaVersion: 2,
			manifests: [
				{
					mediaType: MANIFEST_MEDIA,
					digest: manifest.digest,
					size: manifest.size,
				},
			],
		}),
	);
	return dir;
}

function identity(): void {
	process.env.HOBO_RELEASE_VERSION = VERSION;
	process.env.HOBO_RELEASE_REVISION = REVISION;
	process.env.HOBO_RELEASE_CANDIDATE_SUFFIX = "-loadtest";
}

describe("loadedImageRef", () => {
	it("reads the one image docker load reported", () => {
		expect(loadedImageRef("Loaded image: hobo-sdk:candidate-loadtest\n")).toBe(
			"hobo-sdk:candidate-loadtest",
		);
		expect(loadedImageRef("Loaded image ID: sha256:abc\n")).toBe("sha256:abc");
	});

	it("refuses a load that did not report exactly one image", () => {
		expect(() => loadedImageRef("")).toThrow(/exactly one image/u);
		expect(() => loadedImageRef("Loaded image: a\nLoaded image: b\n")).toThrow(
			/exactly one image/u,
		);
	});
});

describe("loadVerifiedReleaseOciCandidate", () => {
	it("reuses a candidate that is already loaded and does not read the layout", () => {
		identity();
		const calls: string[] = [];
		const exec: ReleaseOciLayoutExec = (command, args) => {
			calls.push(`${command} ${args.join(" ")}`);
			return "";
		};
		const loaded = loadVerifiedReleaseOciCandidate(
			IMAGE,
			"/tmp/hobo-oci-absent-layout",
			{
				imageExists: () => true,
				exec,
			},
		);
		expect(loaded).toEqual({
			ref: "hobo-sdk:candidate-loadtest",
			loaded: false,
		});
		expect(calls).toEqual([]);
	});

	it("verifies the layout, loads it, and tags the current candidate ref", () => {
		identity();
		const calls: string[][] = [];
		const exec: ReleaseOciLayoutExec = (command, args) => {
			calls.push([command, ...args]);
			if (command === "docker" && args[0] === "load") {
				return "Loaded image: hobo-sdk:other\n";
			}
			return "";
		};
		const loaded = loadVerifiedReleaseOciCandidate(IMAGE, layout(REVISION), {
			imageExists: () => false,
			exec,
		});
		expect(loaded).toEqual({
			ref: "hobo-sdk:candidate-loadtest",
			loaded: true,
		});
		expect(calls.map((call) => call[0])).toEqual(["tar", "docker", "docker"]);
		expect(calls[1]?.slice(0, 2)).toEqual(["docker", "load"]);
		expect(calls[2]).toEqual([
			"docker",
			"tag",
			"hobo-sdk:other",
			"hobo-sdk:candidate-loadtest",
		]);
	});

	it("does not retag when docker load already named the candidate ref", () => {
		identity();
		const calls: string[][] = [];
		const exec: ReleaseOciLayoutExec = (command, args) => {
			calls.push([command, ...args]);
			return command === "docker"
				? "Loaded image: hobo-sdk:candidate-loadtest\n"
				: "";
		};
		expect(
			loadVerifiedReleaseOciCandidate(IMAGE, layout(REVISION), {
				imageExists: () => false,
				exec,
			}).loaded,
		).toBe(true);
		expect(calls.map((call) => call[0])).toEqual(["tar", "docker"]);
	});

	it("does not load a layout built from a different revision", () => {
		identity();
		const exec: ReleaseOciLayoutExec = () => {
			throw new Error("docker load must not run");
		};
		expect(() =>
			loadVerifiedReleaseOciCandidate(IMAGE, layout(OTHER_REVISION), {
				imageExists: () => false,
				exec,
			}),
		).toThrow(/revision/u);
	});
});
