/**
 * The verbs of `bootstrap-siblings.mts`, over git pins and asset pins alike:
 * initialise, report, fetch, move. Each prints what it did and returns the
 * process exit code; a refusal is a thrown `PinsError`.
 *
 * Erasable TypeScript with node builtins only.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GitPin, PINS_FILE, type Pins, PinsError } from "./pins.ts";
import { bumpAsset } from "./pins-asset-bump.ts";
import {
	type AssetContext,
	fetchAsset,
	refuseOverridesInCi,
	statusAsset,
} from "./pins-asset-ops.ts";
import { cacheDir, currentTarget } from "./pins-assets.ts";
import {
	bumpPin,
	type GitOptions,
	initPin,
	MIN_GIT,
	requireGit,
	SPARSE_GIT,
	short,
	statusPin,
} from "./pins-git.ts";

export { PINS_FILE };

export interface Request {
	readonly verb: "init" | "status" | "fetch" | "bump";
	readonly root: string;
	readonly reference: string | undefined;
	readonly online: boolean;
	readonly repo: string | undefined;
	readonly drop: readonly string[];
	readonly force: boolean;
	readonly entry: string | undefined;
	readonly member: string | undefined;
	readonly names: readonly string[];
	readonly allowLocal: boolean;
}

function gitOptions(request: Request): GitOptions {
	return {
		reference: request.reference,
		allowLocal: request.allowLocal,
		force: request.force,
	};
}

function assetContext(request: Request): AssetContext {
	return {
		cache: cacheDir(),
		target: currentTarget(),
		env: process.env,
		online: request.online,
		fetchOptions: { allowLocal: request.allowLocal },
	};
}

// A pin name comes from the command line: only the manifest's own keys count,
// never `toString` or `__proto__` from the prototype chain.
function gitPinOf(pins: Pins, name: string): GitPin | undefined {
	return Object.hasOwn(pins.git, name) ? pins.git[name] : undefined;
}

/**
 * Refuses, before the first git pin is read, a git older than the manifest
 * needs: 2.35 when any pin has a sparse cone, 2.31 otherwise.
 */
function requireGitFor(request: Request, pins: Pins): void {
	const sparse = Object.values(pins.git).some((pin) => pin.sparse !== null);
	requireGit(request.root, sparse ? SPARSE_GIT : MIN_GIT);
}

function hasAsset(pins: Pins, name: string): boolean {
	return Object.hasOwn(pins.assets, name);
}

/** A vendored copy is placed by the installer of the repository it comes from. */
function refuseVendored(pins: Pins, name: string): void {
	const pin = Object.hasOwn(pins.vendor, name) ? pins.vendor[name] : undefined;
	if (pin !== undefined) {
		throw new PinsError(
			"USAGE",
			`${name} is a vendored copy of ../${pin.from}/${pin.path}; refresh it with that repository's installer. pins:fetch and pins:bump do not move vendored pins`,
		);
	}
}

function unknownPin(pins: Pins, name: string): never {
	refuseVendored(pins, name);
	const known = [...Object.keys(pins.git), ...Object.keys(pins.assets)];
	throw new PinsError(
		"USAGE",
		`no pin named ${name}; pins: ${known.join(", ")}`,
	);
}

async function initGit(
	request: Request,
	pins: Pins,
	name: string,
): Promise<void> {
	const pin = gitPinOf(pins, name);
	if (pin === undefined) return unknownPin(pins, name);
	requireGitFor(request, pins);
	const result = await initPin(request.root, pin, gitOptions(request));
	const sparse = pin.sparse === null ? "" : `; sparse: ${pin.sparse.join(" ")}`;
	if (result.kind === "already pinned") {
		const note = result.sparseChanged ? `  (sparse set updated${sparse})` : "";
		console.log(`${name}  already pinned at ${short(result.head)}${note}`);
		return;
	}
	const borrowed =
		request.reference === undefined
			? ""
			: `, objects borrowed from ${request.reference}; keep that clone in place`;
	const moved = result.was === null ? "" : `was ${short(result.was)}; `;
	const how = `${moved}${result.shallow ? "shallow" : "full"}${borrowed}`;
	console.log(
		`${name}  ${result.kind} at ${short(result.head)}  (${how}${sparse})`,
	);
}

