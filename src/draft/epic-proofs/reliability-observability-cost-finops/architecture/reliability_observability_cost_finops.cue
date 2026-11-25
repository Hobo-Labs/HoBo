
package architecture_evidence

#ReliabilityObservabilityCostFinopsEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ReliabilityObservabilityCostFinopsRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
