package cli_deploy_transcript_prototype

#CliDeployTranscriptPrototype: {
  schema: "hobo.cli-deploy-transcript-prototype/v1"
  issue: "HOBO-573"
  scenarios: [...#CliDeployScenario]
  scope_out: [...string]
}

#CliDeployScenario: {
  id: =~"^deploy\\."
  title: string
  actor: "app-developer" | "platform-engineer" | "agent-mcp-caller" | "support-operator"
  outcome: "deployed" | "blocked"
  reason?: "policy denied" | "contract incompatible" | "stale or unknown evidence"
  deployment_plan_id: =~"^deployment-plan\\."
  deployment_set_id: =~"^deployment-set\\."
  delta_id: =~"^delta\\."
  gatekeeper_decision_id: =~"^gatekeeper\\."
  gatekeeper_explanation: =~"Gatekeeper"
  resource_actor_event_id: =~"^resource\\."
  projection_id: =~"^projection\\."
  log_fixture_id: =~"^log\\."
  value_proof: =~"^Value proof:"
  proof_mode: "reference fixture" | "simulated" | "scope-out"
  support_wording: string
  accessibility_note: string
  mcp_equivalent: true
  fixtures: [...#DeployFixtureReference]
}

#DeployFixtureReference: {
  kind: "deployment-plan" | "deployment-set" | "delta" | "gatekeeper-decision" | "resource-actor-event" | "projection" | "log"
  id: string
  source: string
}

#McpToolResult: {
  operation: "hobo.up"
  status: "deployed" | "blocked"
  reason: "deployed" | "policy denied" | "contract incompatible" | "stale or unknown evidence"
  plan_id: string
  deployment_set_id: string
  delta_id: string
  gatekeeper_decision_id: string
  gatekeeper_explanation: string
  fixture_ids: [...string]
  proof_mode: "reference fixture" | "simulated" | "scope-out"
  value_proof: string
  customer_safe_summary: string
}

#ScopeCreepDenial: {
  decision: "reject"
  reason: string
  request: string
}

#EvaluationSummary: {
  ok: bool
  successful_deploys: uint & >=0
  blocked_reasons: [...string]
  errors: [...string]
}
