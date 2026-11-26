// CUE constraints for every protobuf type in
// proto/upgrade_migration_scope.proto. These bound the HOBO-430 Upgrade &
// Migration Engine M0 scope record so downstream M1+ tooling can reject
// malformed scope evidence at parse time.

package upgrade_migration_v1

#Persona: {
	role: string & !=""
	need: string & !=""
}

#Boundaries: {
	service:  string & !=""
	ux:       string & !=""
	security: string & !=""
	support:  string & !=""
}

#InitiativeDependency: {
	owner:         string & !=""
	consumes:      string & !=""
	scopeBoundary: string & !=""
}

#UpgradePathClass: {
	name:        string & !=""
	description: string & !=""
}

#FollowUpGate: {
	allowedAfter:  string & !=""
	blockedBefore: string & !=""
}

#UpgradeMigrationScope: {
	issue:                  "HOBO-430"
	project:                string & !=""
	phase:                  "M0"
	goal:                   string & !=""
	personas:               [...#Persona] & [_, ...]
	scopeIn:                [...string] & [_, ...]
	scopeOut:               [...string] & [_, ...]
	nonGoals:               [...string] & [_, ...]
	boundaries:             #Boundaries
	designRefs:             [...string]
	adrRefs:                [...string]
	initiativeDependencies: [...#InitiativeDependency]
	upgradePathClasses:     [...#UpgradePathClass]
	dryRunOutputs:          [...string]
	followUpGate:           #FollowUpGate
}
