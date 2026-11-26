/**
 * The decomposition is only safe if drift is detectable.
 *
 * This suite was written while `@hobo/capability-profiles` still declared
 * `SelectionCandidate` alongside this package's schema for it, and it compared
 * the two so a field added there could not quietly stop being covered by every
 * digest taken through here.
 *
 * Swarm I removed that second declaration. `@hobo/capability-profiles` now
 * re-exports the shape, so there is nothing left to compare and the checks
 * that compared it would be self-comparisons — which pass unconditionally.
 * They are replaced by the stronger statement the re-export makes available:
 * the other package declares **none** of these names, and names this one as
 * their owner. `test/single-owner.test.ts` in `@hobo/manifest-round-trip`
 * checks the same seam by runtime identity.
 *
 * What is unchanged: the `BINDLE_RUNTIMES` / `REALIZATION_KINDS` restatement,
 * which still compares two different packages (the vocabulary moved to
 * `@hobo/manifest-capability`, not here); the transcribed base candidate
 * against `@hobo/capability-profiles`' own test harness; and the `.proto` and
 * `.cue` held to the record this package emits, because "the schema is the
 * contract" is a claim about files nothing else in the build reads.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	BINDLE_RUNTIMES,
	CLAIM_ATOMICITIES,
	CONTINUITY_GRADES,
	CREATOR_AUTHORITIES_AFTER_CLAIM,
	CREDENTIAL_CONTINUITY_GRADES,
	PROVIDER_CLASSES,
	parseSelectionCandidate,
	REALIZATION_KINDS,
	type SelectionCandidate,
	toSelectionCandidateRecord,
} from "../src/index.js";
import {
	BASE_CANDIDATE,
	CANDIDATE_SOURCE_PATH,
	CAPABILITY_PROFILES_INDEX_PATH,
	constStringList,
	IDS_SOURCE_PATH,
	readRepoFile,
	SELECTION_SOURCE_PATH,
	SELECTION_TEST_PATH,
	sliceBlock,
	topLevelKeys,
} from "./fixtures.js";

const DATA_MODELS = join(import.meta.dirname, "..", "data-models");
const PROTO = readRepoFile(join(DATA_MODELS, "selection_candidate.proto"));
const CUE = readRepoFile(join(DATA_MODELS, "selection_candidate.cue"));
const OWN_SOURCE = readRepoFile(CANDIDATE_SOURCE_PATH);
const SELECTION_SOURCE = readRepoFile(SELECTION_SOURCE_PATH);
const PROFILES_INDEX = readRepoFile(CAPABILITY_PROFILES_INDEX_PATH);
const IDS_SOURCE = readRepoFile(IDS_SOURCE_PATH);

const PARSED_BASE = parseSelectionCandidate(BASE_CANDIDATE);
const RECORD = toSelectionCandidateRecord(PARSED_BASE);

/** The six names that moved out of `@hobo/capability-profiles` into here. */
const MOVED = [
	"SelectionCandidate",
	"ProfileImplementation",
	"ProviderClass",
	"CreatorAuthorityAfterClaim",
	"ContinuityGrade",
	"ClaimAtomicity",
] as const;

describe("the shape is declared once, here, and re-exported there", () => {
	it("models exactly the field set its own declaration names", () => {
		// Not a self-comparison: the left side is what `parseSelectionCandidate`
		// actually emits at runtime, the right side is the declared type read as
		// text. A parser that dropped a field or added one fails this.
		const declaredFields = topLevelKeys(
			sliceBlock(OWN_SOURCE, "export type SelectionCandidate = {"),
		);
		expect(declaredFields.length).toBeGreaterThan(10);
		expect([...Object.keys(PARSED_BASE)].sort()).toStrictEqual(
			[...declaredFields].sort(),
		);
	});

	it("models exactly the declared profile-implementation field set", () => {
		const claimFields = topLevelKeys(
			sliceBlock(OWN_SOURCE, "export type ProfileImplementation = {"),
		);
		const claim = PARSED_BASE.implementsProfiles[0];
		expect(claim).toBeDefined();
		expect([...Object.keys(claim ?? {})].sort()).toStrictEqual(
			[...claimFields].sort(),
		);
	});

	it("@hobo/capability-profiles declares none of the moved names", () => {
		// `export type X =` / `export interface X` / `export class X`, not a bare
		// mention: `selection.ts` still *imports* every one of these to type its
		// gates, and a substring search would go green on the import.
		for (const name of MOVED) {
			expect(SELECTION_SOURCE).not.toMatch(
				new RegExp(`^export (?:type|interface|class) ${name}\\b`, "mu"),
			);
			expect(PROFILES_INDEX).not.toMatch(
				new RegExp(`^export (?:type|interface|class) ${name}\\b`, "mu"),
			);
		}
	});

	it("and names this package as their owner", () => {
		// The names must appear inside the block that re-exports from here, not
		// merely somewhere in the file — an unrelated mention in a comment would
		// otherwise satisfy this.
		const block =
			/export type \{([^}]*)\} from "@hobo\/manifest-request";/u.exec(
				PROFILES_INDEX,
			);
		expect(block).not.toBeNull();
		const named = (block?.[1] ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		for (const name of MOVED) {
			expect(named).toContain(name);
		}
	});

	it("restates BINDLE_RUNTIMES and REALIZATION_KINDS without drifting", () => {
		// Still two different packages: the vocabulary moved to
		// `@hobo/manifest-capability`, and a manifest package may not depend on
		// another manifest package, so this one restates rather than imports.
		expect(BINDLE_RUNTIMES).toStrictEqual(
			constStringList(IDS_SOURCE, "BINDLE_RUNTIMES"),
		);
		expect(REALIZATION_KINDS).toStrictEqual(
			constStringList(IDS_SOURCE, "REALIZATION_KINDS"),
		);
	});

	it("keeps the transcribed base candidate aligned with the fixture harness", () => {
		const harnessKeys = topLevelKeys(
			sliceBlock(
				readRepoFile(SELECTION_TEST_PATH),
				"const BASE: SelectionCandidate = {",
			),
		);
		expect([...Object.keys(BASE_CANDIDATE)].sort()).toStrictEqual(
			[...harnessKeys].sort(),
		);
	});
});

