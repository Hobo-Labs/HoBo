
package core

#DeploymentPhase: "plan" | "init" | "handle"

#PhaseScopedCapability: "request" | "reply" | "requestPrincipal" | "requestSpan" | "bindingClient" | "instanceState"

#PhaseScopeRecord: {
	phase: #DeploymentPhase
	dev:   bool
}

#PhaseScopedCapabilityRecord: {
	capability: #PhaseScopedCapability
	phase: "handle" | "init"
	if capability == "bindingClient" || capability == "instanceState" {
		phase: "init"
	}
	if capability != "bindingClient" && capability != "instanceState" {
		phase: "handle"
	}
}

#PhaseViolationRecord: {
	code:           "PHASE_VIOLATION"
	capability:     #PhaseScopedCapability
	required_phase: #DeploymentPhase
	actual_phase:   #DeploymentPhase & !=required_phase
	message:        string & !=""
}
