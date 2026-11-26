// Typed failure modes of the GitOps publisher, each with its remediation.
// Publish failures are returned as a Refusal (ReasonRecord); observation
// problems are reasons on a non-converged observation, never a throw.

// public-contract: cd-gitops failure codes with remediation.
export const GITOPS_FAILURES = Object.freeze({
	"gitops-config-invalid": {
		remediation:
			"Fix the publisher configuration (hobo.cd-gitops.publisher/v1): https API and clone URLs, owner/name repository, a branch, a relative path prefix and credential references.",
	},
	"gitops-credential-missing": {
		remediation:
			"Store `{ token }` under the publisher's credential_ref (Git host) or endpoint.credential_ref (engine). Credentials stay where the publisher runs and are never recorded.",
	},
	"gitops-host-auth-failed": {
		remediation:
			"The Git host refused the token (401/403). Grant it contents read/write on the repository and branch, and check branch protection allows the publisher to push.",
	},
	"gitops-host-not-found": {
		remediation:
			"The repository or branch does not exist on the Git host (404). Create the branch or fix repository/branch in the publisher configuration.",
	},
	"gitops-host-conflict": {
		remediation:
			"The branch moved while publishing and the retry also lost the race. Something else writes the same branch: give HoBo its own branch or path prefix.",
	},
	"gitops-host-unavailable": {
		remediation:
			"The Git host failed (5xx, 429 or transport). Nothing was committed; the reconciler retries on its next pass. Check the host's status.",
	},
	"gitops-host-response-invalid": {
		remediation:
			"The Git host answered with a body the adapter cannot read. Check that api_base_url points at the host's REST API root (for example https://gitlab.example/api/v4).",
	},
	"gitops-set-too-large": {
		remediation:
			"The resolved set exceeds the ConfigMap budget (900 KiB). Split the Bindle or deliver this Camp through an agent reconciler instead of a GitOps publisher.",
	},
	"gitops-engine-unobservable": {
		remediation:
			"The engine status API could not be read; convergence is not assumed. Check endpoint.api_base_url, the engine token and network reach from the publisher.",
	},
	"gitops-engine-not-found": {
		remediation:
			"The engine has not created the Application/Kustomization yet. Bootstrap one root app (app-of-apps) or root Kustomization over the publisher's path prefix.",
	},
	"gitops-engine-not-converged": {
		remediation:
			"The engine has not yet synced the published revision or is still progressing. Wait for the next observation; the reconciler keeps observing until the deadline.",
	},
	"gitops-engine-degraded": {
		remediation:
			"The engine synced the revision but reports it degraded or failed. Read the engine's conditions for the failing resource; roll back through HoBo, not the engine.",
	},
	"gitops-publisher-unknown": {
		remediation:
			"The delivery policy names a publisher target with no configured publisher. Configure a cd-gitops publisher with that name (argo-cd or flux).",
	},
} as const);

export type GitopsFailureCode = keyof typeof GITOPS_FAILURES;

export class GitopsError extends Error {
	readonly code: GitopsFailureCode;
	readonly remediation: string;
	readonly status: number | undefined;
	constructor(code: GitopsFailureCode, message: string, status?: number) {
		super(`${code}: ${message}`);
		this.name = "GitopsError";
		this.code = code;
		this.remediation = GITOPS_FAILURES[code].remediation;
		this.status = status;
	}
}
