// WP22 pure `decide` (D20): determinism under any input order (I18), expired
// scores ignored, claims never granting (I19), unbound sets invisible, spread
// refusals naming the key, and every exclusion carrying a code.
import { create, toBinary } from "@bufbuild/protobuf";
import type { ResidencyConstraint } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	CampClaimRecordSchema,
	CampManagement,
	CampStatusRecordSchema,
	PlacementDecisionRecordSchema,
	PlacementGroupRecordSchema,
	type PlacementRecord,
	PlacementRecordSchema,
	ScoreSnapshotRecordSchema,
	ScoreWeightRecordSchema,
	SelectorRecordSchema,
	SpreadConstraintRecordSchema,
	TaintEffect,
	TaintRecordSchema,
	TolerationRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { PLACEMENT_SCHEMA, PLACEMENT_UNSATISFIABLE } from "../../src/events.js";
import {
	type DecideInput,
	decidePlacement,
	scoreDigest,
} from "../../src/placement/index.js";
import type {
	CampTopology,
	CampView,
	InventorySnapshot,
} from "../../src/ports.js";
import { MINUTE, railDelivery, T0, topology } from "../inventory/fakes.js";

const EU_ONLY: ResidencyConstraint = {
	classifications: [],
	allowedJurisdictions: ["eu"],
};

function view(
	top: CampTopology,
	status: Partial<
		Parameters<typeof create<typeof CampStatusRecordSchema>>[1]
	> = {},
): CampView {
	return {
		topology: top,
		status: create(CampStatusRecordSchema, {
			campId: top.campId,
			management: CampManagement.MANAGED,
			...status,
		}),
	};
}

function snapshot(
	views: CampView[],
	digest = `sha256:${"1".repeat(64)}` as const,
): InventorySnapshot {
	return { digest, camps: views };
}

function placement(
	overrides: Partial<
		Parameters<typeof create<typeof PlacementRecordSchema>>[1]
	> = {},
): PlacementRecord {
	return create(PlacementRecordSchema, {
		schemaVersion: PLACEMENT_SCHEMA,
		name: "web",
		campSets: ["fleet"],
		...overrides,
	});
}

function score(
	name: string,
	byCamp: Record<string, number>,
	validUntilMs: number,
	reportedAtMs = T0 - MINUTE,
) {
	const record = create(ScoreSnapshotRecordSchema, {
		score: name,
		byCamp,
		validUntil: new Date(validUntilMs).toISOString(),
		reportedBy: "service:scorer",
		reportedAt: new Date(reportedAtMs).toISOString(),
	});
	return create(ScoreSnapshotRecordSchema, {
		...record,
		digest: scoreDigest(record),
	});
}

function input(overrides: Partial<DecideInput> = {}): DecideInput {
	return {
		placement: placement(),
		snapshot: snapshot([]),
		scores: [],
		subject: { classifications: [], residency: [] },
		railDelivery: railDelivery({ campSets: ["fleet"] }),
		approvedProviders: ["aws", "gcp", "azure"],
		pipeline: "shop",
		node: "prod",
		atMs: T0,
		...overrides,
	};
}

function codeOf(result: ReturnType<typeof decidePlacement>, code: string) {
	return result.ok
		? undefined
		: result.reasons.find((entry) => entry.code === code);
}

/** Deterministic Fisher-Yates driven by a 32-bit LCG (no RNG in the code under test; the test owns its seed). */
function shuffle<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let state = seed >>> 0;
	for (let index = out.length - 1; index > 0; index -= 1) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		const pick = state % (index + 1);
		[out[index], out[pick]] = [out[pick] as T, out[index] as T];
	}
	return out;
}

