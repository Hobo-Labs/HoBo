package full_dashboard_projection_views

#ViewId: "deployments-timeline" | "topology-graph" | "run-inspector" | "registry-browser" | "agent-activity-credential-audit" | "cost-finops" | "drift" | "plan-preview" | "policy-gate-approvals" | "promote-rollback" | "live-tail"
#ProjectionSource: "DeploymentView" | "TopologyView" | "RunView" | "Registry" | "CredentialAudit" | "CostView" | "DriftView" | "PlanPreviewView" | "PolicyGateView" | "CampPointerView" | "StreamView"
#Interaction: "plan-preview" | "policy-gate-approval" | "promote" | "rollback" | "live-tail" | "time-travel-scrubber" | "replay-diff"
#NonEmptyString: string & != ""

#DashboardView: {
	id:                #ViewId
	title:             #NonEmptyString
	projectionSource:  #ProjectionSource
	fixture:           "examples/multi-cloud-shop"
	projectionOnly:    true
	scrubberAtSeq?:    int & >= 0
	replayDiffStatus?: "unchanged" | "changed"
	payload:           {...}
}

#DashboardRenderResult: {
	issue:           "HOBO-662"
	fixture:         "examples/multi-cloud-shop"
	views:           [#ViewId=string]: #DashboardView
	interactions:    [...#Interaction]
	projectionOnly:  true
}

#WcagAuditResult: {
	target:  "WCAG-2.1-AA"
	passed:  bool
}

#PseudoLocalizationResult: {
	expansionFactor: 2
	direction:       "rtl"
	passed:          bool
}
