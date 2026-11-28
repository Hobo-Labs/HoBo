import type { HttpTransport, JsonObject, JsonValue } from "@hobo/core";
import { GitopsEngine } from "../_generated/gitops_pb.js";
import type { PublisherConfig } from "../config.js";
import { GitopsError, type GitopsFailureCode } from "../errors.js";
import { hostFailure, ok, parseJson, send } from "../http.js";
import { isJsonNumber, isJsonObject, isJsonString } from "../json.js";
import type { EngineDocumentRef } from "../render.js";

export type EngineVerdict = Readonly<{
	state: "converged" | "converging" | "blocked";
	healthy: boolean;
	appliedRevision: string;
	outOfSyncCount?: number;
	outOfSyncResources?: readonly string[];
	reason?: Readonly<{ code: GitopsFailureCode; message: string }>;
}>;

// public-contract: credential scope for engine status tokens.
export const ENGINE_CREDENTIAL_SCOPE = "cd.gitops.engine" as const;

function get(
	value: JsonValue | undefined,
	...path: string[]
): JsonValue | undefined {
	let cursor = value;
	for (const key of path) {
		if (!isJsonObject(cursor)) return undefined;
		cursor = cursor[key];
	}
	return cursor;
}

const str = (value: JsonValue | undefined): string =>
	isJsonString(value) ? value : "";
const num = (value: JsonValue | undefined, fallback: number): number =>
	isJsonNumber(value) ? value : fallback;

function sameRevision(reported: string, published: string): boolean {
	if (reported === "" || published === "") return false;
	const sha = reported.includes(":")
		? reported.slice(reported.lastIndexOf(":") + 1)
		: reported;
	return sha === published;
}

function extractArgoOutOfSyncResources(
	app: JsonObject,
): readonly string[] | undefined {
	const resources = get(app, "status", "resources");
	if (!Array.isArray(resources)) return undefined;
	const outOfSync: string[] = [];
	for (const item of resources) {
		if (!isJsonObject(item)) continue;
		const status = str(item.status);
		if (status === "Synced") continue;
		const kind = str(item.kind) || "Resource";
		const namespace = str(item.namespace);
		const name = str(item.name) || "unnamed";
		outOfSync.push(
			namespace !== "" ? `${kind}/${namespace}/${name}` : `${kind}/${name}`,
		);
	}
	return outOfSync;
}

export function argoVerdict(app: JsonObject, revision: string): EngineVerdict {
	const sync = str(get(app, "status", "sync", "status"));
	const applied = str(get(app, "status", "sync", "revision"));
	const health = str(get(app, "status", "health", "status"));
	const phase = str(get(app, "status", "operationState", "phase"));
	const opRevision =
		str(get(app, "status", "operationState", "syncResult", "revision")) ||
		str(get(app, "status", "operationState", "operation", "sync", "revision"));
	const outOfSyncResources = extractArgoOutOfSyncResources(app);
	const resourceDiff =
		outOfSyncResources !== undefined
			? {
					outOfSyncCount: outOfSyncResources.length,
					outOfSyncResources,
				}
			: {};
	const onRevision = sameRevision(applied, revision);
	if (
		(phase === "Failed" || phase === "Error") &&
		(opRevision === "" || sameRevision(opRevision, revision))
	) {
		return {
			state: "blocked",
			healthy: false,
			appliedRevision: applied,
			...resourceDiff,
			reason: {
				code: "gitops-engine-degraded",
				message: `Argo CD sync ${phase}: ${str(get(app, "status", "operationState", "message"))}`,
			},
		};
	}
	if (onRevision && sync === "Synced" && health === "Healthy") {
		return {
			state: "converged",
			healthy: true,
			appliedRevision: applied,
			...resourceDiff,
		};
	}
	if (onRevision && sync === "Synced" && health === "Degraded") {
		return {
			state: "blocked",
			healthy: false,
			appliedRevision: applied,
			...resourceDiff,
			reason: {
				code: "gitops-engine-degraded",
				message: "Argo CD reports the revision Degraded",
			},
		};
	}
	const driftSuffix =
		outOfSyncResources !== undefined && outOfSyncResources.length > 0
			? ` outOfSync=[${outOfSyncResources.join(", ")}]`
			: "";
	return {
		state: "converging",
		healthy: false,
		appliedRevision: applied,
		...resourceDiff,
		reason: {
			code: "gitops-engine-not-converged",
			message: `Argo CD sync=${sync || "unknown"} health=${health || "unknown"} revision=${applied || "none"}, want ${revision}${driftSuffix}`,
		},
	};
}

