// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#VibeFirstCustomerPilotProofMode: "unspecified" | "live" | "simulated" | "reference fixture" | "scope-out"

#VibeFirstCustomerPilotStoryboardStep: {
	stage:              "invite" | "workspace-setup" | "project-choice" | "first-proof" | "failure-recovery" | "support-handoff" | "feedback-capture"
	title:              string & !=""
	personas:           [...string]
	operating_question: string & !=""
	evidence_source:    string & !=""
}

#VibeFirstCustomerPilotScriptArtifact: {
	stage:                 "invite" | "workspace-setup" | "project-choice" | "first-proof" | "failure-recovery" | "support-handoff" | "feedback-capture"
	entry_criteria:        string & !=""
	exit_criteria:         string & !=""
	consent_state:         string & !=""
	proof_mode:            #VibeFirstCustomerPilotProofMode
	blocker_category:      string & !=""
	owner:                 string & !=""
	safe_next_action:      string & !=""
	customer_safe_message: string & !=""
}

#VibeFirstCustomerPilotScenarioPath: {
	id:           "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
	stage_ids:    [...string]
	narrative:    string & !=""
	safe_outcome: string & !=""
}

#VibeFirstCustomerPilotQuickstartFixtureReference: {
	source_issue: "HOBO-577"
	fixture_id:   "rlq-define-object-graph-v1" | "rlq-plan-safe-preview-v1" | "rlq-deploy-run-accepted-v1" | "rlq-manage-stale-evidence-v1" | "rlq-recover-scope-out-v1"
	pilot_use:    string & !=""
}

#VibeFirstCustomerPilotStoryboardRecord: {
	issue:                   "HOBO-549"
	phase:                   "M1"
	package_path:            "src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard"
	proof_path:              "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md"
	design_refs:             [...string]
	quickstart_fixture_refs: [...#VibeFirstCustomerPilotQuickstartFixtureReference]
	personas:                [...string]
	storyboard:              [...#VibeFirstCustomerPilotStoryboardStep]
	script_artifacts:        [...#VibeFirstCustomerPilotScriptArtifact]
	scenario_paths:          [...#VibeFirstCustomerPilotScenarioPath]
	accessibility_notes:     [...string]
	scope_out:               [...string]
}
