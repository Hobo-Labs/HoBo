
package architecture_evidence

#ComponentHostConformanceSuiteEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ComponentHostConformanceSuiteRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
