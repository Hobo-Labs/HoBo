package data_models

#ResourceLifecycleObservationRecord: {
	tenantId:           string & !=""
	providerId:         string & !=""
	providerAccountId:  string & !=""
	productId:          string & !=""
	resourceId:         string & !=""
	physicalId?:        string
	operationId:        string & !=""
	status:             "ready" | "pending" | "failed" | "absent" | "unknown"
	observedAtMs:       int & >=0 & <=9007199254740991
	evidenceRef:        string & !=""
	artifactDigest?:    string & =~"^sha256:[0-9a-f]{64}$"
	operationTerminal:  *false | bool
	billable?:          bool
	healthy:            *false | bool
	healthEvidenceRef?: string
	usageFinal:         *false | bool
	settledMicros?:     int & >=0 & <=9007199254740991
	usageEvidenceRef?:  string
	servingEndpoint?:   string & =~"^https?://" & !=""
	if status == "ready" || status == "absent" {
		physicalId:        string & !=""
		operationTerminal: true
	}
	if healthy == true {healthEvidenceRef: string & !=""}
	if usageFinal == true {
		usageEvidenceRef: string & !=""
		settledMicros:    int & >=0 & <=9007199254740991
	}
}

#ResourceMutationJournalEntry: {
	mutationId:    string & !=""
	requestDigest: string & =~"^sha256:[0-9a-f]{64}$"
	status:        "claimed" | "acknowledged" | "uncertain"
	recordedAtMs:  int & >=0 & <=9007199254740991
}

#ProviderResourceRecordEnvelope: {
	tenantId:          string & !=""
	providerId:        string & !=""
	providerAccountId: string & !=""
	scopeId:           string & !=""
	recordKey:         string & !=""
	recordJson:        string & !=""
	recordDigest:      string & =~"^sha256:[0-9a-f]{64}$"
}
