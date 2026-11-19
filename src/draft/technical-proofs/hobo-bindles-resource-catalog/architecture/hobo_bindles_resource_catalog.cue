
package architecture_evidence

#HoboBindlesResourceCatalogEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboBindlesResourceCatalogRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
