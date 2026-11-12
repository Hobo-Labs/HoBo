// Engine observation: read the engine's own status API and decide whether the
// published revision has converged. Convergence is claimed only when the
// engine reports the exact revision applied and healthy (I5); anything else —
// including an unreadable status — is CONVERGING or BLOCKED with a reason.

import type { HttpTransport } from "@hobo/core";
import { GitopsEngine } from "../_generated/gitops_pb.js";
import type { PublisherConfig } from "../config.js";
import { GitopsError, type GitopsFailureCode } from "../errors.js";
import { hostFailure, ok, parseJson, send } from "../http.js";
import type { EngineDocumentRef } from "../render.js";

export type EngineVerdict = Readonly<{
	state: "converged" | "converging" | "blocked";
	healthy: boolean;
	/** Revision the engine reports as applied, if any. */
	appliedRevision: string;
	reason?: Readonly<{ code: GitopsFailureCode; message: string }>;
}>;

// public-contract: credential scope for engine status tokens.
export const ENGINE_CREDENTIAL_SCOPE = "cd.gitops.engine" as const;

type Json = Record<string, unknown>;

function get(value: unknown, ...path: string[]): unknown {
	let cursor = value;
	for (const key of path) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		// SAFETY: walking a parsed JSON object.
		cursor = (cursor as Json)[key];
	}
	return cursor;
}

const str = (value: unknown): string =>
	typeof value === "string" ? value : "";

function sameRevision(reported: string, published: string): boolean {
	if (reported === "" || published === "") return false;
	// Flux reports `<branch>@sha1:<sha>`; Argo CD reports the bare sha.
	const sha = reported.includes(":")
		? reported.slice(reported.lastIndexOf(":") + 1)
		: reported;
	return sha === published;
}

/** Argo CD Application status → verdict. */
export function argoVerdict(app: unknown, revision: string): EngineVerdict {
	const sync = str(get(app, "status", "sync", "status"));
	const applied = str(get(app, "status", "sync", "revision"));
	const health = str(get(app, "status", "health", "status"));
	const phase = str(get(app, "status", "operationState", "phase"));
	const opRevision = str(
		get(app, "status", "operationState", "syncResult", "revision"),
	);
	const onRevision = sameRevision(applied, revision);
	if (
		(phase === "Failed" || phase === "Error") &&
		(opRevision === "" || sameRevision(opRevision, revision))
	) {
		return {
			state: "blocked",
			healthy: false,
			appliedRevision: applied,
			reason: {
				code: "gitops-engine-degraded",
				message: `Argo CD sync ${phase}: ${str(get(app, "status", "operationState", "message"))}`,
			},
		};
	}
	if (onRevision && sync === "Synced" && health === "Healthy") {
		return { state: "converged", healthy: true, appliedRevision: applied };
	}
	if (onRevision && sync === "Synced" && health === "Degraded") {
		return {
			state: "blocked",
			healthy: false,
			appliedRevision: applied,
			reason: {
				code: "gitops-engine-degraded",
				message: "Argo CD reports the revision Degraded",
			},
		};
	}
	return {
		state: "converging",
		healthy: false,
		appliedRevision: applied,
		reason: {
			code: "gitops-engine-not-converged",
			message: `Argo CD sync=${sync || "unknown"} health=${health || "unknown"} revision=${applied || "none"}, want ${revision}`,
		},
	};
}

/** Flux Kustomization status → verdict. */
export function fluxVerdict(
	kustomization: unknown,
	revision: string,
): EngineVerdict {
	const applied = str(get(kustomization, "status", "lastAppliedRevision"));
	const attempted = str(get(kustomization, "status", "lastAttemptedRevision"));
	const generation = Number(get(kustomization, "metadata", "generation") ?? 0);
	const observed = Number(
		get(kustomization, "status", "observedGeneration") ?? -1,
	);
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

/** Read the engine document's live status and decide. Never throws for I/O. */
export async function observeEngine(
	config: PublisherConfig,
	ref: EngineDocumentRef,
	revision: string,
	http: HttpTransport,
	token: () => Promise<string>,
): Promise<EngineVerdict> {
	const unobservable = (
		code: GitopsFailureCode,
		message: string,
	): EngineVerdict => ({
		state: "converging",
		healthy: false,
		appliedRevision: "",
		reason: { code, message },
	});
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
			return unobservable(
				"gitops-engine-not-found",
				`${ref.kind} ${ref.namespace}/${ref.name} does not exist yet`,
			);
		}
		if (!ok(response)) {
			const failure = hostFailure(response, `observe ${ref.kind}`);
			return unobservable("gitops-engine-unobservable", failure.message);
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
		return unobservable(
			"gitops-engine-unobservable",
			error instanceof Error ? error.message : String(error),
		);
	}
}
