
package architecture_evidence

#CuratedCatalogPolicyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CuratedCatalogPolicyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
