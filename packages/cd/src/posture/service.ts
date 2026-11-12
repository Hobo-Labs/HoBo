// PostureService (plan 0024 D25, I22): continuous compliance with one mutator.
//
// A Station-side service. On each tick it evaluates every due Camp from the
// latest status observation (`deployment.StatusObserved` on
// `cd-camp-status-<id>`) with the pure evaluator in @hobo/policy/posture,
// against the packs the governing Rail's `delivery.posture` binds, and the
// candidate Rail's packs while one is bound in INFORM. Agents never evaluate
// posture; they report facts.
//
// Facts it appends to `cd-compliance-<id>`:
//   compliance.Observed           every evaluation (ComplianceRecord, naming
//                                 the observation position it used)
//   compliance.Changed            when the state changes (same body)
//   posture.RemediationProposed   per enforced finding (PostureRemediationRecord)
// It updates the Camp's POSTURE_COMPLIANT condition (source HEALTH_SOURCE).
//
// Remediation never mutates a target. `enforce` on an unowned field opens a
// `posture-remediate` Delta (DeltaLedger.open) that the gate admits and the
// Camp's reconciler applies; a Set-owned field is drift (the reconciler
// re-applies the Set) or `ownership-conflict` (nothing mutates; the gate
// refuses Deltas that keep it).
//
// Idempotency: each evaluation's key is the count of earlier records for the
// same (Rail, candidate) pair, so two replicas evaluating the same state
// resolve to one fact under stream CAS; remediation keys are stable per
// (rule, resource, Set, ownership, fix) and Delta ids are derived from them.
import { create } from "@bufbuild/protobuf";
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import type { EventPosition, JsonObject } from "@hobo/core";
import {
	type PosturePack,
	observeFields as packObserveFields,
	parsePosturePack,
	type RemediationMode,
	resolvePostureBindings,
} from "@hobo/policy/posture";
import {
	CampConditionRecordSchema,
	CampConditionType,
	CampManagement,
	ChangeKind,
	type ComplianceRecord,
	ComplianceRecordSchema,
	ComplianceState,
	ConditionStatus,
	DeltaRecordSchema,
	type PostureRemediationRecord,
	PostureRemediationRecordSchema,
	type RailDeliveryRecord,
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	RemediationMode as RemediationModeEnum,
	type SetRecord,
	type ShadowDecisionRecord,
	ShadowDecisionRecordSchema,
	SignalSource,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS, DELTA_SCHEMA } from "../events.js";
import type {
	CampId,
	CampInventory,
	CampPolicy,
	CampView,
	CdAuthorizer,
	CdBase,
	CdContext,
	DeltaLedger,
	DesiredStateReader,
	Digest,
	PostureSeriesReader,
	PostureService,
	RailDeliveryReader,
	TelemetrySink,
} from "../ports.js";
import {
	evaluateCamp,
	noncompliantRatio,
	type RemediationPlan,
} from "./evaluate-camp.js";
import {
	appendOnce,
	asDigest,
	body,
	canonicalJson,
	decode,
	digestOf,
	emit,
	isJsonObject,
	iso,
	jsonOf,
	type MetricPoint,
	metaString,
	parseTime,
	principalName,
	reason,
	sha256Hex,
} from "./journal.js";
import { POSTURE_METRIC, POSTURE_REASON } from "./reasons.js";

export type PostureServiceDeps = CdBase & {
	readonly desired: DesiredStateReader & DeltaLedger;
	readonly campPolicy: CampPolicy;
	readonly rails: RailDeliveryReader;
	readonly inventory: Pick<CampInventory, "list" | "observe">;
	/** Policy packs by name, as policy-IR documents. */
	readonly packs: (names: readonly string[]) => Promise<readonly JsonObject[]>;
	readonly authorizer: CdAuthorizer;
	readonly telemetry: TelemetrySink;
	/**
	 * The `delivery` object of a candidate Rail by digest. Without it a bound
	 * candidate cannot be evaluated and records UNKNOWN (fail closed): wire it
	 * from the Rail registry (not in the frozen factory signature).
	 */
	readonly candidateRail?: (
		railDigest: Digest,
	) => Promise<RailDeliveryRecord | undefined>;
};

