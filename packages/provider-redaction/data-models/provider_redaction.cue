package provider_redaction

#PatternFlags: =~"^[dgimsuvy]*$"

#PatternSource: {
	source: string & !=""
	flags:  #PatternFlags
}

#RedactionProfileDescriptor: {
	patterns?: [...#PatternSource]
	fallbacks?: [...#PatternSource]
	keep?:               #PatternSource
	decode_percent?:     bool
	collapse_whitespace?: bool
}
