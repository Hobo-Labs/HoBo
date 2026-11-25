
package architecture_evidence

#OrgCatalogsScopeAcceptanceEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OrgCatalogsScopeAcceptanceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
