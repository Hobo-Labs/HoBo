
package architecture_evidence

#FlagRulesetSyncContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#FlagRulesetSyncContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
