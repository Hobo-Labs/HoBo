
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
