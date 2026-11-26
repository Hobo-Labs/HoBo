/**
 * What `bootstrap-siblings` does with an asset pin: report it and fetch it.
 * Moving it to another release is `pins-asset-bump.ts`.
 *
 * An asset is one executable per target, pinned by sha256 and kept in the
 * content-addressed cache: a bare file, or one member of a release archive,
 * where the archive is what the pin's digest covers (`pins-archive.ts`).
 *
 * Erasable TypeScript with node builtins only.
 */
import { basename } from "node:path";

import { type AssetPin, PinsError } from "./pins.ts";
import {
	assetFor,
	overrideEnv,
	parseSums,
	releaseBase,
} from "./pins-assets.ts";
import { cacheProblem } from "./pins-cache.ts";
import {
	ensureCached,
	type FetchOptions,
	fetchText,
	verifyCached,
} from "./pins-fetch.ts";

export interface AssetContext {
	readonly cache: string;
	readonly target: string;
	readonly env: NodeJS.ProcessEnv;
	readonly online: boolean;
	readonly fetchOptions: FetchOptions;
}

export interface AssetReport {
	readonly summary: string;
	readonly problems: readonly string[];
	readonly fixes: readonly string[];
}

export const SUMS = "SHA256SUMS";

export function short(digest: string): string {
	return digest.slice(0, 7);
}

function fetchHint(name: string): string {
	return `pnpm run pins:fetch ${name}`;
}

/**
 * Whether this run is a CI run: `CI` (GitHub, GitLab, CircleCI and most
 * others), `GITHUB_ACTIONS` or `TF_BUILD` (Azure Pipelines) set to anything
 * but empty, false or 0. Nothing else is read.
 */
function inCi(env: NodeJS.ProcessEnv): boolean {
	return [env.CI, env.GITHUB_ACTIONS, env.TF_BUILD].some((value) => {
		const set = (value ?? "").toLowerCase();
		return set !== "" && set !== "false" && set !== "0";
	});
}

/**
 * An override variable points a lane at a local binary, which nothing has
 * verified. Refuse it in CI, where a green run has to mean the pinned bytes
 * ran, unless `HOBO_PINS_ALLOW_OVERRIDE=1` says the run means something else.
 */
export function refuseOverridesInCi(
	names: readonly string[],
	env: NodeJS.ProcessEnv,
): void {
	if (!inCi(env) || env.HOBO_PINS_ALLOW_OVERRIDE === "1") return;
	const set = names.map(overrideEnv).filter((variable) => env[variable]);
	if (set.length > 0) {
		throw new PinsError(
			"OVERRIDE_IN_CI",
			`${set.join(", ")} ${set.length > 1 ? "are" : "is"} set in CI: a binary named by an override is unverified, so a green run would not mean the pinned release ran. Unset ${set.length > 1 ? "them" : "it"}, or set HOBO_PINS_ALLOW_OVERRIDE=1 if this run is meant to test a local build`,
		);
	}
}

