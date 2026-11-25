
package architecture_evidence

#TopologyObjectsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TopologyObjectsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
