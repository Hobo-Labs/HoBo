
package architecture_evidence

#XaaScopeInferenceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#XaaScopeInferenceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
