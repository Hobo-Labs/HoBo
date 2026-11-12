// `decide` (D20) as a pure function over recorded inputs: the Placement, the
// inventory snapshot of its bound Camp sets, score snapshots, the subject's
// residency, the Rail's delivery object and `atMs`. No clock, network or
// randomness, and no dependence on input order (I18). Observed claims only
// ever exclude (I19); residency reads declared Yard regions only.
import { create, toJson } from "@bufbuild/protobuf";
import { evaluateResidency, type ResidencyConstraint } from "@hobo/core";
import {
	CampManagement,
	type PlacementCandidateRecord,
	PlacementCandidateRecordSchema,
	type PlacementDecisionRecord,
	PlacementDecisionRecordSchema,
	type PlacementGroupDecisionRecord,
	PlacementGroupDecisionRecordSchema,
	type PlacementRecord,
	PlacementRecordSchema,
	type RailDeliveryRecord,
	type ReasonRecord,
	type ScoreSnapshotRecord,
	type SpreadConstraintRecord,
	TaintEffect,
	type TaintRecord,
	type TolerationRecord,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, PLACEMENT_UNSATISFIABLE } from "../events.js";
import { campJurisdictions, matchesSelector } from "../inventory/selector.js";
import {
	iso,
	parseTime,
	reason,
	refuse,
	sha256Digest,
} from "../inventory/support.js";
import type {
	CampTopology,
	CampView,
	InventorySnapshot,
	Outcome,
	PlacementSubject,
} from "../ports.js";
import { parseRequiredClaim } from "./parse.js";

/** Exclusion codes recorded on candidates (every exclusion has one). */
export const EXCLUSION = Object.freeze({
	taintNotTolerated: "taint-not-tolerated",
	claimMissing: "claim-missing",
	residencyConflict: (code: string) => `residency-conflict:${code}`,
	providerNotApproved: "provider-not-approved",
	setNotBound: "set-not-bound",
	observeOnly: "observe-only",
	excluded: "excluded",
	countLimit: "count-limit",
	spreadMaxGroups: (key: string) => `spread-max-groups:${key}`,
});

export type DecideInput = Readonly<{
	placement: PlacementRecord;
	/** Snapshot of the Placement's Camp sets that the Rail binds; nothing else is visible. */
	snapshot: InventorySnapshot;
	scores: readonly ScoreSnapshotRecord[];
	subject: PlacementSubject;
	railDelivery: RailDeliveryRecord | undefined;
	/**
	 * The Rail's `approvedProviders`. Stations Rails always carry one (default
	 * `["local"]`), so undefined means the evidence is absent and the decision
	 * is refused with `rail-providers-unknown` (fail closed, I5).
	 */
	approvedProviders?: readonly string[] | undefined;
	/** Every defined Camp set name; a visible set outside it records `set-unknown`. */
	knownSets?: readonly string[] | undefined;
	exclude?: readonly string[] | undefined;
	count?: number | undefined;
	pipeline: string;
	node: string;
	atMs: number;
}>;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function spreadValue(
	key: string,
	topology: CampTopology,
): string | undefined {
	switch (key) {
		case "yard":
			return topology.yardId || undefined;
		case "provider":
			return topology.provider || undefined;
		case "region":
			return topology.regions.length === 0
				? undefined
				: [...topology.regions].sort().join("+");
		case "jurisdiction": {
			const jurisdictions = campJurisdictions(topology);
			return jurisdictions.length === 0 ? undefined : jurisdictions.join("+");
		}
		default:
			return key.startsWith("label:")
				? topology.labels[key.slice("label:".length)]
				: undefined;
	}
}

