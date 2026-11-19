package core

#SloDuration:      string & =~"^[1-9][0-9]*(s|m|h|d|w|M|Q|Y)$"
#SloSliceDuration: string & =~"^[1-9][0-9]*(s|m|h|d|w)$"
#SloMetadataRecord: {
	name: string & !=""
	labels?: {[string]: string}
}
#SloTelemetryRecord: {
	query: string & !=""
	unit?: string
}
#SloTelemetryQueryRecord: telemetry: #SloTelemetryRecord
#SloRatioMetricRecord: {
	counter: bool
	good:    #SloTelemetryQueryRecord
	total:   #SloTelemetryQueryRecord
}
#SloIndicatorRecord: ratioMetric: #SloRatioMetricRecord
#SloCalendarRecord: {
	startTime: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?$"
	timeZone:  string & !=""
}
#SloTimeWindowRecord: {
	duration:  #SloDuration
	isRolling: bool
	if isRolling {
		duration:  #SloSliceDuration
		calendar?: _|_
	}
	if !isRolling {
		calendar: #SloCalendarRecord
	}
}
#SloObjectiveRecord: {
	displayName:      string & !=""
	target:           number & >0 & <=1
	timeSliceWindow?: #SloSliceDuration
	timeSliceTarget?: number & >0 & <=1
}
#SloBurnThresholdRecord: {
	name:             string & !=""
	threshold:        number & >0
	lookbackWindow:   #SloSliceDuration
	samplingInterval: #SloSliceDuration
}
#SloSpecRecord: {
	service:         string & !=""
	indicator:       #SloIndicatorRecord
	timeWindow:      #SloTimeWindowRecord
	budgetingMethod: "Occurrences" | "Timeslices" | "RatioTimeslices"
	objectives: [#SloObjectiveRecord, ...#SloObjectiveRecord]
	burnRateThresholds?: [...#SloBurnThresholdRecord]
	if budgetingMethod == "Occurrences" {
		objectives: [...{timeSliceWindow?: _|_, timeSliceTarget?: _|_}]
	}
	if budgetingMethod == "Timeslices" {
		objectives: [...{timeSliceWindow: #SloSliceDuration, timeSliceTarget: number & >0 & <=1}]
	}
	if budgetingMethod == "RatioTimeslices" {
		objectives: [...{timeSliceWindow: #SloSliceDuration, timeSliceTarget?: _|_}]
	}
}
#SloDefinitionRecord: {
	schema:     "hobo.slo/v1"
	apiVersion: "openslo/v1"
	kind:       "SLO"
	metadata:   #SloMetadataRecord
	spec:       #SloSpecRecord
}

#SliSampleRecord: {
	time:  string & !=""
	good:  number & >=0
	total: number & >=0 & >=good
}
#SloWindowEvaluationRecord: {
	startTime:             string & !=""
	endTime:               string & !=""
	status:                "ok" | "no-data" | "invalid-sli"
	good?:                 number & >=0
	total?:                number & >=0
	errors?:               number & >=0
	errorBudget?:          number & >=0
	burnRate?:             number & >=0
	remainingBudgetRatio?: number & >=0 & <=1
	slices?:               int & >=0
}
#SloBurnEvaluationRecord: {
	name:             string & !=""
	threshold:        number & >0
	triggered:        bool
	window:           #SloWindowEvaluationRecord
	lookbackWindow:   #SloSliceDuration
	samplingInterval: #SloSliceDuration
}
#SloObjectiveEvaluationRecord: {
	displayName: string & !=""
	target:      number & >0 & <=1
	status:      #SloEvaluationStatus
	window:      #SloWindowEvaluationRecord
	burnWindows: [...#SloBurnEvaluationRecord]
}
#SloEvaluationStatus: "healthy" | "burning" | "budget-exhausted" | "no-data" | "stale" | "invalid-sli" | "no-error-budget"
#SloEvaluationRecord: {
	schema:      "hobo.slo-computation-engine/v1"
	sloName:     string & !=""
	service:     string & !=""
	evaluatedAt: string & !=""
	status:      #SloEvaluationStatus
	objectives: [#SloObjectiveEvaluationRecord, ...#SloObjectiveEvaluationRecord]
}
