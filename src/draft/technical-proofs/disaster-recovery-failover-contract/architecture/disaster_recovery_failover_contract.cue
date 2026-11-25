
package architecture_evidence

#DisasterRecoveryFailoverContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DisasterRecoveryFailoverContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
