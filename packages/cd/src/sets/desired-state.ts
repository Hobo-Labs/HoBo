// createDesiredState (WP4): the command side (DeltaLedger) and the query side
// (DesiredStateReader) of per-Camp desired state.
//
// - Spec stream `cd-camp-<id>`: delta.Opened/Updated/Applied/Rejected and
//   set.Created, appended with expected-version CAS so one writer wins.
// - Status stream `cd-camp-status-<id>`: observations, written by reconcilers.
//   This module only reads it, so observations never contend with applies.
// - Resolved sets are content-addressed blobs in the ArtifactStore (B3); a Set
//   carries only the digest and size, and every read verifies them (B4).
import { create } from "@bufbuild/protobuf";
import {
	createResolvedDeploymentSet,
	type ResolvedDeploymentSet,
} from "@hobo/cloud";
import {
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	OptimisticSequenceConflictError,
	type ReadAllOptions,
} from "@hobo/core";
import {
	ArtifactKind,
	CampManagement,
	ChangeKind,
	type DeltaDecisionRecord,
	DeltaDecisionRecordSchema,
	type DeltaRecord,
	type ReasonRecord,
	type ReconcileObservationRecord,
	SetOrigin,
	type SetRecord,
	SetRecordSchema,
} from "../_generated/cd_pb.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	DELTA_SCHEMA,
	RESOLVED_SET_MEDIA_TYPE,
	SET_SCHEMA,
} from "../events.js";
import type {
	ArtifactStore,
	CampId,
	CdBase,
	CdContext,
	DeltaId,
	DeltaLedger,
	DesiredStateChange,
	DesiredStateReader,
	Digest,
	OtelAttributes,
	Outcome,
	PostureService,
	SetId,
	TelemetrySink,
} from "../ports.js";
import {
	checkDelta,
	checkSet,
	cloneDelta,
	encodeDecision,
	encodeDelta,
	encodeSet,
	type ParsedSet,
} from "./codec.js";
import { DesiredStateError, reason, refusalFrom, refuse } from "./errors.js";
import {
	applyCampSpecEvent,
	type CampSpecState,
	emptyCampSpec,
	foldCampSpec,
	foldCampStatus,
	foldManagement,
} from "./fold.js";
import { member, textMember } from "./json.js";
import {
	foldLegacyDeployment,
	LEGACY_EVENTS,
	type LegacyDeployment,
} from "./legacy.js";
import {
	type CanonicalResolvedSet,
	canonicalJson,
	decodeResolvedSetBlob,
	diffResolvedSets,
	encodeResolvedSetBlob,
	resourceNames,
	sha256Digest,
} from "./resolved-set.js";

export type DesiredStateDeps = CdBase & {
	readonly artifacts: ArtifactStore;
	/** Metrics sink (WP19). Failures to emit never fail a command. */
	readonly telemetry?: TelemetrySink;
	/** Attribute paths each Camp's posture packs need (D25); empty when absent. */
	readonly posture?: Pick<PostureService, "observeFields">;
	/** Fallback poll for cross-process writers while tailing `changes()`. */
	readonly pollIntervalMs?: number;
};

export type LegacyAdoption = Readonly<{
	adopted: readonly SetRecord[];
	/** Legacy deployments that could not be folded, with the reason. */
	skipped: readonly ReasonRecord[];
}>;

/**
 * The ports plus two operator surfaces. `get` is the intersection of
 * `DesiredStateReader.get(SetId)` and `DeltaLedger.get(DeltaId)`; Set ids are
 * always `set_<hex>` and Delta ids may never start with `set_`, so one
 * function serves both.
 */
export type DesiredState = DesiredStateReader &
	DeltaLedger &
	Readonly<{
		/**
		 * Fold legacy `deployment.*` estates into a current Set (SET_ORIGIN_LEGACY_FOLD)
		 * for every Camp that has no desired state yet. Idempotent.
		 */
		adoptLegacy(ctx: CdContext): Promise<LegacyAdoption>;
		/** The folded spec projection of one Camp (operator and test surface). */
		spec(campId: CampId): Promise<CampSpecState>;
	}>;

