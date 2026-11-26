// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#UiGenerationCitationTarget: {
	id:   string & !=""
	path: string & !=""
}

#UiGenerationCitationCheckResult: {
	id:          string & !=""
	path:        string & !=""
	ok:          bool
	violations:  [...string]
}

#UiGenerationCitationReport: {
	issue:   string & !=""
	results: [...#UiGenerationCitationCheckResult]
}
