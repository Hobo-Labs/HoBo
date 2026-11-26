// Trail contracts (architecture-guard evidence).

#TrailStepRecord: {
	id:           string
	kind:         string
	description?: string
	depends_on?:  [...string]
	recipe_id?:   string
	progressive?: bool
}

#TrailDefinitionRecord: {
	schema_version: string
	id:             string
	version:        string
	description:    string
	targets:        [...string]
	recipe_list?:   [...string]
	content_hash:   string
}

#TrailRunRecord: {
	run_id:          string
	trail_id:        string
	trail_version:   string
	tenant:          string
	target:          string
	state:           "idle" | "planned" | "dual-active" | "ramping" | "validated" | "cutover" | "compensated" | "aborted" | "failed"
	percent:         uint & >=0 & <=100
	identity_linked: bool
	junction_ok:     bool
	dual_ok:         bool
}

#CanTrailResultRecord: {
	schema_version:          string
	ok:                      bool
	dimension:               "can-trail"
	summary:                 string
	trail_id:                string
	trail_version:           string
	identity_continuous:     bool
	bindle_config_required:  bool
	continuous_default:      bool
	dry_run:                 true
	rollback_posture:        "compensate-to-source"
}

#TrailHistoryEntryRecord: {
	schema_version: string
	trail_id:       string
	trail_version:  string
	step_id:        string
	target:         string
	tenant:         string
	checksum:       string
	applied_at:     string
	status:         "applied" | "baseline" | "repaired"
}

#TrailEventRecord: {
	id:             string
	type:           string
	schema_version: string
	tenant:         string
	seq:            uint
	time:           string
	retention:      "standard" | "credential-audit-never-compact"
}
