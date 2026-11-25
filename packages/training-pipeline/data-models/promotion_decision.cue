package data_models

#PromotionOutcome: "PROMOTION_OUTCOME_UNSPECIFIED" |
	"PROMOTION_OUTCOME_PROMOTE" |
	"PROMOTION_OUTCOME_REFUSE"

#EvalResult: {
	rubric_ref: string & !=""
	scores: {[string]: number & >=0 & <=1}
	sample_count: int & >=0
	source:       string & !=""
}

#PromotionThresholds: {
	metric_floors: {[string]: number & >=0 & <=1}
	min_samples: int & >=0
}

#LensFlags: {
	conformance: bool
	eval:        bool
	policy:      bool
}

#ChampionChallenger: {
	champion_id?:  string
	challenger_id: string & !=""
}

#PromotionDecision: {
	candidate_id: string & !=""
	outcome:      #PromotionOutcome & !="PROMOTION_OUTCOME_UNSPECIFIED"
	passed:       #LensFlags
	failures: [...string & !=""]
	champion_challenger?: #ChampionChallenger
}
