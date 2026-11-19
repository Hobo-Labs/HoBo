
package architecture_evidence

#IacCrossplaneBackendContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IacCrossplaneBackendContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
