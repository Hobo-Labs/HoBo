import { describe, expect, it } from "vitest";

describe("push-release-ghcr-images wiring", () => {
	it("publishes only through hobo deploy: an exported OCI layout, never docker push", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const source = readFileSync(
			join(import.meta.dirname, "..", "ci/push-release-ghcr-images.mts"),
			"utf8",
		);
		expect(source).not.toMatch(/runDockerPushWithRetry/u);
		expect(source).not.toMatch(/"push"/u);
		expect(source).toMatch(/exportReleaseOciLayout/u);
		expect(source).toMatch(/qualifyReleaseCandidate/u);
		expect(source).toMatch(/tryReusePublishedTag/u);
		expect(source).toMatch(/normalizeRepoDigestLine/u);
	});
});

describe("releaseImagesToPublish", () => {
	it("publishes one named image of the main train", async () => {
		const { releaseImagesToPublish } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		expect(releaseImagesToPublish("v0.0.0-alpha.149", "hobo-cli")).toEqual([
			"hobo-cli",
		]);
		expect(releaseImagesToPublish("v0.0.0-alpha.149")).toHaveLength(6);
	});

	it("publishes nothing for an image the train does not ship", async () => {
		const { releaseImagesToPublish } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		expect(releaseImagesToPublish("sdk-v1.2.3", "hobo-cli")).toEqual([]);
		expect(releaseImagesToPublish("sdk-v1.2.3", "hobo-sdk")).toEqual([
			"hobo-sdk",
		]);
	});

	it("refuses an image id it does not know", async () => {
		const { releaseImagesToPublish } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		expect(() => releaseImagesToPublish("v0.0.0-alpha.149", "hobo-cl")).toThrow(
			/unknown release image id: hobo-cl/u,
		);
	});
});

describe("release-hobo publish and attest, one image per job", () => {
	it("publishes each image in its own matrix leg and attests that leg's digest", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const workflow = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				".github/workflows/release-hobo.yml",
			),
			"utf8",
		);
		const job = (id: string, next: string) =>
			workflow.slice(
				workflow.indexOf(`\n  ${id}:\n`),
				workflow.indexOf(`\n  ${next}:\n`),
			);
		const publish = job("release-publish", "release-attest");
		const attest = job("release-attest", "release-npm");
		const resolver = job("release-toolchain-image", "release-oci-build-tag");
		const build = job("release-oci-build-tag", "release-images");
		expect(resolver).toContain(
			"name: Resolve the release toolchain image once",
		);
		expect(resolver).toContain(
			"image_ref: ${{ steps.resolve.outputs.image_ref }}",
		);
		expect(resolver).toContain(
			"node --no-warnings scripts/ci/ensure-ci-worker-image.mts --resolve-digest",
		);
		expect(resolver).toMatch(/timeout-minutes: 15/u);
		expect(resolver).toMatch(
			/permissions:\n\s+contents: read\n\s+packages: read/u,
		);
		for (const block of [build, publish]) {
			expect(block).toContain(
				"needs.release-toolchain-image.result == 'success'",
			);
			expect(block).toMatch(
				/needs: \[[^\]]*\brelease-toolchain-image\b[^\]]*\]/u,
			);
			expect(block).toContain(
				"HOBO_CI_WORKER_IMAGE_REF: ${{ needs.release-toolchain-image.outputs.image_ref }}",
			);
			expect(block).toContain('HOBO_CI_WORKER_PULL_BUDGET_SEC: "540"');
			expect(block).toMatch(
				/name: Ensure digest-pinned content-keyed toolchain image\n\s+timeout-minutes: 10/u,
			);
		}
		const fromTrain =
			"image_id: ${{ fromJSON(needs.release-images.outputs.images) }}";
		expect(build).toMatch(/max-parallel: 6/u);
		expect(build).toContain(
			"HOBO_RELEASE_CANDIDATE_SUFFIX: -${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.image_id }}",
		);
		for (const block of [build, publish]) {
			expect(block).not.toContain("Fetch previous release for affected builds");
			expect(block).not.toContain(
				"needs.release-main-train-gate.outputs.turbo_base",
			);
		}
		expect(publish).toContain(fromTrain);
		expect(publish).toMatch(/max-parallel: 6/u);
		expect(publish).toContain(
			"HOBO_RELEASE_CANDIDATE_SUFFIX: -${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.image_id }}",
		);
		expect(publish).toContain(
			"HOBO_RELEASE_STAGING_ID: ${{ github.run_id }}-${{ github.job }}-${{ matrix.image_id }}-${{ github.run_attempt }}",
		);
		expect(attest).toMatch(/max-parallel: 6/u);
		// 20 for the build and bounded push, plus the hobo CLI build that records
		// the leg's image as release Freight.
		expect(publish).toContain("timeout-minutes: 20");
		expect(publish).toContain(
			"push-release-ghcr-images.mts --image ${{ matrix.image_id }}",
		);
		expect(publish).toContain(
			"name: hobo-release-digest-${{ matrix.image_id }}",
		);
		expect(attest).toContain(fromTrain);
		expect(attest).toContain(
			"name: hobo-release-digest-${{ matrix.image_id }}",
		);
		expect(attest).toContain("digest artifact empty");
		expect(attest).toContain("if: steps.digest.outputs.present == 'true'");
		expect(workflow).not.toContain("name: hobo-release-digests\n");
	});
});

