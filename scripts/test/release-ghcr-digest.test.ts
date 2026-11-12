import { describe, expect, it, vi } from "vitest";
import {
	assertReleaseImageMatchesBuild,
	ghcrDigestRef,
	normalizeRepoDigestLine,
	resolveRegistryDigestForTag,
} from "../lib/release-ghcr-digest.mts";

describe("release ghcr digest helpers", () => {
	it("formats ghcr digest refs with image name for attest grep", () => {
		expect(
			ghcrDigestRef("ghcr.io/hobo-labs/hobo/hobo-codegen", "sha256:abcd"),
		).toBe("ghcr.io/hobo-labs/hobo/hobo-codegen@sha256:abcd");
	});

	it("normalizes bare sha256 lines onto the tag name", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-sdk:v0.0.0-alpha.1";
		expect(normalizeRepoDigestLine(tag, "sha256:111", "hobo-sdk")).toBe(
			"ghcr.io/hobo-labs/hobo/hobo-sdk@sha256:111",
		);
	});

	it("resolves digest via imagetools inspect hook", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-cli:v0.0.0-alpha.1";
		const inspect = vi.fn(() => ({ digest: "sha256:beef" }));
		expect(resolveRegistryDigestForTag(tag, inspect)).toBe(
			"ghcr.io/hobo-labs/hobo/hobo-cli@sha256:beef",
		);
		expect(inspect).toHaveBeenCalledWith(tag);
	});

	it("parses buildx imagetools JSON manifest.digest", async () => {
		const { parseImagetoolsInspectStdout } = await import(
			"../lib/release-ghcr-digest.mts"
		);
		expect(
			parseImagetoolsInspectStdout(
				JSON.stringify({
					name: "ghcr.io/hobo-labs/hobo/hobo-sdk:v0.0.0-alpha.1",
					manifest: {
						mediaType: "application/vnd.oci.image.index.v1+json",
						digest: "sha256:deadbeef",
					},
				}),
			),
		).toEqual({ digest: "sha256:deadbeef" });
	});

	it("fails closed when registry revision does not match", () => {
		expect(() =>
			assertReleaseImageMatchesBuild({
				imageId: "hobo-sdk",
				tag: "ghcr.io/x/hobo-sdk:v1",
				digestRef: "ghcr.io/x/hobo-sdk@sha256:1",
				revision: "abc123",
				releaseVersion: "0.0.0-alpha.1",
				labels: {
					"org.opencontainers.image.revision": "wrong",
					"org.opencontainers.image.version": "0.0.0-alpha.1",
				},
			}),
		).toThrow(/revision wrong != expected abc123/u);
	});

	it("accepts matching revision and version labels", () => {
		expect(() =>
			assertReleaseImageMatchesBuild({
				imageId: "hobo-sdk",
				tag: "ghcr.io/x/hobo-sdk:v1",
				digestRef: "ghcr.io/x/hobo-sdk@sha256:1",
				revision: "abc123",
				releaseVersion: "0.0.0-alpha.1",
				labels: {
					"org.opencontainers.image.revision": "abc123",
					"org.opencontainers.image.version": "0.0.0-alpha.1",
				},
			}),
		).not.toThrow();
	});
});
