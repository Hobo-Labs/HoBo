/**
 * Round trip over the fixtures the repository already has.
 *
 * The contract under test is not "my encoder can read my encoder". It is:
 * every candidate the capability-selection suite exercises survives
 * domain -> record -> JSON -> record -> domain with the same bytes, so a
 * digest taken over a candidate in one package equals the digest taken over
 * the same candidate in another.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	canonicalSelectionCandidateJson,
	fromSelectionCandidateRecord,
	parseSelectionCandidate,
	type SelectionCandidate,
	toSelectionCandidateRecord,
} from "../src/index.js";
import {
	BASE_CANDIDATE,
	loadSelectionCaseCandidates,
	REPO_ROOT,
	readRepoFile,
} from "./fixtures.js";

const SET_FIELDS = [
	"runtimeModels",
	"producesBindingProfiles",
	"migrationProfiles",
] as const;

const digestOf = (payload: string): string =>
	`sha256:${createHash("sha256").update(payload).digest("hex")}`;

const CASES = loadSelectionCaseCandidates();

/** Real multi-element binding-profile sets, read out of the recipe goldens. */
function goldenBindingProfileSets(): readonly (readonly string[])[] {
	const goldenDir = join(REPO_ROOT, "packages", "recipes", "test", "golden");
	const sets: (readonly string[])[] = [];
	for (const file of readdirSync(goldenDir).sort()) {
		if (!file.endsWith(".topology.json")) continue;
		const golden = JSON.parse(readRepoFile(join(goldenDir, file))) as {
			topology: {
				yards: readonly {
					resources: readonly { producesBindingProfiles?: readonly string[] }[];
				}[];
			};
		};
		for (const yard of golden.topology.yards) {
			for (const resource of yard.resources) {
				const profiles = resource.producesBindingProfiles;
				if (profiles !== undefined && profiles.length > 1) sets.push(profiles);
			}
		}
	}
	if (sets.length === 0) {
		throw new Error(
			"no multi-element producesBindingProfiles found in the recipe goldens; the corpus that exercises canonical ordering is gone",
		);
	}
	return sets;
}

describe("round trip over the capability-selection fixtures", () => {
	it("covers every candidate the selection suite exercises", () => {
		expect(CASES.length).toBeGreaterThanOrEqual(30);
	});

	for (const { caseName, index, candidate } of CASES) {
		it(`survives encode/decode: ${caseName} #${index}`, () => {
			const parsed = parseSelectionCandidate(candidate);
			const encoded = canonicalSelectionCandidateJson(parsed);
			const decoded = fromSelectionCandidateRecord(JSON.parse(encoded));
			const reencoded = canonicalSelectionCandidateJson(decoded);

			expect(reencoded).toBe(encoded);
			expect(digestOf(reencoded)).toBe(digestOf(encoded));
			expect(decoded).toStrictEqual(parsed);
		});

		it(`loses no field: ${caseName} #${index}`, () => {
			const decoded: SelectionCandidate = fromSelectionCandidateRecord(
				JSON.parse(canonicalSelectionCandidateJson(candidate)),
			);
			const source = candidate as Record<string, unknown>;
			for (const [key, value] of Object.entries(source)) {
				const landed = (decoded as unknown as Record<string, unknown>)[key];
				if ((SET_FIELDS as readonly string[]).includes(key)) {
					expect(landed).toStrictEqual(
						[...(value as readonly string[])].sort(),
					);
					continue;
				}
				expect(landed).toStrictEqual(value);
			}
			// Absence is a fact, and it must not become a present `undefined`.
			expect("evidenceExpiresAtMs" in decoded).toBe(
				"evidenceExpiresAtMs" in source,
			);
		});
	}

	it("keeps absent evidence absent rather than encoding a null", () => {
		const { evidenceExpiresAtMs: _dropped, ...withoutEvidence } =
			BASE_CANDIDATE;
		const encoded = canonicalSelectionCandidateJson(
			withoutEvidence as unknown as SelectionCandidate,
		);
		expect(encoded).not.toContain("evidence_expires_at_ms");
		expect(encoded).not.toContain("null");
		expect(
			"evidenceExpiresAtMs" in
				fromSelectionCandidateRecord(JSON.parse(encoded)),
		).toBe(false);
	});
});

describe("canonical ordering over real binding-profile sets", () => {
	for (const [index, profiles] of goldenBindingProfileSets().entries()) {
		it(`is insensitive to author order: golden set #${index} (${profiles.join(", ")})`, () => {
			const asAuthored = canonicalSelectionCandidateJson({
				...BASE_CANDIDATE,
				producesBindingProfiles: profiles,
			} as unknown as SelectionCandidate);
			const reversed = canonicalSelectionCandidateJson({
				...BASE_CANDIDATE,
				producesBindingProfiles: [...profiles].reverse(),
			} as unknown as SelectionCandidate);
			expect(reversed).toBe(asAuthored);
			expect(JSON.parse(asAuthored).produces_binding_profiles).toStrictEqual(
				[...profiles].sort(),
			);
		});
	}

	it("is insensitive to structured-capability key order", () => {
		const capabilities = {
			tls: true,
			maxStorageBytes: 536_870_912,
			region: "aws-us-east-2",
		};
		const forward = canonicalSelectionCandidateJson({
			...BASE_CANDIDATE,
			structuredCapabilities: capabilities,
		} as unknown as SelectionCandidate);
		const reversed = canonicalSelectionCandidateJson({
			...BASE_CANDIDATE,
			structuredCapabilities: Object.fromEntries(
				Object.entries(capabilities).reverse(),
			),
		} as unknown as SelectionCandidate);
		expect(reversed).toBe(forward);
		expect(forward).toContain(
			'"structured_capabilities":{"maxStorageBytes":536870912,"region":"aws-us-east-2","tls":true}',
		);
	});

	it("keeps implementsProfiles in author order, because selection reads position", () => {
		const claim = (profileId: string, realization: string) => ({
			profileId,
			versionRange: ">=1",
			realization,
			conformanceRef: `conformance.${profileId}`,
			conformance: "pass",
		});
		const forward = toSelectionCandidateRecord({
			...BASE_CANDIDATE,
			implementsProfiles: [
				claim("data.postgres/v1", "native"),
				claim("data.relational/v1", "pack"),
			],
		} as unknown as SelectionCandidate);
		const reversed = toSelectionCandidateRecord({
			...BASE_CANDIDATE,
			implementsProfiles: [
				claim("data.relational/v1", "pack"),
				claim("data.postgres/v1", "native"),
			],
		} as unknown as SelectionCandidate);
		expect(
			forward.implements_profiles.map((entry) => entry.profile_id),
		).toStrictEqual(["data.postgres/v1", "data.relational/v1"]);
		expect(
			reversed.implements_profiles.map((entry) => entry.profile_id),
		).toStrictEqual(["data.relational/v1", "data.postgres/v1"]);
		// The two orders must not digest alike. Measured on 2026-08-19 against
		// the built @hobo/capability-profiles: with a `data.relational/v1`
		// requirement and pack realization denied, the postgres-first order
		// wins and the relational-first order is REALIZATION_DENIED. A canonical
		// form that sorted this list would make that flip unattributable.
		expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(forward));
	});
});
