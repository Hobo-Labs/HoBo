// CampInventory (D19): an event-sourced actor per Camp on
// `cd-camp-inventory-<id>`, a Camp-set registry on `cd-campset-<name>`, and a
// canonical snapshot whose digest placement decisions record (I18).
//
// Commands: observe, taint, untaint, manage, defineSet, tick.
// Events:   camp.StatusChanged (full CampStatusRecord; the fold reads only
//           this), camp.Tainted / camp.Untainted / camp.ManagementChanged
//           (audit, appended atomically with the StatusChanged they explain),
//           campset.Defined (CampSetRecord).
// Projection: an in-memory per-Camp view caught up from the stream before
//           every command (CAS on the stream revision, retried on conflict),
//           so several Station replicas stay consistent.
import {
	create,
	type JsonObject,
	type JsonValue,
	toJson,
} from "@bufbuild/protobuf";
import type {
	EventEnvelope,
	EventInput,
	EventPosition,
	PrincipalRef,
} from "@hobo/core";
import {
	type CampClaimRecord,
	CampClaimRecordSchema,
	type CampConditionRecord,
	CampConditionRecordSchema,
	CampConditionType,
	CampManagement,
	type CampSetRecord,
	CampSetRecordSchema,
	type CampStatusRecord,
	CampStatusRecordSchema,
	ConditionStatus,
	type ReasonRecord,
	ReconcileObservationRecordSchema,
	type SelectorRecord,
	SignalSource,
	TaintEffect,
	type TaintRecord,
	TaintRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS } from "../events.js";
import type {
	CampId,
	CampInventory,
	CampTopology,
	CampView,
	CdAction,
	CdAuthorizer,
	CdBase,
	CdContext,
	DesiredStateReader,
	InventorySnapshot,
	OtelMetricPoint,
	Outcome,
	RailDeliveryReader,
	TelemetrySink,
	TopologyReader,
} from "../ports.js";
import {
	type ContactState,
	defaultStatus,
	deriveStatus,
	isAutomaticNoPlace,
	negativeSignals,
	noRunPermitted,
	sameStatus,
	sortClaims,
	sortConditions,
	sortTaints,
} from "./derive.js";
import { jsonOf, objectAt, stringAt } from "./json.js";
import {
	isManagement,
	parseCampSet,
	parseClaims,
	parseConditions,
	parseTaint,
} from "./parse.js";
import { isEmptySelector, matchesSelector } from "./selector.js";
import {
	body,
	decode,
	emit,
	isConflict,
	iso,
	parseTime,
	principalName,
	reason,
	refuse,
	sha256Digest,
} from "./support.js";

export type CampInventoryDeps = CdBase & {
	readonly topology: TopologyReader;
	readonly rails: RailDeliveryReader;
	readonly desired: DesiredStateReader;
	readonly authorizer: CdAuthorizer;
	readonly telemetry: TelemetrySink;
};

/** Reconcile status events the Station appends on `cd-camp-status-<id>`: each is Station-observed contact. */
const CONTACT_EVENTS: ReadonlySet<string> = new Set([
	CD_EVENTS.ReconcileStarted,
	CD_EVENTS.StatusObserved,
	CD_EVENTS.Converged,
	CD_EVENTS.ReconcileBlocked,
]);
const STATUS_PREFIX = CD_STREAMS.campStatus("");
const CREDENTIAL_EXPIRY = /^expires-at:(.+)$/u;
const MAX_RETRIES = 4;

type CampState = {
	status: CampStatusRecord | undefined;
	seq: number;
	contact: ContactState;
};

type Change = Readonly<{
	status: CampStatusRecord;
	contact: ContactState;
	audit: readonly EventInput[];
}>;

const CONTACT_FIELDS = [
	"lastContactMs",
	"unreachableReportedMs",
	"lastLeaseMs",
	"leaseLostMs",
	"credentialExpiresMs",
	"credentialFailedMs",
	"credentialReportedMs",
] as const;

function contactMeta(contact: ContactState): JsonObject {
	const out: JsonObject = {};
	for (const field of CONTACT_FIELDS) {
		const value = contact[field];
		if (value !== undefined) out[field.replace(/Ms$/u, "At")] = iso(value);
	}
	return out;
}

