// CUE constraints for the Reconciliation records in cd.proto (WP7).
// Field names follow the protobuf JSON mapping the journal stores (status
// events carry `observation` in this shape). The TS module src/reconcile
// applies the same rules: observation.ts (attribute bound, secret-free
// values, retained), retained.ts (drift_kind grammar), transport.ts (stamps).
// Records owned by other modules are referenced as open structs so this file
// vets on its own and unifies with theirs.
package cd

#ReconcilerMode:
	"RECONCILER_MODE_CONDUCTOR" |
	"RECONCILER_MODE_AGENT" |
	"RECONCILER_MODE_PUBLISHER"

#ReconcileStatus:
	"RECONCILE_STATUS_CONVERGING" |
	"RECONCILE_STATUS_CONVERGED" |
	"RECONCILE_STATUS_BLOCKED" |
	"RECONCILE_STATUS_DRIFTED" |
	"RECONCILE_STATUS_OBSERVED"

#reconcileDecimal:   =~"^(0|[1-9][0-9]*)$"
#reconcileTimestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"

// `<class>` or `<class>:<field>[,<field>...]` (src/reconcile/retained.ts).
#reconcileDriftKind: "" | =~"^(modified|deleted|orphan|external|[a-z][a-z-]*)(:[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*)?$"

#reconcileReason: {
	code:         =~"^[a-z][a-z0-9-]*$"
	message?:     string
	remediation?: string
	subject?:     string
}

#ReconcilerRecord: {
	reconcilerId: string & !=""
	mode:         #ReconcilerMode
	campIds?: [...(string & !="")]
	// RFC 7638 JWK thumbprint (base64url SHA-256) bound into the SVID cnf.jkt.
	keyThumbprint?:       =~"^[A-Za-z0-9_-]{43}$"
	enrolledBy?:          string
	enrolledAt?:          #reconcileTimestamp
	revokedAt?:           #reconcileTimestamp
	enrollment?:          "ENROLLMENT_STATE_PENDING" | "ENROLLMENT_STATE_ACCEPTED" | "ENROLLMENT_STATE_REVOKED"
	bootstrapScope?:      string
	keyApprovedBy?:       string
	acceptedBy?:          string
	autoAcceptedByScope?: string
}

#ResourceObservation: {
	resource:        string & !=""
	physicalId?:     string
	outputsHash?:    string
	healthy?:        bool
	driftKind?:      #reconcileDriftKind
	kind?:           string
	classification?: string
	// Only declared observe_fields; secret-free; <= 16 KiB per resource
	// (enforced in observation.ts, where byte length is measurable).
	attributes?: {[string]: string}
	// Fields owned on the target side and excluded from drift (D22).
	retained?: [...(string & !="")]
}

#ReconcileObservationRecord: {
	campId:       string & !=""
	setId?:       string
	reconcilerId: string & !=""
	// Decimal FenceToken of the lease that wrote it (I4).
	fenceToken: #reconcileDecimal
	status:     #ReconcileStatus
	resources?: [...#ResourceObservation]
	reasons?: [...#reconcileReason]
	observedAt: #reconcileTimestamp
	// Observed, never trusted to grant (I19).
	claims?: [...{
		name:        string & !=""
		value?:      string
		reportedBy:  string & !=""
		observedAt?: #reconcileTimestamp
	}]
	// Declared handover outputs (D23), secret-free.
	handover?: {[string]: string}
}

// A BLOCKED observation always says why.
#ReconcileObservationRecord: {
	status: _
	if status == "RECONCILE_STATUS_BLOCKED" {
		reasons: [_, ...]
	}
}

#DeliveryFeedFrame: {
	position: #reconcileDecimal
	set: {...}
	resolvedSetJson?: string
	observeFields?: [...(string & !="")]
	management?: "CAMP_MANAGEMENT_MANAGED" | "CAMP_MANAGEMENT_OBSERVE_ONLY"
	policy?: {...}
}

// The body of every reconcile status event (src/reconcile/status-events.ts).
#ReconcileStatusEvent: {
	schema:      "hobo.cd.reconcile-status/v1"
	observation: #ReconcileObservationRecord
	drift?: [...{
		resource:   string & !=""
		driftClass: "modified" | "deleted" | "orphan" | "external" | "unknown"
		fields: [...string]
		outputsHash?: string
	}]
	orphans?: [...(string & !="")]
}