function tolerated(
	taint: TaintRecord,
	tolerations: readonly TolerationRecord[],
	atMs: number,
): boolean {
	return tolerations.some((toleration) => {
		if (toleration.key !== taint.key) return false;
		if (toleration.value !== "" && toleration.value !== taint.value)
			return false;
		if (
			toleration.effect !== TaintEffect.UNSPECIFIED &&
			toleration.effect !== taint.effect
		)
			return false;
		if (toleration.tolerationMs === 0n) return true;
		const added = parseTime(taint.addedAt);
		return (
			added !== undefined && added + Number(toleration.tolerationMs) > atMs
		);
	});
}

function applicable(
	constraint: ResidencyConstraint,
	subject: PlacementSubject,
): boolean {
	return (
		constraint.classifications.length === 0 ||
		constraint.classifications.some((entry) =>
			subject.classifications.includes(entry),
		)
	);
}

/** First residency failure code over every declared region, or undefined. */
function residencyFailure(
	topology: CampTopology,
	subject: PlacementSubject,
): string | undefined {
	const constraints = subject.residency.filter((constraint) =>
		applicable(constraint, subject),
	);
	if (constraints.length === 0) return undefined;
	if (topology.regions.length === 0) return "region-unmapped";
	for (const constraint of constraints) {
		for (const region of [...topology.regions].sort()) {
			const result = evaluateResidency({ constraint, region });
			if (!result.ok) return result.code;
		}
	}
	return undefined;
}

function exclusions(
	view: CampView,
	input: DecideInput,
	excluded: ReadonlySet<string>,
): string[] {
	const { placement, atMs } = input;
	const codes: string[] = [];
	const management =
		view.status.management === CampManagement.UNSPECIFIED
			? view.topology.management
			: view.status.management;
	if (management !== CampManagement.MANAGED) codes.push(EXCLUSION.observeOnly);
	if (excluded.has(view.topology.campId)) codes.push(EXCLUSION.excluded);
	if (
		view.status.taints.some(
			(taint) => !tolerated(taint, placement.tolerations, atMs),
		)
	)
		codes.push(EXCLUSION.taintNotTolerated);
	for (const entry of placement.requiredClaims) {
		const wanted = parseRequiredClaim(entry);
		const present = view.status.claims.some(
			(claim) =>
				wanted !== undefined &&
				claim.name === wanted.name &&
				(wanted.value === undefined || claim.value === wanted.value),
		);
		if (!present) {
			codes.push(EXCLUSION.claimMissing);
			break;
		}
	}
	if (
		input.approvedProviders === undefined ||
		!input.approvedProviders.includes(view.topology.provider)
	) {
		codes.push(EXCLUSION.providerNotApproved);
	}
	const residency = residencyFailure(view.topology, input.subject);
	if (residency !== undefined)
		codes.push(EXCLUSION.residencyConflict(residency));
	return codes;
}

/** Latest unexpired snapshot per weighted score (ties by digest); expired ones are ignored, never extrapolated. */
function liveScores(
	placement: PlacementRecord,
	scores: readonly ScoreSnapshotRecord[],
	atMs: number,
): ScoreSnapshotRecord[] {
	const out: ScoreSnapshotRecord[] = [];
	for (const name of placement.scores
		.map((weight) => weight.score)
		.sort(byText)) {
		let best: ScoreSnapshotRecord | undefined;
		let bestAt = Number.NEGATIVE_INFINITY;
		for (const snapshot of scores) {
			if (snapshot.score !== name) continue;
			const until = parseTime(snapshot.validUntil);
			const at = parseTime(snapshot.reportedAt);
			if (until === undefined || at === undefined || until <= atMs || at > atMs)
				continue;
			if (
				at > bestAt ||
				(at === bestAt && best !== undefined && snapshot.digest > best.digest)
			) {
				best = snapshot;
				bestAt = at;
			}
		}
		if (best !== undefined) out.push(best);
	}
	return out;
}

function unsatisfiable(
	subject: string,
	message: string,
	remediation: string,
): ReasonRecord {
	return reason(PLACEMENT_UNSATISFIABLE, message, remediation, subject);
}

type Ranked = Readonly<{ view: CampView; score: number; codes: string[] }>;

