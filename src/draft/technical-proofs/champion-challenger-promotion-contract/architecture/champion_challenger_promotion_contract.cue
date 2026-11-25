
package architecture_evidence

#ChampionChallengerPromotionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ChampionChallengerPromotionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