const MAX_ATTEMPTS = 3;
const CHANGE_TYPES: ReadonlySet<string> = new Set([
	CD_EVENTS.SetCreated,
	CD_EVENTS.PolicyBindingChanged,
	CD_EVENTS.CampManagementChanged,
]);

/** Catch-up read options: after the cursor, optionally one stream. */
function readOptions(
	after: EventPosition | undefined,
	streamId: string | undefined,
): ReadAllOptions {
	if (after !== undefined && streamId !== undefined)
		return { after, filter: { streamId } };
	if (after !== undefined) return { after };
	if (streamId !== undefined) return { filter: { streamId } };
	return {};
}

/** Camp ids are opaque, non-empty strings recorded by parsed records. */
function asCampId(value: string): CampId {
	// SAFETY: brand applied to a camp id taken from a parsed record.
	return value as CampId;
}

function isoAt(ms: number): string {
	return new Date(ms).toISOString();
}

function principalLabel(ctx: CdContext): string {
	return `${ctx.principal.kind}:${ctx.principal.id}`;
}

function setIdFor(parts: readonly string[]): string {
	return `set_${sha256Digest(canonicalJson(parts)).slice("sha256:".length, "sha256:".length + 32)}`;
}

function changeKey(change: { resource: string; kind: ChangeKind }): string {
	return `${change.kind}:${change.resource}`;
}

