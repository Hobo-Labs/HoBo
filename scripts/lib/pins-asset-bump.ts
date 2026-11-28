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

const DEFAULT_TARGETS = ["linux-x64", "linux-arm64"] as const;

function oldEntries(pin: AssetPin | null): string[] {
	return pin === null
		? []
		: [...new Set(Object.values(pin.files).map((file) => file.entry))];
}

export interface BumpOptions {
	readonly repo: string | undefined;
	readonly drop: readonly string[];
	readonly entry: string | undefined;
	readonly member: string | undefined;
	readonly allowLocal: boolean;
}

export interface Bumped {
	readonly text: string;
	readonly lines: readonly string[];
}

interface TargetPlan {
	readonly keep: string[];
	readonly dropped: readonly string[];
	readonly unpublished: string[];
}

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

export async function bumpAsset(
	pins: Pins,
	name: string,
	tag: string,
	options: BumpOptions,
	ctx: AssetContext,
): Promise<Bumped> {
	if (!isReleaseTag(tag)) {
		throw new PinsError("USAGE", `${tag} is not a release tag`);
	}
	if (options.repo !== undefined) {
		checkRepoUrl(options.repo, "--repo", options.allowLocal);
	}
	const pin = pins.assets[name] ?? null;
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
	const entryFor = (target: string): string =>
		options.entry ?? pin?.files[target]?.entry ?? name;
	for (const [target, release] of found) {
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
			const member =
				options.member ?? pin?.files[target]?.archive?.member ?? entry;
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
