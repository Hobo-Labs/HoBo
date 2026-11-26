/**
 * Fixtures come from the repository, not from this package's imagination.
 *
 * A schema that is tested only against data written to fit it passes its own
 * test and fails on the first real catalog row. So the round-trip corpus is
 * read at test time out of `@hobo/capability-profiles`' own selection cases
 * and `@hobo/recipes`' golden topologies — files that exist because other
 * packages already depend on their contents.
 *
 * Read as data, never imported: a manifest package's only workspace
 * dependency is `@hobo/core`, and reaching into another package's `src/` would
 * be exactly the edge the boundary guard exists to refuse.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
export const CAPABILITY_PROFILES_DIR = join(
	REPO_ROOT,
	"packages",
	"capability-profiles",
);
export const SELECTION_CASES_PATH = join(
	CAPABILITY_PROFILES_DIR,
	"test",
	"selection.cases.jsonl",
);
export const SELECTION_SOURCE_PATH = join(
	CAPABILITY_PROFILES_DIR,
	"src",
	"selection.ts",
);
export const CAPABILITY_PROFILES_INDEX_PATH = join(
	CAPABILITY_PROFILES_DIR,
	"src",
	"index.ts",
);
/** This package's own declaration of the shape — the only one left. */
export const CANDIDATE_SOURCE_PATH = join(
	import.meta.dirname,
	"..",
	"src",
	"candidate.ts",
);
export const SELECTION_TEST_PATH = join(
	CAPABILITY_PROFILES_DIR,
	"test",
	"selection.test.ts",
);
/**
 * `BINDLE_RUNTIMES` and `REALIZATION_KINDS` used to live in
 * `packages/capability-profiles/src/ids.ts`. Swarm I moved that file into
 * `@hobo/manifest-capability` and deleted the original — `@hobo/capability-profiles`
 * re-exports it. The restatement check below still compares two different
 * packages, so it still means something; only the path moved.
 */
export const IDS_SOURCE_PATH = join(
	REPO_ROOT,
	"packages",
	"manifest-capability",
	"src",
	"ids.ts",
);

/** A missing fixture is a failure, not a skipped test. */
export function readRepoFile(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (cause) {
		throw new Error(
			`fixture ${path} is missing; the round-trip corpus is real repository data and cannot be substituted`,
			{ cause },
		);
	}
}

/**
 * The base candidate every case in `selection.cases.jsonl` patches.
 *
 * Transcribed from `BASE` in `packages/capability-profiles/test/selection.ts`
 * because the cases are patches and a patch alone is not a candidate.
 * `schema-parity.test.ts` fails if that literal grows or loses a field, so the
 * transcription cannot silently drift.
 */
export const BASE_CANDIDATE = {
	definitionId: "test.definition/v1",
	providerId: "test",
	implementsProfiles: [
		{
			profileId: "data.postgres/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: "conformance.data.postgres/v1",
			conformance: "pass",
		},
	],
	runtimeModels: ["paas"],
	structuredCapabilities: {},
	producesBindingProfiles: ["binding.postgresql/v1"],
	migrationProfiles: ["migration.postgres.pg-dump/v1"],
	providerClass: "verified-emerging",
	evidenceExpiresAtMs: Date.UTC(2026, 7, 8) + 20 * 24 * 60 * 60 * 1000,
	evidenceSignatureValid: true,
	creatorAuthorityAfterClaim: "rotatable",
	claimAtomicity: "single-resource",
	claimActionCount: 1,
	continuity: {
		endpoint: "preserved",
		data: "preserved",
		credentials: "rotated",
	},
	supportsExport: true,
	supportsRotation: true,
	supportsRevocation: true,
	sponsorExposureMinorUnits: 0,
	hasRegisteredDriver: true,
	secretCustodyAvailable: true,
} as const;

type ProfileShorthand =
	| string
	| {
			readonly id: string;
			readonly realization?: string;
			readonly conformance?: string;
	  };

