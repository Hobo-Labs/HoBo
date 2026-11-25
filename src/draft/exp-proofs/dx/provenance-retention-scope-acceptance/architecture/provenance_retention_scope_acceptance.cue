
package architecture_evidence

#ProvenanceRetentionScopeAcceptanceEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProvenanceRetentionScopeAcceptanceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
