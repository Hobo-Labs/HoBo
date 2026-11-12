// An in-memory Kubernetes API server behind HttpTransport, with the two hub
// controllers this package relies on simulated: the OCM work agent (applies
// ManifestWorks and reports conditions + status feedback) and the Karmada
// binding controller (binds templates selected by a PropagationPolicy to
// its clusters and aggregates member status). Every request is logged so
// tests can prove which calls were (and were not) made. Stored objects are
// read through the package's JSON guards, never cast.
import type {
	JsonObject,
	JsonValue,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	arrayAt,
	isJsonObject,
	numberAt,
	objectAt,
	objectsOf,
	parseJsonText,
	stringAt,
} from "../src/json.js";

export type Logged = Readonly<{
	method: string;
	path: string;
	query: string;
	body?: JsonValue;
	authorization?: string;
}>;

type Key = string;

type ParsedPath = Readonly<{
	group: string;
	resource: string;
	namespace: string;
	name: string;
}>;

function parsePath(path: string): ParsedPath | undefined {
	const parts = path
		.split("/")
		.filter((p) => p !== "")
		.map(decodeURIComponent);
	let i = 0;
	let group = "";
	if (parts[0] === "api") i = 2;
	else if (parts[0] === "apis") {
		group = parts[1] ?? "";
		i = 3;
	} else return undefined;
	let namespace = "";
	if (parts[i] === "namespaces" && parts.length > i + 2) {
		namespace = parts[i + 1] ?? "";
		i += 2;
	}
	return { group, resource: parts[i] ?? "", namespace, name: parts[i + 1] ?? "" };
}

function clone(value: JsonObject): JsonObject {
	const copy = parseJsonText(JSON.stringify(value));
	return isJsonObject(copy) ? copy : {};
}

const metaOf = (object: JsonValue | undefined): JsonObject =>
	objectAt(object, "metadata");
