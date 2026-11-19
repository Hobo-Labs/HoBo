
package architecture_evidence

#StaticKeyEscapeHatchContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#StaticKeyEscapeHatchContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
