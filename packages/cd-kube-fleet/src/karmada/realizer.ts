// `karmadaRealizer(): Realizer` — Karmada as a transport (D26).
//
// Per Camp: resource templates on the Karmada control plane plus, per
// namespace, a PropagationPolicy pinned to the Camp's one member
// (`clusterAffinity.clusterNames: [<member>]`, `Duplicated`). Compute and data
// templates sit under separate policies so `preserveResourcesOnDeletion`
// follows the DepartureAction. Observation comes from the ResourceBinding's
// aggregated status; a binding naming any other cluster is a pinning
// violation, never accepted. No OverridePolicy is ever written.
//
// Pass order (each step only after the previous succeeded):
//   1. list this Camp's policies; refuse a newer fence (stale-fence);
//   2. read every desired template; refuse foreign ones (template-conflict);
//   3. delete templates the Set no longer declares (kept ones stay);
//   4. upsert the policies (before templates, so no other policy claims them);
//   5. create or replace templates whose content changed;
//   6. read bindings and verify.
import {
	type CampId,
	type CdContext,
	type CredentialResolver,
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
	isJsonString,
	objectAt,
	objectsOf,
	type StringMap,
	stringAt,
	valueAtPath,
} from "../json.js";
import { createKubeApi, type KubeApi } from "../kube/api.js";
import {
	campSlug,
	collectionPath,
	digestOf,
	fenceOf,
	HOBO_KEYS,
	type KubeObject,
	objectPath,
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
	bindingPath,
	indexOf,
	POLICIES_PATH,
	type PolicyClass,
	parseBinding,
	policiesPath,
	policyName,
	policyPreserves,
	renderPolicy,
	type Selected,
	selectedOf,
} from "./policy.js";

export type KarmadaRealizerDeps = Readonly<{
	config: RealizerConfig;
	http: HttpTransport;
	credentials: CredentialResolver;
	telemetry?: TelemetrySink;
	/** Posture attribute paths per Camp (PostureService.observeFields). */
	observeFields?: (campId: CampId) => Promise<readonly string[]>;
	defaultNamespace?: string;
}>;

function annotationsOf(object: JsonObject): JsonObject {
	return objectAt(objectAt(object, "metadata"), "annotations");
}

function labelsOf(object: JsonObject): JsonObject {
	return objectAt(objectAt(object, "metadata"), "labels");
}

function templateBody(o: KubeObject, input: RealizeInput): JsonObject {
	const metadata = objectAt(o.body, "metadata");
	return {
		...o.body,
		metadata: {
			...metadata,
			labels: {
				...objectAt(metadata, "labels"),
				[HOBO_KEYS.managedBy]: HOBO_KEYS.managedByValue,
				[HOBO_KEYS.camp]: campSlug(input.campId),
			},
			annotations: {
				...objectAt(metadata, "annotations"),
				[HOBO_KEYS.campId]: input.campId,
				[HOBO_KEYS.setId]: input.desired.setId,
				[HOBO_KEYS.manifestsDigest]: digestOf(o.body),
				[HOBO_KEYS.fence]: input.fence.toString(),
			},
		},
	};
}

function text(value: JsonValue | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	return isJsonString(value) ? value : JSON.stringify(value);
}

function attributesFor(
	template: JsonObject | undefined,
	memberStatus: JsonObject | undefined,
	fields: readonly string[],
): StringMap {
	const out: Record<string, string> = {};
	for (const field of fields) {
		const value = field.startsWith("status.")
			? valueAtPath(memberStatus, field.slice(7))
			: valueAtPath(template, field);
		const rendered = text(value);
		if (rendered !== undefined) out[field] = rendered;
	}
	return out;
}

type Classes = Map<string, Map<PolicyClass, Selected[]>>;

function abortIfNeeded(input: RealizeInput, ctx: CdContext): void {
	input.signal.throwIfAborted();
	ctx.signal?.throwIfAborted();
}

