import { create } from "@bufbuild/protobuf";
import { ReasonRecordSchema, type Refusal } from "@hobo/cd";
import { ARGCD_FAILURES, type ArgocdFailureCode } from "./errors.js";

const REMEDIATION = {
	[ARGCD_FAILURES.hostUnavailable]:
		"Restore reachability to the Argo CD API or check network policy.",
	[ARGCD_FAILURES.hostAuthFailed]:
		"Rotate the Argo CD token credential and verify RBAC on the Application.",
	[ARGCD_FAILURES.hostNotFound]:
		"Create the Application or fix the name and appNamespace.",
	[ARGCD_FAILURES.hostRejected]:
		"Inspect the Argo CD API response; retry after fixing the request.",
	[ARGCD_FAILURES.syncFailed]:
		"Inspect the Application sync operation in Argo CD; fix manifests or policy.",
	[ARGCD_FAILURES.bodyInvalid]:
		"Correct the Argo CD request or check the API response.",
	[ARGCD_FAILURES.credentialMissing]:
		"Bind an Argo CD API token through the owner credential store.",
	[ARGCD_FAILURES.runbookInvalid]:
		"Declare the RUNBOOK hook with a valid argocd-sync payload.",
} satisfies Record<ArgocdFailureCode, string>;

export function argocdRefusal(
	code: ArgocdFailureCode,
	message: string,
	subject = "",
): Refusal {
	return {
		ok: false,
		reasons: [
			create(ReasonRecordSchema, {
				code,
				message,
				remediation: REMEDIATION[code],
				subject,
			}),
		],
	};
}
