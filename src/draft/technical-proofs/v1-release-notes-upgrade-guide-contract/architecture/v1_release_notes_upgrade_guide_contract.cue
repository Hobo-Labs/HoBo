
package architecture_evidence

#V1ReleaseNotesUpgradeGuideContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#V1ReleaseNotesUpgradeGuideContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
