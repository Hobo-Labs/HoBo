// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#BillingCreditsScopeEvidenceKind: "unspecified" | "design-record" | "contract-test" | "support-handoff" | "legal-review"

#BillingCreditsPersona: {
	role: string & !=""
	need: string & !=""
}

#BillingCreditsDependency: {
	source: string & !=""
	reason: string & !=""
}

#BillingCreditsEvidence: {
	kind:       string & !=""
	owner:      string & !=""
	proof_mode: "design-record" | "contract-test" | "reference-fixture" | "support-handoff" | "legal-review" | "audit-record"
	source:     string & !=""
	proves:     string & !=""
}

#BillingCreditsLimitation: {
	id:      string & !=""
	message: string & !=""
	owner:   string & !=""
}

#BillingCreditsScopeRecord: {
	issue:    "HOBO-418"
	project:  "Billing & Credits"
	phase:    "M0"
	goal:     string & !=""
	personas: [...#BillingCreditsPersona]
	scope_in: [...string]
	scope_out: [...string]
	non_goals: [...string]
	dependencies: [...#BillingCreditsDependency]
	initiative_dependencies: [...#BillingCreditsDependency]
	customer_visible_limitations: [...#BillingCreditsLimitation]
	m1_evidence: [...#BillingCreditsEvidence]
}