function contactFromMeta<M>(meta: M): ContactState {
	const source = objectAt(jsonOf(meta), "contact");
	const out: { -readonly [K in keyof ContactState]: ContactState[K] } = {};
	for (const field of CONTACT_FIELDS) {
		const raw = stringAt(source, field.replace(/Ms$/u, "At"));
		const ms = raw === undefined ? undefined : parseTime(raw);
		if (ms !== undefined) out[field] = ms;
	}
	return out;
}

function topologyJson(topology: CampTopology): JsonValue {
	const labels: JsonObject = {};
	for (const key of Object.keys(topology.labels).sort())
		labels[key] = topology.labels[key] ?? "";
	return {
		campId: topology.campId,
		yardId: topology.yardId,
		stationId: topology.stationId,
		provider: topology.provider,
		regions: [...topology.regions].sort(),
		envType: topology.envType,
		labels,
		management: CampManagement[topology.management] ?? "UNSPECIFIED",
	};
}

function canonicalTopology(topology: CampTopology): CampTopology {
	return { ...topology, regions: [...topology.regions].sort() };
}

/** The view of a declared Camp with no recorded status: never contacted, hence NO_PLACE (fail closed). */
function pristine(topology: CampTopology): CampStatusRecord {
	const derived = deriveStatus({
		previous: defaultStatus(topology),
		topology,
		contact: {},
		failover: undefined,
		atMs: 0,
	});
	return create(CampStatusRecordSchema, {
		...derived,
		conditions: derived.conditions.map((condition) =>
			create(CampConditionRecordSchema, { ...condition, since: "" }),
		),
		taints: derived.taints.map((taint) =>
			create(TaintRecordSchema, { ...taint, addedAt: "" }),
		),
		updatedAt: "",
	});
}

function taintKey(taint: TaintRecord): string {
	return `${taint.effect}/${taint.key}`;
}

function taintAudit(
	before: CampStatusRecord | undefined,
	after: CampStatusRecord,
): EventInput[] {
	const prior = new Map(
		(before?.taints ?? []).map((taint) => [taintKey(taint), taint]),
	);
	const next = new Map(after.taints.map((taint) => [taintKey(taint), taint]));
	const events: EventInput[] = [];
	for (const [key, taint] of next) {
		const old = prior.get(key);
		if (
			old === undefined ||
			old.value !== taint.value ||
			old.reason !== taint.reason
		) {
			events.push({
				type: CD_EVENTS.CampTainted,
				data: body(TaintRecordSchema, taint),
			});
		}
	}
	for (const [key, taint] of prior) {
		if (!next.has(key))
			events.push({
				type: CD_EVENTS.CampUntainted,
				data: body(TaintRecordSchema, taint),
			});
	}
	return events;
}

function mergeClaims(
	existing: readonly CampClaimRecord[],
	incoming: readonly CampClaimRecord[],
	reportedBy: string,
	observedAt: string,
): CampClaimRecord[] {
	const byName = new Map(existing.map((claim) => [claim.name, claim]));
	for (const claim of incoming) {
		const before = byName.get(claim.name);
		if (before !== undefined && before.value === claim.value) continue;
		byName.set(
			claim.name,
			create(CampClaimRecordSchema, {
				name: claim.name,
				value: claim.value,
				reportedBy,
				observedAt,
			}),
		);
	}
	return sortClaims([...byName.values()]);
}

function proposalRefusal(action: CdAction): ReasonRecord {
	return reason(
		"proposal-only",
		`${action} by this principal is proposal-only`,
		"have a human operator or a granted service principal run the command",
		action,
	);
}

function fenceTokenOf<D>(data: D): string {
	const observation = decode(ReconcileObservationRecordSchema, data);
	if (observation !== undefined) return observation.fenceToken;
	const json = jsonOf(data);
	return stringAt(json, "fenceToken") ?? stringAt(json, "fence_token") ?? "";
}

