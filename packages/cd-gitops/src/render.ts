// Render a Set as GitOps documents (pure, byte-stable).
//
// One folder per Camp under the publisher's path prefix:
//
//   <prefix>/<camp>/argo-cd.application.json  | flux.kustomization.json
//   <prefix>/<camp>/manifests/hobo-set.configmap.json
//
// The engine document points the engine at `manifests/`, which carries the
// Set and its canonical, secret-free resolved set as a ConfigMap. The same
// Set always renders the same bytes: keys sorted, two-space indent, trailing
// newline, names derived only from the Camp id.

import { createHash } from "node:crypto";
import { toJson } from "@bufbuild/protobuf";
import { type PublisherPort, type SetRecord, SetRecordSchema } from "@hobo/cd";
import type { JsonObject, JsonValue } from "@hobo/core";
import { GitopsEngine } from "./_generated/gitops_pb.js";
import type { PublisherConfig } from "./config.js";
import { GitopsError } from "./errors.js";
import { cloneAsJson, isJsonObject } from "./json.js";

// public-contract: largest resolved set a ConfigMap may carry (bytes).
export const MAX_SET_DOCUMENT_BYTES = 921_600;

/** The resolved deployment set a publish carries (from the frozen PublisherPort). */
export type ResolvedSet = Parameters<PublisherPort["publish"]>[0]["resolved"];

export type RenderedFile = Readonly<{ path: string; content: string }>;

export type EngineDocumentRef = Readonly<{
	apiVersion: string;
	kind: "Application" | "Kustomization";
	name: string;
	namespace: string;
}>;

export type RenderedPublication = Readonly<{
	/** Sorted by path. */
	files: readonly RenderedFile[];
	engineDocument: EngineDocumentRef;
}>;

function sortKeys(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (isJsonObject(value)) {
		const out: Record<string, JsonValue> = {};
		for (const key of Object.keys(value).sort()) {
			const item = value[key];
			if (item !== undefined) out[key] = sortKeys(item);
		}
		return out;
	}
	return value;
}

/** Byte-stable JSON document: sorted keys, two-space indent, final newline. */
export function stableDocument(value: JsonValue): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** Compact canonical JSON (sorted keys) for hashing and embedding. */
export function canonicalJson(value: JsonValue): string {
	return JSON.stringify(sortKeys(value));
}

export function sha256Digest(text: string): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** A Kubernetes DNS-1123 name from free text; hashed when it must be cut. */
export function k8sName(prefix: string, raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	const name = `${prefix}-${slug || "camp"}`;
	if (name.length <= 63 && slug === raw) return name;
	const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 8);
	return `${name.slice(0, 63 - suffix.length - 1).replace(/-+$/u, "")}-${suffix}`;
}

function campDirectory(config: PublisherConfig, campId: string): string {
	return `${config.repository.pathPrefix}/${k8sName("camp", campId)}`;
}

export function renderPublication(
	config: PublisherConfig,
	set: SetRecord,
	resolved: ResolvedSet | null,
): RenderedPublication {
	if (set.campId === "" || set.setId === "") {
		throw new GitopsError(
			"gitops-config-invalid",
			"a Set needs set_id and camp_id to publish",
		);
	}
	const dir = campDirectory(config, set.campId);
	const name = k8sName("hobo", set.campId);
	const destination = config.endpoint.destinationNamespace;
	// The resolved set is a canonical, secret-free JSON document.
	const resolvedJson = cloneAsJson(resolved);
	const setBody = canonicalJson(cloneAsJson(toJson(SetRecordSchema, set)));
	const resolvedBody = canonicalJson(resolvedJson);
	if (
		Buffer.byteLength(setBody) + Buffer.byteLength(resolvedBody) >
		MAX_SET_DOCUMENT_BYTES
	) {
		throw new GitopsError(
			"gitops-set-too-large",
			`Set ${set.setId} resolves to more than ${MAX_SET_DOCUMENT_BYTES} bytes`,
		);
	}
	const labels = {
		"app.kubernetes.io/managed-by": "hobo",
		"hobo.dev/camp": k8sName("camp", set.campId).slice(0, 63),
	};
	const annotations = {
		"hobo.dev/camp-id": set.campId,
		"hobo.dev/set-id": set.setId,
		"hobo.dev/freight-id": set.freightId,
		"hobo.dev/content-hash": set.contentHash,
	};
	const configMap = {
		apiVersion: "v1",
		kind: "ConfigMap",
		metadata: {
			name: k8sName("hobo-set", set.campId),
			namespace: destination,
			labels,
			annotations,
		},
		data: { "resolved.json": resolvedBody, "set.json": setBody },
	};
	const manifestsPath = `${dir}/manifests`;
	let engineDoc: JsonObject;
	let engineFile: string;
	let ref: EngineDocumentRef;
	if (config.engine === GitopsEngine.ARGO_CD) {
		ref = {
			apiVersion: "argoproj.io/v1alpha1",
			kind: "Application",
			name,
			namespace: config.endpoint.namespace,
		};
		engineFile = `${dir}/argo-cd.application.json`;
		engineDoc = {
			apiVersion: ref.apiVersion,
			kind: ref.kind,
			metadata: { name, namespace: ref.namespace, labels, annotations },
			spec: {
				project: config.endpoint.project,
				source: {
					repoURL: config.repository.cloneUrl,
					targetRevision: config.repository.branch,
					path: manifestsPath,
				},
				destination: {
					server: config.endpoint.destinationServer,
					namespace: destination,
				},
				syncPolicy: config.autoSync
					? {
							automated: { prune: config.prune, selfHeal: true },
							syncOptions: ["CreateNamespace=true"],
						}
					: { syncOptions: ["CreateNamespace=true"] },
			},
		};
	} else {
		ref = {
			apiVersion: "kustomize.toolkit.fluxcd.io/v1",
			kind: "Kustomization",
			name,
			namespace: config.endpoint.namespace,
		};
		engineFile = `${dir}/flux.kustomization.json`;
		engineDoc = {
			apiVersion: ref.apiVersion,
			kind: ref.kind,
			metadata: { name, namespace: ref.namespace, labels, annotations },
			spec: {
				interval: config.interval,
				path: `./${manifestsPath}`,
				prune: config.prune,
				sourceRef: { kind: "GitRepository", name: config.endpoint.sourceRef },
				suspend: !config.autoSync,
				targetNamespace: destination,
				wait: true,
			},
		};
	}
	const files: RenderedFile[] = [
		{ path: engineFile, content: stableDocument(engineDoc) },
		{
			path: `${manifestsPath}/hobo-set.configmap.json`,
			content: stableDocument(configMap),
		},
	];
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { files, engineDocument: ref };
}
