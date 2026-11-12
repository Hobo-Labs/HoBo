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
		expect(source).toMatch(/resolveRegistryDigestForTagWithRetry/u);
		expect(source).toMatch(/tryReusePublishedTag/u);
		expect(source).toMatch(/normalizeRepoDigestLine/u);
	});
});

describe("runDockerPushWithRetry time limits", () => {
	it("stops a stalled push and retries it", () => {
		const timeouts: (number | undefined)[] = [];
		let calls = 0;
		const log: string[] = [];
		runDockerPushWithRetry({
			tag: "ghcr.io/hobo-labs/hobo/hobo-cli:v0.0.0-alpha.149",
			attemptTimeoutMs: 300_000,
			budgetMs: 600_000,
			sleepMs: () => {},
			log: (line) => log.push(line),
			now: () => 0,
			push: (_tag, timeoutMs) => {
				timeouts.push(timeoutMs);
				calls += 1;
				return calls === 1
					? {
							exitCode: null,
							stdout: "abc: Pushing",
							stderr: "",
							timedOut: true,
						}
					: { exitCode: 0, stdout: "digest: sha256:abc", stderr: "" };
			},
		});
		expect(timeouts).toEqual([300_000, 300_000]);
		expect(log[0]).toMatch(/stalled past 300000ms \(attempt 1\/5\)/u);
		expect(log[1]).toBe("abc: Pushing");
	});

	it("gives the last attempt only what is left of the budget", () => {
		let clock = 0;
		const timeouts: (number | undefined)[] = [];
		runDockerPushWithRetry({
			tag: "ghcr.io/x/y:1",
			attemptTimeoutMs: 300_000,
			budgetMs: 400_000,
			sleepMs: (ms) => {
				clock += ms;
			},
			log: () => {},
			now: () => clock,
			push: (_tag, timeoutMs) => {
				timeouts.push(timeoutMs);
				if (timeouts.length === 1) {
					clock += 300_000;
					return { exitCode: null, stdout: "", stderr: "", timedOut: true };
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		// 300 s stalled + 5 s backoff leaves 95 s of the 400 s budget.
		expect(timeouts).toEqual([300_000, 95_000]);
	});

	it("fails with the stall named once the budget is spent", () => {
		let clock = 0;
		const push = vi.fn((_tag: string, timeoutMs?: number) => {
			clock += timeoutMs ?? 0;
			return { exitCode: null, stdout: "", stderr: "", timedOut: true };
		});
		expect(() =>
			runDockerPushWithRetry({
				tag: "ghcr.io/x/y:1",
				attemptTimeoutMs: 300_000,
				budgetMs: 600_000,
				sleepMs: (ms) => {
					clock += ms;
				},
				log: () => {},
				now: () => clock,
				push,
			}),
		).toThrow(
			/docker push ghcr.io\/x\/y:1 timed out after \d+ms \(attempt 2\/5\)/u,
		);
		expect(push).toHaveBeenCalledTimes(2);
	});

	it("counts a timed-out push that also exited 0 as a stall, not a success", () => {
		// spawnSync can report status 0 alongside ETIMEDOUT only if the child
		// exited in the same tick; it is retried, never taken as pushed.
		const push = vi.fn(() => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
			timedOut: true,
		}));
		expect(() =>
			runDockerPushWithRetry({
				tag: "ghcr.io/x/y:1",
				maxAttempts: 2,
				attemptTimeoutMs: 1,
				sleepMs: () => {},
				log: () => {},
				push,
			}),
		).toThrow(/timed out/u);
		expect(push).toHaveBeenCalledTimes(2);
	});

	it("fails at once rather than start an attempt with under a minute left", () => {
		let clock = 0;
		const push = vi.fn(() => {
			clock += 250_000;
			return { exitCode: null, stdout: "", stderr: "", timedOut: true };
		});
		expect(() =>
			runDockerPushWithRetry({
				tag: "ghcr.io/x/y:1",
				attemptTimeoutMs: 250_000,
				budgetMs: 300_000,
				sleepMs: (ms) => {
					clock += ms;
				},
				log: () => {},
				now: () => clock,
				push,
			}),
		).toThrow(/attempt 1\/5/u);
		expect(push).toHaveBeenCalledTimes(1);
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
		const fromTrain =
			"image_id: ${{ fromJSON(needs.release-images.outputs.images) }}";
		expect(publish).toContain(fromTrain);
		expect(publish).toMatch(/max-parallel: 1/u);
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

describe("pushedDigestRef (finding 141)", () => {
	const tag = "ghcr.io/hobo-labs/hobo/hobo-sdk:v0.0.0-alpha.159";
	const digest =
		"sha256:e9e01db3ed33237ceac6cf6b8ba6f5f3335287418739ff6992139f4599ab0a20";

	it("takes the digest docker push printed, under the pushed repository", async () => {
		const { pushedDigestRef } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		// Run 43176733275, ARC pod: RepoDigests[0] was the local name.
		expect(
			pushedDigestRef(
				tag,
				`abc: Layer already exists\nv0.0.0-alpha.159: digest: ${digest} size: 4307`,
				`hobo-sdk@${digest}\n`,
			),
		).toBe(`ghcr.io/hobo-labs/hobo/hobo-sdk@${digest}`);
	});

	it("falls back to the RepoDigests entry for the pushed repository, never the first", async () => {
		const { pushedDigestRef } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		expect(
			pushedDigestRef(
				tag,
				"",
				`hobo-sdk@${digest}\nghcr.io/hobo-labs/hobo/hobo-sdk@${digest}\n`,
			),
		).toBe(`ghcr.io/hobo-labs/hobo/hobo-sdk@${digest}`);
	});

	it("refuses rather than record a reference attest cannot find", async () => {
		const { pushedDigestRef } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		expect(() => pushedDigestRef(tag, "", `hobo-sdk@${digest}\n`)).toThrow(
			/no digest for .*hobo-sdk@sha256/u,
		);
		expect(() => pushedDigestRef(tag, "", "")).toThrow(
			/RepoDigests has no ghcr.io\/hobo-labs\/hobo\/hobo-sdk@ entry \(none\)/u,
		);
	});

	it("produces a line the attest step selects by image id", async () => {
		const { pushedDigestRef } = await import(
			"../ci/push-release-ghcr-images.mts"
		);
		const line = pushedDigestRef(tag, `x: digest: ${digest} size: 1`, "");
		// .github/actions/release-oci-attest: grep -F "/${IMAGE_ID}@"
		expect(line.includes("/hobo-sdk@")).toBe(true);
	});

	it("returns the push output so the digest can be read from it", () => {
		expect(
			runDockerPushWithRetry({
				tag,
				log: () => {},
				push: () => ({
					exitCode: 0,
					stdout: `v: digest: ${digest} size: 1`,
					stderr: "",
				}),
			}),
		).toContain(digest);
	});
});
