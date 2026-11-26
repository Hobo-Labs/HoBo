// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#DriftReconciliationState: "unspecified" | "detected" | "classified" | "source-of-truth-pinned" | "proposed" | "reconciling" | "ignored" | "escalated" | "resolved"

#DriftReconciliationScopeRecord: {
	issue:                 string & !=""
	summary:               string & !=""
	drift_classes:         [...string]
	reconciliation_states: [...string]
	required_evidence:     [...string]
	m1_evidence:           [...string]
}