describe("the .proto and .cue describe the record this package emits", () => {
	const recordFields = Object.keys(RECORD);

	it("declares every record field in the protobuf message, in order", () => {
		const message = sliceBlock(PROTO, "message SelectionCandidateRecord {");
		const declared = [
			...message.matchAll(
				/^\s*(?:optional\s+|repeated\s+)?[\w.<>, ]+?\s+(\w+)\s*=\s*\d+;/gmu,
			),
		].map((match) => match[1] as string);
		expect(declared).toStrictEqual(recordFields);
	});

	it("gives every protobuf field a distinct, stable number", () => {
		const message = sliceBlock(PROTO, "message SelectionCandidateRecord {");
		const numbers = [...message.matchAll(/=\s*(\d+);/gu)].map((match) =>
			Number(match[1]),
		);
		expect(numbers).toStrictEqual([...numbers].sort((a, b) => a - b));
		expect(new Set(numbers).size).toBe(numbers.length);
	});

	it("declares every record field in the CUE definition", () => {
		const definition = sliceBlock(CUE, "#SelectionCandidateRecord: {");
		// `_`-prefixed fields are CUE's hidden constraints, not wire fields.
		const declared = [...definition.matchAll(/^\t([a-z]\w*)\??:/gmu)].map(
			(match) => match[1] as string,
		);
		expect([...declared].sort()).toStrictEqual([...recordFields].sort());
	});

	it("marks exactly the optional field optional in both schemas", () => {
		expect(PROTO).toContain("optional int64 evidence_expires_at_ms");
		expect(CUE).toContain("evidence_expires_at_ms?:");
		const optionalCueFields = [
			...sliceBlock(CUE, "#SelectionCandidateRecord: {").matchAll(
				/^\t(\w+)\?:/gmu,
			),
		].map((match) => match[1] as string);
		expect(optionalCueFields).toStrictEqual(["evidence_expires_at_ms"]);
	});

	it("keeps the CUE vocabularies aligned with the TypeScript ones", () => {
		for (const [name, members] of [
			["#ProviderClass", PROVIDER_CLASSES],
			["#CreatorAuthorityAfterClaim", CREATOR_AUTHORITIES_AFTER_CLAIM],
			["#ContinuityGrade", CONTINUITY_GRADES],
			["#CredentialContinuity", CREDENTIAL_CONTINUITY_GRADES],
			["#ClaimAtomicity", CLAIM_ATOMICITIES],
			["#BindleRuntime", BINDLE_RUNTIMES],
			["#RealizationKind", REALIZATION_KINDS],
		] as const) {
			const line = CUE.split("\n").find((entry) =>
				entry.startsWith(`${name}:`),
			);
			expect(line, `${name} is missing from the CUE schema`).toBeTypeOf(
				"string",
			);
			const declared = [...(line ?? "").matchAll(/"([^"]+)"/gu)].map(
				(match) => match[1] as string,
			);
			expect(declared, name).toStrictEqual([...members]);
		}
	});
});

describe("the candidate the fixtures describe is the candidate we parse", () => {
	it("accepts the transcribed base candidate unchanged", () => {
		const record = toSelectionCandidateRecord(
			BASE_CANDIDATE as unknown as SelectionCandidate,
		);
		expect(record.definition_id).toBe("test.definition/v1");
		expect(record.evidence_expires_at_ms).toBe(
			BASE_CANDIDATE.evidenceExpiresAtMs,
		);
	});
});