function select(
	eligible: readonly Ranked[],
	spreads: readonly SpreadConstraintRecord[],
	target: number,
): Outcome<{ selected: Set<string>; blocked: Map<string, string> }> {
	const selected = new Set<string>();
	const groups = new Map<string, Set<string>>(
		spreads.map((spread) => [spread.topologyKey, new Set<string>()]),
	);
	const blockingKey = (entry: Ranked): string | undefined => {
		for (const spread of spreads) {
			if (spread.maxGroups === 0) continue;
			const value = spreadValue(spread.topologyKey, entry.view.topology);
			const seen = groups.get(spread.topologyKey);
			if (
				value !== undefined &&
				seen !== undefined &&
				!seen.has(value) &&
				seen.size >= spread.maxGroups
			)
				return spread.topologyKey;
		}
		return undefined;
	};
	const add = (entry: Ranked) => {
		selected.add(entry.view.topology.campId);
		for (const spread of spreads) {
			const value = spreadValue(spread.topologyKey, entry.view.topology);
			if (value !== undefined) groups.get(spread.topologyKey)?.add(value);
		}
	};
	for (const spread of spreads) {
		const key = spread.topologyKey;
		const available = new Set(
			eligible
				.map((entry) => spreadValue(key, entry.view.topology))
				.filter((value) => value !== undefined),
		);
		if (available.size < spread.minGroups) {
			return refuse(
				unsatisfiable(
					key,
					`spread ${key} needs at least ${spread.minGroups} distinct values; eligible Camps cover ${available.size}`,
					`add eligible Camps in more distinct ${key} values to the bound Camp sets, or lower minGroups`,
				),
			);
		}
		const seen = groups.get(key) ?? new Set<string>();
		while (seen.size < spread.minGroups) {
			const next = eligible.find((entry) => {
				if (selected.has(entry.view.topology.campId)) return false;
				const value = spreadValue(key, entry.view.topology);
				return (
					value !== undefined &&
					!seen.has(value) &&
					blockingKey(entry) === undefined
				);
			});
			if (next === undefined || selected.size + 1 > target) {
				return refuse(
					unsatisfiable(
						key,
						`spread ${key} cannot reach ${spread.minGroups} distinct values within count ${target} and the other spread limits`,
						`raise count, relax the other spread constraints, or lower minGroups for ${key}`,
					),
				);
			}
			add(next);
		}
	}
	const blocked = new Map<string, string>();
	for (const entry of eligible) {
		const id = entry.view.topology.campId;
		if (selected.has(id)) continue;
		if (selected.size >= target) {
			blocked.set(id, EXCLUSION.countLimit);
			continue;
		}
		const key = blockingKey(entry);
		if (key !== undefined) blocked.set(id, EXCLUSION.spreadMaxGroups(key));
		else add(entry);
	}
	return { ok: true, value: { selected, blocked } };
}

/** Groups of a decision plus the reasons recorded while forming them. */
type GroupedDecision = Readonly<{
	groups: PlacementGroupDecisionRecord[];
	reasons: ReasonRecord[];
}>;

