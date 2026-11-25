
package architecture_evidence

#VmMicrovmBuildProvidersContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#VmMicrovmBuildProvidersContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
