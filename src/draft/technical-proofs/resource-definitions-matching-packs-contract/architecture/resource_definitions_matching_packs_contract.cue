// CUE constraints for every protobuf type in HOBO-641 Resource Definitions + Matching + Packs POC.

package architecture_evidence

#ResourceDefinitionsMatchingPacksRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

#MatchDecidedEvidence: {
	definition_id:         string & !=""
	specificity_score:     int & >=0 & <=3
	catalog_content_hash:  string & =~"^sha256:"
}

#DeploymentSetPromotion: {
	set_id:            string & !=""
	content_address:   string & =~"^sha256:"
	incremental_nodes: [...string]
}

#MultiCloudPlanDecision: {
	camp_id:       string & !=""
	provider:      string & !=""
	definition_id: string & !=""
	winner_score:  int & >=0
}
