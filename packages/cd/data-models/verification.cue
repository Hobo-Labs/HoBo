// CUE constraints for the verification records in cd.proto (WP9, D9, I5).
// Values are protobuf JSON: camelCase fields, enum names, uint64 as decimal
// strings; proto3 JSON omits defaults, so scalar fields are optional unless a
// record is meaningless without them. `package verification` keeps these
// definitions apart from the other cd.proto constraint files in this folder.
//
// The TypeScript parse boundary is src/verification/spec.ts
// (parseVerificationSpec); test/verification/cue.test.ts proves the two agree.
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

#HealthSourceKind: "HEALTH_SOURCE_KIND_PROMETHEUS" | "HEALTH_SOURCE_KIND_HOBO_METERING" | "HEALTH_SOURCE_KIND_HTTP_JSON" | "HEALTH_SOURCE_KIND_DATADOG" | "HEALTH_SOURCE_KIND_NEW_RELIC" | "HEALTH_SOURCE_KIND_CLOUDWATCH" | "HEALTH_SOURCE_KIND_HOBO_POSTURE"
#Cohort:           "COHORT_UNSPECIFIED" | "COHORT_CANARY" | "COHORT_BASELINE" | "COHORT_ALL"
#Comparator:       "COMPARATOR_LT" | "COMPARATOR_LTE" | "COMPARATOR_GT" | "COMPARATOR_GTE"
#Aggregation:      "AGGREGATION_MEAN" | "AGGREGATION_P50" | "AGGREGATION_P95" | "AGGREGATION_P99" | "AGGREGATION_MAX" | "AGGREGATION_SUM"
#Direction:        "DIRECTION_HIGHER_IS_WORSE" | "DIRECTION_LOWER_IS_WORSE"
// UNSPECIFIED takes the CD_DEFAULTS sensitivity (MEDIUM, alpha 0.05).
#Sensitivity:         "SENSITIVITY_UNSPECIFIED" | "SENSITIVITY_LOW" | "SENSITIVITY_MEDIUM" | "SENSITIVITY_HIGH"
#VerificationVerdict: "VERIFICATION_VERDICT_UNSPECIFIED" | "VERIFICATION_VERDICT_PASS" | "VERIFICATION_VERDICT_FAIL" | "VERIFICATION_VERDICT_INCONCLUSIVE"

#HealthQueryRecord: {
	name:          #Name
	source:        #HealthSourceKind
	query:         string & !="" & strings.MaxRunes(4096)
	unit?:         #Text
	credentialRef?: #Text
	cohortLabel?:  =~"^[A-Za-z_.][A-Za-z0-9_.:/-]{0,127}$"
	// Posture reads the journal: endpoint_ref is empty or a Rail digest.
	if source == "HEALTH_SOURCE_KIND_HOBO_POSTURE" {
		endpointRef?: =~"^sha256:[0-9a-f]{64}$"
	}
	if source != "HEALTH_SOURCE_KIND_HOBO_POSTURE" {
		endpointRef: #Https
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
	name:              #Name
	urlRef:            #Https
	expectStatus?:     int & >=100 & <=599
	intervalMs?:       #Uint64
	// 0 (unset) means 1: every attempt must succeed.
	minSuccessRatio?: number & >0 & <=1
}

#SuiteCheckRecord: suite: #Name

// The authored spec. failOnNoData defaults to true (D9).
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

	_t: *[] | [...]
	_c: *[] | [...]
	_p: *[] | [...]
	_s: *[] | [...]
	if thresholds != _|_ {_t: thresholds}
	if comparisons != _|_ {_c: comparisons}
	if probes != _|_ {_p: probes}
	if suites != _|_ {_s: suites}
	// A spec with no checks would pass on absent evidence. (Vetting this
	// definition with no instance reports the hidden field as false; that is
	// the artifact scripts/check-cue-schemas.ts ignores, not a defect.)
	_hasChecks: true & (len(_t)+len(_c)+len(_p)+len(_s) > 0)

	// Every check name is distinct.
	_names: list.Concat([[for t in _t {"threshold:\(t.query.name)"}], [for c in _c {"comparison:\(c.query.name)"}], [for p in _p {"probe:\(p.name)"}], [for s in _s {"suite:\(s.suite)"}]])
	_unique: true & list.UniqueItems(_names)

	if windowMs != _|_ && progressDeadlineMs != _|_ {
		if windowMs != "0" && progressDeadlineMs != "0" {
			_deadlineCoversWindow: true & (strconv.Atoi(progressDeadlineMs) >= strconv.Atoi(windowMs))
		}
	}

	// An error-budget ceiling needs a burn_rate series.
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
	// Anything but a PASS says why.
	if verdict != "VERIFICATION_VERDICT_PASS" {
		reason: #ReasonRecord
	}
	if verdict == "VERIFICATION_VERDICT_PASS" {
		reason?: #ReasonRecord
	}
}

// verification.Completed body. A completed result always has a verdict and a
// finish time; a PASS has at least one check and no failing one.
#VerificationResultRecord: {
	verificationId: =~"^ver-[0-9a-f]{32}$"
	freightId:      string & !=""
	campId:         string & !=""
	verdict:        #VerificationVerdict & !="VERIFICATION_VERDICT_UNSPECIFIED"
	checks?: [...#CheckOutcomeRecord]
	startedAt:  #Timestamp
	finishedAt: #Timestamp
	reasons?: [...#ReasonRecord]
	if verdict == "VERIFICATION_VERDICT_PASS" {
		checks: list.MinItems(1) & [...{verdict: "VERIFICATION_VERDICT_PASS"}]
	}
}

// rollout.EvidenceObserved body on cd-verification-<id>: one sample.
#EvidenceObservationRecord: {
	campId:     string & !=""
	signal:     =~"^(threshold|comparison|probe|suite):[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$"
	healthy?:   bool
	value?:     number | "NaN" | "Infinity" | "-Infinity"
	observedAt: #Timestamp
	source:     string & !=""
	cohort?:    #Cohort
}

// verification.Started body: identity, start instant and the spec as parsed.
#VerificationStarted: {
	verificationId: =~"^ver-[0-9a-f]{32}$"
	freightId:      string & !=""
	campId:         string & !=""
	cohortAware:    bool
	startedAt:      #Timestamp
	spec: {...}
}
