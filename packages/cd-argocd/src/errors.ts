export const ARGCD_FAILURES = Object.freeze({
	hostUnavailable: "argocd-host-unavailable",
	hostAuthFailed: "argocd-host-auth-failed",
	hostNotFound: "argocd-host-not-found",
	hostRejected: "argocd-host-rejected",
	syncFailed: "argocd-sync-failed",
	bodyInvalid: "argocd-body-invalid",
	credentialMissing: "argocd-credential-missing",
	runbookInvalid: "argocd-runbook-invalid",
} as const);

export type ArgocdFailureCode =
	(typeof ARGCD_FAILURES)[keyof typeof ARGCD_FAILURES];

export class ArgocdError extends Error {
	readonly code: ArgocdFailureCode;
	readonly httpStatus?: number | undefined;

	constructor(
		code: ArgocdFailureCode,
		message: string,
		httpStatus?: number | undefined,
	) {
		super(message);
		this.name = "ArgocdError";
		this.code = code;
		if (httpStatus !== undefined) this.httpStatus = httpStatus;
	}
}