describe("decidePlacement determinism (I18)", () => {
	it("property: any permutation of inventory and score order yields a byte-identical decision", () => {
		const providers = ["aws", "gcp", "azure"];
		const regions = ["eu-west-1", "eu-central-1", "europe-west1"];
		const views = Array.from({ length: 24 }, (_, index) =>
			view(
				topology(`camp-${String(index).padStart(2, "0")}`, {
					provider: providers[index % 3],
					regions: [regions[index % 3] ?? "eu"],
					yardId: `yard-${index % 4}`,
					labels: { ring: index < 4 ? "pilot" : "main" },
				}),
				{
					taints:
						index % 7 === 0
							? [
									create(TaintRecordSchema, {
										key: "maintenance",
										effect: TaintEffect.NO_PLACE,
									}),
								]
							: [],
				},
			),
		);
		const scores = [
			score(
				"capacity",
				Object.fromEntries(
					views.map((entry, index) => [
						entry.topology.campId,
						(index * 37) % 11,
					]),
				),
				T0 + MINUTE,
			),
			score(
				"latency",
				Object.fromEntries(
					views.map((entry, index) => [
						entry.topology.campId,
						(index * 13) % 5,
					]),
				),
				T0 + MINUTE,
			),
			score("capacity", { "camp-01": 999 }, T0 - 1),
		];
		const base = input({
			placement: placement({
				count: 12,
				spread: [
					create(SpreadConstraintRecordSchema, {
						topologyKey: "provider",
						minGroups: 3,
					}),
					create(SpreadConstraintRecordSchema, {
						topologyKey: "yard",
						minGroups: 2,
						maxGroups: 3,
					}),
				],
				scores: [
					create(ScoreWeightRecordSchema, { score: "capacity", weight: 2 }),
					create(ScoreWeightRecordSchema, { score: "latency", weight: -1 }),
				],
				groups: [
					create(PlacementGroupRecordSchema, {
						name: "pilot",
						selector: create(SelectorRecordSchema, {
							labels: { ring: "pilot" },
						}),
						maxSize: 2,
					}),
				],
				defaultGroupSize: 4,
			}),
			snapshot: snapshot(views),
			scores,
			subject: { classifications: ["pii"], residency: [EU_ONLY] },
		});
		const reference = decidePlacement(base);
		expect(reference.ok).toBe(true);
		const bytes = reference.ok
			? toBinary(PlacementDecisionRecordSchema, reference.value)
			: new Uint8Array();
		for (let seed = 1; seed <= 200; seed += 1) {
			const permuted = decidePlacement({
				...base,
				snapshot: snapshot(shuffle(views, seed)),
				scores: shuffle(scores, seed * 7919),
			});
			expect(permuted.ok).toBe(true);
			expect(
				permuted.ok
					? toBinary(PlacementDecisionRecordSchema, permuted.value)
					: undefined,
			).toEqual(bytes);
		}
	});

	it("records the inventory digest and the digests of the score snapshots it used", () => {
		const views = [view(topology("a")), view(topology("b"))];
		const live = score("capacity", { a: 1, b: 2 }, T0 + MINUTE);
		const result = decidePlacement(
			input({
				placement: placement({
					scores: [
						create(ScoreWeightRecordSchema, { score: "capacity", weight: 1 }),
					],
				}),
				snapshot: snapshot(views),
				scores: [live],
			}),
		);
		expect(result.ok ? result.value.inventoryDigest : "").toBe(
			`sha256:${"1".repeat(64)}`,
		);
		expect(result.ok ? result.value.scoreSnapshotDigests : []).toEqual([
			live.digest,
		]);
		expect(result.ok ? result.value.decisionId : "").toMatch(
			/^pd-[0-9a-f]{32}$/u,
		);
	});

	it("expired scores are ignored, never extrapolated", () => {
		const views = [view(topology("a")), view(topology("b"))];
		const expired = score("capacity", { a: 100, b: 0 }, T0);
		const live = score(
			"capacity",
			{ a: 0, b: 5 },
			T0 + MINUTE,
			T0 - 2 * MINUTE,
		);
		const result = decidePlacement(
			input({
				placement: placement({
					count: 1,
					scores: [
						create(ScoreWeightRecordSchema, { score: "capacity", weight: 1 }),
					],
				}),
				snapshot: snapshot(views),
				scores: [expired, live],
			}),
		);
		expect(
			result.ok
				? result.value.candidates.filter((c) => c.selected).map((c) => c.campId)
				: [],
		).toEqual(["b"]);
		expect(result.ok ? result.value.scoreSnapshotDigests : []).toEqual([
			live.digest,
		]);
		const onlyExpired = decidePlacement(
			input({
				placement: placement({
					count: 1,
					scores: [
						create(ScoreWeightRecordSchema, { score: "capacity", weight: 1 }),
					],
				}),
				snapshot: snapshot(views),
				scores: [expired],
			}),
		);
		expect(
			onlyExpired.ok
				? onlyExpired.value.candidates.map((c) => [
						c.campId,
						c.score,
						c.selected,
					])
				: [],
		).toEqual([
			["a", 0, true],
			["b", 0, false],
		]);
		expect(
			onlyExpired.ok ? onlyExpired.value.scoreSnapshotDigests : ["x"],
		).toEqual([]);
	});

	it("a snapshot reported in the future of atMs is not used", () => {
		const views = [view(topology("a")), view(topology("b"))];
		const future = score(
			"capacity",
			{ a: 0, b: 9 },
			T0 + 2 * MINUTE,
			T0 + MINUTE,
		);
		const result = decidePlacement(
			input({
				placement: placement({
					count: 1,
					scores: [
						create(ScoreWeightRecordSchema, { score: "capacity", weight: 1 }),
					],
				}),
				snapshot: snapshot(views),
				scores: [future],
			}),
		);
		expect(
			result.ok ? result.value.candidates.find((c) => c.selected)?.campId : "",
		).toBe("a");
	});
});

