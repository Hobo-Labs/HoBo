import { describe, expect, it } from "vitest";
import { applyScopeToManifest } from "../ci/npm-publish-scope.mts";
import {
	ghcrImageTags,
	npmDistTagFromSemver,
	npmPublishArgs,
	parseReleaseRef,
	releaseImageIdsForTrain,
	releaseSemverFromEnv,
	tryParseReleaseRef,
} from "../lib/release-version.mts";

const ALPHA = "0.0.0-alpha.0";

describe("parseReleaseRef (semver gate)", () => {
	it.each([
		["v0.0.0-alpha.0", "full", ALPHA],
		["sdk-v0.0.0-alpha.0", "sdk", ALPHA],
		["cli-v0.0.0-alpha.0", "cli", ALPHA],
		["v1.2.3", "full", "1.2.3"],
	])("accepts %s", (ref, train, semver) => {
		const parsed = parseReleaseRef(ref);
		expect(parsed.ref).toBe(ref);
		expect(parsed.semver).toBe(semver);
		expect(parsed.train).toBe(train);
		expect(parsed.ghcrTag).toBe(ref);
	});

	it("rejects unrecognized refs", () => {
		expect(() => parseReleaseRef("pr-1684")).toThrow(
			/unrecognized release ref/,
		);
		expect(tryParseReleaseRef("pr-1684")).toBeUndefined();
	});
});

describe("npm dist-tag and publish args", () => {
	it("maps alpha prerelease to npm dist-tag alpha", () => {
		expect(npmDistTagFromSemver(ALPHA)).toBe("alpha");
		expect(parseReleaseRef("v0.0.0-alpha.0").npmDistTag).toBe("alpha");
	});

	it("uses --tag alpha for prerelease publish (never latest)", () => {
		const parsed = parseReleaseRef("sdk-v0.0.0-alpha.0");
		expect(npmPublishArgs("hobo-labs-core-0.0.0-alpha.0.tgz", parsed)).toEqual([
			"publish",
			"hobo-labs-core-0.0.0-alpha.0.tgz",
			"--provenance",
			"--access",
			"public",
			"--tag",
			"alpha",
		]);
	});

	it("omits --tag for stable releases (npm latest)", () => {
		const parsed = parseReleaseRef("v1.0.0");
		expect(npmPublishArgs("pkg.tgz", parsed)).toEqual([
			"publish",
			"pkg.tgz",
			"--provenance",
			"--access",
			"public",
		]);
	});
});

describe("GHCR tags for prereleases", () => {
	it("tags only the release ref, never :latest", () => {
		const parsed = parseReleaseRef("v0.0.0-alpha.0");
		const tags = ghcrImageTags("Hobo-Labs/HoBo", "hobo-sdk", parsed);
		expect(tags).toEqual(["ghcr.io/hobo-labs/hobo/hobo-sdk:v0.0.0-alpha.0"]);
		for (const tag of tags) {
			expect(tag).not.toMatch(/:latest$/);
		}
	});

	it("selects train-specific images", () => {
		expect(releaseImageIdsForTrain("sdk")).toEqual(["hobo-sdk"]);
		expect(releaseImageIdsForTrain("cli")).toEqual(["hobo-cli", "hobo-mcp"]);
	});
});

describe("release semver from env (staging / OCI labels)", () => {
	it("prefers HOBO_RELEASE_SEMVER over git tag ref", () => {
		expect(
			releaseSemverFromEnv({
				HOBO_RELEASE_SEMVER: ALPHA,
				HOBO_RELEASE_VERSION: "v9.9.9",
			}),
		).toBe(ALPHA);
	});

	it("derives semver from v0.0.0-alpha.0 tag", () => {
		expect(
			releaseSemverFromEnv({
				HOBO_RELEASE_VERSION: "v0.0.0-alpha.0",
			}),
		).toBe(ALPHA);
	});

	it("maps a pull request ref to valid staging semver", () => {
		expect(releaseSemverFromEnv({ HOBO_RELEASE_VERSION: "pr-1684" })).toBe(
			"0.0.0-pr.1684",
		);
	});
});

describe("staged npm manifest version", () => {
	it("sets package version to release semver at publish boundary", () => {
		const staged = applyScopeToManifest(
			{ name: "@hobo/core", version: "0.0.1" },
			{
				publicScope: "@hobo-labs",
				packages: { "@hobo/core": "@hobo-labs/core" },
			},
			{ version: ALPHA },
		);
		expect(staged.name).toBe("@hobo-labs/core");
		expect(staged.version).toBe(ALPHA);
	});
});
