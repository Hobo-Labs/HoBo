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

#GrowthMeasurement: {
	length:     int & >0
	repeat:     int & >=1
	calibrated: bool
	small_ms:   number & >=0
	large_ms:   number & >=0
	ratio:      number & >=0
}

#SweepOutcome: {
	input:      string & !=""
	screen_ms?: number & >=0
	hung_ms?:   number & >=0
	growth?:    #GrowthMeasurement
}
