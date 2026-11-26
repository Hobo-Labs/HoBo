/**
 * `pins:bump` of an asset pin: move it to another release.
 *
 * A release lists its digests in `SHA256SUMS`. The convention that makes a
 * bump mechanical is `<pin name>-<target>` for each executable
 * (`mirror-linux-x64`), or, where the release ships Go-named archives
 * instead, `<pin name>_<tag>_<goos>_<goarch>.tar.gz` with the executable as
 * one member. A bump downloads every file it pins and checks it against the
 * published sum, and unpacks an archive's member, so a pin is never written
 * from a list alone.
 *
 * Erasable TypeScript with node builtins only.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import {
	type AssetFile,
	type AssetPin,
	checkRepoUrl,
	isReleaseTag,
	type Pins,
	PinsError,
	parsePins,
} from "./pins.ts";
import { extractMember } from "./pins-archive.ts";
import { type AssetContext, SUMS } from "./pins-asset-ops.ts";
import {
	goArchiveName,
	parseSums,
	releaseBase,
	serializePins,
} from "./pins-assets.ts";
import { prepareCache } from "./pins-cache.ts";
import { fetchText, fetchVerified } from "./pins-fetch.ts";
import { sameRepo } from "./pins-repo-url.ts";

/** The targets a release is expected to publish when its pin has none yet. */
const DEFAULT_TARGETS = ["linux-x64", "linux-arm64"] as const;

function oldEntries(pin: AssetPin | null): string[] {
	return pin === null
		? []
		: [...new Set(Object.values(pin.files).map((file) => file.entry))];
}

export interface BumpOptions {
	/** `--repo`: the repository that publishes the release. */
	readonly repo: string | undefined;
	/** `--drop`: targets the new release is allowed to stop publishing. */
	readonly drop: readonly string[];
	/** `--entry`: rename the file the verified bytes are kept and run under. */
	readonly entry: string | undefined;
	/** `--member`: the archive member to run, when the release ships archives. */
	readonly member: string | undefined;
	readonly allowLocal: boolean;
}

export interface Bumped {
	readonly text: string;
	/** What to print: the move, then what was kept and what was dropped. */
	readonly lines: readonly string[];
}

interface TargetPlan {
	readonly keep: string[];
	readonly dropped: readonly string[];
	readonly unpublished: string[];
}

/**
 * The file a release publishes for `target`: the bare executable
 * `<name>-<target>`, else the Go-style archive `<name>_<tag>_<os>_<arch>.tar.gz`
 * that mirror.cloud's release workflow publishes.
 */
function publishedFor(
	name: string,
	tag: string,
	target: string,
	sums: ReadonlyMap<string, string>,
): { readonly file: string; readonly archive: boolean } | undefined {
	if (sums.has(`${name}-${target}`)) {
		return { file: `${name}-${target}`, archive: false };
	}
	const archive = goArchiveName(name, tag, target);
	return archive !== undefined && sums.has(archive)
		? { file: archive, archive: true }
		: undefined;
}

/**
 * Refuse a bump that would lose a build without being told to: every target
 * the pin has must be published by the release, or named in `--drop`.
 */
function planTargets(
	name: string,
	tag: string,
	pin: AssetPin | null,
	sums: ReadonlyMap<string, string>,
	drop: readonly string[],
): TargetPlan {
	const listed = (target: string): boolean =>
		publishedFor(name, tag, target, sums) !== undefined;
	const had = pin === null ? [] : Object.keys(pin.files);
	for (const target of drop) {
		if (listed(target)) {
			throw new PinsError(
				"USAGE",
				`--drop ${target}: the release publishes it`,
			);
		}
	}
	const undeclared = had.filter(
		(target) => !listed(target) && !drop.includes(target),
	);
	if (undeclared.length > 0) {
		throw new PinsError(
			"TARGET_DROPPED",
			`${SUMS} of ${tag} does not list ${undeclared.map((target) => `${name}-${target} or ${goArchiveName(name, tag, target) ?? "an archive"}`).join(", ")}; the pin would lose ${undeclared.join(", ")}. Re-run with ${undeclared.map((target) => `--drop ${target}`).join(" ")} if that is meant`,
		);
	}
	const wanted = pin === null ? [...DEFAULT_TARGETS] : had;
	return {
		keep: wanted.filter(listed),
		dropped: drop,
		unpublished: pin === null ? wanted.filter((target) => !listed(target)) : [],
	};
}

/**
 * Point `name` at release `tag`: read its SHA256SUMS, download each file it
 * pins into the cache, check it against the published sum, measure it, and
 * return the manifest text with only that entry replaced.
 */
