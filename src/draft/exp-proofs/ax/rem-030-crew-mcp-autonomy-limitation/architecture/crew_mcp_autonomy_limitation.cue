package architecture_evidence

#CrewMcpAutonomyLimitationRow: {
	limitation:        string & !="" & =~"(?i)crew|mcp"
	state:             "real"
	affectedPersona:   string & !=""
	userVisibleImpact: string & !="" & =~"(?i)approval|policy gate"
	workaround:        string & !=""
	owner:             string & !=""
	followUpIssue?:    string
}

#CrewMcpAutonomyLimitationEvidence: {
	issue:           "HOBO-697"
	gap:             "GAP-022"
	registerRow:     #CrewMcpAutonomyLimitationRow
	contractInSync:  true
}
