import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { declaredFields, fieldNames } from "./fixtures/declared-fields.js";

/**
 * Evidence for the open question Swarm I settles: does `ResourceIntent` survive
 * as a distinct shape, or is it a projection of the request manifest?
 *
 * This package's answer is **it survives**, and the decisive field is
 * `placement` — with `deps` and `name` behind it. The evidence is structural
 * rather than rhetorical, and every part of it is read off the real source
 * files so it fails if the premise stops holding.
 *
 * The argument, in one line: `placement.affinities` and `placement.spread` are
 * constraints whose *operand is another node in the same plan*, and the request
 * manifest's evaluator has no channel through which a sibling node could be
 * seen. A per-capability requirement is evaluated against a catalog of
 * candidates; it is not evaluated against the rest of the graph, so a
 * relational constraint cannot be projected onto it without inventing that
 * channel — which would be a change to the request manifest, not a projection
 * of the declaration.
 *
 * A note on the brief, because it names the wrong shape. The decomposition
 * question is written as "`ResourceIntent` ... overlaps `CapabilityRequirement`
 * heavily", while §5 files `SelectionCandidate` as the request manifest.
 * `SelectionCandidate` is not a request at all: reading `selection.ts`, it is
 * the offer side — what a hosted product or pack *advertises* (`providerId`,
 * `implementsProfiles`, `evidenceSignatureValid`, `sponsorExposureMinorUnits`).
 * `CapabilityRequirement` is the ask. Both are checked below, because the
 * answer has to hold against whichever one "the request manifest" turns out to
 * mean.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function read(relativePath: string): string {
	return readFileSync(`${REPO_ROOT}${relativePath}`, "utf8");
}

// Swarm I moved these two shapes into the manifest packages and deleted the
// originals; `@hobo/capability-profiles` re-exports them and declares neither.
// So the requirement is read from its owner, the candidate from its owner, and
// `selection.ts` — which still holds the gates and `SelectionInput` — from
// where it always was. The three reads are what this evidence is about, so
// they are named separately rather than collapsed.
const REQUIREMENT = read("packages/manifest-capability/src/requirement.ts");
const CANDIDATE = read("packages/manifest-request/src/candidate.ts");
const SELECTION = read("packages/capability-profiles/src/selection.ts");
const PLAN_TYPES = read("packages/manifest-plan/src/index.ts");
const PLACEMENT = read("packages/cloud/src/planner/placement.ts");
const OWN_SOURCE = read("packages/manifest-declaration/src/index.ts");

describe("ResourceIntent against the capability requirement", () => {
	it("shares not one field name with CapabilityRequirement", () => {
		const intent = new Set(
			fieldNames(declaredFields(OWN_SOURCE, "ResourceIntent")),
		);
		const requirement = new Set(
			fieldNames(declaredFields(REQUIREMENT, "CapabilityRequirement")),
		);
		expect(intent.size).toBe(9);
		expect(requirement.size).toBe(9);
		expect([...intent].filter((field) => requirement.has(field))).toEqual([]);
	});

	it("shares not one field name with SelectionCandidate either", () => {
		const intent = new Set(
			fieldNames(declaredFields(OWN_SOURCE, "ResourceIntent")),
		);
		const candidate = new Set(
			fieldNames(declaredFields(CANDIDATE, "SelectionCandidate")),
		);
		expect(candidate.size).toBeGreaterThan(10);
		expect([...intent].filter((field) => candidate.has(field))).toEqual([]);
	});
});

describe("the field that cannot be projected", () => {
	it("the placement vocabulary appears nowhere in the request manifest", () => {
		// Not a name-overlap argument: these are the *vocabulary tokens* the
		// placement constraints are made of. If the request manifest ever grows a
		// way to say any of them, this test fails and the decision is reopened.
		for (const token of [
			"anti-affinity",
			"targetPort",
			"pickN",
			"spread",
			"objective",
			"deps",
		]) {
			expect(REQUIREMENT).not.toContain(token);
			expect(CANDIDATE).not.toContain(token);
			expect(SELECTION).not.toContain(token);
		}
		// And they are all present here, so the check is comparing something.
		for (const token of ["anti-affinity", "targetPort", "pickN", "spread"]) {
			expect(OWN_SOURCE).toContain(token);
		}
	});

	it("the request manifest's evaluator has no channel for a sibling node", () => {
		// selectCapabilityImplementation takes exactly these inputs. None of them
		// is "what has already been placed", so an affinity or spread rule has
		// nothing to evaluate against.
		expect(fieldNames(declaredFields(SELECTION, "SelectionInput"))).toEqual([
			"requirement",
			"registry",
			"candidates",
			"policy",
			"nowMs",
			"consumableBindingProfiles",
		]);

		// The declaration's evaluator takes that channel as a third argument, and
		// it is a distinct type carrying decided placements.
		expect(PLACEMENT).toContain("export interface PlacementContext {");
		expect(fieldNames(declaredFields(PLACEMENT, "DecidedPlacement"))).toEqual([
			"resource",
			"port",
			"providerId",
			"region",
		]);
	});

	it("selection deliberately has no objective, so `objective` has nowhere to go", () => {
		// From selection.ts's own header. The declaration carries a routing
		// objective; the request manifest refuses to have one on purpose, so this
		// is a designed absence rather than a missing field.
		expect(SELECTION).toContain(
			"There is deliberately no weighted score here.",
		);
	});
});

describe("what a projection would still have to carry", () => {
	it("names the graph identity and edges the plan is built from", () => {
		const intent = fieldNames(declaredFields(OWN_SOURCE, "ResourceIntent"));
		// `name` identifies the node; `deps` names sibling nodes by that same
		// identity. A per-capability requirement is anonymous, so both would have
		// to be reintroduced alongside any projection — at which point the
		// projection is a new shape wearing the request manifest's name.
		expect(intent).toContain("name");
		expect(intent).toContain("deps");
		expect(PLAN_TYPES).toContain("dependencyOrder");
	});

	it("is confirmed by the only intents in the repository with real edges", () => {
		// The hello-bindle lowering is the production path, and its `deps` are
		// resource names from the manifest — graph structure, not capability.
		// SAFETY: this is the repository-owned hello-bindle manifest fixture.
		const manifest = JSON.parse(
			read("packages/cloud/test/fixtures/hello-bindle.manifest.json"),
			// SAFETY: this fixture is the repository-owned manifest shape under test.
		) as { resources: Record<string, { bind?: string[] }> };
		expect(manifest.resources.service?.bind).toEqual(["sessions", "assets"]);
		for (const bound of manifest.resources.service?.bind ?? []) {
			expect(Object.keys(manifest.resources)).toContain(bound);
		}
	});
});
