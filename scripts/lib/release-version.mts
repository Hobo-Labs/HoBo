/** Parse HoBo release git refs (v*, sdk-v*, cli-v*, code-v*) into semver + npm dist-tag. */

export type ReleaseTrain = "full" | "sdk" | "cli" | "code";

export type ParsedReleaseRef = {
	/** Original git tag or dispatch input (e.g. v0.0.0-alpha.0). */
	ref: string;
	/** Semver version without train prefix (e.g. 0.0.0-alpha.0). */
	semver: string;
	/** npm dist-tag: prerelease id (alpha) or `latest` for stable releases. */
	npmDistTag: string;
	/** GHCR tag (same as ref — never `:latest` for prereleases). */
	ghcrTag: string;
	train: ReleaseTrain;
};

const TRAIN_PREFIXES: { prefix: string; train: ReleaseTrain }[] = [
	{ prefix: "sdk-v", train: "sdk" },
	{ prefix: "cli-v", train: "cli" },
	{ prefix: "code-v", train: "code" },
	{ prefix: "v", train: "full" },
];

/** Semver 2.0 core + optional prerelease/build (no leading v). */
export const SEMVER_CORE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*|\d+)\.(0|[1-9]\d*|\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function assertSemver(version: string): void {
	if (!SEMVER_CORE.test(version)) {
		throw new Error(`invalid semver: ${version}`);
	}
}

export function npmDistTagFromSemver(semver: string): string {
	assertSemver(semver);
	const match = SEMVER_CORE.exec(semver);
	const prerelease = match?.[4];
	if (!prerelease) return "latest";
	const id = prerelease.split(".")[0] ?? "";
	if (!id) {
		throw new Error(`invalid prerelease id in ${semver}`);
	}
	return id;
}

export function parseReleaseRef(ref: string): ParsedReleaseRef {
	const trimmed = ref.trim();
	if (!trimmed) {
		throw new Error("release ref required");
	}
	for (const { prefix, train } of TRAIN_PREFIXES) {
		if (!trimmed.startsWith(prefix)) continue;
		const semver = trimmed.slice(prefix.length);
		assertSemver(semver);
		return {
			ref: trimmed,
			semver,
			npmDistTag: npmDistTagFromSemver(semver),
			ghcrTag: trimmed,
			train,
		};
	}
	throw new Error(`unrecognized release ref: ${ref}`);
}

export function tryParseReleaseRef(ref: string): ParsedReleaseRef | undefined {
	try {
		return parseReleaseRef(ref);
	} catch {
		return undefined;
	}
}

/** CI staging refs (PR / merge queue / dispatch) → valid semver for npm pack + OCI labels. */
export function stagingSemverFromRef(ref: string): string | undefined {
	const trimmed = ref.trim();
	const pr = /^pr-(.+)$/.exec(trimmed);
	if (pr) {
		const suffix = pr[1] ?? "";
		if (/^[1-9]\d*$/.test(suffix)) {
			return `0.0.0-pr.${suffix}`;
		}
		const slug = suffix
			.toLowerCase()
			.replace(/[^0-9a-z-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		if (!slug) {
			throw new Error(`invalid pr staging ref: ${ref}`);
		}
		const version = `0.0.0-pr.${slug}`;
		assertSemver(version);
		return version;
	}
	const merge = /^merge-(.+)$/.exec(trimmed);
	if (merge) {
		const slug = (merge[1] ?? "")
			.toLowerCase()
			.replace(/[^0-9a-z-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40);
		if (!slug) {
			throw new Error(`invalid merge staging ref: ${ref}`);
		}
		const version = `0.0.0-merge.${slug}`;
		assertSemver(version);
		return version;
	}
	return undefined;
}

export function releaseSemverFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (env.HOBO_RELEASE_SEMVER?.trim()) {
		assertSemver(env.HOBO_RELEASE_SEMVER.trim());
		return env.HOBO_RELEASE_SEMVER.trim();
	}
	const ref = env.HOBO_RELEASE_VERSION?.trim() ?? env.GITHUB_REF_NAME?.trim();
	const staged = ref ? stagingSemverFromRef(ref) : undefined;
	if (staged) return staged;
	if (ref) return parseReleaseRef(ref).semver;
	return "dev";
}

export const FULL_RELEASE_IMAGE_IDS = [
	"hobo-sdk",
	"hobo-codegen",
	"hobo-cli",
	"hobo-mcp",
	"hobo-ci-serve",
	"hobo-site",
] as const;

export function releaseImageIdsForTrain(
	train: ReleaseTrain,
): readonly string[] {
	switch (train) {
		case "sdk":
			return ["hobo-sdk"];
		case "cli":
			return ["hobo-cli", "hobo-mcp"];
		case "code":
			return ["hobo-code"];
		default:
			return FULL_RELEASE_IMAGE_IDS;
	}
}

export function ghcrImageTags(
	repository: string,
	imageId: string,
	parsed: ParsedReleaseRef,
): string[] {
	const owner =
		repository.toLowerCase().split("/")[0] ?? repository.toLowerCase();
	const versionTag = `ghcr.io/${owner}/hobo/${imageId}:${parsed.ghcrTag}`;
	return [versionTag];
}

export function npmPublishArgs(
	tarballFile: string,
	parsed: ParsedReleaseRef,
): string[] {
	const args = ["publish", tarballFile, "--provenance", "--access", "public"];
	if (parsed.npmDistTag !== "latest") {
		args.push("--tag", parsed.npmDistTag);
	}
	return args;
}
