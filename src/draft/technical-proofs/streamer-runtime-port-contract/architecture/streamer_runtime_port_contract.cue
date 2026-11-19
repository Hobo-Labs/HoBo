
package architecture_evidence

#StreamerRuntimePortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#StreamerRuntimePortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
