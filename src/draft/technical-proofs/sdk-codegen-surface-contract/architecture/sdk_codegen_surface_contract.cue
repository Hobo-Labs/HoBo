
package architecture_evidence

#SdkCodegenSurfaceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SdkCodegenSurfaceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
