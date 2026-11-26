// Station capability coverage invariants.
//
// The load-bearing rules here are the ones a downstream operator or planner
// would otherwise have to re-derive:
//
//   - profile matches the ADR-0151 capability-profile grammar, so a served
//     entry or a gap can never name a free-form string no profile registry
//     can resolve;
//   - an offering constrains product_id or connectivity_id — never neither,
//     because an offering that constrains nothing asserts coverage it does
//     not have (mirrors the Yard binding row rule in @hobo/yards);
//   - every gap carries a non-empty remediation, matching the fail-closed
//     refusals at the parse boundary in src/capability-coverage.ts;
//   - ok means exactly "no expected profile is a gap" — it is pinned to the
//     gap list here so it can never drift into meaning "a deploy would work".
//
// There is deliberately no properties/parameters map anywhere in this record,
// so unlike #YardBindingRecord there is nothing for the credential-key screen
// to guard: coverage carries identifiers only. A future field that carried
// realization parameters would have to re-introduce that screen.

package stations

// <primitive-family>.<path>/v<major>
#StationCapabilityProfileId: =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"

#StationCapabilityOfferingRecord: {
	yard_name:        string & !=""
	provider_id:      string & !=""
	product_id?:      string & !=""
	connectivity_id?: string & !=""
	// An offering that names no product and no connectivity implementation is
	// meaningless, so the coverage record refuses to describe one.
	_constrainsSomething: true & ((product_id != _|_) | (connectivity_id != _|_))
}

#ServedStationCapabilityRecord: {
	profile: #StationCapabilityProfileId
	// Several offerings per profile is the NORMAL case (ADR-0157 decision 1):
	// a Yard declares what it is able to allocate, so Azure's web profile
	// legitimately lists four products. This list is breadth, never a ranking
	// and never a truncated top-N.
	offerings: [...#StationCapabilityOfferingRecord]
	offering_count: uint & >0
	yard_names: [...string & !=""]
	provider_ids: [...string & !=""]
	expected: bool
	_countMatchesOfferings: offering_count == len(offerings)
}

#StationCapabilityGapRecord: {
	profile: #StationCapabilityProfileId
	// Fail-closed refusals name what to change; an empty remediation is a dead end.
	remediation: string & !=""
}

// Factual dependency accounting, not a score: whether a concentration is
// acceptable is a policy question this record does not answer.
#StationProviderConcentrationRecord: {
	provider_id:    string & !=""
	offering_count: uint & >0
	profiles: [...#StationCapabilityProfileId]
	yard_names: [...string & !=""]
	sole_source_profiles: [...#StationCapabilityProfileId]
}

#StationCapabilityCoverageRecord: {
	schema:     "hobo.station-capability-coverage/v1"
	station_id: string & !=""
	ok:         bool
	served: [...#ServedStationCapabilityRecord]
	gaps: [...#StationCapabilityGapRecord]
	// Served by exactly one offering: a resilience signal, not an error.
	singly_sourced: [...#StationCapabilityProfileId]
	provider_concentration: [...#StationProviderConcentrationRecord]
	yard_names: [...string & !=""]
	expected: [...#StationCapabilityProfileId]
	// ok means "no expected profile is a gap" — never "a deploy would succeed".
	_okMeansNoGaps: ok == (len(gaps) == 0)
}