export function fluxVerdict(
	kustomization: JsonObject,
	revision: string,
): EngineVerdict {
	const applied = str(get(kustomization, "status", "lastAppliedRevision"));
	const attempted = str(get(kustomization, "status", "lastAttemptedRevision"));
	const generation = num(get(kustomization, "metadata", "generation"), 0);
	const observed = num(get(kustomization, "status", "observedGeneration"), -1);
	const conditions = get(kustomization, "status", "conditions");
	const ready = Array.isArray(conditions)
		? conditions.find((c) => str(get(c, "type")) === "Ready")
		: undefined;
	const readyStatus = str(get(ready, "status"));
	const readyReason = str(get(ready, "reason"));
	const current = observed >= generation;
	if (current && sameRevision(applied, revision) && readyStatus === "True") {
		return { state: "converged", healthy: true, appliedRevision: applied };
	}
	if (current && readyStatus === "False" && sameRevision(attempted, revision)) {
		return {
			state: "blocked",
			healthy: false,
			appliedRevision: applied,
			reason: {
				code: "gitops-engine-degraded",
				message: `Flux Ready=False (${readyReason}): ${str(get(ready, "message"))}`,
			},
		};
	}
	return {
		state: "converging",
		healthy: false,
		appliedRevision: applied,
		reason: {
			code: "gitops-engine-not-converged",
			message: `Flux Ready=${readyStatus || "Unknown"} applied=${applied || "none"}, want ${revision}`,
		},
	};
}

function unobservableVerdict(
	code: GitopsFailureCode,
	message: string,
): EngineVerdict {
	return {
		state: "converging",
		healthy: false,
		appliedRevision: "",
		reason: { code, message },
	};
}

