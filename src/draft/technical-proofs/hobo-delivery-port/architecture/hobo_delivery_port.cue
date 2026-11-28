
package architecture_evidence

#HoboDeliveryPortEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboDeliveryPortRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
