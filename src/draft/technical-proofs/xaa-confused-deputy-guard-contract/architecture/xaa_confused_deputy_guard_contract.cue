
package architecture_evidence

#XaaConfusedDeputyGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#XaaConfusedDeputyGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
