// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#VibeDocsPortalProofMode: "live" | "simulated" | "reference fixture" | "scope-out"

#VibeDocsPortalFreshnessSignal: {
	status:            "fresh" | "bounded-stale" | "unknown" | "scope-out"
	signal:            string & !=""
	checked_at:        string & !=""
	refresh_trigger:   string & !=""
	stale_disposition: string & !=""
}

#VibeDocsPortalAudiencePath: {
	persona:          "app-developer" | "platform-engineer" | "support-operator" | "security-reviewer" | "docs-maintainer" | "release-owner"
	entry_point:      string & =~"^/docs"
	content_areas:    [...#ContentArea]
	goal:             string & !=""
	success_criteria: string & !=""
	blocked_route:    string & !=""
}

#ContentArea: "getting-started" | "api-reference" | "architecture" | "operations" | "troubleshooting" | "release-notes" | "known-limitations" | "security" | "support"

#VibeDocsPortalContentInventoryEntry: {
	id:                       string & !=""
	title:                    string & !=""
	slug:                     string & =~"^/docs"
	audience_paths:           [...string]
	content_area:             #ContentArea
	source_record:            string & !=""
	owner:                    string & !=""
	freshness_signal:         #VibeDocsPortalFreshnessSignal
	proof_mode:               #VibeDocsPortalProofMode
	limitation_state:         "supported" | "known-limitation" | "unsupported" | "missing-evidence" | "scope-out"
	support_or_release_owner: string & !=""
	customer_visible_status:  string & !=""
}

#VibeDocsPortalSearchMetadataRecord: {
	title:                    string & !=""
	slug:                     string & =~"^/docs"
	audiences:                [...string]
	content_area:             #ContentArea
	source_record:            string & !=""
	owner:                    string & !=""
	freshness_signal:         #VibeDocsPortalFreshnessSignal
	proof_mode:               #VibeDocsPortalProofMode
	limitation_state:         "supported" | "known-limitation" | "unsupported" | "missing-evidence" | "scope-out"
	support_or_release_owner: string & !=""
	searchable_summary:       string & !=""
}

#VibeDocsPortalScenarioPath: {
	id:                "happy-path" | "blocked-path" | "stale-or-unknown-evidence" | "support-handoff"
	narrative:         string & !=""
	content_entry_ids: [...string]
	safe_outcome:      string & !=""
}

#VibeDocsPortalIaStatesRecord: {
	issue:               "HOBO-551"
	phase:               "M1"
	package_path:        "src/draft/exp-proofs/ux/vibe-docs-portal-ia-states"
	proof_path:          "docs/design/proofs/vibe-docs-portal-ia-states/README.md"
	design_refs:         [...string]
	audience_paths:      [...#VibeDocsPortalAudiencePath]
	content_inventory:   [...#VibeDocsPortalContentInventoryEntry]
	search_metadata:     [...#VibeDocsPortalSearchMetadataRecord]
	scenario_paths:      [...#VibeDocsPortalScenarioPath]
	accessibility_notes: [...string]
	scope_out:           [...string]
}
