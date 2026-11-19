
package architecture_evidence

#ProgressiveDeliveryHarnessEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProgressiveDeliveryHarnessRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
