import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	DeclarationNotFoundError,
	type DeclaredField,
	declaredFields,
} from "./fixtures/declared-fields.js";

/**
 * This package and `packages/cloud/src/plan-types.ts` must describe the same
 * shape, field for field, optionality included.
 *
 * Both sides are read from disk with the same reader. Asserting my declaration
 * against a list written out in this file would only prove that I can copy a
 * list; asserting the two *files* against each other is what notices the day
 * one of them changes.
 *
 * Two states are correct, and the test distinguishes them:
 *
 *  - Today: `plan-types.ts` declares `ResourceIntent` itself, and the two
 *    declarations must agree.
 *  - After Swarm I lands the re-export wiring: `plan-types.ts` no longer
 *    declares it and re-exports from `@hobo/manifest-declaration` instead, at
 *    which point there is nothing left to drift and the parity check is
 *    satisfied by the re-export itself.
 *
 * Anything else — the interface gone with no re-export, or present but
 * different — fails, with a message that says which.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function read(relativePath: string): string {
	return readFileSync(`${REPO_ROOT}${relativePath}`, "utf8");
}

const PLAN_TYPES = read("packages/cloud/src/plan-types.ts");
const OWN_SOURCE = read("packages/manifest-declaration/src/index.ts");

const REEXPORTS_THIS_PACKAGE = /@hobo\/manifest-declaration/u.test(PLAN_TYPES);

const SHARED_DECLARATIONS = [
	"ResourceIntent",
	"PlacementCriteria",
	"PlacementPropertySelector",
	"PlacementAffinityRule",
	"PlacementSpread",
	"PlacementPickN",
] as const;

function upstream(name: string): readonly DeclaredField[] | "re-exported" {
	try {
		return declaredFields(PLAN_TYPES, name);
	} catch (error) {
		if (!(error instanceof DeclarationNotFoundError)) throw error;
		if (REEXPORTS_THIS_PACKAGE) return "re-exported";
		throw new Error(
			`packages/cloud/src/plan-types.ts no longer declares ${name} and does not re-export @hobo/manifest-declaration either; the shape has been moved somewhere this test cannot see`,
		);
	}
}

describe("parity with packages/cloud/src/plan-types.ts", () => {
	it("reads a non-trivial field list from the upstream file, so the rest is not vacuous", () => {
		if (REEXPORTS_THIS_PACKAGE) {
			expect(PLAN_TYPES).toContain("@hobo/manifest-declaration");
			return;
		}
		expect(declaredFields(PLAN_TYPES, "ResourceIntent").length).toBe(9);
	});

	for (const name of SHARED_DECLARATIONS) {
		it(`${name} has the same fields and optionality in both files`, () => {
			const theirs = upstream(name);
			if (theirs === "re-exported") return;
			expect(declaredFields(OWN_SOURCE, name)).toEqual(theirs);
		});
	}

	it("declares the same closed vocabularies", () => {
		if (REEXPORTS_THIS_PACKAGE) return;
		for (const declaration of [
			'export type Negotiation = "require" | "prefer";',
			'export type PlacementAffinityMode = "affinity" | "anti-affinity";',
			'export type PlacementScope = "region" | "yard";',
		]) {
			expect(PLAN_TYPES).toContain(declaration);
			expect(OWN_SOURCE).toContain(declaration);
		}
		// PlacementSelectorOp is wrapped across lines by the formatter in both
		// files, so it is compared with whitespace removed.
		const squash = (value: string): string => value.replace(/\s+/gu, "");
		const ops =
			'exporttypePlacementSelectorOp=|"eq"|"ne"|"in"|"not-in"|"lt"|"lte"|"gt"|"gte"|"exists";';
		expect(squash(PLAN_TYPES)).toContain(ops);
		expect(squash(OWN_SOURCE)).toContain(ops);
	});

	it("the parsed derived type mirrors the authoring type field for field", () => {
		const authoring = declaredFields(OWN_SOURCE, "ResourceIntent");
		const parsed = declaredFields(OWN_SOURCE, "ParsedResourceIntent").filter(
			// The brand is a phantom key with no wire form.
			(field) => field.name !== "readonly",
		);
		expect(parsed.map((field) => field.name)).toEqual(
			authoring.map((field) => field.name),
		);
		expect(parsed.map((field) => field.optional)).toEqual(
			authoring.map((field) => field.optional),
		);
	});
});

describe("the wire schema covers the declared shape", () => {
	const PROTO = read(
		"packages/manifest-declaration/data-models/resource_intent.proto",
	);
	const CUE = read(
		"packages/manifest-declaration/data-models/resource_intent.cue",
	);

	it("declares every message in both the proto and the CUE", () => {
		for (const name of SHARED_DECLARATIONS) {
			expect(PROTO).toContain(`message ${name} {`);
			expect(CUE).toContain(`#${name}:`);
		}
	});

	it("gives every optional scalar explicit presence in the proto", () => {
		// The whole point of the divergence from cloud.proto. An optional *scalar*
		// without `optional` is indistinguishable from its default on the wire;
		// an optional *message* already has presence. So: every optional field
		// whose TypeScript type is a primitive must be declared `optional`.
		const scalarTypes = new Set(["string", "number", "boolean"]);
		const source = OWN_SOURCE;
		const body = /export interface ResourceIntent \{([\s\S]*?)\n\}/u.exec(
			source,
		);
		expect(body).not.toBeNull();

		const optionalScalars: string[] = [];
		for (const line of (body?.[1] ?? "").split("\n")) {
			const match = /^\t([A-Za-z_$][\w$]*)\?:\s*([A-Za-z_$][\w$]*);/u.exec(
				line,
			);
			if (match === null) continue;
			// SAFETY: the second capture group is present because the regex matched this line.
			const scalarType = match[2] as string;
			if (!scalarTypes.has(scalarType)) continue;
			// SAFETY: the first capture group is present because the regex matched this line.
			optionalScalars.push(match[1] as string);
		}

		// If this ever becomes empty the assertions below stop meaning anything.
		expect(optionalScalars).toEqual(["region"]);
		for (const field of optionalScalars) {
			expect(PROTO).toMatch(
				new RegExp(`optional\\s+\\w+\\s+${field}\\s*=\\s*\\d+;`, "u"),
			);
		}
	});

	it("records that cloud.proto still declares region without explicit presence", () => {
		// Not a failure — cloud.proto is not this package's file. It is pinned so
		// the divergence is a recorded fact rather than a claim in a README, and
		// so that the day someone fixes it upstream this test says so.
		const cloudProto = read("packages/cloud/data-models/cloud.proto");
		const regionLine = /^\s*(optional\s+)?string region = 7;/mu.exec(
			cloudProto,
		);
		expect(regionLine).not.toBeNull();
		expect(regionLine?.[1]).toBeUndefined();
	});
});
