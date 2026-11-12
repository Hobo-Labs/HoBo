// Shared fixtures: resolved sets, Sets, RealizeInputs, configs, credentials
// and a recording TelemetrySink.
import { create } from "@bufbuild/protobuf";
import {
	type CampId,
	type CdContext,
	type CredentialResolver,
	type OtelMetricPoint,
	type RealizeInput,
	type ReconcilerId,
	SetRecordSchema,
	type TelemetrySink,
} from "@hobo/cd";
import {
	type FenceToken,
	type JsonObject,
	type JsonValue,
	type PrincipalRef,
	stableDigest,
} from "@hobo/core";
import {
	parseKarmadaRealizerConfig,
	parseOcmRealizerConfig,
	type RealizerConfig,
} from "../src/index.js";
import { objectAt, stringAt } from "../src/json.js";

export const HUB_TOKEN = "hub-token";
export const now = (): number => Date.parse("2026-11-12T10:00:00Z");

export const ctx: CdContext = Object.freeze({
	tenant: "acme",
	principal: { kind: "service", id: "reconciler" } satisfies PrincipalRef,
	now,
});

export function credentials(
	token = HUB_TOKEN,
): CredentialResolver & { calls: Array<[string, string]> } {
	const calls: Array<[string, string]> = [];
	return {
		calls,
		async resolve(ref, scope) {
			calls.push([ref, scope]);
			return { token };
		},
	};
}

export function recordingSink(): TelemetrySink & { points: OtelMetricPoint[] } {
	const points: OtelMetricPoint[] = [];
	return {
		points,
		async spans() {},
		async metrics(batch) {
			points.push(...batch);
		},
	};
}

export type ResourceSpec = Readonly<{
	name: string;
	port?: string;
	productId?: string;
	params: JsonObject;
}>;

export const deployment = (
	name: string,
	image: string,
	replicas = 2,
	namespace = "shop",
): ResourceSpec => ({
	name,
	port: "compute",
	params: {
		manifest: {
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name, namespace },
			spec: {
				replicas,
				selector: { matchLabels: { app: name } },
				template: {
					metadata: { labels: { app: name } },
					spec: { containers: [{ name, image }] },
				},
			},
		},
	},
});

export const volume = (name: string, namespace = "shop"): ResourceSpec => ({
	name,
	port: "volume",
	productId: "persistentvolumeclaim",
	params: {
		namespace,
		spec: {
			accessModes: ["ReadWriteOnce"],
			resources: { requests: { storage: "1Gi" } },
		},
	},
});

export function resolvedSet(
	campId: string,
	resources: readonly ResourceSpec[],
): RealizeInput["resolved"] {
	const plan = {
		schema: "hobo.deployment-plan/v1",
		resources: resources.map((r) => ({
			name: r.name,
			port: r.port ?? "compute",
			provider: "@hobo/provider-kubernetes",
			deps: [],
			...(r.productId !== undefined ? { productId: r.productId } : undefined),
			realizationParameters: r.params,
		})),
		dependencyOrder: resources.map((r) => r.name),
		objective: "min-cost",
	};
	// SAFETY: stableDigest returns `sha256:<hex>`.
	const planHash = stableDigest(plan) as `sha256:${string}`;
	const body = { campId, planHash, resources: resources.map((r) => r.name) };
	// SAFETY: test-built resolved set with the fields the realizers read.
	// SAFETY: test-built resolved set carrying every field the realizers read; the plan is authoring-shaped JSON.
	return {
		schemaVersion: "hobo.resolved-deployment-set/v1",
		setId: `set_${planHash.slice(7, 19)}`,
		tenant: "acme",
		environment: "prod",
		campId,
		plan,
		planHash,
		matches: [],
		gatekeeper: {
			decision: "allow",
			gatekeeperDecisionId: "gk-1",
			obligations: [],
			decidedAt: "2026-11-12T09:00:00Z",
		},
		secretRefs: [],
		// SAFETY: stableDigest returns `sha256:<hex>`.
		contentHash: stableDigest({ ...body, plan }) as `sha256:${string}`,
	} satisfies Omit<RealizeInput["resolved"], "plan"> & {
		plan: object;
	} as RealizeInput["resolved"];
}

export function realizeInput(
	campId: string,
	resources: readonly ResourceSpec[],
	options: Readonly<{
		fence?: bigint;
		signal?: AbortSignal;
		keep?: readonly string[];
		reconcilerId?: string;
	}> = {},
): RealizeInput {
	const resolved = resolvedSet(campId, resources);
	const desired = create(SetRecordSchema, {
		schemaVersion: "hobo.cd.set/v1",
		setId: resolved.setId,
		tenant: "acme",
		environment: "prod",
		campId,
		freightId: "sha256:freight",
		planHash: resolved.planHash,
		contentHash: resolved.contentHash,
		resolvedSetDigest: resolved.contentHash,
		createdAt: "2026-11-12T09:00:00Z",
	});
	return {
		// SAFETY: test brands.
		campId: campId as CampId,
		desired,
		resolved,
		// SAFETY: test brands for a reconciler id and a fence token.
		reconcilerId: (options.reconcilerId ?? "rec-1") as ReconcilerId,
		// SAFETY: a fence is a bigint brand; tests pick its value.
		fence: (options.fence ?? 7n) as FenceToken,
		signal: options.signal ?? new AbortController().signal,
		...(options.keep !== undefined ? { keep: options.keep } : undefined),
	};
}

export const hub = (
	kind: "HUB_KIND_OCM" | "HUB_KIND_KARMADA" | "HUB_KIND_CLUSTER_INVENTORY",
	name = "hub-a",
) => ({
	schemaVersion: "hobo.cd-kube-fleet.hub/v1",
	name,
	kind,
	apiBaseUrl: "https://hub.example:6443",
	credentialRef: `secret://kube/${name}`,
	auth: "KUBE_AUTH_BEARER",
});

export function ocmConfig(
	clusters: Readonly<Record<string, string>>,
	departureAction = "DEPARTURE_ACTION_ORPHAN_DATA",
): RealizerConfig {
	return parseOcmRealizerConfig({
		schemaVersion: "hobo.cd-kube-fleet.ocm/v1",
		hub: hub("HUB_KIND_OCM"),
		clusters: Object.entries(clusters).map(([campId, cluster]) => ({
			campId,
			cluster,
		})),
		departureAction,
	});
}

export function karmadaConfig(
	clusters: Readonly<Record<string, string>>,
	departureAction = "DEPARTURE_ACTION_ORPHAN_DATA",
): RealizerConfig {
	return parseKarmadaRealizerConfig({
		schemaVersion: "hobo.cd-kube-fleet.karmada/v1",
		hub: hub("HUB_KIND_KARMADA", "karmada-a"),
		clusters: Object.entries(clusters).map(([campId, cluster]) => ({
			campId,
			cluster,
		})),
		departureAction,
	});
}

/** `metadata` of a hub object (guarded, never cast). */
export const metaOf = (object: JsonValue | undefined): JsonObject =>
	objectAt(object, "metadata");
/** `metadata.annotations` of a hub object. */
export const annotationsOf = (object: JsonValue | undefined): JsonObject =>
	objectAt(metaOf(object), "annotations");
/** `metadata.name` of a hub object. */
export const nameOf = (object: JsonValue | undefined): string =>
	stringAt(metaOf(object), "name") ?? "";
