
package architecture_evidence

#SvidAutoRotationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SvidAutoRotationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
