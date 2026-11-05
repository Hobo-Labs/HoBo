import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	fixedTrainAlphaReleaseRef,
	fixedTrainAlphaSemver,
	parseVersionJsonHeightConfig,
} from "../lib/nbgv-release-version.mts";
import { parseReleaseRef } from "../lib/release-version.mts";

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

describe("release-hobo main train gate (nbgv)", () => {
	const workflow = readFileSync(
		join(import.meta.dirname, "..", "..", ".github/workflows/release-hobo.yml"),
		"utf8",
	);

	it("fetches ts-autocode before pnpm install in Resolve fixed alpha train version", () => {
		const gate = workflow.indexOf("name: Main train release gate (nbgv)");
		expect(gate).toBeGreaterThan(0);
		const resolve = workflow.indexOf(
			"name: Resolve fixed alpha train version",
			gate,
		);
		expect(resolve).toBeGreaterThan(gate);
		const install = workflow.indexOf(
			"pnpm install --frozen-lockfile --config.confirmModulesPurge=false",
			resolve,
		);
		const fetch = workflow.indexOf("pnpm run pins:fetch ts-autocode", resolve);
		expect(fetch).toBeGreaterThan(resolve);
		expect(fetch).toBeLessThan(install);
	});
});
