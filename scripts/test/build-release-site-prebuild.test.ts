import { describe, expect, it } from "vitest";
import {
	RELEASE_SITE_PREBUILD_FILTER,
	releaseSitePrebuildTurboArgs,
} from "../ci/build-release-site-prebuild.mts";

describe("release site prebuild turbo args", () => {
	it("builds the hobo-site workspace closure when base matches HEAD", () => {
		expect(releaseSitePrebuildTurboArgs("/tmp", "")).toEqual([
			"exec",
			"turbo",
			"run",
			"build",
			`--filter=${RELEASE_SITE_PREBUILD_FILTER}`,
		]);
	});
});