describe("release-images job", () => {
	it("lists exactly the images releaseImageIdsForTrain ships for each train", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { releaseImageIdsForTrain } = await import(
			"../lib/release-version.mts"
		);
		const workflow = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				".github/workflows/release-hobo.yml",
			),
			"utf8",
		);
		const job = workflow.slice(
			workflow.indexOf("\n  release-images:\n"),
			workflow.indexOf("\n  release-publish:\n"),
		);
		const listFor = (pattern: string) => {
			const line = job
				.split("\n")
				.find((row) => row.trim().startsWith(`${pattern})`));
			const json = /images='([^']+)'/u.exec(line ?? "")?.[1];
			return JSON.parse(json ?? "null");
		};
		expect(listFor("sdk-v*")).toEqual([...releaseImageIdsForTrain("sdk")]);
		expect(listFor("cli-v*")).toEqual([...releaseImageIdsForTrain("cli")]);
		expect(listFor("*")).toEqual([...releaseImageIdsForTrain("full")]);
	});
});

describe("ociReleaseArtifacts", () => {
	const digest = `sha256:${"b".repeat(64)}`;

	it("names each pushed GHCR image by digest for registry-verified Freight", async () => {
		const { ociReleaseArtifacts } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		expect(
			ociReleaseArtifacts([`ghcr.io/hobo-labs/hobo/hobo-sdk@${digest}`]),
		).toEqual([
			{
				name: "hobo-sdk",
				kind: "ARTIFACT_KIND_OCI_IMAGE",
				digest,
				coordinate: `ghcr.io/hobo-labs/hobo/hobo-sdk@${digest}`,
				ecosystem: "oci",
				// The registry decides index vs manifest; @hobo/cd verifies the digest.
				mediaType: "",
			},
		]);
	});

	it("refuses a digest line that is not <repo>@sha256:<hex>", async () => {
		const { ociReleaseArtifacts } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		expect(() =>
			ociReleaseArtifacts(["ghcr.io/hobo-labs/hobo/hobo-sdk:v1"]),
		).toThrow(/not a pushed digest/);
	});
});

describe("releaseTagsOf (the tag the oci-candidate realizer owns)", () => {
	it("is the release ref's one GHCR tag, the tag docker push wrote, for the recorded digest", async () => {
		const { releaseTagsOf } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		const digest = `sha256:${"b".repeat(64)}`;
		expect(
			releaseTagsOf("v0.0.0-alpha.3", "Hobo-Labs/HoBo", [
				`ghcr.io/hobo-labs/hobo/hobo-sdk@${digest}`,
			]),
		).toBe("v0.0.0-alpha.3");
	});
});

// ── OCI image layout export, read by digest (offline fixtures) ─────────────

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

