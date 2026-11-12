// `ocmRealizer(): Realizer` — Open Cluster Management as a transport (D26).
//
// One ManifestWork per Camp (`hobo-<camp>-<setdigest8>`) in the hub's cluster
// namespace. A new Set is a new work (make before break): the previous work
// is deleted only after the new one is observed Applied and Available, so
// resources both declare survive (OCM shared ownership) and resources only
// the old Set declared are removed per its deleteOption, which carries the
// DepartureAction's orphan rules. Convergence is reported only from observed
// conditions plus HoBo's own verification of what the hub holds.
import {
	type CampId,
	type CdContext,
	type CredentialResolver,
	DepartureAction,
	type RealizeInput,
	type Realizer,
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileStatus,
	type ResourceObservation,
	type TelemetrySink,
} from "@hobo/cd";
import type { HttpTransport, JsonObject, JsonValue } from "@hobo/core";
import { KUBE_FLEET_DEFAULTS, type RealizerConfig } from "../config.js";
import { reason } from "../errors.js";
import {
	arrayAt,
	isJsonObject,
	isJsonString,
	numberAt,
	objectAt,
	objectsOf,
	type StringMap,
	stringAt,
} from "../json.js";
import { createKubeApi, type KubeApi } from "../kube/api.js";
import {
	campSlug,
	digestOf,
	fenceOf,
	HOBO_KEYS,
	identityOf,
	type KubeObject,
} from "../kube/objects.js";
import {
	blocked,
	keepOf,
	observation,
	preflight,
	resourceObservation,
} from "../kube/observation.js";
import { createMeter, KUBE_FLEET_METRICS, type Meter } from "../telemetry.js";
import {
	condition,
	feedbackPath,
	type ManifestStatus,
	manifestsOf,
	parseWorkStatus,
	renderManifestWork,
	WELL_KNOWN,
	type WorkStatus,
	workName,
	worksPath,
} from "./manifest-work.js";

export type ObserveFieldsReader = (
	campId: CampId,
) => Promise<readonly string[]>;

export type OcmRealizerDeps = Readonly<{
	config: RealizerConfig;
	http: HttpTransport;
	credentials: CredentialResolver;
	telemetry?: TelemetrySink;
	/** Posture attribute paths per Camp (PostureService.observeFields). */
	observeFields?: ObserveFieldsReader;
	/** Namespace for namespaced objects that declare none (default `default`). */
	defaultNamespace?: string;
}>;

type Verdict = Readonly<{
	status: ReconcileStatus;
	resources: readonly ResourceObservation[];
	reasons: readonly ReasonRecord[];
}>;

// The resource index annotation lets a later pass compute orphan rules for a
// superseded work without re-reading its Set: [identity, resource, data].
const RESOURCE_INDEX = "hobo.dev/resource-index";
const SPEC_DIGEST = "hobo.dev/spec-digest";

function annotationsOf(object: JsonObject): JsonObject {
	return objectAt(objectAt(object, "metadata"), "annotations");
}

function withIndex(
	work: JsonObject,
	objects: readonly KubeObject[],
): JsonObject {
	const metadata = objectAt(work, "metadata");
	const index = objects.map((o) => [
		identityOf({
			group: o.info.group,
			kind: o.info.kind,
			namespace: o.namespace,
			name: o.name,
		}),
		o.resource,
		o.data ? "data" : "compute",
	]);
	return {
		...work,
		metadata: {
			...metadata,
			annotations: {
				...annotationsOf(work),
				[RESOURCE_INDEX]: JSON.stringify(index),
				[SPEC_DIGEST]: digestOf(work.spec ?? null),
			},
		},
	};
}

