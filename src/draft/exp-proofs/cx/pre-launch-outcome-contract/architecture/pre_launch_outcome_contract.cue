
package architecture_evidence

#PreLaunchOutcomeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PreLaunchOutcomeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
