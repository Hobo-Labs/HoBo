package enterprise_deployment_hardening_scope_contract

import "list"

#EnterpriseDeploymentHardeningScope: {
	issue:   "HOBO-453"
	project: "Enterprise Deployment Hardening"
	state:   #EnterpriseHardeningGateDecision
	goal:    =~"Enterprise Deployment Hardening"
	personas: [...#EnterpriseDeploymentHardeningPersona] & list.MinItems(5)
	deployment_postures: [...#EnterpriseDeploymentPosture] & list.MinItems(4)
	operating_boundaries: [...#EnterpriseHardeningBoundary] & list.MinItems(4)
	m1_evidence: [...#EnterpriseHardeningEvidence] & list.MinItems(7)
	scope_in: [...string] & list.MinItems(1)
	scope_out: [...string] & list.MinItems(1)
}

#EnterpriseDeploymentHardeningPersona: {
	id:   =~"^[a-z0-9-]+$"
	need: string & != ""
}

#EnterpriseDeploymentPosture: {
	id:      "managed-saas" | "self-hosted-yard" | "sovereign-air-gapped" | "local-dev-simulation"
	owner:   string & != ""
	promise: string & != ""
}

#EnterpriseHardeningBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & != ""
	promise: string & != ""
}

#EnterpriseHardeningEvidence: {
	id:            =~"^[a-z0-9-]+$"
	owner:         string & != ""
	minimum_proof: string & != ""
}

#EnterpriseHardeningGateDecision: "SCOPE_DRAFT" | "SCOPE_ACCEPTED" | "FOLLOW_UP_BLOCKED"
