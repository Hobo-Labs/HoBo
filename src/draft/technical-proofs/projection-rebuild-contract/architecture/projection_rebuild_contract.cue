
package architecture_evidence

#ProjectionRebuildContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProjectionRebuildContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
