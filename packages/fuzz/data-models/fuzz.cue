package fuzz

#InvariantVerdict: {
	schema:    "hobo.fuzz.invariant-verdict/v1"
	invariant: string
	ok:        bool
	message:   string
	invariant: =~"^[a-z][a-z0-9.-]+$"
}

#FuzzTrace: {
	schema:   "hobo.fuzz.trace/v1"
	seed:     string
	commands: [...string]
	verdicts: [...#InvariantVerdict]
}
