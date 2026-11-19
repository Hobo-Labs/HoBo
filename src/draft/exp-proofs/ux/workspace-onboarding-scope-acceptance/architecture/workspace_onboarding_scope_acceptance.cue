
package architecture_evidence

#WorkspaceOnboardingScopeAcceptanceEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WorkspaceOnboardingScopeAcceptanceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
