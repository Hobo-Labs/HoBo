
package architecture_evidence

#OpeninferenceLiveEvalStreamContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OpeninferenceLiveEvalStreamContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