export function createCampInventory(d: CampInventoryDeps): CampInventory {
	const camps = new Map<string, CampState>();
	const sets = new Map<string, CampSetRecord>();
	let setsCursor: EventPosition | undefined;
	let scanCursor: EventPosition | undefined;
	let scanReady = false;

	function applyEvent(state: CampState, event: EventEnvelope): void {
		state.seq = event.seq;
		if (event.type !== CD_EVENTS.CampStatusChanged) return;
		const status = decode(CampStatusRecordSchema, event.data);
		if (status === undefined) return;
		state.status = status;
		state.contact = contactFromMeta(event.meta);
	}

	async function load(campId: string): Promise<CampState> {
		const state = camps.get(campId) ?? {
			status: undefined,
			seq: 0,
			contact: {},
		};
		for await (const event of d.store.read(
			CD_STREAMS.campInventory(campId),
			state.seq,
		))
			applyEvent(state, event);
		camps.set(campId, state);
		return state;
	}

	async function loadSets(): Promise<void> {
		const options =
			setsCursor === undefined
				? { filter: { type: CD_EVENTS.CampSetDefined }, tenant: d.tenant }
				: {
						after: setsCursor,
						filter: { type: CD_EVENTS.CampSetDefined },
						tenant: d.tenant,
					};
		for await (const entry of d.store.readAll(options)) {
			setsCursor = entry.position;
			const set = decode(CampSetRecordSchema, entry.event.data);
			if (set !== undefined && set.name !== "") sets.set(set.name, set);
		}
	}

	async function commit(
		campId: CampId,
		actor: PrincipalRef,
		atMs: number,
		compute: (
			state: CampState,
			topology: CampTopology | undefined,
		) => Promise<Change | ReasonRecord[]>,
		known?: CampTopology,
	): Promise<Outcome<CampStatusRecord>> {
		const topology = known ?? (await d.topology.camp(campId));
		for (let attempt = 0; ; attempt += 1) {
			const state = await load(campId);
			const before = state.status;
			const change = await compute(state, topology);
			if (Array.isArray(change)) return refuse(...change);
			const changed =
				before === undefined || !sameStatus(before, change.status);
			if (!changed) {
				state.contact = change.contact;
				return { ok: true, value: before };
			}
			const status = create(CampStatusRecordSchema, {
				...change.status,
				updatedAt: iso(atMs),
			});
			const events: EventInput[] = [
				...change.audit,
				...taintAudit(before, status),
				{
					type: CD_EVENTS.CampStatusChanged,
					data: body(CampStatusRecordSchema, status),
					meta: { contact: contactMeta(change.contact) },
				},
			];
			try {
				const result = await d.store.append(
					CD_STREAMS.campInventory(campId),
					events,
					{
						expectedSeq: state.seq,
						actor,
						tenant: d.tenant,
					},
				);
				const last = result.appended.at(-1);
				if (last !== undefined) state.seq = last.seq;
				state.status = status;
				state.contact = change.contact;
				emitChange(before, status, atMs);
				return { ok: true, value: status };
			} catch (error) {
				if (!isConflict(error) || attempt >= MAX_RETRIES) throw error;
			}
		}
	}

	function emitChange(
		before: CampStatusRecord | undefined,
		after: CampStatusRecord,
		atMs: number,
	): void {
		const prior = new Set((before?.taints ?? []).map(taintKey));
		const next = new Set(after.taints.map(taintKey));
		const points: OtelMetricPoint[] = [
			{
				name: "hobo.cd.inventory.status_changes",
				kind: "counter",
				value: 1,
				unit: "{change}",
				atMs,
				attributes: {
					management: CampManagement[after.management] ?? "UNSPECIFIED",
				},
			},
		];
		for (const taint of after.taints) {
			if (!prior.has(taintKey(taint))) {
				points.push({
					name: "hobo.cd.inventory.taints",
					kind: "counter",
					value: 1,
					unit: "{taint}",
					atMs,
					attributes: {
						effect: TaintEffect[taint.effect] ?? "",
						key: taint.key,
						change: "added",
					},
				});
			}
		}
		for (const taint of before?.taints ?? []) {
			if (!next.has(taintKey(taint))) {
				points.push({
					name: "hobo.cd.inventory.taints",
					kind: "counter",
					value: 1,
					unit: "{taint}",
					atMs,
					attributes: {
						effect: TaintEffect[taint.effect] ?? "",
						key: taint.key,
						change: "cleared",
					},
				});
			}
		}
		emit(d.telemetry, points);
	}

	function baseStatus(
		state: CampState,
		topology: CampTopology | undefined,
		campId: string,
	): CampStatusRecord {
		if (state.status !== undefined) return state.status;
		return topology !== undefined
			? defaultStatus(topology)
			: create(CampStatusRecordSchema, { campId });
	}

	async function failoverFor(
		campId: CampId,
		conditions: readonly CampConditionRecord[],
	) {
		if (!negativeSignals(conditions).has(SignalSource.STATION))
			return undefined;
		return (await d.rails.forCamp(campId))?.failover;
	}

	async function rederive(
		campId: CampId,
		status: CampStatusRecord,
		topology: CampTopology | undefined,
		contact: ContactState,
		atMs: number,
	): Promise<CampStatusRecord> {
		const first = deriveStatus({
			previous: status,
			topology,
			contact,
			failover: undefined,
			atMs,
		});
		const failover = await failoverFor(campId, first.conditions);
		return failover === undefined
			? first
			: deriveStatus({ previous: status, topology, contact, failover, atMs });
	}

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

	function membersOf(set: CampSetRecord, topology: CampTopology): boolean {
		if (set.campIds.includes(topology.campId)) return true;
		return (
			!isEmptySelector(set.selector) && matchesSelector(set.selector, topology)
		);
	}

	async function view(topology: CampTopology): Promise<CampView> {
		const state = await load(topology.campId);
		return {
			topology: canonicalTopology(topology),
			status: state.status ?? pristine(topology),
		};
	}

	async function scan(atMs: number): Promise<Set<string>> {
		const active = new Set<string>();
		if (!scanReady) {
			// Cold start: activity already in the journal is not contact *now*;
			// recorded contact comes from the last StatusChanged meta instead.
			for await (const entry of d.store.readAll({ tenant: d.tenant }))
				scanCursor = entry.position;
			scanReady = true;
			return active;
		}
		const options =
			scanCursor === undefined
				? { tenant: d.tenant }
				: { after: scanCursor, tenant: d.tenant };
		for await (const entry of d.store.readAll(options)) {
			scanCursor = entry.position;
			const event = entry.event;
			if (
				!CONTACT_EVENTS.has(event.type) ||
				!event.streamId.startsWith(STATUS_PREFIX)
			)
				continue;
			const campId = event.streamId.slice(STATUS_PREFIX.length);
			if (campId === "") continue;
			const state = await load(campId);
			state.contact =
				fenceTokenOf(event.data) === ""
					? { ...state.contact, lastContactMs: atMs }
					: { ...state.contact, lastContactMs: atMs, lastLeaseMs: atMs };
			active.add(campId);
		}
		return active;
	}

	const inventory: CampInventory = {
		async status(campId) {
			const state = await load(campId);
			if (state.status !== undefined) return state.status;
			const topology = await d.topology.camp(campId);
			return topology === undefined ? undefined : pristine(topology);
		},

		async list(query) {
			const all = await d.topology.camps();
			let chosen: readonly CampTopology[] = all;
			if (query?.campSets !== undefined) {
				await loadSets();
				const wanted = query.campSets
					.map((name) => sets.get(name))
					.filter((set) => set !== undefined);
				chosen = chosen.filter((topology) =>
					wanted.some((set) => membersOf(set, topology)),
				);
			}
			if (query?.selector !== undefined) {
				const selector: SelectorRecord = query.selector;
				chosen = chosen.filter((topology) =>
					matchesSelector(selector, topology),
				);
			}
			const sorted = [...chosen].sort((a, b) =>
				a.campId < b.campId ? -1 : a.campId > b.campId ? 1 : 0,
			);
			return Promise.all(sorted.map(view));
		},

		async observe(input, ctx) {
			const atMs = ctx.now();
			const source = input.source;
			if (
				source === SignalSource.UNSPECIFIED ||
				SignalSource[source] === undefined
			) {
				return refuse(
					reason(
						"source-invalid",
						"observation source is unspecified",
						"report as station, reconciler, health-source or operator",
						"source",
					),
				);
			}
			if (
				ctx.principal.kind === "agent" &&
				source !== SignalSource.RECONCILER
			) {
				return refuse(
					reason(
						"source-not-permitted",
						`an agent principal cannot report as ${SignalSource[source]}`,
						"agents report as RECONCILER; Station, health-source and operator signals come from those principals",
						"source",
					),
				);
			}
			if (source === SignalSource.OPERATOR && ctx.principal.kind !== "user") {
				return refuse(
					reason(
						"source-not-permitted",
						"only a human operator reports as OPERATOR",
						"report as STATION or HEALTH_SOURCE",
						"source",
					),
				);
			}
			const conditions = parseConditions(input.conditions);
			if (!conditions.ok) return conditions;
			const claims = parseClaims(input.claims);
			if (!claims.ok) return claims;
			const reporter = principalName(ctx.principal);
			const result = await commit(
				input.campId,
				ctx.principal,
				atMs,
				async (state, topology) => {
					if (topology === undefined) {
						return [
							reason(
								"camp-unknown",
								`Camp ${input.campId} is not declared`,
								"declare the Camp in its Yard topology first",
								input.campId,
							),
						];
					}
					let contact: ContactState = { ...state.contact };
					const previous = baseStatus(state, topology, input.campId);
					const kept = new Map(
						previous.conditions.map((condition) => [
							`${condition.type}/${condition.source}`,
							condition,
						]),
					);
					for (const condition of conditions.value) {
						if (source === SignalSource.STATION) {
							contact = stationReport(contact, condition, atMs);
							if (
								condition.type === CampConditionType.REACHABLE ||
								condition.type === CampConditionType.LEASED ||
								condition.type === CampConditionType.CREDENTIAL_VALID
							)
								continue;
						}
						const key = `${condition.type}/${source}`;
						const before = kept.get(key);
						kept.set(
							key,
							create(CampConditionRecordSchema, {
								type: condition.type,
								status: condition.status,
								source,
								reason: condition.reason,
								since:
									before !== undefined && before.status === condition.status
										? before.since
										: iso(atMs),
							}),
						);
					}
					const merged = create(CampStatusRecordSchema, {
						...previous,
						conditions: sortConditions([...kept.values()]),
						claims: mergeClaims(
							previous.claims,
							claims.value,
							reporter,
							iso(atMs),
						),
					});
					const status = await rederive(
						input.campId,
						merged,
						topology,
						contact,
						atMs,
					);
					return { status, contact, audit: [] };
				},
			);
			return result;
		},

		async taint(input, ctx) {
			const atMs = ctx.now();
			const parsed = parseTaint(input.taint);
			if (!parsed.ok) return parsed;
			const taint = parsed.value;
			if (taint.effect === TaintEffect.NO_RUN) {
				if (taint.source === SignalSource.RECONCILER) {
					return refuse(noRunRefusal("an agent self-report never adds NO_RUN"));
				}
				if (
					taint.source === SignalSource.OPERATOR &&
					ctx.principal.kind !== "user"
				) {
					return refuse(
						noRunRefusal("an OPERATOR NO_RUN needs a human operator principal"),
					);
				}
			}
			const denied = await authorize(
				"camp.taint",
				{
					campId: input.campId,
					key: taint.key,
					effect: TaintEffect[taint.effect] ?? "",
				},
				ctx,
			);
			if (denied !== undefined) return refuse(...denied);
			return commit(
				input.campId,
				ctx.principal,
				atMs,
				async (state, topology) => {
					if (topology === undefined && state.status === undefined) {
						return [
							reason(
								"camp-unknown",
								`Camp ${input.campId} is not declared`,
								"declare the Camp in its Yard topology first",
								input.campId,
							),
						];
					}
					const previous = baseStatus(state, topology, input.campId);
					if (
						taint.effect === TaintEffect.NO_RUN &&
						taint.source !== SignalSource.OPERATOR
					) {
						const failover = (await d.rails.forCamp(input.campId))?.failover;
						if (!noRunPermitted(previous.conditions, failover)) {
							return [
								noRunRefusal(
									`the Rail rule needs failover.automatic and ${failover?.requiredSignals || CD_DEFAULTS.taintRequiredSignals} independent negative signals, one Station-observed`,
								),
							];
						}
					}
					const record = create(TaintRecordSchema, {
						...taint,
						addedBy: principalName(ctx.principal),
						addedAt:
							previous.taints.find(
								(t) =>
									t.key === taint.key &&
									t.effect === taint.effect &&
									t.value === taint.value,
							)?.addedAt || iso(atMs),
					});
					const taints = previous.taints.filter(
						(t) => !(t.key === taint.key && t.effect === taint.effect),
					);
					const next = create(CampStatusRecordSchema, {
						...previous,
						taints: sortTaints([...taints, record]),
					});
					const status = await rederive(
						input.campId,
						next,
						topology,
						state.contact,
						atMs,
					);
					return { status, contact: state.contact, audit: [] };
				},
			);
		},

		async untaint(input, ctx) {
			const atMs = ctx.now();
			if (
				input.effect === TaintEffect.NO_PLACE &&
				isAutomaticNoPlace(input.key)
			) {
				return refuse(
					reason(
						"taint-automatic",
						`${input.key} is an automatic NO_PLACE taint`,
						"fix the underlying condition (contact, lease, credential or claims); it clears on the next tick",
						input.key,
					),
				);
			}
			const denied = await authorize(
				"camp.untaint",
				{
					campId: input.campId,
					key: input.key,
					effect: TaintEffect[input.effect] ?? "",
				},
				ctx,
			);
			if (denied !== undefined) return refuse(...denied);
			return commit(
				input.campId,
				ctx.principal,
				atMs,
				async (state, topology) => {
					const previous = baseStatus(state, topology, input.campId);
					const taints = previous.taints.filter(
						(t) => !(t.key === input.key && t.effect === input.effect),
					);
					const next = create(CampStatusRecordSchema, { ...previous, taints });
					const status = await rederive(
						input.campId,
						next,
						topology,
						state.contact,
						atMs,
					);
					return { status, contact: state.contact, audit: [] };
				},
			);
		},

		async manage(input, ctx) {
			const atMs = ctx.now();
			if (!isManagement(input.management)) {
				return refuse(
					reason(
						"management-invalid",
						"management must be MANAGED or OBSERVE_ONLY",
						"set management",
						"management",
					),
				);
			}
			const denied = await authorize(
				"camp.manage",
				{
					campId: input.campId,
					management: CampManagement[input.management] ?? "",
				},
				ctx,
			);
			if (denied !== undefined) return refuse(...denied);
			return commit(
				input.campId,
				ctx.principal,
				atMs,
				async (state, topology) => {
					if (topology === undefined && state.status === undefined) {
						return [
							reason(
								"camp-unknown",
								`Camp ${input.campId} is not declared`,
								"declare the Camp in its Yard topology first",
								input.campId,
							),
						];
					}
					const previous = baseStatus(state, topology, input.campId);
					const next = create(CampStatusRecordSchema, {
						...previous,
						management: input.management,
					});
					const status = await rederive(
						input.campId,
						next,
						topology,
						state.contact,
						atMs,
					);
					const audit: EventInput[] =
						previous.management === input.management
							? []
							: [
									{
										type: CD_EVENTS.CampManagementChanged,
										data: body(
											CampStatusRecordSchema,
											create(CampStatusRecordSchema, {
												campId: input.campId,
												management: input.management,
											}),
										),
									},
								];
					return { status, contact: state.contact, audit };
				},
			);
		},

		async defineSet(set, ctx) {
			const parsed = parseCampSet(set);
			if (!parsed.ok) return parsed;
			const denied = await authorize(
				"campset.define",
				{ name: parsed.value.name },
				ctx,
			);
			if (denied !== undefined) return refuse(...denied);
			const record = create(CampSetRecordSchema, {
				...parsed.value,
				definedBy: principalName(ctx.principal),
			});
			const stream = CD_STREAMS.campSet(record.name);
			for (let attempt = 0; ; attempt += 1) {
				let seq = 0;
				let current: CampSetRecord | undefined;
				for await (const event of d.store.read(stream)) {
					seq = event.seq;
					if (event.type === CD_EVENTS.CampSetDefined)
						current = decode(CampSetRecordSchema, event.data) ?? current;
				}
				const sameDefinition = (a: CampSetRecord, b: CampSetRecord) =>
					sha256Digest(toJson(CampSetRecordSchema, { ...a, definedBy: "" })) ===
					sha256Digest(toJson(CampSetRecordSchema, { ...b, definedBy: "" }));
				if (current !== undefined && sameDefinition(current, record)) {
					sets.set(current.name, current);
					return { ok: true, value: current };
				}
				try {
					await d.store.append(
						stream,
						[
							{
								type: CD_EVENTS.CampSetDefined,
								data: body(CampSetRecordSchema, record),
							},
						],
						{
							expectedSeq: seq,
							actor: ctx.principal,
							tenant: d.tenant,
						},
					);
					sets.set(record.name, record);
					emit(d.telemetry, [
						{
							name: "hobo.cd.inventory.campsets_defined",
							kind: "counter",
							value: 1,
							unit: "{set}",
							atMs: ctx.now(),
							attributes: { set: record.name },
						},
					]);
					return { ok: true, value: record };
				} catch (error) {
					if (!isConflict(error) || attempt >= MAX_RETRIES) throw error;
				}
			}
		},

		async sets() {
			await loadSets();
			return [...sets.values()].sort((a, b) =>
				a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
			);
		},

		async snapshot(campSets) {
			await loadSets();
			const names = [...new Set(campSets)].sort();
			const chosen = names
				.map((name) => sets.get(name))
				.filter((set) => set !== undefined);
			const all = await d.topology.camps();
			const members = all
				.filter((topology) => chosen.some((set) => membersOf(set, topology)))
				.sort((a, b) =>
					a.campId < b.campId ? -1 : a.campId > b.campId ? 1 : 0,
				);
			const camps = await Promise.all(members.map(view));
			const digest = sha256Digest({
				campSets: names,
				sets: chosen.map((set) => toJson(CampSetRecordSchema, set)),
				camps: camps.map((camp) => ({
					topology: topologyJson(camp.topology),
					status: toJson(CampStatusRecordSchema, camp.status),
				})),
			});
			const snapshot: InventorySnapshot = { digest, camps };
			return snapshot;
		},

		async tick(ctx) {
			const atMs = ctx.now();
			const active = await scan(atMs);
			const topologies = await d.topology.camps();
			let noPlace = 0;
			let noRun = 0;
			for (const topology of topologies) {
				const campId = topology.campId;
				let observation: Awaited<ReturnType<DesiredStateReader["status"]>>;
				if (active.has(campId)) observation = await d.desired.status(campId);
				const result = await commit(
					campId,
					ctx.principal,
					atMs,
					async (state) => {
						const previous = baseStatus(state, topology, campId);
						const merged =
							observation !== undefined && observation.claims.length > 0
								? create(CampStatusRecordSchema, {
										...previous,
										claims: mergeClaims(
											previous.claims,
											observation.claims,
											`reconciler:${observation.reconcilerId}`,
											iso(atMs),
										),
									})
								: previous;
						const status = await rederive(
							campId,
							merged,
							topology,
							state.contact,
							atMs,
						);
						return { status, contact: state.contact, audit: [] };
					},
					topology,
				);
				if (result.ok) {
					if (
						result.value.taints.some((t) => t.effect === TaintEffect.NO_PLACE)
					)
						noPlace += 1;
					if (result.value.taints.some((t) => t.effect === TaintEffect.NO_RUN))
						noRun += 1;
				}
			}
			emit(d.telemetry, [
				{
					name: "hobo.cd.inventory.camps",
					kind: "gauge",
					value: topologies.length,
					unit: "{camp}",
					atMs,
					attributes: { taint: "any" },
				},
				{
					name: "hobo.cd.inventory.camps",
					kind: "gauge",
					value: noPlace,
					unit: "{camp}",
					atMs,
					attributes: { taint: "NO_PLACE" },
				},
				{
					name: "hobo.cd.inventory.camps",
					kind: "gauge",
					value: noRun,
					unit: "{camp}",
					atMs,
					attributes: { taint: "NO_RUN" },
				},
			]);
		},
	};
	return inventory;
}

