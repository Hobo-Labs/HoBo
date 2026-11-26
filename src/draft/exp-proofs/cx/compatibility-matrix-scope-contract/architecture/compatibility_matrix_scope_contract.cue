// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

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
