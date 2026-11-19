
package architecture_evidence

#HoboFeatureFlagPortEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboFeatureFlagPortRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
