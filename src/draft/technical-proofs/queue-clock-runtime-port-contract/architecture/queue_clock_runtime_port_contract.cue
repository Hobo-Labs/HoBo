
package architecture_evidence

#QueueClockRuntimePortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#QueueClockRuntimePortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