const COMPLIANCE_PREFIX = CD_STREAMS.compliance("");
const MODE_NAME: Readonly<Record<number, RemediationMode>> = {
	[RemediationModeEnum.INFORM]: "inform",
	[RemediationModeEnum.INFORM_ONLY]: "inform-only",
	[RemediationModeEnum.ENFORCE]: "enforce",
};

type Timed<T> = Readonly<{ record: T; atMs: number }>;

type CampProjection = {
	compliance: Timed<ComplianceRecord>[];
	shadow: Timed<ShadowDecisionRecord>[];
	remediations: PostureRemediationRecord[];
	remediationKeys: Set<string>;
};

type Observed = Readonly<{
	record: ReconcileObservationRecord;
	position: EventPosition;
}>;

type Target = Readonly<{
	railDigest: string;
	candidate: boolean;
	rail: RailDeliveryRecord | undefined;
}>;

/** Remediation mode of a binding; UNSPECIFIED reads as the conservative default (`inform`). */
function modeOf(mode: RemediationModeEnum): RemediationMode {
	return MODE_NAME[mode] ?? CD_DEFAULTS.postureRemediation;
}

function intervalMs(
	rail: RailDeliveryRecord | undefined,
	state: ComplianceState,
): number {
	const compliant =
		state === ComplianceState.COMPLIANT ||
		state === ComplianceState.NOT_APPLICABLE;
	const values = (rail?.posture ?? [])
		.map((p) =>
			Number(compliant ? p.compliantIntervalMs : p.noncompliantIntervalMs),
		)
		.filter((ms) => Number.isFinite(ms) && ms > 0);
	if (values.length > 0) return Math.min(...values);
	return compliant
		? CD_DEFAULTS.postureCompliantIntervalMs
		: CD_DEFAULTS.postureNoncompliantIntervalMs;
}

function conditionStatus(state: ComplianceState): ConditionStatus {
	if (
		state === ComplianceState.COMPLIANT ||
		state === ComplianceState.NOT_APPLICABLE
	)
		return ConditionStatus.TRUE;
	if (state === ComplianceState.NONCOMPLIANT) return ConditionStatus.FALSE;
	return ConditionStatus.UNKNOWN;
}

function observationOf<T>(data: T): ReconcileObservationRecord | undefined {
	const json = jsonOf(data);
	if (!isJsonObject(json)) return undefined;
	const inner = json.observation;
	return decode(
		ReconcileObservationRecordSchema,
		isJsonObject(inner) ? inner : json,
	);
}

function observeOnly(view: CampView): boolean {
	return (
		view.status.management === CampManagement.OBSERVE_ONLY ||
		view.topology.management === CampManagement.OBSERVE_ONLY
	);
}

function pointsFor(
	tenant: string,
	record: ComplianceRecord,
	atMs: number,
	changed: boolean,
): MetricPoint[] {
	const attributes = {
		tenant,
		camp: record.campId,
		rail: record.railDigest,
		candidate: record.candidate,
		state: ComplianceState[record.state] ?? "",
	};
	return [
		{
			name: POSTURE_METRIC.noncompliantRatio,
			kind: "gauge",
			value: noncompliantRatio(record),
			unit: "1",
			atMs,
			attributes,
		},
		{
			name: POSTURE_METRIC.evaluations,
			kind: "counter",
			value: 1,
			unit: "{evaluation}",
			atMs,
			attributes,
		},
		...(changed
			? [
					{
						name: POSTURE_METRIC.complianceChanged,
						kind: "counter" as const,
						value: 1,
						unit: "{change}",
						atMs,
						attributes,
					},
				]
			: []),
		{
			name: POSTURE_METRIC.ownershipConflicts,
			kind: "gauge",
			value: record.findings.filter((f) => f.ownershipConflict).length,
			unit: "{finding}",
			atMs,
			attributes,
		},
	];
}

