
package architecture_evidence

#AlertmanagerRoutingContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AlertmanagerRoutingContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
