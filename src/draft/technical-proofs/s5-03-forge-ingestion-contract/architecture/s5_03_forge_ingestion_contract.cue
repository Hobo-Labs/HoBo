package architecture_evidence

#S503ForgeIngestionContractEvidenceKind: "unspecified" | "contract-record" | "contract-test"

#ForgeIngestionFixtureIndex: {
	schema:                string & !=""
	request_id:            string & !=""
	artifact_kind:         string & !=""
	target_wit_port:       string & !=""
	provider_id:           string & !=""
	conformance_suite_id:  string & !=""
}

#ForgeIngestionEventRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
