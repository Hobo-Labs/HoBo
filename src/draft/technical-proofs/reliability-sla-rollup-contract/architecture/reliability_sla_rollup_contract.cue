
package architecture_evidence

#ReliabilitySlaRollupContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ReliabilitySlaRollupContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
