import { describe, expect, it } from "vitest";
import { releaseSitePrebuildTurboArgs } from "../ci/build-release-site-prebuild.mts";

describe("release site prebuild turbo args", () => {
	it("falls back to ts-autocode-grounding package filter when base matches HEAD", () => {
		expect(releaseSitePrebuildTurboArgs("/tmp", "")).toEqual([
			"exec",
			"turbo",
			"run",
			"build",
			"--filter=ts-autocode-grounding...",
		]);
	});
});