describe("decidePlacement exclusions (D20, I19)", () => {
	it("a Camp declared in us-east-1 claiming eu-west-1 never satisfies an EU residency constraint, even with its taint tolerated", () => {
		const liar = view(topology("us-1", { regions: ["us-east-1"] }), {
			claims: [
				create(CampClaimRecordSchema, { name: "region", value: "eu-west-1" }),
			],
			taints: [
				create(TaintRecordSchema, {
					key: "hobo.cd/claims-inconsistent",
					value: "true",
					effect: TaintEffect.NO_PLACE,
				}),
			],
		});
		const honest = view(topology("eu-1"));
		const result = decidePlacement(
			input({
				placement: placement({
					tolerations: [
						create(TolerationRecordSchema, {
							key: "hobo.cd/claims-inconsistent",
						}),
					],
				}),
				snapshot: snapshot([liar, honest]),
				subject: { classifications: ["pii"], residency: [EU_ONLY] },
			}),
		);
		expect(result.ok).toBe(true);
		const candidate = result.ok
			? result.value.candidates.find((c) => c.campId === "us-1")
			: undefined;
		expect(candidate?.selected).toBe(false);
		expect(candidate?.exclusionCodes).toEqual([
			"residency-conflict:jurisdiction-not-allowed",
		]);
		const untolerated = decidePlacement(
			input({
				snapshot: snapshot([liar, honest]),
				subject: { classifications: [], residency: [EU_ONLY] },
			}),
		);
		expect(
			untolerated.ok
				? untolerated.value.candidates.find((c) => c.campId === "us-1")
						?.exclusionCodes
				: [],
		).toEqual([
			"taint-not-tolerated",
			"residency-conflict:jurisdiction-not-allowed",
		]);
	});

	it("a required claim excludes when missing and never grants residency", () => {
		const gpu = view(topology("us-gpu", { regions: ["us-east-1"] }), {
			claims: [
				create(CampClaimRecordSchema, { name: "accelerator", value: "gpu" }),
			],
		});
		const plain = view(topology("eu-1"));
		const result = decidePlacement(
			input({
				placement: placement({ requiredClaims: ["accelerator=gpu"] }),
				snapshot: snapshot([gpu, plain]),
				subject: { classifications: [], residency: [EU_ONLY] },
			}),
		);
		expect(result.ok).toBe(false);
		expect(codeOf(result, PLACEMENT_UNSATISFIABLE)?.subject).toBe("candidates");
		const open = decidePlacement(
			input({
				placement: placement({ requiredClaims: ["accelerator"] }),
				snapshot: snapshot([gpu, plain]),
			}),
		);
		expect(
			open.ok
				? open.value.candidates.map((c) => [c.campId, c.exclusionCodes])
				: [],
		).toEqual([
			["eu-1", ["claim-missing"]],
			["us-gpu", []],
		]);
	});

	it("an unbound set is invisible: its Camps never become candidates and the decision says why", () => {
		const result = decidePlacement(
			input({
				placement: placement({ campSets: ["fleet", "shadow"] }),
				snapshot: snapshot([view(topology("eu-1"))]),
				railDelivery: railDelivery({ campSets: ["fleet"] }),
			}),
		);
		expect(
			result.ok
				? result.value.reasons.find((r) => r.code === "set-not-bound")?.subject
				: "",
		).toBe("shadow");
		const none = decidePlacement(
			input({
				snapshot: snapshot([]),
				railDelivery: railDelivery({ campSets: [] }),
			}),
		);
		expect(codeOf(none, "set-not-bound")?.subject).toBe("fleet");
		expect(codeOf(none, PLACEMENT_UNSATISFIABLE)).toBeDefined();
	});

	it("spread provider min 3 with two providers is placement-unsatisfiable naming provider", () => {
		const views = [
			view(topology("a", { provider: "aws" })),
			view(topology("b", { provider: "gcp" })),
			view(topology("c", { provider: "aws" })),
		];
		const result = decidePlacement(
			input({
				placement: placement({
					spread: [
						create(SpreadConstraintRecordSchema, {
							topologyKey: "provider",
							minGroups: 3,
						}),
					],
				}),
				snapshot: snapshot(views),
			}),
		);
		expect(result.ok).toBe(false);
		const refusal = codeOf(result, PLACEMENT_UNSATISFIABLE);
		expect(refusal?.subject).toBe("provider");
		expect(refusal?.remediation).not.toBe("");
	});

	it("records observe-only, excluded, provider-not-approved and taint codes", () => {
		const views = [
			view(topology("watch"), { management: CampManagement.OBSERVE_ONLY }),
			view(topology("gone")),
			view(topology("odd", { provider: "hetzner" })),
			view(topology("noisy"), {
				taints: [
					create(TaintRecordSchema, {
						key: "maintenance",
						effect: TaintEffect.NO_RUN,
					}),
				],
			}),
			view(topology("ok")),
		];
		const result = decidePlacement(
			input({ snapshot: snapshot(views), exclude: ["gone"] }),
		);
		expect(
			result.ok
				? Object.fromEntries(
						result.value.candidates.map((c) => [c.campId, c.exclusionCodes]),
					)
				: {},
		).toEqual({
			gone: ["excluded"],
			noisy: ["taint-not-tolerated"],
			odd: ["provider-not-approved"],
			ok: [],
			watch: ["observe-only"],
		});
	});

	it("a timed toleration lapses after toleration_ms", () => {
		const tainted = view(topology("a"), {
			taints: [
				create(TaintRecordSchema, {
					key: "zone",
					effect: TaintEffect.NO_RUN,
					addedAt: new Date(T0 - 10 * MINUTE).toISOString(),
				}),
			],
		});
		const tolerate = (ms: bigint) =>
			placement({
				tolerations: [
					create(TolerationRecordSchema, {
						key: "zone",
						effect: TaintEffect.NO_RUN,
						tolerationMs: ms,
					}),
				],
			});
		expect(
			decidePlacement(
				input({
					placement: tolerate(15n * 60_000n),
					snapshot: snapshot([tainted]),
				}),
			).ok,
		).toBe(true);
		expect(
			decidePlacement(
				input({
					placement: tolerate(5n * 60_000n),
					snapshot: snapshot([tainted]),
				}),
			).ok,
		).toBe(false);
		expect(
			decidePlacement(
				input({ placement: tolerate(0n), snapshot: snapshot([tainted]) }),
			).ok,
		).toBe(true);
	});

	it("an unmapped declared region is a residency conflict (fail closed)", () => {
		const result = decidePlacement(
			input({
				snapshot: snapshot([
					view(topology("mars", { regions: ["olympus-1"] })),
				]),
				subject: { classifications: [], residency: [EU_ONLY] },
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("constraints that apply to other classifications do not exclude", () => {
		const phiOnly: ResidencyConstraint = {
			classifications: ["phi"],
			allowedJurisdictions: ["eu"],
		};
		const result = decidePlacement(
			input({
				snapshot: snapshot([
					view(topology("us-1", { regions: ["us-east-1"] })),
				]),
				subject: { classifications: ["pii"], residency: [phiOnly] },
			}),
		);
		expect(result.ok).toBe(true);
	});

	it("without the Rail's approvedProviders the decision records rail-providers-unknown", () => {
		const { approvedProviders: _omitted, ...rest } = input({
			snapshot: snapshot([view(topology("a"))]),
		});
		const result = decidePlacement(rest);
		expect(result.ok ? result.value.reasons.map((r) => r.code) : []).toContain(
			"rail-providers-unknown",
		);
	});
});

describe("decidePlacement selection and groups (D20)", () => {
	it("count with spread seeds distinct values first, then fills in score order", () => {
		const views = [
			view(topology("a1", { provider: "aws" })),
			view(topology("a2", { provider: "aws" })),
			view(topology("a3", { provider: "aws" })),
			view(topology("g1", { provider: "gcp" })),
		];
		const scores = [score("cap", { a1: 4, a2: 3, a3: 2, g1: 1 }, T0 + MINUTE)];
		const result = decidePlacement(
			input({
				placement: placement({
					count: 2,
					spread: [
						create(SpreadConstraintRecordSchema, {
							topologyKey: "provider",
							minGroups: 2,
						}),
					],
					scores: [
						create(ScoreWeightRecordSchema, { score: "cap", weight: 1 }),
					],
				}),
				snapshot: snapshot(views),
				scores,
			}),
		);
		expect(
			result.ok
				? result.value.candidates.filter((c) => c.selected).map((c) => c.campId)
				: [],
		).toEqual(["a1", "g1"]);
		expect(
			result.ok
				? result.value.candidates.find((c) => c.campId === "a2")?.exclusionCodes
				: [],
		).toEqual(["count-limit"]);
	});

	it("maxGroups caps distinct values and records spread-max-groups", () => {
		const views = [
			view(topology("a", { yardId: "y1" })),
			view(topology("b", { yardId: "y2" })),
			view(topology("c", { yardId: "y1" })),
		];
		const result = decidePlacement(
			input({
				placement: placement({
					spread: [
						create(SpreadConstraintRecordSchema, {
							topologyKey: "yard",
							maxGroups: 1,
						}),
					],
				}),
				snapshot: snapshot(views),
			}),
		);
		expect(
			result.ok
				? result.value.candidates.map((c) => [
						c.campId,
						c.selected,
						c.exclusionCodes,
					])
				: [],
		).toEqual([
			["a", true, []],
			["b", false, ["spread-max-groups:yard"]],
			["c", true, []],
		]);
	});

	it("count beyond the eligible Camps is placement-unsatisfiable naming count", () => {
		const result = decidePlacement(
			input({
				placement: placement({ count: 3 }),
				snapshot: snapshot([view(topology("a")), view(topology("b"))]),
			}),
		);
		expect(codeOf(result, PLACEMENT_UNSATISFIABLE)?.subject).toBe("count");
	});

	it("forms named groups by selector in declaration order, then chunks the rest by the default size", () => {
		const views = Array.from({ length: 7 }, (_, index) =>
			view(
				topology(`c${index}`, {
					labels: {
						ring: index === 5 ? "pilot" : index === 6 ? "canary" : "main",
					},
				}),
			),
		);
		const result = decidePlacement(
			input({
				placement: placement({
					groups: [
						create(PlacementGroupRecordSchema, {
							name: "pilot",
							selector: create(SelectorRecordSchema, {
								labels: { ring: "pilot" },
							}),
						}),
						create(PlacementGroupRecordSchema, {
							name: "nobody",
							selector: create(SelectorRecordSchema, {
								labels: { ring: "none" },
							}),
						}),
						create(PlacementGroupRecordSchema, {
							name: "first-two",
							maxSize: 2,
						}),
					],
					defaultGroupSize: 2,
				}),
				snapshot: snapshot(views),
			}),
		);
		expect(
			result.ok
				? result.value.groups.map((g) => [g.index, g.name, g.campIds])
				: [],
		).toEqual([
			[0, "pilot", ["c5"]],
			[1, "first-two", ["c0", "c1"]],
			[2, "default-1", ["c2", "c3"]],
			[3, "default-2", ["c4", "c6"]],
		]);
		expect(
			result.ok
				? result.value.reasons.find((r) => r.code === "group-empty")?.subject
				: "",
		).toBe("nobody");
	});

	it("the default group size is 10% of the decision, at least one", () => {
		const views = Array.from({ length: 25 }, (_, index) =>
			view(topology(`c${String(index).padStart(2, "0")}`)),
		);
		const result = decidePlacement(input({ snapshot: snapshot(views) }));
		expect(
			result.ok ? result.value.groups.map((g) => g.campIds.length) : [],
		).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 1]);
	});
});
