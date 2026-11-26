// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#LaunchDemoProofMode: "unspecified" | "live-product" | "reference-fixture" | "simulated-reference" | "design-record"

#LaunchDemoSampleApp: {
	id:     string & !=""
	source: string & !=""
	reason: string & !=""
}

#LaunchDemoPersona: {
	role: string & !=""
	need: string & !=""
}

#LaunchDemoCommandStep: {
	id:             string & !=""
	command:        string & !=""
	screen:         string & !=""
	proof_mode:     #LaunchDemoProofMode
	claim_boundary: string & !=""
}

#LaunchDemoExpectedOutput: {
	id:         string & !=""
	output:     string & !=""
	proof_mode: #LaunchDemoProofMode
}

#LaunchDemoEvidenceArtifact: {
	kind:            string & !=""
	owner:           string & !=""
	proof_mode:      #LaunchDemoProofMode
	source:          string & !=""
	refresh_trigger: string & !=""
}

#LaunchDemoGoldenPathRecord: {
	issue:              "HOBO-488"
	project:            string & !=""
	phase:              "M0"
	sample_app:         #LaunchDemoSampleApp
	primary_persona:    #LaunchDemoPersona
	command_path:       [...#LaunchDemoCommandStep]
	expected_outputs:   [...#LaunchDemoExpectedOutput]
	evidence_artifacts: [...#LaunchDemoEvidenceArtifact]
	failure_recovery:   [...string]
	scope_out:          [...string]
}
