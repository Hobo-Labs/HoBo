
package architecture_evidence

#ConformancePortSuiteContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ConformancePortSuiteContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
