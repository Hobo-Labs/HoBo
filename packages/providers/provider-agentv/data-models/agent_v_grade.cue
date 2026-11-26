package data_models

#AgentVGrade: {
	case_id: string & !=""
	score:   number & >=0 & <=1
	named_scores: {[string]: number & >=0 & <=1}
	pass:   bool
	reason: string & !=""
}
