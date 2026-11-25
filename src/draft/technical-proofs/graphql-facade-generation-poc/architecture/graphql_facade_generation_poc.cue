
package architecture_evidence

#GraphqlFacadeGenerationPocEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GraphqlFacadeGenerationPocRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
