
package architecture_evidence

#RunawayRemediationGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RunawayRemediationGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
