
package architecture_evidence

#GraphqlFacadeRuntimeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GraphqlFacadeRuntimeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
