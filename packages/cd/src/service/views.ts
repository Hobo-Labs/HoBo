// Read-side views of the CD read API (WP12). Each view is a pure fold over
// the module ports' projections (no writes, no decisions); records leave as
// canonical protobuf JSON. View shapes are constrained in
// packages/control-api/data-models/control_api.{proto,cue} (`CdPipelineView`,
// `CdFreightTimeline`, …) and pinned by the PACT in
// packages/control-api/contracts/pacts/control-api-cd.pact.json.
import type { DurableEventStore, JsonValue } from "@hobo/core";
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
import type { CampId, CampTopology, CampView, ContinuousDelivery, FreightId, Outcome } from "../ports.js";
import { serviceRefusal } from "./errors.js";
import type { CdReadRoute, ConditionFilter, TaintFilter } from "./routes.js";
import { PROMOTIONS_MAX_LIMIT } from "./routes.js";
import { recordJson } from "./wire.js";

/** The journal reads the read API needs (never appends). */
export type DurableStoreReader = Pick<DurableEventStore, "read" | "readAll">;

export type ViewDeps = Readonly<{
	cd: Pick<
		ContinuousDelivery,
		"pipelines" | "freight" | "promotions" | "desired" | "inventory" | "placement" | "fanout" | "failover" | "posture"
	>;
	store: DurableStoreReader;
	topology?: Readonly<{ camp(campId: CampId): Promise<CampTopology | undefined> }>;
}>;

type Route<K extends CdReadRoute["kind"]> = Extract<CdReadRoute, { kind: K }>;

async function currentOf(d: ViewDeps, campId: string) {
	const set = await d.cd.desired.current(campId as CampId);
	return set ? { campId, freightId: set.freightId, setId: set.setId } : { campId };
}

function placementCamps(decisionGroups: readonly Readonly<{ campIds: readonly string[] }>[]): string[] {
	return [...new Set(decisionGroups.flatMap((g) => g.campIds))].sort();
}

async function nodeView(d: ViewDeps, pipeline: string, node: PipelineNodeRecord) {
	const available = await d.cd.pipelines.available({ pipeline, node: node.name });
	const base = {
		name: node.name,
		edges: { fromSources: [...node.fromSources], fromNodes: [...node.fromNodes] },
		available: available.map((a) => recordJson(FreightAvailabilityRecordSchema, a)),
	};
	if (node.placement !== "") {
		const q = await d.cd.fanout.qualified({ pipeline, node: node.name });
		const campIds = q.decision ? placementCamps(q.decision.groups) : [...q.qualifiedCampIds].sort();
		return {
			...base,
			placement: node.placement,
			...(q.decision ? { decisionId: q.decision.decisionId } : {}),
			qualified: { campIds: [...q.qualifiedCampIds], ...(q.stableFreightId ? { freightId: q.stableFreightId } : {}) },
			camps: await Promise.all(campIds.map((c) => currentOf(d, c))),
		};
	}
	return { ...base, camps: await Promise.all([...node.campIds].map((c) => currentOf(d, c))) };
}

export async function pipelineView(d: ViewDeps, r: Route<"pipeline">): Promise<Outcome<JsonValue>> {
	const pipeline = await d.cd.pipelines.get(r.name);
	if (!pipeline) return serviceRefusal("not-found", `no pipeline named ${r.name}`, r.name);
	const nodes = [];
	for (const node of pipeline.nodes) nodes.push(await nodeView(d, pipeline.name, node));
	return { ok: true, value: { pipeline: recordJson(PipelineRecordSchema, pipeline), nodes } as JsonValue };
}

type TimelineEntry = { at: string; kind: string; campId?: string; detail: JsonValue };

const JOURNAL_KINDS: Readonly<Record<string, string>> = {
	[CD_EVENTS.FreightYanked]: "yanked",
	[CD_EVENTS.FreightRetired]: "retired",
};

export async function freightTimeline(d: ViewDeps, r: Route<"freight">): Promise<Outcome<JsonValue>> {
	const freight: FreightRecord | undefined =
		(await d.cd.freight.get(r.idOrAlias as string as FreightId)) ?? (await d.cd.freight.getByAlias(r.idOrAlias));
	if (!freight) return serviceRefusal("not-found", `no Freight with id or alias ${r.idOrAlias}`, r.idOrAlias);
	const id = freight.freightId as FreightId;
	const entries: TimelineEntry[] = [{ at: freight.recordedAt, kind: "recorded", detail: { by: freight.recordedBy } }];
	for await (const event of d.store.read(CD_STREAMS.freight(id))) {
		const kind = JOURNAL_KINDS[event.type];
		if (kind) entries.push({ at: event.ts, kind, detail: { type: event.type, by: event.actor.id } });
	}
	for (const q of await d.cd.freight.qualifications(id)) {
		entries.push({ at: q.qualifiedAt, kind: "qualified", campId: q.campId, detail: recordJson(FreightQualifiedRecordSchema, q) });
	}
	for (const a of await d.cd.freight.approvals(id)) {
		entries.push({ at: a.approvedAt, kind: "approved", campId: a.campId, detail: recordJson(FreightApprovedRecordSchema, a) });
	}
	for (const p of await d.cd.promotions.list({ limit: PROMOTIONS_MAX_LIMIT })) {
		if (p.freightId !== id) continue;
		for (const campId of p.targetCampIds) {
			entries.push({
				at: p.requestedAt,
				kind: "promotion",
				campId,
				detail: { promotionId: p.promotionId, state: PromotionState[p.state] ?? "UNSPECIFIED", pipeline: p.pipeline, node: p.node },
			});
		}
	}
	const order = ["recorded", "promotion", "qualified", "approved", "yanked", "retired"];
	entries.sort((a, b) => a.at.localeCompare(b.at) || order.indexOf(a.kind) - order.indexOf(b.kind) || (a.campId ?? "").localeCompare(b.campId ?? ""));
	const camps = [...new Set(entries.flatMap((e) => (e.campId ? [e.campId] : [])))].sort();
	return { ok: true, value: { freight: recordJson(FreightRecordSchema, freight), camps, timeline: entries } as JsonValue };
}

