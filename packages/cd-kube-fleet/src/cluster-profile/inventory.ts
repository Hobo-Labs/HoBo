// `clusterProfileInventory` — list and watch ClusterProfiles over
// HttpTransport and present them as OBSERVE_ONLY Camps.
//
// - `list` reads every profile (paged with `continue`), parses each into an
//   ImportedCamp or a skip reason, and returns the list's resourceVersion.
// - `watch` resumes from that resourceVersion with bounded watch requests
//   (`timeoutSeconds`, bookmarks). A 410 Gone re-lists and yields a RESYNC
//   diff, so a consumer never misses a deletion.
// - `topology()` is a `TopologyReader` over the last state; `publish` feeds
//   conditions and claims into `CampInventory.observe` (claims narrow, never
//   grant); `observation` reports a posture-evaluable OBSERVED record.
// - `access` resolves an access provider's credential host-side for one use;
//   the token never enters a record, a log or telemetry.
import { create } from "@bufbuild/protobuf";
import {
	type CampId,
	type CampInventory,
	type CampStatusRecord,
	type CdContext,
	ConditionStatus,
	type CredentialResolver,
	OBSERVE_ATTRIBUTES_LIMIT_BYTES,
	type Outcome,
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	ResourceObservationSchema,
	SignalSource,
	type TelemetrySink,
	type TopologyReader,
} from "@hobo/cd";
import { type HttpTransport, type JsonObject, stableDigest } from "@hobo/core";
import type { ClusterProfileImport } from "../config.js";
import { KubeFleetError, reason } from "../errors.js";
import { arrayAt, objectAt, objectsOf, stringAt } from "../json.js";
import { bearerFrom, createKubeApi, type WatchEvent } from "../kube/api.js";
import { createMeter, KUBE_FLEET_METRICS } from "../telemetry.js";
import {
	type ImportedCamp,
	parseClusterProfile,
	profilesPath,
} from "./parse.js";

export type ClusterProfileSnapshot = Readonly<{
	resourceVersion: string;
	camps: readonly ImportedCamp[];
	skipped: readonly ReasonRecord[];
}>;

export type ClusterProfileChange = Readonly<{
	type: "ADDED" | "MODIFIED" | "DELETED";
	campId: string;
	camp: ImportedCamp | undefined;
	/** True when the change comes from a re-list after the watch expired. */
	resync: boolean;
}>;

/** Host-side access to a member API. Held in memory for one use only. */
export type KubeClusterAccess = Readonly<{
	server: string;
	headers: Readonly<Record<string, string>>;
}>;

export interface ClusterProfileInventory {
	list(): Promise<ClusterProfileSnapshot>;
	watch(
		input: Readonly<{ signal: AbortSignal; resourceVersion?: string }>,
	): AsyncIterable<ClusterProfileChange>;
	/** Declared topology of the imported Camps (last list/watch state). */
	topology(): TopologyReader;
	/** Feed every imported Camp's conditions and claims to the inventory. */
	publish(
		inventory: CampInventory,
		ctx: CdContext,
	): Promise<readonly Outcome<CampStatusRecord>[]>;
	/** An OBSERVED record posture can evaluate (attributes trimmed to `fields`). */
	observation(
		campId: string,
		fields: readonly string[],
		ctx: CdContext,
	): Promise<ReconcileObservationRecord | undefined>;
	/** Resolve one access provider's credential for one scoped use. Never recorded. */
	access(campId: string, ctx: CdContext): Promise<KubeClusterAccess>;
}

export type ClusterProfileInventoryDeps = Readonly<{
	config: ClusterProfileImport;
	http: HttpTransport;
	credentials: CredentialResolver;
	now: () => number;
	telemetry?: TelemetrySink;
	/** Wait between watch retries after a transport failure (default: setTimeout). */
	delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}>;

const PAGE = 500;

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function selectorOf(config: ClusterProfileImport): string | undefined {
	const entries = Object.entries(config.labelSelector).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	return entries.length === 0
		? undefined
		: entries.map(([k, v]) => `${k}=${v}`).join(",");
}

