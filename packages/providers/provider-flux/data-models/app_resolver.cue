// CUE constraints for app_resolver.proto (plan 0024 WP13).
package hobo

#FluxDigest: =~"^sha256:[a-f0-9]{64}$"

#FluxAppOutputs: {
	appName:           =~"^[A-Za-z0-9]{3,32}$"
	owner:             =~"^[A-Za-z0-9]{20,96}$"
	instances:         int & >=1
	requiredInstances: int & >=instances
	runningInstances:  int & >=0
	componentDigests: {[=~"^[A-Za-z0-9]{1,32}$"]: #FluxDigest}
	artifactDigest?:    #FluxDigest
	ready:              bool
	operationConfirmed: ready
	operationTerminal:  ready
	absenceConfirmed:   false
	lifecycleStatus:    "ready" | "pending"
	// Readiness is observed: never ready with fewer nodes than required.
	if runningInstances < requiredInstances {
		ready:           false
		lifecycleStatus: "pending"
	}
	if runningInstances >= requiredInstances {
		ready:           true
		lifecycleStatus: "ready"
	}
}
