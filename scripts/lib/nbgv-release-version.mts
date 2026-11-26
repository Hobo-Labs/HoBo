/** Nerdbank.GitVersioning helpers for the fixed alpha release train. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensureNbgvToolchain, nbgvMiseExecEnv } from "./nbgv-toolchain.mts";
import {
	npmDistTagFromSemver,
	type ParsedReleaseRef,
	parseReleaseRef,
} from "./release-version.mts";

export type VersionJsonHeightConfig = {
	versionHeightOffset: number;
	versionHeightOffsetAppliesTo?: string;
};

const versionJsonHeightSchema = z
	.object({
		version: z.literal("0.0.0-alpha.{height}"),
		versionHeightOffset: z.number().int().nonnegative(),
		versionHeightOffsetAppliesTo: z.string().optional(),
	})
	.transform((value) => {
		const config: VersionJsonHeightConfig = {
			versionHeightOffset: value.versionHeightOffset,
		};
		if (value.versionHeightOffsetAppliesTo !== undefined) {
			config.versionHeightOffsetAppliesTo = value.versionHeightOffsetAppliesTo;
		}
		return config;
	});

export function parseVersionJsonHeightConfig(
	versionJsonText: string,
): VersionJsonHeightConfig {
	const parsed = versionJsonHeightSchema.safeParse(JSON.parse(versionJsonText));
	if (!parsed.success) {
		throw new Error(
			`version.json must declare 0.0.0-alpha.{height} train: ${parsed.error.message}`,
		);
	}
	return parsed.data;
}

export function loadVersionJsonHeightConfig(
	repoRoot: string,
): VersionJsonHeightConfig {
	return parseVersionJsonHeightConfig(
		readFileSync(join(repoRoot, "version.json"), "utf8"),
	);
}

export function fixedTrainAlphaSemver(
	versionHeight: number,
	config: VersionJsonHeightConfig,
): string {
	if (!Number.isInteger(versionHeight) || versionHeight < 0) {
		throw new Error(`invalid version height: ${versionHeight}`);
	}
	const semver = `0.0.0-alpha.${versionHeight + config.versionHeightOffset}`;
	const distTag = npmDistTagFromSemver(semver);
	if (distTag !== "alpha") {
		throw new Error(
			`fixed train semver must map to npm dist-tag alpha, got ${distTag}`,
		);
	}
	if (
		semver.includes("+") ||
		/^0\.0\.0$/.test(semver) ||
		!semver.includes("-alpha.")
	) {
		throw new Error(`refusing non-prerelease semver ${semver}`);
	}
	return semver;
}

export function fixedTrainAlphaReleaseRef(
	versionHeight: number,
	config: VersionJsonHeightConfig,
): ParsedReleaseRef {
	const semver = fixedTrainAlphaSemver(versionHeight, config);
	const tag = `v${semver}`;
	return parseReleaseRef(tag);
}

export type NbgvRunner = (variable: string, commitIsh?: string) => string;

function pinnedPnpmTool(repoRoot: string): string {
	const toml = readFileSync(join(repoRoot, "mise.toml"), "utf8");
	let inTools = false;
	for (const line of toml.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "[tools]") {
			inTools = true;
			continue;
		}
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			inTools = false;
			continue;
		}
		if (!inTools || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^pnpm\s*=\s*"([^"]+)"/);
		if (match?.[1]) return `pnpm@${match[1]}`;
	}
	throw new Error("root mise.toml does not pin pnpm");
}

export function nbgvGetVersionArgv(
	repoRoot: string,
	variable: string,
	commitIsh = "HEAD",
): readonly string[] {
	return [
		"exec",
		pinnedPnpmTool(repoRoot),
		"--",
		"pnpm",
		"exec",
		"nbgv",
		"get-version",
		commitIsh,
		"--variable",
		variable,
	];
}

export function defaultNbgvRunner(repoRoot: string): NbgvRunner {
	ensureNbgvToolchain(repoRoot);
	return (variable, commitIsh = "HEAD") => {
		const args = [...nbgvGetVersionArgv(repoRoot, variable, commitIsh)];
		const result = spawnSync("mise", args, {
			cwd: repoRoot,
			encoding: "utf8",
			env: nbgvMiseExecEnv(repoRoot),
		});
		if (result.status !== 0) {
			throw new Error(
				`nbgv get-version --variable ${variable} failed: ${result.stderr || result.stdout}`,
			);
		}
		return (result.stdout ?? "").trim();
	};
}

export function computeFixedTrainReleaseFromGit(input: {
	repoRoot: string;
	commitIsh?: string;
	nbgv?: NbgvRunner;
	config?: VersionJsonHeightConfig;
}): ParsedReleaseRef {
	const repoRoot = input.repoRoot;
	const config = input.config ?? loadVersionJsonHeightConfig(repoRoot);
	const nbgv = input.nbgv ?? defaultNbgvRunner(repoRoot);
	const commitIsh = input.commitIsh ?? "HEAD";
	const heightText = nbgv("VersionHeight", commitIsh);
	const height = Number(heightText);
	if (!Number.isInteger(height) || height < 0) {
		throw new Error(
			`nbgv VersionHeight must be a non-negative integer, got ${heightText}`,
		);
	}
	return fixedTrainAlphaReleaseRef(height, config);
}
