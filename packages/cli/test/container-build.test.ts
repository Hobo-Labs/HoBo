import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	buildContainerImage,
	validateContainerArchive,
} from "../src/build/container-build.js";
import { sha256Bytes } from "../src/build/events.js";
import { runBuild, writeBuildFixtureProject } from "../src/build/run-build.js";
import { runCodegen } from "../src/codegen/run-codegen.js";

async function archiveFixture(root: string, corrupt: boolean): Promise<Buffer> {
	const layout = join(root, "layout");
	const blobs = join(layout, "blobs/sha256");
	await mkdir(blobs, { recursive: true });
	const filesystem = join(root, "filesystem");
	await mkdir(join(filesystem, "app"), { recursive: true });
	await writeFile(
		join(filesystem, "app/main.mjs"),
		'process.stdout.write("actual image application");',
	);
	const layerTar = execFileSync("tar", ["-cf", "-", "-C", filesystem, "."]);
	async function blob(content: Buffer, mediaType: string) {
		const digest = sha256Bytes(content);
		await writeFile(join(blobs, digest.slice(7)), content);
		return { mediaType, digest, size: content.length };
	}
	const layer = await blob(
		gzipSync(layerTar),
		"application/vnd.oci.image.layer.v1.tar+gzip",
	);
	const config = await blob(
		Buffer.from(
			JSON.stringify({
				architecture: "arm64",
				os: "linux",
				rootfs: { type: "layers", diff_ids: [sha256Bytes(layerTar)] },
				config: { Entrypoint: ["node", "/app/main.mjs"] },
			}),
		),
		"application/vnd.oci.image.config.v1+json",
	);
	const manifest = await blob(
		Buffer.from(
			JSON.stringify({
				schemaVersion: 2,
				mediaType: "application/vnd.oci.image.manifest.v1+json",
				config,
				layers: [layer],
			}),
		),
		"application/vnd.oci.image.manifest.v1+json",
	);
	await writeFile(
		join(layout, "oci-layout"),
		JSON.stringify({ imageLayoutVersion: "1.0.0" }),
	);
	await writeFile(
		join(layout, "index.json"),
		JSON.stringify({ schemaVersion: 2, manifests: [manifest] }),
	);
	if (corrupt)
		await writeFile(join(blobs, layer.digest.slice(7)), "corrupt layer bytes");
	return execFileSync("tar", [
		"-cf",
		"-",
		"-C",
		layout,
		"oci-layout",
		"index.json",
		"blobs",
	]);
}

describe("executable container artifact boundary", () => {
	it.each([
		false,
		true,
	])("verifies native tar OCI layers and detects corruption=%s", async (corrupt) => {
		const root = await mkdtemp(join(tmpdir(), "hobo-oci-archive-"));
		try {
			const archive = await archiveFixture(root, corrupt);
			if (corrupt)
				expect(() => validateContainerArchive(archive)).toThrow("corrupt blob");
			else expect(() => validateContainerArchive(archive)).not.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("requires an actual container build context instead of manufacturing descriptor success", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-container-context-"));
		const service = {
			name: "worker",
			language: "python",
			runtime: "container" as const,
			sourceRoot: "service",
			entrypoint: "service/app.py",
		};
		try {
			await writeBuildFixtureProject(root, { services: [service] });
			await runCodegen({ projectRoot: root, check: false });
			await expect(
				buildContainerImage({
					projectRoot: root,
					service,
					sourceDateEpoch: "0",
					fallbackReason: "declared-runtime: container",
				}),
			).rejects.toMatchObject({ code: "HOBO_BUILD_SOURCE_MISSING" });
			await mkdir(join(root, ".hobo/build"), { recursive: true });
			const previous = join(root, ".hobo/build/build-manifest.json");
			await writeFile(previous, "previous verified build");
			await expect(
				runBuild({
					projectRoot: root,
					targetRuntime: "container",
					sourceDateEpoch: "0",
				}),
			).rejects.toMatchObject({ code: "HOBO_BUILD_SOURCE_MISSING" });
			expect(await readFile(previous, "utf8")).toBe("previous verified build");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects invalid epochs and passes normalized seconds to either container builder", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-container-epoch-"));
		const previousPath = process.env.PATH;
		const previousBuilder = process.env.HOBO_CONTAINER_BUILDER;
		const previousMarker = process.env.HOBO_EPOCH_MARKER;
		const marker = join(root, "builder-was-called");
		const service = {
			name: "worker",
			language: "python",
			runtime: "container" as const,
			sourceRoot: "service",
			entrypoint: "service/app.py",
		};
		try {
			await mkdir(join(root, "service"));
			await writeFile(join(root, "service/Dockerfile"), "FROM scratch\n");
			for (const tool of ["docker", "buildctl"]) {
				await writeFile(
					join(root, tool),
					'#!/bin/sh\nprintf "%s\\n" "$@" > "$HOBO_EPOCH_MARKER"\nexit 1\n',
					{ mode: 0o755 },
				);
			}
			process.env.PATH = `${root}:${previousPath ?? ""}`;
			process.env.HOBO_CONTAINER_BUILDER = "docker";
			process.env.HOBO_EPOCH_MARKER = marker;
			for (const sourceDateEpoch of [
				"-1",
				"1969-12-31T23:59:59Z",
				"2026-01-01T00:00:00",
				"2026-02-30T00:00:00Z",
				"8640000000001",
				String(Number.MAX_SAFE_INTEGER),
			]) {
				await expect(
					buildContainerImage({
						projectRoot: root,
						service,
						sourceDateEpoch,
						fallbackReason: "declared-runtime: container",
					}),
					sourceDateEpoch,
				).rejects.toMatchObject({ code: "HOBO_BUILD_USAGE" });
			}
			await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
			for (const tool of ["docker", "buildctl"]) {
				process.env.HOBO_CONTAINER_BUILDER = tool;
				await expect(
					buildContainerImage({
						projectRoot: root,
						service,
						sourceDateEpoch: "2026-01-01T01:30:00.999+01:30",
						fallbackReason: "declared-runtime: container",
					}),
				).rejects.toMatchObject({ code: "HOBO_BUILD_COMPONENTIZE_FAILED" });
				expect(await readFile(marker, "utf8")).toContain(
					"SOURCE_DATE_EPOCH=1767225600",
				);
			}
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousBuilder === undefined)
				delete process.env.HOBO_CONTAINER_BUILDER;
			else process.env.HOBO_CONTAINER_BUILDER = previousBuilder;
			if (previousMarker === undefined) delete process.env.HOBO_EPOCH_MARKER;
			else process.env.HOBO_EPOCH_MARKER = previousMarker;
			await rm(root, { recursive: true, force: true });
		}
	});
});
