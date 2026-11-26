// CUE constraints for wit-port-stub-contract architecture evidence.

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
