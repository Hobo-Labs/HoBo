import { describe, expect, it, vi } from "vitest";
import {
	dockerPushBackoffMs,
	isRetryableDockerPushOutput,
	runDockerPushWithRetry,
} from "../lib/docker-registry-push.mts";

describe("isRetryableDockerPushOutput", () => {
	it("matches GHCR unknown blob failures from release 42101265267", () => {
		expect(
			isRetryableDockerPushOutput(
				'failed to copy: failed to do request: Put "https://ghcr.io/v2/hobo-labs/hobo/hobo-cli/blobs/uploads/...": unknown blob',
			),
		).toBe(true);
	});

	it("rejects auth and manifest errors", () => {
		expect(isRetryableDockerPushOutput("denied: permission denied")).toBe(
			false,
		);
		expect(isRetryableDockerPushOutput("manifest unknown")).toBe(false);
	});
});

describe("dockerPushBackoffMs", () => {
	it("exponential backoff capped at 60s", () => {
		expect(dockerPushBackoffMs(1)).toBe(5_000);
		expect(dockerPushBackoffMs(2)).toBe(10_000);
		expect(dockerPushBackoffMs(5)).toBe(60_000);
	});
});

describe("runDockerPushWithRetry", () => {
	it("retries unknown blob then succeeds", () => {
		const sleeps: number[] = [];
		const attempts: string[] = [];
		let calls = 0;
		runDockerPushWithRetry({
			tag: "ghcr.io/hobo-labs/hobo/hobo-cli:v0.0.0-alpha.10",
			maxAttempts: 4,
			sleepMs: (ms) => {
				sleeps.push(ms);
			},
			push: (tag) => {
				attempts.push(tag);
				calls += 1;
				if (calls < 3) {
					return {
						exitCode: 1,
						stdout: "",
						stderr: "unknown blob",
					};
				}
				return { exitCode: 0, stdout: "digest: sha256:abc", stderr: "" };
			},
		});
		expect(attempts).toHaveLength(3);
		expect(sleeps).toEqual([5_000, 10_000]);
	});

	it("does not retry non-retryable errors", () => {
		const push = vi.fn(() => ({
			exitCode: 1,
			stdout: "",
			stderr: "denied",
		}));
		expect(() =>
			runDockerPushWithRetry({
				tag: "ghcr.io/x/y:1",
				push,
			}),
		).toThrow(/docker push ghcr.io\/x\/y:1 failed/);
		expect(push).toHaveBeenCalledTimes(1);
	});
});

describe("push-release-ghcr-images wiring", () => {
	it("uses runDockerPushWithRetry for registry push", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const source = readFileSync(
			join(import.meta.dirname, "..", "ci/push-release-ghcr-images.mts"),
			"utf8",
		);
		expect(source).toMatch(/runDockerPushWithRetry/u);
		expect(source).not.toMatch(/run\("docker", \["push"/u);
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
