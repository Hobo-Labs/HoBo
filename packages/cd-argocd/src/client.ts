import type {
	CdContext,
	ClusterSyncObservation,
	ClusterSyncPort,
	CredentialResolver,
	Outcome,
} from "@hobo/cd";
import {
	argoVerdict,
	ENGINE_CREDENTIAL_SCOPE,
	GitopsError,
	hostFailure,
	isJsonObject,
	isJsonString,
	ok,
	parseJson,
	send,
	token,
} from "@hobo/cd-gitops";
import type { HttpTransport, JsonObject } from "@hobo/core";
import { isArgocdResourceName, parseArgocdControlConfig } from "./config.js";
import { ARGCD_FAILURES, ArgocdError } from "./errors.js";
import { argocdRefusal } from "./outcome.js";

export type ArgoCdClientConfig = Readonly<{
	apiBaseUrl: string;
	application: string;
	appNamespace: string;
	tokenRef: string;
}>;

function applicationUrl(
	base: string,
	name: string,
	appNamespace: string,
	suffix: string,
): string {
	if (!isArgocdResourceName(name) || !isArgocdResourceName(appNamespace)) {
		throw new ArgocdError(
			ARGCD_FAILURES.bodyInvalid,
			"Application name and namespace must be DNS-1123 labels",
		);
	}
	const root = base.replace(/\/$/, "");
	return `${root}/api/v1/applications/${encodeURIComponent(name)}${suffix}?appNamespace=${encodeURIComponent(appNamespace)}`;
}

function mapVerdict(
	verdict: ReturnType<typeof argoVerdict>,
): ClusterSyncObservation {
	const reason = verdict.reason
		? Object.freeze({
				code: verdict.reason.code,
				message: verdict.reason.message,
			})
		: undefined;
	const base = {
		state: verdict.state,
		healthy: verdict.healthy,
		appliedRevision: verdict.appliedRevision,
	};
	if (reason) {
		return Object.freeze({ ...base, reason });
	}
	return Object.freeze(base);
}

export function createArgoCdControlClient(
	inputConfig: ArgoCdClientConfig,
	http: HttpTransport,
	credentials: CredentialResolver,
): ClusterSyncPort {
	const config = parseArgocdControlConfig({
		apiBaseUrl: inputConfig.apiBaseUrl,
		application: inputConfig.application,
		appNamespace: inputConfig.appNamespace,
		tokenRef: inputConfig.tokenRef,
	});
	const target = `argocd:${config.apiBaseUrl}:${config.application}`;
	const bearer = (_ctx: CdContext) =>
		token(credentials, config.tokenRef, ENGINE_CREDENTIAL_SCOPE);

	const port: ClusterSyncPort = {
		target,
		async getWorkload(
			input: Readonly<{ name: string; namespace: string }>,
			ctx: CdContext,
		): Promise<Outcome<JsonObject>> {
			try {
				const url = applicationUrl(
					config.apiBaseUrl,
					input.name,
					input.namespace,
					"",
				);
				const response = await send(http, {
					method: "GET",
					url,
					headers: { authorization: `Bearer ${await bearer(ctx)}` },
				});
				if (response.status === 404) {
					return argocdRefusal(
						ARGCD_FAILURES.hostNotFound,
						`Application ${input.namespace}/${input.name} not found`,
						input.name,
					);
				}
				if (!ok(response)) {
					const failure = hostFailure(response, "get application");
					const code =
						failure.code === "gitops-host-auth-failed"
							? ARGCD_FAILURES.hostAuthFailed
							: failure.code === "gitops-host-not-found"
								? ARGCD_FAILURES.hostNotFound
								: ARGCD_FAILURES.hostRejected;
					return argocdRefusal(code, failure.message, input.name);
				}
				const application = parseJson(response, "get application");
				if (
					!isJsonObject(application.metadata) ||
					application.metadata.name !== input.name ||
					application.metadata.namespace !== input.namespace
				) {
					return argocdRefusal(
						ARGCD_FAILURES.bodyInvalid,
						"Argo CD returned a different or unidentified Application",
						input.name,
					);
				}
				return { ok: true, value: application };
			} catch (error) {
				if (error instanceof ArgocdError) {
					return argocdRefusal(error.code, error.message, input.name);
				}
				if (
					error instanceof GitopsError &&
					error.code === "gitops-credential-missing"
				) {
					return argocdRefusal(
						ARGCD_FAILURES.credentialMissing,
						"Argo CD credential is unavailable",
						input.name,
					);
				}
				return argocdRefusal(
					ARGCD_FAILURES.hostUnavailable,
					"Argo CD API request failed",
					input.name,
				);
			}
		},
		async requestSync(
			input: Readonly<{
				name: string;
				namespace: string;
				revision: string;
				manual?: boolean;
			}>,
			ctx: CdContext,
		): Promise<Outcome<void>> {
			try {
				if (!isJsonString(input.revision) || input.revision.trim() === "") {
					return argocdRefusal(
						ARGCD_FAILURES.bodyInvalid,
						"Argo CD sync requires a non-empty revision",
						input.name,
					);
				}
				const url = applicationUrl(
					config.apiBaseUrl,
					input.name,
					input.namespace,
					"/sync",
				);
				const response = await send(http, {
					method: "POST",
					url,
					headers: {
						authorization: `Bearer ${await bearer(ctx)}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(
						input.manual
							? {
									revision: input.revision,
									prune: false,
									dryRun: false,
									syncStrategy: { hook: {} },
								}
							: {
									revision: input.revision,
									prune: false,
									dryRun: false,
								},
					),
				});
				if (response.status === 404) {
					return argocdRefusal(
						ARGCD_FAILURES.hostNotFound,
						`Application ${input.namespace}/${input.name} not found`,
						input.name,
					);
				}
				if (!ok(response)) {
					const failure = hostFailure(response, "sync application");
					return argocdRefusal(
						ARGCD_FAILURES.syncFailed,
						failure.message,
						input.name,
					);
				}
				return { ok: true, value: undefined };
			} catch (error) {
				if (error instanceof ArgocdError) {
					return argocdRefusal(error.code, error.message, input.name);
				}
				if (
					error instanceof GitopsError &&
					error.code === "gitops-credential-missing"
				) {
					return argocdRefusal(
						ARGCD_FAILURES.credentialMissing,
						"Argo CD credential is unavailable",
						input.name,
					);
				}
				return argocdRefusal(
					ARGCD_FAILURES.hostUnavailable,
					"Argo CD API request failed",
					input.name,
				);
			}
		},
		async observeSync(
			input: Readonly<{ name: string; namespace: string; revision: string }>,
			ctx: CdContext,
		): Promise<ClusterSyncObservation> {
			const got = await port.getWorkload(
				{ name: input.name, namespace: input.namespace },
				ctx,
			);
			if (!got.ok) {
				return Object.freeze({
					state: "converging",
					healthy: false,
					appliedRevision: "",
					reason: Object.freeze({
						code: got.reasons[0]?.code ?? ARGCD_FAILURES.hostUnavailable,
						message: got.reasons[0]?.message ?? "cluster sync API unreachable",
					}),
				});
			}
			return mapVerdict(argoVerdict(got.value, input.revision));
		},
	};
	return Object.freeze(port);
}
