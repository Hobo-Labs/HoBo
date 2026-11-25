package architecture_evidence

#VibePilotFirstProofMode: "unspecified" | "live" | "simulated" | "reference fixture" | "scope-out"

#PilotStage: "invite" | "workspace-setup" | "project-choice" | "first-proof" | "failure-recovery" | "support-handoff" | "feedback-capture"

#PilotBlockerRoute: "cutline" | "docs" | "product-ux" | "support" | "engineering"

#VibePilotFirstProofConsumedStoryboard: {
	source_issue: "HOBO-549"
	package_path: "src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard"
	proof_path:   "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md"
	stages:       [...#PilotStage]
}

#VibePilotFirstProofWalkthroughStep: {
	stage:                   #PilotStage
	source_storyboard_stage: #PilotStage
	title:                   string & !=""
	persona:                 string & !=""
	user_action:             string & !=""
	expected_evidence:       string & !=""
	blocker_route:           #PilotBlockerRoute
	proof_mode:              #VibePilotFirstProofMode
	customer_safe_message:   string & !=""
}

#VibePilotFirstProofScenarioPath: {
	id:           "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
	stage_ids:    [...#PilotStage]
	narrative:    string & !=""
	safe_outcome: string & !=""
}

#VibePilotFirstProofBlockerRoute: {
	route:                 #PilotBlockerRoute
	trigger:               string & !=""
	owner:                 string & !=""
	safe_next_action:      string & !=""
	customer_safe_message: string & !=""
}

#VibePilotFirstProofSupportHandoffEvidence: {
	severity:              string & !=""
	redaction_state:       string & !=""
	evidence_link:         string & !=""
	next_update_condition: string & !=""
}

#VibePilotFirstProofWalkthroughRecord: {
	issue:                    "HOBO-563"
	phase:                    "M2"
	package_path:             "src/draft/exp-proofs/ux/vibe-pilot-first-proof-walkthrough"
	proof_path:               "docs/design/proofs/vibe-pilot-first-proof-walkthrough/README.md"
	design_refs:              [...string]
	consumed_storyboard:      #VibePilotFirstProofConsumedStoryboard
	steps:                    [...#VibePilotFirstProofWalkthroughStep]
	scenario_paths:           [...#VibePilotFirstProofScenarioPath]
	blocker_routes:           [...#VibePilotFirstProofBlockerRoute]
	support_handoff_evidence: #VibePilotFirstProofSupportHandoffEvidence
	accessibility_notes:      [...string]
	scope_out:                [...string]
}
