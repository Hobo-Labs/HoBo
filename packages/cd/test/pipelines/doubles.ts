// Collaborator doubles for the pipeline controller tests: Freight ledger,
// promotion service, placement engine, fan-out controller and topology. Each
// implements the frozen port with in-memory state the test arranges.
import { create, toJson } from "@bufbuild/protobuf";
import {
	CampManagement,
	type FanoutStatusRecord,
	FanoutStatusRecordSchema,
	type FreightApprovedRecord,
	FreightApprovedRecordSchema,
	FreightOrigin,
	type FreightQualifiedRecord,
	FreightQualifiedRecordSchema,
	type FreightRecord,
	FreightRecordSchema,
	FreightSubject,
	type PlacementDecisionRecord,
	PlacementDecisionRecordSchema,
	PlacementGroupDecisionRecordSchema,
	type PlacementRecord,
	PlacementRecordSchema,
	type PromotionRecord,
	PromotionRecordSchema,
	PromotionState,
} from "../../src/_generated/cd_pb.js";
import type {
	CampId,
	CampTopology,
	FanoutController,
	FanoutId,
	FreightId,
	FreightLedger,
	Outcome,
	PlacementEngine,
	PromoteRequest,
	PromotionId,
	PromotionService,
	TopologyReader,
} from "../../src/ports.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import { camp, fid, type MemoryEventStore } from "./fakes.js";

const notUsed = (): never => {
	throw new Error("not used by the pipeline controller");
};

export class FakeFreightLedger {
	readonly freight = new Map<string, FreightRecord>();
	readonly quals = new Map<string, FreightQualifiedRecord[]>();
	readonly approvalsBy = new Map<string, FreightApprovedRecord[]>();
	readonly unusable = new Set<string>();

	add(id: string, recordedAtMs: number, fields: Readonly<{ bindle?: string; sourceName?: string; origin?: FreightOrigin; subject?: FreightSubject }> = {}): FreightRecord {
		const record = create(FreightRecordSchema, {
			freightId: id,
			alias: `alias-${id}`,
			origin: fields.origin ?? FreightOrigin.SOURCE_DISCOVERY,
			sourceName: fields.sourceName ?? "images",
			recordedAt: new Date(recordedAtMs).toISOString(),
			manifest: { bindle: fields.bindle ?? "acme/shop", subject: fields.subject ?? FreightSubject.BINDLE, declarationHash: `sha256:${id}` },
		});
		this.freight.set(id, record);
		return record;
	}

	qualify(id: string, campId: string, pipeline: string, node: string, atMs: number): void {
		const list = this.quals.get(id) ?? [];
		list.push(create(FreightQualifiedRecordSchema, { freightId: id, campId, pipeline, node, verificationId: `v-${id}-${campId}`, qualifiedAt: new Date(atMs).toISOString() }));
		this.quals.set(id, list);
	}

	approveFor(id: string, campId: string, expiresAtMs: number): void {
		const list = this.approvalsBy.get(id) ?? [];
		list.push(create(FreightApprovedRecordSchema, { freightId: id, campId, approvedBy: "user:ops", reason: "hotfix", decisionId: "dec-a", approvedAt: new Date(expiresAtMs - 3_600_000).toISOString(), expiresAt: new Date(expiresAtMs).toISOString() }));
		this.approvalsBy.set(id, list);
	}

	async get(id: FreightId) {
		return this.freight.get(id);
	}
	async isUsable(id: FreightId) {
		return this.freight.has(id) && !this.unusable.has(id);
	}
	async qualifications(id: FreightId) {
		return this.quals.get(id) ?? [];
	}
	async approvals(id: FreightId) {
		return this.approvalsBy.get(id) ?? [];
	}
	async list(query?: Readonly<{ bindle?: string; limit?: number }>) {
		return [...this.freight.values()].filter((f) => !query?.bindle || f.manifest?.bindle === query.bindle);
	}
}

// The port's `qualify` collides with the arrange helper above; expose the port shape.
export function ledgerPort(ledger: FakeFreightLedger): FreightLedger {
	return {
		record: notUsed,
		yank: notUsed,
		approve: notUsed,
		qualify: notUsed,
		getByAlias: notUsed,
		retire: notUsed,
		get: (id) => ledger.get(id),
		isUsable: (id) => ledger.isUsable(id),
		qualifications: (id) => ledger.qualifications(id),
		approvals: (id) => ledger.approvals(id),
		list: (query) => ledger.list(query),
	};
}

export class FakePromotions implements PromotionService {
	readonly requests: PromoteRequest[] = [];
	readonly records = new Map<string, PromotionRecord>();
	/** Arranged history per Camp (beyond what this double records itself). */
	readonly history: PromotionRecord[] = [];
	onPromote: ((request: PromoteRequest) => void) | undefined;
	refuseNext = false;
	/** Like WP6, journal `env.PromoteRequested` (body: PromotionRecord) for each new request. */
	constructor(private readonly store?: MemoryEventStore) {}

	async promote(request: PromoteRequest): Promise<Outcome<PromotionRecord>> {
		this.onPromote?.(request);
		const existing = this.records.get(request.idempotencyKey);
		if (existing) return { ok: true, value: existing };
		this.requests.push(request);
		if (this.refuseNext) {
			this.refuseNext = false;
			return { ok: false, reasons: [] };
		}
		const record = create(PromotionRecordSchema, {
			promotionId: `promo-${this.requests.length}`,
			freightId: request.freightId,
			targetCampIds: [...request.targets],
			pipeline: request.pipeline ?? "",
			node: request.node ?? "",
			state: PromotionState.QUEUED,
			idempotencyKey: request.idempotencyKey,
		});
		this.records.set(request.idempotencyKey, record);
		await this.store?.seed(CD_STREAMS.promotion(record.promotionId), CD_EVENTS.EnvPromoteRequested, toJson(PromotionRecordSchema, record));
		return { ok: true, value: record };
	}

