// PlacementEngine (D20): governed Placement definitions and score reports, and
// `decide` = gather recorded inputs, run the pure `decidePlacement`, record
// `placement.Decided`.
//
// Streams: `cd-placement-<name>` (placement.Defined, placement.Decided) and
// `cd-placement-score-<score>` (placement.ScoresReported). A decision is
// keyed by a deterministic id over its inputs, so a retried `decide` with the
// same inputs is one event (I12) and replay yields the same record (I18).
import { create, type JsonObject, toJson } from "@bufbuild/protobuf";
import type { EventInput } from "@hobo/core";
import {
	type PlacementDecisionRecord,
	PlacementDecisionRecordSchema,
	type PlacementRecord,
	PlacementRecordSchema,
	type ReasonRecord,
	type ScoreSnapshotRecord,
	ScoreSnapshotRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../events.js";
import {
	body,
	decode,
	emit,
	isConflict,
	iso,
	principalName,
	reason,
	refuse,
	sha256Digest,
} from "../inventory/support.js";
import type {
	CampInventory,
	CdAction,
	CdAuthorizer,
	CdBase,
	CdContext,
	PlacementEngine,
	RailDeliveryReader,
	TelemetrySink,
} from "../ports.js";
import { decidePlacement } from "./decide.js";
import {
	parsePlacement,
	parseScoreSnapshot,
	SCORE_STREAM_PREFIX,
	scoreDigest,
} from "./parse.js";

export type PlacementEngineDeps = CdBase & {
	readonly inventory: CampInventory;
	readonly rails: RailDeliveryReader;
	readonly authorizer: CdAuthorizer;
	/**
	 * The Station's active Rail `approvedProviders` (stations `Rail`). The
	 * frozen RailDeliveryReader carries only the `delivery` object, so the
	 * composition (WP18) supplies this; when absent (or it resolves to
	 * undefined) every decision is refused with `rail-providers-unknown`:
	 * missing evidence fails closed (I5).
	 */
	readonly approvedProviders?: (
		stationId: string,
	) => Promise<readonly string[] | undefined>;
	readonly telemetry?: TelemetrySink;
};

export function scoreStream(score: string): string {
	return CD_STREAMS.placement(`${SCORE_STREAM_PREFIX}${score}`);
}

function proposalRefusal(action: CdAction): ReasonRecord {
	return reason(
		"proposal-only",
		`${action} by this principal is proposal-only`,
		"have a human operator or a granted service principal run the command",
		action,
	);
}

export function createPlacementEngine(d: PlacementEngineDeps): PlacementEngine {
	const decisions = new Map<string, PlacementDecisionRecord>();

	async function authorize(
		action: CdAction,
		subject: JsonObject,
		ctx: CdContext,
	): Promise<ReasonRecord[] | undefined> {
		const decision = await d.authorizer.authorize(action, subject, ctx);
		if (!decision.ok) return [...decision.reasons];
		if (decision.value.proposalOnly) return [proposalRefusal(action)];
		return undefined;
	}

	async function readPlacement(
		name: string,
	): Promise<{ record: PlacementRecord | undefined; seq: number }> {
		let record: PlacementRecord | undefined;
		let seq = 0;
		for await (const event of d.store.read(CD_STREAMS.placement(name))) {
			seq = event.seq;
			if (event.type === CD_EVENTS.PlacementDefined)
				record = decode(PlacementRecordSchema, event.data) ?? record;
			if (event.type === CD_EVENTS.PlacementDecided) {
				const decision = decode(PlacementDecisionRecordSchema, event.data);
				if (decision !== undefined)
					decisions.set(decision.decisionId, decision);
			}
		}
		return { record, seq };
	}

	async function readScores(
		names: readonly string[],
	): Promise<ScoreSnapshotRecord[]> {
		const out: ScoreSnapshotRecord[] = [];
		for (const name of names) {
			for await (const event of d.store.read(scoreStream(name))) {
				if (event.type !== CD_EVENTS.PlacementScoresReported) continue;
				const snapshot = decode(ScoreSnapshotRecordSchema, event.data);
				if (snapshot !== undefined) out.push(snapshot);
			}
		}
		return out;
	}

	async function appendIdempotent(
		stream: string,
		type: string,
		data: ReturnType<typeof body>,
		key: string | undefined,
		ctx: CdContext,
	): Promise<void> {
		for (let attempt = 0; ; attempt += 1) {
			let seq = 0;
			for await (const event of d.store.read(stream)) seq = event.seq;
			try {
				const event: EventInput = { type, data };
				if (key !== undefined) event.meta = { idempotencyKey: key };
				await d.store.append(stream, [event], {
					expectedSeq: seq,
					actor: ctx.principal,
					tenant: d.tenant,
				});
				return;
			} catch (error) {
				if (attempt >= 4 || !isConflict(error)) throw error;
			}
		}
	}

	const engine: PlacementEngine = {
		async define(placement, ctx) {
			const parsed = parsePlacement(placement);
			if (!parsed.ok) return parsed;
			const denied = await authorize(
				"placement.define",
				{ name: parsed.value.name },
				ctx,
			);
			if (denied !== undefined) return refuse(...denied);
			const record = create(PlacementRecordSchema, {
				...parsed.value,
				definedBy: principalName(ctx.principal),
			});
			const current = (await readPlacement(record.name)).record;
			const content = (value: PlacementRecord) =>
				sha256Digest(
					toJson(PlacementRecordSchema, { ...value, definedBy: "" }),
				);
			if (current !== undefined && content(current) === content(record))
				return { ok: true, value: current };
			await appendIdempotent(
				CD_STREAMS.placement(record.name),
				CD_EVENTS.PlacementDefined,
				body(PlacementRecordSchema, record),
				// No key: redefining back to an earlier content must append again.
				undefined,
				ctx,
			);
			emit(d.telemetry, [
				{
					name: "hobo.cd.placement.defined",
					kind: "counter",
					value: 1,
					unit: "{placement}",
					atMs: ctx.now(),
					attributes: { placement: record.name },
				},
			]);
			return { ok: true, value: record };
		},

		async get(name) {
			return (await readPlacement(name)).record;
		},

		async reportScores(snapshot, ctx) {
			const atMs = ctx.now();
			const parsed = parseScoreSnapshot(snapshot, atMs);
			if (!parsed.ok) return parsed;
			const denied = await authorize(
				"placement.scores",
				{ score: parsed.value.score },
				ctx,
			);
			if (denied !== undefined) return refuse(...denied);
			const stamped = create(ScoreSnapshotRecordSchema, {
				...parsed.value,
				reportedBy: principalName(ctx.principal),
				reportedAt: iso(atMs),
				digest: "",
			});
			const record = create(ScoreSnapshotRecordSchema, {
				...stamped,
				digest: scoreDigest(stamped),
			});
			await appendIdempotent(
				scoreStream(record.score),
				CD_EVENTS.PlacementScoresReported,
				body(ScoreSnapshotRecordSchema, record),
				record.digest,
				ctx,
			);
			emit(d.telemetry, [
				{
					name: "hobo.cd.placement.scores_reported",
					kind: "counter",
					value: 1,
					unit: "{snapshot}",
					atMs,
					attributes: { score: record.score },
				},
			]);
			return { ok: true, value: record };
		},

		async decide(input, ctx) {
			const atMs = ctx.now();
			const placement = (await readPlacement(input.placement)).record;
			if (placement === undefined) {
				return refuse(
					reason(
						"placement-not-found",
						`Placement "${input.placement}" is not defined`,
						"define it with placement.define first",
						input.placement,
					),
				);
			}
			const railDelivery = await d.rails.forStation(input.stationId);
			const bound = new Set(railDelivery?.campSets ?? []);
			const visible = placement.campSets.filter((name) => bound.has(name));
			const snapshot = await d.inventory.snapshot(visible);
			const knownSets = (await d.inventory.sets()).map((set) => set.name);
			const scores = await readScores(
				placement.scores.map((weight) => weight.score),
			);
			const approvedProviders =
				d.approvedProviders === undefined
					? undefined
					: await d.approvedProviders(input.stationId);
			const outcome = decidePlacement({
				placement,
				snapshot,
				scores,
				subject: input.subject,
				railDelivery,
				approvedProviders,
				knownSets,
				exclude: input.exclude,
				count: input.count,
				pipeline: input.pipeline,
				node: input.node,
				atMs,
			});
			if (!outcome.ok) {
				emit(d.telemetry, [
					{
						name: "hobo.cd.placement.decisions",
						kind: "counter",
						value: 1,
						unit: "{decision}",
						atMs,
						attributes: { placement: placement.name, outcome: "refused" },
					},
				]);
				return outcome;
			}
			const decision = outcome.value;
			await appendIdempotent(
				CD_STREAMS.placement(placement.name),
				CD_EVENTS.PlacementDecided,
				body(PlacementDecisionRecordSchema, decision),
				decision.decisionId,
				ctx,
			);
			decisions.set(decision.decisionId, decision);
			const selected = decision.candidates.filter(
				(candidate) => candidate.selected,
			).length;
			emit(d.telemetry, [
				{
					name: "hobo.cd.placement.decisions",
					kind: "counter",
					value: 1,
					unit: "{decision}",
					atMs,
					attributes: { placement: placement.name, outcome: "decided" },
				},
				{
					name: "hobo.cd.placement.selected_camps",
					kind: "histogram",
					value: selected,
					unit: "{camp}",
					atMs,
					attributes: { placement: placement.name },
				},
			]);
			return { ok: true, value: decision };
		},

		async decision(decisionId) {
			const known = decisions.get(decisionId);
			if (known !== undefined) return known;
			for await (const entry of d.store.readAll({
				filter: { type: CD_EVENTS.PlacementDecided },
				tenant: d.tenant,
			})) {
				const decision = decode(
					PlacementDecisionRecordSchema,
					entry.event.data,
				);
				if (decision !== undefined)
					decisions.set(decision.decisionId, decision);
			}
			return decisions.get(decisionId);
		},
	};
	return engine;
}
