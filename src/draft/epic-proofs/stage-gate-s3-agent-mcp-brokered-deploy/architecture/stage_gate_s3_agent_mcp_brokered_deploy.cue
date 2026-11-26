// CUE constraints for Stage Gate S3 drill evidence records.

package architecture_evidence

#StageGateS3EvidenceKind: "unspecified" | "j2-journey" | "adversarial"

#StageGateS3DrillRecord: {
	issue:                 string & !=""
	journey:               string & !=""
	fixture:               string & !=""
	token_event_types:     [...string]
	replayable:            bool
	static_secrets_absent: bool
}
