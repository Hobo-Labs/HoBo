import { describe, expect, it } from "vitest";
import {
	publishRunnerImageReleaseTag,
	runnerImageReleaseTag,
} from "../../../scripts/ci/push-ci-runner-image-ghcr.mts";
import { RUNNER_IMAGE_RELEASE_TAG_PATTERN } from "../src/runner-fleet-delivery.js";

const release = new RegExp(RUNNER_IMAGE_RELEASE_TAG_PATTERN, "u");

describe("runner image release tags for HoBo CD's OCI source", () => {
	it("runnerImageReleaseTag stamps the publish time ahead of the content key, matching the source's allowPattern", () => {
		const tag = runnerImageReleaseTag(
			"v0123456789ab",
			new Date("2026-11-12T09:30:05.999Z"),
		);
		expect(tag).toBe("release-20261112093005-v0123456789ab");
		expect(release.test(tag)).toBe(true);
	});

	it("later publishes sort after earlier ones (lexical selection is publish order)", () => {
		const older = runnerImageReleaseTag(
			"vffffffffffff",
			new Date("2026-11-12T09:30:05Z"),
		);
		const newer = runnerImageReleaseTag(
			"v000000000000",
			new Date("2026-11-12T09:30:06Z"),
		);
		expect([newer, older].sort()).toEqual([older, newer]);
	});

	it("runnerImageReleaseTag refuses anything but a content-keyed version", () => {
		expect(() => runnerImageReleaseTag("local", new Date())).toThrow(
			/content-keyed/u,
		);
	});

	it("publishRunnerImageReleaseTag tags and pushes once, only for a version GHCR did not have", () => {
		const calls: string[][] = [];
		const run = (cmd: string, args: string[]) => {
			calls.push([cmd, ...args]);
			return 0;
		};
		const fresh = publishRunnerImageReleaseTag({
			image: "hobo-ci-worker:v0123456789ab",
			remoteRepository: "ghcr.io/hobo-labs/hobo/hobo-ci-worker",
			version: "v0123456789ab",
			versionWasPublished: false,
			now: new Date("2026-11-12T09:30:05Z"),
			run,
		});
		expect(fresh).toEqual({
			published:
				"ghcr.io/hobo-labs/hobo/hobo-ci-worker:release-20261112093005-v0123456789ab",
		});
		expect(calls).toEqual([
			[
				"docker",
				"tag",
				"hobo-ci-worker:v0123456789ab",
				"ghcr.io/hobo-labs/hobo/hobo-ci-worker:release-20261112093005-v0123456789ab",
			],
			[
				"docker",
				"push",
				"ghcr.io/hobo-labs/hobo/hobo-ci-worker:release-20261112093005-v0123456789ab",
			],
		]);

		calls.length = 0;
		const again = publishRunnerImageReleaseTag({
			image: "hobo-ci-worker:v0123456789ab",
			remoteRepository: "ghcr.io/hobo-labs/hobo/hobo-ci-worker",
			version: "v0123456789ab",
			versionWasPublished: true,
			now: new Date("2026-11-12T10:00:00Z"),
			run,
		});
		expect(again).toEqual({ skipped: "already-released" });
		expect(calls).toEqual([]);
	});

	it("a failed release push is reported, never thrown (the image push already succeeded)", () => {
		const outcome = publishRunnerImageReleaseTag({
			image: "hobo-ci-worker:v0123456789ab",
			remoteRepository: "ghcr.io/hobo-labs/hobo/hobo-ci-worker",
			version: "v0123456789ab",
			versionWasPublished: false,
			now: new Date("2026-11-12T09:30:05Z"),
			run: (_cmd, args) => (args[0] === "push" ? 1 : 0),
		});
		expect(outcome).toEqual({ skipped: "push-failed" });
	});
});
