/**
 * Does `ResourceIntent` survive as a distinct shape, or is it a projection of
 * the request manifest?
 *
 * `@hobo/manifest-declaration` answered **yes, it survives**, with `placement`
 * as the decisive field. This file is a *second* answer, deliberately reached
 * from different sources, because agreeing with an inherited conclusion by
 * restating it is not checking it.
 *
 * Three independent lines, in increasing order of how hard they are to argue
 * with:
 *
 * 1. **The wire contracts, not the TypeScript.** The declaration's answer reads
 *    `.ts` declarations. The schema is the contract in this repo, so the same
 *    question is asked of the four `data-models/*.proto` files.
 * 2. **The parse boundary, at runtime.** Not "these files do not contain the
 *    token `placement`" — a grep says nothing about what the code does. The
 *    projection is actually performed: an intent's fields are handed to
 *    `parseCapabilityRequirement`, and what comes back is inspected.
 * 3. **The evaluator's inputs.** A relational constraint needs an operand. If
 *    the request manifest's evaluator cannot see a sibling node, no projection
 *    onto it can carry one.
 *
 * The result is agreement, and one correction: the request manifest does not
 * *refuse* the surviving fields, it **silently drops** them. That is a worse
 * failure than a refusal and a stronger argument for the shape surviving, since
 * a projection that loses fields without saying so is exactly the decomposition
 * defect this package exists to catch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseCapabilityRequirement } from "@hobo/manifest-capability";
import { parseResourceIntent } from "@hobo/manifest-declaration";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relative: string): string =>
	readFileSync(`${REPO_ROOT}${relative}`, "utf8");

/** Field names of a proto message, by message name. */
function protoFields(source: string, message: string): readonly string[] {
	const opener = new RegExp(`\\bmessage\\s+${message}\\s*\\{`, "u");
	const match = opener.exec(source);
	if (match === null) throw new Error(`no proto message named ${message}`);
	let depth = 0;
	const start = match.index + match[0].length - 1;
	let end = start;
	for (let i = start; i < source.length; i += 1) {
		if (source[i] === "{") depth += 1;
		else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	const body = source
		.slice(start + 1, end)
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/\/\/[^\n]*/gu, "");
	return [
		...body.matchAll(
			/(?:^|\n)\s*(?:optional\s+|repeated\s+)?[\w.<>, ]+?\s+([a-z_][\w]*)\s*=\s*\d+\s*;/gu,
		),
	].map((field) => field[1] as string);
}

const INTENT_PROTO = read(
	"packages/manifest-declaration/data-models/resource_intent.proto",
);
const REQUIREMENT_PROTO = read(
	"packages/manifest-capability/data-models/capability_requirement.proto",
);
const CANDIDATE_PROTO = read(
	"packages/manifest-request/data-models/selection_candidate.proto",
);

describe("the wire contracts, read instead of the TypeScript", () => {
	const intent = protoFields(INTENT_PROTO, "ResourceIntent");

	it("reads a full field list from all three, so the comparisons are not vacuous", () => {
		expect(intent).toEqual([
			"name",
			"port",
			"require",
			"prefer",
			"negotiation",
			"deps",
			"region",
			"objective",
			"placement",
		]);
		expect(
			protoFields(REQUIREMENT_PROTO, "CapabilityRequirement").length,
		).toBeGreaterThan(5);
		expect(
			protoFields(CANDIDATE_PROTO, "SelectionCandidateRecord").length,
		).toBeGreaterThan(10);
	});

	it("ResourceIntent shares no field name with either request-manifest message", () => {
		for (const [proto, message] of [
			[REQUIREMENT_PROTO, "CapabilityRequirement"],
			[CANDIDATE_PROTO, "SelectionCandidateRecord"],
		] as const) {
			const other = new Set(protoFields(proto, message));
			expect(intent.filter((field) => other.has(field))).toEqual([]);
		}
	});

	it("the placement messages exist only in the declaration's contract", () => {
		for (const message of [
			"PlacementCriteria",
			"PlacementAffinityRule",
			"PlacementSpread",
			"PlacementPickN",
		]) {
			expect(INTENT_PROTO).toContain(`message ${message} {`);
			expect(REQUIREMENT_PROTO).not.toContain(message);
			expect(CANDIDATE_PROTO).not.toContain(message);
		}
	});
});

