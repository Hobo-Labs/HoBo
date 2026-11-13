// In-process fakes of the frozen @hobo/cd ports `hobo up`/`down`/`build`
// consume (plan 0024 §7.3: code against frozen ports, write your own fakes).
//
// They are deliberately faithful where the CLI depends on behavior: the
// ledger is idempotent per content id, promotions are idempotent per key and
// write Sets to the Camp spec stream, the reconciler converges through the
// real @hobo/cloud orchestrator and reports to the Camp status stream. Every
// event lands on the runtime's journal with the frozen CD_EVENTS names, so a
// test can assert the journal order `freight.Recorded` -> `set.Created` ->
// `deployment.Converged`. The real modules replace them at merge (WP18).
import { createHash } from "node:crypto";
import {
	create,
	fromJson,
	type JsonValue as ProtoJson,
	toJson,
} from "@bufbuild/protobuf";
import { parseManifest } from "@hobo/bindles";
import type {
	ArtifactStore,
	CampId,
	CampReconciler,
	CdContext,
	ContinuousDelivery,
	DeltaIntent,
	Digest,
	FreightId,
	FreightLedger,
	OtelMetricPoint,
	Outcome,
	PromoteRequest,
	PromotionId,
	ReconcilerId,
	TelemetrySink,
} from "@hobo/cd";
import {
	ArtifactKind,
	ArtifactRefSchema,
	CD_EVENTS,
	CD_STREAMS,
	type FreightManifestRecord,
	FreightManifestRecordSchema,
	type FreightRecord,
	FreightRecordSchema,
	type PromotionRecord,
	PromotionRecordSchema,
	PromotionState,
	type ReasonRecord,
	ReasonRecordSchema,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcilerMode,
	ReconcileStatus,
	ResourceObservationSchema,
	SET_SCHEMA,
	SetOrigin,
	type SetRecord,
	SetRecordSchema,
} from "@hobo/cd";
import {
	collectStream,
	createResolvedDeploymentSet,
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlan,
	type OrchestratorDeps,
	type PlannerRegistry,
	plan as planDeployment,
	type ResolvedDeploymentSet,
	runCompensation,
	runOrchestrator,
} from "@hobo/cloud";
import type { EventEnvelope, EventStore, PrincipalRef } from "@hobo/core";
import { stableStringify } from "../src/build/events.js";
import type { JsonValue } from "../src/json.js";

export type DeliverySlice = Pick<
	ContinuousDelivery,
	"freight" | "artifacts" | "desired" | "promotions" | "createReconciler"
>;

export type FakeKnobs = {
	/** Gate effect for every promotion. */
	gate: "allow" | "deny" | "require-approval";
	/** Resource whose apply the reconciler reports as BLOCKED. */
	blockResource?: string;
	/** The reconciler never finishes converging (provider still working). */
	stall?: boolean;
};

export type FakeDelivery = Readonly<{
	cd: DeliverySlice;
	knobs: FakeKnobs;
	/** Every port call in order, for the PACT consumer test. */
	calls: Array<Readonly<{ port: string; input: JsonValue }>>;
	blobs: Map<string, Uint8Array>;
	metrics: OtelMetricPoint[];
	telemetry: TelemetrySink;
}>;

const SYSTEM: PrincipalRef = { kind: "service", id: "fake-cd" };