type CandidatePatch = Record<string, unknown> & {
	readonly profiles?: readonly ProfileShorthand[];
	readonly absent?: readonly string[];
};

/** The same two shorthands `selection.test.ts` expands. */
function expand(patch: CandidatePatch): Record<string, unknown> {
	const { profiles, absent, ...rest } = patch;
	const draft: Record<string, unknown> = { ...BASE_CANDIDATE, ...rest };
	if (profiles !== undefined) {
		draft.implementsProfiles = profiles.map((entry) => {
			const spec = typeof entry === "string" ? { id: entry } : entry;
			return {
				profileId: spec.id,
				versionRange: ">=1",
				realization: spec.realization ?? "native",
				conformanceRef: `conformance.${spec.id}`,
				conformance: spec.conformance ?? "pass",
			};
		});
	}
	for (const key of absent ?? []) delete draft[key];
	return draft;
}

export type NamedCandidate = {
	readonly caseName: string;
	readonly index: number;
	readonly candidate: Record<string, unknown>;
};

/** Every candidate the capability-selection suite actually exercises. */
export function loadSelectionCaseCandidates(): readonly NamedCandidate[] {
	const loaded: NamedCandidate[] = [];
	for (const line of readRepoFile(SELECTION_CASES_PATH).split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const testCase = JSON.parse(trimmed) as {
			name: string;
			input: readonly { candidates?: readonly CandidatePatch[] }[];
		};
		for (const ask of testCase.input) {
			for (const [index, patch] of (ask.candidates ?? []).entries()) {
				loaded.push({
					caseName: testCase.name,
					index,
					candidate: expand(patch),
				});
			}
		}
	}
	if (loaded.length === 0) {
		throw new Error(
			`${SELECTION_CASES_PATH} yielded no candidates; the fixture format changed`,
		);
	}
	return loaded;
}

/**
 * Slice the body of a brace-delimited block that starts at `anchor`.
 *
 * Used to read another package's declarations as text. Brace-matched rather
 * than line-counted so a nested object does not end the slice early.
 */
export function sliceBlock(source: string, anchor: string): string {
	const start = source.indexOf(anchor);
	if (start < 0) {
		throw new Error(`anchor ${JSON.stringify(anchor)} not found`);
	}
	let depth = 0;
	for (
		let index = start + anchor.length - 1;
		index < source.length;
		index += 1
	) {
		const character = source[index];
		if (character === "{") depth += 1;
		else if (character === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start + anchor.length, index);
		}
	}
	throw new Error(`unbalanced braces after ${JSON.stringify(anchor)}`);
}

/** Top-level `key:` names inside a sliced block, in declaration order. */
export function topLevelKeys(block: string): readonly string[] {
	const keys: string[] = [];
	for (const line of block.split("\n")) {
		const match = /^\t(?:readonly )?([A-Za-z_$][\w$]*)\??:/.exec(line);
		if (match?.[1] !== undefined) keys.push(match[1]);
	}
	return keys;
}

/** String literals in a `const X = [ ... ] as const;` declaration. */
export function constStringList(
	source: string,
	name: string,
): readonly string[] {
	const anchor = `const ${name} = [`;
	const start = source.indexOf(anchor);
	if (start < 0) {
		throw new Error(`declaration ${JSON.stringify(anchor)} not found`);
	}
	let depth = 0;
	for (
		let index = start + anchor.length - 1;
		index < source.length;
		index += 1
	) {
		const character = source[index];
		if (character === "[") depth += 1;
		else if (character === "]") {
			depth -= 1;
			if (depth === 0) {
				const block = source.slice(start + anchor.length, index);
				return [...block.matchAll(/"([^"]+)"/gu)].map(
					(match) => match[1] as string,
				);
			}
		}
	}
	throw new Error(`unbalanced brackets after ${JSON.stringify(anchor)}`);
}
