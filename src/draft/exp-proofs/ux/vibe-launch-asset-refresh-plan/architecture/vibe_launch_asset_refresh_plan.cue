package vibe_launch_asset_refresh_plan

#ProofMode: "live" | "simulated" | "reference fixture" | "scope-out"
#AssetKind: "screenshots" | "recording-manifest" | "command-transcript" | "fixture-data" | "docs"
#ScenarioKind: "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff" | "accessibility-check"

#AssetRefreshPlan: {
	schema: "hobo.vibe-launch-asset-refresh-plan/v1"
	issue: "HOBO-556"
	target_package_path: "src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan"
	proof_note_path: "docs/design/proofs/vibe-launch-asset-refresh-plan/README.md"
	source_refs: [...string] & [_, ...]
	audience: [...string] & [_, ...]
	assets: [...#LaunchAsset]
	fixture_examples: [...#FixtureExample]
	scenarios: [...#RefreshScenario]
	scope_out: [...string] & [_, ...]
}

#LaunchAsset: {
	id: string & !=""
	kind: #AssetKind
	label: string & !=""
	source_owner: string & !=""
	proof_mode: #ProofMode
	evidence_source: string & !=""
	freshness_rule: string & !=""
	refresh_trigger: string & !=""
	validation_route: string & !=""
	stale_downgrade: string & !=""
}

#FixtureExample: {
	id: string & !=""
	proof_mode: #ProofMode
	asset_kind: #AssetKind | "scope-out-asset"
	evidence_source: string & !=""
	claim_boundary: string & !=""
}

#RefreshScenario: {
	id: string & !=""
	kind: #ScenarioKind
	proof_mode: #ProofMode
	asset_ids: [...string] & [_, ...]
	expected_state: "ready" | "blocked" | "downgraded" | "routed"
	launch_readiness_impact: "ready-for-review" | "blocked-until-owner-action" | "downgrade-until-refreshed"
	safe_next_action: string & !=""
	support_handoff: string & !=""
	accessibility_note: string & !=""
}

#ScopeCreepDenial: {
	decision: "reject"
	reason: string & !=""
	request: string & !=""
}