export function createDesiredState(d: DesiredStateDeps): DesiredState {
	const store: DurableEventStore = d.store;
	const deltaCamps = new Map<string, CampId>();
	const setCamps = new Map<string, CampId>();

	async function metric(
		name: string,
		value: number,
		attributes: OtelAttributes,
		kind: "counter" | "histogram" = "counter",
		unit = "1",
	): Promise<void> {
		if (!d.telemetry) return;
		try {
			await d.telemetry.metrics([
				{ name, kind, value, unit, atMs: d.now(), attributes },
			]);
		} catch {
			// Telemetry is best-effort; a collector outage never fails a delivery command.
		}
	}

	async function readStream(streamId: string): Promise<EventEnvelope[]> {
		const events: EventEnvelope[] = [];
		for await (const event of store.read(streamId)) events.push(event);
		return events;
	}

	async function spec(campId: CampId): Promise<CampSpecState> {
		return foldCampSpec(campId, await readStream(CD_STREAMS.campSpec(campId)));
	}

	async function append(
		campId: CampId,
		state: CampSpecState,
		events: EventInput[],
		ctx: CdContext,
	): Promise<void> {
		await store.append(CD_STREAMS.campSpec(campId), events, {
			expectedSeq: state.seq,
			actor: ctx.principal,
			tenant: d.tenant,
		});
	}

	/** The Camp a Delta or Set id was recorded on (ids are immutable, so hits are cached). */
	async function findCamp(
		type: string,
		idField: "deltaId" | "setId",
		id: string,
		cache: Map<string, CampId>,
	): Promise<CampId | undefined> {
		const cached = cache.get(id);
		if (cached !== undefined) return cached;
		for await (const { event } of store.readAll({ filter: { type } })) {
			const campId = textMember(event.data, "campId");
			if (member(event.data, idField) === id && campId !== undefined) {
				cache.set(id, asCampId(campId));
				return asCampId(campId);
			}
		}
		return undefined;
	}

	const campOfDelta = (deltaId: string) =>
		findCamp(CD_EVENTS.DeltaOpened, "deltaId", deltaId, deltaCamps);
	const campOfSet = (setId: string) =>
		findCamp(CD_EVENTS.SetCreated, "setId", setId, setCamps);

	async function resolved(set: SetRecord): Promise<CanonicalResolvedSet> {
		const attributes = { "hobo.cd.camp": set.campId };
		try {
			// SAFETY: a parsed Set carries a sha256 digest.
			const bytes = await d.artifacts.get(
				// SAFETY: a parsed Set carries a sha256:<64 hex> digest.
				set.resolvedSetDigest as Digest,
			);
			if (bytes === undefined) {
				throw new DesiredStateError(
					"resolved-set-missing",
					`resolved-set blob ${set.resolvedSetDigest} for ${set.setId} is not in the artifact store`,
					set.setId,
					`Restore blob ${set.resolvedSetDigest} into the artifact store (${d.artifacts.backend}) or re-apply the Set; nothing converges without it.`,
				);
			}
			const decoded = decodeResolvedSetBlob(bytes, {
				digest: set.resolvedSetDigest,
				size: Number(set.resolvedSetBytes),
			});
			if (
				decoded.contentHash !== set.contentHash ||
				decoded.campId !== set.campId
			) {
				throw new DesiredStateError(
					"resolved-set-invalid",
					`blob ${set.resolvedSetDigest} does not hold Set ${set.setId} (content ${decoded.contentHash})`,
					set.setId,
				);
			}
			return decoded;
		} catch (error) {
			if (error instanceof DesiredStateError) {
				await metric("hobo.cd.sets.resolved_set_verify_failures", 1, {
					...attributes,
					"hobo.cd.reason": error.code,
				});
			}
			throw error;
		}
	}

	/** Check a Delta's changes against the resources of its base Set. */
	async function checkChanges(
		delta: DeltaRecord,
		state: CampSpecState,
	): Promise<Outcome<true>> {
		if (delta.changes.length === 0) return { ok: true, value: true };
		let names: ReadonlySet<string>;
		try {
			names = resourceNames(
				state.current ? await resolved(state.current) : undefined,
			);
		} catch (error) {
			if (error instanceof DesiredStateError) return refusalFrom(error);
			throw error;
		}
		for (const change of delta.changes) {
			const present = names.has(change.resource);
			if (
				(change.kind === ChangeKind.ADD && present) ||
				(change.kind !== ChangeKind.ADD && !present)
			) {
				return refuse(
					"delta-absent-resource",
					`${ChangeKind[change.kind]} ${change.resource} against base ${state.current?.setId ?? "<none>"}`,
					change.resource,
				);
			}
		}
		return { ok: true, value: true };
	}

	function normalize(input: DeltaRecord, ctx: CdContext): Outcome<DeltaRecord> {
		const delta = cloneDelta(input);
		if (delta.schemaVersion === "") delta.schemaVersion = DELTA_SCHEMA;
		if (delta.openedAt === "") delta.openedAt = isoAt(ctx.now());
		if (delta.openedBy === "") delta.openedBy = principalLabel(ctx);
		try {
			return { ok: true, value: checkDelta(delta, "delta-invalid") };
		} catch (error) {
			if (error instanceof DesiredStateError) return refusalFrom(error);
			throw error;
		}
	}

	function sameIntent(a: DeltaRecord, b: DeltaRecord): boolean {
		const comparable = (delta: DeltaRecord) => {
			const copy = cloneDelta(delta);
			copy.openedAt = "";
			copy.openedBy = "";
			return canonicalJson(encodeDelta(copy));
		};
		return comparable(a) === comparable(b);
	}

	/** Run a spec-stream command, retrying when another writer moved the head. */
	async function withCas<T>(
		campId: CampId,
		attempt: (state: CampSpecState, conflicted: boolean) => Promise<Outcome<T>>,
	): Promise<Outcome<T>> {
		let conflicted = false;
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const state = await spec(campId);
			try {
				return await attempt(state, conflicted);
			} catch (error) {
				if (!(error instanceof OptimisticSequenceConflictError)) throw error;
				conflicted = true;
				await metric("hobo.cd.sets.apply_conflicts", 1, {
					"hobo.cd.camp": campId,
				});
			}
		}
		return refuse(
			"concurrent-apply",
			`spec stream of ${campId} kept moving after ${MAX_ATTEMPTS} attempts`,
			campId,
		);
	}

	const open: DeltaLedger["open"] = async (input, ctx) => {
		const normalized = normalize(input, ctx);
		if (!normalized.ok) return normalized;
		const delta = normalized.value;
		const campId = asCampId(delta.campId);
		const owner = await campOfDelta(delta.deltaId);
		if (owner !== undefined && owner !== campId) {
			return refuse(
				"delta-invalid",
				`delta ${delta.deltaId} already belongs to camp ${owner}`,
				delta.deltaId,
			);
		}
		return withCas(campId, async (state) => {
			const existing = state.deltas.get(delta.deltaId);
			if (existing) {
				if (existing.status === "open" && sameIntent(existing.record, delta))
					return { ok: true, value: existing.record };
				return refuse(
					"delta-not-open",
					`delta ${delta.deltaId} is already recorded (${existing.status})`,
					delta.deltaId,
				);
			}
			if (state.openDeltaId !== undefined) {
				return refuse(
					"delta-overlap",
					`camp ${campId} already has open delta ${state.openDeltaId}`,
					campId,
				);
			}
			const currentId = state.current?.setId ?? "";
			if (delta.baseSetId !== currentId) {
				return refuse(
					"delta-stale-base",
					`base ${delta.baseSetId || "<none>"} is not the current Set ${currentId || "<none>"}`,
					campId,
				);
			}
			const changes = await checkChanges(delta, state);
			if (!changes.ok) return changes;
			await append(
				campId,
				state,
				[{ type: CD_EVENTS.DeltaOpened, data: encodeDelta(delta) }],
				ctx,
			);
			deltaCamps.set(delta.deltaId, campId);
			await metric("hobo.cd.sets.deltas_opened", 1, {
				"hobo.cd.camp": campId,
				"hobo.cd.intent": delta.intent,
			});
			return { ok: true, value: delta };
		});
	};

	const update: DeltaLedger["update"] = async (input, ctx) => {
		const normalized = normalize(input, ctx);
		if (!normalized.ok) return normalized;
		const delta = normalized.value;
		const campId = await campOfDelta(delta.deltaId);
		if (campId === undefined)
			return refuse(
				"delta-not-found",
				`delta ${delta.deltaId} was never opened`,
				delta.deltaId,
			);
		if (campId !== delta.campId)
			return refuse(
				"delta-invalid",
				`delta ${delta.deltaId} belongs to camp ${campId}`,
				delta.deltaId,
			);
		return withCas(campId, async (state) => {
			const existing = state.deltas.get(delta.deltaId);
			if (!existing)
				return refuse(
					"delta-not-found",
					`delta ${delta.deltaId} is not on camp ${campId}`,
					delta.deltaId,
				);
			if (existing.status !== "open")
				return refuse(
					"delta-not-open",
					`delta ${delta.deltaId} is ${existing.status}`,
					delta.deltaId,
				);
			if (delta.baseSetId !== existing.record.baseSetId) {
				return refuse(
					"delta-stale-base",
					"an update cannot move a Delta to another base Set",
					delta.deltaId,
				);
			}
			const changes = await checkChanges(delta, state);
			if (!changes.ok) return changes;
			const record = cloneDelta(delta);
			record.openedAt = existing.record.openedAt;
			record.openedBy = existing.record.openedBy;
			await append(
				campId,
				state,
				[{ type: CD_EVENTS.DeltaUpdated, data: encodeDelta(record) }],
				ctx,
			);
			return { ok: true, value: checkDelta(record) };
		});
	};

	const apply: DeltaLedger["apply"] = async (input, ctx) => {
		const origin = input.origin;
		if (
			origin === SetOrigin.UNSPECIFIED ||
			origin === SetOrigin.LEGACY_FOLD ||
			SetOrigin[origin] === undefined
		) {
			return refuse(
				"set-origin-invalid",
				`origin ${SetOrigin[origin] ?? origin} cannot be applied`,
				input.deltaId,
			);
		}
		if (input.gateDecisionId === "") {
			return refuse(
				"gate-decision-missing",
				`delta ${input.deltaId} has no gate decision`,
				input.deltaId,
			);
		}
		const campId = await campOfDelta(input.deltaId);
		if (campId === undefined)
			return refuse(
				"delta-not-found",
				`delta ${input.deltaId} was never opened`,
				input.deltaId,
			);
		const attributes = {
			"hobo.cd.camp": campId,
			"hobo.cd.origin": SetOrigin[origin] ?? "",
		};

		const outcome = await withCas<SetRecord>(
			campId,
			async (state, conflicted) => {
				const entry = state.deltas.get(input.deltaId);
				if (!entry)
					return refuse(
						"delta-not-found",
						`delta ${input.deltaId} is not on camp ${campId}`,
						input.deltaId,
					);
				if (entry.status === "applied") {
					const setId = entry.decision?.setId ?? "";
					const set = state.sets.find((candidate) => candidate.setId === setId);
					if (set) return { ok: true, value: set };
					return refuse(
						"journal-invalid",
						`applied delta ${input.deltaId} names unknown Set ${setId}`,
						campId,
					);
				}
				if (entry.status === "rejected") {
					return conflicted
						? refuse(
								"concurrent-apply",
								`delta ${input.deltaId} was rejected by a concurrent writer`,
								campId,
							)
						: refuse(
								"delta-rejected",
								`delta ${input.deltaId} was rejected`,
								input.deltaId,
							);
				}
				const delta = entry.record;
				if (
					input.resolved.campId !== delta.campId ||
					input.resolved.tenant !== d.tenant
				) {
					return refuse(
						"resolved-set-camp-mismatch",
						`resolved set is for ${input.resolved.tenant}/${input.resolved.campId}, delta is for ${d.tenant}/${delta.campId}`,
						campId,
					);
				}
				let blob: ReturnType<typeof encodeResolvedSetBlob>;
				let base: CanonicalResolvedSet | undefined;
				try {
					blob = encodeResolvedSetBlob(input.resolved);
					base = state.current ? await resolved(state.current) : undefined;
				} catch (error) {
					if (error instanceof DesiredStateError) return refusalFrom(error);
					throw error;
				}
				if (delta.baseSetId !== (state.current?.setId ?? "")) {
					return refuse(
						"delta-stale-base",
						`camp ${campId} moved past base ${delta.baseSetId || "<none>"}`,
						campId,
					);
				}
				const computed = diffResolvedSets(base, blob.resolved)
					.map(changeKey)
					.sort();
				const declared = delta.changes.map(changeKey).sort();
				if (computed.join("|") !== declared.join("|")) {
					return refuse(
						"delta-diff-mismatch",
						`delta declares [${declared.join(", ")}], the resolved set changes [${computed.join(", ")}]`,
						input.deltaId,
					);
				}
				const decision = (setId: string): DeltaDecisionRecord =>
					create(DeltaDecisionRecordSchema, {
						deltaId: delta.deltaId,
						setId,
						gateDecisionId: input.gateDecisionId,
						decidedAt: isoAt(ctx.now()),
					});
				if (
					state.current &&
					state.current.contentHash === blob.resolved.contentHash
				) {
					// Empty Delta: an explicit no-op that mints no Set (delta-set-apply-reconcile).
					await append(
						campId,
						state,
						[
							{
								type: CD_EVENTS.DeltaApplied,
								data: encodeDecision(decision(state.current.setId)),
							},
						],
						ctx,
					);
					return { ok: true, value: state.current };
				}
				const ref = await d.artifacts.put(
					blob.bytes,
					{
						name: `resolved-set/${campId}/${delta.deltaId}`,
						kind: ArtifactKind.PACKAGE,
						mediaType: RESOLVED_SET_MEDIA_TYPE,
					},
					ctx,
				);
				if (
					ref.digest !== blob.digest ||
					(ref.sizeBytes !== 0n && ref.sizeBytes !== BigInt(blob.size))
				) {
					return refuse(
						"blob-digest-mismatch",
						`artifact store returned ${ref.digest} (${ref.sizeBytes} bytes) for ${blob.digest} (${blob.size} bytes)`,
						campId,
					);
				}
				const set = checkSet(
					create(SetRecordSchema, {
						schemaVersion: SET_SCHEMA,
						setId: setIdFor([
							d.tenant,
							campId,
							delta.deltaId,
							blob.resolved.contentHash,
						]),
						tenant: d.tenant,
						environment: blob.resolved.environment,
						campId,
						freightId: delta.freightId,
						planHash: blob.resolved.planHash,
						contentHash: blob.resolved.contentHash,
						predecessorSetId: state.current?.setId ?? "",
						gateDecisionId: input.gateDecisionId,
						origin,
						resolvedSetDigest: blob.digest,
						resolvedSetBytes: BigInt(blob.size),
						createdAt: isoAt(ctx.now()),
					}),
					"resolved-set-invalid",
				);
				await append(
					campId,
					state,
					[
						{
							type: CD_EVENTS.DeltaApplied,
							data: encodeDecision(decision(set.setId)),
						},
						{ type: CD_EVENTS.SetCreated, data: encodeSet(set) },
					],
					ctx,
				);
				setCamps.set(set.setId, campId);
				await metric(
					"hobo.cd.sets.resolved_set_bytes",
					blob.size,
					attributes,
					"histogram",
					"By",
				);
				return { ok: true, value: set };
			},
		);
		await metric(
			outcome.ok ? "hobo.cd.sets.deltas_applied" : "hobo.cd.sets.apply_refused",
			1,
			outcome.ok
				? attributes
				: { ...attributes, "hobo.cd.reason": outcome.reasons[0]?.code ?? "" },
		);
		return outcome;
	};

	const reject: DeltaLedger["reject"] = async (deltaId, reasons, ctx) => {
		const campId = await campOfDelta(deltaId);
		if (campId === undefined)
			throw new DesiredStateError(
				"delta-not-found",
				`delta ${deltaId} was never opened`,
				deltaId,
			);
		const outcome = await withCas<true>(campId, async (state) => {
			const entry = state.deltas.get(deltaId);
			if (!entry)
				throw new DesiredStateError(
					"delta-not-found",
					`delta ${deltaId} is not on camp ${campId}`,
					deltaId,
				);
			if (entry.status === "applied") {
				throw new DesiredStateError(
					"delta-already-applied",
					`delta ${deltaId} was applied as ${entry.decision?.setId ?? "?"}`,
					deltaId,
				);
			}
			if (entry.status === "rejected") return { ok: true, value: true };
			const decision = create(DeltaDecisionRecordSchema, {
				deltaId,
				reasons: [...reasons],
				decidedAt: isoAt(ctx.now()),
			});
			await append(
				campId,
				state,
				[{ type: CD_EVENTS.DeltaRejected, data: encodeDecision(decision) }],
				ctx,
			);
			await metric("hobo.cd.sets.deltas_rejected", 1, {
				"hobo.cd.camp": campId,
				"hobo.cd.reason": reasons[0]?.code ?? "",
			});
			return { ok: true, value: true };
		});
		if (!outcome.ok) {
			const first = outcome.reasons[0];
			throw new DesiredStateError(
				"concurrent-apply",
				first?.message ?? "reject did not land",
				deltaId,
			);
		}
	};

	/** One function serves both ports' `get`: Set ids are always `set_<hex>`, Delta ids never are. */
	function getById(setId: SetId): Promise<SetRecord | undefined>;
	function getById(deltaId: DeltaId): Promise<DeltaRecord | undefined>;
	function getById(
		id: SetId | DeltaId,
	): Promise<SetRecord | DeltaRecord | undefined> {
		// SAFETY: the set_ prefix is reserved for Set ids (checkDelta refuses it for Deltas).
		return id.startsWith("set_")
			? getSet(id as SetId)
			: getDelta(id as DeltaId);
	}

	async function getDelta(deltaId: DeltaId): Promise<DeltaRecord | undefined> {
		const campId = await campOfDelta(deltaId);
		if (campId === undefined) return undefined;
		return (await spec(campId)).deltas.get(deltaId)?.record;
	}

	async function getSet(setId: SetId): Promise<SetRecord | undefined> {
		const campId = await campOfSet(setId);
		if (campId === undefined) return undefined;
		return (await spec(campId)).sets.find((set) => set.setId === setId);
	}

	async function management(
		campId: CampId,
		state: CampSpecState,
	): Promise<CampManagement> {
		const inventory = foldManagement(
			await readStream(CD_STREAMS.campInventory(campId)),
		);
		return inventory ?? state.management ?? CampManagement.MANAGED;
	}

	async function* changes(
		input: Readonly<{
			campIds: readonly CampId[];
			after?: EventPosition;
			signal: AbortSignal;
		}>,
	): AsyncIterable<DesiredStateChange> {
		const { campIds, after, signal } = input;
		const byStream = new Map(
			campIds.map((campId) => [CD_STREAMS.campSpec(campId), campId] as const),
		);
		const states = new Map<CampId, CampSpecState>();
		const single =
			campIds.length === 1 ? CD_STREAMS.campSpec(campIds[0] ?? "") : undefined;
		let cursor: EventPosition | undefined;
		let dirty = false;
		let wake: (() => void) | undefined;
		const subscription = store.subscribe({}, (event) => {
			if (byStream.has(event.streamId)) {
				dirty = true;
				wake?.();
			}
		});
		const onAbort = () => wake?.();
		signal.addEventListener("abort", onAbort);
		try {
			while (!signal.aborted) {
				dirty = false;
				const batch: {
					position: EventPosition;
					campId: CampId;
					event: EventEnvelope;
				}[] = [];
				const reads = store.readAll(readOptions(cursor, single));
				for await (const { position, event } of reads) {
					cursor = position;
					const campId = byStream.get(event.streamId);
					if (campId !== undefined) batch.push({ position, campId, event });
				}
				for (const { position, campId, event } of batch) {
					const state = applyCampSpecEvent(
						states.get(campId) ?? emptyCampSpec(campId),
						event,
					);
					states.set(campId, state);
					if (after !== undefined && position <= after) continue;
					if (!CHANGE_TYPES.has(event.type) || state.current === undefined)
						continue;
					const observeFields = d.posture
						? await d.posture.observeFields(campId)
						: [];
					const frame = {
						position,
						set: state.current,
						observeFields: Object.freeze([...observeFields]),
						management: await management(campId, state),
					};
					const change: DesiredStateChange =
						state.policy === undefined
							? frame
							: { ...frame, policy: state.policy };
					yield Object.freeze(change);
					if (signal.aborted) return;
				}
				if (dirty || signal.aborted) continue;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(
						resolve,
						d.pollIntervalMs ?? CD_DEFAULTS.serviceTickMs,
					);
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
				wake = undefined;
			}
		} finally {
			subscription.unsubscribe();
			signal.removeEventListener("abort", onAbort);
		}
	}

	async function adoptOne(
		legacy: LegacyDeployment,
		ctx: CdContext,
	): Promise<SetRecord | undefined> {
		const campId = asCampId(legacy.campId);
		const state = await spec(campId);
		if (state.seq > 0) return undefined;
		const gateDecisionId = `legacy:${legacy.streamId}@${legacy.planSeq}`;
		const blob = encodeResolvedSetBlob(
			createResolvedDeploymentSet({
				tenant: d.tenant,
				environment: legacy.environment,
				campId,
				plan: legacy.plan,
				matches: legacy.matches,
				gatekeeper: {
					decision: "allow",
					gatekeeperDecisionId: gateDecisionId,
					obligations: ["legacy-fold"],
					decidedAt: legacy.plannedAt,
				},
			}),
		);
		const ref = await d.artifacts.put(
			blob.bytes,
			{
				name: `resolved-set/${campId}/legacy`,
				kind: ArtifactKind.PACKAGE,
				mediaType: RESOLVED_SET_MEDIA_TYPE,
			},
			ctx,
		);
		if (ref.digest !== blob.digest) {
			throw new DesiredStateError(
				"blob-digest-mismatch",
				`artifact store returned ${ref.digest} for ${blob.digest}`,
				campId,
			);
		}
		const set: ParsedSet = checkSet(
			create(SetRecordSchema, {
				schemaVersion: SET_SCHEMA,
				setId: setIdFor([
					d.tenant,
					campId,
					gateDecisionId,
					blob.resolved.contentHash,
				]),
				tenant: d.tenant,
				environment: legacy.environment,
				campId,
				planHash: blob.resolved.planHash,
				contentHash: blob.resolved.contentHash,
				gateDecisionId,
				origin: SetOrigin.LEGACY_FOLD,
				resolvedSetDigest: blob.digest,
				resolvedSetBytes: BigInt(blob.size),
				createdAt: isoAt(ctx.now()),
			}),
			"resolved-set-invalid",
		);
		try {
			await append(
				campId,
				state,
				[
					{
						type: CD_EVENTS.SetCreated,
						data: encodeSet(set),
						meta: { idempotencyKey: `set.Created:${gateDecisionId}` },
					},
				],
				ctx,
			);
		} catch (error) {
			if (error instanceof OptimisticSequenceConflictError) return undefined;
			throw error;
		}
		setCamps.set(set.setId, campId);
		return set;
	}

	async function adoptLegacy(ctx: CdContext): Promise<LegacyAdoption> {
		const streams: string[] = [];
		for await (const { event } of store.readAll({
			filter: { type: LEGACY_EVENTS.planned },
		})) {
			if (event.tenant === d.tenant && !streams.includes(event.streamId))
				streams.push(event.streamId);
		}
		const latest = new Map<string, LegacyDeployment>();
		const skipped: ReasonRecord[] = [];
		for (const streamId of streams) {
			const legacy = foldLegacyDeployment(await readStream(streamId));
			if (
				legacy === undefined ||
				legacy.state !== "deployed" ||
				legacy.tenant !== d.tenant
			)
				continue;
			const prior = latest.get(legacy.campId);
			if (!prior || (prior.deployedAtSeq ?? 0) <= (legacy.deployedAtSeq ?? 0))
				latest.set(legacy.campId, legacy);
		}
		const adopted: SetRecord[] = [];
		for (const legacy of [...latest.values()].sort((a, b) =>
			a.campId.localeCompare(b.campId),
		)) {
			try {
				const set = await adoptOne(legacy, ctx);
				if (set) adopted.push(set);
			} catch (error) {
				if (!(error instanceof DesiredStateError)) throw error;
				skipped.push(
					reason(
						error.code,
						`${legacy.streamId}: ${error.message}`,
						legacy.campId,
						error.remediation,
					),
				);
				await metric("hobo.cd.sets.legacy_skipped", 1, {
					"hobo.cd.camp": legacy.campId,
					"hobo.cd.reason": error.code,
				});
			}
		}
		if (adopted.length > 0)
			await metric("hobo.cd.sets.legacy_adopted", adopted.length, {});
		return Object.freeze({
			adopted: Object.freeze(adopted),
			skipped: Object.freeze(skipped),
		});
	}

	return Object.freeze({
		async current(campId: CampId) {
			return (await spec(campId)).current;
		},
		get: getById,
		async history(campId: CampId, limit?: number) {
			const sets = [...(await spec(campId)).sets].reverse();
			return limit === undefined ? sets : sets.slice(0, Math.max(0, limit));
		},
		resolved: (set: SetRecord): Promise<ResolvedDeploymentSet> => resolved(set),
		async status(
			campId: CampId,
		): Promise<ReconcileObservationRecord | undefined> {
			return foldCampStatus(await readStream(CD_STREAMS.campStatus(campId)));
		},
		changes,
		open,
		update,
		apply,
		reject,
		adoptLegacy,
		spec,
	});
}
