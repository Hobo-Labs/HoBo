
package architecture_evidence

#ReadsYourWritesContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ReadsYourWritesContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
