
package architecture_evidence

#DefaultReadSurfaceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DefaultReadSurfaceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
