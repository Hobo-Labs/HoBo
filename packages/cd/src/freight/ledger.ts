// createFreightLedger (WP1, D2, D18): the event-sourced home of Freight.
//
// Commands append to `cd-freight-<id>` with expected-seq CAS and an
// idempotency key per fact, so a retried command records nothing twice (I12)
// and a concurrent writer is re-read rather than overwritten. Queries fold the
// stream; `list`/`getByAlias` read a projection over `freight.Recorded` that
// catches up from its last journal position and is rebuilt from the journal
// on start.
import { create } from "@bufbuild/protobuf";
import type { EventPosition } from "@hobo/core";
import {
	type FreightApprovedRecord,
	FreightApprovedRecordSchema,
	FreightOrigin,
	type FreightQualifiedRecord,
	FreightQualifiedRecordSchema,
	type FreightRecord,
	FreightRecordSchema,
	type FreightRetiredRecord,
	FreightRetiredRecordSchema,
	type FreightYankedRecord,
	FreightYankedRecordSchema,
	type RetentionPolicyRecord,
	VerificationVerdict,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS, FREIGHT_SCHEMA } from "../events.js";
import type {
	ArtifactVerifier,
	CampId,
	CdAction,
	CdAuthorizer,
	CdBase,
	CdContext,
	FreightId,
	FreightLedger,
	Outcome,
	Refusal,
	TelemetrySink,
} from "../ports.js";
import { body, decode, emitCounter, iso, principalName, referencedFreightId, stringField } from "./journal.js";
import { freightIdentity, parseFreightManifest } from "./manifest.js";
import { FREIGHT_REASON, reason, refuse, refuseWith } from "./reasons.js";
import { type CampDeployments, planRetention, type RetentionCandidate, type RetentionPin } from "./retention.js";

// public-contract: metric names the ledger emits through TelemetrySink.
export const FREIGHT_METRIC = Object.freeze({
	recorded: "hobo.cd.freight.recorded",
	refused: "hobo.cd.freight.refused",
	yanked: "hobo.cd.freight.yanked",
	qualified: "hobo.cd.freight.qualified",
	approved: "hobo.cd.freight.approved",
	retired: "hobo.cd.freight.retired",
	retentionAborted: "hobo.cd.freight.retention.aborted",
} as const);

export type FreightLedgerDeps = CdBase & {
	readonly artifacts: ArtifactVerifier;
	readonly telemetry: TelemetrySink;
	/**
	 * Governs `approve` (required: without it approvals fail closed) and
	 * `yank` (when present). Recording is governed by the ingress that calls
	 * `record` (FreightIngest, FreightSources).
	 */
	readonly authorizer?: CdAuthorizer;
};

type FreightState = {
	seq: number;
	record?: FreightRecord | undefined;
	yanked?: FreightYankedRecord | undefined;
	retired?: FreightRetiredRecord | undefined;
	qualifications: FreightQualifiedRecord[];
	approvals: FreightApprovedRecord[];
	/** An event in the stream could not be decoded; usability fails closed. */
	unreadable: boolean;
};

const TERMINAL_PROMOTION_EVENTS: ReadonlySet<string> = new Set([
	CD_EVENTS.EnvPromoted,
	CD_EVENTS.EnvPromoteRejected,
	CD_EVENTS.EnvPromoteSuperseded,
	CD_EVENTS.EnvPromoteRolledBack,
]);
const MAX_REASON = 1024;
const CAS_ATTEMPTS = 3;

class RetentionAborted extends Error {}

