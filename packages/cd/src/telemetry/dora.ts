// DORA four keys and reconcile lag (WP19, C13) as a materialized view over
// the event store. `computeDora` is the pure definition (hand-checkable); the
// projection only gathers its facts from the journal, incrementally from a
// position cursor, so a refresh reads only new events (the cursor is the
// view's snapshot; the in-memory facts are its read store).
//
// Definitions (per Camp, filtered by `campIds` when given; window is
// (now − windowMs, now]):
//   - Deployment: an `env.Promoted` for a Bindle (Rail promotions excluded).
//   - Deployment frequency: deployments in the window per day.
//   - Lead time: `env.Promoted` time − the Freight's `freight.Recorded` time.
//   - Change failure: a deployment followed, on the same Camp and before that
//     Camp's next deployment, by an `env.PromoteRolledBack`.
//   - Time to restore: that rollback's time − the failed deployment's time
//     (DORA's "failed deployment recovery time").
//   - p50 is the nearest-rank median: the ⌈n/2⌉-th smallest value. Empty
//     samples report 0 (no deployments, nothing to measure).
import {
	type DescMessage,
	fromJson,
	type MessageShape,
} from "@bufbuild/protobuf";
import type { DurableEventStore, EventPosition, JsonValue } from "@hobo/core";
import {
	FreightRecordSchema,
	FreightSubject,
	PromotionRecordSchema,
	ReconcileObservationRecordSchema,
	SetRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_EVENTS } from "../events.js";
import type { DoraMetrics } from "../ports.js";

// public-contract: milliseconds per day used by deployment frequency.
export const DAY_MS = 86_400_000 as const;

export type DoraDeployment = Readonly<{
	promotionId: string;
	campId: string;
	freightId: string;
	atMs: number;
}>;

export type DoraRollback = Readonly<{ campId: string; atMs: number }>;

export type DoraFacts = Readonly<{
	deployments: readonly DoraDeployment[];
	rollbacks: readonly DoraRollback[];
	/** Freight id → `freight.Recorded` time. */
	recordedAtMs: ReadonlyMap<string, number>;
}>;

export type DoraQuery = Readonly<{
	windowMs: number;
	nowMs: number;
	campIds?: readonly string[];
}>;

export function p50(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length / 2) - 1] ?? 0;
}

export function computeDora(facts: DoraFacts, query: DoraQuery): DoraMetrics {
	const windowMs = Math.max(0, query.windowMs);
	const from = query.nowMs - windowMs;
	const camps = query.campIds ? new Set(query.campIds) : undefined;
	const inCamp = (campId: string) => camps === undefined || camps.has(campId);
	const byCamp = new Map<string, DoraDeployment[]>();
	for (const d of facts.deployments) {
		if (!inCamp(d.campId) || d.atMs > query.nowMs) continue;
		const list = byCamp.get(d.campId) ?? [];
		list.push(d);
		byCamp.set(d.campId, list);
	}
	const rollbacks = new Map<string, number[]>();
	for (const r of facts.rollbacks) {
		if (!inCamp(r.campId) || r.atMs > query.nowMs) continue;
		const list = rollbacks.get(r.campId) ?? [];
		list.push(r.atMs);
		rollbacks.set(r.campId, list);
	}

	let deployments = 0;
	let failures = 0;
	const leadTimes: number[] = [];
	const restores: number[] = [];
	for (const [campId, list] of byCamp) {
		const ordered = list
			.map((d, index) => ({ d, index }))
			.sort((a, b) => a.d.atMs - b.d.atMs || a.index - b.index)
			.map((x) => x.d);
		const campRollbacks = (rollbacks.get(campId) ?? []).sort((a, b) => a - b);
		for (const [i, d] of ordered.entries()) {
			if (d.atMs <= from) continue;
			deployments += 1;
			const recorded = facts.recordedAtMs.get(d.freightId);
			if (recorded !== undefined)
				leadTimes.push(Math.max(0, d.atMs - recorded));
			const next = ordered[i + 1]?.atMs ?? Number.POSITIVE_INFINITY;
			const rollback = campRollbacks.find((at) => at >= d.atMs && at < next);
			if (rollback !== undefined) {
				failures += 1;
				restores.push(rollback - d.atMs);
			}
		}
	}
	return {
		windowMs,
		deploymentFrequencyPerDay:
			windowMs === 0 ? 0 : deployments / (windowMs / DAY_MS),
		leadTimeMsP50: p50(leadTimes),
		changeFailureRate: deployments === 0 ? 0 : failures / deployments,
		timeToRestoreMsP50: p50(restores),
	};
}

