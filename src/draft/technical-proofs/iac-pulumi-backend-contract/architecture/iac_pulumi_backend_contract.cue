
package architecture_evidence

#IacPulumiBackendContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IacPulumiBackendContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
