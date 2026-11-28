
package architecture_evidence

#GatedAutonomousRemediationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GatedAutonomousRemediationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
