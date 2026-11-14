// Read-side views of the CD read API (WP12). Each view is a pure fold over
// the module ports' projections (no writes, no decisions); records leave as
// canonical protobuf JSON. View shapes are constrained in
// packages/control-api/data-models/control_api.{proto,cue} (`CdPipelineNodeView`,
// `CdTimelineEntry`, …) and pinned by the PACT in
// packages/control-api/contracts/pacts/control-api-cd.pact.json. Absent
// optional members are `undefined` and are omitted on the wire.
import type { DurableEventStore } from "@hobo/core";
import {
	type CampStatusRecord,
	CampStatusRecordSchema,
	ComplianceRecordSchema,
	ConditionStatus,
	FailoverRecordSchema,
	FanoutStatusRecordSchema,
	FreightApprovedRecordSchema,
	FreightAvailabilityRecordSchema,
	FreightQualifiedRecordSchema,
	type FreightRecord,
	FreightRecordSchema,
	type PipelineNodeRecord,
	PipelineRecordSchema,
	PlacementDecisionRecordSchema,
	PromotionRecordSchema,
	PromotionState,
	ReconcileObservationRecordSchema,
	SetRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../events.js";
import type {
	CampId,
	CampTopology,
	CampView,
	ContinuousDelivery,
	FreightId,
	Outcome,
} from "../ports.js";
import { serviceRefusal } from "./errors.js";
import type { CdReadRoute, ConditionFilter, TaintFilter } from "./routes.js";
import { PROMOTIONS_MAX_LIMIT } from "./routes.js";
import { recordJson, type WireValue } from "./wire.js";

/** The journal reads the read API needs (never appends). */
export type DurableStoreReader = Pick<DurableEventStore, "read" | "readAll">;

export type ViewDeps = Readonly<{
	cd: Pick<
		ContinuousDelivery,
		| "pipelines"
		| "freight"
		| "promotions"
		| "desired"
		| "inventory"
		| "placement"
		| "fanout"
		| "failover"
		| "posture"
	>;
	store: DurableStoreReader;
	topology:
		| Readonly<{ camp(campId: CampId): Promise<CampTopology | undefined> }>
		| undefined;
}>;

type Route<K extends CdReadRoute["kind"]> = Extract<CdReadRoute, { kind: K }>;

function asCampId(campId: string): CampId {
	// SAFETY: Camp ids here come from records the modules wrote (node camp_ids, decision groups).
	return campId as CampId;
}

async function currentOf(d: ViewDeps, campId: string): Promise<WireValue> {
	const set = await d.cd.desired.current(asCampId(campId));
	return { campId, freightId: set?.freightId, setId: set?.setId };
}

function placementCamps(
	decisionGroups: readonly Readonly<{ campIds: readonly string[] }>[],
): string[] {
	return [...new Set(decisionGroups.flatMap((g) => g.campIds))].sort();
}

async function nodeView(
	d: ViewDeps,
	pipeline: string,
	node: PipelineNodeRecord,
): Promise<WireValue> {
	const available = await d.cd.pipelines.available({
		pipeline,
		node: node.name,
	});
	const edges = {
		fromSources: [...node.fromSources],
		fromNodes: [...node.fromNodes],
	};
	const availableJson = available.map((a) =>
		recordJson(FreightAvailabilityRecordSchema, a),
	);
	if (node.placement === "") {
		return {
			name: node.name,
			edges,
			camps: await Promise.all(node.campIds.map((c) => currentOf(d, c))),
			available: availableJson,
		};
	}
	const q = await d.cd.fanout.qualified({ pipeline, node: node.name });
	const campIds = q.decision
		? placementCamps(q.decision.groups)
		: [...q.qualifiedCampIds].sort();
	return {
		name: node.name,
		edges,
		placement: node.placement,
		decisionId: q.decision?.decisionId,
		qualified: {
			campIds: [...q.qualifiedCampIds],
			freightId: q.stableFreightId,
		},
		camps: await Promise.all(campIds.map((c) => currentOf(d, c))),
		available: availableJson,
	};
}

export async function pipelineView(
	d: ViewDeps,
	r: Route<"pipeline">,
): Promise<Outcome<WireValue>> {
	const pipeline = await d.cd.pipelines.get(r.name);
	if (!pipeline)
		return serviceRefusal("not-found", `no pipeline named ${r.name}`, r.name);
	const nodes: WireValue[] = [];
	for (const node of pipeline.nodes)
		nodes.push(await nodeView(d, pipeline.name, node));
	return {
		ok: true,
		value: { pipeline: recordJson(PipelineRecordSchema, pipeline), nodes },
	};
}

const TIMELINE_ORDER = [
	"recorded",
	"promotion",
	"qualified",
	"approved",
	"yanked",
	"retired",
] as const;

type TimelineKind = (typeof TIMELINE_ORDER)[number];

type TimelineEntry = Readonly<{
	at: string;
	kind: TimelineKind;
	campId: string | undefined;
	detail: WireValue;
}>;

const JOURNAL_KINDS = new Map<string, TimelineKind>([
	[CD_EVENTS.FreightYanked, "yanked"],
	[CD_EVENTS.FreightRetired, "retired"],
]);

async function findFreight(
	d: ViewDeps,
	idOrAlias: string,
): Promise<FreightRecord | undefined> {
	// SAFETY: a lookup key only; an unknown id simply finds nothing.
	const byId = await d.cd.freight.get(idOrAlias as FreightId);
	return byId ?? (await d.cd.freight.getByAlias(idOrAlias));
}

export async function freightTimeline(
	d: ViewDeps,
	r: Route<"freight">,
): Promise<Outcome<WireValue>> {
	const freight = await findFreight(d, r.idOrAlias);
	if (!freight)
		return serviceRefusal(
			"not-found",
			`no Freight with id or alias ${r.idOrAlias}`,
			r.idOrAlias,
		);
	// SAFETY: the ledger returned this record, so its id is a recorded FreightId.
	const id = freight.freightId as FreightId;
	const entries: TimelineEntry[] = [
		{
			at: freight.recordedAt,
			kind: "recorded",
			campId: undefined,
			detail: { by: freight.recordedBy },
		},
	];
	for await (const event of d.store.read(CD_STREAMS.freight(id))) {
		const kind = JOURNAL_KINDS.get(event.type);
		if (kind)
			entries.push({
				at: event.ts,
				kind,
				campId: undefined,
				detail: { type: event.type, by: event.actor.id },
			});
	}
	for (const q of await d.cd.freight.qualifications(id)) {
		entries.push({
			at: q.qualifiedAt,
			kind: "qualified",
			campId: q.campId,
			detail: recordJson(FreightQualifiedRecordSchema, q),
		});
	}
	for (const a of await d.cd.freight.approvals(id)) {
		entries.push({
			at: a.approvedAt,
			kind: "approved",
			campId: a.campId,
			detail: recordJson(FreightApprovedRecordSchema, a),
		});
	}
	for (const p of await d.cd.promotions.list({ limit: PROMOTIONS_MAX_LIMIT })) {
		if (p.freightId !== id) continue;
		for (const campId of p.targetCampIds) {
			entries.push({
				at: p.requestedAt,
				kind: "promotion",
				campId,
				detail: {
					promotionId: p.promotionId,
					state: PromotionState[p.state] ?? "UNSPECIFIED",
					pipeline: p.pipeline,
					node: p.node,
				},
			});
		}
	}
	entries.sort(
		(a, b) =>
			a.at.localeCompare(b.at) ||
			TIMELINE_ORDER.indexOf(a.kind) - TIMELINE_ORDER.indexOf(b.kind) ||
			(a.campId ?? "").localeCompare(b.campId ?? ""),
	);
	const camps = [
		...new Set(entries.flatMap((e) => (e.campId ? [e.campId] : []))),
	].sort();
	return {
		ok: true,
		value: {
			freight: recordJson(FreightRecordSchema, freight),
			camps,
			timeline: entries,
		},
	};
}

export async function promotionsView(
	d: ViewDeps,
	r: Route<"promotions">,
): Promise<Outcome<WireValue>> {
	const rows = await d.cd.promotions.list(
		r.campId === undefined
			? { limit: r.limit }
			: { campId: r.campId, limit: r.limit },
	);
	return {
		ok: true,
		value: {
			promotions: rows
				.slice(0, r.limit)
				.map((p) => recordJson(PromotionRecordSchema, p)),
		},
	};
}

export async function campStatusView(
	d: ViewDeps,
	r: Route<"campStatus">,
): Promise<Outcome<WireValue>> {
	const [current, observation, inventory] = await Promise.all([
		d.cd.desired.current(r.campId),
		d.cd.desired.status(r.campId),
		d.cd.inventory.status(r.campId),
	]);
	if (!current && !observation && !inventory)
		return serviceRefusal(
			"not-found",
			`no Camp ${r.campId} in desired state or inventory`,
			r.campId,
		);
	return {
		ok: true,
		value: {
			campId: r.campId,
			current: current && recordJson(SetRecordSchema, current),
			observation:
				observation &&
				recordJson(ReconcileObservationRecordSchema, observation),
			inventory: inventory && recordJson(CampStatusRecordSchema, inventory),
		},
	};
}

function matchesCondition(
	status: CampStatusRecord,
	f: ConditionFilter,
): boolean {
	const c = status.conditions.find((x) => x.type === f.type);
	if (!c) return f.status === ConditionStatus.UNKNOWN;
	return c.status === f.status;
}

function matchesTaint(status: CampStatusRecord, f: TaintFilter): boolean {
	return status.taints.some((t) =>
		"effect" in f ? t.effect === f.effect : t.key === f.key,
	);
}

function campJson(view: CampView): WireValue {
	return {
		topology: view.topology,
		status: recordJson(CampStatusRecordSchema, view.status),
	};
}

export async function campsView(
	d: ViewDeps,
	r: Route<"camps">,
): Promise<Outcome<WireValue>> {
	const views = await d.cd.inventory.list(
		r.set === undefined ? undefined : { campSets: [r.set] },
	);
	const { taint, condition } = r;
	const filtered = views
		.filter((v) => taint === undefined || matchesTaint(v.status, taint))
		.filter(
			(v) => condition === undefined || matchesCondition(v.status, condition),
		)
		.sort((a, b) => a.topology.campId.localeCompare(b.topology.campId));
	return { ok: true, value: { camps: filtered.map(campJson) } };
}

export async function campInventoryView(
	d: ViewDeps,
	r: Route<"campInventory">,
): Promise<Outcome<WireValue>> {
	const [status, topology] = await Promise.all([
		d.cd.inventory.status(r.campId),
		d.topology?.camp(r.campId),
	]);
	if (!status && !topology)
		return serviceRefusal(
			"not-found",
			`no Camp ${r.campId} in the inventory`,
			r.campId,
		);
	return {
		ok: true,
		value: {
			campId: r.campId,
			topology,
			status: status && recordJson(CampStatusRecordSchema, status),
		},
	};
}

export async function placementDecisionView(
	d: ViewDeps,
	r: Route<"placementDecision">,
): Promise<Outcome<WireValue>> {
	const decision = await d.cd.placement.decision(r.decisionId);
	if (!decision || decision.placement !== r.placement) {
		return serviceRefusal(
			"not-found",
			`no decision ${r.decisionId} for placement ${r.placement}`,
			r.decisionId,
		);
	}
	return {
		ok: true,
		value: { decision: recordJson(PlacementDecisionRecordSchema, decision) },
	};
}

export async function fanoutView(
	d: ViewDeps,
	r: Route<"fanout">,
): Promise<Outcome<WireValue>> {
	const fanout = await d.cd.fanout.get(r.fanoutId);
	if (!fanout)
		return serviceRefusal("not-found", `no fan-out ${r.fanoutId}`, r.fanoutId);
	return {
		ok: true,
		value: { fanout: recordJson(FanoutStatusRecordSchema, fanout) },
	};
}

export async function failoversView(
	d: ViewDeps,
	r: Route<"failovers">,
): Promise<Outcome<WireValue>> {
	const rows = await d.cd.failover.list(
		r.state === undefined ? undefined : { state: r.state },
	);
	const sorted = [...rows].sort(
		(a, b) =>
			b.updatedAt.localeCompare(a.updatedAt) ||
			a.failoverId.localeCompare(b.failoverId),
	);
	return {
		ok: true,
		value: {
			failovers: sorted.map((f) => recordJson(FailoverRecordSchema, f)),
		},
	};
}

export async function complianceView(
	d: ViewDeps,
	r: Route<"compliance">,
): Promise<Outcome<WireValue>> {
	const campIds =
		r.campId !== undefined
			? [r.campId]
			: (await d.cd.inventory.list()).map((v) => v.topology.campId).sort();
	const out: WireValue[] = [];
	for (const campId of campIds) {
		for (const record of await d.cd.posture.compliance(campId)) {
			if (r.railDigest !== undefined && record.railDigest !== r.railDigest)
				continue;
			out.push(recordJson(ComplianceRecordSchema, record));
		}
	}
	return { ok: true, value: { compliance: out } };
}