export async function observeEngine(
	config: PublisherConfig,
	ref: EngineDocumentRef,
	revision: string,
	http: HttpTransport,
	token: () => Promise<string>,
): Promise<EngineVerdict> {
	try {
		const base = config.endpoint.apiBaseUrl;
		const url =
			config.engine === GitopsEngine.ARGO_CD
				? `${base}/api/v1/applications/${encodeURIComponent(ref.name)}?appNamespace=${encodeURIComponent(ref.namespace)}`
				: `${base}/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${encodeURIComponent(ref.namespace)}/kustomizations/${encodeURIComponent(ref.name)}`;
		const response = await send(http, {
			method: "GET",
			url,
			headers: { authorization: `Bearer ${await token()}` },
		});
		if (response.status === 404) {
			return unobservableVerdict(
				"gitops-engine-not-found",
				`${ref.kind} ${ref.namespace}/${ref.name} does not exist yet`,
			);
		}
		if (!ok(response)) {
			const failure = hostFailure(response, `observe ${ref.kind}`);
			return unobservableVerdict("gitops-engine-unobservable", failure.message);
		}
		const body = parseJson(response, `observe ${ref.kind}`);
		return config.engine === GitopsEngine.ARGO_CD
			? argoVerdict(body, revision)
			: fluxVerdict(body, revision);
	} catch (error) {
		if (
			error instanceof GitopsError &&
			error.code === "gitops-credential-missing"
		)
			throw error;
		return unobservableVerdict(
			"gitops-engine-unobservable",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export type TriggerArgoSyncOptions = Readonly<{
	appNamespace?: string;
	prune?: boolean;
}>;

export async function triggerArgoSync(
	config: PublisherConfig,
	appName: string,
	revision: string,
	http: HttpTransport,
	token: () => Promise<string>,
	options?: TriggerArgoSyncOptions,
): Promise<Readonly<{ triggered: true; appName: string; revision: string }>> {
	if (config.engine !== GitopsEngine.ARGO_CD) {
		throw new GitopsError(
			"gitops-config-invalid",
			"triggerArgoSync requires an Argo CD publisher config",
		);
	}
	const appNamespace = options?.appNamespace ?? config.endpoint.namespace;
	const response = await send(http, {
		method: "POST",
		url: `${config.endpoint.apiBaseUrl}/api/v1/applications/${encodeURIComponent(appName)}/sync`,
		headers: {
			authorization: `Bearer ${await token()}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			revision,
			prune: options?.prune ?? config.prune,
			dryRun: false,
			appNamespace,
		}),
	});
	if (!ok(response)) {
		throw hostFailure(response, `trigger Argo CD sync for ${appName}`);
	}
	return { triggered: true, appName, revision };
}

export type ObserveArgoSelectorOptions = Readonly<{
	appNamespace?: string;
	triggerSync?: boolean;
}>;

export async function observeArgoApplicationsBySelector(
	config: PublisherConfig,
	selector: string,
	revision: string,
	http: HttpTransport,
	token: () => Promise<string>,
	options?: ObserveArgoSelectorOptions,
): Promise<EngineVerdict> {
	if (config.engine !== GitopsEngine.ARGO_CD) {
		throw new GitopsError(
			"gitops-config-invalid",
			"observeArgoApplicationsBySelector requires an Argo CD publisher config",
		);
	}
	const appNamespace = options?.appNamespace ?? config.endpoint.namespace;
	try {
		const url = `${config.endpoint.apiBaseUrl}/api/v1/applications?selector=${encodeURIComponent(selector)}&appNamespace=${encodeURIComponent(appNamespace)}`;
		const fetchSelectorItems = async (): Promise<
			| Readonly<{ ok: true; items: JsonObject[] }>
			| Readonly<{ ok: false; verdict: EngineVerdict }>
		> => {
			const response = await send(http, {
				method: "GET",
				url,
				headers: { authorization: `Bearer ${await token()}` },
			});
			if (response.status === 404) {
				return {
					ok: false,
					verdict: unobservableVerdict(
						"gitops-engine-not-found",
						`no Argo CD Applications matched selector "${selector}"`,
					),
				};
			}
			if (!ok(response)) {
				const failure = hostFailure(
					response,
					`observe Argo CD Applications for selector "${selector}"`,
				);
				return {
					ok: false,
					verdict: unobservableVerdict(
						"gitops-engine-unobservable",
						failure.message,
					),
				};
			}
			const body = parseJson(
				response,
				`observe Argo CD Applications for selector "${selector}"`,
			);
			const rawItems = body.items;
			const parsedItems: JsonObject[] = Array.isArray(rawItems)
				? rawItems.filter((item): item is JsonObject => isJsonObject(item))
				: [];
			if (parsedItems.length === 0) {
				return {
					ok: false,
					verdict: unobservableVerdict(
						"gitops-engine-not-found",
						`no Argo CD Applications matched selector "${selector}"`,
					),
				};
			}
			return { ok: true, items: parsedItems };
		};

		const initial = await fetchSelectorItems();
		if (!initial.ok) return initial.verdict;
		let items = initial.items;

		if (options?.triggerSync === true) {
			let triggeredAny = false;
			for (const item of items) {
				const name = str(get(item, "metadata", "name"));
				if (name === "") continue;
				if (argoVerdict(item, revision).state === "converged") continue;
				const itemNamespace =
					str(get(item, "metadata", "namespace")) || appNamespace;
				await triggerArgoSync(config, name, revision, http, token, {
					appNamespace: itemNamespace,
				});
				triggeredAny = true;
			}
			if (triggeredAny) {
				const refreshed = await fetchSelectorItems();
				if (!refreshed.ok) return refreshed.verdict;
				items = refreshed.items;
			}
		}

		const verdicts = items.map((item) => ({
			name: str(get(item, "metadata", "name")) || "unnamed",
			verdict: argoVerdict(item, revision),
		}));

		const allOutOfSync: string[] = [];
		for (const entry of verdicts) {
			if (entry.verdict.outOfSyncResources !== undefined) {
				for (const res of entry.verdict.outOfSyncResources) {
					allOutOfSync.push(`${entry.name}:${res}`);
				}
			}
		}

		const blocked = verdicts.filter(
			(entry) => entry.verdict.state === "blocked",
		);
		if (blocked.length > 0) {
			const detail = blocked
				.map(
					(entry) =>
						`${entry.name}: ${entry.verdict.reason?.message ?? "degraded"}`,
				)
				.join("; ");
			return {
				state: "blocked",
				healthy: false,
				appliedRevision: blocked[0]?.verdict.appliedRevision ?? "",
				outOfSyncCount: allOutOfSync.length,
				outOfSyncResources: allOutOfSync,
				reason: {
					code: "gitops-engine-degraded",
					message: `Argo CD selector "${selector}" degraded (${blocked.length}/${verdicts.length}): ${detail}`,
				},
			};
		}

		if (verdicts.every((entry) => entry.verdict.state === "converged")) {
			return {
				state: "converged",
				healthy: true,
				appliedRevision: revision,
				outOfSyncCount: 0,
				outOfSyncResources: [],
			};
		}

		const converging = verdicts.filter(
			(entry) => entry.verdict.state !== "converged",
		);
		const detail = converging
			.map(
				(entry) =>
					`${entry.name}: ${entry.verdict.reason?.message ?? "converging"}`,
			)
			.join("; ");
		return {
			state: "converging",
			healthy: false,
			appliedRevision: verdicts[0]?.verdict.appliedRevision ?? "",
			outOfSyncCount: allOutOfSync.length,
			outOfSyncResources: allOutOfSync,
			reason: {
				code: "gitops-engine-not-converged",
				message: `Argo CD selector "${selector}" converging (${verdicts.length - converging.length}/${verdicts.length} converged): ${detail}`,
			},
		};
	} catch (error) {
		if (
			error instanceof GitopsError &&
			(error.code === "gitops-credential-missing" ||
				error.code === "gitops-host-auth-failed" ||
				error.code === "gitops-config-invalid")
		)
			throw error;
		return unobservableVerdict(
			"gitops-engine-unobservable",
			error instanceof Error ? error.message : String(error),
		);
	}
}