// WellKnownStatus value names OCM feeds back per kind.
const WELL_KNOWN_FIELDS = new Map<string, readonly string[]>([
	["Deployment", ["ReadyReplicas", "Replicas", "AvailableReplicas"]],
	["StatefulSet", ["ReadyReplicas", "Replicas", "AvailableReplicas"]],
	[
		"DaemonSet",
		[
			"NumberReady",
			"DesiredNumberScheduled",
			"NumberAvailable",
			"CurrentNumberScheduled",
			"NumberMisscheduled",
			"UpdatedNumberScheduled",
		],
	],
	["Job", ["JobComplete", "JobSucceeded"]],
	["Pod", ["PodPhase", "PodReady"]],
]);

type WorkloadState = "ready" | "not-ready" | "feedback-missing";

/**
 * Fail-closed readiness from OCM WellKnownStatus feedback. Kubernetes omits
 * zero counts (omitempty) and OCM drops paths it cannot find, so a missing
 * ready count is zero and a workload with no well-known values at all is
 * unknown, never healthy. `desiredReplicas` is the declared spec.replicas,
 * which lets a workload scaled to zero (no counts fed back) pass.
 */
export function workloadState(
	kind: string,
	feedback: Readonly<Record<string, string>>,
	desiredReplicas?: number,
): WorkloadState {
	if (!WELL_KNOWN.has(kind)) return "ready";
	const names = WELL_KNOWN_FIELDS.get(kind) ?? [];
	const scaledToZero = desiredReplicas === 0;
	if (!names.some((n) => feedback[n] !== undefined))
		return scaledToZero ? "ready" : "feedback-missing";
	const ok = (value: boolean): WorkloadState => (value ? "ready" : "not-ready");
	switch (kind) {
		case "Job":
			return ok(
				feedback.JobSucceeded === "true" || feedback.JobComplete === "true",
			);
		case "Pod":
			return ok(feedback.PodReady === "true");
		case "DaemonSet": {
			const want = feedback.DesiredNumberScheduled;
			if (want === undefined) return "not-ready";
			return ok(Number(feedback.NumberReady ?? "0") >= Number(want));
		}
		default: {
			const want = feedback.Replicas ?? (scaledToZero ? "0" : undefined);
			if (want === undefined) return "not-ready";
			return ok(Number(feedback.ReadyReplicas ?? "0") >= Number(want));
		}
	}
}

export function workloadReady(
	kind: string,
	feedback: Readonly<Record<string, string>>,
	desiredReplicas?: number,
): boolean {
	return workloadState(kind, feedback, desiredReplicas) === "ready";
}

function desiredReplicasOf(o: KubeObject): number | undefined {
	return numberAt(objectAt(o.body, "spec"), "replicas");
}

function attributesFor(
	manifest: ManifestStatus | undefined,
	fields: readonly string[],
): StringMap {
	if (manifest === undefined) return {};
	const out: Record<string, string> = {};
	for (const field of fields) {
		if (feedbackPath(field) === undefined) continue;
		const value = manifest.feedback[field];
		if (value !== undefined) out[field] = value;
	}
	return out;
}

function unobservable(
	fields: readonly string[],
	campId: string,
): readonly ReasonRecord[] {
	return fields
		.filter((field) => feedbackPath(field) === undefined)
		.map((field) =>
			reason(
				"kube-attribute-unobservable",
				`${field} is not a status field; OCM cannot feed it back`,
				campId,
			),
		);
}

function physicalIdOf(cluster: string, o: KubeObject): string {
	return `ocm:${cluster}/${identityOf({ group: o.info.group, kind: o.info.kind, namespace: o.namespace, name: o.name })}`;
}