function noRunRefusal(detail: string): ReasonRecord {
	return reason(
		"no-run-not-permitted",
		`NO_RUN refused: ${detail}`,
		"have an operator add NO_RUN, or enable the Rail failover rule and wait for independent Station-observed signals",
		"effect",
	);
}

/** Fold a Station-sourced report of a derived condition into contact state. */
function stationReport(
	contact: ContactState,
	condition: CampConditionRecord,
	atMs: number,
): ContactState {
	const truthy = condition.status === ConditionStatus.TRUE;
	const falsy = condition.status === ConditionStatus.FALSE;
	switch (condition.type) {
		case CampConditionType.REACHABLE:
			if (truthy) return { ...contact, lastContactMs: atMs };
			if (falsy) return { ...contact, unreachableReportedMs: atMs };
			return contact;
		case CampConditionType.LEASED:
			if (truthy) return { ...contact, lastContactMs: atMs, lastLeaseMs: atMs };
			if (falsy) return { ...contact, leaseLostMs: atMs };
			return contact;
		case CampConditionType.CREDENTIAL_VALID: {
			if (falsy)
				return {
					...contact,
					credentialReportedMs: atMs,
					credentialFailedMs: atMs,
				};
			if (!truthy) return contact;
			const match = CREDENTIAL_EXPIRY.exec(condition.reason);
			const reported =
				match?.[1] !== undefined ? parseTime(match[1]) : undefined;
			const expires = reported ?? atMs + CD_DEFAULTS.svidTtlMs;
			const { credentialFailedMs: _cleared, ...rest } = contact;
			return {
				...rest,
				credentialReportedMs: atMs,
				credentialExpiresMs: expires,
			};
		}
		default:
			return contact;
	}
}
