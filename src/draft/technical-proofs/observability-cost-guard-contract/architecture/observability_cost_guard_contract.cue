
package architecture_evidence

#ObservabilityCostGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ObservabilityCostGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
