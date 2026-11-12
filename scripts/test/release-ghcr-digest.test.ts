import { describe, expect, it, vi } from "vitest";
import {
	assertReleaseImageMatchesBuild,
	assertSha256ImageDigest,
	ghcrDigestRef,
	normalizeRepoDigestLine,
	resolveRegistryDigestForTag,
} from "../lib/release-ghcr-digest.mts";

const DIGEST_A =
	"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B =
	"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_DEAD =
	"sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("release ghcr digest helpers", () => {
	it("formats ghcr digest refs with image name for attest grep", () => {
		expect(ghcrDigestRef("ghcr.io/hobo-labs/hobo/hobo-codegen", DIGEST_A)).toBe(
			`ghcr.io/hobo-labs/hobo/hobo-codegen@${DIGEST_A}`,
		);
	});

	it("rejects digests that are not sha256 plus 64 hex", () => {
		expect(() => assertSha256ImageDigest("sha256:abcd", "test")).toThrow(
			/sha256:\[a-f0-9\]\{64\}/u,
		);
		expect(() => ghcrDigestRef("ghcr.io/x/y", "abcd")).toThrow();
	});

	it("normalizes repo digest lines with full sha256 refs", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-sdk:v0.0.0-alpha.1";
		expect(normalizeRepoDigestLine(tag, DIGEST_A, "hobo-sdk")).toBe(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${DIGEST_A}`,
		);
	});

	it("resolves digest via imagetools inspect hook", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-cli:v0.0.0-alpha.1";
		const inspect = vi.fn(() => ({ digest: DIGEST_B }));
		expect(resolveRegistryDigestForTag(tag, inspect)).toBe(
			`ghcr.io/hobo-labs/hobo/hobo-cli@${DIGEST_B}`,
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
						digest: DIGEST_DEAD,
					},
				}),
			),
		).toEqual({ digest: DIGEST_DEAD });
	});

	it("fails closed when registry revision does not match", () => {
		expect(() =>
			assertReleaseImageMatchesBuild({
				imageId: "hobo-sdk",
				tag: "ghcr.io/x/hobo-sdk:v1",
				digestRef: `ghcr.io/x/hobo-sdk@${DIGEST_A}`,
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
				digestRef: `ghcr.io/x/hobo-sdk@${DIGEST_A}`,
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