export async function promotionsView(d: ViewDeps, r: Route<"promotions">): Promise<Outcome<JsonValue>> {
	const rows = await d.cd.promotions.list({ limit: r.limit, ...(r.campId === undefined ? {} : { campId: r.campId }) });
	return { ok: true, value: { promotions: rows.slice(0, r.limit).map((p) => recordJson(PromotionRecordSchema, p)) } };
}

export async function campStatusView(d: ViewDeps, r: Route<"campStatus">): Promise<Outcome<JsonValue>> {
	const [current, observation, inventory] = await Promise.all([
		d.cd.desired.current(r.campId),
		d.cd.desired.status(r.campId),
		d.cd.inventory.status(r.campId),
	]);
	if (!current && !observation && !inventory) return serviceRefusal("not-found", `no Camp ${r.campId} in desired state or inventory`, r.campId);
	return {
		ok: true,
		value: {
			campId: r.campId,
			...(current ? { current: recordJson(SetRecordSchema, current) } : {}),
			...(observation ? { observation: recordJson(ReconcileObservationRecordSchema, observation) } : {}),
			...(inventory ? { inventory: recordJson(CampStatusRecordSchema, inventory) } : {}),
		},
	};
}

function matchesCondition(status: CampStatusRecord, f: ConditionFilter): boolean {
	const c = status.conditions.find((x) => x.type === f.type);
	if (!c) return f.status === ConditionStatus.UNKNOWN;
	return c.status === f.status;
}

function matchesTaint(status: CampStatusRecord, f: TaintFilter): boolean {
	return status.taints.some((t) => ("effect" in f ? t.effect === f.effect : t.key === f.key));
}

function campJson(view: CampView): JsonValue {
	return { topology: { ...view.topology, regions: [...view.topology.regions] } as JsonValue, status: recordJson(CampStatusRecordSchema, view.status) };
}

export async function campsView(d: ViewDeps, r: Route<"camps">): Promise<Outcome<JsonValue>> {
	const views = await d.cd.inventory.list(r.set === undefined ? undefined : { campSets: [r.set] });
	const filtered = views
		.filter((v) => (r.taint ? matchesTaint(v.status, r.taint) : true))
		.filter((v) => (r.condition ? matchesCondition(v.status, r.condition) : true))
		.slice()
		.sort((a, b) => a.topology.campId.localeCompare(b.topology.campId));
	return { ok: true, value: { camps: filtered.map(campJson) } };
}

export async function campInventoryView(d: ViewDeps, r: Route<"campInventory">): Promise<Outcome<JsonValue>> {
	const [status, topology] = await Promise.all([d.cd.inventory.status(r.campId), d.topology?.camp(r.campId)]);
	if (!status && !topology) return serviceRefusal("not-found", `no Camp ${r.campId} in the inventory`, r.campId);
	return {
		ok: true,
		value: {
			campId: r.campId,
			...(topology ? { topology: { ...topology, regions: [...topology.regions] } as JsonValue } : {}),
			...(status ? { status: recordJson(CampStatusRecordSchema, status) } : {}),
		},
	};
}

export async function placementDecisionView(d: ViewDeps, r: Route<"placementDecision">): Promise<Outcome<JsonValue>> {
	const decision = await d.cd.placement.decision(r.decisionId);
	if (!decision || decision.placement !== r.placement) {
		return serviceRefusal("not-found", `no decision ${r.decisionId} for placement ${r.placement}`, r.decisionId);
	}
	return { ok: true, value: { decision: recordJson(PlacementDecisionRecordSchema, decision) } };
}

export async function fanoutView(d: ViewDeps, r: Route<"fanout">): Promise<Outcome<JsonValue>> {
	const fanout = await d.cd.fanout.get(r.fanoutId);
	if (!fanout) return serviceRefusal("not-found", `no fan-out ${r.fanoutId}`, r.fanoutId);
	return { ok: true, value: { fanout: recordJson(FanoutStatusRecordSchema, fanout) } };
}

export async function failoversView(d: ViewDeps, r: Route<"failovers">): Promise<Outcome<JsonValue>> {
	const rows = await d.cd.failover.list(r.state === undefined ? undefined : { state: r.state });
	const sorted = rows.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.failoverId.localeCompare(b.failoverId));
	return { ok: true, value: { failovers: sorted.map((f) => recordJson(FailoverRecordSchema, f)) } };
}

export async function complianceView(d: ViewDeps, r: Route<"compliance">): Promise<Outcome<JsonValue>> {
	const campIds = r.campId !== undefined ? [r.campId] : (await d.cd.inventory.list()).map((v) => v.topology.campId).sort();
	const out: JsonValue[] = [];
	for (const campId of campIds) {
		for (const record of await d.cd.posture.compliance(campId)) {
			if (r.railDigest !== undefined && record.railDigest !== r.railDigest) continue;
			out.push(recordJson(ComplianceRecordSchema, record));
		}
	}
	return { ok: true, value: { compliance: out } };
}
