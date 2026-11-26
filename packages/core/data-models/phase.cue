// CUE constraints for every protobuf type in phase.proto. These are
// load-bearing for ADR-0158 enforcement: the phase vocabulary is closed (an
// unknown token must be refused, never defaulted), dev is an independent
// boolean rather than a phase, and the capability -> phase map is total and
// fixed, so a violation record can always name the phase to move the access
// into.

package core

#DeploymentPhase: "plan" | "init" | "handle"

#PhaseScopedCapability: "request" | "reply" | "requestPrincipal" | "requestSpan" | "bindingClient" | "instanceState"

#PhaseScopeRecord: {
	phase: #DeploymentPhase
	dev:   bool
}

#PhaseScopedCapabilityRecord: {
	capability: #PhaseScopedCapability
	// Request-scoped capabilities live in "handle"; init-scoped ones in
	// "init". No phase-scoped capability belongs to "plan": planning touches
	// no live instance.
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
