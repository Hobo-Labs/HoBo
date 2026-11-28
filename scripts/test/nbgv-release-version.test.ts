import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	defaultNbgvRunner,
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
	it.skipIf(process.platform === "win32")(
		"runs nbgv when mise removes the host Node directory from PATH",
		() => {
			const fixture = mkdtempSync(join(tmpdir(), "hobo-nbgv-mise-"));
			const bin = join(fixture, "bin");
			const packageDir = join(
				fixture,
				"node_modules",
				"nerdbank-gitversioning",
			);
			const previousPath = process.env.PATH;
			const previousFixture = process.env.HOBO_NBGV_TEST_BIN;
			try {
				mkdirSync(bin, { recursive: true });
				mkdirSync(packageDir, { recursive: true });
				writeFileSync(
					join(fixture, "mise.toml"),
					'[tools]\npnpm = "10.33.4"\n',
				);
				writeFileSync(
					join(bin, "mise"),
					'#!/bin/sh\nif [ "$1" = which ]; then echo /fake/dotnet; exit 0; fi\n[ "$1" = exec ] || exit 1\nshift\n[ "$1" = -- ] || shift\n[ "$1" = -- ] || exit 1\nshift\nPATH="$HOBO_NBGV_TEST_BIN"\nexport PATH\nexec "$@"\n',
					{ mode: 0o755 },
				);
				writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nexec node "$@"\n', {
					mode: 0o755,
				});
				writeFileSync(
					join(packageDir, "main.js"),
					'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["get-version", "HEAD", "--variable", "VersionHeight"])) process.exit(2); process.stdout.write("42");\n',
				);
				process.env.PATH = [bin, previousPath ?? ""].join(delimiter);
				process.env.HOBO_NBGV_TEST_BIN = bin;
				expect(defaultNbgvRunner(fixture)("VersionHeight", "HEAD")).toBe("42");
			} finally {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				if (previousFixture === undefined)
					delete process.env.HOBO_NBGV_TEST_BIN;
				else process.env.HOBO_NBGV_TEST_BIN = previousFixture;
				rmSync(fixture, { recursive: true, force: true });
			}
		},
	);

	it("uses the installed nbgv CLI with the running Node executable", () => {
		const manifest = JSON.parse(
			readFileSync(
				join(root, "node_modules", "nerdbank-gitversioning", "package.json"),
				"utf8",
			),
		);
		expect(manifest.bin.nbgv).toBe("main.js");
		expect(nbgvGetVersionArgv(root, "VersionHeight", "HEAD")).toEqual([
			"exec",
			"--",
			process.execPath,
			join(root, "node_modules", "nerdbank-gitversioning", "main.js"),
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
