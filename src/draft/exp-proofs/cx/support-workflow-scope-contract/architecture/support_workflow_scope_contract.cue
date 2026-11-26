// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#SupportWorkflowIntakeState: "unspecified" | "received" | "classified" | "evidence-linked" | "owner-routed" | "customer-updated" | "closed"

#SupportWorkflowScopeRecord: {
	issue:             string & !=""
	summary:           string & !=""
	intake_states:     [...string]
	required_evidence: [...string]
	owner_routes:      [...string]
	m1_evidence:       [...string]
}
