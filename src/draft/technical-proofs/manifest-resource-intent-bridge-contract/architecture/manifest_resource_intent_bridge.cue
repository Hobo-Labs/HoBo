package architecture_evidence

#ManifestSchema: "hobo.manifest/v1"

#RoutingObjective: "cost" | "latency" | "single-provider" | "carbon" | "maximize-credits"

#ManifestResourceNode: {
	type: string & !=""
	port?: string & !=""
	paradigm?: string & !=""
	allow?: [...string & !=""]
	bind?: [...string & !=""]
	links?: [...#ManifestLink]
}

#ManifestLink: {
	import?: string & !=""
	to: string & !=""
}

#DeployContext: {
	tenant: string & !=""
	workspace: string & !=""
	environment: string & !=""
	routing_objective?: #RoutingObjective
	budget?: #BudgetScope
}

#BudgetScope: {
	amount: number & >=0
	currency: string & !=""
	period: "monthly" | "weekly" | "daily"
	soft_limit_behavior: "warn" | "requireApproval"
	hard_limit_behavior: "deny" | "allow"
}

#ManifestResourceIntentBridgeInput: {
	manifest_schema: #ManifestSchema
	resources: [string]: #ManifestResourceNode
	deploy_context: #DeployContext
}

#ResourceIntentRecord: {
	schema_version: "finops.resource-intent/v1"
	resource_name: string & !=""
	owner: #OwnerRef
	capability: #CapabilityClass
	budget: #BudgetScope
	constraints: #IntentConstraints
	routing_objective: #RoutingObjective
}

#OwnerRef: {
	tenant: string & !=""
	workspace: string & !=""
	environment: string & !=""
}

#CapabilityClass: {
	category: string & !=""
	requirements: [...string & !=""]
}

#IntentConstraints: {
	colocate_with: [...string & !=""]
}

#ManifestResourceIntentBridgeEvidenceEvent: {
	event_id: =~"^evt_[a-z0-9]+$"
	event_type: "manifest.ResourceIntentBridged"
	issue_id: "HOBO-696"
	input: #ManifestResourceIntentBridgeInput
	intents: [...#ResourceIntentRecord]
}
