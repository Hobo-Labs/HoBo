// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#BrokerRejectionMatrixCase: "stale-catalog" | "incompatible-mapping" | "ambiguous-mapping" | "missing-mapping" | "unsupported-capability"
#BrokerRejectionMatrixCode: "catalog.stale" | "mapping.incompatible" | "mapping.ambiguous" | "mapping.missing" | "capability.unsupported"
#BrokerBlockedOptimism: "best-effort-selection" | "stale-catalog-optimism" | "provider-default-fallback" | "hidden-yard-planning"

#Digest: =~"^sha256:[a-f0-9A-Za-z._:-]+$"

#BrokerRejectionReplayInputs: {
	manifestDigest:        #Digest
	environmentDigest:     #Digest
	catalogSnapshotDigest: #Digest
}

#BrokerRejectionReason: {
	code:            #BrokerRejectionMatrixCode
	message:         string & !=""
	details:         [...string] & len(_) > 0
	remediationHint: string & !=""
	blockedOptimism: [...#BrokerBlockedOptimism]
	supportSafe:     true
}

#BrokerRejectionSupportEvidence: {
	evidenceId:            string & !=""
	resourceId:            string & !=""
	interface:             string & =~"^hobo:"
	manifestDigest:        #Digest
	environmentDigest:     #Digest
	catalogSnapshotDigest: #Digest
	customerSafeSummary:   string & !=""
}

#BrokerResolutionRejectionMatrixEntry: {
	schema:                "hobo.resolution-rejection/v1"
	rejectionId:           string & !=""
	resolutionAuthority:   "meta-cloud-broker"
	caseId:                #BrokerRejectionMatrixCase
	reason:                #BrokerRejectionReason
	replayInputs:          #BrokerRejectionReplayInputs
	supportEvidence:       #BrokerRejectionSupportEvidence
	fallbackAttempted:     false
	yardPlanningAllowed:   false
	partialReceiptEmitted: false
	digest:                #Digest
	signature:             string & =~"^signed:meta-cloud-broker:sha256:"
}

#BrokerRejectionMatrix: {
	schema:     "hobo.broker-rejection-matrix/v1"
	issue:      "HOBO-528"
	rejections: [...#BrokerResolutionRejectionMatrixEntry] & len(_) == 5
}
