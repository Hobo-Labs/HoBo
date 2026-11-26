package dapr_parity_anchor_audit

#Feature: "Bindings" | "Distributed lock"
#Status: "🔜"

#Row: {
	feature:        #Feature
	status:         #Status
	designAnchors:  [...string] & [_, ...]
	notes:          string & =~"\\S"
}

#Audit: {
	issue:     "HOBO-699"
	targetDoc: "docs/competitors/dapr.md"
	rows:      [...#Row] & [_, _]
}

DaprParityAnchorAudit: #Audit
DaprParityRow: #Row