const text = (object: JsonValue | undefined, key: string): string =>
	stringAt(object, key) ?? "";

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
	readonly watchQueue: Array<{
		status: number;
		events?: readonly JsonObject[];
	}> = [];

	constructor(options: FakeHubOptions = {}) {
		this.token = options.token ?? "hub-token";
		this.failWith = options.failWith;
	}

	key(group: string, resource: string, namespace: string, name: string): Key {
		return `${group}|${resource}|${namespace}|${name}`;
	}

	nextRv(): string {
		this.rv += 1;
		return String(this.rv);
	}

	put(group: string, resource: string, object: JsonObject): JsonObject {
		const meta = metaOf(object);
		const stored = clone({
			...object,
			metadata: {
				...meta,
				resourceVersion: this.nextRv(),
				generation: numberAt(meta, "generation") ?? 1,
			},
		});
		this.objects.set(
			this.key(group, resource, text(meta, "namespace"), text(meta, "name")),
			stored,
		);
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
		const id = (o: JsonObject): string => `${text(metaOf(o), "namespace")}/${text(metaOf(o), "name")}`;
		return out.sort((a, b) => id(a).localeCompare(id(b)));
	}

	mutatingCalls(): Logged[] {
		return this.log.filter((l) => l.method !== "GET");
	}

	readonly transport = async (request: TransportRequest): Promise<TransportResponse> => {
		const url = new URL(request.url);
		const body = request.body === undefined ? undefined : parseJsonText(request.body);
		this.log.push({
			method: request.method,
			path: url.pathname,
			query: url.search,
			...(body !== undefined ? { body } : undefined),
			...(request.headers.authorization !== undefined
				? { authorization: request.headers.authorization }
				: undefined),
		});
		const respond = (status: number, value?: JsonValue): TransportResponse => ({
			status,
			headers: { "content-type": "application/json" },
			body: value === undefined ? "" : JSON.stringify(value),
		});
		if (this.failWith !== undefined) return respond(this.failWith, { kind: "Status", message: "injected" });
		if (request.headers.authorization !== `Bearer ${this.token}`)
			return respond(401, { kind: "Status", message: "Unauthorized" });
		const p = parsePath(url.pathname);
		if (p === undefined) return respond(404, { kind: "Status", message: "not found" });
		const { group, resource, namespace, name } = p;
		if (request.method === "GET" && url.searchParams.get("watch") === "1") {
			const next = this.watchQueue.shift();
			if (next === undefined) return { status: 200, headers: {}, body: "" };
			if (next.status !== 200)
				return respond(next.status, { kind: "Status", code: next.status, message: "gone" });
			return { status: 200, headers: {}, body: (next.events ?? []).map((e) => JSON.stringify(e)).join("\n") };
		}
		if (request.method === "GET" && name === "") {
			const selector = url.searchParams.get("labelSelector");
			const want = selector === null ? [] : selector.split(",").map((s) => s.split("="));
			const items = this.all(group, resource).filter((o) => {
				const meta = metaOf(o);
				if (namespace !== "" && text(meta, "namespace") !== namespace) return false;
				const labels = objectAt(meta, "labels");
				return want.every(([k, v]) => k !== undefined && labels[k] === v);
			});
			return respond(200, { kind: "List", metadata: { resourceVersion: String(this.rv) }, items: items.map(clone) });
		}
		const existing = this.find(group, resource, namespace, name);
		if (request.method === "GET")
			return existing === undefined ? respond(404, { kind: "Status", message: "not found" }) : respond(200, clone(existing));
		if (request.method === "POST") {
			if (!isJsonObject(body)) return respond(400);
			const meta = metaOf(body);
			if (this.find(group, resource, namespace, text(meta, "name")) !== undefined)
				return respond(409, { kind: "Status", message: "AlreadyExists" });
			const stored = this.put(group, resource, { ...body, metadata: { ...meta, namespace, generation: 1 } });
			return respond(201, clone(stored));
		}
		if (request.method === "PUT") {
			if (existing === undefined) return respond(404, { kind: "Status", message: "not found" });
			if (!isJsonObject(body)) return respond(400);
			const meta = metaOf(body);
			if (text(meta, "resourceVersion") !== text(metaOf(existing), "resourceVersion"))
				return respond(409, { kind: "Status", message: "Conflict" });
			const specChanged = JSON.stringify(body.spec ?? null) !== JSON.stringify(existing.spec ?? null);
			const generation = (numberAt(metaOf(existing), "generation") ?? 1) + (specChanged ? 1 : 0);
			const stored = this.put(group, resource, {
				...body,
				metadata: { ...meta, namespace, generation },
				...(existing.status !== undefined ? { status: existing.status } : undefined),
			});
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

	protected onDelete(_group: string, _resource: string, _object: JsonObject): void {}
}

const WORK = "work.open-cluster-management.io";

function groupOf(apiVersion: string): string {
	return apiVersion.includes("/") ? (apiVersion.split("/")[0] ?? "") : "";
}

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
		return this.all(WORK, "manifestworks").filter((w) => cluster === undefined || text(metaOf(w), "namespace") === cluster);
	}

	private feedback(manifest: JsonObject, config: JsonObject | undefined): JsonObject[] {
		const values: JsonObject[] = [];
		for (const rule of objectsOf(arrayAt(config, "feedbackRules"))) {
			if (rule.type === "WellKnownStatus" && manifest.kind === "Deployment") {
				const replicas = numberAt(objectAt(manifest, "spec"), "replicas") ?? 1;
				values.push({ name: "Replicas", fieldValue: { type: "Integer", integer: replicas } });
				values.push({ name: "ReadyReplicas", fieldValue: { type: "Integer", integer: this.readyReplicas ?? replicas } });
			}
			if (rule.type === "JSONPaths") {
				for (const jp of objectsOf(arrayAt(rule, "jsonPaths"))) {
					if (jp.path === ".observedGeneration")
						values.push({ name: text(jp, "name"), fieldValue: { type: "Integer", integer: 1 } });
				}
			}
		}
		return values;
	}

	/** Run the work agent of one cluster (or all): apply and report status. */
	agent(cluster?: string): void {
		for (const work of this.works(cluster)) {
			const meta = metaOf(work);
			const ns = text(meta, "namespace");
			const workName = text(meta, "name");
			const generation = numberAt(meta, "generation") ?? 1;
			const spec = objectAt(work, "spec");
			const manifests = objectsOf(arrayAt(objectAt(spec, "workload"), "manifests"));
			const configs = objectsOf(arrayAt(spec, "manifestConfigs"));
			const clusterApplied = this.applied.get(ns) ?? new Map<string, Set<string>>();
			this.applied.set(ns, clusterApplied);
			let anyFailed = false;
			const statuses = manifests.map((manifest, ordinal) => {
				const mm = metaOf(manifest);
				const apiVersion = text(manifest, "apiVersion");
				const group = groupOf(apiVersion);
				const identity = `${group}/${text(manifest, "kind")}/${text(mm, "namespace")}/${text(mm, "name")}`;
				const reject = this.rejects.get(identity);
				if (reject === undefined) {
					const owners = clusterApplied.get(identity) ?? new Set<string>();
					owners.add(workName);
					clusterApplied.set(identity, owners);
				} else anyFailed = true;
				const config = configs.find((c) => {
					const id = objectAt(c, "resourceIdentifier");
					return text(id, "name") === text(mm, "name") && text(id, "namespace") === text(mm, "namespace");
				});
				const values = this.feedback(manifest, config);
				const status = reject === undefined ? "True" : "False";
				return {
					resourceMeta: {
						ordinal,
						group,
						version: apiVersion.split("/").at(-1) ?? "",
						kind: text(manifest, "kind"),
						resource: `${text(manifest, "kind").toLowerCase()}s`,
						name: text(mm, "name"),
						namespace: text(mm, "namespace"),
					},
					conditions: [
						{
							type: "Applied",
							status,
							reason: reject === undefined ? "AppliedManifestComplete" : "AppliedManifestFailed",
							message: reject ?? "Apply manifest complete",
							observedGeneration: generation,
						},
						{ type: "Available", status, reason: "ResourceAvailable", message: "", observedGeneration: generation },
					],
					...(values.length > 0 ? { statusFeedback: { values } } : undefined),
				};
			});
			const workStatus = anyFailed ? "False" : "True";
			this.objects.set(this.key(WORK, "manifestworks", ns, workName), {
				...work,
				status: {
					conditions: [
						{
							type: "Applied",
							status: workStatus,
							reason: anyFailed ? "AppliedManifestWorkFailed" : "AppliedManifestWorkComplete",
							message: "",
							observedGeneration: generation,
						},
						{ type: "Available", status: workStatus, reason: "ResourcesAvailable", message: "", observedGeneration: generation },
					],
					resourceStatus: { manifests: statuses },
				},
			});
		}
	}

	protected override onDelete(group: string, resource: string, object: JsonObject): void {
		if (group !== WORK || resource !== "manifestworks") return;
		const meta = metaOf(object);
		const ns = text(meta, "namespace");
		const clusterApplied = this.applied.get(ns);
		if (clusterApplied === undefined) return;
		const option = objectAt(objectAt(object, "spec"), "deleteOption");
		const policy = stringAt(option, "propagationPolicy") ?? "Foreground";
		const rules = objectsOf(arrayAt(objectAt(option, "selectivelyOrphans"), "orphaningRules"));
		for (const [identity, owners] of clusterApplied) {
			if (!owners.delete(text(meta, "name")) || owners.size > 0) continue;
			const [, , rns, rname] = identity.split("/");
			const orphan =
				policy === "Orphan" ||
				(policy === "SelectivelyOrphan" && rules.some((r) => text(r, "name") === rname && text(r, "namespace") === rns));
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
			const spec = objectAt(policy, "spec");
			const clusters = arrayAt(objectAt(objectAt(spec, "placement"), "clusterAffinity"), "clusterNames").map(String);
			const targets = this.extraCluster === undefined ? clusters : [...clusters, this.extraCluster];
			for (const selector of objectsOf(arrayAt(spec, "resourceSelectors"))) {
				const template = this.templates().find(
					(t) =>
						t.kind === selector.kind &&
						text(metaOf(t), "name") === text(selector, "name") &&
						text(metaOf(t), "namespace") === text(selector, "namespace"),
				);
				if (template === undefined) continue;
				const m = metaOf(template);
				const name = `${text(m, "name")}-${text(template, "kind").toLowerCase()}`;
				const replicas = numberAt(objectAt(template, "spec"), "replicas") ?? 1;
				this.objects.set(this.key(BINDING, "resourcebindings", text(m, "namespace"), name), {
					apiVersion: "work.karmada.io/v1alpha2",
					kind: "ResourceBinding",
					metadata: { name, namespace: text(m, "namespace"), resourceVersion: this.nextRv() },
					spec: {
						resource: {
							apiVersion: text(template, "apiVersion"),
							kind: text(template, "kind"),
							namespace: text(m, "namespace"),
							name: text(m, "name"),
							resourceVersion: text(m, "resourceVersion"),
						},
						clusters: targets.map((c) => ({ name: c })),
						preserveResourcesOnDeletion: spec.preserveResourcesOnDeletion ?? false,
					},
					status: {
						aggregatedStatus: targets.map((c) => ({
							clusterName: c,
							applied: true,
							health: this.health,
							status: { replicas, readyReplicas: replicas, observedGeneration: 1 },
						})),
					},
				});
			}
		}
	}

	protected override onDelete(group: string, _resource: string, object: JsonObject): void {
		if (group === POLICY || group === BINDING) return;
		const m = metaOf(object);
		const key = this.key(BINDING, "resourcebindings", text(m, "namespace"), `${text(m, "name")}-${text(object, "kind").toLowerCase()}`);
		const binding = this.objects.get(key);
		if (binding !== undefined) {
			if (objectAt(binding, "spec").preserveResourcesOnDeletion === true)
				this.preserved.push(`${text(m, "namespace")}/${text(m, "name")}`);
			this.objects.delete(key);
		}
	}
}