async function layoutFixture(options: {
	platforms?: readonly string[];
	present?: readonly string[];
	attestation?: boolean;
	index?: boolean;
	labels?: Record<string, string>;
}) {
	const { createHash } = await import("node:crypto");
	const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "hobo-oci-layout-"));
	mkdirSync(join(dir, "blobs", "sha256"), { recursive: true });
	const put = (bytes: Uint8Array, write = true) => {
		const hex = createHash("sha256").update(bytes).digest("hex");
		if (write) writeFileSync(join(dir, "blobs", "sha256", hex), bytes);
		return { digest: `sha256:${hex}`, size: bytes.byteLength };
	};
	const platforms = options.platforms ?? ["amd64"];
	const children = platforms.map((arch) => {
		const present = (options.present ?? platforms).includes(arch);
		const config = put(
			Buffer.from(
				JSON.stringify({
					architecture: arch,
					os: "linux",
					config: { Labels: options.labels },
				}),
			),
			present,
		);
		const layer = put(
			Uint8Array.from(
				{ length: 300 },
				(_, i) => (i * 13 + arch.charCodeAt(1)) % 256,
			),
			present,
		);
		const manifest = Buffer.from(
			JSON.stringify({
				schemaVersion: 2,
				mediaType: OCI_MANIFEST,
				config: {
					mediaType: "application/vnd.oci.image.config.v1+json",
					...config,
				},
				layers: [
					{
						mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
						...layer,
					},
				],
			}),
		);
		return {
			mediaType: OCI_MANIFEST,
			...put(manifest, present),
			platform: { architecture: arch, os: "linux" },
		};
	});
	const attestation = options.attestation
		? [
				{
					mediaType: OCI_MANIFEST,
					...put(
						Buffer.from(
							JSON.stringify({
								schemaVersion: 2,
								mediaType: OCI_MANIFEST,
								config: {
									mediaType: "application/vnd.oci.image.config.v1+json",
									...put(Buffer.from("{}")),
								},
								layers: [],
							}),
						),
					),
					annotations: { "vnd.docker.reference.type": "attestation-manifest" },
				},
			]
		: [];
	let root = children[0];
	if (options.index) {
		const index = Buffer.from(
			JSON.stringify({
				schemaVersion: 2,
				mediaType: OCI_INDEX,
				manifests: [...children, ...attestation],
			}),
		);
		root = {
			mediaType: OCI_INDEX,
			...put(index),
			platform: { architecture: "", os: "" },
		};
	}
	writeFileSync(join(dir, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
	writeFileSync(
		join(dir, "index.json"),
		JSON.stringify({ schemaVersion: 2, manifests: [root] }),
	);
	return { dir, root, children };
}

describe("verified OCI handoff", () => {
	const expected = {
		imageId: "hobo-sdk",
		revision: "a".repeat(40),
		version: "1.2.3",
	};
	const labels = {
		"io.hobo.release.image": expected.imageId,
		"org.opencontainers.image.revision": expected.revision,
		"org.opencontainers.image.version": expected.version,
	};
	it("verifies each platform and requires labels", async () => {
		const { verifyReleaseOciHandoff } = await import(
			"../ci/release-oci-handoff.mts"
		);
		const { rmSync } = await import("node:fs");
		const multi = await layoutFixture({
			platforms: ["amd64", "arm64"],
			labels,
		});
		const missing = await layoutFixture({});
		try {
			if (!multi.root) throw new Error("fixture has no root");
			expect(verifyReleaseOciHandoff(multi.dir, expected).digest).toBe(
				multi.root.digest,
			);
			expect(() => verifyReleaseOciHandoff(missing.dir, expected)).toThrow();
		} finally {
			rmSync(multi.dir, { recursive: true, force: true });
			rmSync(missing.dir, { recursive: true, force: true });
		}
	});
	it("rejects a reused registry tag whose digest differs from the verified image", async () => {
		const { buildReleaseGhcrImages } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		const { rmSync } = await import("node:fs");
		const fixture = await layoutFixture({ labels });
		const oldDir = process.env.HOBO_RELEASE_OCI_LAYOUT_DIR;
		const oldRevision = process.env.HOBO_RELEASE_REVISION;
		process.env.HOBO_RELEASE_OCI_LAYOUT_DIR = fixture.dir;
		process.env.HOBO_RELEASE_REVISION = expected.revision;
		const repository = "ghcr.io/hobo-labs/hobo/hobo-sdk";
		try {
			const options = {
				releaseRef: "sdk-v1.2.3",
				repository: "hobo-labs/hobo",
				imageId: expected.imageId,
			};
			expect(() =>
				buildReleaseGhcrImages({
					...options,
					reusePublishedTag: () => `${repository}@sha256:${"f".repeat(64)}`,
				}),
			).toThrow(
				/existing registry digest does not match verified OCI handoff/u,
			);
			if (!fixture.root?.digest) throw new Error("fixture has no root digest");
			const digest = fixture.root.digest;
			expect(
				buildReleaseGhcrImages({
					...options,
					reusePublishedTag: () => `${repository}@${digest}`,
				}),
			).toEqual([{ id: expected.imageId, line: `${repository}@${digest}` }]);
		} finally {
			if (oldDir === undefined) delete process.env.HOBO_RELEASE_OCI_LAYOUT_DIR;
			else process.env.HOBO_RELEASE_OCI_LAYOUT_DIR = oldDir;
			if (oldRevision === undefined) delete process.env.HOBO_RELEASE_REVISION;
			else process.env.HOBO_RELEASE_REVISION = oldRevision;
			rmSync(fixture.dir, { recursive: true, force: true });
		}
	});
	it("accepts the verified gate image and rejects altered inputs", async () => {
		const { verifyReleaseOciHandoff } = await import(
			"../ci/release-oci-handoff.mts"
		);
		const fixture = await layoutFixture({ labels });
		try {
			const result = verifyReleaseOciHandoff(fixture.dir, expected);
			expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
			expect(() =>
				verifyReleaseOciHandoff(fixture.dir, {
					...expected,
					imageId: "hobo-cli",
				}),
			).toThrow();
			expect(() =>
				verifyReleaseOciHandoff(fixture.dir, {
					...expected,
					revision: "b".repeat(40),
				}),
			).toThrow();
			expect(() =>
				verifyReleaseOciHandoff(fixture.dir, { ...expected, version: "1.2.4" }),
			).toThrow();
			const { writeFileSync } = await import("node:fs");
			const last = result.blobs.at(-1);
			if (!last) throw new Error("fixture has no blobs");
			writeFileSync(last.path, "corrupted");
			expect(() => verifyReleaseOciHandoff(fixture.dir, expected)).toThrow();
		} finally {
			const { rmSync } = await import("node:fs");
			rmSync(fixture.dir, { recursive: true, force: true });
		}
	});
});

describe("readOciLayout (the image the oci-candidate realizer pushes)", () => {
	it("reads a single-platform image: root manifest first, then config and layers, each re-hashed", async () => {
		const { readOciLayout } = await import("../ci/build-release-oci-image.mts");
		const { root, dir } = await layoutFixture({});
		const layout = readOciLayout(dir);
		expect(layout.digest).toBe(root?.digest);
		expect(layout.mediaType).toBe(OCI_MANIFEST);
		expect(layout.size).toBe(root?.size);
		expect(layout.blobs).toHaveLength(3);
		expect(layout.blobs[0]?.digest).toBe(root?.digest);
	});

	it("publishes a complete index as the index", async () => {
		const { readOciLayout } = await import("../ci/build-release-oci-image.mts");
		const { root, dir } = await layoutFixture({
			platforms: ["amd64", "arm64"],
			index: true,
		});
		const layout = readOciLayout(dir);
		expect(layout.digest).toBe(root?.digest);
		expect(layout.mediaType).toBe(OCI_INDEX);
		expect(layout.blobs).toHaveLength(7);
	});

	it("publishes the one complete platform of an index saved from one platform, never the attestation", async () => {
		const { readOciLayout } = await import("../ci/build-release-oci-image.mts");
		const { children, dir } = await layoutFixture({
			platforms: ["amd64", "arm64"],
			present: ["amd64"],
			attestation: true,
			index: true,
		});
		expect(readOciLayout(dir).digest).toBe(children[0]?.digest);
	});

	it("refuses a missing layer or a blob that does not hash to its name (nothing substituted)", async () => {
		const { readOciLayout } = await import("../ci/build-release-oci-image.mts");
		const { rmSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const missing = await layoutFixture({});
		rmSync(readOciLayout(missing.dir).blobs[2]?.path ?? "");
		expect(() => readOciLayout(missing.dir)).toThrow(/missing blobs/u);
		const tampered = await layoutFixture({});
		writeFileSync(readOciLayout(tampered.dir).blobs[2]?.path ?? "", "other");
		expect(() => readOciLayout(tampered.dir)).toThrow(/hashes to/u);
		expect(() => readOciLayout(join(tampered.dir, "blobs"))).toThrow(
			/not an OCI image layout/u,
		);
	});
});

describe("dockerOciSaveSupport (the host docker save must run on)", () => {
	it("refuses a daemon older than Docker 25, whose save is not an OCI layout", async () => {
		const { dockerOciSaveSupport } = await import(
			"../ci/build-release-oci-image.mts"
		);
		expect(() => dockerOciSaveSupport("24.0.9", "[]")).toThrow(
			/Docker 25 or later.*24\.0\.9/u,
		);
		expect(() => dockerOciSaveSupport("", "[]")).toThrow(/Docker 25/u);
	});

	it("reports whether the containerd image store compresses the saved layers", async () => {
		const { dockerOciSaveSupport } = await import(
			"../ci/build-release-oci-image.mts"
		);
		expect(
			dockerOciSaveSupport(
				"27.3.1",
				'[["driver-type","io.containerd.snapshotter.v1"]]',
			),
		).toEqual({ serverVersion: "27.3.1", compressedLayers: true });
		const classic = dockerOciSaveSupport(
			"25.0.0",
			'[["Backing Filesystem","extfs"]]',
		);
		expect(classic.compressedLayers).toBe(false);
	});
});

describe("publishReleaseGhcrImages (release Freight for hobo deploy)", () => {
	it("records a built image from the artifact store at its GHCR coordinate, with every blob, the release tag and the mount source", async () => {
		const { readOciLayout } = await import("../ci/build-release-oci-image.mts");
		const { publishReleaseGhcrImages, releaseMountFrom } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		const { dir } = await layoutFixture({});
		const layout = readOciLayout(dir);
		const line = `ghcr.io/hobo-labs/hobo/hobo-cli@${layout.digest}`;
		const reused = `ghcr.io/hobo-labs/hobo/hobo-sdk@sha256:${"b".repeat(64)}`;
		let registry: unknown;
		let labels: unknown;
		let blobs = 0;
		await publishReleaseGhcrImages(
			{
				releaseRef: "v0.0.0-alpha.3",
				repository: "Hobo-Labs/HoBo",
				freightHome: "/tmp/cd",
				images: [
					{ id: "hobo-cli", line, layout, layoutDir: dir },
					{ id: "hobo-sdk", line: reused },
				],
			},
			async (input) => {
				registry = input.registry;
				labels = input.labels;
				for (const _blob of input.blobs ?? []) blobs++;
				return {
					freightId: "f",
					verdict: { outcome: "qualified", codes: [], message: "" },
				};
			},
		);
		expect(registry).toEqual([
			{
				name: "hobo-cli",
				kind: "ARTIFACT_KIND_OCI_IMAGE",
				digest: layout.digest,
				coordinate: line,
				ecosystem: "store",
				mediaType: OCI_MANIFEST,
				sizeBytes: String(layout.size),
			},
			expect.objectContaining({ name: "hobo-sdk", ecosystem: "oci" }),
		]);
		expect(blobs).toBe(3);
		expect(labels).toMatchObject({
			"hobo.cd/oci.tags": "v0.0.0-alpha.3",
			"hobo.cd/oci.mount-from": "hobo-labs/hobo/hobo-ci-worker",
		});
		expect(releaseMountFrom("Hobo-Labs/HoBo")).toBe(
			"hobo-labs/hobo/hobo-ci-worker",
		);
	});

	it("refuses a digest line that does not name the layout root", async () => {
		const { storedOciReleaseArtifact } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		expect(() =>
			storedOciReleaseArtifact(
				`ghcr.io/hobo-labs/hobo/hobo-cli@sha256:${"e".repeat(64)}`,
				{
					digest: `sha256:${"f".repeat(64)}`,
					mediaType: OCI_MANIFEST,
					size: 1,
				},
			),
		).toThrow(/does not name the layout root/u);
	});
});
