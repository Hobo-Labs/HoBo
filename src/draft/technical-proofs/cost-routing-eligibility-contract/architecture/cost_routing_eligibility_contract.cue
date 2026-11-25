
package architecture_evidence

#CostRoutingEligibilityContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CostRoutingEligibilityContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
