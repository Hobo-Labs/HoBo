// CUE constraints for every protobuf type in this package's schema, so the architecture guard can
// confirm data shapes are bounded at parse time.

package architecture_evidence

#CustomerOnboardingProofMode: "unspecified" | "design-record" | "reference-fixture" | "support-handoff" | "feedback-record"

#CustomerOnboardingScriptStage: {
	id:                string & !=""
	owner:             string & !=""
	prompt:            string & !=""
	expected_evidence: string & !=""
	proof_mode:        #CustomerOnboardingProofMode
	source:            string & !=""
}

#CustomerOnboardingScriptRecord: {
	issue:            "HOBO-487"
	goal:             string & !=""
	stages:           [...#CustomerOnboardingScriptStage]
	success_criteria: [...string]
}