/** Evaluate an observed work against the desired objects. Pure. */
export function evaluateWork(
	input: Readonly<{
		campId: string;
		cluster: string;
		objects: readonly KubeObject[];
		fields: readonly string[];
		status: WorkStatus;
		desiredManifestsDigest: string;
		superseded: number;
	}>,
): Verdict {
	const { status, objects, cluster } = input;
	const reasons: ReasonRecord[] = [...unobservable(input.fields, input.campId)];
	const byIdentity = new Map(status.manifests.map((m) => [m.identity, m]));
	const physical = (o: KubeObject): string => physicalIdOf(cluster, o);
	if (status.manifestsDigest !== input.desiredManifestsDigest) {
		return {
			status: ReconcileStatus.DRIFTED,
			resources: objects.map((o) =>
				resourceObservation({
					object: o,
					physicalId: physical(o),
					outputsHash: "",
					healthy: false,
					driftKind: "modified",
				}),
			),
			reasons: [
				...reasons,
				reason(
					"ocm-work-modified",
					`ManifestWork ${status.name} holds manifests the Set does not declare`,
					input.campId,
				),
			],
		};
	}
	const resources = objects.map((o) => {
		const manifest = byIdentity.get(
			identityOf({
				group: o.info.group,
				kind: o.info.kind,
				namespace: o.namespace,
				name: o.name,
			}),
		);
		const available =
			manifest !== undefined &&
			condition(manifest.conditions, "Available")?.status === "True";
		const applied =
			manifest !== undefined &&
			condition(manifest.conditions, "Applied")?.status === "True";
		const workload = workloadState(
			o.info.kind,
			manifest?.feedback ?? {},
			desiredReplicasOf(o),
		);
		return {
			object: o,
			manifest,
			workload,
			observation: resourceObservation({
				object: o,
				physicalId: physical(o),
				outputsHash: manifest === undefined ? "" : digestOf(manifest.feedback),
				healthy: applied && available && workload === "ready",
				attributes: attributesFor(manifest, input.fields),
			}),
		};
	});
	const observed = resources.map((r) => r.observation);
	const applied = condition(status.conditions, "Applied");
	const current = (c: typeof applied): boolean =>
		c !== undefined &&
		(c.observedGeneration === undefined ||
			c.observedGeneration === status.generation);
	if (applied?.status === "False" && current(applied)) {
		const failed = resources
			.filter(
				(r) =>
					r.manifest !== undefined &&
					condition(r.manifest.conditions, "Applied")?.status === "False",
			)
			.map(
				(r) =>
					`${r.object.resource}: ${condition(r.manifest?.conditions ?? [], "Applied")?.message ?? ""}`,
			);
		return {
			status: ReconcileStatus.BLOCKED,
			resources: observed,
			reasons: [
				...reasons,
				reason(
					"ocm-work-apply-failed",
					failed.length > 0 ? failed.join("; ") : applied.message,
					input.campId,
				),
			],
		};
	}
	if (
		applied?.status !== "True" ||
		!current(applied) ||
		resources.some((r) => r.manifest === undefined)
	) {
		return {
			status: ReconcileStatus.CONVERGING,
			resources: observed,
			reasons: [
				...reasons,
				reason(
					"ocm-work-not-applied",
					`ManifestWork ${status.name} generation ${status.generation} not applied yet`,
					input.campId,
				),
			],
		};
	}
	const available = condition(status.conditions, "Available");
	if (available?.status !== "True" || !current(available)) {
		return {
			status: ReconcileStatus.CONVERGING,
			resources: observed,
			reasons: [
				...reasons,
				reason(
					"ocm-work-not-available",
					`ManifestWork ${status.name} is not Available`,
					input.campId,
				),
			],
		};
	}
	const blind = resources
		.filter((r) => r.workload === "feedback-missing")
		.map((r) => r.object.resource);
	if (blind.length > 0) {
		return {
			status: ReconcileStatus.CONVERGING,
			resources: observed,
			reasons: [
				...reasons,
				reason(
					"ocm-feedback-missing",
					`no WellKnownStatus feedback for: ${blind.join(", ")}`,
					input.campId,
				),
			],
		};
	}
	const unhealthy = resources
		.filter((r) => !r.observation.healthy)
		.map((r) => r.object.resource);
	if (unhealthy.length > 0) {
		return {
			status: ReconcileStatus.CONVERGING,
			resources: observed,
			reasons: [
				...reasons,
				reason(
					"kube-workload-not-ready",
					`not ready: ${unhealthy.join(", ")}`,
					input.campId,
				),
			],
		};
	}
	if (input.superseded > 0) {
		return {
			status: ReconcileStatus.CONVERGING,
			resources: observed,
			reasons: [
				...reasons,
				reason(
					"ocm-superseded-work-pending",
					`${input.superseded} superseded ManifestWork(s) still present`,
					input.campId,
				),
			],
		};
	}
	return { status: ReconcileStatus.CONVERGED, resources: observed, reasons };
}

