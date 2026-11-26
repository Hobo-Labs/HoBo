package architecture_evidence

#WitInterfaceCoverageRow: {
	wit:          string & !=""
	port:         string & !=""
	suite_id:     string
	suite_backed: bool
}

#WitCoverageGap: {
	wit:    string & !=""
	reason: "missing-suite"
}

#WitCoverageReport: {
	schema:             "hobo.conformance.wit-coverage-report/v1"
	catalog_source:     string & !=""
	generated_at:       string & !=""
	interfaces:         [...#WitInterfaceCoverageRow]
	suite_backed_count: int & >=0
	total_interfaces:   int & >0
	coverage_percent:   float & >=0 & <=100
	gaps:               [...#WitCoverageGap]
	complete:           bool
}

#RegistryPublishGateDecision: {
	schema:            "hobo.conformance.registry-publish-gate/v1"
	provider_id:       string & !=""
	status:            "listed" | "blocked"
	claimed_interfaces: [...string]
	blocking_reasons:  [...string]
}
