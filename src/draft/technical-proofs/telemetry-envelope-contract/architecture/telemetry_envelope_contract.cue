
package architecture_evidence

#TelemetryEnvelopeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TelemetryEnvelopeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