function groupsOf(
	placement: PlacementRecord,
	selected: readonly CampView[],
): GroupedDecision {
	const total = selected.length;
	const remaining = [...selected];
	const groups: PlacementGroupDecisionRecord[] = [];
	const reasons: ReasonRecord[] = [];
	for (const group of placement.groups) {
		const percentCap =
			group.maxSizePercent > 0
				? Math.max(1, Math.ceil((group.maxSizePercent * total) / 100))
				: Number.POSITIVE_INFINITY;
		const cap = Math.min(
			group.maxSize > 0 ? group.maxSize : Number.POSITIVE_INFINITY,
			percentCap,
		);
		const members: string[] = [];
		for (let index = 0; index < remaining.length && members.length < cap; ) {
			const view = remaining[index];
			if (
				view !== undefined &&
				matchesSelector(group.selector, view.topology)
			) {
				members.push(view.topology.campId);
				remaining.splice(index, 1);
			} else index += 1;
		}
		if (members.length === 0) {
			reasons.push(
				reason(
					"group-empty",
					`group "${group.name}" matched no selected Camp`,
					"check the group selector against the bound Camp sets; a mandatory empty group must not pass silently",
					group.name,
				),
			);
			continue;
		}
		groups.push(
			create(PlacementGroupDecisionRecordSchema, {
				name: group.name,
				index: groups.length,
				campIds: members,
			}),
		);
	}
	const percent =
		placement.defaultGroupSizePercent || CD_DEFAULTS.fanoutGroupSizePercent;
	const size =
		placement.defaultGroupSize > 0
			? placement.defaultGroupSize
			: Math.max(1, Math.ceil((percent * total) / 100));
	for (
		let start = 0, chunk = 1;
		start < remaining.length;
		start += size, chunk += 1
	) {
		groups.push(
			create(PlacementGroupDecisionRecordSchema, {
				name: `default-${chunk}`,
				index: groups.length,
				campIds: remaining
					.slice(start, start + size)
					.map((view) => view.topology.campId),
			}),
		);
	}
	return { groups, reasons };
}

/**
 * Deterministic decision id over every recorded input. `atMs` is an input on
 * purpose: score expiry and taint toleration windows depend on it, so a retry
 * at the same instant is one event (I12) while a retry at a later clock
 * reading is a new decision over possibly different evidence.
 */
