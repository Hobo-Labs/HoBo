// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#VibeDeploymentDashboardProofMode: "unspecified" | "live" | "simulated" | "reference fixture" | "scope-out"

#VibeDeploymentDashboardFreshness: {
	status:            "fresh" | "bounded-stale" | "unknown" | "scope-out"
	observed_at:       string & !=""
	freshness_bound:   string & !=""
	stale_disposition: string & !=""
}

#VibeDeploymentDashboardFieldGroup: {
	id:                      string & !=""
	surface:                 string & !=""
	projection_source:       string & !=""
	freshness:               #VibeDeploymentDashboardFreshness
	owner:                   string & !=""
	tenant_rbac_disposition: string & !=""
	safe_next_action:        string & !=""
	proof_mode:              #VibeDeploymentDashboardProofMode
}

#VibeDeploymentDashboardWireframe: {
	id:                 string & !=""
	surface:            string & !=""
	title:              string & !=""
	personas:           [...string]
	questions_answered: [...string]
	field_group_ids:    [...string]
}

#VibeDeploymentDashboardScenarioPath: {
	id:              string & !=""
	narrative:       string & !=""
	field_group_ids: [...string]
	safe_outcome:    string & !=""
}

#VibeDeploymentDashboardQuickstartFixtureReference: {
	source_issue:      "HOBO-577"
	fixture_id:        "rlq-deploy-run-accepted-v1" | "rlq-inspect-event-projection-v1" | "rlq-manage-stale-evidence-v1" | "rlq-recover-snapshot-restore-v1" | "rlq-recover-scope-out-v1"
	proof_mode:        "reference-fixture" | "simulated" | "live" | "scope-out"
	consuming_surface: "deployment-timeline" | "topology-graph" | "run-inspector" | "project-environment-fleet" | "health-cost-incident-rollups"
	dashboard_use:     string & !=""
}

#VibeDeploymentDashboardMockupsRecord: {
	issue:               "HOBO-544"
	phase:               "M1"
	package_path:        "src/draft/exp-proofs/ux/vibe-deployment-dashboard-mockups"
	proof_path:          "docs/design/proofs/vibe-deployment-dashboard-mockups/README.md"
	design_refs:         [...string]
	quickstart_fixture_refs: [...#VibeDeploymentDashboardQuickstartFixtureReference]
	personas:            [...string]
	wireframes:          [...#VibeDeploymentDashboardWireframe]
	field_groups:        [...#VibeDeploymentDashboardFieldGroup]
	scenario_paths:      [...#VibeDeploymentDashboardScenarioPath]
	accessibility_notes: [...string]
	scope_out:           [...string]
}