type Indexed = Readonly<{ identity: string; resource: string; data: boolean }>;

function resourceIndex(work: JsonObject): readonly Indexed[] {
	const raw = stringAt(annotationsOf(work), RESOURCE_INDEX);
	if (raw === undefined) return [];
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse of an annotation this package wrote; shape checked below.
		parsed = JSON.parse(raw) as JsonValue;
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: Indexed[] = [];
	for (const row of parsed) {
		if (!Array.isArray(row) || row.length !== 3) continue;
		const [identity, resource, kind] = row;
		if (isJsonString(identity) && isJsonString(resource))
			out.push({ identity, resource, data: kind === "data" });
	}
	return out;
}

/**
 * The deleteOption a superseded work must carry before it is deleted:
 * resources the new work still declares survive by shared ownership; the
 * rest follow the DepartureAction (keep wins over DELETE).
 */
export function supersededDeleteOption(
	work: JsonObject,
	desired: readonly KubeObject[],
	action: DepartureAction,
	keep: ReadonlySet<string>,
): JsonObject {
	if (action === DepartureAction.ORPHAN) return { propagationPolicy: "Orphan" };
	const still = new Set(
		desired.map((o) =>
			identityOf({
				group: o.info.group,
				kind: o.info.kind,
				namespace: o.namespace,
				name: o.name,
			}),
		),
	);
	const rules: JsonObject[] = [];
	for (const manifest of arrayAt(
		objectAt(objectAt(work, "spec"), "workload"),
		"manifests",
	)) {
		if (!isJsonObject(manifest)) continue;
		const metadata = objectAt(manifest, "metadata");
		const apiVersion = stringAt(manifest, "apiVersion") ?? "";
		const group = apiVersion.includes("/")
			? apiVersion.slice(0, apiVersion.indexOf("/"))
			: "";
		const identity = identityOf({
			group,
			kind: stringAt(manifest, "kind") ?? "",
			namespace: stringAt(metadata, "namespace") ?? "",
			name: stringAt(metadata, "name") ?? "",
		});
		if (still.has(identity)) continue;
		const indexed = resourceIndex(work).find((i) => i.identity === identity);
		const kept = indexed !== undefined && keep.has(indexed.resource);
		const data =
			indexed?.data ?? stringAt(manifest, "kind") === "PersistentVolumeClaim";
		if (!kept && (action === DepartureAction.DELETE || !data)) continue;
		const plural = pluralOf(work, identity);
		rules.push({
			group,
			resource: plural,
			...(stringAt(metadata, "namespace") !== undefined
				? { namespace: stringAt(metadata, "namespace") ?? "" }
				: undefined),
			name: stringAt(metadata, "name") ?? "",
		});
	}
	return rules.length === 0
		? { propagationPolicy: "Foreground" }
		: {
				propagationPolicy: "SelectivelyOrphan",
				selectivelyOrphans: { orphaningRules: rules },
			};
}

function pluralOf(work: JsonObject, identity: string): string {
	for (const entry of arrayAt(
		objectAt(work, "status").resourceStatus ?? {},
		"manifests",
	)) {
		const meta = objectAt(entry, "resourceMeta");
		const id = identityOf({
			group: stringAt(meta, "group") ?? "",
			kind: stringAt(meta, "kind") ?? "",
			namespace: stringAt(meta, "namespace") ?? "",
			name: stringAt(meta, "name") ?? "",
		});
		const resource = stringAt(meta, "resource");
		if (id === identity && resource !== undefined) return resource;
	}
	const kind = identity.split("/")[1] ?? "";
	return `${kind.toLowerCase()}s`;
}