function sha(bytes: Uint8Array | string): Digest {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isDigest(value: string): value is Digest {
	return /^sha256:[0-9a-f]{64}$/.test(value);
}

function setOf(event: EventEnvelope): SetRecord {
	// SAFETY: set.Created bodies are written by writeSet as SetRecord JSON.
	return fromJson(SetRecordSchema, event.data as ProtoJson);
}

/** A port call's input as plain JSON, as the pact records it. */
function jsonOf<T>(value: T): JsonValue {
	// SAFETY: JSON.parse of JSON.stringify output is a JSON value by construction.
	return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** Sorted-key compact JSON (the canonical form the real writer emits). */
function canonical(value: ProtoJson): string {
	return stableStringify(value).trimEnd();
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function reason(
	code: string,
	message: string,
	remediation: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation, subject });
}

async function append(
	store: EventStore,
	streamId: string,
	type: string,
	data: ProtoJson,
	actor: PrincipalRef,
	tenant: string,
): Promise<void> {
	const existing = await collectStream(store, streamId);
	await store.append(streamId, [{ type, data }], {
		expectedSeq: existing.length,
		actor,
		tenant,
	});
}

export function createFakeDelivery(input: {
	readonly store: EventStore;
	readonly registry: PlannerRegistry;
	readonly orchestrator: OrchestratorDeps;
	readonly tenant: string;
	readonly knobs?: Partial<FakeKnobs>;
}): FakeDelivery {
	const { store, registry, orchestrator, tenant } = input;
	const knobs: FakeKnobs = { gate: "allow", ...input.knobs };
	const calls: Array<{ port: string; input: JsonValue }> = [];
	const called = <T>(port: string, input: T): void => {
		calls.push({ port, input: jsonOf(input) });
	};
	const blobs = new Map<string, Uint8Array>();
	const metrics: OtelMetricPoint[] = [];
	const freightById = new Map<string, FreightRecord>();
	const promotions = new Map<string, PromotionRecord>();

	const artifacts: ArtifactStore = {
		backend: "memory",
		async put(bytes, meta) {
			called("artifacts.put", meta);
			const digest = sha(bytes);
			blobs.set(digest, bytes);
			return create(ArtifactRefSchema, {
				name: meta.name,
				kind: meta.kind,
				digest,
				coordinate: `store://${digest}`,
				sizeBytes: BigInt(bytes.byteLength),
				mediaType: meta.mediaType,
				ecosystem: "store",
			});
		},
		async get(digest) {
			return blobs.get(digest);
		},
		async has(digest) {
			return blobs.has(digest);
		},
		async *list() {
			for (const digest of blobs.keys()) if (isDigest(digest)) yield digest;
		},
		async delete(digest) {
			blobs.delete(digest);
		},
	};

	const freight: FreightLedger = {
		async record({ manifest, origin }, ctx) {
			called("freight.record", {
				manifest: toJson(FreightManifestRecordSchema, manifest),
				origin,
			});
			const identity = canonical({
				bindle: manifest.bindle,
				declarationHash: manifest.declarationHash,
				artifacts: [...manifest.artifacts]
					.map((a) => ({ name: a.name, kind: a.kind, digest: a.digest }))
					.sort((a, b) => (a.name < b.name ? -1 : 1)),
			});
			const freightId = sha(identity);
			const known = freightById.get(freightId);
			if (known) return { ok: true, value: known };
			const record = create(FreightRecordSchema, {
				schemaVersion: "hobo.cd.freight/v1",
				freightId,
				alias: `alias-${freightId.slice(7, 15)}`,
				manifest,
				origin,
				recordedBy: ctx.principal.id,
				recordedAt: iso(ctx.now()),
			});
			freightById.set(freightId, record);
			await append(
				store,
				CD_STREAMS.freight(freightId),
				CD_EVENTS.FreightRecorded,
				toJson(FreightRecordSchema, record),
				ctx.principal,
				tenant,
			);
			return { ok: true, value: record };
		},
		async yank() {
			throw new Error("not used by the CLI");
		},
		async approve() {
			throw new Error("not used by the CLI");
		},
		async qualify() {
			throw new Error("not used by the CLI");
		},
		async get(id) {
			return freightById.get(id);
		},
		async getByAlias(alias) {
			return [...freightById.values()].find((f) => f.alias === alias);
		},
		async isUsable() {
			return true;
		},
		async qualifications() {
			return [];
		},
		async approvals() {
			return [];
		},
		async list(query) {
			return [...freightById.values()].filter(
				(f) =>
					query?.bindle === undefined || f.manifest?.bindle === query.bindle,
			);
		},
		async retire() {
			return [];
		},
	};

	async function sets(campId: string): Promise<SetRecord[]> {
		const events = await collectStream(store, CD_STREAMS.campSpec(campId));
		return events.filter((e) => e.type === CD_EVENTS.SetCreated).map(setOf);
	}

	async function observations(
		campId: string,
	): Promise<ReconcileObservationRecord[]> {
		const events = await collectStream(store, CD_STREAMS.campStatus(campId));
		return events
			.filter((e) => e.type === CD_EVENTS.StatusObserved)
			.map((e) =>
				// SAFETY: status bodies are written by `report` as observation JSON.
				fromJson(ReconcileObservationRecordSchema, e.data as ProtoJson),
			);
	}

	async function resolvedOf(set: SetRecord): Promise<ResolvedDeploymentSet> {
		const bytes = blobs.get(set.resolvedSetDigest);
		if (!bytes)
			throw new Error(`resolved set ${set.resolvedSetDigest} missing`);
		// SAFETY: the blob was written by writeSet from a ResolvedDeploymentSet.
		return JSON.parse(new TextDecoder().decode(bytes)) as ResolvedDeploymentSet;
	}

	const desired: DeliverySlice["desired"] = {
		async current(campId) {
			return (await sets(campId)).at(-1);
		},
		async get(setId) {
			for (const id of campIds) {
				const found = (await sets(id)).find((s) => s.setId === setId);
				if (found) return found;
			}
			return undefined;
		},
		async history(campId, limit) {
			const all = (await sets(campId)).reverse();
			return limit === undefined ? all : all.slice(0, limit);
		},
		resolved: resolvedOf,
		async status(campId) {
			return (await observations(campId)).at(-1);
		},
		changes() {
			throw new Error("not used by the CLI");
		},
	};
	const campIds = new Set<string>();

	async function writeSet(
		campId: string,
		freightRecord: FreightRecord,
		resolved: ResolvedDeploymentSet,
		origin: SetOrigin,
		ctx: CdContext,
	): Promise<SetRecord> {
		campIds.add(campId);
		const blob = new TextEncoder().encode(JSON.stringify(resolved));
		const digest = sha(blob);
		blobs.set(digest, blob);
		const previous = (await sets(campId)).at(-1);
		const set = create(SetRecordSchema, {
			schemaVersion: SET_SCHEMA,
			setId: `set-${sha(`${campId}|${digest}|${previous?.setId ?? ""}`).slice(7, 19)}`,
			tenant,
			environment: campId,
			campId,
			freightId: freightRecord.freightId,
			planHash: resolved.planHash,
			contentHash: resolved.contentHash,
			predecessorSetId: previous?.setId ?? "",
			gateDecisionId: "gate-fake",
			origin,
			resolvedSetDigest: digest,
			resolvedSetBytes: BigInt(blob.byteLength),
			createdAt: iso(ctx.now()),
		});
		await append(
			store,
			CD_STREAMS.campSpec(campId),
			CD_EVENTS.SetCreated,
			toJson(SetRecordSchema, set),
			ctx.principal,
			tenant,
		);
		return set;
	}

	async function resolve(
		freightRecord: FreightRecord,
		campId: string,
		intent: DeltaIntent,
	): Promise<ResolvedDeploymentSet | ReasonRecord> {
		const gatekeeper = {
			decision: "allow" as const,
			gatekeeperDecisionId: "gate-fake",
			obligations: [],
			decidedAt: iso(0),
		};
		if (intent === "down") {
			const empty: DeploymentPlan = {
				schema: DEPLOYMENT_PLAN_SCHEMA,
				resources: [],
				dependencyOrder: [],
				objective: "min-cost",
			};
			return createResolvedDeploymentSet({
				tenant,
				environment: campId,
				campId,
				plan: empty,
				matches: [],
				gatekeeper,
			});
		}
		const declaration = blobs.get(
			freightRecord.manifest?.declarationHash ?? "",
		);
		if (!declaration)
			return reason(
				"planning-declaration-missing",
				"declaration not stored",
				"store the declaration under its hash",
			);
		const bindle = parseManifest(
			JSON.parse(new TextDecoder().decode(declaration)),
		);
		const planned = planDeployment(bindle, { deploymentId: campId }, registry);
		if (!planned.ok)
			return reason(
				"planning-plan-rejected",
				planned.reason,
				"fix the declaration",
			);
		return createResolvedDeploymentSet({
			tenant,
			environment: campId,
			campId,
			plan: planned.plan,
			matches: [],
			gatekeeper,
		});
	}

	function promotionIdFor(key: string): PromotionId {
		// SAFETY: the fake mints promotion ids deterministically from the key.
		return `prom-${sha(key).slice(7, 19)}` as PromotionId;
	}

	const promotionService: DeliverySlice["promotions"] = {
		async promote(request: PromoteRequest, ctx) {
			called("promotions.promote", request);
			const promotionId = promotionIdFor(request.idempotencyKey);
			const existing = promotions.get(promotionId);
			if (existing) return { ok: true, value: existing };
			const campId = request.targets[0] ?? "";
			const freightRecord = freightById.get(request.freightId);
			if (!freightRecord)
				return {
					ok: false,
					reasons: [
						reason(
							"promotion-freight-unknown",
							"unknown Freight",
							"record it first",
						),
					],
				};
			const record = create(PromotionRecordSchema, {
				schemaVersion: "hobo.cd.promotion/v1",
				promotionId,
				freightId: request.freightId,
				targetCampIds: [...request.targets],
				state: PromotionState.QUEUED,
				requestedBy: ctx.principal.id,
				requestedAt: iso(ctx.now()),
				idempotencyKey: request.idempotencyKey,
			});
			await append(
				store,
				CD_STREAMS.promotion(promotionId),
				CD_EVENTS.EnvPromoteRequested,
				toJson(PromotionRecordSchema, record),
				ctx.principal,
				tenant,
			);
			if (knobs.gate === "deny") {
				record.state = PromotionState.REJECTED;
				record.reasons = [
					reason(
						"gate-denied",
						"policy pack denies the promotion",
						"request the promote grant",
						campId,
					),
				];
				promotions.set(promotionId, record);
				return { ok: false, reasons: record.reasons };
			}
			if (knobs.gate === "require-approval") {
				record.state = PromotionState.AWAITING_APPROVAL;
				promotions.set(promotionId, record);
				return { ok: true, value: record };
			}
			const resolved = await resolve(
				freightRecord,
				campId,
				request.intent ?? "promote",
			);
			if (!("plan" in resolved)) {
				record.state = PromotionState.REJECTED;
				record.reasons = [resolved];
				promotions.set(promotionId, record);
				return { ok: false, reasons: [resolved] };
			}
			await writeSet(
				campId,
				freightRecord,
				resolved,
				request.intent === "down" ? SetOrigin.TEARDOWN : SetOrigin.UP,
				ctx,
			);
			record.state = PromotionState.PROMOTED;
			record.gateDecisionId = "gate-fake";
			promotions.set(promotionId, record);
			return { ok: true, value: record };
		},
		async rollback(request, ctx) {
			called("promotions.rollback", request);
			const promotionId = promotionIdFor(`rollback|${request.idempotencyKey}`);
			const existing = promotions.get(promotionId);
			if (existing) return { ok: true, value: existing };
			const history = await sets(request.campId);
			const current = history.at(-1);
			const target = history.find((s) => s.setId === current?.predecessorSetId);
			if (!current || !target)
				return {
					ok: false,
					reasons: [
						reason(
							"rollback-no-predecessor",
							"no predecessor Set",
							"deploy twice first",
							request.campId,
						),
					],
				};
			const freightRecord = freightById.get(target.freightId);
			if (!freightRecord) throw new Error("predecessor freight missing");
			await writeSet(
				request.campId,
				freightRecord,
				await resolvedOf(target),
				SetOrigin.ROLLBACK,
				ctx,
			);
			const record = create(PromotionRecordSchema, {
				schemaVersion: "hobo.cd.promotion/v1",
				promotionId,
				freightId: target.freightId,
				targetCampIds: [request.campId],
				state: PromotionState.ROLLED_BACK,
				idempotencyKey: request.idempotencyKey,
			});
			promotions.set(promotionId, record);
			return { ok: true, value: record };
		},
		async approve() {
			throw new Error("not used by the CLI");
		},
		async get(promotionId) {
			return promotions.get(promotionId);
		},
		async list() {
			return [...promotions.values()];
		},
		async tick() {
			called("promotions.tick", {});
		},
		async createPreview() {
			throw new Error("not used by the CLI");
		},
		async expirePreviews() {
			return [];
		},
		async listPreviews() {
			return [];
		},
	};

	function createReconciler(spec: {
		mode: ReconcilerMode;
		reconcilerId: ReconcilerId;
		campIds: readonly CampId[];
		holderId: string;
	}): CampReconciler {
		called("createReconciler", spec);
		return {
			reconcilerId: spec.reconcilerId,
			mode: spec.mode,
			async run() {
				throw new Error("hobo up runs bounded passes only");
			},
			async reconcileOnce(campId, ctx) {
				called("reconcileOnce", { campId });
				return reconcile(campId, spec.reconcilerId, ctx);
			},
		};
	}

	async function report(
		campId: string,
		type: string,
		observation: ReconcileObservationRecord,
		actor: PrincipalRef,
	): Promise<void> {
		await append(
			store,
			CD_STREAMS.campStatus(campId),
			type,
			toJson(ReconcileObservationRecordSchema, observation),
			actor,
			tenant,
		);
	}

	async function reconcile(
		campId: string,
		reconcilerId: string,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord> {
		const history = await sets(campId);
		const desiredSet = history.at(-1);
		const last = (await observations(campId)).at(-1);
		const observation = (
			status: ReconcileStatus,
			resources: readonly string[],
			reasons: ReasonRecord[] = [],
		) =>
			create(ReconcileObservationRecordSchema, {
				campId,
				setId: desiredSet?.setId ?? "",
				reconcilerId,
				fenceToken: "1",
				status,
				resources: resources.map((name) =>
					create(ResourceObservationSchema, {
						resource: name,
						physicalId: `${campId}/${name}`,
						healthy: true,
					}),
				),
				reasons,
				observedAt: iso(ctx.now()),
			});
		if (!desiredSet) return observation(ReconcileStatus.CONVERGED, []);
		if (
			last &&
			last.setId === desiredSet.setId &&
			last.status === ReconcileStatus.CONVERGED
		) {
			const same = observation(
				ReconcileStatus.CONVERGED,
				last.resources.map((r) => r.resource),
			);
			await report(campId, CD_EVENTS.StatusObserved, same, SYSTEM);
			return same;
		}
		const resolved = await resolvedOf(desiredSet);
		const started = observation(ReconcileStatus.CONVERGING, []);
		await report(campId, CD_EVENTS.ReconcileStarted, started, SYSTEM);
		if (knobs.stall) return started;
		const realized = `cd.${campId}.${desiredSet.setId}`;
		const blocked = knobs.blockResource;
		if (blocked && resolved.plan.resources.some((r) => r.name === blocked)) {
			const stuck = observation(
				ReconcileStatus.BLOCKED,
				[],
				[
					reason(
						"realize-apply-failed",
						`apply of ${blocked} failed`,
						"inspect provider credentials, then rerun hobo up",
						blocked,
					),
				],
			);
			await report(campId, CD_EVENTS.StatusObserved, stuck, SYSTEM);
			await report(campId, CD_EVENTS.ReconcileBlocked, stuck, SYSTEM);
			return stuck;
		}
		const previous = history.find((s) => s.setId === last?.setId);
		if (previous && last?.status === ReconcileStatus.CONVERGED) {
			const before = await resolvedOf(previous);
			if (before.plan.resources.length > 0)
				await runCompensation(
					orchestrator,
					before.plan,
					`cd.${campId}.${previous.setId}`,
					{
						resourceId: before.plan.resources[0]?.name ?? campId,
						reason: "superseded",
					},
					{ tenant, actor: SYSTEM, correlationId: `cd:${campId}` },
				);
		}
		let names: string[] = [];
		if (resolved.plan.resources.length > 0) {
			const result = await runOrchestrator(
				orchestrator,
				resolved.plan,
				realized,
				{
					tenant,
					actor: SYSTEM,
					correlationId: `cd:${campId}`,
				},
			);
			names = [...result.provisioned].sort();
		}
		const done = observation(ReconcileStatus.CONVERGED, names);
		await report(campId, CD_EVENTS.StatusObserved, done, SYSTEM);
		await report(campId, CD_EVENTS.Converged, done, SYSTEM);
		return done;
	}

	const telemetry: TelemetrySink = {
		async spans() {},
		async metrics(points) {
			metrics.push(...points);
		},
	};

	return {
		cd: {
			freight,
			artifacts,
			desired,
			promotions: promotionService,
			createReconciler,
		},
		knobs,
		calls,
		blobs,
		metrics,
		telemetry,
	};
}

/** The test-side stand-in for `@hobo/cd/freight` `writeFreightManifest`/`parseFreightManifest`. */
export const fakeFreightManifestCodec = Object.freeze({
	write(manifest: FreightManifestRecord): Uint8Array {
		return new TextEncoder().encode(
			canonical(toJson(FreightManifestRecordSchema, manifest)),
		);
	},
	parse(bytes: Uint8Array): Outcome<FreightManifestRecord> {
		try {
			// SAFETY: JSON.parse returns JSON; fromJson below is the real parse.
			const json = JSON.parse(new TextDecoder().decode(bytes)) as ProtoJson;
			const manifest = fromJson(FreightManifestRecordSchema, json);
			if (manifest.schemaVersion !== "hobo.freight-manifest/v1")
				return {
					ok: false,
					reasons: [
						reason(
							"freight-manifest-invalid",
							"schemaVersion",
							"rewrite it",
							"schemaVersion",
						),
					],
				};
			return { ok: true, value: manifest };
		} catch (error) {
			return {
				ok: false,
				reasons: [
					reason(
						"freight-manifest-invalid",
						String(error),
						"rewrite it",
						"manifest",
					),
				],
			};
		}
	},
});

export { ArtifactKind, type FreightId, ReconcilerMode };
