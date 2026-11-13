// PlacementEngine conformance (plan 0024 D20, I18, I19). The suite owns
// neutral fleet scenarios; the harness binds each to real inventory,
// placement and score records, in the Camp order the suite dictates.
import {
	type CdConformanceReport,
	type CdReasonLike,
	type CdSuiteOptions,
	canonicalText,
	check,
	checkTypedRefusal,
	permutationsOf,
	runCdAssertions,
} from "./cd-kit.js";
import { CD_REFUSAL, type Outcome } from "./cd-shapes.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const PLACEMENT_ENGINE_SUITE = "hobo.cd.placement-engine/v1";

// public-contract: assertion names of the PlacementEngine suite.
export const PLACEMENT_ENGINE_ASSERTIONS = Object.freeze([
	"permutationDeterminism",
	"repeatDeterminism",
	"countIsHonoured",
	"taintedCampsAreExcluded",
	"claimsNeverGrantResidency",
	"missingRequiredClaimExcludes",
	"observeOnlyCampsAreExcluded",
	"unsatisfiableSpreadIsRefused",
	"expiredScoresAreIgnored",
	"everyCandidateIsAccounted",
] as const);
export type PlacementEngineAssertion =
	(typeof PLACEMENT_ENGINE_ASSERTIONS)[number];

export type ScenarioCamp = Readonly<{
	campId: string;
	yard: string;
	provider: string;
	/** Declared Yard regions; residency is evaluated only against these. */
	regions: readonly string[];
	labels: Readonly<Record<string, string>>;
	/** Observed claims (never trusted to grant). */
	claims?: Readonly<Record<string, string>>;
	taints?: readonly ("NO_PLACE" | "NO_RUN")[];
	management?: "MANAGED" | "OBSERVE_ONLY";
}>;

export type ScenarioScore = Readonly<{
	score: string;
	byCamp: Readonly<Record<string, number>>;
	validUntilMs: number;
}>;

export type PlacementSpec = Readonly<{
	count: number;
	spread?: readonly Readonly<{
		topologyKey: "yard" | "provider" | "region";
		minGroups: number;
	}>[];
	requiredClaims?: readonly string[];
	scores?: readonly Readonly<{ score: string; weight: number }>[];
	/** Subject residency: allowed declared regions (empty = unrestricted). */
	residencyRegions?: readonly string[];
	defaultGroupSize?: number;
}>;

export type PlacementScenario = Readonly<{
	camps: readonly ScenarioCamp[];
	scores: readonly ScenarioScore[];
	placement: PlacementSpec;
	nowMs: number;
}>;

/** Structural view of PlacementDecisionRecord. */
export type PlacementDecisionLike = Readonly<{
	inventoryDigest: string;
	scoreSnapshotDigests: readonly string[];
	groups: readonly Readonly<{ name: string; campIds: readonly string[] }>[];
	candidates: readonly Readonly<{
		campId: string;
		selected: boolean;
		exclusionCodes: readonly string[];
	}>[];
	reasons: readonly CdReasonLike[];
}>;

export interface PlacementEngineHarness {
	readonly subject: string;
	/** Build a fresh world (Camps registered in `order`), define, score, decide. */
	decide(
		scenario: PlacementScenario,
		order: readonly string[],
	): Promise<Outcome<PlacementDecisionLike>>;
}

function camp(
	campId: string,
	provider: string,
	region: string,
	extra: Partial<ScenarioCamp> = {},
): ScenarioCamp {
	return {
		campId,
		yard: `yard-${provider}-${region}`,
		provider,
		regions: [region],
		labels: { tier: "edge" },
		...extra,
	};
}

/** The suite's reference fleet: three providers, three regions. */
export function referenceFleet(): readonly ScenarioCamp[] {
	return [
		camp("camp-a1", "aws", "eu-west"),
		camp("camp-a2", "aws", "us-east"),
		camp("camp-g1", "gcp", "eu-west"),
		camp("camp-g2", "gcp", "us-east"),
		camp("camp-h1", "hetzner", "eu-central"),
		camp("camp-h2", "hetzner", "eu-central"),
	];
}

function selected(decision: PlacementDecisionLike): readonly string[] {
	return decision.candidates
		.filter((c) => c.selected)
		.map((c) => c.campId)
		.sort();
}

