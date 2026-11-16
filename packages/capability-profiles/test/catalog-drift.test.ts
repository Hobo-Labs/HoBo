/**
 * `@hobo/core`'s typed capability catalog and this package's standard profile
 * registry must name exactly the same profiles.
 *
 * They are two copies on purpose: core is layer 0 and cannot import this
 * package, but provider packages at layer 2 need typed profile names at their
 * authoring sites. Two copies drift unless something checks, so this checks —
 * in both directions, because each direction fails differently and both
 * failures are silent:
 *
 * - A profile in the registry but not in core's catalog is defined but
 *   unnameable through the typed surface, so authors fall back to a string
 *   literal and lose every guarantee the catalog exists to give.
 * - A profile in core's catalog but not in the registry autocompletes, compiles,
 *   and then matches nothing at resolution — the worst of the three failure
 *   modes, because it looks correct at the call site.
 *
 * The slot assignment is checked too. Core says which slot holds a profile;
 * `@hobo/yards` refuses a row filed under a slot whose profile family belongs
 * elsewhere (`SLOT_PROFILE_MISMATCH`). If core's grouping disagreed with the
 * family grammar, the typed surface would hand authors a value the parse
 * boundary then rejects.
 */
import {
	CAPABILITY_PROFILE_IDS,
	CAPABILITY_SLOTS,
	capability,
	slotForProfile,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { STANDARD_CAPABILITY_PROFILES } from "../src/index.js";

/** The registry's own schema-version id is not a capability anyone can bind. */
const NOT_A_CAPABILITY = new Set(["hobo.capability-profile/v1"]);

const registryIds = STANDARD_CAPABILITY_PROFILES.map((profile) => profile.id)
	.filter((id) => !NOT_A_CAPABILITY.has(id))
	.sort();

/** `secretRef` is spelled `secret-ref` on the wire; `webhook` also holds `realtime.*`. */
const FAMILIES_BY_SLOT = {
	secretRef: ["secret-ref"],
	webhook: ["webhook", "realtime"],
} satisfies Readonly<Record<string, readonly string[]>>;

function familyOf(profileId: string): string {
	const [family = ""] = profileId.split(".");
	return family;
}

describe("core's typed catalog matches the standard profile registry", () => {
	it("names every profile the registry defines", () => {
		const missing = registryIds.filter(
			// SAFETY: the generated catalog IDs are compared as plain wire strings.
			(id) => !(CAPABILITY_PROFILE_IDS as readonly string[]).includes(id),
		);
		expect(
			missing,
			"these profiles are registered but absent from `capability` in @hobo/core, so no author can name them without a string literal",
		).toEqual([]);
	});

	it("names no profile the registry does not define", () => {
		// SAFETY: the generated catalog IDs are compared as plain wire strings.
		const unknown = (CAPABILITY_PROFILE_IDS as readonly string[]).filter(
			(id) => !registryIds.includes(id),
		);
		expect(
			unknown,
			"these profiles autocomplete from `capability` but no registry entry defines them, so a Yard row naming one compiles and then matches nothing",
		).toEqual([]);
	});

	it("groups every profile under a slot its family grammar allows", () => {
		const misfiled: string[] = [];
		for (const slot of CAPABILITY_SLOTS) {
			// SAFETY: each catalog slot is a record of named profile IDs.
			const group = capability[slot] as Readonly<Record<string, string>>;
			const allowed = FAMILIES_BY_SLOT[slot] ?? [slot];
			for (const profileId of Object.values(group)) {
				if (!allowed.includes(familyOf(profileId))) {
					misfiled.push(`${slot} <- ${profileId}`);
				}
			}
		}
		expect(
			misfiled,
			"core groups these profiles under a slot whose family grammar @hobo/yards would refuse with SLOT_PROFILE_MISMATCH",
		).toEqual([]);
	});

	it("resolves each profile back to the slot that lists it", () => {
		for (const slot of CAPABILITY_SLOTS) {
			// SAFETY: each catalog slot is a record of named profile IDs.
			const group = capability[slot] as Readonly<Record<string, string>>;
			for (const profileId of Object.values(group)) {
				expect(slotForProfile(profileId), `slotForProfile(${profileId})`).toBe(
					slot,
				);
			}
		}
	});

	it("lists no profile twice, under one slot or across two", () => {
		const seen = new Map<string, string>();
		const duplicates: string[] = [];
		for (const slot of CAPABILITY_SLOTS) {
			for (const profileId of Object.values(
				// SAFETY: each catalog slot is a record of named profile IDs.
				capability[slot] as Readonly<Record<string, string>>,
			)) {
				const previous = seen.get(profileId);
				if (previous !== undefined) {
					duplicates.push(`${profileId} in both ${previous} and ${slot}`);
				}
				seen.set(profileId, slot);
			}
		}
		expect(duplicates).toEqual([]);
	});
});

describe("the non-relational umbrella is reachable from its refinements", () => {
	/**
	 * The point of an umbrella profile is that an app can ask for the broad
	 * thing. That only works if every concrete non-relational engine refines
	 * into it — an engine that does not is invisible to such a request.
	 */
	it("every non-relational engine refines data.nosql/v1", () => {
		const umbrella = "data.nosql/v1";
		const byId = new Map(
			STANDARD_CAPABILITY_PROFILES.map((profile) => [profile.id, profile]),
		);

		const reaches = (id: string, seen = new Set<string>()): boolean => {
			if (id === umbrella) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			return (byId.get(id)?.refines ?? []).some((parent) =>
				reaches(parent, seen),
			);
		};

		const engines = [
			"data.document/v1",
			"data.graph/v1",
			"data.wide-column/v1",
			"data.vector/v1",
			"data.vector.pgvector/v1",
		];
		const orphaned = engines.filter((id) => !reaches(id));
		expect(
			orphaned,
			"these non-relational engines do not reach data.nosql/v1 through refinement, so an app requiring the umbrella cannot be served by them",
		).toEqual([]);
	});

	it("does not make a relational engine satisfy the non-relational umbrella", () => {
		const byId = new Map(
			STANDARD_CAPABILITY_PROFILES.map((profile) => [profile.id, profile]),
		);
		const reaches = (id: string, target: string, seen = new Set<string>()) => {
			if (id === target) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			return (byId.get(id)?.refines ?? []).some((parent) =>
				reaches(parent, target, seen),
			);
		};

		// The two umbrellas are disjoint claims, not a hierarchy. If Postgres
		// reached data.nosql/v1, "give me any non-relational store" would be
		// answerable with a SQL database, which is exactly the mismatch the
		// umbrella exists to prevent.
		for (const relational of [
			"data.postgres/v1",
			"data.mysql/v1",
			"data.sqlite/v1",
			"data.relational/v1",
		]) {
			expect(
				reaches(relational, "data.nosql/v1"),
				`${relational} must not satisfy data.nosql/v1`,
			).toBe(false);
		}
	});
});
