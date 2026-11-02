import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

/** Package folder name under `packages/` → public engine id served at `/engines/<id>/`. */
export const CI_ENGINE_PACKAGE_IDS: Readonly<Record<string, string>> = Object.freeze({
	"ci-gh-actions": "gh-actions",
	"ci-vercel": "vercel",
	"ci-dagger": "dagger",
	"ci-cf": "cf",
	"ci-ado": "ado",
});

// public-contract: default `/engines/<id>/` mount when a checkout omits an explicit engine id.
export const DEFAULT_CI_ENGINE_ID = "gh-actions";

const engineIdPattern = /^[a-z][a-z0-9-]{0,62}$/;

export function isKnownCiEngineId(value: string): boolean {
	return engineIdPattern.test(value) && knownEngineIds().includes(value);
}

export function knownEngineIds(): readonly string[] {
	return Object.freeze(
		[...new Set(Object.values(CI_ENGINE_PACKAGE_IDS))].sort(),
	);
}

/** Discover engine ids from `packages/ci-*` folders in a repository checkout. */
export async function inventoryCiEnginesFromRepository(
	repositoryRoot: string,
): Promise<readonly string[]> {
	const packagesDir = join(repositoryRoot, "packages");
	let entries: string[];
	try {
		await access(packagesDir, constants.R_OK);
		entries = await readdir(packagesDir);
	} catch {
		return [DEFAULT_CI_ENGINE_ID];
	}
	const discovered = entries
		.filter(
			(name) =>
				name.startsWith("ci-") &&
				name !== "ci-guard" &&
				Object.hasOwn(CI_ENGINE_PACKAGE_IDS, name),
		)
		.map((name) => CI_ENGINE_PACKAGE_IDS[name]!);
	const unique = [...new Set(discovered)].sort();
	return unique.length > 0 ? unique : [DEFAULT_CI_ENGINE_ID];
}

export function normalizeCiEngineSelection(input: {
	readonly configured?: readonly string[];
	readonly cli?: readonly string[];
	readonly inventory: readonly string[];
}): readonly string[] {
	const requested =
		input.cli && input.cli.length > 0
			? input.cli
			: input.configured && input.configured.length > 0
				? input.configured
				: input.inventory;
	const allowed = new Set(input.inventory);
	for (const engine of requested) {
		if (!isKnownCiEngineId(engine) || !allowed.has(engine))
			throw new Error(`unknown or unavailable CI engine: ${engine}`);
	}
	return Object.freeze([...requested]);
}
