package data_models

// ADR-0143 provider-neutral routing constraints. Provider capability gaps are
// represented by ApplyResult rather than weakening these boundary invariants.
#WeightStrategy: "static" | "prefer-healthy" | "locality"

#ProviderKind: "simple" | "cloudflare" | "funnel" | "vercel" | "lakebed" | "other"

#Realization: "full" | "partial" | "none"

#Capability: "weighted-backends" | "health-aware" | "locality-aware" | "path-prefix" | "header-match" | "availability-constraints" | "resiliency"

#TrafficRoutingBackendRecord: {
	id:              string & != ""
	service:         string & != ""
	location_hints?: [...string & != ""]
	weight?:         int & >=1 & <=100
	endpoint?:       string & =~"^https?://[^@/?#[:space:]]+[^?#[:space:]]*$"
}

#TrafficRoutingMatchRecord: {
	path_prefix?: string & =~"^/"
	headers?: [string & =~"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$"]: string
}

#TrafficRoutingRuleRecord: {
	match?:           #TrafficRoutingMatchRecord
	backends:         [#TrafficRoutingBackendRecord, ...#TrafficRoutingBackendRecord]
	weight_strategy?: #WeightStrategy
}

#TrafficRoutingAvailabilityRecord: {
	min_healthy_backends?:   int & >=1
	min_distinct_locations?: int & >=1
	location_labels?:        [...string & != ""]
}

#TrafficRoutingResiliencyRecord: {
	timeout_ms?: int & >=1
	retries?:    int & >=0
}

#TrafficRoutingIntentRecord: {
	service:      string & != ""
	tenant_id:    string & != ""
	rules:        [#TrafficRoutingRuleRecord, ...#TrafficRoutingRuleRecord]
	availability?: #TrafficRoutingAvailabilityRecord
	resiliency?:   #TrafficRoutingResiliencyRecord
}

#TrafficRoutingPlanRecord: {
	plan_id:    string & != ""
	intent:     #TrafficRoutingIntentRecord
	backends:   [#TrafficRoutingBackendRecord, ...#TrafficRoutingBackendRecord]
	station_id?: string & != ""
	rail_hash?:  =~"^sha256:[a-f0-9]{64}$"
	created_at:  string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"
	degraded:    bool
	notes?:      [...string & != ""]
}

#TrafficRoutingApplyResultRecord: {
	plan_id:       string & != ""
	provider:      #ProviderKind
	realized:      #Realization
	notes?:        [...string & != ""]
	applied_rules?: int & >=0
	unmet?:        [...string & != ""]
	capabilities?: [...#Capability]
	if realized == "full" {
		applied_rules: int & >=1
		unmet?: []
	}
	if realized == "partial" {
		unmet: [string & != "", ...string & != ""]
	}
	if realized == "none" {
		applied_rules?: 0
	}
}

#TrafficRoutingStatusRecord: {
	plan_id:       string & != ""
	active:        bool
	realized:      #Realization
	notes?:        [...string & != ""]
	if active {
		realized: "full" | "partial"
	}
	if realized == "full" {
		active: true
	}
}

#TrafficRoutingRevokeResultRecord: {
	ok:     bool
	notes?: [...string & != ""]
}

// Package-level CUE vet entrypoint; the portable apply unit is RoutingPlan.
#TrafficRouting: #TrafficRoutingPlanRecord
