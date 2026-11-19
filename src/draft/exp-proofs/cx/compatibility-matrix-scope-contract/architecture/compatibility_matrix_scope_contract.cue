
package architecture_evidence

#CompatibilityMatrixScopeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CompatibilityMatrixScopeRecord: {
	issue:            string & !=""
	phase:            "M0"
	summary:          string & !=""
	personas:         [...string]
	owner_boundaries: [...string]
	scope_out:        [...string]
	evidence:         [...string]
}
