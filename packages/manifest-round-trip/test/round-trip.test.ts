/**
 * The cross-manifest round trip: every decomposed shape checked against the
 * fixtures the packages on both sides of the seam are pinned by.
 *
 * Each manifest package already round-trips its own shape against its own
 * fixtures. What none of them can check is the *seam*:
 *
 * 1. The plan digest is a constant copied into three of `@hobo/cloud`'s test
 *    files and a fourth in `@hobo/manifest-plan`. Every one of those is a
 *    transcription. Here they are read out of the source text, so a plan schema
 *    that lost a field is caught against the number the rest of the repo
 *    actually asserts rather than against a copy of it.
 * 2. The declaration and the plan describe the same graph — the declaration
 *    says what is wanted and the plan says what was chosen — and no test
 *    anywhere checks that the graph survived the lowering, because the two
 *    shapes now live in different packages.
 * 3. `SelectionCandidate` moved away from the gates that read it. So every
 *    candidate the selection suite exercises is put through the codec and the
 *    gates a second time, and must reach the same verdict.
 *
 * `@hobo/cloud` is read as data, never imported: it is a layer-3 application
 * package and an edge to it from here is an `outward-dependency` the boundary
 * gate refuses. Reading is also stricter — a copied constant cannot drift from
 * its source while a read one can.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	type SelectionCandidate,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
} from "@hobo/capability-profiles";
import { parseResourceIntent } from "@hobo/manifest-declaration";
import {
	canonicalPlanJson,
	hashDeploymentPlan,
	parseDeploymentPlan,
} from "@hobo/manifest-plan";
import {
	fromSelectionCandidateRecord,
	toSelectionCandidateRecord,
} from "@hobo/manifest-request";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relative: string): string =>
	readFileSync(`${REPO_ROOT}${relative}`, "utf8");
const readJson = (relative: string): unknown => JSON.parse(read(relative));

// ─── 1. The plan digest, read from every file that pins it ──────────────────

/** Every `const <NAME> =\n"sha256:…"` in a file, by constant name. */
function pinnedDigests(source: string): ReadonlyMap<string, string> {
	const found = new Map<string, string>();
	for (const match of source.matchAll(
		/const\s+([A-Z][A-Z0-9_]*)\s*=\s*\n?\s*"(sha256:[0-9a-f]{64})"/gu,
	)) {
		found.set(match[1] as string, match[2] as string);
	}
	return found;
}

const PINNING_FILES = [
	"packages/cloud/test/planner.test.ts",
	"packages/cloud/test/gateway.test.ts",
	"packages/cloud/test/placement.test.ts",
	"packages/manifest-plan/test/round-trip.test.ts",
] as const;

describe("the golden plan digest, against every file that pins it", () => {
	const pins = PINNING_FILES.map(
		(file) =>
			[
				file,
				pinnedDigests(read(file)).get("HELLO_BINDLE_PLAN_HASH") ??
					pinnedDigests(read(file)).get("GOLDEN_PLAN_HASH"),
			] as const,
	);

	it("finds the constant in all four files, so the comparison is not vacuous", () => {
		for (const [file, digest] of pins) {
			expect(digest, `no plan digest constant found in ${file}`).toMatch(
				/^sha256:[0-9a-f]{64}$/u,
			);
		}
		expect(pins.length).toBe(4);
	});

	it("all four transcriptions of it agree", () => {
		expect(new Set(pins.map(([, digest]) => digest)).size).toBe(1);
	});

	it("and @hobo/manifest-plan reproduces it from @hobo/cloud's committed fixture", () => {
		const raw = readJson("packages/cloud/test/fixtures/golden-plan.json");
		const parsed = parseDeploymentPlan(raw);
		expect(hashDeploymentPlan(parsed)).toBe(pins[0]?.[1]);
		// Byte-identical, not merely equal: a lost field, a materialised absent
		// optional and a reordered array all survive a structural comparison.
		expect(canonicalPlanJson(parsed)).toBe(
			JSON.stringify(sortKeysIndependently(raw)),
		);
	});
});

/** Written independently of the module under test, on purpose. */
function sortKeysIndependently(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeysIndependently);
	if (value && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort())
			out[key] = sortKeysIndependently(source[key]);
		return out;
	}
	return value;
}

// ─── 2. The declaration and the plan describe the same graph ────────────────

type ManifestResource = {
	readonly type: string;
	readonly port?: string;
	readonly bind?: readonly string[];
};

/**
 * The hello-bindle manifest lowered to declarations.
 *
 * The lowering rule is `@hobo/cloud`'s, restated on the two fields it turns on:
 * a `component.v1` resource asks for the `compute` port, a `data.v1` resource
 * names its own, and `bind` becomes `deps`. Restating it is the point — if the
 * real lowering changes, the plan below stops matching and this test says so,
 * which a shared helper would hide.
 */
function lowerToIntents(): readonly ReturnType<typeof parseResourceIntent>[] {
	const manifest = readJson(
		"packages/cloud/test/fixtures/hello-bindle.manifest.json",
	) as { readonly resources: Readonly<Record<string, ManifestResource>> };
	return Object.entries(manifest.resources).map(([name, resource]) =>
		parseResourceIntent({
			name,
			port: resource.type === "component.v1" ? "compute" : resource.port,
			require: [],
			prefer: [],
			negotiation: "require",
			deps: [...(resource.bind ?? [])],
			objective: "min-cost",
		}),
	);
}

