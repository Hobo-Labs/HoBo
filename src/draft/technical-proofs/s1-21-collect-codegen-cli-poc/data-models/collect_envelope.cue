package collect_envelope

#CollectStatus: "complete" | "coverage-incomplete"

#CollectEnvelope: {
	ok:            true
	command:       "collect"
	contract:      "hobo.collect-cli/v1"
	status:        #CollectStatus
	manifest_hash: string & !=""
	if status == "complete" {
		manifest_hash: =~"^sha256:[0-9a-f]{64}$"
	}
}

#CodegenDriftEntry: {
	path:   string & !=""
	status: "missing" | "extra" | "changed"
}

#CodegenResult: {
	mode:    "write" | "check"
	drift:   bool
	checked: [...string]
	written: [...string]
}
