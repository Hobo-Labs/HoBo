package architecture_evidence

#PortabilityConformanceEvidenceKind: "unspecified" | "nfr001-lane" | "nfr020-lint"

#PortabilityConformanceRecord: {
	issue:             string & !=""
	fixture:           string & !=""
	target_providers:  [...string] & [string, ...]
	bindle_digest:     string & !=""
}
