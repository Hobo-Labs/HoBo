package hobo

#BuildCostObservationRecord: {
	type:           "build.CacheHitObserved"
	seq:            int & >0 & <=9007199254740991
	providerId:     string & !=""
	buildId:        string & !=""
	estimatedUnits: number & >0
	meteredUnits:   number & >=0
}
