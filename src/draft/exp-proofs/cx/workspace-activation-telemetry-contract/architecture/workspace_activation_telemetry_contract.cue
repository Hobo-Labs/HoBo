
package architecture_evidence

#WorkspaceActivationTelemetryContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WorkspaceActivationTelemetryContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
