
package architecture_evidence

#RegistryPublishFlowContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RegistryPublishFlowContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
