
package architecture_evidence

#HoboExperimentPortEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboExperimentPortRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
