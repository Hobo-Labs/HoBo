
package architecture_evidence

#DriverDispatchRoutingContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DriverDispatchRoutingContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
