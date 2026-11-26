// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchSupportEscalationMatrixEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LaunchSupportEscalationMatrixRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

