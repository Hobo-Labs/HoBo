// CUE constraints for every protobuf type in evals.proto, so the
// architecture guard can confirm the rubric/report/verdict shapes are
// bounded at parse time.

package evals

#ScoringKind: "boolean" | "scale" | "golden-match"

#UnitInterval: number & >=0 & <=1

#RubricCriterion: {
	id:            string & !=""
	description:   string
	weight:        number & >0
	kind:          #ScoringKind
	passThreshold: #UnitInterval
	expectedJson?: string
	required:      bool
}

#Rubric: {
	schema:        "hobo.evals.rubric/v1"
	id:            string & !=""
	passThreshold: #UnitInterval
	criteria: [...#RubricCriterion] & [_, ...]
}

#ValueDiff: {
	path:         string & !=""
	expectedJson: string
	actualJson:   string
}

#CriterionScore: {
	criterionId:   string & !=""
	kind:          #ScoringKind
	weight:        number & >0
	passThreshold: #UnitInterval
	score:         #UnitInterval
	passed:        bool
	diff?:         #ValueDiff
}

#EvalsFailure: {
	code:         "criterion.below-threshold" | "criterion.required-failed" | "rubric.total-below-threshold"
	criterionId?: string & !=""
	message:      string & !=""
}

#RubricReport: {
	schema:        "hobo.evals.rubric-report/v1"
	ok:            bool
	rubricId:      string & !=""
	passThreshold: #UnitInterval
	weightedTotal: #UnitInterval
	scores: [...#CriterionScore]
	failures: [...#EvalsFailure]
}

#GateReason: {
	code:    string & =~"^evals\\."
	message: string & !=""
}

#PromotionGateVerdict: {
	ok: bool
	reasons: [...#GateReason]
}

// A blocking verdict must explain itself.
#BlockingPromotionGateVerdict: #PromotionGateVerdict & {
	ok: false
	reasons: [_, ...]
}
