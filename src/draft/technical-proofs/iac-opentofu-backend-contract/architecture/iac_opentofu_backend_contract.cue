
package architecture_evidence

#IacOpentofuBackendContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IacOpentofuBackendContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
