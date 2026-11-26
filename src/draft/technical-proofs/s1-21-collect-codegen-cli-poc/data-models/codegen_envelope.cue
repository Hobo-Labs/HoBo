package codegen_envelope

#CodegenMode: "write" | "check"
#DriftStatus: "missing" | "extra" | "changed"

#CodegenEnvelope: {
	ok:      true
	command: "codegen"
	mode:    #CodegenMode
	drift:   bool
	layout:  [".hobo/generated", "src/_generated"]
	if mode == "check" {
		written: []
	}
}

#CodegenDriftEntry: {
	path:   string & !=""
	status: #DriftStatus
}
