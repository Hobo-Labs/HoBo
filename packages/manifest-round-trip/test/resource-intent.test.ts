import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseCapabilityRequirement } from "@hobo/manifest-capability";
import { parseResourceIntent } from "@hobo/manifest-declaration";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relative: string): string =>
	readFileSync(`${REPO_ROOT}${relative}`, "utf8");

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
			"cadence",
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
		const projected = parseCapabilityRequirement({
			requiredProfiles: INTENT.require.map((profileId) => ({ profileId })),
			name: INTENT.name,
			deps: [...INTENT.deps],
			objective: INTENT.objective,
			placement: INTENT.placement,
		} as never);

		for (const field of ["name", "deps", "objective", "placement"]) {
			expect(Object.hasOwn(projected, field)).toBe(false);
		}
		expect(projected.requiredProfiles.map((p) => p.profileId)).toEqual([
			"data.postgres/v1",
		]);
	});
});

describe("the evaluator has no operand for a relational constraint", () => {
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