export function createPostureService(
	d: PostureServiceDeps,
): PostureService & PostureSeriesReader {
	const camps = new Map<string, CampProjection>();
	const status = new Map<
		string,
		{ cursor?: EventPosition; latest?: Observed }
	>();
	let cursor: EventPosition | undefined;
	let queue: Promise<unknown> = Promise.resolve();

	/** Run one projection or tick step at a time, so concurrent callers never double-fold. */
	function serial<T>(work: () => Promise<T>): Promise<T> {
		const next = queue.then(work, work);
		queue = next.catch(() => undefined);
		return next;
	}

	function projection(campId: string): CampProjection {
		let found = camps.get(campId);
		if (!found) {
			found = {
				compliance: [],
				shadow: [],
				remediations: [],
				remediationKeys: new Set(),
			};
			camps.set(campId, found);
		}
		return found;
	}

	async function catchUp(): Promise<void> {
		for await (const { position, event } of d.store.readAll({
			...(cursor === undefined ? {} : { after: cursor }),
			tenant: d.tenant,
		})) {
			cursor = position;
			if (!event.streamId.startsWith(COMPLIANCE_PREFIX)) continue;
			const campId = event.streamId.slice(COMPLIANCE_PREFIX.length);
			if (event.type === CD_EVENTS.ComplianceObserved) {
				const record = decode(ComplianceRecordSchema, event.data);
				const atMs = parseTime(record?.evaluatedAt ?? "");
				if (record && atMs !== undefined)
					projection(campId).compliance.push({ record, atMs });
			} else if (event.type === CD_EVENTS.PolicyShadowDecided) {
				const record = decode(ShadowDecisionRecordSchema, event.data);
				const atMs = parseTime(record?.decidedAt ?? "");
				if (record && atMs !== undefined)
					projection(campId).shadow.push({ record, atMs });
			} else if (event.type === CD_EVENTS.PostureRemediationProposed) {
				const record = decode(PostureRemediationRecordSchema, event.data);
				if (!record) continue;
				const view = projection(campId);
				view.remediations.push(record);
				const key = metaString(event, "remediationKey");
				if (key) view.remediationKeys.add(key);
			}
		}
	}

	const read = () => serial(catchUp);

	async function latestObservation(
		campId: string,
	): Promise<Observed | undefined> {
		const entry = status.get(campId) ?? {};
		const streamId = CD_STREAMS.campStatus(campId);
		for await (const { position, event } of d.store.readAll({
			...(entry.cursor === undefined ? {} : { after: entry.cursor }),
			filter: { streamId },
			tenant: d.tenant,
		})) {
			entry.cursor = position;
			if (
				event.streamId !== streamId ||
				event.type !== CD_EVENTS.StatusObserved
			)
				continue;
			const record = observationOf(event.data);
			if (record) entry.latest = { record, position };
		}
		status.set(campId, entry);
		return entry.latest;
	}

	async function loadPacks(
		names: readonly string[],
	): Promise<{ packs?: PosturePack[]; problem?: string }> {
		if (names.length === 0) return { packs: [] };
		let documents: readonly JsonObject[];
		try {
			documents = await d.packs(names);
		} catch (error) {
			return {
				problem: `pack lookup failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const parsed = new Map<string, PosturePack>();
		for (const document of documents) {
			try {
				const pack = parsePosturePack(document);
				parsed.set(pack.pack, pack);
			} catch (error) {
				return {
					problem: error instanceof Error ? error.message : String(error),
				};
			}
		}
		const missing = names.filter((name) => !parsed.has(name));
		if (missing.length > 0)
			return { problem: `packs not found: ${missing.join(", ")}` };
		return {
			packs: names
				.map((name) => parsed.get(name))
				.filter((p): p is PosturePack => p !== undefined),
		};
	}

	async function targets(campId: CampId): Promise<Target[]> {
		const out: Target[] = [];
		const enforced = await d.rails.forCamp(campId);
		if (enforced && enforced.posture.length > 0)
			out.push({
				railDigest: enforced.railDigest,
				candidate: false,
				rail: enforced,
			});
		const binding = await d.campPolicy.binding(campId);
		const candidate = asDigest(binding?.candidateRailDigest ?? "");
		if (candidate)
			out.push({
				railDigest: candidate,
				candidate: true,
				rail: d.candidateRail ? await d.candidateRail(candidate) : undefined,
			});
		return out;
	}

	async function currentSet(
		campId: CampId,
	): Promise<{ set?: SetRecord; resolved?: ResolvedDeploymentSet }> {
		try {
			const set = await d.desired.current(campId);
			if (!set) return {};
			return { set, resolved: await d.desired.resolved(set) };
		} catch {
			return {};
		}
	}

	function remediationRecord(
		campId: string,
		plan: RemediationPlan,
		reasons: readonly ReasonRecord[],
		deltaId = "",
	): PostureRemediationRecord {
		return create(PostureRemediationRecordSchema, {
			campId,
			rule: plan.rule,
			resource: plan.resource,
			mode: RemediationModeEnum.ENFORCE,
			deltaId,
			reasons: [...reasons],
		});
	}

	async function appendRemediation(
		campId: string,
		record: PostureRemediationRecord,
		key: string,
		ctx: CdContext,
	): Promise<void> {
		const appended = await appendOnce({
			store: d.store,
			tenant: d.tenant,
			actor: ctx.principal,
			streamId: CD_STREAMS.compliance(campId),
			event: {
				type: CD_EVENTS.PostureRemediationProposed,
				data: body(PostureRemediationRecordSchema, record),
				meta: { remediationKey: key },
			},
			idempotencyKey: key,
		});
		if (appended?.fresh)
			emit(d.telemetry, [
				{
					name: POSTURE_METRIC.remediations,
					kind: "counter",
					value: 1,
					unit: "{remediation}",
					atMs: ctx.now(),
					attributes: {
						tenant: d.tenant,
						camp: campId,
						outcome: record.reasons[0]?.code ?? "",
						delta: record.deltaId !== "",
					},
				},
			]);
	}

	function fixReason(plan: RemediationPlan): ReasonRecord {
		return reason(
			POSTURE_REASON.fix,
			canonicalJson(
				plan.fixes.map((f) => ({ field: f.field, value: f.value })),
			),
			"Applied by the Camp's reconciler once the gate admits the posture-remediate Delta.",
			plan.resource,
		);
	}

	function terminalReason(plan: RemediationPlan): ReasonRecord | undefined {
		switch (plan.ownership) {
			case "conflict":
				return reason(
					POSTURE_REASON.ownershipConflict,
					`posture rule ${plan.rule} contradicts the Set-owned value of ${plan.resource} (${plan.conflicting.join(", ")}); nothing was mutated`,
					`Change the declaration of ${plan.resource} so it satisfies ${plan.rule}, or retire the rule; until then the gate refuses Deltas that keep the violation.`,
					plan.resource,
				);
			case "drift":
				return reason(
					POSTURE_REASON.drift,
					`${plan.resource} differs from its Set, which already satisfies ${plan.rule}`,
					"The Camp's reconciler re-applies the Set on its next drift pass; check its drift policy if this persists.",
					plan.resource,
				);
			case "retained":
				return reason(
					POSTURE_REASON.retained,
					`a fix field of ${plan.rule} is retained by a target-side controller on ${plan.resource}`,
					"Change the controller's configuration, or drop the field from hobo.cd/retain.",
					plan.resource,
				);
			case "no-fix":
				return reason(
					POSTURE_REASON.noFix,
					`${plan.rule} declares no fix`,
					"Add literal fix values to the rule, or bind it inform.",
					plan.resource,
				);
			case "set-unavailable":
				return reason(
					POSTURE_REASON.setUnavailable,
					`the current Set of the Camp could not be read, so ownership of ${plan.resource} is unknown`,
					"Check the desired-state store and the resolved-set blob; posture retries on the next evaluation.",
					plan.resource,
				);
			default:
				return undefined;
		}
	}

	async function remediate(
		campId: CampId,
		railDigest: string,
		plans: readonly RemediationPlan[],
		set: SetRecord | undefined,
		resolved: ResolvedDeploymentSet | undefined,
		observation: ReconcileObservationRecord,
		evaluatedAt: string,
		ctx: CdContext,
	): Promise<void> {
		const view = projection(campId);
		const setId = set?.setId ?? "";
		const keyOf = (plan: RemediationPlan) =>
			`remediation:${plan.rule}:${plan.resource}:${setId}:${plan.ownership}:${sha256Hex(canonicalJson(plan.fixes.map((f) => [f.field, f.value])))}`;
		const repair: RemediationPlan[] = [];
		for (const plan of plans) {
			const key = keyOf(plan);
			if (view.remediationKeys.has(key)) continue;
			const terminal = terminalReason(plan);
			if (terminal) {
				// set-unavailable is transient: retry on the next evaluation.
				const recordKey =
					plan.ownership === "set-unavailable" ? `${key}:${evaluatedAt}` : key;
				await appendRemediation(
					campId,
					remediationRecord(campId, plan, [terminal]),
					recordKey,
					ctx,
				);
				continue;
			}
			repair.push(plan);
		}
		if (repair.length === 0 || !set || !resolved) return;
		const deltaId = `delta_posture_${sha256Hex(`${campId}|${setId}|${repair.map(keyOf).sort().join("|")}`).slice(0, 24)}`;
		const decision = await d.authorizer.authorize(
			"posture.enforce",
			{
				campId,
				railDigest,
				deltaId,
				rules: repair.map((p) => p.rule),
				resources: repair.map((p) => p.resource),
			},
			ctx,
		);
		if (!decision.ok) {
			for (const plan of repair)
				await appendRemediation(
					campId,
					remediationRecord(campId, plan, [
						reason(
							POSTURE_REASON.enforceUnauthorized,
							`posture.enforce was refused for ${plan.rule} on ${plan.resource}`,
							"Grant posture.enforce to the posture service principal, or bind the pack inform.",
							plan.resource,
						),
						...decision.reasons,
					]),
					`${keyOf(plan)}:${evaluatedAt}`,
					ctx,
				);
			return;
		}
		const changes = repair.map((plan) => {
			const match = resolved.plan.resources.find(
				(r) => r.name === plan.resource,
			);
			const before =
				observation.resources.find((r) => r.resource === plan.resource)
					?.attributes ?? {};
			return {
				resource: plan.resource,
				kind: ChangeKind.UPDATE,
				provider: match?.provider ?? "",
				productId: match?.productId ?? "",
				beforeHash: digestOf(
					Object.fromEntries(
						plan.fixes.map((f) => [f.field, before[f.field] ?? null]),
					),
				),
				afterHash: digestOf(
					Object.fromEntries(plan.fixes.map((f) => [f.field, f.value])),
				),
			};
		});
		const delta = create(DeltaRecordSchema, {
			schemaVersion: DELTA_SCHEMA,
			deltaId,
			campId,
			baseSetId: set.setId,
			freightId: set.freightId,
			changes,
			openedBy: principalName(ctx.principal),
			proposal: decision.value.proposalOnly,
			openedAt: evaluatedAt,
			intent: "posture-remediate",
		});
		const opened = await d.desired.open(delta, ctx);
		for (const plan of repair) {
			if (opened.ok) {
				await appendRemediation(
					campId,
					remediationRecord(
						campId,
						plan,
						[
							reason(
								POSTURE_REASON.proposed,
								`posture-remediate Delta ${deltaId} proposes the fix for ${plan.rule} on ${plan.resource}`,
								"The gate decides the Delta; the Camp's reconciler applies it. Nothing changes the target before that.",
								plan.resource,
							),
							fixReason(plan),
						],
						deltaId,
					),
					keyOf(plan),
					ctx,
				);
			} else {
				await appendRemediation(
					campId,
					remediationRecord(campId, plan, [
						reason(
							POSTURE_REASON.deltaRefused,
							`the posture-remediate Delta for ${plan.rule} was refused`,
							"Posture retries on its next evaluation; see the following reasons.",
							plan.resource,
						),
						...opened.reasons,
					]),
					`${keyOf(plan)}:${evaluatedAt}`,
					ctx,
				);
			}
		}
	}

	async function evaluateTarget(
		view: CampView,
		target: Target,
		observed: Observed,
		ctx: CdContext,
	): Promise<void> {
		const campId = view.topology.campId;
		const nowMs = ctx.now();
		const earlier = projection(campId).compliance.filter(
			(c) =>
				c.record.railDigest === target.railDigest &&
				c.record.candidate === target.candidate,
		);
		const prev = earlier.at(-1);
		if (prev && nowMs - prev.atMs < intervalMs(target.rail, prev.record.state))
			return;
		const evaluatedAt = iso(nowMs);
		let packs: PosturePack[] | undefined;
		if (!target.rail) {
			emit(d.telemetry, [
				{
					name: POSTURE_METRIC.packInvalid,
					kind: "counter",
					value: 1,
					unit: "{evaluation}",
					atMs: nowMs,
					attributes: {
						tenant: d.tenant,
						camp: campId,
						reason: POSTURE_REASON.candidateUnresolved,
					},
				},
			]);
		} else {
			const loaded = await loadPacks(
				[...new Set(target.rail.posture.map((p) => p.pack))].sort(),
			);
			packs = loaded.packs;
			if (loaded.problem)
				emit(d.telemetry, [
					{
						name: POSTURE_METRIC.packInvalid,
						kind: "counter",
						value: 1,
						unit: "{evaluation}",
						atMs: nowMs,
						attributes: {
							tenant: d.tenant,
							camp: campId,
							reason: POSTURE_REASON.packInvalid,
						},
					},
				]);
		}
		const modes = resolvePostureBindings(
			(target.rail?.posture ?? []).map((p) => ({
				pack: p.pack,
				remediation: modeOf(p.remediation),
			})),
		);
		const { set, resolved } = target.candidate ? {} : await currentSet(campId);
		const management = observeOnly(view)
			? CampManagement.OBSERVE_ONLY
			: CampManagement.MANAGED;
		const { record, remediations } = evaluateCamp({
			campId,
			railDigest: target.railDigest,
			candidate: target.candidate,
			packs,
			modes,
			observation: observed.record,
			position: observed.position.toString(),
			resolved,
			management,
			evaluatedAt,
		});
		const sequence = `${target.railDigest}:${target.candidate ? "candidate" : "enforced"}:${earlier.length}`;
		const observedEvent = await appendOnce({
			store: d.store,
			tenant: d.tenant,
			actor: ctx.principal,
			streamId: CD_STREAMS.compliance(campId),
			event: {
				type: CD_EVENTS.ComplianceObserved,
				data: body(ComplianceRecordSchema, record),
			},
			idempotencyKey: `observed:${sequence}`,
		});
		if (!observedEvent?.fresh) return;
		const changed = prev === undefined || prev.record.state !== record.state;
		if (changed) {
			await appendOnce({
				store: d.store,
				tenant: d.tenant,
				actor: ctx.principal,
				streamId: CD_STREAMS.compliance(campId),
				event: {
					type: CD_EVENTS.ComplianceChanged,
					data: body(ComplianceRecordSchema, record),
					meta: {
						from: prev ? (ComplianceState[prev.record.state] ?? "") : "",
					},
				},
				idempotencyKey: `changed:${sequence}`,
			});
			if (!target.candidate) {
				await d.inventory.observe(
					{
						campId,
						source: SignalSource.HEALTH_SOURCE,
						conditions: [
							create(CampConditionRecordSchema, {
								type: CampConditionType.POSTURE_COMPLIANT,
								status: conditionStatus(record.state),
								source: SignalSource.HEALTH_SOURCE,
								reason: `posture ${ComplianceState[record.state] ?? ""} against Rail ${target.railDigest}`,
								since: evaluatedAt,
							}),
						],
						claims: [],
					},
					ctx,
				);
			}
		}
		emit(d.telemetry, pointsFor(d.tenant, record, nowMs, changed));
		await read();
		if (remediations.length > 0)
			await remediate(
				campId,
				target.railDigest,
				remediations,
				set,
				resolved,
				observed.record,
				evaluatedAt,
				ctx,
			);
	}

	async function tickOnce(ctx: CdContext): Promise<void> {
		await read();
		const views = [...(await d.inventory.list())].sort((a, b) =>
			a.topology.campId < b.topology.campId
				? -1
				: a.topology.campId > b.topology.campId
					? 1
					: 0,
		);
		for (const view of views) {
			const campId = view.topology.campId;
			const list = await targets(campId);
			if (list.length === 0) continue;
			const observed = await latestObservation(campId);
			if (!observed) {
				emit(d.telemetry, [
					{
						name: POSTURE_METRIC.noObservation,
						kind: "counter",
						value: 1,
						unit: "{camp}",
						atMs: ctx.now(),
						attributes: { tenant: d.tenant, camp: campId },
					},
				]);
				continue;
			}
			for (const target of list)
				await evaluateTarget(view, target, observed, ctx);
		}
	}

	let ticking: Promise<void> | undefined;

	return {
		async tick(ctx) {
			while (ticking) await ticking;
			ticking = tickOnce(ctx).finally(() => {
				ticking = undefined;
			});
			return ticking;
		},

		async compliance(campId) {
			await read();
			return (camps.get(campId)?.compliance ?? []).map((c) => c.record);
		},

		async conflicts(campId) {
			await read();
			const latest = (camps.get(campId)?.compliance ?? [])
				.filter((c) => !c.record.candidate)
				.at(-1);
			return (latest?.record.findings ?? []).filter(
				(f) => f.ownershipConflict && f.state === ComplianceState.NONCOMPLIANT,
			);
		},

		async remediations(campId) {
			await read();
			return [...(camps.get(campId)?.remediations ?? [])];
		},

		async observeFields(campId) {
			const names = new Set<string>();
			for (const target of await targets(campId))
				for (const p of target.rail?.posture ?? []) names.add(p.pack);
			const loaded = await loadPacks([...names].sort());
			return loaded.packs ? packObserveFields(loaded.packs) : [];
		},

		async noncompliantRatio(input) {
			await read();
			return (camps.get(input.campId)?.compliance ?? [])
				.filter((c) => c.atMs >= input.fromMs && c.atMs <= input.toMs)
				.filter((c) =>
					input.railDigest === undefined
						? !c.record.candidate
						: c.record.railDigest === input.railDigest,
				)
				.map((c) => noncompliantRatio(c.record));
		},

		async shadowDivergence(input) {
			await read();
			const view = camps.get(input.campId);
			if (!view) return [];
			const samples: { atMs: number; value: number }[] = [];
			for (const s of view.shadow)
				if (
					s.record.candidateRailDigest === input.railDigest &&
					s.atMs >= input.fromMs &&
					s.atMs <= input.toMs
				)
					samples.push({ atMs: s.atMs, value: s.record.diverged ? 1 : 0 });
			// Each candidate evaluation is evidence the candidate was bound and observed: a zero sample.
			for (const c of view.compliance)
				if (
					c.record.candidate &&
					c.record.railDigest === input.railDigest &&
					c.atMs >= input.fromMs &&
					c.atMs <= input.toMs
				)
					samples.push({ atMs: c.atMs, value: 0 });
			return samples.sort((a, b) => a.atMs - b.atMs).map((s) => s.value);
		},
	};
}