/** No verb: every git pin, nothing downloaded. */
export async function runInit(request: Request, pins: Pins): Promise<number> {
	for (const name of Object.keys(pins.git)) await initGit(request, pins, name);
	return 0;
}

/** Named pins, or all of them (an unpublished asset is skipped, not an error). */
export async function runFetch(request: Request, pins: Pins): Promise<number> {
	refuseOverridesInCi(Object.keys(pins.assets), process.env);
	const explicit = request.names.length > 0;
	const names = explicit
		? request.names
		: [...Object.keys(pins.git), ...Object.keys(pins.assets)];
	const ctx = assetContext(request);
	for (const name of names) {
		if (gitPinOf(pins, name) !== undefined) {
			await initGit(request, pins, name);
		} else if (hasAsset(pins, name)) {
			console.log(
				await fetchAsset(name, pins.assets[name] ?? null, ctx, explicit),
			);
		} else {
			unknownPin(pins, name);
		}
	}
	return 0;
}

function printProblems(
	problems: readonly string[],
	fixes: readonly string[],
): void {
	for (const problem of problems) console.log(`  ${problem}`);
	fixes.forEach((fix, index) =>
		console.log(`  ${index === 0 ? "fix:" : "    "} ${fix}`),
	);
}

/** A warning leaves the exit status alone. */
function printWarnings(
	warnings: readonly string[],
	fixes: readonly string[],
): void {
	printProblems(
		warnings.map((warning) => `warning: ${warning}`),
		fixes,
	);
}

export async function runStatus(request: Request, pins: Pins): Promise<number> {
	refuseOverridesInCi(Object.keys(pins.assets), process.env);
	let failed = 0;
	if (Object.keys(pins.git).length > 0) requireGitFor(request, pins);
	for (const [name, pin] of Object.entries(pins.git)) {
		const status = await statusPin(
			request.root,
			name,
			pin,
			request.online,
			gitOptions(request),
		);
		if (status.problems.length === 0) {
			const tip =
				status.tip === null
					? ""
					: status.tip === status.commit
						? `  (the tip of ${pin.branch})`
						: `  (${pin.branch} is at ${short(status.tip)})`;
			console.log(`${name}  ${short(status.commit)}  ok${tip}`);
			printWarnings(status.warnings, status.warningFixes);
			continue;
		}
		failed += 1;
		console.log(`${name}  ${short(status.commit)}  FAIL`);
		printProblems(status.problems, status.fixes);
		printWarnings(status.warnings, status.warningFixes);
	}
	const ctx = assetContext(request);
	for (const [name, pin] of Object.entries(pins.assets)) {
		const report = await statusAsset(name, pin, ctx);
		console.log(report.summary);
		printProblems(report.problems, report.fixes);
		if (report.problems.length > 0) failed += 1;
	}
	for (const [name, pin] of Object.entries(pins.vendor)) {
		console.log(
			`${name}  vendored from ${pin.from}  (not checked by pins:status)`,
		);
	}
	if (failed > 0) console.error(`ERR ${failed} pin(s) out of date`);
	return failed === 0 ? 0 : 1;
}

export async function runBump(request: Request, pins: Pins): Promise<number> {
	const [name = "", ref = ""] = request.names;
	const gitPin = gitPinOf(pins, name);
	if (gitPin !== undefined) {
		if (request.repo !== undefined) {
			throw new PinsError(
				"USAGE",
				"--repo applies to asset pins, not git pins",
			);
		}
		requireGitFor(request, pins);
		const { from, to } = await bumpPin(
			request.root,
			name,
			gitPin,
			ref,
			gitOptions(request),
		);
		console.log(
			`${name}  ${short(from)} -> ${short(to)}  (gitlink staged; commit it)`,
		);
		return 0;
	}
	if (!hasAsset(pins, name)) return unknownPin(pins, name);
	const { text, lines } = await bumpAsset(
		pins,
		name,
		ref,
		{
			repo: request.repo,
			drop: request.drop,
			entry: request.entry,
			member: request.member,
			allowLocal: request.allowLocal,
		},
		assetContext(request),
	);
	const file = join(request.root, PINS_FILE);
	writeFileSync(`${file}.tmp`, text);
	renameSync(`${file}.tmp`, file);
	console.log(
		`${lines.join("\n")}\n${PINS_FILE} rewritten; review and commit it`,
	);
	return 0;
}
