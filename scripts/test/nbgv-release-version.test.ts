import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	fixedTrainAlphaReleaseRef,
	fixedTrainAlphaSemver,
	nbgvGetVersionArgv,
	parseVersionJsonHeightConfig,
} from "../lib/nbgv-release-version.mts";
import { parseReleaseRef } from "../lib/release-version.mts";

const root = join(import.meta.dirname, "..", "..");

const VERSION_JSON = `{
  "version": "0.0.0-alpha.{height}",
  "versionHeightOffset": 3,
  "versionHeightOffsetAppliesTo": "0.0.0-alpha.{height}",
  "publicReleaseRefSpec": []
}`;

describe("version.json height config", () => {
	it("requires alpha height train shape", () => {
		const config = parseVersionJsonHeightConfig(VERSION_JSON);
		expect(config.versionHeightOffset).toBe(3);
	});

	it("rejects stable version bases", () => {
		expect(() =>
			parseVersionJsonHeightConfig(
				'{"version":"1.0.0","versionHeightOffset":0}',
			),
		).toThrow(/0\.0\.0-alpha\.\{height\}/);
	});
});

describe("fixedTrainAlphaSemver", () => {
	const config = parseVersionJsonHeightConfig(VERSION_JSON);

	it("maps nbgv height + offset to npm alpha semver", () => {
		expect(fixedTrainAlphaSemver(0, config)).toBe("0.0.0-alpha.3");
		expect(fixedTrainAlphaSemver(4, config)).toBe("0.0.0-alpha.7");
	});

	it("never maps to npm dist-tag latest", () => {
		const parsed = fixedTrainAlphaReleaseRef(0, config);
		expect(parsed.ref).toBe("v0.0.0-alpha.3");
		expect(parsed.npmDistTag).toBe("alpha");
		expect(parsed.train).toBe("full");
		expect(parseReleaseRef(parsed.ref).semver).toBe(parsed.semver);
	});
});

describe("nbgv get-version argv", () => {
	it("activates the pinned pnpm tool so ignored root config still runs nbgv", () => {
		const toml = readFileSync(join(root, "mise.toml"), "utf8");
		const version = toml.match(/^pnpm\s*=\s*"([^"]+)"/m)?.[1];
		expect(version).toBeTruthy();
		expect(nbgvGetVersionArgv(root, "VersionHeight", "HEAD")).toEqual([
			"exec",
			`pnpm@${version}`,
			"--",
			"pnpm",
			"exec",
			"nbgv",
			"get-version",
			"HEAD",
			"--variable",
			"VersionHeight",
		]);
	});
});

describe("computeFixedTrainReleaseFromGit (injected nbgv)", () => {
	it("uses VersionHeight from nbgv", async () => {
		const { computeFixedTrainReleaseFromGit } = await import(
			"../lib/nbgv-release-version.mts"
		);
		const parsed = computeFixedTrainReleaseFromGit({
			repoRoot: "/tmp/unused",
			config: parseVersionJsonHeightConfig(VERSION_JSON),
			nbgv: (variable) => (variable === "VersionHeight" ? "2" : ""),
		});
		expect(parsed.semver).toBe("0.0.0-alpha.5");
		expect(parsed.npmDistTag).toBe("alpha");
	});
});
