
package architecture_evidence

#TopologyOverrideConflictContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TopologyOverrideConflictContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