/** Offline: the cached bytes still hash to the pin. Online: the release still says so. */
export async function statusAsset(
	name: string,
	pin: AssetPin | null,
	ctx: AssetContext,
): Promise<AssetReport> {
	if (pin === null) {
		const variable = overrideEnv(name);
		const state = ctx.env[variable] ? "is set" : "is unset";
		return {
			summary: `${name}  unpinned  (not published yet; ${variable} ${state})`,
			problems: [],
			fixes: [],
		};
	}
	const published = Object.keys(pin.files).sort().join(", ");
	if (pin.files[ctx.target] === undefined) {
		return {
			summary: `${name}  ${pin.tag}  n/a  (no ${ctx.target} build; published: ${published})`,
			problems: [],
			fixes: [],
		};
	}
	const file = assetFor(pin, name, ctx.target);
	const problems: string[] = [];
	const fixes: string[] = [];
	const unsafe = await cacheProblem(ctx.cache, file.sha256);
	if (unsafe !== null) {
		problems.push(unsafe.problem);
		fixes.push(unsafe.fix);
	}
	const cached = await verifyCached(ctx.cache, file);
	if (cached.state === "mismatch") {
		problems.push(
			`${cached.path} hashes to ${cached.actual}, the pin says ${file.sha256}`,
		);
		fixes.push(`${fetchHint(name)}   (replaces the corrupt file)`);
	}
	if (cached.state === "invalid") {
		problems.push(`${cached.path} is not a regular file (${cached.reason})`);
		fixes.push(`${fetchHint(name)}   (replaces it)`);
	}
	if (cached.state === "stale") {
		problems.push(cached.reason);
		fixes.push(
			`${fetchHint(name)}   (unpacks it again from the verified archive)`,
		);
	}
	if (cached.state === "unusable") {
		problems.push(
			`the pinned archive cannot supply the entry: ${cached.reason}`,
		);
		fixes.push(
			`pnpm run pins:bump ${name} ${pin.tag} -- --member <path>   (pins the member the archive does hold; fetching again cannot help)`,
		);
	}
	if (ctx.online) {
		const published = await compareWithRelease(pin, ctx);
		problems.push(...published);
		if (published.length > 0) {
			fixes.push(
				`pnpm run pins:bump ${name} ${pin.tag}   (re-pin to what the release publishes now, once you know why it changed)`,
			);
		}
	}
	const variable = overrideEnv(name);
	const shadowed = ctx.env[variable]
		? `; ${variable} is set and shadows this pin: that binary is not verified`
		: "";
	const where =
		cached.state === "ok"
			? "cached"
			: cached.state === "absent"
				? `not cached; ${fetchHint(name)}`
				: cached.state === "invalid"
					? "cache invalid"
					: cached.state === "stale"
						? "unpacked file stale"
						: cached.state === "unusable"
							? "archive unusable"
							: "cache corrupt";
	const mark = problems.length === 0 ? "ok" : "FAIL";
	const online =
		ctx.online && problems.length === 0 ? "; matches SHA256SUMS" : "";
	return {
		summary: `${name}  ${pin.tag}  ${mark}  (${ctx.target} sha256 ${short(file.sha256)}, ${where}${online}${shadowed})`,
		problems,
		fixes,
	};
}

async function compareWithRelease(
	pin: AssetPin,
	ctx: AssetContext,
): Promise<string[]> {
	const url = `${releaseBase(pin.repo, pin.tag)}${SUMS}`;
	const sums = parseSums(await fetchText(url, ctx.fetchOptions));
	const problems: string[] = [];
	for (const [target, file] of Object.entries(pin.files)) {
		const published = sums.get(basename(new URL(file.url).pathname));
		if (published !== file.sha256) {
			problems.push(
				`${target}: the pin says ${file.sha256}; ${SUMS} of ${pin.tag} says ${published ?? "nothing"}`,
			);
		}
	}
	return problems;
}

/** Download, verify and cache this machine's build; the line to print. */
export async function fetchAsset(
	name: string,
	pin: AssetPin | null,
	ctx: AssetContext,
	explicit: boolean,
): Promise<string> {
	const variable = overrideEnv(name);
	if (pin === null) {
		if (explicit) {
			throw new PinsError(
				"ASSET_UNPUBLISHED",
				`${name} has no published release pinned yet; set ${variable} to a local build`,
			);
		}
		return `${name}  skipped  (not published yet; set ${variable} to a local build)`;
	}
	const file = assetFor(pin, name, ctx.target);
	const { path, downloaded, unpacked } = await ensureCached(
		ctx.cache,
		file,
		ctx.fetchOptions,
	);
	if (downloaded) {
		return `${name}  fetched ${ctx.target} (${file.size} bytes, sha256 ${short(file.sha256)}) to ${path}`;
	}
	return unpacked
		? `${name}  unpacked again from the verified archive to ${path}`
		: `${name}  already cached at ${path}`;
}
