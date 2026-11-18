package architecture_evidence

#VibeClickableFirstRunProofMode: "unspecified" | "live" | "simulated" | "reference fixture" | "scope-out"

#WalkthroughStage: "workspace-entry" | "project-setup" | "plan-preview" | "blocked-recovery" | "value-proof"

#HandoffSurface: "docs-portal" | "tutorials" | "troubleshooting" | "support-workflow"

#VibeClickableFirstRunConsumedActivationRail: {
	source_issue: "HOBO-540"
	package_path: "src/draft/exp-proofs/ux/vibe-first-run-activation-rail"
	proof_path:   "urn:hobo:proof:vibe-first-run-activation-rail"
	stages:       [...string]
}

#VibeClickableFirstRunConsumedWorkspaceProjectStates: {
	source_issue: "HOBO-541"
	package_path: "src/draft/exp-proofs/ux/vibe-workspace-project-states"
	proof_path:   "urn:hobo:proof:vibe-workspace-project-states"
	states:       [...string]
}

#VibeClickableFirstRunSnapshopFixtureRef: {
	fixture_id:            =~"^vcfrw-[a-z0-9-]+-v[0-9]+$"
	snapshop_context:      string & !="" & =~"(?i)snapshop"
	quickstart_fixture_id: =~"^rlq-[a-z0-9-]+-v[0-9]+$"
}

#VibeClickableFirstRunWalkthroughStep: {
	stage:                   #WalkthroughStage
	activation_rail_stage:   string & !=""
	workspace_project_state: string & !=""
	title:                   string & !=""
	persona:                 string & !=""
	clickable_action:        string & !=""
	snapshop_fixture:        #VibeClickableFirstRunSnapshopFixtureRef
	proof_mode:              #VibeClickableFirstRunProofMode
	docs_handoff:            string & !="" & =~"^urn:hobo:proof:"
	support_handoff:         string & !=""
	accessibility_note:      string & !=""
}

#VibeClickableFirstRunScenarioPath: {
	id:           "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
	stage_ids:    [...#WalkthroughStage]
	narrative:    string & !=""
	safe_outcome: string & !=""
}

#VibeClickableFirstRunHandoffRoute: {
	surface:               #HandoffSurface
	trigger:               string & !=""
	owner:                 string & !=""
	evidence_anchor:       string & !="" & =~"^urn:hobo:proof:"
	customer_safe_message: string & !=""
}

#VibeClickableFirstRunSupportHandoffEvidence: {
	severity:              string & !=""
	redaction_state:       string & !=""
	evidence_link:         string & !=""
	next_update_condition: string & !=""
}

#VibeClickableFirstRunWalkthroughRecord: {
	issue:                             "HOBO-559"
	phase:                             "M2"
	package_path:                      "src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough"
	proof_path:                        "urn:hobo:proof:vibe-clickable-first-run-walkthrough"
	design_refs:                       [...string]
	consumed_activation_rail:            #VibeClickableFirstRunConsumedActivationRail
	consumed_workspace_project_states: #VibeClickableFirstRunConsumedWorkspaceProjectStates
	steps:                             [...#VibeClickableFirstRunWalkthroughStep]
	scenario_paths:                    [...#VibeClickableFirstRunScenarioPath]
	handoff_routes:                    [...#VibeClickableFirstRunHandoffRoute]
	support_handoff_evidence:          #VibeClickableFirstRunSupportHandoffEvidence
	accessibility_notes:               [...string]
	scope_out:                         [...string]
}