describe("the declaration and the plan describe the same graph", () => {
	const intents = lowerToIntents();
	const plan = parseDeploymentPlan(
		readJson("packages/cloud/test/fixtures/golden-plan.json"),
	);

	it("every resource in the manifest parses as a ResourceIntent", () => {
		expect(intents.map((intent) => intent.name).sort()).toEqual([
			"assets",
			"service",
			"sessions",
		]);
	});

	it("names the same nodes on both sides of the lowering", () => {
		expect(plan.resources.map((node) => node.name).sort()).toEqual(
			intents.map((intent) => intent.name).sort(),
		);
	});

	it("names the same ports", () => {
		const byName = new Map(intents.map((i) => [i.name, i.port]));
		for (const node of plan.resources) {
			expect(node.port).toBe(byName.get(node.name));
		}
	});

	it("carries the same edges, as a set — the plan sorts what the manifest does not", () => {
		// `service` binds `["sessions", "assets"]` in the manifest and depends on
		// `["assets", "sessions"]` in the plan. The plan is content-addressed, so
		// its ordering is load-bearing and the declaration's is not; comparing
		// them as sequences would fail on a difference that is by design.
		const byName = new Map(intents.map((i) => [i.name, [...i.deps].sort()]));
		for (const node of plan.resources) {
			expect([...node.deps].sort()).toEqual(byName.get(node.name));
		}
		// And at least one node has edges, or the loop above compares empties.
		expect(plan.resources.some((node) => node.deps.length > 0)).toBe(true);
	});

	it("orders every node after the nodes it depends on", () => {
		const position = new Map(
			plan.dependencyOrder.map((name, index) => [name, index] as const),
		);
		for (const node of plan.resources) {
			for (const dep of node.deps) {
				expect(position.get(dep)).toBeLessThan(
					position.get(node.name) as number,
				);
			}
		}
	});
});

// ─── 3. The candidate codec is decision-preserving ──────────────────────────

const registry = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
const NOW = Date.UTC(2026, 7, 8);
const FRESH = NOW + 20 * 24 * 60 * 60 * 1000;

const BASE: SelectionCandidate = {
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
	evidenceExpiresAtMs: FRESH,
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
};

type CasePatch = Partial<SelectionCandidate> & {
	readonly profiles?: readonly (
		| string
		| {
				readonly id: string;
				readonly realization?: string;
				readonly conformance?: string;
		  }
	)[];
	readonly absent?: readonly string[];
};

/**
 * Every candidate `@hobo/capability-profiles`' own selection suite exercises,
 * read out of the case file it drives itself from.
 */
function selectionCaseCandidates(): readonly SelectionCandidate[] {
	const lines = read("packages/capability-profiles/test/selection.cases.jsonl")
		.split("\n")
		.filter((line) => line.trim().length > 0 && !line.startsWith("#"));
	const candidates: SelectionCandidate[] = [];
	for (const line of lines) {
		const testCase = JSON.parse(line) as {
			readonly input?: readonly {
				readonly candidates?: readonly CasePatch[];
			}[];
		};
		for (const ask of testCase.input ?? []) {
			for (const patch of ask.candidates ?? []) {
				const { profiles, absent, ...rest } = patch;
				const draft = { ...BASE, ...rest } as Record<string, unknown>;
				if (profiles) {
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
				candidates.push(draft as unknown as SelectionCandidate);
			}
		}
	}
	return candidates;
}

describe("the candidate codec is decision-preserving", () => {
	const candidates = selectionCaseCandidates();
	const REQUIREMENT = parseCapabilityRequirement({
		requiredProfiles: [{ profileId: "data.postgres/v1" }],
	} as never);

	const verdict = (given: readonly SelectionCandidate[]) => {
		const result = selectCapabilityImplementation({
			requirement: REQUIREMENT,
			registry,
			candidates: given,
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW,
		});
		return {
			winner: result.winner?.definitionId ?? null,
			rejections: result.rejections.map((r) => `${r.definitionId}:${r.code}`),
		};
	};

	it("reads a non-trivial corpus out of the case file", () => {
		expect(candidates.length).toBeGreaterThan(30);
	});

	it.each(
		candidates.map((c, i) => [i, c] as const),
	)("candidate %i reaches the same verdict after record -> JSON -> record", (_index, candidate) => {
		const decoded = fromSelectionCandidateRecord(
			JSON.parse(JSON.stringify(toSelectionCandidateRecord(candidate))),
		);
		expect(verdict([decoded])).toEqual(verdict([candidate]));
	});

	it("and the whole corpus at once reaches the same verdict", () => {
		// One at a time cannot catch a codec that perturbs *ranking*: the tiebreak
		// is lexicographic over fields the record carries, so a field that decoded
		// to a different value changes which of two survivors wins only when both
		// are present.
		const decoded = candidates.map((candidate) =>
			fromSelectionCandidateRecord(
				JSON.parse(JSON.stringify(toSelectionCandidateRecord(candidate))),
			),
		);
		expect(verdict(decoded)).toEqual(verdict(candidates));
	});
});