export function karmadaRealizer(deps: KarmadaRealizerDeps): Realizer {
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
			realizer: "karmada",
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
		const scoped = checked.objects.filter((o) => !o.info.namespaced);
		if (scoped.length > 0)
			return finish(
				observation(
					input,
					ctx,
					ReconcileStatus.BLOCKED,
					[],
					[
						reason(
							"karmada-cluster-scoped-unsupported",
							`cluster-scoped: ${scoped.map((o) => `${o.info.kind}/${o.name}`).join(", ")}`,
							input.campId,
						),
					],
				),
			);
		const api = createKubeApi({
			hub: config.hub,
			http: deps.http,
			credentials: deps.credentials,
			now: ctx.now,
			meter,
		});
		try {
			return finish(
				await run(
					mode,
					input,
					ctx,
					api,
					meter,
					checked.cluster,
					checked.objects,
				),
			);
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
		member: string,
		objects: readonly KubeObject[],
	): Promise<ReconcileObservationRecord> {
		const fields = (await deps.observeFields?.(input.campId)) ?? [];
		const keep = keepOf(input);
		const mutate = async <T>(
			verb: string,
			op: () => Promise<T>,
		): Promise<T> => {
			abortIfNeeded(input, ctx);
			const out = await op();
			meter.count(KUBE_FLEET_METRICS.mutations, { realizer: "karmada", verb });
			return out;
		};

		// 1. This Camp's policies, fence check.
		const policies = objectsOf(
			arrayAt(
				await api.list(POLICIES_PATH, {
					labelSelector: `${HOBO_KEYS.camp}=${campSlug(input.campId)}`,
				}),
				"items",
			),
		);
		const newer = policies.find((p) => (fenceOf(p) ?? 0n) > input.fence);
		if (newer !== undefined)
			return observation(
				input,
				ctx,
				ReconcileStatus.BLOCKED,
				[],
				[
					reason(
						"stale-fence",
						`PropagationPolicy ${stringAt(objectAt(newer, "metadata"), "name") ?? ""} carries fence ${fenceOf(newer)}; ours is ${input.fence}`,
						input.campId,
					),
				],
			);

		// 2. Desired templates: conflict and fence checks before any write.
		const templates = new Map<string, JsonObject | undefined>();
		for (const o of objects) {
			const existing = await api.get(objectPath(o));
			if (existing !== undefined) {
				if (
					stringAt(labelsOf(existing), HOBO_KEYS.camp) !==
					campSlug(input.campId)
				)
					return observation(
						input,
						ctx,
						ReconcileStatus.BLOCKED,
						[],
						[
							reason(
								"karmada-template-conflict",
								`${o.info.kind} ${o.namespace}/${o.name} belongs to ${stringAt(labelsOf(existing), HOBO_KEYS.camp) ?? "no HoBo Camp"}`,
								input.campId,
							),
						],
					);
				if ((fenceOf(existing) ?? 0n) > input.fence)
					return observation(
						input,
						ctx,
						ReconcileStatus.BLOCKED,
						[],
						[
							reason(
								"stale-fence",
								`${o.info.kind} ${o.namespace}/${o.name} carries fence ${fenceOf(existing)}`,
								input.campId,
							),
						],
					);
			}
			templates.set(o.resource, existing);
		}

		if (mode === "observe")
			return verify(
				input,
				ctx,
				api,
				member,
				objects,
				templates,
				fields,
				[],
				policies,
			);

		// 3. Remove templates the Set no longer declares.
		const desiredIds = new Set(objects.map((o) => selectedOf(o).identity));
		const carried: Classes = new Map();
		const reasons: ReasonRecord[] = [];
		for (const policy of policies) {
			const ns = stringAt(objectAt(policy, "metadata"), "namespace") ?? "";
			const cls: PolicyClass = (
				stringAt(objectAt(policy, "metadata"), "name") ?? ""
			).endsWith("-data")
				? "data"
				: "compute";
			for (const s of indexOf(policy)) {
				if (desiredIds.has(s.identity)) continue;
				if (keep.has(s.resource) && !policyPreserves(policy)) {
					reasons.push(
						reason(
							"karmada-keep-retained",
							`${s.kind} ${s.namespace}/${s.name} kept; its policy does not preserve member resources`,
							input.campId,
						),
					);
					const byClass = carried.get(ns) ?? new Map<PolicyClass, Selected[]>();
					byClass.set(cls, [...(byClass.get(cls) ?? []), s]);
					carried.set(ns, byClass);
					continue;
				}
				const group = s.apiVersion.includes("/")
					? s.apiVersion.slice(0, s.apiVersion.indexOf("/"))
					: "";
				const version = s.apiVersion.includes("/")
					? s.apiVersion.slice(s.apiVersion.indexOf("/") + 1)
					: s.apiVersion;
				const path = `${collectionPath({ group, version, kind: s.kind, resource: s.plural, namespaced: true }, s.namespace)}/${encodeURIComponent(s.name)}`;
				await mutate("delete", () => api.remove(path));
			}
		}

		// 4. Policies: one per namespace and class, pinned to the member.
		const wanted: Classes = new Map();
		for (const o of objects) {
			const byClass =
				wanted.get(o.namespace) ?? new Map<PolicyClass, Selected[]>();
			const cls: PolicyClass = o.data ? "data" : "compute";
			byClass.set(cls, [...(byClass.get(cls) ?? []), selectedOf(o)]);
			wanted.set(o.namespace, byClass);
		}
		for (const [ns, byClass] of carried) {
			const target = wanted.get(ns) ?? new Map<PolicyClass, Selected[]>();
			for (const [cls, list] of byClass)
				target.set(cls, [...(target.get(cls) ?? []), ...list]);
			wanted.set(ns, target);
		}
		const kept = new Set<string>();
		for (const [ns, byClass] of wanted) {
			for (const [cls, selected] of byClass) {
				const desired = renderPolicy({
					campId: input.campId,
					namespace: ns,
					cls,
					member,
					selected,
					action: config.departureAction,
					fence: input.fence,
					reconcilerId: input.reconcilerId,
				});
				const name = policyName(input.campId, cls);
				kept.add(`${ns}/${name}`);
				const existing = policies.find(
					(p) =>
						stringAt(objectAt(p, "metadata"), "namespace") === ns &&
						stringAt(objectAt(p, "metadata"), "name") === name,
				);
				if (existing === undefined) {
					await mutate("create", () => api.create(policiesPath(ns), desired));
				} else if (
					digestOf(objectAt(existing, "spec")) !==
						digestOf(objectAt(desired, "spec")) ||
					fenceOf(existing) !== input.fence ||
					stringAt(annotationsOf(existing), "hobo.dev/resource-index") !==
						stringAt(annotationsOf(desired), "hobo.dev/resource-index")
				) {
					const metadata = objectAt(desired, "metadata");
					await mutate("update", () =>
						api.replace(`${policiesPath(ns)}/${encodeURIComponent(name)}`, {
							...desired,
							metadata: {
								...metadata,
								resourceVersion:
									stringAt(objectAt(existing, "metadata"), "resourceVersion") ??
									"",
							},
						}),
					);
				}
			}
		}
		for (const policy of policies) {
			const ns = stringAt(objectAt(policy, "metadata"), "namespace") ?? "";
			const name = stringAt(objectAt(policy, "metadata"), "name") ?? "";
			if (!kept.has(`${ns}/${name}`))
				await mutate("delete", () =>
					api.remove(`${policiesPath(ns)}/${encodeURIComponent(name)}`),
				);
		}

		// 5. Templates.
		for (const o of objects) {
			const body = templateBody(o, input);
			const existing = templates.get(o.resource);
			if (existing === undefined) {
				templates.set(
					o.resource,
					await mutate("create", () =>
						api.create(collectionPath(o.info, o.namespace), body),
					),
				);
				continue;
			}
			const same =
				stringAt(annotationsOf(existing), HOBO_KEYS.manifestsDigest) ===
					digestOf(o.body) && fenceOf(existing) === input.fence;
			if (same) continue;
			const metadata = objectAt(body, "metadata");
			templates.set(
				o.resource,
				await mutate("update", () =>
					api.replace(objectPath(o), {
						...body,
						metadata: {
							...metadata,
							resourceVersion:
								stringAt(objectAt(existing, "metadata"), "resourceVersion") ??
								"",
						},
					}),
				),
			);
		}

		// 6. Observe.
		return verify(
			input,
			ctx,
			api,
			member,
			objects,
			templates,
			fields,
			reasons,
			undefined,
		);
	}

	async function verify(
		input: RealizeInput,
		ctx: CdContext,
		api: KubeApi,
		member: string,
		objects: readonly KubeObject[],
		templates: ReadonlyMap<string, JsonObject | undefined>,
		fields: readonly string[],
		carriedReasons: readonly ReasonRecord[],
		policies: readonly JsonObject[] | undefined,
	): Promise<ReconcileObservationRecord> {
		const reasons: ReasonRecord[] = [...carriedReasons];
		const resources: ResourceObservation[] = [];
		let status = ReconcileStatus.CONVERGED;
		const worse = (next: ReconcileStatus): void => {
			const rank = (s: ReconcileStatus): number =>
				s === ReconcileStatus.BLOCKED
					? 3
					: s === ReconcileStatus.DRIFTED
						? 2
						: s === ReconcileStatus.CONVERGING
							? 1
							: 0;
			if (rank(next) > rank(status)) status = next;
		};
		if (policies !== undefined) {
			// Observe mode: our policies must still pin exactly the member.
			for (const p of policies) {
				const names = arrayAt(
					objectAt(
						objectAt(objectAt(p, "spec"), "placement"),
						"clusterAffinity",
					),
					"clusterNames",
				);
				if (names.length !== 1 || names[0] !== member) {
					worse(ReconcileStatus.DRIFTED);
					reasons.push(
						reason(
							"karmada-pinning-violated",
							`PropagationPolicy ${stringAt(objectAt(p, "metadata"), "name") ?? ""} targets ${JSON.stringify(names)}`,
							input.campId,
						),
					);
				}
			}
		}
		for (const o of objects) {
			const template = templates.get(o.resource);
			const physicalId = `karmada:${member}/${selectedOf(o).identity}`;
			if (template === undefined) {
				worse(ReconcileStatus.DRIFTED);
				reasons.push(
					reason(
						"karmada-binding-pending",
						`template ${o.info.kind} ${o.namespace}/${o.name} is missing`,
						input.campId,
					),
				);
				resources.push(
					resourceObservation({
						object: o,
						physicalId,
						outputsHash: "",
						healthy: false,
						driftKind: "deleted",
					}),
				);
				continue;
			}
			if (
				stringAt(annotationsOf(template), HOBO_KEYS.manifestsDigest) !==
				digestOf(o.body)
			) {
				worse(ReconcileStatus.DRIFTED);
				reasons.push(
					reason(
						"karmada-binding-pending",
						`template ${o.info.kind} ${o.namespace}/${o.name} does not hold the Set's content`,
						input.campId,
					),
				);
				resources.push(
					resourceObservation({
						object: o,
						physicalId,
						outputsHash: "",
						healthy: false,
						driftKind: "modified",
					}),
				);
				continue;
			}
			const raw = await api.get(bindingPath(o));
			const templateVersion =
				stringAt(objectAt(template, "metadata"), "resourceVersion") ?? "";
			if (raw === undefined) {
				worse(ReconcileStatus.CONVERGING);
				reasons.push(
					reason(
						"karmada-binding-pending",
						`no ResourceBinding for ${o.info.kind} ${o.namespace}/${o.name} yet`,
						input.campId,
					),
				);
				resources.push(
					resourceObservation({
						object: o,
						physicalId,
						outputsHash: "",
						healthy: false,
					}),
				);
				continue;
			}
			const binding = parseBinding(raw);
			const foreign = [
				...binding.clusters,
				...binding.members.map((m) => m.cluster),
			].filter((c) => c !== member);
			if (foreign.length > 0) {
				worse(ReconcileStatus.BLOCKED);
				reasons.push(
					reason(
						"karmada-pinning-violated",
						`${o.info.kind} ${o.namespace}/${o.name} bound to ${[...new Set(foreign)].sort().join(", ")}`,
						input.campId,
					),
				);
				resources.push(
					resourceObservation({
						object: o,
						physicalId,
						outputsHash: "",
						healthy: false,
					}),
				);
				continue;
			}
			const memberStatus = binding.members.find((m) => m.cluster === member);
			const current =
				binding.resourceVersion === "" ||
				binding.resourceVersion === templateVersion;
			const healthy =
				memberStatus?.applied === true && memberStatus.health === "Healthy";
			resources.push(
				resourceObservation({
					object: o,
					physicalId,
					outputsHash:
						memberStatus === undefined ? "" : digestOf(memberStatus.status),
					healthy: healthy && current,
					attributes: attributesFor(template, memberStatus?.status, fields),
				}),
			);
			if (
				!current ||
				binding.clusters.length === 0 ||
				memberStatus === undefined
			) {
				worse(ReconcileStatus.CONVERGING);
				reasons.push(
					reason(
						"karmada-binding-pending",
						`${o.info.kind} ${o.namespace}/${o.name} not bound at the current revision`,
						input.campId,
					),
				);
			} else if (
				memberStatus.applied === false &&
				memberStatus.appliedMessage !== ""
			) {
				worse(ReconcileStatus.BLOCKED);
				reasons.push(
					reason(
						"karmada-member-unhealthy",
						`${o.info.kind} ${o.namespace}/${o.name}: ${memberStatus.appliedMessage}`,
						input.campId,
					),
				);
			} else if (!healthy) {
				worse(ReconcileStatus.CONVERGING);
				reasons.push(
					reason(
						"karmada-member-unhealthy",
						`${o.info.kind} ${o.namespace}/${o.name} is ${memberStatus.health}`,
						input.campId,
					),
				);
			}
		}
		return observation(input, ctx, status, resources, reasons);
	}

	return Object.freeze({
		converge: (input: RealizeInput, ctx: CdContext) =>
			pass("converge", input, ctx),
		observe: (input: RealizeInput, ctx: CdContext) =>
			pass("observe", input, ctx),
	});
}
