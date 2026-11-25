
package architecture_evidence

#RawDriverEscapeHatchContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RawDriverEscapeHatchContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