function abortIfNeeded(input: RealizeInput, ctx: CdContext): void {
	input.signal.throwIfAborted();
	ctx.signal?.throwIfAborted();
}

export function ocmRealizer(deps: OcmRealizerDeps): Realizer {
	const defaultNamespace =
		deps.defaultNamespace ?? KUBE_FLEET_DEFAULTS.defaultNamespace;
	const { config } = deps;

	async function pass(
		mode: "converge" | "observe",
		input: RealizeInput,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord> {
		abortIfNeeded(input, ctx);
		const meter = createMeter(deps.telemetry, ctx.now);
		const started = ctx.now();
		const attributes = {
			realizer: "ocm",
			hub: config.hub.name,
			camp: input.campId,
		};
		const finish = async (
			record: ReconcileObservationRecord,
		): Promise<ReconcileObservationRecord> => {
			meter.count(KUBE_FLEET_METRICS.passes, {
				...attributes,
				mode,
				status: ReconcileStatus[record.status],
			});
			meter.histogram(KUBE_FLEET_METRICS.duration, ctx.now() - started, "ms", {
				...attributes,
				mode,
			});
			await meter.flush();
			return record;
		};
		const checked = preflight(input, config, defaultNamespace);
		if (!checked.ok)
			return finish(
				observation(input, ctx, ReconcileStatus.BLOCKED, [], checked.reasons),
			);
		const api = createKubeApi({
			hub: config.hub,
			http: deps.http,
			credentials: deps.credentials,
			now: ctx.now,
			meter,
		});
		try {
			const record = await run(
				mode,
				input,
				ctx,
				api,
				meter,
				checked.cluster,
				checked.objects,
			);
			return finish(record);
		} catch (error) {
			if (input.signal.aborted || ctx.signal?.aborted === true) throw error;
			return finish(
				blocked(
					input,
					ctx,
					error instanceof Error ? error : new Error(String(error)),
				),
			);
		}
	}

	async function run(
		mode: "converge" | "observe",
		input: RealizeInput,
		ctx: CdContext,
		api: KubeApi,
		meter: Meter,
		cluster: string,
		objects: readonly KubeObject[],
	): Promise<ReconcileObservationRecord> {
		const fields = (await deps.observeFields?.(input.campId)) ?? [];
		const keep = keepOf(input);
		const contentHash =
			input.desired.contentHash !== ""
				? input.desired.contentHash
				: input.resolved.contentHash;
		const desired = withIndex(
			renderManifestWork({
				campId: input.campId,
				cluster,
				setId: input.desired.setId,
				contentHash,
				fence: input.fence,
				reconcilerId: input.reconcilerId,
				objects,
				observeFields: fields,
				departure: config.departureAction,
				keep,
			}),
			objects,
		);
		const name = workName(input.campId, contentHash);
		const collection = worksPath(cluster);
		const selector = {
			labelSelector: `${HOBO_KEYS.camp}=${campSlug(input.campId)}`,
		};
		const items = objectsOf(
			arrayAt(await api.list(collection, selector), "items"),
		);
		const newer = items.find((item) => (fenceOf(item) ?? 0n) > input.fence);
		if (newer !== undefined)
			return observation(
				input,
				ctx,
				ReconcileStatus.BLOCKED,
				[],
				[
					reason(
						"stale-fence",
						`ManifestWork ${stringAt(objectAt(newer, "metadata"), "name") ?? ""} carries fence ${fenceOf(newer)}; ours is ${input.fence}`,
						input.campId,
					),
				],
			);
		let current = items.find(
			(item) => stringAt(objectAt(item, "metadata"), "name") === name,
		);
		const desiredManifestsDigest = digestOf(manifestsOf(objects));
		const desiredSpecDigest =
			stringAt(annotationsOf(desired), SPEC_DIGEST) ?? "";
		let superseded = items.filter(
			(item) => stringAt(objectAt(item, "metadata"), "name") !== name,
		);

		if (mode === "observe") {
			if (current === undefined)
				return observation(
					input,
					ctx,
					ReconcileStatus.DRIFTED,
					objects.map((o) =>
						resourceObservation({
							object: o,
							physicalId: physicalIdOf(cluster, o),
							outputsHash: "",
							healthy: false,
							driftKind: "deleted",
						}),
					),
					[
						reason(
							"ocm-work-missing",
							`ManifestWork ${name} is not on the hub`,
							input.campId,
						),
					],
				);
			const verdict = evaluateWork({
				campId: input.campId,
				cluster,
				objects,
				fields,
				status: parseWorkStatus(current),
				desiredManifestsDigest,
				superseded: superseded.length,
			});
			return observation(
				input,
				ctx,
				verdict.status,
				verdict.resources,
				verdict.reasons,
			);
		}

		const path = `${collection}/${encodeURIComponent(name)}`;
		if (current === undefined) {
			abortIfNeeded(input, ctx);
			current = await api.create(collection, desired);
			meter.count(KUBE_FLEET_METRICS.mutations, {
				realizer: "ocm",
				verb: "create",
			});
		} else {
			const status = parseWorkStatus(current);
			const specChanged =
				status.manifestsDigest !== desiredManifestsDigest ||
				stringAt(annotationsOf(current), SPEC_DIGEST) !== desiredSpecDigest;
			const fenceChanged = fenceOf(current) !== input.fence;
			if (specChanged || fenceChanged) {
				abortIfNeeded(input, ctx);
				const metadata = objectAt(desired, "metadata");
				current = await api.replace(path, {
					...desired,
					metadata: { ...metadata, resourceVersion: status.resourceVersion },
				});
				meter.count(KUBE_FLEET_METRICS.mutations, {
					realizer: "ocm",
					verb: "update",
				});
			}
		}
		const verdict = evaluateWork({
			campId: input.campId,
			cluster,
			objects,
			fields,
			status: parseWorkStatus(current),
			desiredManifestsDigest,
			superseded: 0,
		});
		if (verdict.status !== ReconcileStatus.CONVERGED || superseded.length === 0)
			return observation(
				input,
				ctx,
				verdict.status,
				verdict.resources,
				verdict.reasons,
			);
		// Make before break: the new work is observed Applied and Available.
		for (const old of superseded) {
			abortIfNeeded(input, ctx);
			const oldName = stringAt(objectAt(old, "metadata"), "name") ?? "";
			const oldPath = `${collection}/${encodeURIComponent(oldName)}`;
			const option = supersededDeleteOption(
				old,
				objects,
				config.departureAction,
				keep,
			);
			if (
				digestOf(objectAt(old, "spec").deleteOption ?? null) !==
				digestOf(option)
			) {
				await api.replace(oldPath, {
					...old,
					spec: { ...objectAt(old, "spec"), deleteOption: option },
				});
				meter.count(KUBE_FLEET_METRICS.mutations, {
					realizer: "ocm",
					verb: "update",
				});
			}
			await api.remove(oldPath, "Background");
			meter.count(KUBE_FLEET_METRICS.mutations, {
				realizer: "ocm",
				verb: "delete",
			});
		}
		superseded = objectsOf(
			arrayAt(await api.list(collection, selector), "items"),
		).filter((item) => stringAt(objectAt(item, "metadata"), "name") !== name);
		const after = evaluateWork({
			campId: input.campId,
			cluster,
			objects,
			fields,
			status: parseWorkStatus(current),
			desiredManifestsDigest,
			superseded: superseded.length,
		});
		return observation(
			input,
			ctx,
			after.status,
			after.resources,
			after.reasons,
		);
	}

	return Object.freeze({
		converge: (input: RealizeInput, ctx: CdContext) =>
			pass("converge", input, ctx),
		observe: (input: RealizeInput, ctx: CdContext) =>
			pass("observe", input, ctx),
	});
}