export function decisionIdOf(
	input: DecideInput,
	scoreDigests: readonly string[],
): string {
	const digest = sha256Digest({
		placement: toJson(PlacementRecordSchema, input.placement),
		inventoryDigest: input.snapshot.digest,
		scoreDigests: [...scoreDigests],
		pipeline: input.pipeline,
		node: input.node,
		railDigest: input.railDelivery?.railDigest ?? "",
		boundSets: [...(input.railDelivery?.campSets ?? [])].sort(),
		approvedProviders:
			input.approvedProviders === undefined
				? null
				: [...input.approvedProviders].sort(),
		subject: {
			classifications: [...input.subject.classifications].sort(),
			residency: input.subject.residency.map((constraint) => ({
				classifications: [...constraint.classifications].sort(),
				allowed: [...constraint.allowedJurisdictions].sort(),
				denied: [...(constraint.deniedJurisdictions ?? [])].sort(),
			})),
		},
		exclude: [...new Set(input.exclude ?? [])].sort(),
		count: input.count ?? null,
		atMs: input.atMs,
	});
	return `pd-${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

export function decidePlacement(
	input: DecideInput,
): Outcome<PlacementDecisionRecord> {
	const { placement, atMs } = input;
	const reasons: ReasonRecord[] = [];
	const bound = new Set(input.railDelivery?.campSets ?? []);
	for (const set of [...placement.campSets].sort(byText)) {
		if (!bound.has(set)) {
			reasons.push(
				reason(
					EXCLUSION.setNotBound,
					`Camp set "${set}" is not bound by the Station's Rail and is invisible`,
					"bind the set in the Rail's delivery.camp_sets and promote that Rail",
					set,
				),
			);
		}
	}
	if (input.approvedProviders === undefined) {
		return refuse(
			reason(
				"rail-providers-unknown",
				"the Rail's approvedProviders were not supplied; provider approval cannot be evaluated, so placement fails closed",
				"wire approvedProviders into createPlacementEngine in the composition",
				"approvedProviders",
			),
		);
	}
	if (input.knownSets !== undefined) {
		const known = new Set(input.knownSets);
		for (const set of [...placement.campSets].sort(byText)) {
			if (bound.has(set) && !known.has(set)) {
				reasons.push(
					reason(
						"set-unknown",
						`Camp set "${set}" is bound by the Rail but has no definition and contributes no Camps`,
						"define the set with inventory.defineSet or remove it from the Placement",
						set,
					),
				);
			}
		}
	}
	const unique = new Map<string, CampView>();
	for (const view of input.snapshot.camps) {
		const id = view.topology.campId;
		if (unique.has(id)) {
			return refuse(
				reason(
					"inventory-invalid",
					`the inventory snapshot lists Camp "${id}" more than once`,
					"rebuild the inventory snapshot; Camp ids must be unique",
					id,
				),
			);
		}
		unique.set(id, view);
	}
	const views = [...unique.values()]
		.filter((view) => matchesSelector(placement.predicate, view.topology))
		.sort((a, b) => byText(a.topology.campId, b.topology.campId));
	const live = liveScores(placement, input.scores, atMs);
	const weights = [...placement.scores].sort((a, b) =>
		byText(a.score, b.score),
	);
	const excluded = new Set(input.exclude ?? []);
	const ranked: Ranked[] = views
		.map((view) => {
			let score = 0;
			for (const weight of weights) {
				const snapshot = live.find((entry) => entry.score === weight.score);
				score += weight.weight * (snapshot?.byCamp[view.topology.campId] ?? 0);
			}
			return { view, score, codes: exclusions(view, input, excluded) };
		})
		.sort(
			(a, b) =>
				b.score - a.score ||
				byText(a.view.topology.campId, b.view.topology.campId),
		);
	const eligible = ranked.filter((entry) => entry.codes.length === 0);
	const count = input.count ?? placement.count;
	if (eligible.length === 0) {
		return refuse(
			...reasons,
			unsatisfiable(
				"candidates",
				"no eligible Camp: every candidate is excluded or no bound set has members",
				"inspect the candidates' exclusion codes and the Rail's bound Camp sets",
			),
		);
	}
	if (count > 0 && eligible.length < count) {
		return refuse(
			...reasons,
			unsatisfiable(
				"count",
				`count ${count} exceeds the ${eligible.length} eligible Camps`,
				"lower count, tolerate the blocking taints, or add eligible Camps",
			),
		);
	}
	const target = count > 0 ? count : eligible.length;
	const chosen = select(eligible, placement.spread, target);
	if (!chosen.ok) return refuse(...reasons, ...chosen.reasons);
	const { selected, blocked } = chosen.value;
	if (count > 0 && selected.size < count) {
		const key =
			[...blocked.values()]
				.find((code) => code.startsWith("spread-max-groups:"))
				?.slice("spread-max-groups:".length) ?? "count";
		return refuse(
			...reasons,
			unsatisfiable(
				key,
				`only ${selected.size} of ${count} Camps fit within the ${key} spread limits`,
				`raise maxGroups for ${key} or lower count`,
			),
		);
	}
	const candidates: PlacementCandidateRecord[] = ranked.map((entry) => {
		const id = entry.view.topology.campId;
		const extra = blocked.get(id);
		return create(PlacementCandidateRecordSchema, {
			campId: id,
			selected: selected.has(id),
			exclusionCodes:
				extra === undefined ? entry.codes : [...entry.codes, extra],
			score: entry.score,
		});
	});
	const selectedViews = ranked
		.filter((entry) => selected.has(entry.view.topology.campId))
		.map((entry) => entry.view);
	const grouped = groupsOf(placement, selectedViews);
	const scoreDigests = live.map((snapshot) => snapshot.digest).sort(byText);
	return {
		ok: true,
		value: create(PlacementDecisionRecordSchema, {
			decisionId: decisionIdOf(input, scoreDigests),
			placement: placement.name,
			pipeline: input.pipeline,
			node: input.node,
			inventoryDigest: input.snapshot.digest,
			scoreSnapshotDigests: scoreDigests,
			groups: grouped.groups,
			candidates,
			reasons: [...reasons, ...grouped.reasons],
			decidedAt: iso(atMs),
		}),
	};
}