	arrange(freightId: string, campId: string, state: PromotionState): void {
		this.history.push(create(PromotionRecordSchema, { promotionId: `hist-${this.history.length}`, freightId, targetCampIds: [campId], state, requestedAt: new Date(0).toISOString() }));
	}

	async list(query?: Readonly<{ campId?: CampId; limit?: number }>) {
		return [...this.history, ...this.records.values()].filter((p) => !query?.campId || p.targetCampIds.includes(query.campId));
	}
	async get(id: PromotionId) {
		return [...this.records.values()].find((p) => p.promotionId === id);
	}
	rollback = notUsed;
	approve = notUsed;
	tick = notUsed;
}

export class FakePlacement implements PlacementEngine {
	readonly placements = new Map<string, PlacementRecord>();
	readonly decisions: PlacementDecisionRecord[] = [];
	nextDecision: PlacementDecisionRecord | undefined;

	define = notUsed;
	reportScores = notUsed;
	async get(name: string) {
		return this.placements.get(name);
	}
	add(name: string, groups: readonly string[] = []): void {
		this.placements.set(name, create(PlacementRecordSchema, { name, campSets: ["fleet"], groups: groups.map((g) => ({ name: g })) }));
	}
	async decide(input: Readonly<{ placement: string; pipeline: string; node: string }>): Promise<Outcome<PlacementDecisionRecord>> {
		const decision = create(PlacementDecisionRecordSchema, {
			...(this.nextDecision ?? decisionOf(["fleet-1"], [])),
			decisionId: `decision-${this.decisions.length + 1}`,
			placement: input.placement,
			pipeline: input.pipeline,
			node: input.node,
		});
		this.decisions.push(decision);
		return { ok: true, value: decision };
	}
	async decision(id: string) {
		return this.decisions.find((d) => d.decisionId === id);
	}
}

/** A decision whose groups hold `camps` (first `mandatory` camps form the mandatory "pilot" group). */
export function decisionOf(camps: readonly string[], mandatory: readonly string[]): PlacementDecisionRecord {
	const rest = camps.filter((c) => !mandatory.includes(c));
	return create(PlacementDecisionRecordSchema, {
		decisionId: "decision-0",
		groups: [
			...(mandatory.length > 0 ? [create(PlacementGroupDecisionRecordSchema, { name: "pilot", index: 0, campIds: [...mandatory], mandatory: true })] : []),
			create(PlacementGroupDecisionRecordSchema, { name: "rest", index: mandatory.length > 0 ? 1 : 0, campIds: rest, mandatory: false }),
		],
		candidates: camps.map((campId) => ({ campId, selected: true })),
	});
}

export class FakeFanout implements FanoutController {
	readonly started: Parameters<FanoutController["start"]>[0][] = [];
	readonly statuses: FanoutStatusRecord[] = [];
	readonly qualifiedBy = new Map<string, Awaited<ReturnType<FanoutController["qualified"]>>>();

	async start(input: Parameters<FanoutController["start"]>[0]): Promise<Outcome<FanoutStatusRecord>> {
		this.started.push(input);
		const status = create(FanoutStatusRecordSchema, { fanoutId: `fanout-${this.started.length}`, pipeline: input.pipeline, node: input.node, freightId: input.freightId, decisionId: input.decision.decisionId, state: 1 });
		this.statuses.push(status);
		return { ok: true, value: status };
	}
	async get(id: FanoutId) {
		return this.statuses.find((s) => s.fanoutId === id);
	}
	async list(query?: Readonly<{ pipeline?: string; node?: string }>) {
		return this.statuses.filter((s) => (!query?.pipeline || s.pipeline === query.pipeline) && (!query?.node || s.node === query.node));
	}
	async qualified(input: Readonly<{ pipeline: string; node: string }>) {
		return this.qualifiedBy.get(`${input.pipeline}/${input.node}`) ?? { qualifiedCampIds: [] };
	}
	setQualified(pipeline: string, node: string, decision: PlacementDecisionRecord, qualifiedCampIds: readonly string[], stableFreightId?: string): void {
		this.qualifiedBy.set(`${pipeline}/${node}`, {
			decision,
			qualifiedCampIds: qualifiedCampIds.map(camp),
			...(stableFreightId ? { stableFreightId: fid(stableFreightId) } : {}),
		});
	}
	halt = notUsed;
	resume = notUsed;
	rollback = notUsed;
	tick = notUsed;
}

export class FakeTopology implements TopologyReader {
	readonly byId = new Map<string, CampTopology>();
	add(id: string, fields: Partial<Omit<CampTopology, "campId">> = {}): void {
		this.byId.set(id, {
			campId: camp(id),
			yardId: "yard-1",
			stationId: "station-1",
			provider: "vercel",
			regions: ["us-east-1"],
			envType: fields.envType ?? "production",
			labels: fields.labels ?? {},
			management: fields.management ?? CampManagement.MANAGED,
			...fields,
		});
	}
	async camps() {
		return [...this.byId.values()];
	}
	async camp(id: CampId) {
		return this.byId.get(id);
	}
}
