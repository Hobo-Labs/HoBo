// Typed failure modes of @hobo/cd-kube-fleet, each with its remediation.
// Realizers never throw for a target-side problem: it becomes a ReasonRecord
// on a non-converged ReconcileObservationRecord. Configuration problems are
// thrown at construction (parse boundary). Only an aborted signal rejects.
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "@hobo/cd";

// public-contract: cd-kube-fleet failure codes with remediation.
export const KUBE_FLEET_FAILURES = Object.freeze({
	"kube-fleet-config-invalid": {
		remediation:
			"Fix the configuration record (hobo.cd-kube-fleet.*/v1): an https API base URL without a path, a credential reference, DNS-1123 cluster names and a known DepartureAction.",
	},
	"kube-credential-missing": {
		remediation:
			"Store `{ token }` under the hub's credential_ref (bearer), or make the host's exec plugin return an ExecCredential status with a token (exec). Credentials stay where the reconciler runs and are never recorded.",
	},
	"kube-credential-unsupported": {
		remediation:
			"The exec plugin returned client-certificate credentials. HttpTransport carries bearer tokens only: configure the plugin (or a ClusterProfile access provider) to issue a token.",
	},
	"kube-credential-expired": {
		remediation:
			"The exec credential's expirationTimestamp has passed. The host's exec plugin must return a fresh token per resolve; nothing was sent with the expired one.",
	},
	"kube-auth-failed": {
		remediation:
			"The API server refused the token (401/403). Grant the hub identity get/list/watch/create/update/delete on the resources this adapter manages (ManifestWorks, or templates, PropagationPolicies and ResourceBindings, or ClusterProfiles).",
	},
	"kube-conflict": {
		remediation:
			"Another writer changed the object between read and write (409). The next reconcile pass re-reads and retries; if it persists, find the other writer of the object.",
	},
	"kube-unavailable": {
		remediation:
			"The API server failed (5xx, 429 or transport). Nothing is assumed converged; the reconciler retries on its next pass. Check the hub's health and network reach from the reconciler.",
	},
	"kube-response-invalid": {
		remediation:
			"The API server answered with a body this adapter cannot read. Check that api_base_url points at the hub's Kubernetes API root and that the CRDs are installed at the expected versions.",
	},
	"kube-cluster-unmapped": {
		remediation:
			"The Camp has no cluster mapping. Add a CampClusterRecord (camp_id, cluster) for it to the realizer configuration.",
	},
	"kube-object-unrenderable": {
		remediation:
			"A plan resource has no Kubernetes form. Give it realizationParameters.manifest (apiVersion, kind, metadata.name) or a known productId with realizationParameters.spec.",
	},
	"kube-kind-unknown": {
		remediation:
			"The manifest's kind is not in the built-in table. Declare its REST plural in realizationParameters.resource and realizationParameters.namespaced (true/false).",
	},
	"kube-secret-refused": {
		remediation:
			"Secrets never travel in a Set (I9). Reference the secret instead (secretRefs) and materialize it on the cluster with the cluster's own secret operator.",
	},
	"kube-name-invalid": {
		remediation:
			"Kubernetes names must be DNS-1123 (lower-case alphanumerics and '-', at most 253 characters; namespaces at most 63). Rename the resource in the declaration.",
	},
	"resolved-set-mismatch": {
		remediation:
			"The resolved set does not match the Set's content hash. Restore the resolved-set blob in the artifact store (or re-apply the Set); nothing was applied.",
	},
	"stale-fence": {
		remediation:
			"The hub object carries a newer reconciler fence: this process lost the Camp lease. Stop it; the current lease holder owns the Camp.",
	},
	"ocm-work-not-applied": {
		remediation:
			"The klusterlet work agent has not applied the current ManifestWork generation yet. Wait for the next observation; if it never applies, check the ManagedCluster is joined and its work agent is running.",
	},
	"ocm-work-not-available": {
		remediation:
			"The ManifestWork applied but its resources are not Available yet. Wait for the next observation; HoBo verification decides at the deadline.",
	},
	"ocm-work-apply-failed": {
		remediation:
			"The work agent could not apply a manifest (Applied=False). Read the manifest condition message, fix the declaration and promote again, or roll back through HoBo.",
	},
	"ocm-work-missing": {
		remediation:
			"The Camp's ManifestWork is gone from the hub. This is drift: the reconciler re-applies the Set, or routes it per the drift policy.",
	},
	"ocm-work-modified": {
		remediation:
			"The ManifestWork's manifests differ from the Set (edited on the hub). This is drift: the reconciler re-applies the Set. Change the declaration instead of the hub.",
	},
	"ocm-superseded-work-pending": {
		remediation:
			"An older ManifestWork for this Camp is still being removed. Wait for the next observation; resources it alone owned are removed per the DepartureAction.",
	},
	"kube-attribute-unobservable": {
		remediation:
			"OCM status feedback reads `.status` fields only. Posture packs should observe `status.*` attributes for OCM-backed Camps; this attribute is reported as absent (posture: unknown).",
	},
	"kube-workload-not-ready": {
		remediation:
			"The workload reports fewer ready replicas than desired. Wait for the next observation; HoBo verification decides at the deadline.",
	},
	"karmada-template-conflict": {
		remediation:
			"A resource template with the same name and namespace exists on the Karmada control plane and is not this Camp's. Give each Camp its own namespace (a Camp mapping rule) so templates never collide.",
	},
	"karmada-cluster-scoped-unsupported": {
		remediation:
			"The Karmada realizer propagates namespaced templates only. Create cluster-scoped objects (Namespaces, ClusterRoles) with the member's bootstrap, or deliver this Camp through the OCM realizer.",
	},
	"karmada-binding-pending": {
		remediation:
			"Karmada has not bound the current template revision yet. Wait for the next observation.",
	},
	"karmada-pinning-violated": {
		remediation:
			"The ResourceBinding targets clusters other than the Camp's member. Something other than HoBo changed placement (an OverridePolicy, a failover or the scheduler). Remove it; HoBo never lets Karmada schedule or fail over a delivery.",
	},
	"karmada-member-unhealthy": {
		remediation:
			"The member reports the propagated resource as not applied or not Healthy. Read the binding's aggregated status for the member's message; HoBo verification decides at the deadline.",
	},
	"karmada-keep-retained": {
		remediation:
			"A resource the departure keeps sits under a PropagationPolicy that does not preserve resources on deletion, so its template is left in place. Delete the template by hand once the data is safe, or keep it.",
	},
	"clusterprofile-invalid": {
		remediation:
			"The ClusterProfile is missing required fields (metadata.name/namespace) or has an unparseable status. It is skipped; fix it on the inventory hub.",
	},
	"clusterprofile-camp-collision": {
		remediation:
			"Two ClusterProfiles map to the same Camp id. Rename one profile, or set a distinct camp_id_prefix per import.",
	},
	"clusterprofile-access-missing": {
		remediation:
			"The ClusterProfile names no access provider (status.accessProviders), so its API cannot be reached. Install an access provider plugin on the inventory hub.",
	},
	"clusterprofile-unknown": {
		remediation:
			"The Camp is not an imported ClusterProfile. List the inventory again; the profile may have been deleted.",
	},
} as const);

export type KubeFleetFailureCode = keyof typeof KUBE_FLEET_FAILURES;

export class KubeFleetError extends Error {
	readonly code: KubeFleetFailureCode;
	readonly remediation: string;
	readonly status: number | undefined;
	constructor(code: KubeFleetFailureCode, message: string, status?: number) {
		super(`${code}: ${message}`);
		this.name = "KubeFleetError";
		this.code = code;
		this.remediation = KUBE_FLEET_FAILURES[code].remediation;
		this.status = status;
	}
}

/** A ReasonRecord for one failure code, with its remediation. */
export function reason(
	code: KubeFleetFailureCode,
	message: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, {
		code,
		message,
		remediation: KUBE_FLEET_FAILURES[code].remediation,
		subject,
	});
}

/** A ReasonRecord for a caught error; unknown errors map to kube-unavailable. */
export function reasonOf(error: Error, subject = ""): ReasonRecord {
	if (error instanceof KubeFleetError)
		return reason(error.code, error.message, subject);
	return reason("kube-unavailable", error.message, subject);
}
