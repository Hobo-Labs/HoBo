import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	assertReleaseImageMatchesBuild,
	assertSha256ImageDigest,
	ghcrDigestRef,
	imagetoolsInspectTag,
	isImagetoolsRegistryTagNotFound,
	normalizeRepoDigestLine,
	resolveRegistryDigestForTag,
	resolveRegistryDigestForTagWithRetry,
	stderrReferencesExactTag,
} from "../lib/release-ghcr-digest.mts";

const DIGEST_A =
	"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B =
	"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_DEAD =
	"sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function stubSpawnSync(
	status: number,
	stderr: string,
): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, "", stderr],
		stdout: "",
		stderr,
		status,
		signal: null,
	};
}

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

	it("rejects foreign repository prefixes in repo digest lines", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-sdk:v0.0.0-alpha.1";
		const foreign = `evil.io/hobo/hobo-sdk@${DIGEST_A}`;
		expect(() => normalizeRepoDigestLine(tag, foreign, "hobo-sdk")).toThrow(
			/repository mismatch/u,
		);
		expect(() =>
			normalizeRepoDigestLine(
				tag,
				`ghcr.io/hobo-labs/hobo/hobo-sdk@sha256:bad`,
				"hobo-sdk",
			),
		).toThrow(/sha256:\[a-f0-9\]\{64\}/u);
	});

	it("fails closed when imagetools returns success but unparsable JSON", () => {
		const run = vi.fn(() => stubSpawnSync(0, ""));
		run.mockReturnValueOnce({ ...stubSpawnSync(0, ""), stdout: "not-json" });
		expect(() => imagetoolsInspectTag("ghcr.io/x/y:v1", run)).toThrow(
			/unparsable JSON/u,
		);
	});

	it("imagetools inspect fails closed on non-absent errors", () => {
		const run = vi.fn(() => stubSpawnSync(1, "unexpected registry failure"));
		expect(() => imagetoolsInspectTag("ghcr.io/x/y:v1", run)).toThrow(
			/imagetools inspect/u,
		);
	});

	it("rejects tag prefix collisions in stderr", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-cli:v1";
		const longer = "ghcr.io/hobo-labs/hobo/hobo-cli:v10";
		const dotted = "ghcr.io/hobo-labs/hobo/hobo-cli:v1.1";
		const dashed = "ghcr.io/hobo-labs/hobo/hobo-cli:v1-rc";
		const underscored = "ghcr.io/hobo-labs/hobo/hobo-cli:v1_foo";
		expect(stderrReferencesExactTag(`ERROR: ${tag}: not found`, tag)).toBe(
			true,
		);
		expect(stderrReferencesExactTag(`ERROR: ${longer}: not found`, tag)).toBe(
			false,
		);
		for (const other of [longer, dotted, dashed, underscored]) {
			expect(() =>
				imagetoolsInspectTag(
					tag,
					vi.fn(() => stubSpawnSync(1, `ERROR: ${other}: not found`)),
				),
			).toThrow(/imagetools inspect/u);
		}
		expect(() =>
			imagetoolsInspectTag(
				tag,
				vi.fn(() => stubSpawnSync(1, `ERROR: x${tag}: not found`)),
			),
		).toThrow(/imagetools inspect/u);
		expect(() =>
			imagetoolsInspectTag(
				tag,
				vi.fn(() => stubSpawnSync(1, `ERROR: evil/${tag}: not found`)),
			),
		).toThrow(/imagetools inspect/u);
		expect(() =>
			imagetoolsInspectTag(
				tag,
				vi.fn(() => stubSpawnSync(1, `ERROR: ${tag}@${DIGEST_A}: not found`)),
			),
		).toThrow(/imagetools inspect/u);
	});

	it("treats buildx ERROR ref-not-found as absent only for matching refs", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-cli:v1";
		expect(isImagetoolsRegistryTagNotFound(`ERROR: ${tag}: not found`)).toBe(
			true,
		);
		expect(isImagetoolsRegistryTagNotFound("token not found")).toBe(false);
		expect(
			imagetoolsInspectTag(
				tag,
				vi.fn(() => stubSpawnSync(1, `ERROR: ${tag}: not found`)),
			),
		).toBeUndefined();
		expect(() =>
			imagetoolsInspectTag(
				tag,
				vi.fn(() =>
					stubSpawnSync(1, "ERROR: ghcr.io/other/image:v9: not found"),
				),
			),
		).toThrow(/imagetools inspect/u);
	});

	it("treats manifest unknown as absent and name unknown only when tag appears in stderr", () => {
		const tag = "ghcr.io/x/y:v1";
		expect(() =>
			imagetoolsInspectTag(
				tag,
				vi.fn(() => stubSpawnSync(1, "manifest unknown")),
			),
		).toThrow(/imagetools inspect/u);
		expect(
			imagetoolsInspectTag(
				tag,
				vi.fn(() => stubSpawnSync(1, `manifest unknown: ${tag}`)),
			),
		).toBeUndefined();
		expect(() =>
			imagetoolsInspectTag(
				tag,
				vi.fn(() => stubSpawnSync(1, `manifest unknown: ${tag}@${DIGEST_A}`)),
			),
		).toThrow(/imagetools inspect/u);
		expect(() =>
			imagetoolsInspectTag(
				tag,
				vi.fn(() => stubSpawnSync(1, "name unknown")),
			),
		).toThrow(/imagetools inspect/u);
		expect(
			imagetoolsInspectTag(
				tag,
				vi.fn(() => stubSpawnSync(1, `name unknown: ${tag}`)),
			),
		).toBeUndefined();
	});

	it("fails closed on imagetools JSON with labels but no digest", async () => {
		const { parseImagetoolsInspectStdout } = await import(
			"../lib/release-ghcr-digest.mts"
		);
		expect(() =>
			parseImagetoolsInspectStdout(
				JSON.stringify({
					config: { labels: { "io.hobo.release.image": "hobo-sdk" } },
				}),
			),
		).toThrow(/labels without a digest/u);
	});

	it("resolveRegistryDigestForTagWithRetry retries transient inspect errors", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-cli:v1";
		const inspect = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("temporary registry timeout");
			})
			.mockReturnValueOnce({ digest: DIGEST_B });
		const sleepMs = vi.fn();
		const digest = resolveRegistryDigestForTagWithRetry(tag, inspect, {
			maxAttempts: 3,
			delayMs: 1,
			sleepMs,
		});
		expect(digest).toBe(`ghcr.io/hobo-labs/hobo/hobo-cli@${DIGEST_B}`);
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(sleepMs).toHaveBeenCalledTimes(1);
	});

	it("resolveRegistryDigestForTagWithRetry waits until digest appears", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-cli:v1";
		const inspect = vi
			.fn()
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce({ digest: DIGEST_B });
		const sleepMs = vi.fn();
		const digest = resolveRegistryDigestForTagWithRetry(tag, inspect, {
			maxAttempts: 3,
			delayMs: 1,
			sleepMs,
		});
		expect(digest).toBe(`ghcr.io/hobo-labs/hobo/hobo-cli@${DIGEST_B}`);
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(sleepMs).toHaveBeenCalledTimes(1);
	});

	it("resolves digest via imagetools inspect hook", () => {
		const tag = "ghcr.io/hobo-labs/hobo/hobo-cli:v0.0.0-alpha.1";
		const inspect = vi.fn(() => ({ digest: DIGEST_B }));
		expect(resolveRegistryDigestForTag(tag, inspect)).toBe(
			`ghcr.io/hobo-labs/hobo/hobo-cli@${DIGEST_B}`,
		);
		expect(inspect).toHaveBeenCalledWith(tag);
	});

	it("parseImagetoolsInspectStdout rejects malformed manifest.digest", async () => {
		const { parseImagetoolsInspectStdout } = await import(
			"../lib/release-ghcr-digest.mts"
		);
		expect(() =>
			parseImagetoolsInspectStdout(
				JSON.stringify({
					manifest: { digest: "sha256:bad" },
				}),
			),
		).toThrow(/sha256:/u);
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
					"io.hobo.release.image": "hobo-sdk",
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
					"io.hobo.release.image": "hobo-sdk",
					"org.opencontainers.image.revision": "abc123",
					"org.opencontainers.image.version": "0.0.0-alpha.1",
				},
			}),
		).not.toThrow();
	});
});
