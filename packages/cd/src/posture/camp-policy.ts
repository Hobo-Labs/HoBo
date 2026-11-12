// CampPolicy (plan 0024 D24, I23): which Rail governs a Camp. Bindings are
// `policy.BindingChanged` facts on the Camp's spec stream `cd-camp-<id>`,
// written by promotion only (subject RAIL), so one writer per Camp still
// holds. The body is exactly the protobuf JSON of PolicyBindingRecord (the
// spec fold in ./sets decodes it); the command that wrote it (`bind` or
// `restore`) and its mode travel in event meta.
//
//   INFORM   candidate := Rail digest; the enforced Rail still decides.
//   ENFORCE  enforced  := Rail digest; candidate cleared. Requires a
//            qualification on an INFORM pipeline node, or an unexpired
//            approval for the Camp (I23), read from the journal.
//   restore  enforced  := the digest enforced before that promotion's bind;
//            candidate cleared. Refused when a later bind superseded it.
//
// A Camp with no binding resolves to its Station's active Rail
// (`governingRailDigest`), so existing behaviour is unchanged.
import { create } from "@bufbuild/protobuf";
import type { EventEnvelope, JsonObject } from "@hobo/core";
import {
	FreightApprovedRecordSchema,
	FreightQualifiedRecordSchema,
	type FreightRecord,
	FreightSubject,
	PipelineRecordSchema,
	type PolicyBindingRecord,
	PolicyBindingRecordSchema,
	PolicyMode,
} from "../_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../events.js";
import type {
	CampId,
	CampPolicy,
	CdAuthorizer,
	CdBase,
	CdContext,
	Digest,
	FreightId,
	Outcome,
	TelemetrySink,
} from "../ports.js";
import {
	appendOnce,
	asDigest,
	body,
	decode,
	emit,
	iso,
	metaString,
	parseTime,
	reason,
	refuse,
} from "./journal.js";
import { POSTURE_METRIC, POSTURE_REASON } from "./reasons.js";

export type CampPolicyDeps = CdBase & {
	readonly authorizer: CdAuthorizer;
	/** Optional: binding metrics. The frozen factory signature does not carry it. */
	readonly telemetry?: TelemetrySink;
};

type BindingEntry = Readonly<{
	binding: PolicyBindingRecord;
	action: "bind" | "restore";
	mode: PolicyMode;
}>;

type CampBindings = Readonly<{ entries: readonly BindingEntry[] }>;

const MODE_NAME: Readonly<Record<number, string>> = {
	[PolicyMode.INFORM]: "INFORM",
	[PolicyMode.ENFORCE]: "ENFORCE",
};

/** The Rail digest that decides for a Camp: its enforced binding, else the Station's active Rail. */
export function governingRailDigest(
	binding: PolicyBindingRecord | undefined,
	stationRailDigest: Digest | undefined,
): Digest | undefined {
	return asDigest(binding?.enforcedRailDigest ?? "") ?? stationRailDigest;
}

function entryOf<T>(event: EventEnvelope<T>): BindingEntry | undefined {
	const binding = decode(PolicyBindingRecordSchema, event.data);
	if (!binding) return undefined;
	const action = metaString(event, "action") === "restore" ? "restore" : "bind";
	const mode =
		metaString(event, "mode") === "ENFORCE"
			? PolicyMode.ENFORCE
			: PolicyMode.INFORM;
	return { binding, action, mode };
}

function lastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i -= 1) {
		const item = items[i];
		if (item !== undefined && test(item)) return i;
	}
	return -1;
}

