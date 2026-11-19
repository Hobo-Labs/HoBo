
package architecture_evidence

#WitPortStubContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

#StubRecordedTraceEntry: {
	function_name: string & !=""
	input_json:    string & !=""
	output_json:   string & !=""
}

#StubRecordedTrace: {
	schema:  string & !=""
	entries: [...#StubRecordedTraceEntry]
}
