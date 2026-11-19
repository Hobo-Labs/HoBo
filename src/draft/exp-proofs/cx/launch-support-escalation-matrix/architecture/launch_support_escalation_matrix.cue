
package architecture_evidence

#LaunchSupportEscalationMatrixEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LaunchSupportEscalationMatrixRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
