/**
 * One declaration per shape, checked at runtime rather than asserted in prose.
 *
 * The decomposition's whole claim is that a shape now has exactly one owner and
 * that the package it came from re-exports rather than re-declares it. Two
 * copies of a *structural* type are merely untidy; two copies of these are not:
 *
 * - `ProfileId` is branded with a module-local `unique symbol`. Two
 *   declarations produce two different types, and a `ProfileId` parsed by one
 *   is not assignable to the other — a compile error at some unrelated call
 *   site months later, with a message that names neither package.
 * - `ProfileIdError`, `CapabilityProfileError` and `CapabilityRequirementError`
 *   are classes. Two declarations make `instanceof` false across the seam, and
 *   the failure is *silent*: a `catch` that tests for the wrong copy falls
 *   through to the rethrow rather than to the handler.
 *
 * Identity comparison catches both, and nothing else does. `toEqual` on two
 * copies of the same class passes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as profiles from "@hobo/capability-profiles";
import * as capability from "@hobo/manifest-capability";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relative: string): string =>
	readFileSync(`${REPO_ROOT}${relative}`, "utf8");

/**
 * Every runtime (non-type) binding `@hobo/capability-profiles` re-exports,
 * paired with the original it must *be*.
 *
 * Written out statically rather than looked up by name off the two namespace
 * objects. A dynamic lookup would read `profiles[name]` and `capability[name]`,
 * which is both a lint finding and a weaker test: a typo in the name string
 * would compare `undefined` to `undefined` and pass. Naming both sides makes a
 * missing export a compile error.
 */
const RE_EXPORTED: readonly (readonly [string, unknown, unknown])[] = [
	[
		"BINDLE_PRIMITIVES",
		profiles.BINDLE_PRIMITIVES,
		capability.BINDLE_PRIMITIVES,
	],
	["BINDLE_RUNTIMES", profiles.BINDLE_RUNTIMES, capability.BINDLE_RUNTIMES],
	[
		"CapabilityProfileError",
		profiles.CapabilityProfileError,
		capability.CapabilityProfileError,
	],
	[
		"CapabilityRequirementError",
		profiles.CapabilityRequirementError,
		capability.CapabilityRequirementError,
	],
	["ProfileIdError", profiles.ProfileIdError, capability.ProfileIdError],
	[
		"REALIZATION_KINDS",
		profiles.REALIZATION_KINDS,
		capability.REALIZATION_KINDS,
	],
	[
		"STANDARD_CAPABILITY_PROFILES",
		profiles.STANDARD_CAPABILITY_PROFILES,
		capability.STANDARD_CAPABILITY_PROFILES,
	],
	[
		"isBindlePrimitive",
		profiles.isBindlePrimitive,
		capability.isBindlePrimitive,
	],
	["isBindleRuntime", profiles.isBindleRuntime, capability.isBindleRuntime],
	[
		"parseCapabilityProfile",
		profiles.parseCapabilityProfile,
		capability.parseCapabilityProfile,
	],
	[
		"parseCapabilityRequirement",
		profiles.parseCapabilityRequirement,
		capability.parseCapabilityRequirement,
	],
	["parseProfileId", profiles.parseProfileId, capability.parseProfileId],
	[
		"tryParseProfileId",
		profiles.tryParseProfileId,
		capability.tryParseProfileId,
	],
];

describe("@hobo/capability-profiles re-exports rather than re-declares", () => {
	it("finds every named binding on both sides, so the identity check below is not vacuous", () => {
		for (const [name, reExported, original] of RE_EXPORTED) {
			expect(reExported, `${name} missing from the re-export`).toBeDefined();
			expect(original, `${name} missing from the owner`).toBeDefined();
		}
		expect(RE_EXPORTED.length).toBe(13);
	});

	it.each(
		RE_EXPORTED,
	)("%s is the identical binding, not a copy", (_name, reExported, original) => {
		expect(reExported).toBe(original);
	});

	it("instanceof holds across the seam for every error class", () => {
		// The failure this pins is silent, so it is provoked rather than asserted
		// structurally: throw from the manifest package, catch against the
		// re-export. With two copies each of these is `false` and the value falls
		// through every handler that names the wrong one.
		expect(() => capability.parseProfileId("not-a-profile-id")).toThrow(
			profiles.ProfileIdError,
		);
		expect(() =>
			capability.parseCapabilityProfile({ schemaVersion: "nope" }),
		).toThrow(profiles.CapabilityProfileError);
		expect(() =>
			capability.parseCapabilityRequirement({ requiredProfiles: [] }),
		).toThrow(profiles.CapabilityRequirementError);
	});

	it("a ProfileId parsed in the manifest package is accepted by the registry that stayed behind", () => {
		// The brand is unforgeable outside `parseProfileId`. If the registry held
		// a second declaration of it this call would not compile, and if it held a
		// second *catalog* the digest below would differ.
		const registry = profiles.createCapabilityProfileRegistry(
			capability.STANDARD_CAPABILITY_PROFILES,
		);
		const id = capability.parseProfileId("data.postgres/v1").id;
		expect(registry.require(id).id).toBe("data.postgres/v1");
		expect(
			profiles.createCapabilityProfileRegistry(
				profiles.STANDARD_CAPABILITY_PROFILES,
			).digest,
		).toBe(registry.digest);
	});
});

describe("the files that held the second copy are gone", () => {
	const INDEX = read("packages/capability-profiles/src/index.ts");

	it("declares no shape of its own — every capability and request name is re-exported", () => {
		// An `export type X = ...`, `export interface X` or `export class X`
		// reappearing in this file is how the second copy comes back, and it comes
		// back looking harmless. The pattern deliberately does not match
		// `export type {`, which is the formatter's spelling of a *type-only
		// re-export* — that is the shape this file is supposed to be made of.
		expect(INDEX).not.toMatch(/^export (?:type \w|interface |class )/mu);
		expect(INDEX).toContain('} from "@hobo/manifest-capability";');
		expect(INDEX).toContain('} from "@hobo/manifest-request";');
	});

	it.each([
		"packages/capability-profiles/src/ids.ts",
		"packages/capability-profiles/src/descriptor.ts",
		"packages/capability-profiles/src/requirement.ts",
		"packages/capability-profiles/src/standard-profiles.ts",
	])("%s no longer exists", (relative) => {
		expect(() => read(relative)).toThrow(/ENOENT/u);
	});

	it("selection.ts keeps the gates and no longer declares the candidate", () => {
		const selection = read("packages/capability-profiles/src/selection.ts");
		expect(selection).toContain(
			"export function selectCapabilityImplementation",
		);
		expect(selection).not.toMatch(/^export type SelectionCandidate = \{/mu);
		expect(selection).toContain('from "@hobo/manifest-request"');
	});
});
