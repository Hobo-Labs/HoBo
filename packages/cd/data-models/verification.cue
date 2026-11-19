package verification

import (
	"list"
	"strconv"
	"strings"
)

#Uint64:    =~"^(0|[1-9][0-9]{0,19})$"
#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#Name:      =~"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$"
#Https:     =~"^https://[^/@\\s]+(/.*)?$"
#Text:      string & strings.MaxRunes(1024)

#ReasonRecord: {
	code:        string & !=""
	message?:    #Text
	remediation: string & !="" & #Text
	subject?:    #Text
}

#HealthSourceKind:    "HEALTH_SOURCE_KIND_PROMETHEUS" | "HEALTH_SOURCE_KIND_HOBO_METERING" | "HEALTH_SOURCE_KIND_HTTP_JSON" | "HEALTH_SOURCE_KIND_DATADOG" | "HEALTH_SOURCE_KIND_NEW_RELIC" | "HEALTH_SOURCE_KIND_CLOUDWATCH" | "HEALTH_SOURCE_KIND_HOBO_POSTURE"
#Cohort:              "COHORT_UNSPECIFIED" | "COHORT_CANARY" | "COHORT_BASELINE" | "COHORT_ALL"
#Comparator:          "COMPARATOR_LT" | "COMPARATOR_LTE" | "COMPARATOR_GT" | "COMPARATOR_GTE"
#Aggregation:         "AGGREGATION_MEAN" | "AGGREGATION_P50" | "AGGREGATION_P95" | "AGGREGATION_P99" | "AGGREGATION_MAX" | "AGGREGATION_SUM"
#Direction:           "DIRECTION_HIGHER_IS_WORSE" | "DIRECTION_LOWER_IS_WORSE"
#Sensitivity:         "SENSITIVITY_UNSPECIFIED" | "SENSITIVITY_LOW" | "SENSITIVITY_MEDIUM" | "SENSITIVITY_HIGH"
#VerificationVerdict: "VERIFICATION_VERDICT_UNSPECIFIED" | "VERIFICATION_VERDICT_PASS" | "VERIFICATION_VERDICT_FAIL" | "VERIFICATION_VERDICT_INCONCLUSIVE"

#HealthQueryRecord: {
	name:           #Name
	source:         #HealthSourceKind
	query:          string & !="" & strings.MaxRunes(4096)
	unit?:          #Text
	credentialRef?: #Text
	cohortLabel?:   =~"^[A-Za-z_.][A-Za-z0-9_.:/-]{0,127}$"
	if source == "HEALTH_SOURCE_KIND_HOBO_POSTURE" {
		endpointRef?: =~"^sha256:[0-9a-f]{64}$"
	}
	if source != "HEALTH_SOURCE_KIND_HOBO_POSTURE" {
		endpointRef: #Https
	}
}

#HealthSamplePointRecord: {
	value?:          number | "NaN" | "Infinity" | "-Infinity"
	observedAtMs?:   int & >=0 & <=8640000000000000
	seriesKey:       string & !=""
	correlationKey?: string & !=""
}

#HealthSamplesRecord: {
	values?: [...(number | "NaN" | "Infinity" | "-Infinity")]
	fromMs?: int & >=0 & <=8640000000000000
	toMs?:   int & >=0 & <=8640000000000000
	points?: [...#HealthSamplePointRecord]
	if points != _|_ {
		values: [...]
		_pointCount: true & (len(points) == len(values))
	}
}

#ThresholdCheckRecord: {
	query:       #HealthQueryRecord
	aggregation: #Aggregation
	comparator:  #Comparator
	value?:      number
}

#ComparisonCheckRecord: {
	query:        #HealthQueryRecord
	direction:    #Direction
	sensitivity?: #Sensitivity
	minSamples?:  int & >=0 & <=10000
	if query.source != "HEALTH_SOURCE_KIND_HOBO_POSTURE" {
		query: cohortLabel: string
	}
}

#ProbeCheckRecord: {
	name:             #Name
	urlRef:           #Https
	expectStatus?:    int & >=100 & <=599
	intervalMs?:      #Uint64
	minSuccessRatio?: number & >0 & <=1
}

#SuiteCheckRecord: suite: #Name

#SloGateRecord: {
	burnRate: #HealthQueryRecord & {unit: "burn_rate"}
	remainingBudgetRatio: #HealthQueryRecord & {unit: "ratio"}
	if burnRate.source == "HEALTH_SOURCE_KIND_PROMETHEUS" {
		burnRate: query: =~#"^[A-Za-z_:][A-Za-z0-9_:]*(\{([^{}"\\]|"([^"\\]|\\.)*")*\})?$"#
	}
	if remainingBudgetRatio.source == "HEALTH_SOURCE_KIND_PROMETHEUS" {
		remainingBudgetRatio: query: =~#"^[A-Za-z_:][A-Za-z0-9_:]*(\{([^{}"\\]|"([^"\\]|\\.)*")*\})?$"#
	}
	rollbackBurnRate?:         number & >0
	minRemainingBudgetRatio?:  number & >=0 & <=1
	holdBurnRate?:             number & >0
	holdRemainingBudgetRatio?: number & >=0 & <=1
	sustainedBreachCount?:     int & (0 | (>=2 & <=10000))
	sustainedHealthyCount?:    int & (0 | (>=2 & <=10000))
	maxSampleAgeMs?:           #Uint64
	_rollback:                 *12 | number & >0
	_minimum:                  *0.08 | number & >=0 & <=1
	_holdBurn:                 *1 | number & >0
	_holdBudget:               *0.2 | number & >=0 & <=1
	if rollbackBurnRate != _|_ {_rollback: rollbackBurnRate}
	if minRemainingBudgetRatio != _|_ {_minimum: minRemainingBudgetRatio}
	if holdBurnRate != _|_ {_holdBurn: holdBurnRate}
	if holdRemainingBudgetRatio != _|_ {_holdBudget: holdRemainingBudgetRatio}
	_burnOrder:   true & (_holdBurn < _rollback)
	_budgetOrder: true & (_minimum < _holdBudget)
}

