// Provider catalog hand-off invariants.
//
// These are the rules a composition layer would otherwise have to re-derive, or
// worse, assume:
//
//   - profile matches the ADR-0151 capability-profile grammar, so a published
//     row can never name a free-form string no profile registry can resolve;
//   - a row constrains product_id or connectivity_id — never neither, because a
//     row that constrains nothing asserts a portability guarantee it does not
//     make;
//   - properties are locators, never values: a credential-shaped key is
//     rejected, matching the parse boundary in `@hobo/core`'s `slotBinding()`
//     and again in `@hobo/yards`' `parseYardBindings()`;
//   - regions are non-blank, because a blank region would silently widen
//     residency rather than narrow it.
//
// What is deliberately NOT constrained here: whether a product_id is registered
// in the definition catalog. That is a resolution-time check
// (`YARD_BINDING_PRODUCT_UNKNOWN`) against a catalog this package cannot see,
// and inferring a provider from an id prefix would make a naming convention
// load-bearing — the external-spec dependency ADR-0144 forbids.

package data_models

// <primitive-family>.<path>/v<major>
#ProviderCatalogProfileId: =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"

// Anything that reads as a secret value rather than a locator.
#CredentialKeyPattern: "(?i)(secret|password|token|credential|private[_-]?key|api[_-]?key)"

#ProviderCatalogRowRecord: {
	profile:          #ProviderCatalogProfileId
	product_id?:      string & !=""
	connectivity_id?: string & !=""
	properties?: {[!~#CredentialKeyPattern]: string}
	// A row that constrains neither offering is meaningless, so the catalog
	// refuses to describe one.
	_constrainsSomething: true & ((product_id != _|_) | (connectivity_id != _|_))
}

#ProviderYardSpecRecord: {
	provider: string & !=""
	// A provider with no published region cannot be placed into; an empty list
	// would fail later and further from the cause.
	regions: [...string & !=""] & [_, ...]
	// A provider that can allocate nothing is not a provider. Empty here would
	// produce a Yard that silently satisfies no capability.
	bindings: [...#ProviderCatalogRowRecord] & [_, ...]
}

// Parity levels, local before cloud fallback (council-decision.md). Closed, so
// no record can invent a level no reader knows how to rank. This is the full
// vocabulary; the constants-only record below may use only its first two.
#ParityLevel: "P0" | "L1" | "L2" | "L3" | "P2" | "P3"

// The levels a projection over constants can honestly emit. L2/L3/P2/P3 need
// executed evidence (a run, minutes, a live account) that no count carries.
#ConstantsParityLevel: #ParityLevel & ("P0" | "L1")

// The constants-only projection record (`toProviderParityRecord()` in
// src/parity.ts). Its L1 is a candidate signal — resolvers declared — not the
// council's full L1 (fake transport + six lifecycle cases + PACT), which this
// record has no field to evidence.
#ProviderParityRowRecord: {
	provider:       string & !=""
	level:          #ConstantsParityLevel
	catalog_count:  int & >=0
	resolved_count: int & >=0 & <=catalog_count
	// The denominator is derived, never free text: a claim without the exact
	// count behind it is the overclaim this record exists to stop.
	denominator: "\(resolved_count)/\(catalog_count)"
	// P0 iff nothing resolved, in both directions.
	if resolved_count == 0 {
		level: "P0"
	}
	if resolved_count > 0 {
		level: "L1"
	}
}
