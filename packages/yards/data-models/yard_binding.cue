// Yard binding + localhost seed invariants.
//
// The load-bearing rules here are the ones a downstream planner would
// otherwise have to re-derive:
//
//   - profile matches the ADR-0151 capability-profile grammar, so a row can
//     never name a free-form string that no profile registry can resolve;
//   - a row constrains product_id or connectivity_id — never neither, because
//     a row that constrains nothing asserts a portability guarantee it does
//     not make;
//   - properties are locators, never values: a credential-shaped key is
//     rejected, matching the parse boundary in src/binding.ts;
//   - every localhost seed row carries a fidelity, so an in-memory stand-in
//     can never be reported as a real implementation (ADR-0042).

package data_models

// <primitive-family>.<path>/v<major>
#YardBindingProfileId: =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"

// Anything that reads as a secret value rather than a locator.
#CredentialKeyPattern: "(?i)(secret|password|token|credential|private[_-]?key|api[_-]?key)"

#SeedProvenance: "default" | "discovered" | "declared"

#SeedFidelity: "real" | "simulated" | "mocked" | "camp-only"

#YardBindingRecord: {
	contract:         "hobo.yard-binding/v1"
	profile:          #YardBindingProfileId
	product_id?:      string & !=""
	connectivity_id?: string & !=""
	require: [...string & !=""]
	properties?: {[!~#CredentialKeyPattern]: string}
	// A row that constrains neither offering is meaningless, so the catalog
	// refuses to describe one.
	_constrainsSomething: true & ((product_id != _|_) | (connectivity_id != _|_))
}

#LocalhostSeedRowRecord: {
	profile:    #YardBindingProfileId
	product_id: string & =~"^local:[a-z0-9][a-z0-9-]*$"
	provenance: #SeedProvenance
	fidelity:   #SeedFidelity
}

#LocalhostSeedUnavailableRecord: {
	profile: #YardBindingProfileId
	// Fail-closed refusals name what to change; an empty reason is a dead end.
	reason: string & !=""
}

#LocalhostYardSeedRecord: {
	contract:    "hobo.localhost-yard-seed/v1"
	yard_name:   "yard:local"
	provider_id: "local"
	rows: [...#LocalhostSeedRowRecord]
	unavailable: [...#LocalhostSeedUnavailableRecord]
}
