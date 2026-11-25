/**
 * Which platforms the CUE auto-download claims to support.
 *
 * Archive selection is tested directly with explicit host values. Unsupported
 * hosts fail before `ensureCueBinary` can reach its network download path, and
 * supported hosts produce the archive names published by CUE.
 */
import { describe, expect, it } from "vitest";

import { cueArchiveName } from "../src/cue.js";

describe("hosts the download supports", () => {
	for (const [platform, expected] of [
		["linux", "linux"],
		["darwin", "darwin"],
		["win32", "windows"],
	] as const) {
		it(`accepts ${platform}`, () => {
			expect(cueArchiveName(platform, "x64")).toBe(
				`cue_v0.14.0_${expected}_amd64.${platform === "win32" ? "zip" : "tar.gz"}`,
			);
		});
	}

	for (const [arch, expected] of [
		["x64", "amd64"],
		["arm64", "arm64"],
	] as const) {
		it(`accepts ${arch}`, () => {
			expect(cueArchiveName("linux", arch)).toBe(
				`cue_v0.14.0_linux_${expected}.tar.gz`,
			);
		});
	}
});

describe("hosts the download refuses", () => {
	it("refuses and names an unsupported platform", () => {
		expect(() => cueArchiveName("sunos", "x64")).toThrow(
			/unsupported platform for CUE download: sunos/,
		);
		expect(() => cueArchiveName("aix", "x64")).toThrow(/aix/);
	});

	it("refuses and names an unsupported architecture", () => {
		expect(() => cueArchiveName("linux", "s390x")).toThrow(
			/unsupported architecture for CUE download: s390x/,
		);
		expect(() => cueArchiveName("linux", "ppc64")).toThrow(/ppc64/);
	});

	it("checks the platform before the architecture", () => {
		expect(() => cueArchiveName("sunos", "s390x")).toThrow(
			/unsupported platform/,
		);
	});
});
