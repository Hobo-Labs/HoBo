
package architecture_evidence

#GovernanceConformanceSuiteContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GovernanceConformanceSuiteContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
