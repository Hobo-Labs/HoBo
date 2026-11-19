
package architecture_evidence

#ProviderAuthoringContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderAuthoringContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