export async function runPlacementEngineConformance(
	harness: PlacementEngineHarness,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<PlacementEngineAssertion>> {
	const base: PlacementScenario = {
		camps: referenceFleet(),
		scores: [
			{
				score: "latency",
				byCamp: {
					"camp-a1": 0.9,
					"camp-g1": 0.8,
					"camp-h1": 0.7,
					"camp-a2": 0.2,
				},
				validUntilMs: 10_000_000,
			},
		],
		placement: {
			count: 4,
			spread: [{ topologyKey: "provider", minGroups: 2 }],
			scores: [{ score: "latency", weight: 1 }],
			defaultGroupSize: 2,
		},
		nowMs: 1_000_000,
	};
	const ids = (scenario: PlacementScenario) =>
		scenario.camps.map((c) => c.campId);
	const decided = async (
		scenario: PlacementScenario,
		order: readonly string[] = ids(scenario),
	): Promise<PlacementDecisionLike> => {
		const outcome = await harness.decide(scenario, order);
		check(
			outcome.ok,
			`a satisfiable placement was refused: ${outcome.ok ? "" : outcome.reasons.map((r) => r.code).join(",")}`,
			"decide over the eligible Camps",
		);
		if (!outcome.ok) throw new Error("refused");
		return outcome.value;
	};
	const excluded = (
		decision: PlacementDecisionLike,
		campId: string,
		why: string,
		remediation: string,
	) => {
		const candidate = decision.candidates.find((c) => c.campId === campId);
		check(
			candidate !== undefined && !candidate.selected,
			`${campId} was placed although ${why}`,
			remediation,
		);
		check(
			(candidate?.exclusionCodes.length ?? 0) > 0,
			`${campId} is excluded without an exclusion code`,
			"record every candidate's exclusion codes (D20)",
		);
	};
	const withCamps = (
		map: (c: ScenarioCamp) => ScenarioCamp,
	): PlacementScenario => ({ ...base, camps: base.camps.map(map) });
	return runCdAssertions<PlacementEngineAssertion>(
		PLACEMENT_ENGINE_SUITE,
		harness.subject,
		{
			permutationDeterminism: async () => {
				const orders = permutationsOf(ids(base), 6);
				const reference = canonicalText(
					await decided(base, orders[0] ?? ids(base)),
				);
				for (const order of orders.slice(1)) {
					const text = canonicalText(await decided(base, order));
					check(
						text === reference,
						`inventory order ${order.join(",")} changed the decision`,
						"placement is independent of input order (I18)",
					);
				}
			},
			repeatDeterminism: async () => {
				const a = canonicalText(await decided(base));
				const b = canonicalText(await decided(base));
				check(
					a === b,
					"the same inputs produced different decisions",
					"decide is pure over recorded inputs (I18)",
				);
			},
			countIsHonoured: async () => {
				const decision = await decided(base);
				check(
					selected(decision).length === 4,
					`count 4 selected ${selected(decision).length}`,
					"take exactly `count` eligible Camps",
				);
				const grouped = decision.groups.flatMap((g) => g.campIds).sort();
				check(
					grouped.join(",") === selected(decision).join(","),
					"groups do not partition the selected Camps",
					"every selected Camp is in exactly one group",
				);
			},
			taintedCampsAreExcluded: async () => {
				const scenario = withCamps((c) =>
					c.campId === "camp-a1" ? { ...c, taints: ["NO_PLACE"] } : c,
				);
				excluded(
					await decided(scenario),
					"camp-a1",
					"it is NO_PLACE-tainted",
					"untolerated taints exclude a Camp (D19)",
				);
			},
			claimsNeverGrantResidency: async () => {
				const scenario: PlacementScenario = {
					...withCamps((c) =>
						c.campId === "camp-a1"
							? { ...c, claims: { region: "us-east" } }
							: c,
					),
					placement: { count: 2, residencyRegions: ["us-east"] },
				};
				const decision = await decided(scenario);
				excluded(
					decision,
					"camp-a1",
					"only its claim (not its declared region) satisfies residency",
					"residency uses declared regions only; claims narrow, never grant (I19)",
				);
				check(
					selected(decision).join(",") === "camp-a2,camp-g2",
					`selected ${selected(decision).join(",")}`,
					"place on Camps whose declared regions satisfy residency",
				);
			},
			missingRequiredClaimExcludes: async () => {
				const scenario: PlacementScenario = {
					...withCamps((c) =>
						c.provider === "gcp" ? { ...c, claims: { gpu: "a100" } } : c,
					),
					placement: { count: 0, requiredClaims: ["gpu"] },
				};
				const decision = await decided(scenario);
				check(
					selected(decision).join(",") === "camp-g1,camp-g2",
					`selected ${selected(decision).join(",")}`,
					"required_claims exclude Camps without the claim",
				);
				excluded(
					decision,
					"camp-a1",
					"it lacks a required claim",
					"required_claims exclude Camps without the claim",
				);
			},
			observeOnlyCampsAreExcluded: async () => {
				const scenario = withCamps((c) =>
					c.campId === "camp-g1" ? { ...c, management: "OBSERVE_ONLY" } : c,
				);
				excluded(
					await decided(scenario),
					"camp-g1",
					"it is OBSERVE_ONLY",
					"placement considers MANAGED Camps only (D20)",
				);
			},
			unsatisfiableSpreadIsRefused: async () => {
				const scenario: PlacementScenario = {
					...base,
					camps: base.camps.filter((c) => c.provider !== "hetzner"),
					placement: {
						count: 0,
						spread: [{ topologyKey: "provider", minGroups: 3 }],
					},
				};
				checkTypedRefusal(
					await harness.decide(scenario, ids(scenario)),
					"spread provider min 3 over two providers",
					CD_REFUSAL.placementUnsatisfiable,
				);
			},
			expiredScoresAreIgnored: async () => {
				const expired: PlacementScenario = {
					...base,
					scores: [
						{
							...base.scores[0],
							score: "latency",
							byCamp: { "camp-h2": 99, "camp-g2": 98 },
							validUntilMs: base.nowMs - 1,
						},
					],
				};
				const none: PlacementScenario = { ...base, scores: [] };
				const a = selected(await decided(expired)).join(",");
				const b = selected(await decided(none)).join(",");
				check(
					a === b,
					`an expired score changed the selection (${a} vs ${b})`,
					"ignore expired score snapshots; never extrapolate (D20)",
				);
			},
			everyCandidateIsAccounted: async () => {
				const decision = await decided(base);
				const seen = new Set(decision.candidates.map((c) => c.campId));
				for (const c of base.camps)
					check(
						seen.has(c.campId),
						`${c.campId} is missing from candidates`,
						"record every candidate",
					);
				check(
					decision.inventoryDigest.length > 0,
					"decision records no inventory digest",
					"record the inventory digest (I18)",
				);
				for (const c of decision.candidates) {
					check(
						!c.selected || c.exclusionCodes.length === 0,
						`${c.campId} is selected with exclusion codes`,
						"selected Camps carry no exclusion codes",
					);
				}
			},
		},
		options,
	);
}
