// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#KnownLimitationState: "real" | "beta-only" | "simulated-reference" | "unsupported" | "deferred" | "post-ga"

#KnownLimitation: {
	id:                         string & !=""
	summary:                    string & !=""
	state:                      #KnownLimitationState
	affectedPersona:            string & !=""
	userVisibleImpact:          string & !=""
	workaround:                 string & !=""
	owner:                      string & !=""
	followUpIssue?:             string & !=""
	requiresFollowUp:           bool
	releaseNoteSection:         string & !=""
	supportScriptRoute:         string & !=""
	docsRoute:                  string & !=""
	launchMessagingDisposition: string & !=""
}

#KnownLimitationHandoffTarget: {
	id:               "release-notes" | "support-scripts" | "docs-portal" | "launch-messaging"
	owner:            string & !=""
	consumes:         [...string]
	requiredEvidence: [...string]
}

#KnownLimitationReviewCheckpoint: {
	gate:                       "beta" | "ga"
	owner:                      string & !=""
	requiredFields:             [...string]
	blocksPublicationWhenStale: true
}

#KnownLimitationsRegister: {
	issue:             "HOBO-485"
	phase:             "M0"
	limitations:       [...#KnownLimitation]
	handoffTargets:    [...#KnownLimitationHandoffTarget]
	reviewCheckpoints: [...#KnownLimitationReviewCheckpoint]
	allowedFraming:    [...#KnownLimitationState]
}