export function clusterProfileInventory(
	deps: ClusterProfileInventoryDeps,
): ClusterProfileInventory {
	const { config, now } = deps;
	const delay = deps.delay ?? defaultDelay;
	const state = new Map<string, ImportedCamp>();
	const path = profilesPath(config.namespace);
	const selector = selectorOf(config);
	const iso = (): string => new Date(now()).toISOString();

	function api() {
		const meter = createMeter(deps.telemetry, now);
		return {
			kube: createKubeApi({
				hub: config.hub,
				http: deps.http,
				credentials: deps.credentials,
				now,
				meter,
			}),
			flush: () => meter.flush(),
			meter,
		};
	}

	function parseAll(items: readonly JsonObject[]) {
		const camps: ImportedCamp[] = [];
		const skipped: ReasonRecord[] = [];
		const seen = new Map<string, string>();
		const at = iso();
		const sorted = [...items].sort((a, b) =>
			`${stringAt(objectAt(a, "metadata"), "namespace") ?? ""}/${stringAt(objectAt(a, "metadata"), "name") ?? ""}`.localeCompare(
				`${stringAt(objectAt(b, "metadata"), "namespace") ?? ""}/${stringAt(objectAt(b, "metadata"), "name") ?? ""}`,
			),
		);
		for (const item of sorted) {
			const parsed = parseClusterProfile(item, config, at);
			if (!parsed.ok) {
				skipped.push(parsed.reason);
				continue;
			}
			const id = parsed.camp.topology.campId;
			const source = `${parsed.camp.record.profileNamespace}/${parsed.camp.record.profileName}`;
			const prior = seen.get(id);
			if (prior !== undefined) {
				skipped.push(
					reason(
						"clusterprofile-camp-collision",
						`${source} and ${prior} both map to Camp ${id}`,
						id,
					),
				);
				continue;
			}
			seen.set(id, source);
			camps.push(parsed.camp);
		}
		return { camps, skipped };
	}

	async function list(): Promise<ClusterProfileSnapshot> {
		const { kube, flush, meter } = api();
		try {
			const items: JsonObject[] = [];
			let token: string | undefined;
			let resourceVersion = "";
			do {
				const page = await kube.list(path, {
					limit: String(PAGE),
					...(selector !== undefined ? { labelSelector: selector } : undefined),
					...(token !== undefined ? { continue: token } : undefined),
				});
				items.push(...objectsOf(arrayAt(page, "items")));
				const meta = objectAt(page, "metadata");
				resourceVersion = stringAt(meta, "resourceVersion") ?? resourceVersion;
				const next = stringAt(meta, "continue");
				token = next === undefined || next === "" ? undefined : next;
			} while (token !== undefined);
			const { camps, skipped } = parseAll(items);
			state.clear();
			for (const camp of camps) state.set(camp.topology.campId, camp);
			meter.gauge(KUBE_FLEET_METRICS.profiles, camps.length, {
				hub: config.hub.name,
			});
			if (skipped.length > 0)
				meter.count(
					KUBE_FLEET_METRICS.skipped,
					{ hub: config.hub.name },
					skipped.length,
				);
			return Object.freeze({
				resourceVersion,
				camps: Object.freeze(camps),
				skipped: Object.freeze(skipped),
			});
		} finally {
			await flush();
		}
	}

	async function* watch(
		input: Readonly<{ signal: AbortSignal; resourceVersion?: string }>,
	): AsyncIterable<ClusterProfileChange> {
		let resourceVersion = input.resourceVersion;
		let failures = 0;
		while (!input.signal.aborted) {
			if (resourceVersion === undefined) {
				const before = new Map(state);
				const snapshot = await list();
				resourceVersion = snapshot.resourceVersion;
				for (const [id, camp] of state) {
					const prior = before.get(id);
					if (prior === undefined)
						yield { type: "ADDED", campId: id, camp, resync: true };
					else if (prior.record.resourceVersion !== camp.record.resourceVersion)
						yield { type: "MODIFIED", campId: id, camp, resync: true };
				}
				for (const id of before.keys())
					if (!state.has(id))
						yield {
							type: "DELETED",
							campId: id,
							camp: undefined,
							resync: true,
						};
				continue;
			}
			const { kube, flush, meter } = api();
			let events: readonly WatchEvent[];
			try {
				events = await kube.watch(path, {
					resourceVersion,
					allowWatchBookmarks: "true",
					timeoutSeconds: String(config.watchTimeoutSeconds),
					...(selector !== undefined ? { labelSelector: selector } : undefined),
				});
				failures = 0;
			} catch (error) {
				if (error instanceof KubeFleetError && error.status === 410) {
					meter.count(KUBE_FLEET_METRICS.relists, { hub: config.hub.name });
					await flush();
					resourceVersion = undefined;
					continue;
				}
				await flush();
				if (
					!(error instanceof KubeFleetError) ||
					error.code !== "kube-unavailable"
				)
					throw error;
				failures += 1;
				await delay(
					Math.min(1000 * 2 ** Math.min(failures - 1, 9), 600_000),
					input.signal,
				);
				continue;
			}
			await flush();
			for (const event of events) {
				const rv = stringAt(
					objectAt(event.object, "metadata"),
					"resourceVersion",
				);
				if (rv !== undefined) resourceVersion = rv;
				if (event.type === "BOOKMARK") continue;
				const parsed = parseClusterProfile(event.object, config, iso());
				if (!parsed.ok) continue;
				const id = parsed.camp.topology.campId;
				if (event.type === "DELETED") {
					state.delete(id);
					yield { type: "DELETED", campId: id, camp: undefined, resync: false };
				} else {
					const type = state.has(id) ? "MODIFIED" : "ADDED";
					state.set(id, parsed.camp);
					yield { type, campId: id, camp: parsed.camp, resync: false };
				}
			}
		}
	}

	const topology: TopologyReader = Object.freeze({
		async camps() {
			return Object.freeze(
				[...state.values()]
					.map((c) => c.topology)
					.sort((a, b) => a.campId.localeCompare(b.campId)),
			);
		},
		async camp(campId: CampId) {
			return state.get(campId)?.topology;
		},
	});

	return Object.freeze({
		list,
		watch,
		topology: () => topology,
		async publish(inventory: CampInventory, ctx: CdContext) {
			const out: Outcome<CampStatusRecord>[] = [];
			for (const camp of [...state.values()].sort((a, b) =>
				a.topology.campId.localeCompare(b.topology.campId),
			)) {
				out.push(
					await inventory.observe(
						{
							campId: camp.topology.campId,
							source: SignalSource.HEALTH_SOURCE,
							conditions: camp.conditions,
							claims: camp.claims,
						},
						ctx,
					),
				);
			}
			return Object.freeze(out);
		},
		async observation(
			campId: string,
			fields: readonly string[],
			ctx: CdContext,
		) {
			const camp = state.get(campId);
			if (camp === undefined) return undefined;
			const attributes: Record<string, string> = {};
			const reasons: ReasonRecord[] = [];
			let bytes = 0;
			for (const field of [...new Set(fields)].sort()) {
				const value = camp.attributes[field];
				if (value === undefined) continue;
				const size = field.length + value.length;
				if (bytes + size > OBSERVE_ATTRIBUTES_LIMIT_BYTES) {
					reasons.push(
						reason(
							"kube-attribute-unobservable",
							`${field} exceeds the ${OBSERVE_ATTRIBUTES_LIMIT_BYTES}-byte attribute budget`,
							campId,
						),
					);
					continue;
				}
				bytes += size;
				attributes[field] = value;
			}
			return create(ReconcileObservationRecordSchema, {
				campId,
				setId: "",
				reconcilerId: "",
				fenceToken: "",
				status: ReconcileStatus.OBSERVED,
				resources: [
					create(ResourceObservationSchema, {
						resource: "cluster",
						physicalId: `clusterprofile:${config.hub.name}/${camp.record.profileNamespace}/${camp.record.profileName}`,
						outputsHash: stableDigest(camp.attributes),
						healthy: camp.conditions.every(
							(c) => c.status !== ConditionStatus.FALSE,
						),
						driftKind: "",
						kind: "kubernetes-cluster",
						classification: "",
						attributes,
						retained: [],
					}),
				],
				reasons,
				observedAt: new Date(ctx.now()).toISOString(),
				claims: [...camp.claims],
				handover: {},
			});
		},
		async access(campId: string, ctx: CdContext) {
			const camp = state.get(campId);
			if (camp === undefined)
				throw new KubeFleetError(
					"clusterprofile-unknown",
					`Camp ${campId} is not an imported ClusterProfile`,
				);
			const provider = camp.access.find(
				(p) => p.server !== undefined && p.server.startsWith("https://"),
			);
			if (provider === undefined || provider.server === undefined)
				throw new KubeFleetError(
					"clusterprofile-access-missing",
					`${camp.record.profileNamespace}/${camp.record.profileName} has no https access provider`,
				);
			const ref = `clusterprofile/${camp.record.profileNamespace}/${camp.record.profileName}/${provider.name}`;
			const resolved = await deps.credentials.resolve(
				ref,
				`kube-exec:${provider.name}`,
			);
			const token = bearerFrom(resolved, ref, ctx.now());
			return Object.freeze({
				server: provider.server,
				headers: Object.freeze({ authorization: `Bearer ${token}` }),
			});
		},
	});
}