export function createFreightLedger(deps: FreightLedgerDeps): FreightLedger {
	const index = new Map<string, FreightRecord>();
	let indexedTo: EventPosition | undefined;

	function emit(name: string, attributes: Readonly<Record<string, string>> = {}, value = 1): void {
		emitCounter(deps.telemetry, { name, unit: "{freight}", atMs: deps.now(), attributes: { tenant: deps.tenant, ...attributes }, value });
	}

	function refused(outcome: Refusal, operation: string): Refusal {
		emit(FREIGHT_METRIC.refused, { operation, code: outcome.reasons[0]?.code ?? "" });
		return outcome;
	}

	async function load(id: string): Promise<FreightState> {
		const state: FreightState = { seq: 0, qualifications: [], approvals: [], unreadable: false };
		for await (const event of deps.store.read(CD_STREAMS.freight(id))) {
			state.seq = event.seq;
			switch (event.type) {
				case CD_EVENTS.FreightRecorded:
					state.record = decode(FreightRecordSchema, event.data);
					state.unreadable ||= state.record === undefined;
					break;
				case CD_EVENTS.FreightYanked:
					state.yanked = decode(FreightYankedRecordSchema, event.data);
					state.unreadable ||= state.yanked === undefined;
					break;
				case CD_EVENTS.FreightRetired:
					state.retired = decode(FreightRetiredRecordSchema, event.data);
					state.unreadable ||= state.retired === undefined;
					break;
				case CD_EVENTS.FreightQualified: {
					const qualified = decode(FreightQualifiedRecordSchema, event.data);
					if (qualified) state.qualifications.push(qualified);
					else state.unreadable = true;
					break;
				}
				case CD_EVENTS.FreightApproved: {
					const approved = decode(FreightApprovedRecordSchema, event.data);
					if (approved) state.approvals.push(approved);
					else state.unreadable = true;
					break;
				}
				default:
					break;
			}
		}
		return state;
	}

	/** Run a command against the folded stream, re-reading on a CAS conflict. */
	async function mutate<T>(
		id: string,
		ctx: CdContext,
		decide: (state: FreightState) => Promise<
			Outcome<T> | Readonly<{ ok: true; value: T; append: Readonly<{ type: string; data: unknown; key: string }> }>
		>,
	): Promise<Outcome<T>> {
		for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
			const state = await load(id);
			const decision = await decide(state);
			if (!decision.ok || !("append" in decision)) return decision;
			try {
				await deps.store.append(
					CD_STREAMS.freight(id),
					[{ type: decision.append.type, data: decision.append.data, meta: { idempotencyKey: decision.append.key } }],
					{ expectedSeq: state.seq, actor: ctx.principal, tenant: deps.tenant },
				);
				return { ok: true, value: decision.value };
			} catch (error) {
				if (attempt === CAS_ATTEMPTS - 1) {
					return refuse(
						FREIGHT_REASON.conflict,
						`journal append for ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
						"retry the command; it is idempotent",
						id,
					);
				}
			}
		}
		return refuse(FREIGHT_REASON.conflict, `journal append for ${id} did not settle`, "retry the command; it is idempotent", id);
	}

	function unusable(state: FreightState, id: string): Refusal | undefined {
		if (!state.record) return refuse(FREIGHT_REASON.notFound, `no Freight ${id}`, "record the Freight first, or check the id", id);
		if (state.unreadable) {
			return refuse(FREIGHT_REASON.notFound, `Freight ${id} has an unreadable journal event`, "repair the journal from backup", id);
		}
		if (state.yanked) {
			return refuse(FREIGHT_REASON.yanked, `Freight ${id} was yanked: ${state.yanked.reason}`, "record and promote newer Freight", id);
		}
		if (state.retired) {
			return refuse(FREIGHT_REASON.retired, `Freight ${id} was retired by retention`, "record the build again to re-admit it", id);
		}
		return undefined;
	}

	async function govern(
		action: CdAction,
		subject: Readonly<Record<string, string>>,
		ctx: CdContext,
	): Promise<Outcome<string>> {
		if (!deps.authorizer) {
			return refuse(
				FREIGHT_REASON.ungoverned,
				`${action} needs a policy decision and the ledger has no authorizer`,
				"compose createFreightLedger with the CdAuthorizer (WP18 compose)",
				action,
			);
		}
		const decision = await deps.authorizer.authorize(action, subject, ctx);
		if (!decision.ok) {
			return refuseWith(
				reason(FREIGHT_REASON.unauthorized, `${action} was denied by policy`, "request the grant from a policy owner", action),
				decision.reasons,
			);
		}
		if (decision.value.proposalOnly) {
			return refuse(
				FREIGHT_REASON.proposalOnly,
				`${principalName(ctx.principal)} may only propose ${action}`,
				"ask a granted principal to apply the proposal",
				action,
			);
		}
		return { ok: true, value: decision.value.decisionId };
	}

	async function catchUp(): Promise<void> {
		for await (const entry of deps.store.readAll({
			tenant: deps.tenant,
			filter: { type: CD_EVENTS.FreightRecorded },
			...(indexedTo !== undefined ? { after: indexedTo } : {}),
		})) {
			indexedTo = entry.position;
			const record = decode(FreightRecordSchema, entry.event.data);
			if (record && !index.has(record.freightId)) index.set(record.freightId, record);
		}
	}

	async function deployments(): Promise<readonly CampDeployments[]> {
		const byCamp = new Map<string, string[]>();
		for await (const entry of deps.store.readAll({ tenant: deps.tenant, filter: { type: CD_EVENTS.SetCreated } })) {
			const freightId = referencedFreightId(entry.event.data);
			if (freightId === undefined) throw new RetentionAborted(`unreadable ${CD_EVENTS.SetCreated} at ${entry.position}`);
			const streamCamp = entry.event.streamId.startsWith("cd-camp-") ? entry.event.streamId.slice("cd-camp-".length) : "";
			const campId = stringField(entry.event.data, "campId", "camp_id") || streamCamp;
			const history = byCamp.get(campId) ?? [];
			history.push(freightId);
			byCamp.set(campId, history);
		}
		return [...byCamp].map(([campId, freightIds]) => ({ campId, freightIds }));
	}

	async function inFlightPromotions(): Promise<readonly RetentionPin[]> {
		const requested = new Map<string, string>();
		for await (const entry of deps.store.readAll({ tenant: deps.tenant, filter: { type: CD_EVENTS.EnvPromoteRequested } })) {
			const freightId = referencedFreightId(entry.event.data);
			if (freightId === undefined) throw new RetentionAborted(`unreadable ${CD_EVENTS.EnvPromoteRequested} at ${entry.position}`);
			if (freightId !== "") requested.set(entry.event.streamId, freightId);
		}
		for (const type of TERMINAL_PROMOTION_EVENTS) {
			for await (const entry of deps.store.readAll({ tenant: deps.tenant, filter: { type } })) {
				requested.delete(entry.event.streamId);
			}
		}
		return [...requested.values()].map((freightId) => ({ freightId, reason: "in-flight-promotion" as const }));
	}

	return {
		async record(input, ctx) {
			if (input.origin === FreightOrigin.UNSPECIFIED || FreightOrigin[input.origin] === undefined) {
				return refused(refuse(FREIGHT_REASON.originInvalid, "Freight origin must be specified", "pass the ingress origin", "origin"), "record");
			}
			const parsed = parseFreightManifest(input.manifest);
			if (!parsed.ok) return refused(parsed, "record");
			const { freightId, alias } = freightIdentity(parsed.value);
			const existing = await load(freightId);
			if (existing.record) return { ok: true, value: existing.record };
			const verified = await deps.artifacts.verify(parsed.value, ctx);
			if (!verified.ok) {
				return refused(
					refuseWith(
						reason(
							FREIGHT_REASON.artifactsUnverified,
							`artifact digests for ${parsed.value.bindle} could not be verified at their coordinates`,
							"publish the artifacts at the declared coordinates with the declared digests, then resubmit",
							freightId,
						),
						verified.reasons,
					),
					"record",
				);
			}
			const outcome = await mutate<FreightRecord>(freightId, ctx, async (state) => {
				if (state.record) return { ok: true, value: state.record };
				const record = create(FreightRecordSchema, {
					schemaVersion: FREIGHT_SCHEMA,
					freightId,
					alias,
					manifest: parsed.value,
					origin: input.origin,
					sourceName: input.sourceName ?? "",
					recordedBy: principalName(ctx.principal),
					recordedAt: iso(ctx.now()),
				});
				return {
					ok: true,
					value: record,
					append: { type: CD_EVENTS.FreightRecorded, data: body(FreightRecordSchema, record), key: CD_EVENTS.FreightRecorded },
				};
			});
			if (outcome.ok) {
				index.set(freightId, outcome.value);
				emit(FREIGHT_METRIC.recorded, { origin: FreightOrigin[input.origin] ?? "", bindle: parsed.value.bindle });
			}
			return outcome;
		},

		async yank(id, why, ctx) {
			const text = why.trim();
			if (text === "" || text.length > MAX_REASON) {
				return refused(refuse(FREIGHT_REASON.reasonRequired, "a yank needs a reason (1-1024 characters)", "state why the Freight is unsafe", id), "yank");
			}
			let appended = false;
			const outcome = await mutate<FreightRecord>(id, ctx, async (state) => {
				if (!state.record) return refuse(FREIGHT_REASON.notFound, `no Freight ${id}`, "check the id or alias", id);
				if (state.yanked) return { ok: true, value: state.record };
				if (deps.authorizer) {
					const decision = await govern("freight.yank", { freightId: id, reason: text }, ctx);
					if (!decision.ok) return decision;
				}
				const yanked = create(FreightYankedRecordSchema, {
					freightId: id,
					reason: text,
					yankedBy: principalName(ctx.principal),
					yankedAt: iso(ctx.now()),
				});
				appended = true;
				return {
					ok: true,
					value: state.record,
					append: { type: CD_EVENTS.FreightYanked, data: body(FreightYankedRecordSchema, yanked), key: CD_EVENTS.FreightYanked },
				};
			});
			if (!outcome.ok) return refused(outcome, "yank");
			if (appended) emit(FREIGHT_METRIC.yanked);
			return outcome;
		},

		async approve(input, ctx) {
			const text = input.reason.trim();
			if (String(input.campId).trim() === "") {
				return refused(refuse(FREIGHT_REASON.campRequired, "an approval names one Camp", "pass the target Camp id", "campId"), "approve");
			}
			if (text === "" || text.length > MAX_REASON) {
				return refused(refuse(FREIGHT_REASON.reasonRequired, "an approval needs a reason", "reference the incident or change", "reason"), "approve");
			}
			const nowMs = ctx.now();
			if (input.expiresAtMs <= nowMs || input.expiresAtMs - nowMs > CD_DEFAULTS.hotfixApprovalMaxMs) {
				return refused(
					refuse(
						FREIGHT_REASON.approvalExpiry,
						`approval must expire after now and within ${CD_DEFAULTS.hotfixApprovalMaxMs} ms`,
						"choose an expiry within the hotfix maximum (72 h)",
						"expiresAtMs",
					),
					"approve",
				);
			}
			const outcome = await mutate<FreightApprovedRecord>(input.freightId, ctx, async (state) => {
				const blocked = unusable(state, input.freightId);
				if (blocked) return blocked;
				const decision = await govern(
					"freight.approve",
					{ freightId: input.freightId, campId: input.campId, reason: text, expiresAt: iso(input.expiresAtMs) },
					ctx,
				);
				if (!decision.ok) return decision;
				const approved = create(FreightApprovedRecordSchema, {
					freightId: input.freightId,
					campId: input.campId,
					approvedBy: principalName(ctx.principal),
					reason: text,
					decisionId: decision.value,
					approvedAt: iso(nowMs),
					expiresAt: iso(input.expiresAtMs),
				});
				return {
					ok: true,
					value: approved,
					append: {
						type: CD_EVENTS.FreightApproved,
						data: body(FreightApprovedRecordSchema, approved),
						key: `${CD_EVENTS.FreightApproved}:${decision.value}`,
					},
				};
			});
			if (!outcome.ok) return refused(outcome, "approve");
			emit(FREIGHT_METRIC.approved);
			return outcome;
		},

		async qualify(input, ctx) {
			const result = input.result;
			if (result.verdict !== VerificationVerdict.PASS) {
				return refused(
					refuse(
						FREIGHT_REASON.verificationNotPass,
						`qualification needs a PASS verification; got ${VerificationVerdict[result.verdict] ?? result.verdict}`,
						"fix the release and verify again; FAIL and INCONCLUSIVE never qualify",
						result.verificationId,
					),
					"qualify",
				);
			}
			if (result.freightId !== input.freightId || result.campId !== input.campId || result.verificationId.trim() === "") {
				return refused(
					refuse(
						FREIGHT_REASON.verificationMismatch,
						`verification ${result.verificationId} is for ${result.freightId} at ${result.campId}`,
						"qualify with the verification of this Freight at this Camp",
						result.verificationId,
					),
					"qualify",
				);
			}
			if (String(input.campId).trim() === "" || input.pipeline.trim() === "" || input.node.trim() === "") {
				return refused(refuse(FREIGHT_REASON.campRequired, "qualification names a Camp, pipeline and node", "pass all three", "campId"), "qualify");
			}
			const key = `${CD_EVENTS.FreightQualified}:${input.campId}:${input.pipeline}:${input.node}:${result.verificationId}`;
			let appended = false;
			const outcome = await mutate<FreightQualifiedRecord>(input.freightId, ctx, async (state) => {
				const prior = state.qualifications.find(
					(item) =>
						item.campId === input.campId &&
						item.pipeline === input.pipeline &&
						item.node === input.node &&
						item.verificationId === result.verificationId,
				);
				if (prior) return { ok: true, value: prior };
				const blocked = unusable(state, input.freightId);
				if (blocked) return blocked;
				const qualified = create(FreightQualifiedRecordSchema, {
					freightId: input.freightId,
					campId: input.campId,
					pipeline: input.pipeline,
					node: input.node,
					verificationId: result.verificationId,
					qualifiedAt: iso(ctx.now()),
				});
				appended = true;
				return {
					ok: true,
					value: qualified,
					append: { type: CD_EVENTS.FreightQualified, data: body(FreightQualifiedRecordSchema, qualified), key },
				};
			});
			if (!outcome.ok) return refused(outcome, "qualify");
			if (appended) emit(FREIGHT_METRIC.qualified, { pipeline: input.pipeline, node: input.node });
			return outcome;
		},

		async get(id) {
			return (await load(id)).record;
		},

		async getByAlias(alias) {
			await catchUp();
			const matches = [...index.values()].filter((record) => record.alias === alias);
			// Aliases are for humans; two Freight sharing one is ambiguous and
			// resolves to nothing rather than to a guess.
			return matches.length === 1 ? matches[0] : undefined;
		},

		async isUsable(id) {
			return unusable(await load(id), id) === undefined;
		},

		async qualifications(id) {
			return (await load(id)).qualifications;
		},

		async approvals(id) {
			return (await load(id)).approvals;
		},

		async list(query = {}) {
			await catchUp();
			const labels = Object.entries(query.labels ?? {});
			const matches = [...index.values()]
				.reverse()
				.filter((record) => query.bindle === undefined || record.manifest?.bindle === query.bindle)
				.filter((record) => labels.every(([key, value]) => record.manifest?.labels[key] === value));
			return query.limit !== undefined && query.limit >= 0 ? matches.slice(0, query.limit) : matches;
		},

		async retire(policy: RetentionPolicyRecord, ctx) {
			await catchUp();
			const nowMs = ctx.now();
			const states = new Map<string, FreightState>();
			for (const id of index.keys()) states.set(id, await load(id));
			let camps: readonly CampDeployments[];
			let promotions: readonly RetentionPin[];
			try {
				camps = await deployments();
				promotions = await inFlightPromotions();
			} catch (error) {
				if (!(error instanceof RetentionAborted)) throw error;
				emit(FREIGHT_METRIC.retentionAborted, { reason: error.message });
				return [];
			}
			const candidates: RetentionCandidate[] = [];
			const approvals: RetentionPin[] = [];
			for (const [id, state] of states) {
				if (!state.record || state.retired || state.unreadable) continue;
				candidates.push({
					freightId: id,
					bindle: state.record.manifest?.bindle ?? "",
					recordedAtMs: Date.parse(state.record.recordedAt),
					labels: state.record.manifest?.labels ?? {},
				});
				if (state.approvals.some((approval) => Date.parse(approval.expiresAt) > nowMs)) {
					approvals.push({ freightId: id, reason: "approval" });
				}
			}
			const plan = planRetention({
				policy: {
					bindle: policy.bindle,
					keepPerCamp: policy.keepPerCamp,
					keepUnpromotedMs: Number(policy.keepUnpromotedMs),
					legalHoldLabels: policy.legalHoldLabels,
				},
				nowMs,
				candidates,
				deployments: camps,
				pinned: [...promotions, ...approvals],
			});
			const retired: FreightRecord[] = [];
			for (const id of plan.retire) {
				const outcome = await mutate<FreightRecord | undefined>(id, ctx, async (state) => {
					if (!state.record || state.retired) return { ok: true, value: undefined };
					const record = create(FreightRetiredRecordSchema, {
						freightId: id,
						reason: `retention: unreferenced for ${Number(policy.keepUnpromotedMs) || CD_DEFAULTS.retentionKeepUnpromotedMs} ms`,
						retiredAt: iso(nowMs),
					});
					return {
						ok: true,
						value: state.record,
						append: { type: CD_EVENTS.FreightRetired, data: body(FreightRetiredRecordSchema, record), key: CD_EVENTS.FreightRetired },
					};
				});
				if (outcome.ok && outcome.value) retired.push(outcome.value);
			}
			if (retired.length > 0) emit(FREIGHT_METRIC.retired, { bindle: policy.bindle }, retired.length);
			return retired;
		},
	};
}