type CampMark = Readonly<{ setId: string; atMs: number }>;

/** Reconcile lag: how far a Camp's status trails its latest desired Set. */
export function computeReconcileLag(
	specs: readonly CampMark[],
	converged: readonly CampMark[],
	nowMs: number,
): number | undefined {
	let latest: CampMark | undefined;
	for (const s of specs) if (!latest || s.atMs >= latest.atMs) latest = s;
	if (!latest) return undefined;
	const target = latest;
	const done = converged.find(
		(c) =>
			c.atMs >= target.atMs && (c.setId === "" || c.setId === target.setId),
	);
	return Math.max(0, (done ? done.atMs : nowMs) - target.atMs);
}

function parse<D extends DescMessage>(
	schema: D,
	data: unknown,
): MessageShape<D> | undefined {
	try {
		// SAFETY: journal bodies are proto-JSON; fromJson parses or throws.
		return fromJson(schema, data as JsonValue, { ignoreUnknownFields: true });
	} catch {
		return undefined;
	}
}

function ms(text: string): number | undefined {
	if (text === "") return undefined;
	const value = Date.parse(text);
	return Number.isFinite(value) ? value : undefined;
}

export type DoraProjection = Readonly<{
	/** Catch up from the cursor; returns the number of events read. */
	refresh(): Promise<number>;
	facts(): DoraFacts;
	specs(campId: string): readonly CampMark[];
	converged(campId: string): readonly CampMark[];
	camps(): readonly string[];
	cursor(): EventPosition | undefined;
}>;

export function createDoraProjection(
	store: DurableEventStore,
	tenant: string,
): DoraProjection {
	let cursor: EventPosition | undefined;
	const deployments: DoraDeployment[] = [];
	const rollbacks: DoraRollback[] = [];
	const recordedAtMs = new Map<string, number>();
	const specs = new Map<string, CampMark[]>();
	const converged = new Map<string, CampMark[]>();
	const push = (
		map: Map<string, CampMark[]>,
		campId: string,
		mark: CampMark,
	) => {
		const list = map.get(campId) ?? [];
		list.push(mark);
		map.set(campId, list);
	};

	return {
		async refresh() {
			let read = 0;
			const options =
				cursor === undefined ? { tenant } : { tenant, after: cursor };
			for await (const { position, event } of store.readAll(options)) {
				cursor = position;
				read += 1;
				const atMs = ms(event.ts);
				if (atMs === undefined) continue;
				switch (event.type) {
					case CD_EVENTS.FreightRecorded: {
						const r = parse(FreightRecordSchema, event.data);
						if (r && r.freightId !== "" && !recordedAtMs.has(r.freightId))
							recordedAtMs.set(r.freightId, ms(r.recordedAt) ?? atMs);
						break;
					}
					case CD_EVENTS.EnvPromoted: {
						const r = parse(PromotionRecordSchema, event.data);
						if (!r || r.subject === FreightSubject.RAIL) break;
						for (const campId of r.targetCampIds)
							deployments.push({
								promotionId: r.promotionId,
								campId,
								freightId: r.freightId,
								atMs,
							});
						break;
					}
					case CD_EVENTS.EnvPromoteRolledBack: {
						const r = parse(PromotionRecordSchema, event.data);
						if (!r || r.subject === FreightSubject.RAIL) break;
						for (const campId of r.targetCampIds)
							rollbacks.push({ campId, atMs });
						break;
					}
					case CD_EVENTS.SetCreated: {
						const r = parse(SetRecordSchema, event.data);
						if (r && r.campId !== "")
							push(specs, r.campId, { setId: r.setId, atMs });
						break;
					}
					case CD_EVENTS.Converged: {
						const r = parse(ReconcileObservationRecordSchema, event.data);
						if (r && r.campId !== "")
							push(converged, r.campId, { setId: r.setId, atMs });
						break;
					}
					default:
						break;
				}
			}
			return read;
		},
		facts: () => ({ deployments, rollbacks, recordedAtMs }),
		specs: (campId) => specs.get(campId) ?? [],
		converged: (campId) => converged.get(campId) ?? [],
		camps: () => [...specs.keys()].sort(),
		cursor: () => cursor,
	};
}