#VerificationSpecRecord: {
	windowMs?:             #Uint64
	requiredObservations?: int & >=0 & <=10000
	progressDeadlineMs?:   #Uint64
	failOnNoData:          *true | bool
	maxErrorBudgetBurn?:   number & >=0
	thresholds?: [...#ThresholdCheckRecord]
	comparisons?: [...#ComparisonCheckRecord]
	probes?: [...#ProbeCheckRecord]
	suites?: [...#SuiteCheckRecord]
	sloGate?: #SloGateRecord

	_t: *[] | [...]
	_c: *[] | [...]
	_p: *[] | [...]
	_s: *[] | [...]
	if thresholds != _|_ {_t: thresholds}
	if comparisons != _|_ {_c: comparisons}
	if probes != _|_ {_p: probes}
	if suites != _|_ {_s: suites}
	_hasSlo: *0 | 1
	if sloGate != _|_ {_hasSlo: 1}
	_hasChecks: true & (len(_t)+len(_c)+len(_p)+len(_s)+_hasSlo > 0)

	_names: list.Concat([[for t in _t {"threshold:\(t.query.name)"}], [for c in _c {"comparison:\(c.query.name)"}], [for p in _p {"probe:\(p.name)"}], [for s in _s {"suite:\(s.suite)"}]])
	_unique: true & list.UniqueItems(_names)

	if windowMs != _|_ && progressDeadlineMs != _|_ {
		if windowMs != "0" && progressDeadlineMs != "0" {
			_deadlineCoversWindow: true & (strconv.Atoi(progressDeadlineMs) >= strconv.Atoi(windowMs))
		}
	}

	if sloGate != _|_ {
		if sloGate.maxSampleAgeMs != _|_ {
			if sloGate.maxSampleAgeMs != "0" {
				_effectiveSloWindow: *900000 | int
				if windowMs != _|_ {
					if windowMs != "0" {_effectiveSloWindow: strconv.Atoi(windowMs)}
				}
				_ageWithinWindow: true & (strconv.Atoi(sloGate.maxSampleAgeMs) <= _effectiveSloWindow)
			}
		}
	}
	if maxErrorBudgetBurn != _|_ {
		if maxErrorBudgetBurn > 0 {
			_burn: list.Concat([[for t in _t if t.query.unit != _|_ if t.query.unit == "burn_rate" {t}], [for c in _c if c.query.unit != _|_ if c.query.unit == "burn_rate" {c}]])
			_burnBound: true & (len(_burn) > 0)
		}
	}
}

#CheckOutcomeRecord: {
	check:            string & !=""
	verdict:          #VerificationVerdict & !="VERIFICATION_VERDICT_UNSPECIFIED"
	statistic?:       number | "NaN" | "Infinity" | "-Infinity"
	pValue?:          number & >=0 & <=1
	samplesCanary?:   int & >=0
	samplesBaseline?: int & >=0
	if verdict != "VERIFICATION_VERDICT_PASS" {
		reason: #ReasonRecord
	}
	if verdict == "VERIFICATION_VERDICT_PASS" {
		reason?: #ReasonRecord
	}
}

#VerificationResultRecord: {
	verificationId: =~"^ver-[0-9a-f]{32}$"
	freightId:      string & !=""
	campId:         string & !=""
	verdict:        #VerificationVerdict & !="VERIFICATION_VERDICT_UNSPECIFIED"
	checks?: [...#CheckOutcomeRecord]
	startedAt:       #Timestamp
	finishedAt:      #Timestamp
	evidenceDigest?: =~"^sha256:[0-9a-f]{64}$"
	reasons?: [...#ReasonRecord]
	if verdict == "VERIFICATION_VERDICT_PASS" {
		checks: list.MinItems(1) & [...{verdict: "VERIFICATION_VERDICT_PASS"}]
	}
}

#EvidenceObservationRecord: {
	campId:          string & !=""
	signal:          =~"^(threshold|comparison|probe|suite|slo):[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$"
	healthy?:        bool
	value?:          number | "NaN" | "Infinity" | "-Infinity"
	observedAt:      #Timestamp
	source:          string & !=""
	cohort?:         #Cohort
	seriesKey?:      string & !=""
	correlationKey?: string & !=""
}

#VerificationStarted: {
	verificationId: =~"^ver-[0-9a-f]{32}$"
	freightId:      string & !=""
	campId:         string & !=""
	cohortAware:    bool
	startedAt:      #Timestamp
	spec: {...}
}
