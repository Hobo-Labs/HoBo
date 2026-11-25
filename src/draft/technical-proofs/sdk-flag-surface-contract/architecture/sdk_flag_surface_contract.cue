
package architecture_evidence

#SdkFlagSurfaceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SdkFlagSurfaceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