export function createCampPolicy(d: CampPolicyDeps): CampPolicy {
	async function load(campId: CampId): Promise<CampBindings> {
		const entries: BindingEntry[] = [];
		for await (const event of d.store.read(CD_STREAMS.campSpec(campId))) {
			if (event.type !== CD_EVENTS.PolicyBindingChanged) continue;
			const entry = entryOf(event);
			if (entry) entries.push(entry);
		}
		return { entries };
	}

	/** Pipeline nodes by `pipeline/node`, from the latest `pipeline.Applied` of each pipeline read. */
	async function nodeMode(
		pipeline: string,
		node: string,
	): Promise<PolicyMode | undefined> {
		let mode: PolicyMode | undefined;
		for await (const event of d.store.read(CD_STREAMS.pipeline(pipeline))) {
			if (event.type !== CD_EVENTS.PipelineApplied) continue;
			const record = decode(PipelineRecordSchema, event.data);
			if (!record) continue;
			mode = record.nodes.find((n) => n.name === node)?.policyMode;
		}
		return mode;
	}

	/** I23: a qualification on an INFORM node, or an unexpired approval for this Camp. */
	async function shadowSatisfied(
		freightId: FreightId,
		campId: CampId,
		nowMs: number,
	): Promise<boolean> {
		for await (const event of d.store.read(CD_STREAMS.freight(freightId))) {
			if (event.type === CD_EVENTS.FreightApproved) {
				const approval = decode(FreightApprovedRecordSchema, event.data);
				const expires = parseTime(approval?.expiresAt ?? "");
				if (
					approval?.campId === campId &&
					expires !== undefined &&
					expires > nowMs
				)
					return true;
			} else if (event.type === CD_EVENTS.FreightQualified) {
				const qualified = decode(FreightQualifiedRecordSchema, event.data);
				if (
					qualified &&
					(await nodeMode(qualified.pipeline, qualified.node)) ===
						PolicyMode.INFORM
				)
					return true;
			}
		}
		return false;
	}

	async function append(
		campId: CampId,
		record: PolicyBindingRecord,
		meta: JsonObject,
		key: string,
		ctx: CdContext,
	) {
		const event = await appendOnce({
			store: d.store,
			tenant: d.tenant,
			actor: ctx.principal,
			streamId: CD_STREAMS.campSpec(campId),
			event: {
				type: CD_EVENTS.PolicyBindingChanged,
				data: body(PolicyBindingRecordSchema, record),
				meta,
			},
			idempotencyKey: key,
		});
		if (!event)
			return refuse(
				reason(
					POSTURE_REASON.journalConflict,
					`could not append policy.BindingChanged to ${CD_STREAMS.campSpec(campId)} (concurrent writers)`,
					"Retry the promotion step; binding is idempotent per promotion.",
					campId,
				),
			);
		const written = decode(PolicyBindingRecordSchema, event.data) ?? record;
		emit(d.telemetry, [
			{
				name: POSTURE_METRIC.bindingChanged,
				kind: "counter",
				value: 1,
				unit: "{binding}",
				atMs: ctx.now(),
				attributes: {
					tenant: d.tenant,
					camp: campId,
					action: metaString(event, "action") ?? "bind",
					mode: metaString(event, "mode") ?? "",
				},
			},
		]);
		return { ok: true as const, value: written };
	}

	return {
		async binding(campId) {
			const state = await load(campId);
			return state.entries.at(-1)?.binding;
		},

		async bind(input, ctx) {
			const freight: FreightRecord = input.freight;
			const subject = freight.manifest?.subject ?? FreightSubject.UNSPECIFIED;
			if (subject !== FreightSubject.RAIL)
				return refuse(
					reason(
						POSTURE_REASON.notRail,
						`Freight ${freight.freightId} is not a Rail (subject ${FreightSubject[subject] ?? subject})`,
						"Only RAIL Freight binds a Camp's policy; promote Bindle Freight as a Set.",
						input.campId,
					),
				);
			const railDigest = asDigest(freight.manifest?.declarationHash ?? "");
			if (!railDigest)
				return refuse(
					reason(
						POSTURE_REASON.digestInvalid,
						`Rail Freight ${freight.freightId} does not carry a sha256 Rail content digest`,
						"Record the Rail Freight with declaration_hash = the Rail content digest (sha256:<hex>).",
						input.campId,
					),
				);
			const modeName = MODE_NAME[input.mode];
			if (modeName === undefined)
				return refuse(
					reason(
						POSTURE_REASON.modeInvalid,
						`policy mode ${input.mode} is neither INFORM nor ENFORCE`,
						"Set the pipeline node's policy_mode to INFORM or ENFORCE.",
						input.campId,
					),
				);
			const decision = await d.authorizer.authorize(
				"rail.promote",
				{
					campId: input.campId,
					railDigest,
					mode: modeName,
					promotionId: input.promotionId,
					freightId: freight.freightId,
				},
				ctx,
			);
			if (!decision.ok) return decision;
			if (decision.value.proposalOnly)
				return refuse(
					reason(
						POSTURE_REASON.proposalOnly,
						`${ctx.principal.kind}:${ctx.principal.id} may only propose Rail promotions`,
						"Have a principal granted rail.promote approve the promotion.",
						input.campId,
					),
				);
			const state = await load(input.campId);
			const key = `bind:${input.promotionId}:${modeName}:${railDigest}`;
			const prior = state.entries.find(
				(e) =>
					e.action === "bind" &&
					e.binding.promotionId === input.promotionId &&
					e.mode === input.mode &&
					(input.mode === PolicyMode.ENFORCE
						? e.binding.enforcedRailDigest
						: e.binding.candidateRailDigest) === railDigest,
			);
			if (prior) return { ok: true, value: prior.binding };
			const nowMs = ctx.now();
			// SAFETY: FreightRecord ids are the Freight content digests.
			if (
				input.mode === PolicyMode.ENFORCE &&
				!(await shadowSatisfied(
					freight.freightId as FreightId,
					input.campId,
					nowMs,
				))
			)
				return refuse(
					reason(
						POSTURE_REASON.shadowRequired,
						`Rail ${railDigest} has not qualified on an INFORM node and holds no unexpired approval for Camp ${input.campId}`,
						"Bind the Rail in INFORM upstream and let its verification qualify it, or record an expiring approval (freight.Approved) for this Camp.",
						input.campId,
					),
				);
			const current = state.entries.at(-1)?.binding;
			const next = create(PolicyBindingRecordSchema, {
				campId: input.campId,
				enforcedRailDigest:
					input.mode === PolicyMode.ENFORCE
						? railDigest
						: (current?.enforcedRailDigest ?? ""),
				candidateRailDigest:
					input.mode === PolicyMode.ENFORCE ? "" : railDigest,
				freightId: freight.freightId,
				promotionId: input.promotionId,
				boundAt: iso(nowMs),
			});
			return append(
				input.campId,
				next,
				{ action: "bind", mode: modeName },
				key,
				ctx,
			);
		},

		async restore(input, ctx): Promise<Outcome<PolicyBindingRecord>> {
			const decision = await d.authorizer.authorize(
				"rollback",
				{
					campId: input.campId,
					promotionId: input.promotionId,
					subject: "rail",
				},
				ctx,
			);
			if (!decision.ok) return decision;
			if (decision.value.proposalOnly)
				return refuse(
					reason(
						POSTURE_REASON.proposalOnly,
						`${ctx.principal.kind}:${ctx.principal.id} may only propose a Rail rollback`,
						"Have a principal granted rollback run it.",
						input.campId,
					),
				);
			const state = await load(input.campId);
			const at = lastIndex(
				state.entries,
				(e) =>
					e.action === "bind" && e.binding.promotionId === input.promotionId,
			);
			if (at < 0)
				return refuse(
					reason(
						POSTURE_REASON.restoreUnknown,
						`promotion ${input.promotionId} never bound a Rail to Camp ${input.campId}`,
						"Roll back the promotion that bound the Camp's current Rail (see policy.BindingChanged on its spec stream).",
						input.campId,
					),
				);
			const later = state.entries.slice(at + 1);
			const restored = later.find(
				(e) =>
					e.action === "restore" && e.binding.promotionId === input.promotionId,
			);
			if (restored && later.at(-1) === restored)
				return { ok: true, value: restored.binding };
			const superseding = later.find((e) => e.action === "bind");
			if (superseding)
				return refuse(
					reason(
						POSTURE_REASON.restoreSuperseded,
						`promotion ${superseding.binding.promotionId} bound Camp ${input.campId} after ${input.promotionId}`,
						`Roll back ${superseding.binding.promotionId} first, then ${input.promotionId}.`,
						input.campId,
					),
				);
			const before = state.entries[at - 1]?.binding;
			const next = create(PolicyBindingRecordSchema, {
				campId: input.campId,
				enforcedRailDigest: before?.enforcedRailDigest ?? "",
				candidateRailDigest: "",
				freightId: before?.freightId ?? "",
				promotionId: input.promotionId,
				boundAt: iso(ctx.now()),
			});
			return append(
				input.campId,
				next,
				{ action: "restore", mode: "" },
				`restore:${input.promotionId}`,
				ctx,
			);
		},
	};
}
