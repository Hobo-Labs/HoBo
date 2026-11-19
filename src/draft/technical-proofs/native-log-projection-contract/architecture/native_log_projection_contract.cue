
package architecture_evidence

#NativeLogProjectionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#NativeLogProjectionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