describe("the projection, performed rather than argued about", () => {
	// A real intent with everything the question turns on: a graph identity, an
	// edge, an objective, and a relational placement constraint.
	const INTENT = parseResourceIntent({
		name: "sessions",
		port: "kv",
		require: ["data.postgres/v1"],
		prefer: [],
		negotiation: "require",
		deps: ["assets"],
		objective: "min-cost",
		placement: {
			selectors: [{ key: "region", op: "in", values: ["ENAM"] }],
			affinities: [
				{ mode: "anti-affinity", targetPort: "compute", scope: "region" },
			],
			spread: { dimension: "region" },
		},
	});

	it("carries the four fields the question is about", () => {
		expect(INTENT.name).toBe("sessions");
		expect(INTENT.deps).toEqual(["assets"]);
		expect(INTENT.objective).toBe("min-cost");
		expect(INTENT.placement?.affinities.length).toBe(1);
	});

	it("survives its own round trip, so the loss below is the projection's and not the intent's", () => {
		expect(parseResourceIntent(JSON.parse(JSON.stringify(INTENT)))).toEqual(
			INTENT,
		);
	});

	it("loses all four to the capability requirement — silently, without a refusal", () => {
		// The only projection that exists: the required profiles are the ask, and
		// everything else is offered alongside to see whether it is carried.
		const projected = parseCapabilityRequirement({
			requiredProfiles: INTENT.require.map((profileId) => ({ profileId })),
			name: INTENT.name,
			deps: [...INTENT.deps],
			objective: INTENT.objective,
			placement: INTENT.placement,
		} as never);

		// This is the correction to the inherited answer. The boundary does not
		// refuse these — it drops them, and a caller that projected an intent this
		// way would get a requirement back that looks fine and has lost the graph.
		for (const field of ["name", "deps", "objective", "placement"]) {
			expect(Object.hasOwn(projected, field)).toBe(false);
		}
		// And the parse did happen, so the assertion above is not about a throw.
		expect(projected.requiredProfiles.map((p) => p.profileId)).toEqual([
			"data.postgres/v1",
		]);
	});
});

describe("the evaluator has no operand for a relational constraint", () => {
	// `placement.affinities` and `placement.spread` constrain a node relative to
	// *another node in the same plan*. Selection is evaluated against a catalog
	// of candidates; there is no channel through which a sibling could be seen,
	// so projecting the constraint would mean inventing one — a change to the
	// request manifest, not a projection of the declaration.
	const SELECTION = read("packages/capability-profiles/src/selection.ts");
	const PLACEMENT = read("packages/cloud/src/planner/placement.ts");

	it("SelectionInput names a catalog and nothing about the rest of the graph", () => {
		const body = /export type SelectionInput = \{([\s\S]*?)\n\};/u.exec(
			SELECTION,
		);
		expect(body).not.toBeNull();
		const fields = [
			...(body?.[1] ?? "").matchAll(/^\treadonly ([\w]+)\??:/gmu),
		].map((match) => match[1]);
		expect(fields).toEqual([
			"requirement",
			"registry",
			"candidates",
			"policy",
			"nowMs",
			"consumableBindingProfiles",
		]);
	});

	it("the declaration's evaluator takes that channel as a separate argument", () => {
		expect(PLACEMENT).toContain("export interface PlacementContext {");
		expect(PLACEMENT).toMatch(/context\s*:\s*PlacementContext,/u);
	});

	it("selection states the absence of an objective as a decision, not an omission", () => {
		expect(SELECTION).toContain(
			"There is deliberately no weighted score here.",
		);
	});
});
