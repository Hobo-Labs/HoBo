
package architecture_evidence

#PolicyEnginePortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicyEnginePortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
