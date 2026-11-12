// An in-memory Kubernetes API server behind HttpTransport, with the two hub
// controllers this package relies on simulated: the OCM work agent (applies
// ManifestWorks and reports conditions + status feedback) and the Karmada
// binding controller (binds templates selected by a PropagationPolicy to
// its clusters and aggregates member status). Every request is logged so
// tests can prove which calls were (and were not) made.
import type {
	JsonObject,
	JsonValue,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";

export type Logged = Readonly<{ method: string; path: string; query: string; body?: JsonValue; authorization?: string }>;

type Key = string;

function parsePath(path: string): { group: string; version: string; resource: string; namespace: string; name: string } | undefined {
	const parts = path.split("/").filter((p) => p !== "").map(decodeURIComponent);
	let i = 0;
	let group = "";
	let version = "";
	if (parts[0] === "api") {
		version = parts[1] ?? "";
		i = 2;
	} else if (parts[0] === "apis") {
		group = parts[1] ?? "";
		version = parts[2] ?? "";
		i = 3;
	} else return undefined;
	let namespace = "";
	if (parts[i] === "namespaces" && parts.length > i + 2) {
		namespace = parts[i + 1] ?? "";
		i += 2;
	}
	const resource = parts[i] ?? "";
	const name = parts[i + 1] ?? "";
	return { group, version, resource, namespace, name };
}

function clone<T extends JsonValue>(value: T): T {
	// SAFETY: test-only deep copy of a JSON value.
	return JSON.parse(JSON.stringify(value)) as T;
}

function meta(object: JsonObject): Record<string, JsonValue> {
	// SAFETY: test fake mutates metadata it owns.
	return object.metadata as Record<string, JsonValue>;
}

export type FakeHubOptions = Readonly<{
	token?: string;
	/** Fail every request with this status (outage simulation). */
	failWith?: number;
}>;

export class FakeHub {
	readonly log: Logged[] = [];
	readonly objects = new Map<Key, JsonObject>();
	private rv = 100;
	token: string;
	failWith: number | undefined;
	/** Watch responses queued for the next watch requests (NDJSON bodies or a status). */
	readonly watchQueue: Array<{ status: number; events?: readonly JsonObject[] }> = [];

	constructor(options: FakeHubOptions = {}) {
		this.token = options.token ?? "hub-token";
		this.failWith = options.failWith;
	}

	private key(group: string, resource: string, namespace: string, name: string): Key {
		return `${group}|${resource}|${namespace}|${name}`;
	}

	nextRv(): string {
		this.rv += 1;
		return String(this.rv);
	}

	put(group: string, resource: string, object: JsonObject): JsonObject {
		const m = meta(object);
		const stored = clone(object);
		const sm = meta(stored);
		sm.resourceVersion = this.nextRv();
		if (sm.generation === undefined) sm.generation = 1;
		this.objects.set(this.key(group, resource, String(m.namespace ?? ""), String(m.name)), stored);
		return stored;
	}

	find(group: string, resource: string, namespace: string, name: string): JsonObject | undefined {
		return this.objects.get(this.key(group, resource, namespace, name));
	}

	all(group: string, resource: string): JsonObject[] {
		const out: JsonObject[] = [];
		for (const [key, value] of this.objects) {
			const [g, r] = key.split("|");
			if (g === group && r === resource) out.push(value);
		}
		return out.sort((a, b) => `${meta(a).namespace}/${meta(a).name}`.localeCompare(`${meta(b).namespace}/${meta(b).name}`));
	}

	mutatingCalls(): Logged[] {
		return this.log.filter((l) => l.method !== "GET");
	}

	readonly transport = async (request: TransportRequest): Promise<TransportResponse> => {
		const url = new URL(request.url);
		const body = request.body === undefined ? undefined : (JSON.parse(request.body) as JsonValue);
		this.log.push({
			method: request.method,
			path: url.pathname,
			query: url.search,
			...(body !== undefined ? { body } : undefined),
			...(request.headers.authorization !== undefined ? { authorization: request.headers.authorization } : undefined),
		});
		const respond = (status: number, value?: JsonValue): TransportResponse => ({
			status,
			headers: { "content-type": "application/json" },
			body: value === undefined ? "" : JSON.stringify(value),
		});
		if (this.failWith !== undefined) return respond(this.failWith, { kind: "Status", message: "injected" });
		if (request.headers.authorization !== `Bearer ${this.token}`) return respond(401, { kind: "Status", message: "Unauthorized" });
		const p = parsePath(url.pathname);
		if (p === undefined) return respond(404, { kind: "Status", message: "not found" });
		const { group, resource, namespace, name } = p;
		if (request.method === "GET" && url.searchParams.get("watch") === "1") {
			const next = this.watchQueue.shift();
			if (next === undefined) return { status: 200, headers: {}, body: "" };
			if (next.status !== 200) return respond(next.status, { kind: "Status", code: next.status, message: "gone" });
			return { status: 200, headers: {}, body: (next.events ?? []).map((e) => JSON.stringify(e)).join("\n") };
		}
		if (request.method === "GET" && name === "") {
			const selector = url.searchParams.get("labelSelector");
			const want = selector === null ? [] : selector.split(",").map((s) => s.split("="));
			const items = this.all(group, resource).filter((o) => {
				const m = meta(o);
				if (namespace !== "" && m.namespace !== namespace) return false;
				const labels = (m.labels ?? {}) as Record<string, string>;
				return want.every(([k, v]) => k !== undefined && labels[k] === v);
			});
			return respond(200, { kind: "List", metadata: { resourceVersion: String(this.rv) }, items: clone(items) });
		}
		const existing = this.find(group, resource, namespace, name);
		if (request.method === "GET") return existing === undefined ? respond(404, { kind: "Status", message: "not found" }) : respond(200, clone(existing));
		if (request.method === "POST") {
			if (body === undefined || typeof body !== "object" || body === null || Array.isArray(body)) return respond(400);
			const m = meta(body);
			if (this.find(group, resource, namespace, String(m.name)) !== undefined) return respond(409, { kind: "Status", message: "AlreadyExists" });
			const stored = this.put(group, resource, { ...body, metadata: { ...m, namespace, generation: 1 } });
			this.onChange(group, resource, stored);
			return respond(201, clone(stored));
		}
		if (request.method === "PUT") {
			if (existing === undefined) return respond(404, { kind: "Status", message: "not found" });
			if (body === undefined || typeof body !== "object" || body === null || Array.isArray(body)) return respond(400);
			const m = meta(body);
			if (m.resourceVersion !== meta(existing).resourceVersion) return respond(409, { kind: "Status", message: "Conflict" });
			const specChanged = JSON.stringify(body.spec ?? null) !== JSON.stringify(existing.spec ?? null);
			const generation = Number(meta(existing).generation ?? 1) + (specChanged ? 1 : 0);
			const stored = this.put(group, resource, { ...body, metadata: { ...m, namespace, generation }, ...(existing.status !== undefined ? { status: existing.status } : undefined) });
			this.onChange(group, resource, stored);
			return respond(200, clone(stored));
		}
		if (request.method === "DELETE") {
			if (existing === undefined) return respond(404, { kind: "Status", message: "not found" });
			this.objects.delete(this.key(group, resource, namespace, name));
			this.onDelete(group, resource, existing);
			return respond(200, { kind: "Status", status: "Success" });
		}
		return respond(405);
	};

	protected onChange(_group: string, _resource: string, _object: JsonObject): void {}
	protected onDelete(_group: string, _resource: string, _object: JsonObject): void {}
}

const WORK = "work.open-cluster-management.io";

/** OCM hub + klusterlet work agents. */
export class FakeOcmHub extends FakeHub {
	/** Applied resources per cluster: identity → owning work names. */
	readonly applied = new Map<string, Map<string, Set<string>>>();
	/** Manifests the agent must report Applied=False for (identity → message). */
	readonly rejects = new Map<string, string>();
	/** Resources orphaned by a deleted work (cluster/identity). */
	readonly orphaned: string[] = [];
	readyReplicas: number | undefined;

	works(cluster?: string): JsonObject[] {
		return this.all(WORK, "manifestworks").filter((w) => cluster === undefined || meta(w).namespace === cluster);
	}

	/** Run the work agent of one cluster (or all): apply and report status. */
	agent(cluster?: string): void {
		for (const work of this.works(cluster)) {
			const m = meta(work);
			const ns = String(m.namespace);
			const generation = Number(m.generation ?? 1);
			const manifests = ((work.spec as JsonObject).workload as JsonObject).manifests as JsonObject[];
			const configs = ((work.spec as JsonObject).manifestConfigs ?? []) as JsonObject[];
			const clusterApplied = this.applied.get(ns) ?? new Map<string, Set<string>>();
			this.applied.set(ns, clusterApplied);
			let anyFailed = false;
			const statuses = manifests.map((manifest, ordinal) => {
				const mm = manifest.metadata as JsonObject;
				const apiVersion = String(manifest.apiVersion);
				const group = apiVersion.includes("/") ? apiVersion.split("/")[0] ?? "" : "";
				const identity = `${group}/${String(manifest.kind)}/${String(mm.namespace ?? "")}/${String(mm.name)}`;
				const reject = this.rejects.get(identity);
				if (reject === undefined) {
					const owners = clusterApplied.get(identity) ?? new Set<string>();
					owners.add(String(m.name));
					clusterApplied.set(identity, owners);
				} else anyFailed = true;
				const config = configs.find((c) => {
					const id = c.resourceIdentifier as JsonObject;
					return id.name === mm.name && (id.namespace ?? "") === (mm.namespace ?? "");
				});
				const values: JsonObject[] = [];
				for (const rule of ((config?.feedbackRules ?? []) as JsonObject[])) {
					if (rule.type === "WellKnownStatus" && manifest.kind === "Deployment") {
						const replicas = Number(((manifest.spec as JsonObject).replicas as number | undefined) ?? 1);
						values.push({ name: "Replicas", fieldValue: { type: "Integer", integer: replicas } });
						values.push({ name: "ReadyReplicas", fieldValue: { type: "Integer", integer: this.readyReplicas ?? replicas } });
					}
					if (rule.type === "JSONPaths") {
						for (const jp of rule.jsonPaths as JsonObject[]) {
							if (jp.path === ".observedGeneration") values.push({ name: String(jp.name), fieldValue: { type: "Integer", integer: 1 } });
						}
					}
				}
				const status = reject === undefined ? "True" : "False";
				return {
					resourceMeta: { ordinal, group, version: apiVersion.split("/").at(-1) ?? "", kind: manifest.kind ?? "", resource: `${String(manifest.kind).toLowerCase()}s`, name: mm.name ?? "", namespace: mm.namespace ?? "" },
					conditions: [
						{ type: "Applied", status, reason: reject === undefined ? "AppliedManifestComplete" : "AppliedManifestFailed", message: reject ?? "Apply manifest complete", observedGeneration: generation },
						{ type: "Available", status, reason: "ResourceAvailable", message: "", observedGeneration: generation },
					],
					...(values.length > 0 ? { statusFeedback: { values } } : undefined),
				};
			});
			const workStatus = anyFailed ? "False" : "True";
			this.objects.set(`${WORK}|manifestworks|${ns}|${String(m.name)}`, {
				...work,
				status: {
					conditions: [
						{ type: "Applied", status: workStatus, reason: anyFailed ? "AppliedManifestWorkFailed" : "AppliedManifestWorkComplete", message: "", observedGeneration: generation },
						{ type: "Available", status: workStatus, reason: "ResourcesAvailable", message: "", observedGeneration: generation },
					],
					resourceStatus: { manifests: statuses },
				},
			});
		}
	}

	protected override onDelete(group: string, resource: string, object: JsonObject): void {
		if (group !== WORK || resource !== "manifestworks") return;
		const m = meta(object);
		const ns = String(m.namespace);
		const clusterApplied = this.applied.get(ns);
		if (clusterApplied === undefined) return;
		const option = (object.spec as JsonObject).deleteOption as JsonObject | undefined;
		const policy = option?.propagationPolicy ?? "Foreground";
		const rules = (((option?.selectivelyOrphans as JsonObject | undefined)?.orphaningRules ?? []) as JsonObject[]);
		for (const [identity, owners] of clusterApplied) {
			if (!owners.delete(String(m.name)) || owners.size > 0) continue;
			const [, , rns, rname] = identity.split("/");
			const orphan =
				policy === "Orphan" ||
				(policy === "SelectivelyOrphan" && rules.some((r) => r.name === rname && (r.namespace ?? "") === rns));
			clusterApplied.delete(identity);
			if (orphan) this.orphaned.push(`${ns}:${identity}`);
		}
	}

	/** Identities present on a cluster (applied or orphaned). */
	present(cluster: string): string[] {
		return [...(this.applied.get(cluster)?.keys() ?? [])].sort();
	}
}

const POLICY = "policy.karmada.io";
const BINDING = "work.karmada.io";

/** Karmada control plane + binding controller. */
export class FakeKarmada extends FakeHub {
	/** Member clusters a binding controller would (wrongly) add, for violation tests. */
	extraCluster: string | undefined;
	health = "Healthy";
	/** Member resources left behind because their policy preserved them. */
	readonly preserved: string[] = [];

	policies(): JsonObject[] {
		return this.all(POLICY, "propagationpolicies");
	}

	bindings(): JsonObject[] {
		return this.all(BINDING, "resourcebindings");
	}

	templates(): JsonObject[] {
		const out: JsonObject[] = [];
		for (const [key, value] of this.objects) {
			const [g] = key.split("|");
			if (g !== POLICY && g !== BINDING) out.push(value);
		}
		return out;
	}

	/** Run the detector + binding controller: bind selected templates and report member status. */
	schedule(): void {
		for (const policy of this.policies()) {
			const spec = policy.spec as JsonObject;
			const clusters = (((spec.placement as JsonObject).clusterAffinity as JsonObject).clusterNames ?? []) as string[];
			const targets = this.extraCluster === undefined ? clusters : [...clusters, this.extraCluster];
			for (const selector of spec.resourceSelectors as JsonObject[]) {
				const template = this.templates().find((t) => {
					const m = meta(t);
					return t.kind === selector.kind && m.name === selector.name && m.namespace === selector.namespace;
				});
				if (template === undefined) continue;
				const m = meta(template);
				const name = `${String(m.name)}-${String(template.kind).toLowerCase()}`;
				const replicas = Number(((template.spec as JsonObject | undefined)?.replicas as number | undefined) ?? 1);
				this.objects.set(`${BINDING}|resourcebindings|${String(m.namespace)}|${name}`, {
					apiVersion: "work.karmada.io/v1alpha2",
					kind: "ResourceBinding",
					metadata: { name, namespace: m.namespace ?? "", resourceVersion: this.nextRv() },
					spec: {
						resource: { apiVersion: template.apiVersion ?? "", kind: template.kind ?? "", namespace: m.namespace ?? "", name: m.name ?? "", resourceVersion: m.resourceVersion ?? "" },
						clusters: targets.map((c) => ({ name: c })),
						preserveResourcesOnDeletion: spec.preserveResourcesOnDeletion ?? false,
					},
					status: {
						aggregatedStatus: targets.map((c) => ({ clusterName: c, applied: true, health: this.health, status: { replicas, readyReplicas: replicas, observedGeneration: 1 } })),
					},
				});
			}
		}
	}

	protected override onDelete(group: string, _resource: string, object: JsonObject): void {
		if (group === POLICY || group === BINDING) return;
		const m = meta(object);
		const name = `${String(m.name)}-${String(object.kind).toLowerCase()}`;
		const key = `${BINDING}|resourcebindings|${String(m.namespace)}|${name}`;
		const binding = this.objects.get(key);
		if (binding !== undefined) {
			if ((binding.spec as JsonObject).preserveResourcesOnDeletion === true) this.preserved.push(`${String(m.namespace)}/${String(m.name)}`);
			this.objects.delete(key);
		}
	}
}
