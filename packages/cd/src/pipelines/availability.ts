// Pure availability (D4, D21, I13, I16): which Freight a node may receive,
// through which sources, upstream nodes or approvals, and since when. The
// controller gathers the facts (qualifications, approvals, env.Promoted times,
// placement decisions); this module only decides.
import {
	Availability,
	type FreightApprovedRecord,
	type FreightQualifiedRecord,
	type FreightRecord,
	type PipelineNodeRecord,
	type PipelineRecord,
	type QuorumRecord,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import { effectiveAvailability, isPlaced, subjectOf } from "./graph.js";
import { ORIGIN_SOURCES } from "./reasons.js";

// public-contract: the `via` entry naming an approval (FreightAvailabilityRecord).
export const VIA_APPROVAL = "approval" as const;

/** The Camps of a placed node's latest decision, and those in mandatory groups. */
export type PlacedView = Readonly<{
	campIds: readonly string[];
	mandatoryCampIds: readonly string[];
}>;

export type FreightFacts = Readonly<{
	freight: FreightRecord;
	usable: boolean;
	qualifications: readonly FreightQualifiedRecord[];
	approvals: readonly FreightApprovedRecord[];
	/** Latest env.Promoted time of this Freight per Camp. */
	promotedAt: ReadonlyMap<string, number>;
}>;

export type NodeAvailability = Readonly<{
	via: readonly string[];
	availableAtMs: number;
	/** Available through sources or upstream qualification (not only approvals). */
	lineage: boolean;
	/** Camps of the node with an unexpired approval for this Freight. */
	approvedCampIds: readonly string[];
}>;

export type AvailabilityInput = Readonly<{
	pipeline: PipelineRecord;
	nodes: ReadonlyMap<string, PipelineNodeRecord>;
	node: PipelineNodeRecord;
	nowMs: number;
	facts: FreightFacts;
	/** Latest decision per placed node; absent means none recorded. */
	placed: ReadonlyMap<string, PlacedView>;
}>;

/**
 * Qualified Camps a quorum needs: the larger of `min_qualified` and
 * `min_qualified_percent` of the decision (default 95%, rounded up). Never
 * below one, so an empty decision qualifies nothing.
 */
export function quorumThreshold(quorum: QuorumRecord | undefined, total: number): number {
	const percent =
		quorum && (quorum.minQualified > 0 || quorum.minQualifiedPercent > 0)
			? quorum.minQualifiedPercent
			: CD_DEFAULTS.fanoutQuorumPercent;
	const byPercent = Math.ceil((percent * total) / 100);
	return Math.max(1, quorum?.minQualified ?? 0, byPercent);
}

function ms(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Each Camp of `upstream` whose qualification (plus soak) is complete, with the time it completed. */
function readyTimes(input: AvailabilityInput, upstream: PipelineNodeRecord, domain: readonly string[]): Map<string, number> {
	const soak = Number(input.node.requiredSoakMs);
	const inDomain = new Set(domain);
	const ready = new Map<string, number>();
	for (const q of input.facts.qualifications) {
		if (q.pipeline !== input.pipeline.name || q.node !== upstream.name || !inDomain.has(q.campId)) continue;
		const qualifiedAt = ms(q.qualifiedAt);
		if (qualifiedAt === undefined) continue;
		const promoted = input.facts.promotedAt.get(q.campId) ?? qualifiedAt;
		const at = Math.max(qualifiedAt, promoted + soak);
		if (at > input.nowMs) continue;
		const previous = ready.get(q.campId);
		ready.set(q.campId, previous === undefined ? at : Math.min(previous, at));
	}
	return ready;
}

/** When `upstream` admits the Freight under `strategy`, or undefined. */
function admitted(input: AvailabilityInput, upstream: PipelineNodeRecord, strategy: Availability): number | undefined {
	const view = isPlaced(upstream) ? input.placed.get(upstream.name) : { campIds: upstream.campIds, mandatoryCampIds: [] };
	if (!view || view.campIds.length === 0) return undefined;
	const ready = readyTimes(input, upstream, view.campIds);
	const times = [...ready.values()].sort((a, b) => a - b);
	if (isPlaced(upstream) || strategy === Availability.QUORUM) {
		const needed = quorumThreshold(upstream.quorum, view.campIds.length);
		if (times.length < needed) return undefined;
		let at = times[needed - 1] ?? input.nowMs;
		for (const campId of view.mandatoryCampIds) {
			const time = ready.get(campId);
			if (time === undefined) return undefined;
			at = Math.max(at, time);
		}
		return at;
	}
	if (strategy === Availability.ALL) {
		if (view.campIds.some((campId) => !ready.has(campId))) return undefined;
		return times[times.length - 1];
	}
	return times[0];
}

function nodeDomain(input: AvailabilityInput): readonly string[] {
	return isPlaced(input.node) ? (input.placed.get(input.node.name)?.campIds ?? []) : input.node.campIds;
}

/**
 * Is the Freight available to the node, and how? Undefined when it is not.
 * Lineage (I16): a source the node takes Freight from, or upstream
 * qualification per the node's strategy plus soak. An unexpired approval
 * makes it available to the approved Camps of the node only.
 */
export function freightAvailability(input: AvailabilityInput): NodeAvailability | undefined {
	const { freight } = input.facts;
	if (!input.facts.usable) return undefined;
	if (freight.manifest?.bindle !== input.pipeline.bindle) return undefined;
	if (subjectOf(freight.manifest.subject) !== subjectOf(input.pipeline.subject)) return undefined;

	const paths: { via: string; at: number }[] = [];
	const recordedAt = ms(freight.recordedAt) ?? input.nowMs;
	for (const source of input.node.fromSources) {
		const origin = ORIGIN_SOURCES.get(source);
		const matches = origin === undefined ? freight.sourceName === source : freight.origin === origin;
		if (matches && recordedAt <= input.nowMs) paths.push({ via: source, at: recordedAt });
	}

	if (input.node.fromNodes.length > 0) {
		const strategy = effectiveAvailability(input.node, input.nodes);
		const results = input.node.fromNodes.map((name) => {
			const upstream = input.nodes.get(name);
			return { name, at: upstream ? admitted(input, upstream, strategy) : undefined };
		});
		if (strategy === Availability.ONE_OF) {
			for (const result of results) if (result.at !== undefined) paths.push({ via: result.name, at: result.at });
		} else if (results.every((result) => result.at !== undefined)) {
			const at = Math.max(...results.map((result) => result.at ?? input.nowMs));
			for (const result of results) paths.push({ via: result.name, at });
		}
	}

	const domain = new Set(nodeDomain(input));
	const approvals = input.facts.approvals.filter((approval) => {
		const expires = ms(approval.expiresAt);
		return domain.has(approval.campId) && expires !== undefined && expires > input.nowMs;
	});
	const approvedCampIds = [...new Set(approvals.map((approval) => approval.campId))].sort();
	if (approvals.length > 0) {
		const at = Math.min(...approvals.map((approval) => ms(approval.approvedAt) ?? input.nowMs));
		paths.push({ via: VIA_APPROVAL, at });
	}

	if (paths.length === 0) return undefined;
	const lineage = paths.some((path) => path.via !== VIA_APPROVAL);
	const via = [...new Set(paths.map((path) => path.via))].sort();
	const relevant = lineage ? paths.filter((path) => path.via !== VIA_APPROVAL) : paths;
	return {
		via,
		availableAtMs: Math.min(...relevant.map((path) => path.at)),
		lineage,
		approvedCampIds,
	};
}