export async function bumpAsset(
	pins: Pins,
	name: string,
	tag: string,
	options: BumpOptions,
	ctx: AssetContext,
): Promise<Bumped> {
	// Nothing the operator typed reaches a URL, the cache or the network unchecked.
	if (!isReleaseTag(tag)) {
		throw new PinsError("USAGE", `${tag} is not a release tag`);
	}
	if (options.repo !== undefined) {
		checkRepoUrl(options.repo, "--repo", options.allowLocal);
	}
	const pin = pins.assets[name] ?? null;
	// `--repo` naming the pin's own repository (a trailing slash, `.git`) is
	// not a move: keep the manifest's text and announce nothing.
	const repo =
		options.repo !== undefined &&
		pin !== null &&
		sameRepo(options.repo, pin.repo)
			? pin.repo
			: (options.repo ?? pin?.repo);
	if (repo === undefined) {
		throw new PinsError(
			"USAGE",
			`${name} has no repository yet: pass --repo <url of the repository that publishes the release>`,
		);
	}
	const had = pin === null ? [] : Object.keys(pin.files);
	for (const target of options.drop) {
		if (!had.includes(target)) {
			throw new PinsError(
				"USAGE",
				`--drop ${target}: the pin has no such target (it has ${had.join(", ") || "none"})`,
			);
		}
	}
	const base = releaseBase(repo, tag);
	const sums = parseSums(await fetchText(`${base}${SUMS}`, ctx.fetchOptions));
	const plan = planTargets(name, tag, pin, sums, options.drop);
	if (plan.keep.length === 0) {
		throw new PinsError(
			"SUMS_MALFORMED",
			`${SUMS} of ${tag} lists none of ${DEFAULT_TARGETS.map((target) => `${name}-${target}`).join(", ")}, nor the archives ${DEFAULT_TARGETS.map((target) => goArchiveName(name, tag, target) ?? `${name}-${target}.tar.gz`).join(", ")}`,
		);
	}
	const found = new Map(
		plan.keep.map((target) => [target, publishedFor(name, tag, target, sums)]),
	);
	if (options.member !== undefined) {
		for (const [target, release] of found) {
			if (release?.archive === true) continue;
			throw new PinsError(
				"USAGE",
				`--member ${options.member}: ${tag} publishes ${release?.file ?? `${name}-${target}`}, an executable, not an archive`,
			);
		}
	}
	// The name a binary runs under is the pin's, not the release's: carry it over.
	const entryFor = (target: string): string =>
		options.entry ?? pin?.files[target]?.entry ?? name;
	for (const [target, release] of found) {
		// The archive and the entry share the cache directory, under their own names.
		if (release?.archive === true && entryFor(target) === release.file) {
			throw new PinsError(
				"USAGE",
				`${options.entry === undefined ? "the pin's entry" : `--entry ${options.entry}`} is ${release.file}, the name of the archive it would be unpacked from; name the entry something else`,
			);
		}
	}
	await prepareCache(ctx.cache);
	const files: Record<string, AssetFile> = {};
	for (const target of plan.keep) {
		const release = found.get(target);
		const published = release?.file ?? `${name}-${target}`;
		const sha256 = sums.get(published) ?? "";
		const entry = entryFor(target);
		await prepareCache(ctx.cache, sha256);
		const dest = join(
			ctx.cache,
			sha256,
			release?.archive === true ? published : entry,
		);
		await fetchVerified(`${base}${published}`, sha256, dest, ctx.fetchOptions);
		const file: AssetFile = {
			url: `${base}${published}`,
			sha256,
			size: statSync(dest).size,
			entry,
		};
		if (release?.archive === true) {
			// `--member`, else the member the pin already names, else the pin's entry.
			const member =
				options.member ?? pin?.files[target]?.archive?.member ?? entry;
			// Unpacking it is the check that the archive holds what the pin will run.
			await extractMember(dest, member, join(ctx.cache, sha256, entry), sha256);
			files[target] = { ...file, archive: { format: "tar.gz", member } };
		} else {
			files[target] = file;
		}
	}
	const next: Pins = {
		...pins,
		assets: { ...pins.assets, [name]: { repo, tag, files } },
	};
	const text = serializePins(next);
	parsePins(text, { allowLocal: options.allowLocal });
	const move = `${name}  ${pin?.tag ?? "unpinned"} -> ${tag}  (each file downloaded and checked against ${SUMS})`;
	const lost =
		plan.unpublished.length > 0
			? `not published: ${plan.unpublished.join(", ")}`
			: `dropped: ${plan.dropped.length > 0 ? plan.dropped.join(", ") : "none"}`;
	const renamed = [
		...new Set(Object.values(files).map((file) => file.entry)),
	].filter(
		(now) => options.entry !== undefined && !oldEntries(pin).includes(now),
	);
	const lines = [move, `  kept: ${plan.keep.join(", ")}  ${lost}`];
	if (pin?.repo !== repo) {
		lines.push(`  repo: ${pin?.repo ?? "(none)"} -> ${repo}`);
	}
	if (renamed.length > 0) {
		lines.push(
			`  entry: ${oldEntries(pin).join(", ") || "(none)"} -> ${renamed.join(", ")}`,
		);
	}
	return { text, lines };
}
