package hobo

#ReactivityClass: "reactive" | "non-reactive"

#AggregateSnapshotRecord: {
	streamId:   string & !=""
	seq:        int & >=0
	fenceToken: =~"^[0-9]+$"
	stateJson:  string
	savedAt:    string & !=""
}

#ProjectionCheckpointRecord: {
	projection: string & !=""
	seq:        int & >=0
	rowsJson:   string
	savedAt:    string & !=""
}

#QuarantineRecord: {
	offendingSeq:  int & >0
	quarantineSeq: int & >0
	type:          =~"\\.Quarantined$"
	reason:        string & !=""
}

#AggregateQuarantinedEventData: {
	offendingSeq:     int & >0 & <=9007199254740991
	offendingType:    =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
	offendingEventId: string & !=""
	fold:             string & !=""
	foldKind:         "aggregate"
	reason:           string
}

#ProjectionQuarantinedEventData: {
	projection:       string & !=""
	sourceStreamId:   string & !=""
	offendingSeq:     int & >0 & <=9007199254740991
	offendingEventId: string & !=""
	offendingType:    =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
	reason:           string
}

#EventStoreQuarantinedEventData: {
	offendingSeq:   int & >0 & <=9007199254740991
	offendingType?: string
	reason?:        string
}

#QuarantineFinding: {
	sourceStreamId:   string & !=""
	offendingSeq:     =~"^[1-9][0-9]*$"
	offendingEventId: string & !=""
	offendingType:    string & !=""
	fold:             string
	foldKind:         "aggregate" | "projection" | "eventstore"
	reason:           string
	recordStreamId:   string & !=""
	recordSeq:        =~"^[1-9][0-9]*$"
	code:             "event-log.poison-quarantined"
	severity:         "incident"
	remediation:      string & !=""
}

#QuarantineReport: {
	findings: [...#QuarantineFinding]
	complete:     bool
	nextPosition: string
	if complete {
		nextPosition: ""
	}
	if !complete {
		nextPosition: =~"^[1-9][0-9]*$"
	}
}

#QuarantineReprocessFinding: {
	code:             "event-log.quarantine-reprocess-policy-required"
	sourceStreamId:   string & !=""
	offendingSeq:     =~"^[1-9][0-9]*$"
	offendingEventId: string & !=""
	fold:             string & !=""
	foldKind:         "aggregate" | "projection"
}

#UpcasterRegistration: {
	type:        =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
	fromVersion: int & >=1
	toVersion:   int & >=2
}

#ActorActivatedData: {
	streamId:   string & !=""
	holderId:   string & !=""
	fenceToken: =~"^[0-9]+$"
}

#ActorStateAppendedData: {
	streamId:   string & !=""
	seq:        int & >0
	fenceToken: =~"^[0-9]+$"
}

#ActorPassivatedData: {
	streamId: string & !=""
	seq:      int & >=0
}

#ProjectionDeclaredData: {
	projection: string & !=""
	readSet: [...string] & !=[]
	reactivityClass: #ReactivityClass
}

#ProjectionLaggedData: {
	projection: string & !=""
	lagSeq:     int & >=0
	bound:      int & >=0
}

#ProjectionSinkReboundData: {
	projection:        string & !=""
	matchDecidedRef?:  string & !=""
	fromSinkId?:       string & !=""
	toSinkId?:         string & !=""
	configHash?:       =~"^sha256:[a-f0-9]{64}$"
	verifiedPosition?: string & =~"^(0|[1-9][0-9]*)$"
	migrationId?:      string & !=""
	{
		matchDecidedRef:   string & !=""
		fromSinkId?:       _|_
		toSinkId?:         _|_
		configHash?:       _|_
		verifiedPosition?: _|_
		migrationId?:      _|_
	} | {
		matchDecidedRef?: _|_
		fromSinkId:       string & !=""
		toSinkId:         string & !=""
		configHash:       =~"^sha256:[a-f0-9]{64}$"
	}
}

#ProjectionReplicatedEventData: {
	eventJson:      string & !=""
	sourcePosition: =~"^[0-9]+$"
}

#ProjectionReplicationCheckedData: {
	sourceStreamId: string
	sourcePosition: =~"^[0-9]+$"
	checkedAtMs:    =~"^[0-9]+$"
	caughtUp:       bool
}

#CrossCampProjectionLaggedData: {
	projection:     string & !=""
	ownerCampId:    string & !=""
	replicaCampId:  string & !=""
	sourcePosition: =~"^[0-9]+$"
	boundMs:        =~"^[0-9]+$"
	observedLagMs:  =~"^[0-9]+$"
}

#PaginatedChangeData: {
	resource:       string & !=""
	key:            string & !=""
	op:             "insert" | "update" | "delete"
	sourceSeq:      int & >0 & <=9007199254740991
	sourceStreamId: string & !=""
	rowJson?:       string
	if op != "delete" {rowJson: string & !=""}
}

#PaginatedCursorData: {
	resource: string & !=""
	orderBy:  string & !=""
	keyJson:  string & !=""
	rowId:    string & !=""
	streamId: string & !=""
	tenant:   string & !=""
}

#PaginatedPageData: {
	itemsJson: [...string]
	nextCursor?: string
	seq: [string]: int & >=0 & <=9007199254740991
}

#ProjectionRebuildRowRecord: {
	configHash: =~"^sha256:[a-f0-9]{64}$"
	key:        string & !=""
	rowJson?:   string
	deleted?:   bool
}

#ProjectionRebuildSeedRecord: {
	configHash:      =~"^sha256:[a-f0-9]{64}$"
	seeded?:         bool
	sourcePosition?: string & =~"^(0|[1-9][0-9]*)$"
	rowsJson:        string & !=""
}

#ProjectionRebuildCheckpointRecord: {
	configHash:      =~"^sha256:[a-f0-9]{64}$"
	sourcePosition?: string & =~"^(0|[1-9][0-9]*)$"
}
