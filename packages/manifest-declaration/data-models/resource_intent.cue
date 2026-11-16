package hobo

// CUE constraints for the declaration manifest (resource_intent.proto). One
// constraint per protobuf message.
//
// Field names here are the *domain/JSON* spelling (`targetPort`, `pickN`),
// matching the TypeScript parsed derived types and the JSON the round-trip
// suite compares; resource_intent.proto carries the snake_case wire spelling of
// the same fields. That split follows packages/cloud/data-models/cloud.cue,
// which does the same thing for the same record.
//
// Four constraints below are stronger than the ones in cloud.cue. Each was
// added because a value admitted by the looser form is either lossy on the wire
// or silently meaningless to the evaluator that consumes it, and every existing
// ResourceIntent value in the repository satisfies all four:
//
//  1. `region?: string & !=""`. cloud.cue writes `region?: string`, so
//     `{"region": ""}` is admitted; it is also the one value the proto3
//     implicit-presence encoding cannot distinguish from an absent region. A
//     present-but-empty region names no region, so it is refused rather than
//     preserved. Every other string in the record is already `!=""`, which is
//     what makes the rest of the record survive the same encoding — `region`
//     looks like an omission in cloud.cue rather than a decision.
//
//  2. Selector arity. `packages/cloud/src/planner/placement.ts` reads
//     `selector.values[0]` for eq/ne/lt/lte/gt/gte and the whole list for
//     in/not-in, and ignores `values` entirely for `exists`. A non-`exists`
//     selector with no operands therefore compares against `undefined` and
//     rejects every candidate silently, and an `exists` selector with operands
//     reads as a filter that is never applied. Both are refused.
//
//  3. No duplicates in `require`, `prefer` or `deps`. All three are sets by
//     meaning — a feature required twice is required once, a bind edge declared
//     twice is one edge. Order is *not* normalized: it is preserved exactly as
//     authored so a record round-trips byte-identically.
//
//  4. No self-dependency. `deps` names sibling intents by `name`; an intent
//     that depends on itself is a one-node cycle, and it is checkable inside a
//     single record rather than only at DAG-ordering time.

#Negotiation: "require" | "prefer"

#PlacementSelectorOp: "eq" | "ne" | "in" | "not-in" | "lt" | "lte" | "gt" | "gte" | "exists"

#PlacementAffinityMode: "affinity" | "anti-affinity"

#PlacementScope: "region" | "yard"

#PlacementPropertySelector: {
	key: string & !=""
	op:  #PlacementSelectorOp
	values: [...string]
	// "exists" is a presence test and takes no operands; every other op reads
	// at least one.
	_operandArity: true & (op != "exists" | len(values) == 0)
	_operandsPresent: true & (op == "exists" | len(values) > 0)
}

#PlacementAffinityRule: {
	mode:       #PlacementAffinityMode
	targetPort: string & !=""
	scope:      #PlacementScope
}

#PlacementSpread: {
	dimension: #PlacementScope
}

#PlacementPickN: {
	// uint32 on the wire; a cardinality of zero asks matching to find nothing.
	count: uint32 & >0
}

#PlacementCriteria: {
	selectors: [...#PlacementPropertySelector]
	affinities: [...#PlacementAffinityRule]
	spread?: #PlacementSpread
	pickN?:  #PlacementPickN
}

#ResourceIntent: {
	// Graph identity inside the declaring manifest.
	name: string & !=""
	// Capability class; may be namespaced ("hobo:database") when the manifest
	// port did not map to a known class.
	port: string & !=""
	require: [...string & !=""]
	prefer: [...string & !=""]
	negotiation: #Negotiation
	deps: [...string & !=""]
	// Absent or a real region. Never present-and-empty: see note 1.
	region?:   string & !=""
	objective: string & !=""
	placement?: #PlacementCriteria
}
